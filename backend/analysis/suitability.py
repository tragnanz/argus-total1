"""Mappa di idoneità del terreno per progetti agroindustriali (Argus Total).

Incrocia PENDENZA (da DEM), VIGORE/UMIDITÀ (indici Sentinel-2) e CLIMA (ET₀ e
pioggia da NASA POWER) in un punteggio di idoneità 0–100 per pixel, con pesi e
soglie regolabili dall'interfaccia. DEM e bande sono scaricati su UNA griglia
comune (una sola immagine leggera) e messi in cache: cambiando i pesi/soglie il
ricalcolo NON riscarica nulla (nessun consumo di quota Copernicus).
"""
from __future__ import annotations

import base64
import hashlib
import io

import numpy as np
import pyproj

from processing.satellite_export import _utm_bbox, _plan_grid, _stitch
from processing.climate import get_climate

from .eto import eto_year

# cache LRU minimale: firma griglia → (dem, ndvi, ndmi)
_CACHE: dict[str, tuple] = {}
_CACHE_ORDER: list[str] = []
_CACHE_MAX = 8
# cache clima per centroide (dipende solo dal punto): evita di ri-chiamare
# NASA POWER a ogni modifica di pesi/soglie.
_CLIM_CACHE: dict[str, tuple] = {}


def _get_climate_cached(lat: float, lon: float, allow_net: bool):
    key = f"{round(lat, 3)}|{round(lon, 3)}|{int(allow_net)}"
    if key not in _CLIM_CACHE:
        _CLIM_CACHE[key] = get_climate(lat, lon, allow_network=allow_net)
    return _CLIM_CACHE[key]

CLASSES = [
    {"key": "non_idoneo", "label": "non idoneo", "color": "#d73027", "lo": 0,  "hi": 40},
    {"key": "marginale",  "label": "marginale",  "color": "#fee08b", "lo": 40, "hi": 60},
    {"key": "idoneo",     "label": "idoneo",      "color": "#66bd63", "lo": 60, "hi": 80},
    {"key": "ottimale",   "label": "ottimale",    "color": "#1a9850", "lo": 80, "hi": 101},
]
MAX_DIM = 500          # lato max della griglia di calcolo (dettaglio/velocità)


def _hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _ramp(x, lo, hi):
    """Punteggio 0..1 lineare tra lo e hi (clip fuori range)."""
    if hi == lo:
        return np.where(x >= hi, 1.0, 0.0)
    return np.clip((x - lo) / (hi - lo), 0.0, 1.0)


def _poly_mask(geom: dict, epsg, minx, top, res, wp, hp) -> np.ndarray:
    """Maschera booleana (hp,wp): pixel il cui centro cade dentro il poligono."""
    from matplotlib.path import Path
    to_utm = pyproj.Transformer.from_crs(4326, epsg, always_xy=True)
    ring = geom["coordinates"][0]
    pix = []
    for lon, lat, *_ in ring:
        x, y = to_utm.transform(lon, lat)
        pix.append(((x - minx) / res, (top - y) / res))     # (col, row)
    path = Path(pix)
    cc, rr = np.meshgrid(np.arange(wp) + 0.5, np.arange(hp) + 0.5)
    pts = np.column_stack([cc.ravel(), rr.ravel()])
    return path.contains_points(pts).reshape(hp, wp)


def _grid_sig(epsg, minx, miny, wp, hp, date) -> str:
    return hashlib.sha1(
        f"{epsg}|{round(minx)}|{round(miny)}|{wp}|{hp}|{date}".encode()).hexdigest()[:16]


def _fetch_layers(client, geom, date):
    """DEM + NDVI + NDMI + NDWI sulla griglia comune. Usa la cache se disponibile.
    NDWI (McFeeters) serve a riconoscere acqua/aree paludose (saturate)."""
    epsg, minx, miny, maxx, maxy, to_wgs = _utm_bbox(geom)
    res, wp, hp, nx, ny = _plan_grid(minx, miny, maxx, maxy, max_dim=MAX_DIM, max_tiles=1)
    top = miny + hp * res
    south, east = top - hp * res, minx + wp * res
    sig = _grid_sig(epsg, minx, miny, wp, hp, date)
    ctx = dict(epsg=epsg, minx=minx, miny=miny, top=top, south=south, east=east,
               res=res, wp=wp, hp=hp, to_wgs=to_wgs)

    if sig in _CACHE:
        dem, ndvi, ndmi, ndwi = _CACHE[sig]
        return dem, ndvi, ndmi, ndwi, ctx, 0, True

    mos, n_calls, n_ok = _stitch(client, epsg, minx, miny, top, res, wp, hp, nx, ny,
                                 date, ["ndvi", "ndmi", "ndwi"])
    if n_ok == 0:
        raise RuntimeError("Nessuna scena disponibile per la data scelta.")
    ndvi, ndmi, ndwi = mos["ndvi"], mos["ndmi"], mos["ndwi"]
    dem = client.fetch_dem([minx, south, east, top], epsg, wp, hp)
    n_calls += 1

    _CACHE[sig] = (dem, ndvi, ndmi, ndwi)
    _CACHE_ORDER.append(sig)
    while len(_CACHE_ORDER) > _CACHE_MAX:
        old = _CACHE_ORDER.pop(0)
        _CACHE.pop(old, None)
    return dem, ndvi, ndmi, ndwi, ctx, n_calls, False


