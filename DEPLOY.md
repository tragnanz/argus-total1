# Deploy di Argus Total su Render

Argus Total è un deploy **separato** da Argus Smart: repo, servizi e database
dedicati. Il file `render.yaml` è un *blueprint*: Render crea in un colpo il
database Postgres, il backend (FastAPI) e il frontend (Next.js).

## 0. Prerequisiti
- Repo GitHub **nuovo** `argus-total` con questo codice (push da GitHub Desktop).
- Account Render collegato a GitHub.

## 1. Crea i servizi dal blueprint
1. Render → **New +** → **Blueprint**.
2. Seleziona il repo `argus-total` → Render legge `render.yaml`.
3. **Apply**: crea `argus-total-db`, `argus-total-api`, `argus-total-web`.

Il primo build parte subito. `DATABASE_URL` viene collegato in automatico e le
tabelle si creano da sole all'avvio (nessuna migrazione da lanciare).

## 2. Prendi gli URL assegnati
Dopo l'apply, in dashboard trovi gli URL (di solito):
- backend  → `https://argus-total-api.onrender.com`
- frontend → `https://argus-total-web.onrender.com`

(se il nome è già preso, Render aggiunge un suffisso: usa gli URL reali che vedi).

## 3. Imposta le variabili d'ambiente (`sync:false`)
**argus-total-api** → Environment:
- `CORS_ORIGINS` = URL del **frontend** (es. `https://argus-total-web.onrender.com`)
- `PROVIDER_MODE` = `cdse` (in produzione dal 04/11/2026; `synthetic` solo per
  prove senza credenziali).
- `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` = credenziali del **secondo** account
  Copernicus Data Space (Sentinel-2). Senza, con `cdse` il backend va in errore.

**argus-total-web** → Environment:
- `NEXT_PUBLIC_API_BASE` = URL del **backend** (es. `https://argus-total-api.onrender.com`)

## 4. Ridistribuisci il frontend (importante)
`NEXT_PUBLIC_API_BASE` viene **incorporato nel build** di Next.js: dopo averlo
impostato, sul servizio `argus-total-web` fai **Manual Deploy → Clear build cache
& deploy**. Sul backend basta un **Restart** (o si riavvia da solo al salvataggio
delle env var).

## 5. Verifica
- Backend: apri `https://argus-total-api.onrender.com/api/health` → deve dare
  `{"status":"ok","provider_mode":"cdse","rev":"…"}` (il `rev` è quello di
  `backend/app/main.py`).
- Frontend: apri l'URL web, disegna un'area, cerca le date, genera l'anteprima e
  una scheda PDF.

## Piani di calcolo
`render.yaml` dichiara **Standard** per l'API e **Starter** per il frontend.

| servizio | piano | RAM / CPU | perché |
|---|---|---|---|
| `argus-total-api` | Standard | 2 GB / 1 CPU | un export di un progetto da 121 pivot tocca ~270 MB di picco su 164 MB a riposo: su 512 MB il margine era di poche decine di MB e il servizio si riavviava. Misurato il 04/11/2026 con dati reali: 138 MB a riposo, 398 MB di picco con 3 stime di fiume (DEM, GEOGLOWS) e l'NDVI di 35 pivot in parallelo. |
| `argus-total-web` | Starter | 512 MB / 0,5 CPU | a Next.js serve soprattutto non andare in sospensione. |
| `argus-total-db` | basic-256mb | — | già a pagamento. |

Perché **non** Starter sull'API: costa meno ma ha ancora 512 MB, quindi
toglierebbe il risveglio a freddo senza alzare il tetto di memoria — proprio il
limite che faceva cadere il servizio durante gli export.

Cosa cambia in pratica:
- **niente più sospensione**: sui piani a pagamento il servizio resta acceso, e
  sparisce il risveglio da ~40 s alla prima richiesta dopo una pausa;
- **CPU**: da 0,1 a 1 sull'API, cioè dieci volte tanto sulle parti pesanti
  (layout, idoneità, generazione della tavola).

