"""Lettura di fiumi e canali (analysis/waterways.py) su una scena sintetica con misure note:
canale diritto 40 m, fiume a meandri 120 m, fosso 7 m, strada asfaltata 15 m (da scartare).
I pixel misti si costruiscono per sovracampionamento (frazione d'acqua vera di ogni pixel)."""
import functools
import math

import numpy as np
import pyproj

from analysis import waterways as W

RES = 10.0
H, Wd = 400, 500          # 4 × 5 km
SUP = 5                   # sovracampionamento per i pixel misti


def _coverage(dist_fn, half_w):
    """Frazione di ogni pixel entro half_w (m) dall'asse, per sovracampionamento."""
    ys = (np.arange(H * SUP) + 0.5) / SUP * RES
    xs = (np.arange(Wd * SUP) + 0.5) / SUP * RES
    X, Y = np.meshgrid(xs, ys)
    inside = dist_fn(X, Y) <= half_w
    return inside.reshape(H, SUP, Wd, SUP).mean(axis=(1, 3))


def _scene():
    # canale diritto E-O a y = 800 m, largo 40 m
    canal = _coverage(lambda X, Y: np.abs(Y - 800.0), 20.0)
    # fiume a meandri: asse y = 2600 + 250 sin(2πx/1500), largo 120 m (distanza verticale ~ ok, correggo per pendenza)
    def d_river(X, Y):
        yc = 2600 + 250 * np.sin(2 * np.pi * X / 1500.0)
        slope = 250 * 2 * np.pi / 1500.0 * np.cos(2 * np.pi * X / 1500.0)
        return np.abs(Y - yc) / np.sqrt(1 + slope ** 2)
    river = _coverage(d_river, 60.0)
    # fosso N-S a x = 1505 m (al centro di un pixel: a cavallo di due pixel un fosso da 7 m non si distingue), largo 7 m (sotto il pixel), da y=1200 a y=2000
    ditch = _coverage(lambda X, Y: np.where((Y > 1200) & (Y < 2000), np.abs(X - 1505.0), 1e9), 3.5)
    # strada asfaltata N-S a x = 3500 m, larga 15 m
    road = _coverage(lambda X, Y: np.abs(X - 3500.0), 7.5)
    water = np.clip(canal + river + ditch, 0, 1)
    veg = np.clip(1 - water - road, 0, 1)
    # riflettanze: vegetazione, acqua, asfalto (B02,B03,B04,B05,B08,B11)
    R_veg = np.array([0.03, 0.07, 0.04, 0.12, 0.33, 0.20])
    R_wat = np.array([0.05, 0.06, 0.04, 0.03, 0.02, 0.01])
    R_road = np.array([0.12, 0.13, 0.14, 0.15, 0.17, 0.24])
    bands = (veg[None] * R_veg[:, None, None] + water[None] * R_wat[:, None, None]
             + road[None] * R_road[:, None, None]).astype("float32")
    return bands


class FakeClient:
    def __init__(self):
        self.b = _scene()

    def search_scenes(self, bbox, d0, d1, max_cloud=80, limit=100):
        return [{"date": "2025-07-01", "cloud": 1.0}, {"date": "2025-08-01", "cloud": 2.0}]

    def fetch_bands(self, bbox_utm, epsg, width, height, day):
        # la griglia del test parte da (0,0) in UTM locale: ritaglio diretto
        x0, y0, x1, y1 = bbox_utm
        c0 = int(round((x0 - ORIGIN[0]) / RES)); r0 = int(round((ORIGIN[1] + H * RES - y1) / RES))
        out = np.zeros((7, height, width), "float32")
        sub = self.b[:, r0:r0 + height, c0:c0 + width]
        out[:6, :sub.shape[1], :sub.shape[2]] = sub
        out[6] = 4                                       # SCL vegetazione
        return out


# origine UTM 33N arbitraria
EPSG = 32633
ORIGIN = (500000.0, 4000000.0)


def _geom():
    to_wgs = pyproj.Transformer.from_crs(EPSG, 4326, always_xy=True)
    x0, y0 = ORIGIN
    pts = [(x0 + 1, y0 + 1), (x0 + Wd * RES - 1, y0 + 1), (x0 + Wd * RES - 1, y0 + H * RES - 1), (x0 + 1, y0 + H * RES - 1)]
    ring = [list(to_wgs.transform(x, y)) for x, y in pts]
    return {"type": "Polygon", "coordinates": [ring + [ring[0]]]}


@functools.lru_cache(maxsize=1)
def _run():
    g = {"epsg": EPSG, "minx": ORIGIN[0], "top": ORIGIN[1] + H * RES, "res": RES, "wp": Wd, "hp": H,
         "to_wgs": pyproj.Transformer.from_crs(EPSG, 4326, always_xy=True)}
    C = W._composite(FakeClient(), g, ["2025-07-01", "2025-08-01"], workers=1)
    return W.detect_waterways(None, _geom(), sens=3, composite=(C, g, ["2025-07-01", "2025-08-01"]))


