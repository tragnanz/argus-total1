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
from scipy.ndimage import distance_transform_edt

from .canal import _route


def _water_mask(client, ctx, date):
    """Maschera acqua/paludi (NDWI) sulla stessa griglia del DEM del canale.
    Acqua libera: NDWI alto. Palude: vegetazione (NDVI) con NDWI/NDMI elevati
    (suolo saturo). Ritorna un bool array o None se non ci sono scene."""
    from processing.satellite_export import _stitch
    miny = ctx["top"] - ctx["hp"] * ctx["res"]
    mos, _nc, n_ok = _stitch(client, ctx["epsg"], ctx["minx"], miny, ctx["top"],
                             ctx["res"], ctx["wp"], ctx["hp"], 1, 1, date,
                             ["ndvi", "ndmi", "ndwi"])
    if n_ok == 0:
        return None
    ndvi, ndmi, ndwi = mos["ndvi"], mos["ndmi"], mos["ndwi"]
    water = ndwi > 0.20
    marsh = (ndvi > 0.30) & ((ndwi > -0.05) | (ndmi > 0.55))
    return np.isfinite(ndwi) & (water | marsh)


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


def _decide(drop: float, grad_pm: float, conn_max: float) -> str:
    """Connessione consigliata: canaletta a gravità se a valle e dolce, altrimenti tubazione."""
    if drop != drop:
        return "pipe"
    if drop < 0:
        return "pipe"                                 # a monte → pompa
    if grad_pm == grad_pm and grad_pm <= conn_max:
        return "canal"                                # a valle, dolce → gravità
    return "pipe"                                     # a valle ma ripido → interrata