def score_grid(client, geom: dict, date: str, params: dict) -> dict:
    """Griglia del punteggio di idoneità 0–100 (riusata da mappa e layout M3)."""
    w = params.get("weights", {})
    w_slope = float(w.get("slope", 0.45))
    w_vigor = float(w.get("vigor", 0.25))
    w_moist = float(w.get("moisture", 0.15))
    w_clim = float(w.get("climate", 0.15))
    wsum = w_slope + w_vigor + w_moist + w_clim or 1.0

    slope_ideal = float(params.get("slope_ideal_pct", 3.0))
    slope_max = float(params.get("slope_max_pct", 12.0))
    if slope_max <= slope_ideal:
        slope_max = slope_ideal + 1.0
    ndvi_min = float(params.get("ndvi_min", 0.20))
    ndvi_good = float(params.get("ndvi_good", 0.60))
    ndmi_min = float(params.get("ndmi_min", 0.00))
    ndmi_good = float(params.get("ndmi_good", 0.40))
    allow_net = bool(params.get("allow_climate_network", True))
    # Esclusione aree paludose/acqua (default attivo): NDWI (acqua) + vegetazione
    # bagnata (NDVI alto con NDWI/NDMI elevati = suolo saturo).
    exclude_wetland = bool(params.get("exclude_wetland", True))
    ndwi_water = float(params.get("ndwi_water", 0.20))   # acqua libera
    ndvi_wet = float(params.get("ndvi_wet", 0.30))       # vegetazione presente
    ndwi_wet = float(params.get("ndwi_wet", -0.05))      # umido (meno negativo)
    ndmi_wet = float(params.get("ndmi_wet", 0.55))       # canopy/suolo molto bagnati

    dem, ndvi, ndmi, ndwi, ctx, n_calls, cached = _fetch_layers(client, geom, date)
    res = ctx["res"]

    gy, gx = np.gradient(dem.astype("float64"), res, res)
    slope_pct = np.sqrt(gx ** 2 + gy ** 2) * 100.0

    slope_score = np.clip((slope_max - slope_pct) / (slope_max - slope_ideal), 0.0, 1.0)
    vigor_score = _ramp(ndvi, ndvi_min, ndvi_good)
    moist_score = _ramp(ndmi, ndmi_min, ndmi_good)

    ring = geom["coordinates"][0]
    lon0 = sum(p[0] for p in ring) / len(ring)
    lat0 = sum(p[1] for p in ring) / len(ring)
    clim, elev = _get_climate_cached(lat0, lon0, allow_net)
    et = eto_year(clim, elev, lat0)
    ai = et["aridity_index"] or 0.0
    clim_score = float(np.clip(0.3 + (ai - 0.1) / (0.9 - 0.1) * 0.7, 0.3, 1.0))

    score = (w_slope * slope_score + w_vigor * vigor_score +
             w_moist * moist_score + w_clim * clim_score) / wsum
    score = np.where(slope_pct > slope_max, np.minimum(score, 0.35), score)  # troppo ripido

    # Aree paludose/acqua: escluse dall'idoneità (punteggio azzerato).
    water = ndwi > ndwi_water
    marsh = (ndvi > ndvi_wet) & ((ndwi > ndwi_wet) | (ndmi > ndmi_wet))
    wet = np.isfinite(ndwi) & (water | marsh)
    if exclude_wetland:
        score = np.where(wet, np.minimum(score, 0.05), score)

    score100 = score * 100.0
    valid = np.isfinite(ndvi) & np.isfinite(dem)

    return {"score100": score100, "slope_pct": slope_pct, "valid": valid, "ctx": ctx,
            "et": et, "clim_score": clim_score, "elev": elev, "n_calls": n_calls,
            "cached": cached, "slope_ideal": slope_ideal, "slope_max": slope_max, "wet": wet,
            "dem": dem,
            "weights": {"slope": w_slope, "vigor": w_vigor, "moisture": w_moist, "climate": w_clim}}