def _near(seg, x_m=None, y_m=None):
    to_utm = pyproj.Transformer.from_crs(4326, EPSG, always_xy=True)
    pts = [to_utm.transform(*c) for c in seg["geojson"]["coordinates"]]
    if x_m is not None:
        return all(abs(p[0] - ORIGIN[0] - x_m) < 40 for p in pts)
    return all(abs(p[1] - (ORIGIN[1] + H * RES - y_m)) < 40 for p in pts)


def test_misure_e_scarti():
    out = _run()
    segs = out["segments"]
    canal = [s for s in segs if _near(s, y_m=800.0)]
    assert canal, "canale non trovato"
    c = max(canal, key=lambda s: s["length_m"])
    assert c["kind"] == "canal"
    assert abs(c["width_m"] - 40.0) / 40.0 < 0.15, c["width_m"]
    assert c["length_m"] > 0.95 * Wd * RES * 0.97          # tutto il riquadro, meno i bordi
    # fiume: largo 120 m, sinuoso
    big = [s for s in segs if s["width_m"] > 80]
    assert big, "fiume non trovato"
    r = max(big, key=lambda s: s["length_m"])
    assert r["kind"] == "river"
    assert abs(r["width_m"] - 120.0) / 120.0 < 0.15, r["width_m"]
    assert r["sinuosity"] > 1.2
    # strada: nessun tratto lungo x = 3500 m
    assert not [s for s in segs if _near(s, x_m=3500.0) and s["length_m"] > 200], "strada presa per un canale"


def test_fosso_sotto_il_pixel():
    out = _run()
    d = [s for s in out["segments"] if _near(s, x_m=1500.0)]
    assert d, "fosso da 7 m non trovato"
    s = max(d, key=lambda s: s["length_m"])
    assert s["below_pixel"]
    assert 4.0 <= s["width_m"] <= 11.0, s["width_m"]
    assert abs(s["length_m"] - 800.0) < 120


def test_grafo_rami():
    # una Y: tre tratti che si incontrano in un nodo
    m = np.zeros((60, 60), bool)
    m[30, 5:31] = True
    for k in range(25):
        m[30 - k, 30 + k] = True
        m[30 + k, 30 + k] = True
    edges = W._graph(m)
    edges = W._prune_merge(edges, 10.0, 30.0, np.ones_like(m, float))
    lens = sorted(round(W._plen(e["px"], 10.0)) for e in edges)
    assert len(edges) == 3, lens


# ---- fiumara: acqua solo in gennaio e febbraio, 12 date mensili ----
DATES12 = [f"2025-{m:02d}-15" for m in range(1, 13)]


class FiumaraClient(FakeClient):
    def __init__(self):
        super().__init__()
        # alveo E-O a y = 1800 m, largo 30 m, sinuoso
        def d_f(X, Y):
            yc = 1800 + 120 * np.sin(2 * np.pi * X / 2500.0)
            sl = 120 * 2 * np.pi / 2500.0 * np.cos(2 * np.pi * X / 2500.0)
            return np.abs(Y - yc) / np.sqrt(1 + sl ** 2)
        f = _coverage(d_f, 15.0)
        R_veg = np.array([0.03, 0.07, 0.04, 0.12, 0.33, 0.20])
        R_wat = np.array([0.05, 0.06, 0.04, 0.03, 0.02, 0.01])
        R_grav = np.array([0.12, 0.14, 0.16, 0.18, 0.22, 0.28])     # greto asciutto
        self.wet = self.b * (1 - f)[None] + (f[None] * R_wat[:, None, None]).astype("float32")
        self.dry = self.b * (1 - f)[None] + (f[None] * R_grav[:, None, None]).astype("float32")

    def search_scenes(self, bbox, d0, d1, max_cloud=80, limit=100):
        return [{"date": d, "cloud": 5.0} for d in DATES12 if d0 <= d <= d1]

    def fetch_bands(self, bbox_utm, epsg, width, height, day):
        self.b = self.wet if day[5:7] in ("01", "02") else self.dry
        return super().fetch_bands(bbox_utm, epsg, width, height, day)


def test_fiumara_effimera():
    g = {"epsg": EPSG, "minx": ORIGIN[0], "top": ORIGIN[1] + H * RES, "res": RES, "wp": Wd, "hp": H,
         "to_wgs": pyproj.Transformer.from_crs(EPSG, 4326, always_xy=True)}
    assert W._pick_scenes(FiumaraClient(), [0, 0, 1, 1], "2025-12-31", 12, 60, 12) == DATES12
    C = W._composite(FiumaraClient(), g, DATES12, workers=1)
    out = W.detect_waterways(None, _geom(), sens=3, composite=(C, g, DATES12))
    f = [s for s in out["segments"] if _near(s, y_m=1800.0) or (s["length_m"] > 1500 and s["regime"] != "perennial")]
    assert f, [(s["length_m"], s["regime"]) for s in out["segments"]]
    s = max(f, key=lambda s: s["length_m"])
    assert s["regime"] == "ephemeral", s["regime"]
    assert s["months_wet"] == [1, 2], s["months_wet"]
    assert abs(s["width_m"] - 30.0) / 30.0 < 0.25, s["width_m"]
    assert s["length_m"] > 3000
    # i corsi perenni restano perenni
    c = max((x for x in out["segments"] if _near(x, y_m=800.0)), key=lambda x: x["length_m"])
    assert c["regime"] == "perennial" and len(c["months_wet"]) == 12
