"""Termitai dalle immagini Sentinel-2 (stagione secca).

Nella savana i termitai grandi (10–40 m di diametro) portano alberi e arbusti che restano
verdi quando il campo intorno è secco: nell'NDVI di una scena della stagione secca sono
macchie isolate di 1–10 pixel, più verdi dello sfondo. Si sceglie la scena più secca degli
ultimi 12 mesi (NDVI mediano più basso nell'area, senza nuvole), si toglie lo sfondo con un
filtro mediano su ~110 m e si tengono le macchie piccole e isolate su terreno aperto
(sfondo con NDVI basso: nel bosco un termitaio non si distingue dagli alberi).

Il diametro è quello della macchia verde (minimo 8 m, il pixel è di 10 m): per i termitai
più piccoli la scena a 10 m non basta, e vanno segnati a mano.
"""
from __future__ import annotations

import datetime as dt
import math

import numpy as np

from .waterways import _grid

CLOUD_SCL = (3, 8, 9, 10)                       # ombra, nuvole medie/alte, cirri
THR = {1: 0.08, 2: 0.065, 3: 0.05, 4: 0.04, 5: 0.03}   # sensibilità → scarto minimo di NDVI


def _poly_mask(g: dict, geom: dict) -> np.ndarray:
    import pyproj
    from matplotlib.path import Path
    to_utm = pyproj.Transformer.from_crs(4326, g["epsg"], always_xy=True)
    rings = [[to_utm.transform(lo, la) for lo, la, *_ in r] for r in geom["coordinates"]]
    xs = g["minx"] + (np.arange(g["wp"]) + 0.5) * g["res"]
    ys = g["top"] - (np.arange(g["hp"]) + 0.5) * g["res"]
    X, Y = np.meshgrid(xs, ys)
    pts = np.c_[X.ravel(), Y.ravel()]
    m = Path(rings[0]).contains_points(pts)
    for h in rings[1:]:
        m &= ~Path(h).contains_points(pts)
    return m.reshape(g["hp"], g["wp"])


def _scenes(client, bbox, date_to: str, months: int = 12) -> list[str]:
    """Una scena per mese (la prima trovata con poche nuvole), dalle più recenti."""
    d1 = dt.date.fromisoformat(date_to)
    d0 = d1 - dt.timedelta(days=int(months * 30.44))
    out: dict[str, str] = {}
    a = d0
    while a < d1:
        b = min(d1, a + dt.timedelta(days=91))
        try:
            for d in client.search_dates(bbox, a.isoformat(), b.isoformat(), max_cloud=10):
                out.setdefault(d[:7], d)
        except Exception:  # noqa: BLE001
            pass
        a = b + dt.timedelta(days=1)
    return [out[k] for k in sorted(out)]


def detect_termites(client, geom: dict, date: str | None = None, sens: int = 3,
                    max_scenes: int = 6) -> dict:
    from scipy import ndimage as nd
    g = _grid(geom)
    res = g["res"]
    inside = _poly_mask(g, geom)
    bbox_utm = [g["minx"], g["top"] - g["hp"] * res, g["minx"] + g["wp"] * res, g["top"]]
    date_to = date or dt.date.today().isoformat()
    months = _scenes(client, g["bbox_wgs"], date_to)
    if not months:
        raise RuntimeError("nessuna scena Sentinel-2 senza nuvole negli ultimi 12 mesi")
    # al massimo max_scenes scene distribuite nell'anno: si tiene la più secca
    step = max(1, math.ceil(len(months) / max_scenes))
    cand = months[::step]
    best = None
    for d in cand:
        try:
            b = client.fetch_bands(bbox_utm, g["epsg"], g["wp"], g["hp"], d)
        except Exception:  # noqa: BLE001
            continue
        red, nir, scl = b[2], b[4], b[6]
        ok = inside & np.isfinite(red) & np.isfinite(nir) & ~np.isin(scl, CLOUD_SCL)
        if ok.sum() < 0.8 * inside.sum():
            continue
        ndvi = (nir - red) / (nir + red + 1e-6)
        med = float(np.nanmedian(ndvi[ok]))
        if best is None or med < best[1]:
            best = (d, med, ndvi, ok)
    if best is None:
        raise RuntimeError("nessuna scena utilizzabile (nuvole o dati mancanti)")
    d, med, ndvi, ok = best
    nd_f = np.where(ok, ndvi, med)
    bg = nd.median_filter(nd_f, size=max(5, int(round(110 / res)) | 1))
    an = nd_f - bg
    thr = THR.get(int(sens), 0.05)
    m = (an > thr) & (bg < 0.30) & ok
    lab, n = nd.label(m)
    out = []
    if n:
        idx = np.arange(1, n + 1)
        sz = nd.sum(m, lab, idx)
        cm = nd.center_of_mass(m, lab, idx)
        pk = nd.maximum(an, lab, idx)
        max_px = max(2, int(round(1000 / (res * res))))      # macchie fino a ~1000 m² (≈ 36 m di diametro)
        for (r, c), s, p in zip(cm, sz, pk):
            if s < 1 or s > max_px:
                continue
            x = g["minx"] + (c + 0.5) * res
            y = g["top"] - (r + 0.5) * res
            lon, lat = g["to_wgs"].transform(x, y)
            dia = max(8.0, min(40.0, 2 * math.sqrt(s * res * res / math.pi)))
            out.append({"lon": round(lon, 6), "lat": round(lat, 6), "d_m": round(dia, 1), "score": round(float(p), 3)})
    out.sort(key=lambda q: -q["score"])
    return {"date": d, "ndvi_median": round(med, 3), "res_m": res, "mounds": out[:5000], "n_total": len(out)}
