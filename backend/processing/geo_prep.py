"""Preparazione della griglia UTM e della maschera del campo da un poligono
GeoJSON (lon/lat), e costruzione della geometria d'impianto in coordinate UTM.

Vincoli §1: griglia fissa a 10 m allineata all'UTM locale (co-registrazione),
buffer negativo sul confine (pixel di bordo), calcoli metrici in UTM.
"""
from __future__ import annotations
import numpy as np
import pyproj
from matplotlib.path import Path
from scipy import ndimage

from .geometry.grid import Grid
from .geometry.pivot import PivotGeometry
from .geometry.banded import BandedGeometry

BANDED_TYPES = {"linear_move", "hose_reel", "drip"}


def utm_epsg(lon: float, lat: float) -> int:
    zone = int((lon + 180) // 6) + 1
    return (32600 if lat >= 0 else 32700) + zone


def prepare_field(polygon_lonlat: dict, res_m: float = 10.0, neg_buffer_m: float = 15.0):
    """Ritorna (grid, mask, ring_utm, epsg, to_wgs84)."""
    ring = polygon_lonlat["coordinates"][0]
    lon0 = sum(p[0] for p in ring) / len(ring)
    lat0 = sum(p[1] for p in ring) / len(ring)
    epsg = utm_epsg(lon0, lat0)
    to_utm = pyproj.Transformer.from_crs(4326, epsg, always_xy=True)
    to_wgs = pyproj.Transformer.from_crs(epsg, 4326, always_xy=True)
    ring_utm = np.array([to_utm.transform(x, y) for x, y in ring])

    minx, miny = ring_utm.min(0)
    maxx, maxy = ring_utm.max(0)
    W = max(1, int(np.ceil((maxx - minx) / res_m)))
    H = max(1, int(np.ceil((maxy - miny) / res_m)))
    grid = Grid(H, W, res_m, x0=minx, y0=miny)

    X, Y = grid.coords()
    inside = Path(ring_utm).contains_points(
        np.column_stack([X.ravel(), Y.ravel()])).reshape(X.shape)
    if neg_buffer_m > 0:
        k = int(round(neg_buffer_m / res_m))
        if k > 0:
            inside = ndimage.binary_erosion(inside, iterations=k)
    return grid, inside, ring_utm, epsg, to_wgs


def build_geometry_for_field(grid: Grid, ring_utm: np.ndarray,
                             irr_type: str, params: dict):
    if irr_type == "center_pivot":
        cx = params.get("center_x")
        cy = params.get("center_y")
        if cx is None or cy is None:
            cx, cy = float(ring_utm[:, 0].mean()), float(ring_utm[:, 1].mean())
        radius = params.get("radius_m")
        if not radius:
            radius = float(np.max(np.hypot(ring_utm[:, 0] - cx, ring_utm[:, 1] - cy)))
        return PivotGeometry(grid, (cx, cy), radius,
                             start_azimuth_deg=params.get("start_azimuth_deg", 0.0),
                             overhang_m=params.get("overhang_m", 0.0),
                             end_gun=params.get("end_gun", False))
    if irr_type in BANDED_TYPES:
        c = ring_utm.mean(0)
        pts = ring_utm - c
        w, v = np.linalg.eigh(np.cov(pts.T))
        along = v[:, int(np.argmax(w))]
        perp = np.array([-along[1], along[0]])
        u = pts @ along
        vv = pts @ perp
        origin = c + along * u.min() + perp * vv.min()
        ang = float(np.degrees(np.arctan2(along[1], along[0])))
        return BandedGeometry(grid, irr_type, along_dir_deg=ang,
                              origin_xy=(float(origin[0]), float(origin[1])),
                              extent_along_m=float(u.max() - u.min()),
                              extent_cross_m=float(vv.max() - vv.min()),
                              lane_spacing_m=params.get("lane_spacing_m"),
                              feed=params.get("feed", "end"),
                              end_gun=params.get("end_gun", False))
    raise ValueError(f"Tipo impianto non supportato: {irr_type}")
