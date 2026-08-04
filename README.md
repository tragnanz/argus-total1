# Argus Total

Prodotto della suite **Argus** di Nabu — **progettazione da zero di grandi
progetti agroindustriali**. Riusa il motore satellitare di **Argus Smart**
(client Copernicus/CDSE, indici, cloud masking, geometrie, DEM, clima) in un
progetto/repo/deploy/DB **completamente separati**.

> **M1**: scaffold + gerarchia dati (Cliente → Progetto → Area) + pagina
> "Area di progetto" con anteprima indici e DEM.
> **M2**: mappa di **idoneità del terreno** (pendenza da DEM + vigore/umidità +
> clima ET₀) con pesi e soglie regolabili; ET₀ FAO-56 Penman-Monteith.
> **M3**: **layout automatico dei pivot** (maglia quadrata o triangolare) +
> **dimensionamento idrico**; il vincolo di pendenza dipende dal
> tipo di trasporto acqua (canali vs tubazioni interrate); reticolo orientato al
> canale, spaziatura e sbordo regolabili, rete a spine + collettore.
> **M4**: **fasi di sviluppo** + **export scheda progetto PDF** brandizzata Nabu
> (con schema dell'impianto) e layout in GeoJSON.
> **M5**: **multi-campo** — import di KMZ/KML/GeoJSON con **più poligoni** (più
> appezzamenti); ogni campo si può selezionare/rinominare e le regole tecniche
> possono essere **le stesse per tutti** oppure **diverse per campo**. Layout,
> KPI e portate sono aggregati sul progetto; export PDF per campo (ZIP) e
> GeoJSON combinato.

## Struttura

```
argus-total/
├─ backend/            FastAPI + SQLAlchemy + motore satellitare (processing/)
│  ├─ app/             API (config, db, models, schemas, deps, routers, main)
│  ├─ analysis/        LOGICA nuova di Total: eto.py (FAO-56), suitability.py
│  ├─ processing/      MOTORE riusato da Argus Smart (NON modificato)
│  │  └─ providers/synthetic.py   provider demo senza crediti (nuovo)
│  ├─ assets/          logo Nabu
│  └─ requirements-backend.txt
├─ frontend/           Next.js 14 + TypeScript + Leaflet + Tailwind
│  └─ src/app/page.tsx pagina "Area di progetto"
├─ render.yaml         blueprint deploy (servizi + Postgres separati)
└─ .gitignore
```

## Regole di separazione da Argus Smart (rispettate)

1. **Repo/servizio nuovi** — non tocca `tragnanz/agri-sat-audit`.
2. **Database dedicato** — Postgres nuovo, `DATABASE_URL` via env.
3. **Secondo account Copernicus** — `CDSE_CLIENT_ID`/`CDSE_CLIENT_SECRET` via
   env var (mai nel codice), così i crediti di Smart e Total non si consumano
   a vicenda. Finché `PROVIDER_MODE=synthetic` non serve alcuna credenziale.

## Avvio in locale

### Backend
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-backend.txt
cp .env.example .env          # PROVIDER_MODE=synthetic (default)
uvicorn app.main:app --reload --port 8000
# health:  http://localhost:8000/api/health
# docs:    http://localhost:8000/docs
```

### Frontend
```bash
cd frontend
npm install
cp .env.local.example .env.local   # NEXT_PUBLIC_API_BASE=http://localhost:8000
npm run dev                         # http://localhost:3000
```

## Provider satellitare

- `PROVIDER_MODE=synthetic` (default): dati generati in locale, deterministici
  per area. La UI (anteprima indici, DEM, ricerca date) funziona **senza
  consumare crediti Copernicus**. Ideale per sviluppo e demo.
- `PROVIDER_MODE=cdse`: dati reali Sentinel-2 L2A + DEM Copernicus. Richiede le
  credenziali del **secondo account CDSE** nelle env var. Nessuna altra modifica
  al codice.

## API (M1)

| Metodo | Endpoint | Descrizione |
|---|---|---|
| GET | `/api/health` | stato + provider_mode + rev |
| GET/POST/PATCH/DELETE | `/api/clients` | clienti |
| GET/POST/PATCH/DELETE | `/api/projects` | progetti (filtro `?client_id=`) |
| GET | `/api/projects/{id}/areas` | aree del progetto |
| POST/GET/PATCH/DELETE | `/api/areas` | aree di progetto (GeoJSON) |
| POST | `/api/satellite/scenes` | date/scene disponibili per l'area |
| POST | `/api/satellite/preview` | anteprima indice (NDVI/NDMI/NDRE/MSI/RGB) |
| POST | `/api/satellite/dem` | anteprima DEM (quota) |
| POST | `/api/suitability` | mappa idoneità (pendenza+indici+clima), pesi/soglie regolabili |
| POST | `/api/layout` | layout pivot (quadrata/sfalsata) + fasi + dimensionamento idrico |
| POST | `/api/project/report` | scheda progetto PDF brandizzata (con schema impianto) |

## Deploy su Render

Il file `render.yaml` è un blueprint: crea il DB Postgres, il servizio API e il
servizio web. Le variabili sensibili (credenziali CDSE, `NEXT_PUBLIC_API_BASE`,
`CORS_ORIGINS`) sono `sync:false` → si impostano dal dashboard, non nel repo.

## Versionamento

La revisione software è nella costante **`REV`** — frontend:
`frontend/src/app/page.tsx`; backend: `backend/app/main.py`. Aggiornarle a ogni
versione consegnata (attuale: **v0.5.0**).

## Note sul layout pivot (M3)

Due configurazioni scelte dall'utente (come negli schemi di progetto):

- **Maglia quadrata**: file e colonne allineate, adduttrici dritte e
  perpendicolari al canale. Efficienza d'impacchettamento ≈ **78,5%** (π/4).
- **Maglia triangolare (sfalsata / quinconce)**: file sfalsate, adduttrici
  diagonali più lunghe. Efficienza → **90,7%** (π/2√3), limitata dai bordi.

Il campo `packing_pct` riproduce la metrica degli schemi ("Gross Area for … Ha
Pivots"); `coverage_pct` è invece la copertura dell'area disegnata (con margini).

**Pendenza in funzione del trasporto acqua**:

- **Canali a gravità**: l'acqua scorre per gravità → serve terreno pianeggiante
  e regolare. Vincolo severo (pendenza max ~2%): i pivot su terreno più ripido
  vengono scartati. Favorisce la maglia quadrata (canali dritti).
- **Tubazioni interrate in pressione**: la pompa fornisce il carico → si tollera
  più pendenza (max ~12%, limite pratico del pivot); cresce però l'energia di
  sollevamento.

La spaziatura tra i pivot è regolabile (distanza tra i bordi, m → interasse
`2R + gap`). Il dimensionamento idrico usa l'ET₀ di punta (FAO-56) × Kc /
efficienza per calcolare portata per pivot, portata totale e volumi.

**Rifiniture (v0.3.1)**:

- **Reticolo orientato al canale/campo**: di default le file si allineano al
  bordo più lungo del poligono (il canale corre lungo quel bordo); si può forzare
  un azimut manuale o spostare il canale sul bordo opposto. Così un campo ruotato
  mantiene il packing pieno (78,5% / 90,7%) invece di perdere i pivot ai bordi.
- **Layout solo sulle aree idonee (incrocio con M2)**: attivando l'opzione, i
  pivot vengono posati solo dove l'idoneità ≥ soglia scelta (oltre al vincolo di
  pendenza), riusando la stessa griglia dell'idoneità (nessun consumo extra).

**Rifiniture (v0.4.0)**:

- **Sbordo controllato**: consente ai pivot di uscire dall'area di una quota del
  raggio (0–30%) per recuperare pivot ai bordi.
- **Rete a spine + collettore**: oltre alla tubazione delle spine si calcola il
  collettore lungo il canale che collega le pompe e la **lunghezza totale** della
  rete.

## Fasi di sviluppo ed export (M4)

- **Fasi di sviluppo**: i pivot si suddividono in 1–6 fasi, ordinabili per
  vicinanza al canale (infrastruttura più economica prima), per idoneità
  (i terreni migliori prima) o per file. Ogni fase riporta pivot, ettari e
  portata; sulla mappa e nello schema i pivot sono colorati per fase.
- **Scheda progetto PDF** (`/api/project/report`): documento brandizzato Nabu con
  dati progetto, sintesi idoneità, configurazione e KPI del layout, rete
  idraulica, dimensionamento idrico, tabella fasi e **schema dell'impianto**
  (cerchi pivot per fase, canale, pompe, condotte) generato lato server.
  **Multilingua** nelle stesse 11 lingue dell'interfaccia (parametro `lang`):
  font incorporati per garantire la resa ovunque — DejaVu Sans (latino/cirillico/
  arabo, in `assets/fonts`), sottoinsieme CJK `NabuCJK.ttf` per il cinese, e
  **reshaping + layout RTL** per l'arabo (`arabic-reshaper` + `python-bidi`). Lo
  schema dell'impianto è localizzato di conseguenza.
- **Export layout in GeoJSON** (lato client) per riuso in QGIS/altri strumenti.

## Note sull'idoneità (M2)

- **Pendenza**: calcolata dal gradiente del DEM (%). È il vincolo dominante per
  i pivot: sopra la "pendenza massima" l'area è declassata a non idonea.
- **Vigore/Umidità**: da NDVI/NDMI della data scelta (proxy di produttività e
  disponibilità idrica del suolo).
- **Clima**: ET₀ FAO-56 e pioggia dai normali NASA POWER; è ~uniforme sull'area
  quindi entra come fattore d'area (indice di aridità) mostrato nel pannello.
- DEM e bande sono scaricati su una griglia comune e messi in **cache**: cambiare
  pesi/soglie ricalcola **senza riscaricare** (nessun consumo di quota).

## Multilingua

Interfaccia e **scheda PDF** complete in **18 lingue** (`frontend/src/lib/i18n.tsx`
per la UI, `backend/analysis/report_i18n.py` per il PDF): italiano, inglese,
francese, spagnolo, arabo, ungherese, tedesco, rumeno, polacco, bulgaro, russo,
kazako, afrikaans, portoghese, malese, indonesiano, cinese mandarino, vietnamita.
L'arabo attiva automaticamente il layout **RTL** (`document.dir` nella UI;
reshaping + tabelle invertite nel PDF). Il dizionario usa la stringa italiana come
chiave; ogni lingua copre l'intero set (139 voci UI). Per aggiungere una lingua:
nuovo dizionario + voce in `LANGS` (e in `RTL_LANGS` se destra-sinistra) e il
corrispondente dizionario in `report_i18n.py`.

I font incorporati coprono tutti gli alfabeti richiesti senza dipendenze esterne:
DejaVu Sans (latino esteso/**vietnamita**, **cirillico** per bg/ru/kk, glifi
arabi) e `NabuCJK.ttf` per il cinese.

**Numeri e date** sono localizzati per lingua: nella UI via `Intl` (separatori e
date dal `locale`, esposto da `useI18n`); nel PDF tramite `fmt_num`/`fmt_date` in
`report_i18n.py` (es. tedesco `4.784`, francese `4 784`, inglese `4,784`; date
`dd.mm.yyyy`, `yyyy-mm-dd`, `yyyy年mm月dd日`…). La scheda PDF riporta la data di
generazione localizzata.

## Roadmap

Le 5 milestone di Argus Total (scaffold → area → idoneità → layout → export)
sono complete. Possibili sviluppi successivi: export DOCX oltre al PDF, snapshot
della mappa satellitare nella scheda, energia di pompaggio (prevalenza/kW dal
DEM), salvataggio di layout e schede lato server, e gli altri prodotti della
suite (Argus Explorer, Argus Vision).
