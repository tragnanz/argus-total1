"""Profilo altimetrico su una polilinea qualsiasi (Argus Total).

Strumento di misura: data una serie di punti (lon/lat) disegnati dall'utente,
campiona la quota del DEM in ciascun punto e calcola distanze progressive e
dislivelli fra i vari punti. Non instrada nulla — è solo una lettura del terreno.
"""
from __future__ import annotations

import numpy as np
import pyproj

from .canal import _dem_and_grid


def sample_elevation(client, coords_ll: list) -> dict:
    if not coords_ll or len(coords_ll) < 1:
        raise RuntimeError("Serve almeno un punto.")
    lons = [float(c[0]) for c in coords_ll]
    lats = [float(c[1]) for c in coords_ll]
    mnx, mxx = min(lons), max(lons)
    mny, mxy = min(lats), max(lats)
    # bbox con margine attorno alla polilinea (min ~0,002° per punti coincidenti)
    mlon = max(0.002, (mxx - mnx) * 0.15)
    mlat = max(0.002, (mxy - mny) * 0.15)
    poly = {"type": "Polygon", "coordinates": [[
        [mnx - mlon, mny - mlat], [mxx + mlon, mny - mlat],
        [mxx + mlon, mxy + mlat], [mnx - mlon, mxy + mlat],
        [mnx - mlon, mny - mlat]]]}
    dem, _mask, ctx = _dem_and_grid(client, poly)
    res, wp, hp = ctx["res"], ctx["wp"], ctx["hp"]
    to_utm = pyproj.Transformer.from_crs(4326, ctx["epsg"], always_xy=True)

    pts = []
    cum = 0.0
    prev_xy = None
    prev_e = None
    for lo, la in zip(lons, lats):
        x, y = to_utm.transform(lo, la)
        col = min(wp - 1, max(0, int((x - ctx["minx"]) / res)))
        row = min(hp - 1, max(0, int((ctx["top"] - y) / res)))
        v = dem[row, col]
        e = float(v) if np.isfinite(v) else None
        if prev_xy is not None:
            cum += ((x - prev_xy[0]) ** 2 + (y - prev_xy[1]) ** 2) ** 0.5
        drop = (prev_e - e) if (prev_e is not None and e is not None) else None
        pts.append({
            "lon": lo, "lat": la,
            "elev_m": round(e, 1) if e is not None else None,
            "dist_m": round(cum, 1),
            "drop_prev_m": round(drop, 2) if drop is not None else None,
        })
        prev_xy = (x, y)
        prev_e = e

    evals = [p["elev_m"] for p in pts if p["elev_m"] is not None]
    total_drop = None
    if len(pts) >= 2 and pts[0]["elev_m"] is not None and pts[-1]["elev_m"] is not None:
        total_drop = round(pts[0]["elev_m"] - pts[-1]["elev_m"], 2)
    return {
        "points": pts,
        "total_drop_m": total_drop,
        "length_m": round(cum, 1),
        "min_m": round(min(evals), 1) if evals else None,
        "max_m": round(max(evals), 1) if evals else None,
    }
