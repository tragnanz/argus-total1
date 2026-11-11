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


class FakeGround:
    """Scena secca (set) con una crosta di sale e un bosco; scena umida (gen) con un ristagno."""

    def search_dates(self, bbox, a, b, max_cloud=10):
        return [a[:8] + "15"]

    def fetch_bands(self, bbox_utm, epsg, w, h, day):
        out = np.zeros((7, h, w), "float32")
        out[0], out[1], out[2], out[4], out[5] = 0.08, 0.10, 0.14, 0.24, 0.30   # suolo nudo bruno
        out[6] = 4
        m = day[5:7]
        if m in ("08", "09"):                                # secca
            out[:, 20:40, 20:40] = np.array([0.40, 0.42, 0.43, 0, 0.45, 0.40, 4], "float32")[:, None, None]   # sale
            out[2, 100:140, 100:160] = 0.04; out[4, 100:140, 100:160] = 0.35                                     # bosco
        else:
            out[4] += 0.04
        if m in ("01", "02"):                                # bagnata
            out[1, 150:175, 30:70] = 0.12; out[5, 150:175, 30:70] = 0.05; out[4, 150:175, 30:70] = 0.08          # acqua
        return out


def test_classi_per_origine():
    import base64, zlib
    geom = {"type": "Polygon", "coordinates": [[[29.38, -13.62], [29.40, -13.62], [29.40, -13.60], [29.38, -13.60], [29.38, -13.62]]]}
    r = detect_termites(FakeGround(), geom, "2025-11-01", sens=3)
    L = r["layers"]
    assert 3.0 <= L["ha"]["salt"] <= 4.5            # 20×20 px = 4 ha meno i bordi
    assert 20 <= L["ha"]["wood"] <= 25              # 40×60 px = 24 ha
    assert 8 <= L["ha"]["wet"] <= 11                # 25×40 px = 10 ha
    assert L["ha"]["water"] == 0
    f = np.frombuffer(zlib.decompress(base64.b64decode(L["b64"])), np.uint8)
    assert f.size == L["w"] * L["h"] and set(np.unique(f)) <= {0, 1, 2, 4}


def test_niente_termitai_fuori_dai_tropici():
    geom = {"type": "Polygon", "coordinates": [[[11.0, 45.0], [11.02, 45.0], [11.02, 45.02], [11.0, 45.02], [11.0, 45.0]]]}
    r = detect_termites(FakeClient([(50, 50, 2)]), geom, "2025-11-01", sens=3)
    assert r["termites_skipped"] and r["mounds"] == []
