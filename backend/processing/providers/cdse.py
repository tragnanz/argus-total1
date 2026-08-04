"""Provider Copernicus Data Space Ecosystem (API Sentinel Hub).

Flusso: token OAuth2 (client_credentials) → ricerca date scene via Catalog
(STAC) → per ogni data, Process API con evalscript che restituisce le bande +
SCL ritagliate al campo a 10 m nel CRS UTM del campo → cloud masking SCL →
calcolo indice → composito mediano per anno.

Il livello HTTP (`CdseClient`) è isolato e mockabile: i test lo sostituiscono
con risposte sintetiche, così l'intera pipeline del provider è verificabile
senza credenziali né rete.
"""
from __future__ import annotations
import datetime as dt
import warnings
import numpy as np
import requests

from ..indices import compute_index, REQUIRED_BANDS
from ..masking import scl_valid_mask, valid_fraction
from ..geo_prep import prepare_field, build_geometry_for_field

TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process"
CATALOG_URL = "https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search"

# Ordine delle bande restituite dall'evalscript
BANDS = ["B02", "B03", "B04", "B05", "B08", "B11", "SCL"]

EVALSCRIPT = """//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B02","B03","B04","B05","B08","B11","SCL"] }],
    output: { bands: 7, sampleType: "FLOAT32" }
  };
}
function evaluatePixel(s) {
  return [s.B02, s.B03, s.B04, s.B05, s.B08, s.B11, s.SCL];
}
"""

DEM_EVALSCRIPT = """//VERSION=3
function setup() {
  return {
    input: [{ bands: ["DEM"] }],
    output: { bands: 1, sampleType: "FLOAT32" }
  };
}
function evaluatePixel(s) {
  return [s.DEM];
}
"""


class CdseClient:
    """Client HTTP verso CDSE. Isolato per essere sostituibile nei test."""

    def __init__(self, client_id: str, client_secret: str, session=None):
        self.client_id = client_id
        self.client_secret = client_secret
        self.session = session or requests.Session()
        self._token = None
        self._exp = 0.0

    def token(self) -> str:
        now = dt.datetime.now().timestamp()
        if self._token and now < self._exp - 60:
            return self._token
        r = self.session.post(TOKEN_URL, data={
            "grant_type": "client_credentials",
            "client_id": self.client_id,
            "client_secret": self.client_secret,
        }, timeout=30)
        r.raise_for_status()
        j = r.json()
        self._token = j["access_token"]
        self._exp = now + float(j.get("expires_in", 600))
        return self._token

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token()}"}

    def search_dates(self, bbox_wgs84, date_from, date_to,
                     max_cloud=80, limit=100) -> list[str]:
        payload = {
            "collections": ["sentinel-2-l2a"],
            "bbox": list(bbox_wgs84),
            "datetime": f"{date_from}T00:00:00Z/{date_to}T23:59:59Z",
            "limit": limit,
            "filter": {"op": "<=", "args": [{"property": "eo:cloud_cover"}, max_cloud]},
            "filter-lang": "cql2-json",
        }
        dates: set[str] = set()
        r = self.session.post(CATALOG_URL, json=payload, headers=self._headers(), timeout=60)
        r.raise_for_status()
        for feat in r.json().get("features", []):
            dtm = feat.get("properties", {}).get("datetime")
            if dtm:
                dates.add(dtm[:10])
        return sorted(dates)

    def search_scenes(self, bbox_wgs84, date_from, date_to,
                      max_cloud=90, limit=100) -> list[dict]:
        """Come search_dates ma ritorna [{date, cloud}] (nuvolosità %) per data,
        più recente prima. Tiene la scena meno nuvolosa per ogni giorno."""
        payload = {
            "collections": ["sentinel-2-l2a"],
            "bbox": list(bbox_wgs84),
            "datetime": f"{date_from}T00:00:00Z/{date_to}T23:59:59Z",
            "limit": limit,
            "filter": {"op": "<=", "args": [{"property": "eo:cloud_cover"}, max_cloud]},
            "filter-lang": "cql2-json",
        }
        r = self.session.post(CATALOG_URL, json=payload, headers=self._headers(), timeout=60)
        r.raise_for_status()
        best: dict[str, float] = {}
        for feat in r.json().get("features", []):
            p = feat.get("properties", {})
            d = (p.get("datetime") or "")[:10]
            cc = p.get("eo:cloud_cover")
            if not d:
                continue
            if d not in best or (cc is not None and (best[d] is None or cc < best[d])):
                best[d] = cc
        return [{"date": d, "cloud": best[d]} for d in sorted(best, reverse=True)]

    def fetch_bands(self, bbox_utm, epsg, width, height, day) -> np.ndarray:
        """Ritorna un array (7, H, W) float32: B02,B03,B04,B05,B08,B11,SCL."""
        payload = {
            "input": {
                "bounds": {
                    "bbox": list(bbox_utm),
                    "properties": {"crs": f"http://www.opengis.net/def/crs/EPSG/0/{epsg}"},
                },
                "data": [{
                    "type": "sentinel-2-l2a",
                    "dataFilter": {
                        "timeRange": {"from": f"{day}T00:00:00Z", "to": f"{day}T23:59:59Z"},
                        "mosaickingOrder": "leastCC",
                    },
                }],
            },
            "output": {
                "width": int(width), "height": int(height),
                "responses": [{"identifier": "default", "format": {"type": "image/tiff"}}],
            },
            "evalscript": EVALSCRIPT,
        }
        r = self.session.post(PROCESS_URL, json=payload, headers=self._headers(), timeout=120)
        if not r.ok:
            raise RuntimeError(f"CDSE Process API {r.status_code}: {r.text[:600]}")
        from rasterio.io import MemoryFile  # import lazy (solo nel percorso live)
        with MemoryFile(r.content) as mf, mf.open() as ds:
            return ds.read().astype("float32")

    def fetch_dem(self, bbox_utm, epsg, width, height,
                  dem_instance: str = "COPERNICUS_30") -> np.ndarray:
        """Ritorna un array (H, W) float32 con la quota (m) dal DEM Copernicus.
        Usato per le mappe di livello: incrocia i ristagni con la topografia."""
        payload = {
            "input": {
                "bounds": {
                    "bbox": list(bbox_utm),
                    "properties": {"crs": f"http://www.opengis.net/def/crs/EPSG/0/{epsg}"},
                },
                "data": [{
                    "type": "dem",
                    "dataFilter": {"demInstance": dem_instance},
                }],
            },
            "output": {
                "width": int(width), "height": int(height),
                "responses": [{"identifier": "default", "format": {"type": "image/tiff"}}],
            },
            "evalscript": DEM_EVALSCRIPT,
        }
        r = self.session.post(PROCESS_URL, json=payload, headers=self._headers(), timeout=120)
        if not r.ok:
            raise RuntimeError(f"CDSE DEM Process API {r.status_code}: {r.text[:600]}")
        from rasterio.io import MemoryFile
        with MemoryFile(r.content) as mf, mf.open() as ds:
            return ds.read(1).astype("float32")


