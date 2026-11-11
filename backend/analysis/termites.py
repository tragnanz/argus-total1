"""Problemi del terreno dalle immagini Sentinel-2, divisi per origine.

- Termitai (scena più secca): vedi sotto.
- Aree saline (tutte le scene dell'anno): croste di sale chiare e "bianche" (blu ≈ rosso),
  senza vegetazione, riflettenti anche nel NIR, in almeno una scena (il sale affiora a
  stagioni: spesso in primavera); si tolgono le forme sottili (strade, tetti) con
  un'apertura morfologica, restano le chiazze larghe almeno ~30 m. Le scene con neve
  (SCL 11) non si usano: la neve ha la stessa firma del sale.
- Ristagni stagionali (scena più bagnata): acqua o suolo saturo (MNDWI con lo SWIR) nella
  scena con più superficie bagnata, dove nella scena secca non c'è acqua permanente.
- Specchi d'acqua permanenti: acqua anche nella scena più secca.
- Alberi e arbusti da disboscare (scena più secca): vegetazione verde in macchie più grandi
  di un termitaio.
Le classi tornano come griglia lon/lat (bit per classe, zlib+base64) allineata alla mappa.

Termitai dalle immagini Sentinel-2 (stagione secca).

Nella savana i termitai grandi (10–40 m di diametro) portano alberi e arbusti che restano
verdi quando il campo intorno è secco: nell'NDVI di una scena della stagione secca sono
macchie isolate di 1–10 pixel, più verdi dello sfondo. Si sceglie la scena più secca degli
ultimi 12 mesi (NDVI mediano più basso nell'area, senza nuvole), si toglie lo sfondo con un
filtro mediano su ~110 m e si tengono le macchie piccole e isolate su terreno aperto
(sfondo con NDVI basso: nel bosco un termitaio non si distingue dagli alberi).

Il diametro è quello della macchia verde (minimo 8 m, il pixel è di 10 m): per i termitai
più piccoli la scena a 10 m non basta, e vanno segnati a mano.
"""
from __future__ import annotations

import base64
import datetime as dt
import math
import zlib

import numpy as np

from .waterways import _grid

CLOUD_SCL = (3, 8, 9, 10)                       # ombra, nuvole medie/alte, cirri
THR = {1: 0.08, 2: 0.065, 3: 0.05, 4: 0.04, 5: 0.03}   # sensibilità → scarto minimo di NDVI
# bit delle classi nella griglia
F_SALT, F_WET, F_WOOD, F_WATER = 1, 2, 4, 8
WOOD_NDVI = {1: 0.50, 2: 0.45, 3: 0.40, 4: 0.37, 5: 0.34}
SALT_BRIGHT = {1: 0.30, 2: 0.28, 3: 0.25, 4: 0.23, 5: 0.21}
WET_MNDWI = {1: 0.10, 2: 0.05, 3: 0.0, 4: -0.05, 5: -0.10}
MAX_CELLS = 2_500_000
TERMITE_LAT = 32.0                 # oltre questa latitudine niente termitai a cumulo


def _poly_mask(g: dict, geom: dict) -> np.ndarray:
    import pyproj
    from matplotlib.path import Path
    to_utm = pyproj.Transformer.from_crs(4326, g["epsg"], always_xy=True)
    rings = [[to_utm.transform(lo, la) for lo, la, *_ in r] for r in geom["coordinates"]]
    xs = g["minx"] + (np.arange(g["wp"]) + 0.5) * g["res"]
    ys = g["top"] - (np.arange(g["hp"]) + 0.5) * g["res"]
    X, Y = np.meshgrid(xs, ys)
    pts = np.c_[X.ravel(), Y.ravel()]
    m = Path(rings[0]).contains_points(pts)
    for h in rings[1:]:
        m &= ~Path(h).contains_points(pts)
    return m.reshape(g["hp"], g["wp"])