def sample_grid(grid: np.ndarray, ctx: dict, x: float, y: float) -> float:
    """Campiona un valore della griglia (indicizzata come il DEM) a (x,y) UTM."""
    col = int((x - ctx["minx"]) / ctx["res"])
    row = int((ctx["top"] - y) / ctx["res"])
    if 0 <= row < ctx["hp"] and 0 <= col < ctx["wp"]:
        v = grid[row, col]
        return float(v) if np.isfinite(v) else float("nan")
    return float("nan")


def compute_suitability(client, geom: dict, date: str, params: dict) -> dict:
    sg = score_grid(client, geom, date, params)
    score100 = sg["score100"]; slope_pct = sg["slope_pct"]; ctx = sg["ctx"]
    et = sg["et"]; clim_score = sg["clim_score"]; elev = sg["elev"]
    n_calls = sg["n_calls"]; cached = sg["cached"]
    slope_ideal = sg["slope_ideal"]; slope_max = sg["slope_max"]; w = sg["weights"]
    res, wp, hp = ctx["res"], ctx["wp"], ctx["hp"]

    mask = _poly_mask(geom, ctx["epsg"], ctx["minx"], ctx["top"], res, wp, hp) & sg["valid"]

    # --- render RGBA (trasparente fuori area / nodata) ---
    rgba = np.zeros((hp, wp, 4), dtype="uint8")
    for cls in CLASSES:
        sel = mask & (score100 >= cls["lo"]) & (score100 < cls["hi"])
        r, g, b = _hex_rgb(cls["color"])
        rgba[sel] = (r, g, b, 210)
    buf = io.BytesIO()
    from PIL import Image
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG")
    image = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

    # --- statistiche per classe (ettari) ---
    pixel_ha = (res * res) / 10000.0
    total_px = int(mask.sum())
    total_ha = round(total_px * pixel_ha, 1)
    classes_out = []
    for cls in CLASSES:
        sel = mask & (score100 >= cls["lo"]) & (score100 < cls["hi"])
        npx = int(sel.sum())
        classes_out.append({
            "key": cls["key"], "label": cls["label"], "color": cls["color"],
            "ha": round(npx * pixel_ha, 1),
            "pct": round(100 * npx / total_px, 1) if total_px else 0.0,
        })
    suitable_ha = round(sum(c["ha"] for c in classes_out if c["key"] in ("idoneo", "ottimale")), 1)
    mean_score = round(float(np.nanmean(score100[mask])), 1) if total_px else 0.0
    slope_in = slope_pct[mask]
    wet_mask = sg.get("wet")
    wetland_ha = round(int((wet_mask & mask).sum()) * pixel_ha, 1) if wet_mask is not None else 0.0

    # quota (DEM) del NETTO COLTIVABILE: min/max/mediana sulle celle idonee
    # (idoneo+ottimale); se non ce ne sono, ripiega sull'intera area valida.
    dem = sg.get("dem")
    elevation = {"min_m": None, "max_m": None, "median_m": None}
    if dem is not None:
        cult = np.zeros((hp, wp), bool)
        for cls in CLASSES:
            if cls["key"] in ("idoneo", "ottimale"):
                cult |= mask & (score100 >= cls["lo"]) & (score100 < cls["hi"])
        sel = cult if cult.any() else mask
        demv = dem[sel]
        demv = demv[np.isfinite(demv)]
        if demv.size:
            elevation = {
                "min_m": round(float(demv.min()), 1),
                "max_m": round(float(demv.max()), 1),
                "median_m": round(float(np.median(demv)), 1),
            }

    corners = [(ctx["minx"], ctx["south"]), (ctx["east"], ctx["south"]),
               (ctx["east"], ctx["top"]), (ctx["minx"], ctx["top"])]
    lls = [ctx["to_wgs"].transform(x, y) for x, y in corners]
    lons = [p[0] for p in lls]; lats = [p[1] for p in lls]
    bounds = [[min(lats), min(lons)], [max(lats), max(lons)]]

    meta = {
        "date": date, "res_m": round(res, 1), "cached": cached, "calls": n_calls,
        "total_ha": total_ha, "suitable_ha": suitable_ha, "mean_score": mean_score,
        "wetland_ha": wetland_ha,
        "elevation": elevation,
        "classes": classes_out,
        "slope": {
            "mean_pct": round(float(np.nanmean(slope_in)), 1) if slope_in.size else 0.0,
            "max_pct": round(float(np.nanmax(slope_in)), 1) if slope_in.size else 0.0,
            "ideal_pct": slope_ideal, "max_allowed_pct": slope_max,
        },
        "climate": {
            "eto_year_mm": et["eto_year_mm"], "rain_year_mm": et["rain_year_mm"],
            "deficit_year_mm": et["deficit_year_mm"], "aridity_index": et["aridity_index"],
            "score": round(clim_score, 2), "elev_m": round(elev, 0), "source": et["source"],
        },
        "weights": w,
    }
    return {"image": image, "bounds": bounds, "meta": meta}
