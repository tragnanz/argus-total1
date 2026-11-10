"""Termitai su un campo sintetico: sfondo secco con macchie verdi di 1–4 pixel."""
import numpy as np

from analysis.termites import detect_termites


class FakeClient:
    def __init__(self, spots):
        self.spots = spots

    def search_dates(self, bbox, a, b, max_cloud=10):
        return [a[:8] + "15"]

    def fetch_bands(self, bbox_utm, epsg, w, h, day):
        out = np.zeros((7, h, w), "float32")
        out[2] = 0.20                                   # rosso: terreno secco
        out[4] = 0.30                                   # NIR → NDVI 0,2
        dry = day[5:7] in ("08", "09")
        if not dry:
            out[4] = 0.45                               # stagione umida: tutto più verde
        for r, c, s in self.spots:
            out[2, r:r + s, c:c + s] = 0.08
            out[4, r:r + s, c:c + s] = 0.40             # NDVI ≈ 0,67 sulla macchia
        out[6] = 4
        return out


def test_termitai_su_terreno_secco():
    geom = {"type": "Polygon", "coordinates": [[[29.38, -13.62], [29.40, -13.62], [29.40, -13.60], [29.38, -13.60], [29.38, -13.62]]]}
    spots = [(50, 50, 1), (80, 120, 2), (150, 60, 3), (170, 170, 2)]
    r = detect_termites(FakeClient(spots), geom, "2025-11-01", sens=3)
    assert r["n_total"] == 4
    ds = sorted(m["d_m"] for m in r["mounds"])
    assert ds[0] == 11.3 and ds[-1] == 33.9          # 1 pixel → 11,3 m; 9 pixel → 33,9 m
    assert r["date"][5:7] in ("08", "09")             # la scena più secca dell'anno