def _scenes(client, bbox, date_to: str, months: int = 12, max_cloud: float = 10) -> list[str]:
    """Una scena per mese (la prima trovata con poche nuvole), dalle più recenti."""
    d1 = dt.date.fromisoformat(date_to)
    d0 = d1 - dt.timedelta(days=int(months * 30.44))
    out: dict[str, str] = {}
    a = d0
    while a < d1:
        b = min(d1, a + dt.timedelta(days=91))
        try:
            for d in client.search_dates(bbox, a.isoformat(), b.isoformat(), max_cloud=max_cloud):
                out.setdefault(d[:7], d)
        except Exception:  # noqa: BLE001
            pass
        a = b + dt.timedelta(days=1)
    return [out[k] for k in sorted(out)]


def _open(nd, m: np.ndarray, px: int) -> np.ndarray:
    """Toglie forme più sottili di px pixel (strade, argini, tetti)."""
    if px <= 1:
        return m
    return nd.binary_opening(m, structure=np.ones((px, px), bool))


def _to_lonlat_grid(g: dict, flags: np.ndarray) -> dict:
    """Ricampiona la griglia UTM delle classi su una griglia lon/lat (vicino più prossimo)."""
    import pyproj
    w, s_, e, n = g["bbox_wgs"]
    lat0 = (s_ + n) / 2
    res = g["res"]
    dlon = res / (111320 * math.cos(math.radians(lat0)))
    dlat = res / 110540
    W, H = max(1, math.ceil((e - w) / dlon)), max(1, math.ceil((n - s_) / dlat))
    k = 1.0
    while W * H > MAX_CELLS:
        k *= 1.25
        W, H = math.ceil((e - w) / (dlon * k)), math.ceil((n - s_) / (dlat * k))
    dlon, dlat = (e - w) / W, (n - s_) / H
    lons = w + (np.arange(W) + 0.5) * dlon
    lats = n - (np.arange(H) + 0.5) * dlat
    LO, LA = np.meshgrid(lons, lats)
    to_utm = pyproj.Transformer.from_crs(4326, g["epsg"], always_xy=True)
    X, Y = to_utm.transform(LO.ravel(), LA.ravel())
    c = np.floor((np.asarray(X) - g["minx"]) / res).astype(int)
    r = np.floor((g["top"] - np.asarray(Y)) / res).astype(int)
    okp = (c >= 0) & (c < g["wp"]) & (r >= 0) & (r < g["hp"])
    out = np.zeros(W * H, np.uint8)
    out[okp] = flags[r[okp], c[okp]]
    return {"w": int(W), "h": int(H), "bbox": [w, s_, e, n],
            "b64": base64.b64encode(zlib.compress(out.tobytes(), 6)).decode()}


