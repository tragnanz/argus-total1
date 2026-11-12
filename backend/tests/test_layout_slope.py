"""Scarpate: con il limite di pendenza sotto il pivot, nessun pivot posato a cavallo di una scarpata."""
import numpy as np

from analysis import layout as L


class FakeDEM:
    def fetch_dem(self, bbox, epsg, wp, hp, dem_instance=None):
        x0, y0, x1, y1 = bbox
        xs = np.linspace(x0, x1, wp)
        # scarpata larga ~150 m a metà dell'area: 30 m di dislivello, pendenza ~20 %
        mid = (x0 + x1) / 2
        z = np.tile(100.0 - 30.0 * np.clip((xs - (mid - 75)) / 150.0, 0, 1), (hp, 1))
        return z


def test_scarpata_esclusa():
    geom = {"type": "Polygon", "coordinates": [[[10.0, 45.0], [10.06, 45.0], [10.06, 45.03], [10.0, 45.03], [10.0, 45.0]]]}
    L._DEM_CACHE.clear()
    base = dict(radius_m=300, gap_m=10, transport="buried", slope_max_pct=60, dem_smooth_m=0)
    a = L.compute_layout(FakeDEM(), geom, dict(base))
    L._DEM_CACHE.clear()
    b = L.compute_layout(FakeDEM(), geom, dict(base, pivot_slope_max_pct=10, pivot_slope_tol_pct=2))
    na, nb = a["meta"]["n_pivots"], b["meta"]["n_pivots"]
    assert nb < na and nb > 0
