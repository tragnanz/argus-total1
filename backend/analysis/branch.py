"""Diramazioni pivot da canale (Accessori).

Data la geometria di un campo e il tracciato di un canale, posa in automatico
fino a N pivot lungo il canale (dentro il campo, senza sovrapporsi ai pivot
esistenti) e per ciascuno traccia la tubazione PIÙ CORTA che lo collega al
canale. Puro calcolo geometrico in proiezione UTM (niente shapely).
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
import pyproj
from matplotlib.path import Path

from processing.satellite_export import _utm_bbox


def _polyline_len(pts: np.ndarray) -> float:
    if len(pts) < 2:
        return 0.0
    d = np.diff(pts, axis=0)
    return float(np.sqrt((d ** 2).sum(axis=1)).sum())


def _point_tangent_at(pts: np.ndarray, s: float):
    """Punto e tangente unitaria a distanza d'arco s lungo la polilinea."""
    acc = 0.0
    for i in range(len(pts) - 1):
        a = pts[i]; b = pts[i + 1]
        seg = b - a
        L = float(math.hypot(seg[0], seg[1]))
        if L <= 1e-9:
            continue
        if acc + L >= s:
            t = (s - acc) / L
            P = a + seg * t
            T = seg / L
            return P, T
        acc += L
    # oltre la fine: ultimo punto
    seg = pts[-1] - pts[-2]
    L = float(math.hypot(seg[0], seg[1])) or 1.0
    return pts[-1], seg / L


def _nearest_on_polyline(pts: np.ndarray, C: np.ndarray) -> np.ndarray:
    """Punto della polilinea più vicino a C (tubazione più corta)."""
    best = pts[0]; bestd = float("inf")
    for i in range(len(pts) - 1):
        a = pts[i]; b = pts[i + 1]
        ab = b - a
        L2 = float(ab[0] ** 2 + ab[1] ** 2)
        t = 0.0 if L2 <= 1e-12 else float(np.clip(np.dot(C - a, ab) / L2, 0.0, 1.0))
        Q = a + ab * t
        d = float((C[0] - Q[0]) ** 2 + (C[1] - Q[1]) ** 2)
        if d < bestd:
            bestd = d; best = Q
    return best


def _circle_ok(path: Path, C: np.ndarray, R: float) -> bool:
    """Il cerchio di raggio R centrato in C è interamente dentro il campo."""
    if not path.contains_point((C[0], C[1])):
        return False
    ang = np.linspace(0, 2 * math.pi, 16, endpoint=False)
    ring = np.stack([C[0] + R * np.cos(ang), C[1] + R * np.sin(ang)], axis=1)
    return bool(path.contains_points(ring).all())


def branch_pivots(geom: dict[str, Any], canal: list[list[float]], params: dict[str, Any]) -> dict[str, Any]:
    R = float(params.get("radius_m", 360.0))
    gap = max(0.0, float(params.get("gap_m", 10.0)))
    clear = max(0.0, float(params.get("clear_m", 0.0)))
    canal_w = max(0.0, float(params.get("canal_width_m", 0.0)))
    max_n = max(0, int(params.get("max_pivots", 5)))
    side = params.get("side", "auto")           # auto | both | left | right
    existing = params.get("existing") or []      # [{lat,lng,r}]

    if max_n == 0 or R <= 0 or not canal or len(canal) < 2:
        return {"pivots": [], "pipes": [], "meta": {"n": 0}}

    epsg, *_rest, _to_wgs = _utm_bbox(geom)
    to_utm = pyproj.Transformer.from_crs(4326, epsg, always_xy=True)
    to_wgs = pyproj.Transformer.from_crs(epsg, 4326, always_xy=True)

    ring = [to_utm.transform(lon, lat) for lon, lat, *_ in geom["coordinates"][0]]
    path = Path(ring)
    cpts = np.array([to_utm.transform(p[0], p[1]) for p in canal], float)

    ex = []
    for e in existing:
        try:
            x, y = to_utm.transform(float(e["lng"]), float(e["lat"]))
            ex.append((np.array([x, y]), float(e.get("r", R))))
        except Exception:  # noqa: BLE001
            continue

    total = _polyline_len(cpts)
    step = 2.0 * R + gap                       # passo tra pivot adiacenti lungo il canale
    offset = R + clear + canal_w / 2.0         # distanza centro↔asse canale
    if side in ("left", "right"):
        signs = [1.0 if side == "left" else -1.0]
    elif side == "both":
        signs = [1.0, -1.0]
    else:
        signs = [1.0, -1.0]                     # auto: prova entrambi, tieni il primo valido

    placed: list[np.ndarray] = []

    def _valid(C: np.ndarray) -> bool:
        if not _circle_ok(path, C, R):
            return False
        for e, er in ex:                        # niente sovrapposizione con i pivot esistenti
            if float((C[0] - e[0]) ** 2 + (C[1] - e[1]) ** 2) < (R + er + gap) ** 2 - 1.0:
                return False
        for pc in placed:                       # né tra loro
            if float((C[0] - pc[0]) ** 2 + (C[1] - pc[1]) ** 2) < (2 * R + gap) ** 2 - 1.0:
                return False
        return True

    s = step * 0.5
    while s <= total + 1e-6 and len(placed) < max_n:
        P, T = _point_tangent_at(cpts, s)
        N = np.array([-T[1], T[0]])             # normale unitaria
        for sg in signs:
            C = P + N * (offset * sg)
            if _valid(C):
                placed.append(C)
                if len(placed) >= max_n:
                    break
                if side == "auto":
                    break                        # un solo lato per slot in modalità auto
        s += step

    pivots = []
    pipes = []
    for C in placed:
        lon, lat = to_wgs.transform(C[0], C[1])
        pivots.append({"lat": round(lat, 7), "lng": round(lon, 7), "r": round(R)})
        Q = _nearest_on_polyline(cpts, C)
        qlon, qlat = to_wgs.transform(Q[0], Q[1])
        pipes.append([[round(qlon, 7), round(qlat, 7)], [round(lon, 7), round(lat, 7)]])

    return {"pivots": pivots, "pipes": pipes, "meta": {"n": len(pivots), "radius_m": round(R)}}