def detect_termites(client, geom: dict, date: str | None = None, sens: int = 3,
                    max_scenes: int = 8, layers: bool = True) -> dict:
    from scipy import ndimage as nd
    sens = int(sens) if int(sens) in THR else 3
    g = _grid(geom)
    res = g["res"]
    inside = _poly_mask(g, geom)
    bbox_utm = [g["minx"], g["top"] - g["hp"] * res, g["minx"] + g["wp"] * res, g["top"]]
    date_to = date or dt.date.today().isoformat()
    months = _scenes(client, g["bbox_wgs"], date_to, max_cloud=40 if layers else 10)
    if not months:
        raise RuntimeError("nessuna scena Sentinel-2 senza nuvole negli ultimi 12 mesi")
    # al massimo max_scenes scene distribuite nell'anno: la più secca e la più bagnata
    step = max(1, math.ceil(len(months) / max_scenes))
    cand = months[::step]
    best = None
    wet_best = None
    salt_any = np.zeros(inside.shape, bool)
    n_in = max(1, int(inside.sum()))
    for d in cand:
        try:
            b = client.fetch_bands(bbox_utm, g["epsg"], g["wp"], g["hp"], d)
        except Exception:  # noqa: BLE001
            continue
        blue, green, red, nir, swir, scl = b[0], b[1], b[2], b[4], b[5], b[6]
        ok = inside & np.isfinite(red) & np.isfinite(nir) & ~np.isin(scl, CLOUD_SCL)
        if ok.sum() < 0.8 * n_in or (scl[inside] == 11).mean() > 0.05:   # nuvole o neve
            continue
        ndvi = (nir - red) / (nir + red + 1e-6)
        med = float(np.nanmedian(ndvi[ok]))
        if layers:
            mndwi = (green - swir) / (green + swir + 1e-6)
            wet = ok & np.isfinite(swir) & (mndwi > WET_MNDWI[sens])
            fr = float(wet.sum()) / n_in
            if wet_best is None or fr > wet_best[1]:
                wet_best = (d, fr, wet)
            bright = (blue + green + red) / 3
            salt_any |= ok & (ndvi < 0.15) & (bright > SALT_BRIGHT[sens]) & (blue > 0.8 * red) & (nir > 0.2)
        if best is None or med < best[1]:
            extra = None
            if layers:
                water = ok & np.isfinite(swir) & (((green - swir) / (green + swir + 1e-6)) > 0.1) & (nir < 0.15)
                extra = water
            best = (d, med, ndvi, ok, extra)
    if best is None:
        raise RuntimeError("nessuna scena utilizzabile (nuvole o dati mancanti)")
    d, med, ndvi, ok, extra = best
    nd_f = np.where(ok, ndvi, med)
    bg = nd.median_filter(nd_f, size=max(5, int(round(110 / res)) | 1))
    an = nd_f - bg
    thr = THR.get(int(sens), 0.05)
    m = (an > thr) & (bg < 0.30) & ok
    lab, n = nd.label(m)
    out = []
    max_px = max(2, int(round(1000 / (res * res))))      # macchie fino a ~1000 m² (≈ 36 m di diametro)
    if n:
        idx = np.arange(1, n + 1)
        sz = nd.sum(m, lab, idx)
        cm = nd.center_of_mass(m, lab, idx)
        pk = nd.maximum(an, lab, idx)
        for (r, c), s, p in zip(cm, sz, pk):
            if s < 1 or s > max_px:
                continue
            x = g["minx"] + (c + 0.5) * res
            y = g["top"] - (r + 0.5) * res
            lon, lat = g["to_wgs"].transform(x, y)
            dia = max(8.0, min(40.0, 2 * math.sqrt(s * res * res / math.pi)))
            out.append({"lon": round(lon, 6), "lat": round(lat, 6), "d_m": round(dia, 1), "score": round(float(p), 3)})
    out.sort(key=lambda q: -q["score"])
    # termitai a cumulo solo nella fascia tropicale e subtropicale: altrove le macchie verdi sono alberi
    lat0 = (g["bbox_wgs"][1] + g["bbox_wgs"][3]) / 2
    skipped = abs(lat0) > TERMITE_LAT
    if skipped:
        out = []
    res_out = {"date": d, "ndvi_median": round(med, 3), "res_m": res, "mounds": out[:5000], "n_total": len(out), "termites_skipped": skipped}
    if layers and extra is not None:
        water = extra
        salt = salt_any & ~water
        px30 = max(2, int(round(30 / res)))
        salt = _open(nd, salt, px30)
        water = _open(nd, water, 2)
        wetm = np.zeros_like(ok) if wet_best is None else wet_best[2]
        perm = nd.binary_dilation(water, iterations=1)
        wetm = _open(nd, wetm & ~perm, px30)
        # alberi e arbusti: macchie verdi nella scena secca più grandi di un termitaio
        wood = ok & (ndvi > WOOD_NDVI[sens])
        lw, nw = nd.label(wood)
        if nw:
            szw = nd.sum(wood, lw, np.arange(1, nw + 1))
            big = np.concatenate([[False], szw > max_px])
            wood = big[lw]
        wood &= ~salt & ~water
        flags = (salt * F_SALT | wetm * F_WET | wood * F_WOOD | water * F_WATER).astype(np.uint8)
        flags[~inside] = 0
        ha = res * res / 10000
        res_out["layers"] = {
            **_to_lonlat_grid(g, flags),
            "date_dry": d, "date_wet": wet_best[0] if wet_best else None,
            "ha": {"salt": round(float(salt[inside].sum()) * ha, 1), "wet": round(float(wetm[inside].sum()) * ha, 1),
                   "wood": round(float(wood[inside].sum()) * ha, 1), "water": round(float(water[inside].sum()) * ha, 1)},
            "area_ha": round(n_in * ha, 1),
        }
    return res_out
