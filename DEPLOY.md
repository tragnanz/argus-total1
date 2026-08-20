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
- `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` = lasciali **vuoti** finché resti in
  modalità synthetic. Quando il secondo account Copernicus è pronto: inseriscili
  e cambia `PROVIDER_MODE` da `synthetic` a `cdse`.

**argus-total-web** → Environment:
- `NEXT_PUBLIC_API_BASE` = URL del **backend** (es. `https://argus-total-api.onrender.com`)

## 4. Ridistribuisci il frontend (importante)
`NEXT_PUBLIC_API_BASE` viene **incorporato nel build** di Next.js: dopo averlo
impostato, sul servizio `argus-total-web` fai **Manual Deploy → Clear build cache
& deploy**. Sul backend basta un **Restart** (o si riavvia da solo al salvataggio
delle env var).

## 5. Verifica
- Backend: apri `https://argus-total-api.onrender.com/api/health` → deve dare
  `{"status":"ok","provider_mode":"synthetic","rev":"0.4.4"}`.
- Frontend: apri l'URL web, disegna un'area, cerca le date, genera l'anteprima e
  una scheda PDF.

## Piani di calcolo
`render.yaml` dichiara **Standard** per l'API e **Starter** per il frontend.

| servizio | piano | RAM / CPU | perché |
|---|---|---|---|
| `argus-total-api` | Standard | 2 GB / 1 CPU | un export di un progetto da 121 pivot tocca ~270 MB di picco su 164 MB a riposo: su 512 MB il margine era di poche decine di MB e il servizio si riavviava. Con CDSE i raster reali pesano più dei sintetici. |
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

## Passaggio al satellite reale (CDSE)
Quando hai il **secondo** account Copernicus:
1. `argus-total-api` → env: `PROVIDER_MODE=cdse`, `CDSE_CLIENT_ID`, `CDSE_CLIENT_SECRET`.
2. Restart del backend. Nient'altro da toccare (nessuna modifica al codice).

## Opzione: frontend come Static Site (gratis, senza "sonno")
Il frontend è interamente client-side: può essere pubblicato come **Static Site**
Render (nessuna sospensione, più veloce). Richiede `output: "export"` in
`next.config.mjs` e un servizio `type: static`. Posso predisporlo su richiesta.
