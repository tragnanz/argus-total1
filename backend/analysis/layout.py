"""Layout automatico dei center-pivot + dimensionamento idrico (Milestone 3).

Due configurazioni scelte dall'utente:
  - "square"     → maglia quadrata (file/colonne allineate, adduttrici dritte
                   perpendicolari al canale). Densità d'uso suolo ≈ π/4 = 78,5%.
  - "staggered"  → maglia rettangolare sfalsata (quinconce): file sfalsate,
                   adduttrici diagonali più lunghe. Densità → π/(2√3) = 90,7%.

Il tipo di trasporto acqua imposta il vincolo di PENDENZA (dal DEM):
  - "canal"  → canali a gravità: serve terreno pianeggiante (max ~5‰).
  - "buried" → tubazioni interrate in pressione: tollera più pendenza (~70‰),
               ma cresce l'energia di sollevamento.

I pivot sono posati solo se il cerchio sta INTERO nell'area (niente sbordo) e la
pendenza del centro è entro il limite del trasporto. Nessuna sovrapposizione
(spaziatura reticolare). Adduzione modellata a "spine" (una pompa per fila/
diagonale sul canale), coerente con gli schemi di progetto.

Rifiniture:
  - Il reticolo è ORIENTATO al canale/campo: di default si allinea al bordo più
    lungo del poligono (file parallele al canale); l'utente può forzare un azimut
    o mettere il canale sul bordo opposto (canal_flip).
  - only_suitable=True: i pivot vengono posati SOLO dove l'idoneità (M2) ≥ soglia
    (incrocio diretto con la mappa di idoneità), oltre al vincolo di pendenza.
"""
from __future__ import annotations

import hashlib
import math

import numpy as np
import pyproj

from processing.satellite_export import _utm_bbox, _plan_grid
from processing.climate import get_climate
from .eto import eto_year
from .suitability import score_grid, sample_grid

_DEM_CACHE: dict[str, tuple] = {}

# soglie di pendenza (%) per tipo di trasporto: (ideale, massima).
# NB: l'interfaccia le mostra in ‰ (per mille) → qui in % = ‰/10.
#   canali:    ideale 2‰ (0,2%),  massima 5‰ (0,5%)
#   tubazioni: ideale 5‰ (0,5%),  massima 70‰ (7,0%)
TRANSPORT_SLOPE = {
    "canal":  {"ideal": 0.2, "max": 0.5},
    "buried": {"ideal": 0.5, "max": 7.0},
}


def _dem_grid(client, geom):
    """DEM + pendenza(%) su griglia comune (cache per area)."""
    epsg, minx, miny, maxx, maxy, to_wgs = _utm_bbox(geom)
    res, wp, hp, nx, ny = _plan_grid(minx, miny, maxx, maxy, max_dim=500, max_tiles=1)
    top = miny + hp * res
    sig = hashlib.sha1(f"{epsg}|{round(minx)}|{round(miny)}|{wp}|{hp}".encode()).hexdigest()[:16]
    if sig in _DEM_CACHE:
        dem, slope = _DEM_CACHE[sig]
    else:
        south, east = top - hp * res, minx + wp * res
        dem = client.fetch_dem([minx, south, east, top], epsg, wp, hp).astype("float64")
        gy, gx = np.gradient(dem, res, res)
        slope = np.sqrt(gx ** 2 + gy ** 2) * 100.0
        _DEM_CACHE[sig] = (dem, slope)
    # top/res/wp/hp = griglia DEM (per campionare pendenza e quota).
    # minx/miny/maxx/maxy = bbox VERO del poligono (per reticolo e canale).
    return dict(epsg=epsg, minx=minx, miny=miny, maxx=maxx, maxy=maxy,
                top=top, res=res, wp=wp, hp=hp, to_wgs=to_wgs, slope=slope, dem=dem)


def _slope_at(g, x, y) -> float:
    col = int((x - g["minx"]) / g["res"])
    row = int((g["top"] - y) / g["res"])
    if 0 <= row < g["hp"] and 0 <= col < g["wp"]:
        v = g["slope"][row, col]
        return float(v) if np.isfinite(v) else 0.0
    return 0.0