def fetch_area_composite(client: "CdseClient", polygon_lonlat: dict,
                         season_months: tuple[int, int] = (4, 9),
                         start_year: int | None = None, res_m: float = 10.0,
                         max_scenes: int = 8, max_dim: int = 1800,
                         max_cloud: float = 60.0, dry_background: bool = False,
                         years: int = 1):
    """Composito NDVI di UN'area (bbox), per il rilevamento campi.
    Ritorna (comps, grid, epsg, to_wgs, meta). Aumenta la risoluzione se l'area
    è troppo grande, per rispettare i limiti della Process API.

    dry_background=True: dentro ciascun anno tiene solo le scene a SFONDO più
    secco (mediana d'area NDVI più bassa) → i pivot irrigati restano verdi, lo
    sfondo è brullo, contrasto massimo.

    years>1: costruisce la maschera di vegetazione PERSISTENTE su più anni.
    L'NDVI di uscita è un basso-percentile fra i compositi annuali: resta alto
    solo dove è verde OGNI anno (pivot sempre irrigati), mentre la boscaglia
    stagionale (verde solo in alcuni anni) scende → dischi puliti. L'NDMI di
    uscita è il massimo fra gli anni (miglior evidenza d'irrigazione)."""
    grid, _mask, _ring, epsg, to_wgs = prepare_field(polygon_lonlat, res_m, neg_buffer_m=0.0)
    while grid.width > max_dim or grid.height > max_dim:
        res_m *= 1.5
        grid, _mask, _ring, epsg, to_wgs = prepare_field(polygon_lonlat, res_m, neg_buffer_m=0.0)

    minx, miny = grid.x0, grid.y0
    maxx = minx + grid.width * res_m
    maxy = miny + grid.height * res_m
    bbox_utm = [minx, miny, maxx, maxy]
    lon_a, lat_a = to_wgs.transform(minx, miny)
    lon_b, lat_b = to_wgs.transform(maxx, maxy)
    bbox_wgs = [min(lon_a, lon_b), min(lat_a, lat_b), max(lon_a, lon_b), max(lat_a, lat_b)]

    names = ["ndvi", "ndwi", "ndmi"]     # NDVI rileva, NDWI=acqua, NDMI=umidità
    m0, m1 = season_months
    last_day = 28 if m1 == 2 else 30
    base_year = start_year if start_year is not None else dt.date.today().year - 1
    n_years = max(1, int(years))

    yearly: dict[str, list] = {n: [] for n in names}   # un composito per anno
    total_scenes = total_requests = 0
    for yk in range(n_years):
        year = base_year - yk
        dates = client.search_dates(bbox_wgs, f"{year}-{m0:02d}-01",
                                    f"{year}-{m1:02d}-{last_day:02d}", max_cloud=max_cloud)
        dates = _subsample(dates, max_scenes)
        total_requests += len(dates) + 1
        if not dates:
            continue
        stacks: dict[str, list] = {n: [] for n in names}
        for day in dates:
            try:
                arr = client.fetch_bands(bbox_utm, epsg, grid.width, grid.height, day)
            except Exception:  # noqa: BLE001 — una scena lenta/fallita non blocca tutto
                continue
            bands = {name: arr[i] for i, name in enumerate(BANDS)}
            valid = scl_valid_mask(bands["SCL"])
            bd = {b: bands[b] for b in REQUIRED_BANDS}
            for n in names:
                stacks[n].append(np.where(valid, compute_index(n, bd), np.nan))
        total_scenes += len(stacks["ndvi"])
        if dry_background and len(stacks["ndvi"]) >= 3:
            with np.errstate(invalid="ignore"), warnings.catch_warnings():
                warnings.simplefilter("ignore", category=RuntimeWarning)
                scene_med = [float(np.nanmedian(a)) for a in stacks["ndvi"]]
            order = np.argsort(np.nan_to_num(scene_med, nan=1.0))
            k = max(2, len(order) // 2)
            keep = set(int(i) for i in order[:k])
            for n in names:
                stacks[n] = [a for i, a in enumerate(stacks[n]) if i in keep]
        with np.errstate(invalid="ignore"), warnings.catch_warnings():
            warnings.simplefilter("ignore", category=RuntimeWarning)
            for n in names:
                if stacks[n]:
                    yearly[n].append(np.nanmedian(np.stack(stacks[n]), axis=0))

    comps: dict[str, np.ndarray] = {}
    with np.errstate(invalid="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        if yearly["ndvi"]:
            # MASSIMO fra gli anni: un pivot montato/usato anche solo in 1 dei 3
            # anni (verde in quell'anno) emerge lo stesso. La mediana lo avrebbe
            # soppresso perché a riposo negli altri due. La precisione contro la
            # boscaglia la danno la soglia/intensità NDMI e i filtri di forma.
            comps["ndvi"] = np.nanmax(np.stack(yearly["ndvi"]), axis=0)
        else:
            comps["ndvi"] = np.full(grid.shape, np.nan)
        comps["ndmi"] = (np.nanmax(np.stack(yearly["ndmi"]), axis=0)
                         if yearly["ndmi"] else np.full(grid.shape, np.nan))
        comps["ndwi"] = (np.nanmedian(np.stack(yearly["ndwi"]), axis=0)
                         if yearly["ndwi"] else np.full(grid.shape, np.nan))
    meta = {"scenes_used": total_scenes, "requests": total_requests,
            "epsg": epsg, "res_m": res_m, "provider": "cdse",
            "dry_background": bool(dry_background), "years": n_years}
    return comps, grid, epsg, to_wgs, meta


def _seasons(years: int, months: tuple[int, int], start_year: int | None):
    end = (start_year if start_year is not None else dt.date.today().year - 1)
    return [end - k for k in range(years)]


def _subsample(dates: list[str], cap: int | None) -> list[str]:
    """Riduce il numero di scene per anno (protezione quota): campionamento
    uniforme sulle date disponibili."""
    if not cap or len(dates) <= cap:
        return dates
    step = len(dates) / cap
    return [dates[int(i * step)] for i in range(cap)]


def build_cdse_inputs(client: CdseClient, polygon_lonlat: dict, irr_type: str,
                      params: dict, years: int = 5, index: str = "ndvi",
                      season_months: tuple[int, int] = (4, 9), res_m: float = 10.0,
                      min_valid_frac: float = 0.6, max_cloud: float = 80.0,
                      start_year: int | None = None,
                      max_scenes_per_year: int | None = 12,
                      center_exclusion_m: float = 25.0):
    """Ritorna (years_arrays, mask, geometry, grid) — stesso contratto del
    provider synthetic, così la pipeline a valle non cambia."""
    grid, mask, ring_utm, epsg, to_wgs = prepare_field(polygon_lonlat, res_m)
    geom = build_geometry_for_field(grid, ring_utm, irr_type, params)

    # Esclude il centro del pivot (platea di cemento / gruppo di pompaggio):
    # NDVI strutturalmente basso, non è un'anomalia agronomica.
    if irr_type == "center_pivot" and center_exclusion_m and center_exclusion_m > 0:
        mask = mask & (geom.r > float(center_exclusion_m))

    minx, miny = grid.x0, grid.y0
    maxx = minx + grid.width * res_m
    maxy = miny + grid.height * res_m
    bbox_utm = [minx, miny, maxx, maxy]
    (lon_a, lat_a) = to_wgs.transform(minx, miny)
    (lon_b, lat_b) = to_wgs.transform(maxx, maxy)
    bbox_wgs = [min(lon_a, lon_b), min(lat_a, lat_b), max(lon_a, lon_b), max(lat_a, lat_b)]

    m0, m1 = season_months
    # oltre all'indice dell'analisi, compone anche gli indici di visualizzazione
    # (dalle stesse bande già scaricate → nessuna richiesta Copernicus extra).
    viz = list(dict.fromkeys([index, "ndvi", "ndmi", "ndre", "msi"]))
    used, excluded = 0, 0
    season_list = _seasons(years, season_months, start_year)
    index_year: dict[str, list] = {name: [] for name in viz}
    for year in season_list:
        date_from = f"{year}-{m0:02d}-01"
        last_day = 28 if m1 == 2 else 30
        date_to = f"{year}-{m1:02d}-{last_day:02d}"
        dates = client.search_dates(bbox_wgs, date_from, date_to, max_cloud=max_cloud)
        dates = _subsample(dates, max_scenes_per_year)
        stacks: dict[str, list] = {name: [] for name in viz}
        for day in dates:
            arr = client.fetch_bands(bbox_utm, epsg, grid.width, grid.height, day)
            bands = {name: arr[i] for i, name in enumerate(BANDS)}
            valid = scl_valid_mask(bands["SCL"]) & mask
            if valid_fraction(valid, mask) < min_valid_frac:
                excluded += 1
                continue
            used += 1
            bd = {b: bands[b] for b in REQUIRED_BANDS}
            for name in viz:
                stacks[name].append(np.where(valid, compute_index(name, bd), np.nan))
        for name in viz:
            if stacks[name]:
                with np.errstate(invalid="ignore"), warnings.catch_warnings():
                    warnings.simplefilter("ignore", category=RuntimeWarning)
                    comp = np.nanmedian(np.stack(stacks[name]), axis=0)
            else:
                comp = np.full(grid.shape, np.nan)
            index_year[name].append(np.where(mask, comp, np.nan))
    years_arrays = index_year[index]

    meta = {"scenes_used": used, "scenes_excluded": excluded,
            "fetches": used + excluded, "catalog_searches": len(season_list),
            "requests": used + excluded + len(season_list),
            "index": index, "epsg": epsg, "provider": "cdse",
            "year_labels": [str(y) for y in season_list]}
    return years_arrays, mask, geom, grid, meta, index_year


def estimate_cdse_scenes(client: CdseClient, polygon_lonlat: dict, years: int = 5,
                         season_months: tuple[int, int] = (4, 9), res_m: float = 10.0,
                         max_cloud: float = 80.0, start_year: int | None = None,
                         max_scenes_per_year: int | None = 12) -> dict:
    """Stima *senza scaricare* quante scene un'analisi userebbe: interroga solo
    il Catalog (ricerca), utile per sapere in anticipo il consumo di quota."""
    grid, _mask, _ring, epsg, to_wgs = prepare_field(polygon_lonlat, res_m)
    minx, miny = grid.x0, grid.y0
    maxx = minx + grid.width * res_m
    maxy = miny + grid.height * res_m
    (lon_a, lat_a) = to_wgs.transform(minx, miny)
    (lon_b, lat_b) = to_wgs.transform(maxx, maxy)
    bbox_wgs = [min(lon_a, lon_b), min(lat_a, lat_b), max(lon_a, lon_b), max(lat_a, lat_b)]
    m0, m1 = season_months
    total_available = 0
    total_capped = 0
    searches = 0
    for year in _seasons(years, season_months, start_year):
        last_day = 28 if m1 == 2 else 30
        dates = client.search_dates(bbox_wgs, f"{year}-{m0:02d}-01",
                                    f"{year}-{m1:02d}-{last_day:02d}", max_cloud=max_cloud)
        searches += 1
        total_available += len(dates)
        total_capped += min(len(dates), max_scenes_per_year or len(dates))
    return {"available_scenes": total_available, "planned_fetches": total_capped,
            "catalog_searches": searches,
            "estimated_requests": total_capped + searches}
