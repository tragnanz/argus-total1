"""Leggibilità del terreno (Argus Total — M6).

Due strumenti per leggere facilmente dislivelli, sensi e pendenze del terreno:

1. `terrain_readability` — rilievo ombreggiato (hillshade) sovrapposto alla
   colorazione per quota + curve di livello (isoipse) etichettate. Il rilievo
   rende immediatamente visibili i sensi delle pendenze; le isoipse ravvicinate
   indicano i tratti più ripidi.
2. `reachable_region` — data la presa, la zona realisticamente collegabile a
   gravità (aree a valle, raggiungibili in discesa): serve a capire dove poter
   collocare il finale di un canale.
"""
from __future__ import annotations

import base64
import math
from collections import deque

import numpy as np
from rasterio import features
from rasterio.transform import from_origin

from processing.satellite_export import _get_cmap, _png_from_rgb
from .canal import _NB, _dem_and_grid, _smooth, _snap_cell
from .macroareas import _rdp, _simplify_ring


def _range(dem, valid) -> tuple[float, float]:
    finite = dem[valid]
    if finite.size < 4:
        raise RuntimeError("DEM non disponibile per l'area.")
    vmin = float(np.percentile(finite, 2))
    vmax = float(np.percentile(finite, 98))
    if vmax - vmin < 1e-3:
        vmax = vmin + 1.0
    return vmin, vmax


def _bounds(ctx) -> list[list[float]]:
    res, wp, hp = ctx["res"], ctx["wp"], ctx["hp"]
    minx, top, to_wgs = ctx["minx"], ctx["top"], ctx["to_wgs"]
    south, east = top - hp * res, minx + wp * res
    lls = [to_wgs.transform(x, y) for x, y in
           ((minx, south), (east, south), (east, top), (minx, top))]
    lons = [p[0] for p in lls]; lats = [p[1] for p in lls]
    return [[min(lats), min(lons)], [max(lats), max(lons)]]


def _nice_interval(span: float, target: int = 12) -> float:
    """Intervallo 'tondo' fra le isoipse per avere ~`target` linee."""
    raw = span / max(1, target)
    if raw <= 0:
        return 1.0
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 2.5, 5, 10):
        if raw <= m * mag:
            return round(m * mag, 3)
    return 10 * mag


def _hillshade_rgb(dem, valid, res, vmin, vmax, vert_exag=2.0) -> np.ndarray:
    """RGB (H,W,3) uint8: colormap 'terrain' fusa con il rilievo ombreggiato."""
    from matplotlib.colors import LightSource
    ls = LightSource(azdeg=315, altdeg=45)
    filled = np.where(valid, dem, vmin).astype("float64")
    rgba = ls.shade(filled, cmap=_get_cmap("terrain"), blend_mode="soft",
                    vert_exag=vert_exag, dx=res, dy=res, vmin=vmin, vmax=vmax)
    rgb = (rgba[..., :3] * 255).astype("uint8")
    rgb[~valid] = 210  # fuori area: grigio neutro
    return rgb


