"""Profilo longitudinale di un canale (e di una strada) dal modello del terreno, con i SALTI di quota.

Il fondo scende con la pendenza di progetto. Il canale si tiene in scavo: la sommità degli argini
(fondo + tirante + franco) sta al livello del terreno. Dove il terreno scende più del fondo, il
canale resterebbe pensile. Lì si mette un salto (manufatto di caduta) che riporta il fondo sotto il
terreno. Un salto è alto al massimo `drop_max` m: se serve di più se ne mettono diversi di seguito.
Da qui si ricavano scavo e rilevato (m³) e lo scavo massimo.
"""
from __future__ import annotations

import math

import numpy as np
import pyproj

from .canal import _dem_and_grid, _smooth


def _densify_utm(coords_ll: list, to_utm, step: float) -> list[tuple[float, float, float, float]]:
    """Punti ogni `step` m lungo la polilinea: (x, y, lon, lat)."""
    out = []
    xy = [to_utm.transform(float(c[0]), float(c[1])) for c in coords_ll]
    for i in range(len(xy) - 1):
        (x0, y0), (x1, y1) = xy[i], xy[i + 1]
        L = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(math.ceil(L / step)))
        for k in range(n):
            t = k / n
            lo = coords_ll[i][0] + (coords_ll[i + 1][0] - coords_ll[i][0]) * t
            la = coords_ll[i][1] + (coords_ll[i + 1][1] - coords_ll[i][1]) * t
            out.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, float(lo), float(la)))
    out.append((xy[-1][0], xy[-1][1], float(coords_ll[-1][0]), float(coords_ll[-1][1])))
    return out


def terrain_profile(client, coords_ll: list, step: float = 20.0, bundle=None) -> dict:
    """Quote del terreno (DEM levigato, interpolazione bilineare) ogni `step` m lungo la linea."""
    lons = [c[0] for c in coords_ll]; lats = [c[1] for c in coords_ll]
    m = 0.004
    geom = {"type": "Polygon", "coordinates": [[[min(lons) - m, min(lats) - m], [max(lons) + m, min(lats) - m],
                                                [max(lons) + m, max(lats) + m], [min(lons) - m, max(lats) + m],
                                                [min(lons) - m, min(lats) - m]]]}
    dem, mask, ctx = bundle or _dem_and_grid(client, geom, max_dim=420)
    demS = _smooth(dem)
    to_utm = pyproj.Transformer.from_crs(4326, ctx["epsg"], always_xy=True)
    pts = _densify_utm(coords_ll, to_utm, step)
    res, hp, wp = ctx["res"], ctx["hp"], ctx["wp"]
    d, z, ll = [], [], []
    cum = 0.0
    for k, (x, y, lo, la) in enumerate(pts):
        if k:
            cum += math.hypot(x - pts[k - 1][0], y - pts[k - 1][1])
        fx = (x - ctx["minx"]) / res - 0.5; fy = (ctx["top"] - y) / res - 0.5
        c0 = int(np.clip(math.floor(fx), 0, wp - 2)); r0 = int(np.clip(math.floor(fy), 0, hp - 2))
        tx = float(np.clip(fx - c0, 0, 1)); ty = float(np.clip(fy - r0, 0, 1))
        q = demS[r0:r0 + 2, c0:c0 + 2]
        if not np.all(np.isfinite(q)):
            v = float(np.nanmean(q)) if np.any(np.isfinite(q)) else float("nan")
        else:
            v = float(q[0, 0] * (1 - tx) * (1 - ty) + q[0, 1] * tx * (1 - ty) + q[1, 0] * (1 - tx) * ty + q[1, 1] * tx * ty)
        d.append(cum); z.append(v); ll.append([lo, la])
    z = np.array(z, float)
    if np.any(~np.isfinite(z)):
        good = np.isfinite(z)
        z = np.interp(np.arange(len(z)), np.flatnonzero(good), z[good]) if good.any() else np.zeros(len(z))
    return {"d": d, "z": [float(v) for v in z], "ll": ll}


def design_canal(prof: dict, b: float, y: float, fb: float, m: float, slope_permille: float,
                 drop_max: float = 1.0, fill_tol: float = 0.2) -> dict:
    """Fondo, pelo libero, argini e salti lungo il profilo del terreno."""
    d, z, ll = prof["d"], prof["z"], prof["ll"]
    S = max(1e-5, slope_permille / 1000.0)
    H = y + fb
    bed = [0.0] * len(d)
    bed[0] = z[0] - H                              # testa: argini al livello del terreno
    drops = []
    for i in range(1, len(d)):
        bi = bed[i - 1] - S * (d[i] - d[i - 1])
        # pensile oltre la tolleranza: salto (uno o più) per riportare gli argini al terreno
        need = bi + H - z[i]
        if need > fill_tol:
            hh = need
            while hh > 1e-6:
                h = min(drop_max, hh)
                h = math.ceil(h * 10) / 10.0
                drops.append({"d": round(d[i], 1), "h": round(h, 2), "ll": ll[i]})
                bi -= h; hh -= h
        bed[i] = bi
    wl = [b0 + y for b0 in bed]
    bank = [b0 + H for b0 in bed]
    cut_v = fill_v = 0.0
    cut_max = 0.0
    for i in range(1, len(d)):
        dd = d[i] - d[i - 1]
        for j in (i - 1, i):
            dc = z[j] - bed[j]                     # profondità dal terreno al fondo
            if dc > 0:
                hc = min(dc, H)
                area = (b + m * hc) * hc + (b + 2 * m * H) * max(0.0, dc - H)
                cut_v += area * dd / 2
            hf = bank[j] - z[j]                    # argini sopra il terreno (rilevato)
            if hf > 0:
                fill_v += 2 * (2.0 + 1.5 * hf) * hf * dd / 2      # due argini, sommità 2 m, scarpa 1:1,5
        cut_max = max(cut_max, z[i] - bed[i], z[i - 1] - bed[i - 1])
    # profilo alleggerito per il disegno (≤ 200 punti)
    step = max(1, len(d) // 200)
    idx = list(range(0, len(d), step))
    if idx[-1] != len(d) - 1:
        idx.append(len(d) - 1)
    return {
        "length_m": round(d[-1], 1),
        "terrain_permille": round((z[0] - z[-1]) / max(1.0, d[-1]) * 1000, 3),
        "slope_permille": slope_permille,
        "drops": drops, "n_drops": len(drops), "drop_total_m": round(sum(x["h"] for x in drops), 2),
        "cut_m3": round(cut_v), "fill_m3": round(fill_v), "cut_max_m": round(cut_max, 2),
        "profile": {"d": [round(d[i], 1) for i in idx], "z": [round(z[i], 2) for i in idx],
                    "bed": [round(bed[i], 2) for i in idx], "wl": [round(wl[i], 2) for i in idx],
                    "bank": [round(bank[i], 2) for i in idx]},
    }