Il cambio di piano si applica facendo **Manual Sync** del blueprint, oppure a
mano dal dashboard: servizio → *Settings* → *Instance Type*. La modifica è
immediata e comporta un riavvio del servizio.

- Deploy automatico: ogni push su GitHub ridistribuisce (per il frontend, se
  cambi `NEXT_PUBLIC_API_BASE`, ricordati del *clear cache & deploy*).

## Satellite reale (CDSE) — attivo
`PROVIDER_MODE=cdse` con le credenziali del secondo account Copernicus. Per
tornare ai dati sintetici (prove) basta rimettere `synthetic` e fare Restart.

- **Sentinel-2** (NDVI, scene, compositi): Process API di CDSE.
- **Corsi d'acqua esistenti** (`analysis/waterways.py`): composito Sentinel-2 di 12 mesi
  (una scena per mese, nuvole ≤ 60% tolte pixel per pixel, più una seconda scena per i
  mesi più nuvolosi: 12-16 date) a 10 m, in tessere da 1500 px; ogni tessera
  scarica le sue date, fa il composito e libera la memoria. Area massima ~9 milioni di
  pixel (≈30×30 km a 10 m), oltre ricampiona. Richieste = scene × tessere (12–64) più
  un DEM grossolano (mare a quota 0 e alvei asciutti delle fiumare).
  Il NIR di ogni data resta in memoria (uint8, al massimo 120 MB) per la larghezza data
  per data; per i fiumi ≥ 80 m le quote minime e massime vengono da Hydroweb (via
  GEOGLOWS, al più 4 tratti e 40 s per rilevamento).
  Misurato in locale sulle COG pubbliche AWS dello stesso Sentinel-2: 20–170 s per
  5–13 km di lato, picco del processo 402 MB.
- **DEM**: l'account CDSE non ha i permessi sul DEM (la Process API risponde 403
  `COMMON_INSUFFICIENT_PERMISSIONS`). Il backend se ne accorge alla prima
  richiesta e legge lo stesso Copernicus DEM GLO-30/GLO-90 dai COG pubblici su
  AWS (`copernicus-dem-30m` / `copernicus-dem-90m`), sulla stessa griglia UTM.

## Fonti esterne usate dal backend
Nessuna richiede chiavi oltre a CDSE. Tutte vanno raggiunte in uscita da Render.

| dato | fonte | limiti |
|---|---|---|
| portate dei fiumi (modello principale) | GEOGLOWS v2, ECMWF — serie mensili `s3://geoglows-v2` (AWS Open Data, CC BY 4.0), previsione e livelli via `geoglows.ecmwf.int` e `transformers/hydroweb.zarr` | nessun limite di richieste |
| indice dei fiumi | `backend/analysis/data/geoglows_index.npz` (1,15 milioni di tratti con bacino ≥ 1.000 km², ~17 MB nel repo) | — |
| portate misurate | `backend/analysis/data/river_stations.json` (~25.000 stazioni: GSIM, GRDC 2025, Dai 2026, GRDC/UNH, Kazhydromet); il file è CC BY-SA 3.0 perché deriva anche da GSIM | — |
| portate GloFAS (seconda opzione) | Open-Meteo Flood API | piano gratuito: limite orario; una ricerca della presa (25 celle × 20 anni) ne consuma una parte grande. Con molti utenti serve una chiave a pagamento |
| clima e piogge | NASA POWER | — |
| suolo | SoilGrids (ISRIC) | lento: 2 tentativi da 30 s |

Per rigenerare i due file dei dati: `backend/scripts/river_data/README.md`.

## Opzione: frontend come Static Site (gratis, senza "sonno")
Il frontend è interamente client-side: può essere pubblicato come **Static Site**
Render (nessuna sospensione, più veloce). Richiede `output: "export"` in
`next.config.mjs` e un servizio `type: static`. Posso predisporlo su richiesta.