def _elev_at(g, x, y) -> float:
    """Quota (m) dal DEM nel punto UTM (x, y); NaN se fuori griglia/non finita."""
    col = int((x - g["minx"]) / g["res"])
    row = int((g["top"] - y) / g["res"])
    if 0 <= row < g["hp"] and 0 <= col < g["wp"]:
        v = g["dem"][row, col]
        return float(v) if np.isfinite(v) else float("nan")
    return float("nan")


def _azimuth_longest_edge(ring_xy) -> float:
    """Azimut (rad) del lato più lungo del poligono (direzione del canale)."""
    best, best_len = 0.0, -1.0
    for i in range(len(ring_xy) - 1):
        x1, y1 = ring_xy[i]; x2, y2 = ring_xy[i + 1]
        d = math.hypot(x2 - x1, y2 - y1)
        if d > best_len:
            best_len, best = d, math.atan2(y2 - y1, x2 - x1)
    return best


def compute_layout(client, geom: dict, params: dict) -> dict:
    cfg = params.get("config", "staggered")
    R = float(params.get("radius_m", 400.0))
    gap = max(0.0, float(params.get("gap_m", 0.0)))            # distanza tra i bordi dei pivot
    transport = params.get("transport", "buried")
    tslope = TRANSPORT_SLOPE.get(transport, TRANSPORT_SLOPE["buried"])
    slope_max = float(params.get("slope_max_pct", tslope["max"]))
    kc = float(params.get("kc_peak", 1.15))
    eff = float(params.get("efficiency", 0.85))
    hours = float(params.get("hours_per_day", 20.0))
    # orientamento del reticolo
    auto_orient = bool(params.get("auto_orient", True))
    az = params.get("canal_azimuth_deg", None)
    canal_flip = bool(params.get("canal_flip", False))
    # incrocio con l'idoneità (M2)
    only_suitable = bool(params.get("only_suitable", False))
    min_suit = float(params.get("min_suitability", 60.0))
    suit_date = params.get("date", None)
    # sbordo controllato: quota di raggio che può uscire dall'area (0 = niente)
    overhang = min(0.4, max(0.0, float(params.get("overhang_pct", 0.0)) / 100.0))
    # fasi di sviluppo
    n_phases = max(1, int(params.get("n_phases", 1)))
    phase_order = params.get("phase_order", "canal_distance")   # canal_distance|suitability|rows

    g = _dem_grid(client, geom)
    epsg, res = g["epsg"], g["res"]
    to_utm = pyproj.Transformer.from_crs(4326, epsg, always_xy=True)
    to_wgs = g["to_wgs"]
    from matplotlib.path import Path
    ring_utm = [to_utm.transform(lon, lat) for lon, lat, *_ in geom["coordinates"][0]]

    # griglia di idoneità (M2): serve se posiamo solo su aree idonee OPPURE se le
    # fasi sono ordinate per idoneità
    suit = None
    if (only_suitable or phase_order == "suitability") and suit_date:
        sparams = {"slope_ideal_pct": float(params.get("slope_ideal_pct", tslope["ideal"])),
                   "slope_max_pct": slope_max,
                   "allow_climate_network": params.get("allow_climate_network", True)}
        sg = score_grid(client, geom, suit_date, sparams)
        suit = (sg["score100"], sg["ctx"])

    # --- orientamento: ruota la scena così che il canale sia orizzontale ---
    ax = sum(p[0] for p in ring_utm[:-1]) / (len(ring_utm) - 1)
    ay = sum(p[1] for p in ring_utm[:-1]) / (len(ring_utm) - 1)
    if az is not None:
        theta = math.radians(float(az))
    elif auto_orient:
        theta = _azimuth_longest_edge(ring_utm)
    else:
        theta = 0.0
    ct, st = math.cos(theta), math.sin(theta)

    def rot(x, y):
        dx_, dy_ = x - ax, y - ay
        return (dx_ * ct + dy_ * st, -dx_ * st + dy_ * ct)

    def unrot(rx, ry):
        return (ax + rx * ct - ry * st, ay + rx * st + ry * ct)

    ring_rot = [rot(x, y) for x, y in ring_utm]
    path_rot = Path(ring_rot)
    rxs = [p[0] for p in ring_rot]; rys = [p[1] for p in ring_rot]
    rminx, rmaxx, rminy, rmaxy = min(rxs), max(rxs), min(rys), max(rys)

    # lato del canale nel frame ruotato (bordo più lungo → in alto, salvo flip)
    le_mid = None
    if az is None and auto_orient:
        # midpoint del lato più lungo, ruotato → decide alto/basso
        best_len, mid = -1.0, (0.0, 0.0)
        for i in range(len(ring_utm) - 1):
            x1, y1 = ring_utm[i]; x2, y2 = ring_utm[i + 1]
            d = math.hypot(x2 - x1, y2 - y1)
            if d > best_len:
                best_len = d; mid = ((x1 + x2) / 2, (y1 + y2) / 2)
        le_mid = rot(*mid)
    top = True if le_mid is None else (le_mid[1] >= (rminy + rmaxy) / 2)
    # Canali a gravità: l'acqua scende dall'alto verso il basso → il canale va
    # sul bordo PIÙ ALTO, così serve i pivot a valle. (Le tubazioni in pressione
    # spingono anche in salita: nessun vincolo di direzione.)
    if transport == "canal":
        xs_s = np.linspace(rminx + R, rmaxx - R, 20)
        def _edge_elev(cry):
            vals = [_elev_at(g, *unrot(float(sx), cry)) for sx in xs_s]
            vals = [v for v in vals if v == v]
            return (sum(vals) / len(vals)) if vals else float("nan")
        e_top, e_bot = _edge_elev(rmaxy), _edge_elev(rminy)
        if e_top == e_top and e_bot == e_bot:
            top = e_top >= e_bot
    if canal_flip:
        top = not top
    canal_ry = rmaxy if top else rminy      # riga del canale nel frame ruotato

    # --- reticolo dei centri (parte dal canale) ---
    s = 2 * R + gap                                             # interasse minimo tra pivot
    dx = s
    dy = (math.sqrt(3) / 2 * s) if cfg == "staggered" else s
    ang = np.linspace(0, 2 * math.pi, 16, endpoint=False)
    # con sbordo, si garantisce dentro l'area solo il cerchio interno R*(1-overhang)
    off = np.stack([np.cos(ang), np.sin(ang)], 1) * (R * (1.0 - overhang) * 0.999)

    def depth_of(ry):
        return (rmaxy - ry) if top else (ry - rminy)

    centers = []                # (rx, ry, x, y) — ruotate + UTM
    j = 0
    ry = (rmaxy - R) if top else (rminy + R)
    while (ry >= rminy + R - 1e-6) if top else (ry <= rmaxy - R + 1e-6):
        rx = rminx + R + (dx / 2 if (cfg == "staggered" and j % 2 == 1) else 0.0)
        while rx <= rmaxx - R + 1e-6:
            pts = off + np.array([rx, ry])
            if path_rot.contains_point((rx, ry)) and path_rot.contains_points(pts).all():
                x, y = unrot(rx, ry)
                ok = _slope_at(g, x, y) <= slope_max
                if ok and transport == "canal":
                    # gravità: il pivot dev'essere a valle del canale (quota ≤ canale)
                    e_p = _elev_at(g, x, y)
                    e_c = _elev_at(g, *unrot(rx, canal_ry))
                    if e_p == e_p and e_c == e_c:
                        ok = e_p <= e_c + 1e-6
                if ok and only_suitable and suit is not None:
                    sc = sample_grid(suit[0], suit[1], x, y)
                    ok = (sc == sc) and sc >= min_suit          # sc==sc → non NaN
                if ok:
                    centers.append((rx, ry, x, y))
            rx += dx
        ry += (-dy if top else dy)
        j += 1

    n = len(centers)
    pivot_ha = math.pi * R * R / 10000.0
    net_ha = round(n * pivot_ha, 1)
    field_ha = round(abs(_ring_area(ring_utm)) / 10000.0, 1)
    coverage = round(100 * net_ha / field_ha, 1) if field_ha else 0.0
    if centers:
        cxs = [c[0] for c in centers]; cys = [c[1] for c in centers]
        gross_block_ha = round((max(cxs) - min(cxs) + 2 * R) * (max(cys) - min(cys) + 2 * R) / 10000.0, 1)
        packing_pct = round(100 * net_ha / gross_block_ha, 1) if gross_block_ha else 0.0
    else:
        gross_block_ha = 0.0; packing_pct = 0.0

    # --- fasi di sviluppo: assegna a ogni pivot una fase 1..n_phases ---
    def _phase_key(i):
        rx, ry, x, y = centers[i]
        if phase_order == "suitability" and suit is not None:
            sc = sample_grid(suit[0], suit[1], x, y)
            return -(sc if sc == sc else -1.0)         # idoneità alta → fase prima
        if phase_order == "rows":
            return depth_of(ry)                        # per righe dal canale
        return depth_of(ry)                            # canal_distance (default)
    phase_idx = [1] * n
    if n_phases > 1 and n:
        order = sorted(range(n), key=_phase_key)
        per = math.ceil(n / n_phases)
        for rank, i in enumerate(order):
            phase_idx[i] = min(n_phases, rank // per + 1)

    # --- adduzione a spine (una pompa per fila/diagonale), nel frame ruotato ---
    spines: dict[int, list] = {}
    slope_along = (dx / 2) / dy if (cfg == "staggered" and dy > 0) else 0.0
    for (rx, ry, x, y) in centers:
        d = depth_of(ry)
        key = round((rx - slope_along * d) / dx)         # colonna (o diagonale)
        spines.setdefault(key, []).append((rx, ry, x, y, d))

    pipe_total = 0.0
    pipe_lengths = []
    pump_along = []     # posizione along-canale delle pompe (frame ruotato)
    pumps = []          # (lon,lat)
    spine_lines = []    # [(lon,lat)_pump, (lon,lat)_far]
    ry0 = rmaxy if top else rminy
    for key, group in spines.items():
        far = max(group, key=lambda t: t[4])            # pivot più lontano dal canale
        rx0 = far[0] - slope_along * far[4]             # along al canale (depth 0)
        px, py = unrot(rx0, ry0)
        length = math.hypot(far[0] - rx0, far[4])       # lunghezza spina fino al più lontano
        pipe_total += length
        pipe_lengths.append(length)
        pump_along.append(rx0)
        pumps.append(to_wgs.transform(px, py))
        spine_lines.append((to_wgs.transform(px, py), to_wgs.transform(far[2], far[3])))

    n_pumps = len(spines)
    pipe_max = round(max(pipe_lengths), 0) if pipe_lengths else 0.0
    # collettore (header) lungo il canale che collega le pompe a un'unica presa,
    # e lunghezza TOTALE della rete (spine + collettore).
    header_m = round(max(pump_along) - min(pump_along), 0) if pump_along else 0.0
    network_total_m = round(pipe_total + header_m, 0)
    pipe_total = round(pipe_total, 0)

    # --- dimensionamento idrico (ET₀ di punta al centroide) ---
    ring = geom["coordinates"][0]
    lon0 = sum(p[0] for p in ring) / len(ring)
    lat0 = sum(p[1] for p in ring) / len(ring)
    clim, elev = get_climate(lat0, lon0, allow_network=params.get("allow_climate_network", True))
    et = eto_year(clim, elev, lat0)
    et0_peak = max(et["eto_day"])                        # mm/giorno
    etc_peak = et0_peak * kc
    gross_mm_day = etc_peak / eff
    area_pivot_m2 = math.pi * R * R
    vol_pivot_day_m3 = gross_mm_day * area_pivot_m2 / 1000.0     # mm·m² = L → /1000 = m³
    q_pivot_ls = vol_pivot_day_m3 * 1000.0 / (hours * 3600.0)    # l/s
    q_total_ls = q_pivot_ls * n
    vol_total_day_m3 = vol_pivot_day_m3 * n

    # riepilogo per fase di sviluppo
    phases_out = []
    for ph in range(1, n_phases + 1):
        npv = sum(1 for i in range(n) if phase_idx[i] == ph)
        phases_out.append({
            "phase": ph, "n_pivots": npv, "net_ha": round(npv * pivot_ha, 1),
            "q_ls": round(q_pivot_ls * npv, 1), "q_m3h": round(q_pivot_ls * npv * 3.6, 1),
        })

    # --- GeoJSON per la mappa (cerchi + pompe + spine) ---
    circ_ang = np.linspace(0, 2 * math.pi, 48, endpoint=False)
    circ_off = np.stack([np.cos(circ_ang), np.sin(circ_ang)], 1) * R
    features = []
    for i, (rx, ry, x, y) in enumerate(centers):
        pts = circ_off + np.array([x, y])
        coords = [list(to_wgs.transform(px, py)) for px, py in pts]
        coords.append(coords[0])
        features.append({"type": "Feature",
                         "properties": {"kind": "pivot", "id": i, "phase": phase_idx[i]},
                         "geometry": {"type": "Polygon", "coordinates": [coords]}})
    # collettore lungo il canale (header) tra la prima e l'ultima pompa
    if pump_along and len(pump_along) > 1:
        h0 = unrot(min(pump_along), ry0); h1 = unrot(max(pump_along), ry0)
        features.append({"type": "Feature", "properties": {"kind": "header"},
                         "geometry": {"type": "LineString",
                                      "coordinates": [list(to_wgs.transform(*h0)),
                                                      list(to_wgs.transform(*h1))]}})
    for (pa, pb) in spine_lines:
        features.append({"type": "Feature", "properties": {"kind": "pipe"},
                         "geometry": {"type": "LineString", "coordinates": [list(pa), list(pb)]}})
    for (plon, plat) in pumps:
        features.append({"type": "Feature", "properties": {"kind": "pump"},
                         "geometry": {"type": "Point", "coordinates": [plon, plat]}})
    # linea del canale (bordo scelto), nel frame ruotato
    cy = rmaxy if top else rminy
    canal = [list(to_wgs.transform(*unrot(rminx, cy))), list(to_wgs.transform(*unrot(rmaxx, cy)))]
    features.append({"type": "Feature", "properties": {"kind": "canal"},
                     "geometry": {"type": "LineString", "coordinates": canal}})

    minx, miny, maxx, maxy = g["minx"], g["miny"], g["maxx"], g["maxy"]
    corners = [(minx, miny), (maxx, miny), (maxx, maxy), (minx, maxy)]
    lls = [to_wgs.transform(x, y) for x, y in corners]
    lons = [p[0] for p in lls]; lats = [p[1] for p in lls]
    bounds = [[min(lats), min(lons)], [max(lats), max(lons)]]

    meta = {
        "config": cfg, "radius_m": R, "gap_m": gap, "transport": transport,
        "slope_max_pct": slope_max,
        "orientation_deg": round(math.degrees(theta), 1),
        "auto_orient": (az is None and auto_orient), "canal_flip": canal_flip,
        "only_suitable": only_suitable, "min_suitability": min_suit if only_suitable else None,
        "overhang_pct": round(overhang * 100, 1),
        "n_phases": n_phases, "phase_order": phase_order, "phases": phases_out,
        "n_pivots": n, "n_pumps": n_pumps,
        "net_ha": net_ha, "field_ha": field_ha, "coverage_pct": coverage,
        "gross_block_ha": gross_block_ha, "packing_pct": packing_pct,
        "pivot_ha": round(pivot_ha, 1),
        "pipe_total_m": pipe_total, "pipe_max_m": pipe_max,
        "header_m": header_m, "network_total_m": network_total_m,
        "water": {
            "et0_peak_mm": round(et0_peak, 2), "kc_peak": kc, "etc_peak_mm": round(etc_peak, 2),
            "efficiency": eff, "gross_mm_day": round(gross_mm_day, 2), "hours_day": hours,
            "q_pivot_ls": round(q_pivot_ls, 1), "q_pivot_m3h": round(q_pivot_ls * 3.6, 1),
            "q_total_ls": round(q_total_ls, 1), "q_total_m3h": round(q_total_ls * 3.6, 1),
            "vol_pivot_day_m3": round(vol_pivot_day_m3, 0), "vol_total_day_m3": round(vol_total_day_m3, 0),
            "climate_source": et["source"],
        },
    }
    return {"geojson": {"type": "FeatureCollection", "features": features},
            "bounds": bounds, "meta": meta}


def _ring_area(ring_xy) -> float:
    """Area con la formula del gaussiano (shoelace) su coord proiettate (m²)."""
    a = 0.0
    n = len(ring_xy)
    for i in range(n):
        x1, y1 = ring_xy[i]
        x2, y2 = ring_xy[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return a / 2.0
