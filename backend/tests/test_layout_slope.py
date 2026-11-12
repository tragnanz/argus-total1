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
    reasons = {f["properties"].get("reason") for f in b["geojson"]["features"] if f["properties"].get("kind") == "excluded"}
    assert "steep" in reasons and b["meta"]["excluded_steep_ha"] > 0


def test_fasce_corsi_acqua_tratteggiate():
    geom = {"type": "Polygon", "coordinates": [[[10.0, 45.0], [10.06, 45.0], [10.06, 45.03], [10.0, 45.03], [10.0, 45.0]]]}
    L._DEM_CACHE.clear()
    river = {"geojson": {"type": "LineString", "coordinates": [[10.03, 44.99], [10.03, 45.04]]}, "width_m": 10, "clear_m": 50}
    r = L.compute_layout(FakeDEM(), geom, dict(radius_m=300, gap_m=10, transport="buried", slope_max_pct=60, dem_smooth_m=0, roads=[river]))
    w = [f for f in r["geojson"]["features"] if f["properties"].get("reason") == "water"]
    # fascia ~110 m × 3,3 km ≈ 36 ha
    assert w and 20 < r["meta"]["excluded_water_ha"] < 60