def design_pivots(client, geom: dict, params: dict) -> dict:
    R = float(params.get("radius_m", 400.0))
    gap = max(0.0, float(params.get("gap_m", 0.0)))
    safety = max(0.0, float(params.get("safety_m", 20.0)))     # distanza di sicurezza tra i bordi
    clear = max(gap, safety)                                   # franco effettivo fra i bordi
    per_side = max(1, min(4, int(params.get("per_side", 2))))
    target_permille = float(params.get("target_permille", 1.0))
    conn_max = float(params.get("conn_max_permille", 5.0))     # canaletta: pendenza max dolce
    date = params.get("date")                                  # per l'esclusione acqua (NDWI)
    exclude_water = bool(params.get("exclude_water", True))

    r = _route(client, geom, target_permille)
    dem, ctx, xy = r["dem"], r["ctx"], r["xy"]
    res = ctx["res"]; wp = ctx["wp"]; hp = ctx["hp"]; to_wgs = ctx["to_wgs"]
    to_utm = pyproj.Transformer.from_crs(4326, ctx["epsg"], always_xy=True)

    # --- TERRENO LIBERO: i pivot non devono passare sopra il canale né su
    # acqua/paludi. Costruisco le distanze (in metri) dal canale e dall'acqua;
    # un pivot è ammesso solo se il suo cerchio (raggio R) non le tocca. ---
    canal_mask = np.zeros((hp, wp), bool)
    for (rr, cc) in r["path"]:
        if 0 <= rr < hp and 0 <= cc < wp:
            canal_mask[rr, cc] = True
    dist_canal = distance_transform_edt(~canal_mask) * res     # m dalla cella di canale
    dist_wet = np.full((hp, wp), np.inf)
    n_wet = 0
    wet = np.zeros((hp, wp), bool)
    # 1) corsi d'acqua CONFERMATI dall'utente (anche modificati a mano)
    avoid = params.get("avoid")
    if avoid:
        try:
            from rasterio.features import rasterize
            from rasterio.transform import from_origin
            from scipy.ndimage import binary_dilation
            geoms = []
            for f in avoid:
                g = f.get("geojson") or f
                typ = g.get("type"); coords = g.get("coordinates")
                if typ == "Polygon" and coords:
                    ring = [to_utm.transform(lon, lat) for lon, lat, *_ in coords[0]]
                    geoms.append({"type": "Polygon", "coordinates": [ring]})
                elif typ == "LineString" and coords:
                    line = [to_utm.transform(lon, lat) for lon, lat, *_ in coords]
                    geoms.append({"type": "LineString", "coordinates": line})
            if geoms:
                am = rasterize([(gg, 1) for gg in geoms], out_shape=(hp, wp),
                               transform=from_origin(ctx["minx"], ctx["top"], res, res),
                               fill=0, all_touched=True).astype(bool)
                wet |= binary_dilation(am, iterations=1)
        except Exception:  # noqa: BLE001
            pass
    # 2) NDWI automatico (se c'è una data), unito a quanto sopra
    if exclude_water and date:
        try:
            w = _water_mask(client, ctx, date)
            if w is not None and w.any():
                wet |= w
        except Exception:  # noqa: BLE001 — se manca la scena, salto l'esclusione NDWI
            pass
    if wet.any():
        n_wet = int(wet.sum())
        dist_wet = distance_transform_edt(~wet) * res

    def land_ok(cx, cy):
        """Terreno libero sotto il pivot: nessun canale né acqua entro il raggio."""
        col = int((cx - ctx["minx"]) / res); row = int((ctx["top"] - cy) / res)
        if not (0 <= row < hp and 0 <= col < wp):
            return False
        return dist_canal[row, col] >= R - 1.0 and dist_wet[row, col] >= R - 1.0

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

    s = 2 * R + clear                                 # interasse pivot (bordi a distanza `clear`)
    min_d2 = s * s                                     # distanza minima² fra due centri
    ang = np.linspace(0, 2 * math.pi, 24, endpoint=False)
    circ = np.stack([np.cos(ang), np.sin(ang)], 1) * (R * 0.999)

    def _free(cx, cy, cen):
        """True se il pivot non si sovrappone a nessuno già posato (con franco)."""
        return all((cx - ex) ** 2 + (cy - ey) ** 2 >= min_d2 - 1e-6 for ex, ey in cen)

    def pivot_feature(cx, cy, conn, drop, grad_pm, origin):
        pts = circ + np.array([cx, cy])
        ring = [list(to_wgs.transform(x, y)) for x, y in pts.tolist()]
        ring.append(ring[0])
        return {
            "type": "Feature",
            "properties": {"kind": "pivot", "phase": 1 if conn == "canal" else 2,
                           "connection": conn, "origin": origin,
                           "drop_m": round(drop, 2) if drop == drop else None,
                           "grad_permille": round(grad_pm, 1) if grad_pm == grad_pm else None},
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        }

    feats = []
    n_canal = n_pipe = n_along = n_fill = 0
    centers = []                                      # centri UTM (per anti-sovrapposizione)
    stations = []                                     # (x, y, quota) lungo il canale
    d = s / 2.0
    while d <= max(total - s / 2.0, 0.0) + 1e-6:
        (px, py), (tx, ty) = _sample_polyline(xy, dists, d)
        nx, ny = -ty, tx                              # perpendicolare
        e_canal = elev(px, py)
        stations.append((px, py, e_canal))
        for side in (+1, -1):
            for k in range(per_side):
                # 1ª fila a R+clear/2 dal canale: i due lati restano a s l'uno
                # dall'altro (bordi a distanza `clear`); file successive a passo s.
                off = R + clear / 2.0 + k * s
                cx, cy = px + nx * side * off, py + ny * side * off
                pts = circ + np.array([cx, cy])
                if not (field.contains_point((cx, cy)) and field.contains_points(pts).all()):
                    continue
                if not _free(cx, cy, centers):        # niente sovrapposizioni (canale curvo)
                    continue
                if not land_ok(cx, cy):               # terreno libero (no canale/acqua)
                    continue
                e_piv = elev(cx, cy)
                drop = (e_canal - e_piv) if (e_canal == e_canal and e_piv == e_piv) else float("nan")
                grad_pm = (1000.0 * drop / off) if (drop == drop and off > 0) else float("nan")
                conn = _decide(drop, grad_pm, conn_max)
                n_canal += conn == "canal"; n_pipe += conn == "pipe"; n_along += 1
                feats.append(pivot_feature(cx, cy, conn, drop, grad_pm, "canal"))
                a = list(to_wgs.transform(px, py)); b = list(to_wgs.transform(cx, cy))
                feats.append({
                    "type": "Feature",
                    "properties": {"kind": "pipe" if conn == "pipe" else "canal", "connection": conn},
                    "geometry": {"type": "LineString", "coordinates": [a, b]},
                })
                centers.append((cx, cy))
        d += s

    # --- riempimento degli spazi vuoti con pivot della stessa dimensione ---
    if bool(params.get("fill", True)) and stations:
        xs = [p[0] for p in ring_utm]; ys = [p[1] for p in ring_utm]
        minx_, maxx_, miny_, maxy_ = min(xs), max(xs), min(ys), max(ys)
        yy = miny_ + R
        while yy <= maxy_ - R + 1e-6:
            xx = minx_ + R
            while xx <= maxx_ - R + 1e-6:
                pts = circ + np.array([xx, yy])
                if field.contains_point((xx, yy)) and field.contains_points(pts).all() \
                        and _free(xx, yy, centers) and land_ok(xx, yy):  # libero: no overlap/canale/acqua
                    # connessione stimata rispetto alla stazione di canale più vicina
                    best = min(stations, key=lambda st: (xx - st[0]) ** 2 + (yy - st[1]) ** 2)
                    cdist = ((xx - best[0]) ** 2 + (yy - best[1]) ** 2) ** 0.5
                    e_piv = elev(xx, yy)
                    drop = (best[2] - e_piv) if (best[2] == best[2] and e_piv == e_piv) else float("nan")
                    grad_pm = (1000.0 * drop / cdist) if (drop == drop and cdist > 0) else float("nan")
                    conn = _decide(drop, grad_pm, conn_max)
                    n_canal += conn == "canal"; n_pipe += conn == "pipe"; n_fill += 1
                    feats.append(pivot_feature(xx, yy, conn, drop, grad_pm, "fill"))
                    centers.append((xx, yy))
                xx += s
            yy += s

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
        "n_along_canal": n_along, "n_fill": n_fill,
        "per_side": per_side, "radius_m": R, "gap_m": gap,
        "safety_m": round(clear, 1), "spacing_m": round(s, 1),
        "pivot_ha": round(pivot_ha, 1),
        "water_excluded": bool(n_wet > 0),
        "net_ha": round(n * pivot_ha, 1),
        "canal_length_m": round(length_m, 1),
        "canal_drop_m": round(drop_m, 2),
        "canal_mean_permille": round(1000.0 * drop_m / length_m, 2) if length_m > 0 else 0.0,
        "target_permille": round(target_permille, 2),
        "conn_max_permille": round(conn_max, 2),
    }
    return {"geojson": {"type": "FeatureCollection", "features": feats}, "meta": meta}
