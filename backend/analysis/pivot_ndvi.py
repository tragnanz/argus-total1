"""NDVI di ogni pivot dall'ultima scena Sentinel-2 L2A poco nuvolosa (controllo dopo la posa).

Per pivot: NDVI medio, coefficiente di variazione (uniformità), quota di superficie «debole»
(NDVI sotto la media di oltre 0,15) e profilo per anelli dal centro alla punta, che fa vedere
i difetti tipici dell'irrigazione (punta secca, ugelli sbagliati in una campata, centro bagnato).
Le nuvole e le loro ombre sono tolte con la classificazione SCL della scena.
"""
from __future__ import annotations

import datetime as dt
import math

import numpy as np
import pyproj

from processing.indices import compute_index

BANDS = ["B02", "B03", "B04", "B05", "B08", "B11"]
SCL_BAD = {0, 1, 3, 8, 9, 10, 11}          # nessun dato, saturi, ombre, nuvole, cirri, neve


def pivots_ndvi(client, pivots: list[dict], days: int = 120, max_cloud: float = 30.0) -> dict:
    if not pivots:
        raise ValueError("Nessun pivot.")
    lons = [p["lng"] for p in pivots]; lats = [p["lat"] for p in pivots]
    lat0, lon0 = sum(lats) / len(lats), sum(lons) / len(lons)
    epsg = 32600 + int((lon0 + 180) // 6) + 1 + (0 if lat0 >= 0 else 100)
    to_utm = pyproj.Transformer.from_crs(4326, epsg, always_xy=True)
    xy = [to_utm.transform(p["lng"], p["lat"]) for p in pivots]
    rmax = max(float(p["r"]) for p in pivots) + 30
    minx, maxx = min(x for x, _ in xy) - rmax, max(x for x, _ in xy) + rmax
    miny, maxy = min(y for _, y in xy) - rmax, max(y for _, y in xy) + rmax
    res = max(10.0, max(maxx - minx, maxy - miny) / 2400)
    w, h = int(math.ceil((maxx - minx) / res)), int(math.ceil((maxy - miny) / res))
    to_wgs = pyproj.Transformer.from_crs(epsg, 4326, always_xy=True)
    a, b = to_wgs.transform(minx, miny), to_wgs.transform(maxx, maxy)
    today = dt.date.today()
    scenes = client.search_scenes([a[0], a[1], b[0], b[1]], str(today - dt.timedelta(days=days)), str(today), max_cloud=max_cloud)
    if not scenes:
        raise ValueError(f"Nessuna scena Sentinel-2 con nuvolosità ≤ {int(max_cloud)}% negli ultimi {days} giorni.")
    sc = scenes[0]                                    # la più recente fra quelle poco nuvolose
    arr = client.fetch_bands([minx, miny, maxx, maxy], epsg, w, h, sc["date"])
    bands = {k: arr[i].astype("float64") for i, k in enumerate(BANDS)}
    ndvi = compute_index("ndvi", bands)
    if arr.shape[0] > 6:
        scl = np.rint(arr[6]).astype(int)
        ndvi = np.where(np.isin(scl, list(SCL_BAD)), np.nan, ndvi)
    H, W = ndvi.shape
    xs = minx + (np.arange(W) + 0.5) * res
    ys = maxy - (np.arange(H) + 0.5) * res
    X, Y = np.meshgrid(xs, ys)
    out = []
    for k, (p, (cx, cy)) in enumerate(zip(pivots, xy)):
        r = float(p["r"])
        d = np.hypot(X - cx, Y - cy)
        m = d <= r
        deg = float(p.get("deg") or 360)
        if deg < 359.5:                               # settore: azimut da nord in senso orario
            az = (np.degrees(np.arctan2(X - cx, Y - cy)) + 360) % 360
            a0 = float(p.get("az") or 0) % 360
            m &= ((az - a0) % 360) <= deg
        v = ndvi[m & np.isfinite(ndvi)]
        n_all = int(m.sum())
        if v.size < 20:
            out.append({"i": k, "ok": False, "valid_pct": round(100 * v.size / max(1, n_all))}); continue
        mean = float(v.mean()); sd = float(v.std())
        rings = []
        for j in range(5):
            mm = m & (d >= r * j / 5) & (d < r * (j + 1) / 5) & np.isfinite(ndvi)
            rings.append(round(float(ndvi[mm].mean()), 3) if mm.any() else None)
        out.append({"i": k, "ok": True, "mean": round(mean, 3), "cv": round(100 * sd / max(1e-3, abs(mean)), 1),
                    "weak_pct": round(100 * float((v < mean - 0.15).mean()), 1), "p10": round(float(np.percentile(v, 10)), 3),
                    "p90": round(float(np.percentile(v, 90)), 3), "rings": rings, "valid_pct": round(100 * v.size / max(1, n_all))})
    return {"date": sc["date"], "cloud": sc.get("cloud"), "res_m": round(res, 1), "pivots": out, "source": "Sentinel-2 L2A (Copernicus)"}