def _contours(dem, valid, ctx, vmin, vmax, interval) -> list[dict]:
    """Isoipse come LineString (lon/lat) con quota; ogni 5ª è 'principale'."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    res, wp, hp = ctx["res"], ctx["wp"], ctx["hp"]
    minx, top, to_wgs = ctx["minx"], ctx["top"], ctx["to_wgs"]
    cols = minx + (np.arange(wp) + 0.5) * res
    rows = top - (np.arange(hp) + 0.5) * res
    X, Y = np.meshgrid(cols, rows)
    demm = np.ma.masked_where(~valid, dem)

    lo = math.ceil(vmin / interval) * interval
    levels = list(np.arange(lo, vmax + interval * 0.5, interval))
    if len(levels) < 2:
        return []

    fig = plt.figure()
    ax = fig.add_subplot(111)
    cs = ax.contour(X, Y, demm, levels=levels)
    feats: list[dict] = []
    for lvl, segs in zip(cs.levels, cs.allsegs):
        principal = (round(lvl / interval) % 5 == 0)
        for seg in segs:
            if len(seg) < 2:
                continue
            simp = _rdp([(float(x), float(y)) for x, y in seg], res * 0.7)
            if len(simp) < 2:
                continue
            ll = [list(to_wgs.transform(x, y)) for x, y in simp]
            feats.append({
                "type": "Feature",
                "properties": {"elev": round(float(lvl), 1), "principal": principal},
                "geometry": {"type": "LineString", "coordinates": ll},
            })
    plt.close(fig)
    return feats


def terrain_readability(client, geom: dict, vert_exag: float = 2.0) -> dict:
    dem, mask, ctx = _dem_and_grid(client, geom, max_dim=420)
    valid = np.isfinite(dem)                 # rilievo su tutto il riquadro DEM
    vmin, vmax = _range(dem, valid)
    infield = mask & valid                   # isoipse solo dentro l'area
    if int(infield.sum()) < 16:
        infield = valid
    interval = _nice_interval(vmax - vmin)
    rgb = _hillshade_rgb(dem, valid, ctx["res"], vmin, vmax, vert_exag)
    png = _png_from_rgb(rgb)
    image = "data:image/png;base64," + base64.b64encode(png).decode()
    contours = _contours(dem, infield, ctx, vmin, vmax, interval)
    return {
        "image": image,
        "bounds": _bounds(ctx),
        "contours": {"type": "FeatureCollection", "features": contours},
        "interval_m": interval,
        "elev_min": round(float(np.nanmin(dem[valid])), 1),
        "elev_max": round(float(np.nanmax(dem[valid])), 1),
    }


def _reach_mask(dem, valid, s_row, s_col, head, head_tol) -> np.ndarray:
    """Flood dalla presa a gravità. Un canale a gravità non può portare l'acqua
    sopra la quota della presa (il 'carico' idraulico di partenza), ma può
    attraversare avvallamenti e piccoli dossi: quello che conta è NON superare la
    quota della presa. Quindi la cella è transitabile se `quota <= quota_presa +
    tol`. Il `tol` assorbe il rumore del DEM (dossi fittizi di pochi decimetri)
    che altrimenti bloccherebbero la propagazione a valle già a pochi metri.
    (Un flood 'strettamente in discesa' cella-per-cella si ferma al primo dosso
    e fa sembrare la zona a valle piccolissima: era il bug segnalato.)"""
    hp, wp = dem.shape
    thr = head + head_tol
    reach = np.zeros((hp, wp), dtype=bool)
    reach[s_row, s_col] = True
    dq = deque([(s_row, s_col)])
    while dq:
        r, c = dq.popleft()
        for dr, dc in _NB:
            nr, nc = r + dr, c + dc
            if not (0 <= nr < hp and 0 <= nc < wp):
                continue
            if valid[nr, nc] and not reach[nr, nc] and dem[nr, nc] <= thr:
                reach[nr, nc] = True
                dq.append((nr, nc))
    return reach


def reachable_region(client, geom: dict, start_ll, tol_up_m: float = 0.5,
                     min_drop_m: float = 0.3) -> dict:
    """Zona dove il finale è realisticamente collocabile: le celle collegate alla
    presa senza superarne la quota (carico idraulico) E più basse della presa.
    `tol_up_m` = tolleranza sul rumore DEM; `min_drop_m` = dislivello minimo
    perché una cella conti come 'a valle'."""
    dem, mask, ctx = _dem_and_grid(client, geom)
    res, wp, hp = ctx["res"], ctx["wp"], ctx["hp"]
    to_wgs = ctx["to_wgs"]
    import pyproj
    to_utm = pyproj.Transformer.from_crs(4326, ctx["epsg"], always_xy=True)
    valid = mask & np.isfinite(dem)
    if int(valid.sum()) < 10:
        raise RuntimeError("Area troppo piccola o DEM non disponibile.")

    s_row, s_col = _snap_cell(ctx, valid, to_utm, start_ll[0], start_ll[1])
    demS = _smooth(dem)                       # stesso DEM lisciato del routing
    head = float(demS[s_row, s_col])
    # corridoio raggiungibile senza superare il carico della presa
    corridor = _reach_mask(demS, valid, s_row, s_col, head, tol_up_m)
    # finale valido = raggiungibile E realmente più in basso della presa
    reach = corridor & (demS <= head - min_drop_m)
    if int(reach.sum()) < 1:
        return {"polygons": [], "elev_start_m": round(head, 1),
                "elev_min_m": round(head, 1), "area_ha": 0.0}

    transform = from_origin(ctx["minx"], ctx["top"], res, res)
    m = reach.astype("uint8")
    polys: list[dict] = []
    for g, _v in features.shapes(m, mask=reach, transform=transform):
        ring_utm = [(float(x), float(y)) for x, y in g["coordinates"][0]]
        ring_utm = _simplify_ring(ring_utm, res * 1.2)
        ring_ll = [list(to_wgs.transform(x, y)) for x, y in ring_utm]
        if len(ring_ll) < 4:
            continue
        if ring_ll[0] != ring_ll[-1]:
            ring_ll.append(ring_ll[0])
        polys.append({"type": "Polygon", "coordinates": [ring_ll]})

    pixel_ha = (res * res) / 10000.0
    return {
        "polygons": polys,
        "elev_start_m": round(head, 1),
        "elev_min_m": round(float(demS[reach].min()), 1),
        "area_ha": round(float(reach.sum()) * pixel_ha, 1),
    }
