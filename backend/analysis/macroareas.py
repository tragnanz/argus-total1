"""Macro-aree di intervento (Argus Total — M6, Fase 1).

Dalla mappa di idoneità (idoneità ≥ soglia) individua automaticamente le ZONE
contigue idonee e le restituisce come poligoni (lon/lat). L'utente le può poi
usare come campi o rifinire a mano. Nessun consumo extra di quota: riusa la
stessa griglia di `score_grid` (cache).
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage
from rasterio import features
from rasterio.transform import from_origin

from .suitability import score_grid, _poly_mask


def _rdp(points: list, eps: float) -> list:
    """Semplificazione poligonale Douglas–Peucker (coordinate UTM)."""
    if len(points) < 3:
        return points
    x0, y0 = points[0]
    x1, y1 = points[-1]
    dx, dy = x1 - x0, y1 - y0
    seg = (dx * dx + dy * dy) ** 0.5 or 1e-9
    dmax, idx = 0.0, 0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        # distanza punto-segmento
        d = abs(dy * px - dx * py + x1 * y0 - y1 * x0) / seg
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        left = _rdp(points[:idx + 1], eps)
        right = _rdp(points[idx:], eps)
        return left[:-1] + right
    return [points[0], points[-1]]


def _simplify_ring(ring: list, eps: float) -> list:
    """RDP su un ANELLO chiuso: lo spezza al vertice più lontano dal primo
    (RDP diretto degenererebbe perché primo == ultimo punto)."""
    pts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else list(ring)
    if len(pts) < 4:
        return ring
    x0, y0 = pts[0]
    far = max(range(len(pts)), key=lambda i: (pts[i][0] - x0) ** 2 + (pts[i][1] - y0) ** 2)
    s1 = _rdp(pts[:far + 1], eps)
    s2 = _rdp(pts[far:] + [pts[0]], eps)
    out = s1[:-1] + s2                      # richiuso su pts[0]
    return out if len(out) >= 4 else ring


def compute_macroareas(client, geom: dict, date: str, params: dict,
                       min_suit: float = 60.0, min_area_ha: float = 10.0) -> list[dict]:
    """Ritorna [{geojson: Polygon(lon/lat), area_ha, mean_score}] ordinate per area."""
    sg = score_grid(client, geom, date, params)
    score = sg["score100"]
    ctx = sg["ctx"]
    valid = sg["valid"]
    res, wp, hp = ctx["res"], ctx["wp"], ctx["hp"]

    field = _poly_mask(geom, ctx["epsg"], ctx["minx"], ctx["top"], res, wp, hp) & valid
    suitable = field & (score >= float(min_suit))
    if not suitable.any():
        return []
    # chiude piccoli buchi / speckle per aree più pulite
    suitable = ndimage.binary_closing(suitable, iterations=1)
    suitable = ndimage.binary_opening(suitable, iterations=1)

    lbl, n = ndimage.label(suitable)
    pixel_ha = (res * res) / 10000.0
    transform = from_origin(ctx["minx"], ctx["top"], res, res)
    to_wgs = ctx["to_wgs"]

    out: list[dict] = []
    for val in range(1, n + 1):
        m = lbl == val
        area_ha = float(m.sum()) * pixel_ha
        if area_ha < float(min_area_ha):
            continue
        mean_score = round(float(np.nanmean(score[m])), 1)
        polys = [g for g, _v in features.shapes(m.astype("uint8"), mask=m, transform=transform)]
        if not polys:
            continue
        # anello esterno del poligono più esteso (in vertici) della componente
        g0 = max(polys, key=lambda g: len(g["coordinates"][0]))
        ring_utm = [(float(x), float(y)) for x, y in g0["coordinates"][0]]
        ring_utm = _simplify_ring(ring_utm, res * 1.2)
        ring_ll = [list(to_wgs.transform(x, y)) for x, y in ring_utm]
        if len(ring_ll) < 4:
            continue
        if ring_ll[0] != ring_ll[-1]:
            ring_ll.append(ring_ll[0])
        out.append({
            "geojson": {"type": "Polygon", "coordinates": [ring_ll]},
            "area_ha": round(area_ha, 1),
            "mean_score": mean_score,
        })
    out.sort(key=lambda a: a["area_ha"], reverse=True)
    return out
