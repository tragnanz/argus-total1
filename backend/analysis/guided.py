"""Progettazione guidata — Fase 3 (Argus Total, M6).

Lungo il CANALE PRINCIPALE (Fase 2) dispone i pivot: N per lato (destra/sinistra),
numero scelto dall'utente. Per ogni pivot decide la CONNESSIONE al canale:
- il pivot è a valle e il dislivello è dolce (≤ soglia canale) → CANALETTA a gravità;
- il pivot è a monte (serve pompa) o troppo ripido → TUBAZIONE interrata in pressione.
Restituisce un FeatureCollection (canale, pivot, connessioni) + statistiche.
"""
from __future__ import annotations

import math
import numpy as np
import pyproj
from matplotlib.path import Path

from .canal import _route


def _sample_polyline(xy: list, dists: list, target: float):
    """Punto e tangente (versore) sulla polilinea UTM alla distanza `target`."""
    for i in range(1, len(xy)):
        if dists[i] >= target:
            x0, y0 = xy[i - 1]; x1, y1 = xy[i]
            seg = dists[i] - dists[i - 1] or 1e-9
            f = (target - dists[i - 1]) / seg
            px, py = x0 + (x1 - x0) * f, y0 + (y1 - y0) * f
            tx, ty = x1 - x0, y1 - y0
            tn = math.hypot(tx, ty) or 1e-9
            return (px, py), (tx / tn, ty / tn)
    x0, y0 = xy[-2]; x1, y1 = xy[-1]
    tn = math.hypot(x1 - x0, y1 - y0) or 1e-9
    return (x1, y1), ((x1 - x0) / tn, (y1 - y0) / tn)


def design_pivots(client, geom: dict, params: dict) -> dict:
    R = float(params.get("radius_m", 400.0))
    gap = max(0.0, float(params.get("gap_m", 0.0)))
    per_side = max(1, min(4, int(params.get("per_side", 2))))
    target_permille = float(params.get("target_permille", 1.0))
    conn_max = float(params.get("conn_max_permille", 5.0))     # canaletta: pendenza max dolce

    r = _route(client, geom, target_permille)
    dem, ctx, xy = r["dem"], r["ctx"], r["xy"]
    res = ctx["res"]; wp = ctx["wp"]; hp = ctx["hp"]; to_wgs = ctx["to_wgs"]

    to_utm = pyproj.Transformer.from_crs(4326, ctx["epsg"], always_xy=True)
    ring_utm = [to_utm.transform(lon, lat) for lon, lat, *_ in geom["coordinates"][0]]
    field = Path(ring_utm)

    def elev(x, y):
        col = int((x - ctx["minx"]) / res); row = int((ctx["top"] - y) / res)
        if 0 <= row < hp and 0 <= col < wp:
            v = dem[row, col]
            return float(v) if np.isfinite(v) else float("nan")
        return float("nan")

    # distanze cumulate lungo il canale
    dists = [0.0]
    for i in range(1, len(xy)):
        dists.append(dists[-1] + math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]))
    total = dists[-1]

    s = 2 * R + gap                                   # interasse pivot
    ang = np.linspace(0, 2 * math.pi, 24, endpoint=False)
    circ = np.stack([np.cos(ang), np.sin(ang)], 1) * (R * 0.999)

    feats = []
    n_canal = n_pipe = 0
    centers_ll = []
    d = s / 2.0
    while d <= max(total - s / 2.0, 0.0) + 1e-6:
        (px, py), (tx, ty) = _sample_polyline(xy, dists, d)
        nx, ny = -ty, tx                              # perpendicolare
        e_canal = elev(px, py)
        for side in (+1, -1):
            for k in range(per_side):
                off = R + k * (2 * R + gap)
                cx, cy = px + nx * side * off, py + ny * side * off
                # pivot interamente dentro il campo
                pts = circ + np.array([cx, cy])
                if not (field.contains_point((cx, cy)) and field.contains_points(pts).all()):
                    continue
                e_piv = elev(cx, cy)
                drop = (e_canal - e_piv) if (e_canal == e_canal and e_piv == e_piv) else float("nan")
                grad_pm = (1000.0 * drop / off) if (drop == drop and off > 0) else float("nan")
                if drop != drop:
                    conn = "pipe"
                elif drop < 0:
                    conn = "pipe"                     # a monte → pompa
                elif grad_pm <= conn_max:
                    conn = "canal"                    # a valle, dolce → gravità
                else:
                    conn = "pipe"                     # a valle ma ripido → interrata
                if conn == "canal":
                    n_canal += 1
                else:
                    n_pipe += 1
                # cerchio pivot (lon/lat)
                ring = [list(to_wgs.transform(x, y)) for x, y in pts.tolist()]
                ring.append(ring[0])
                feats.append({
                    "type": "Feature",
                    "properties": {"kind": "pivot", "phase": 1 if conn == "canal" else 2,
                                   "connection": conn,
                                   "drop_m": round(drop, 2) if drop == drop else None,
                                   "grad_permille": round(grad_pm, 1) if grad_pm == grad_pm else None},
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                })
                # connessione canale → pivot
                a = list(to_wgs.transform(px, py)); b = list(to_wgs.transform(cx, cy))
                feats.append({
                    "type": "Feature",
                    "properties": {"kind": "pipe" if conn == "pipe" else "canal", "connection": conn},
                    "geometry": {"type": "LineString", "coordinates": [a, b]},
                })
                centers_ll.append((cx, cy))
        d += s

    # canale principale
    feats.append({
        "type": "Feature", "properties": {"kind": "canal", "main": True},
        "geometry": {"type": "LineString", "coordinates": [list(to_wgs.transform(x, y)) for x, y in xy]},
    })

    n = n_canal + n_pipe
    pivot_ha = math.pi * R * R / 10000.0
    length_m = total
    drop_m = float(dem[r["path"][0]]) - float(dem[r["path"][-1]])
    meta = {
        "n_pivots": n, "n_canal_conn": n_canal, "n_pipe_conn": n_pipe,
        "per_side": per_side, "radius_m": R, "gap_m": gap,
        "net_ha": round(n * pivot_ha, 1),
        "canal_length_m": round(length_m, 1),
        "canal_drop_m": round(drop_m, 2),
        "canal_mean_permille": round(1000.0 * drop_m / length_m, 2) if length_m > 0 else 0.0,
        "target_permille": round(target_permille, 2),
        "conn_max_permille": round(conn_max, 2),
    }
    return {"geojson": {"type": "FeatureCollection", "features": feats}, "meta": meta}
