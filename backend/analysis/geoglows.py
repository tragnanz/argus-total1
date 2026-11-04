"""Portate GEOGLOWS v2 (ECMWF · BYU) per qualsiasi fiume del mondo, corrette con le stazioni misurate.

GEOGLOWS v2 simula 6,8 milioni di tratti di fiume (rete TDX-Hydro) dal 1940 a oggi;
la serie mensile è pubblica su AWS Open Data (s3://geoglows-v2, CC BY 4.0) e si
legge senza chiavi né limiti di richieste: un blocco zarr (~0,6 MB) contiene 250
tratti × 85 anni.

data/geoglows_index.npz è l'indice compatto dei 1,15 milioni di tratti con bacino
≥ 1.000 km²: colonna zarr, tratto a valle, superficie del bacino e un punto ogni
~4 km lungo il tracciato (tessere di 1°). Con la rete si sa se una stazione sta
sullo STESSO fiume della presa (una è a valle dell'altra), senza indovinarlo dalle
portate.

La correzione: fattore_mese = Q osservata alla stazione / Q GEOGLOWS al tratto della
stazione, applicato al tratto della presa (stesso fiume, bacino di dimensione
simile).
"""
from __future__ import annotations

import math
import os
import threading
from collections import OrderedDict
from functools import lru_cache

import numpy as np
import requests

ZARR = "https://geoglows-v2.s3-us-west-2.amazonaws.com/retrospective/monthly-timeseries.zarr"
SOURCE = "GEOGLOWS v2 · ECMWF (AWS Open Data, CC BY 4.0)"
_IDX = os.path.join(os.path.dirname(__file__), "data", "geoglows_index.npz")
Y0, Y1 = 1994, 2023                       # stesso periodo di GloFAS
_M0 = (Y0 - 1940) * 12                    # primo mese nel blocco temporale 0 (1940-01 … 2024-12)
_M1 = (Y1 - 1940 + 1) * 12
_CH = OrderedDict()
_LOCK = threading.Lock()


@lru_cache(maxsize=1)
def index():
    z = np.load(_IDX)
    col = np.cumsum(z["dcol"]).astype(np.int64)
    dds = z["dds"]
    ds = np.where(dds == np.int32(-2**31), -1, dds.astype(np.int64) + np.arange(len(dds)))
    area = 10 ** (z["larea"].astype(np.float64) / 1000.0)
    tiles, tstart = z["tiles"], z["tstart"]
    pr = np.cumsum(z["dpr"]).astype(np.int32)
    tl = (tiles // 360) - 90
    tn = (tiles % 360) - 180
    n = len(pr)
    tend = np.append(tstart[1:], n)
    reps = (tend - tstart).astype(np.int64)
    plat = (np.repeat(tl, reps) + z["dla"].astype(np.float64) / 1e4).astype(np.float32)
    plon = (np.repeat(tn, reps) + z["dlo"].astype(np.float64) / 1e4).astype(np.float32)
    tpos = {int(t): (int(a), int(b)) for t, a, b in zip(tiles, tstart, tend)}
    return {"col": col, "ds": ds, "area": area, "pr": pr, "plat": plat, "plon": plon, "tpos": tpos}


def reaches_near(lat: float, lon: float, radius_km: float, min_area: float = 0.0) -> list[dict]:
    """Tratti entro radius_km dal punto, con la distanza minima dal tracciato (km)."""
    ix = index()
    dla = radius_km / 111.0
    dlo = radius_km / (111.0 * max(0.05, math.cos(math.radians(lat))))
    sl = []
    for a in range(math.floor(lat - dla), math.floor(lat + dla) + 1):
        for b in range(math.floor(lon - dlo), math.floor(lon + dlo) + 1):
            bb = ((b + 180) % 360) - 180
            p = ix["tpos"].get((a + 90) * 360 + (bb + 180))
            if p:
                sl.append(np.arange(p[0], p[1]))
    if not sl:
        return []
    k = np.concatenate(sl)
    kx = 111.32 * math.cos(math.radians(lat))
    d = np.hypot((ix["plat"][k] - lat) * 110.57, (ix["plon"][k] - lon) * kx)
    m = d <= radius_km
    k, d = k[m], d[m]
    if not len(k):
        return []
    r = ix["pr"][k]
    best: dict[int, tuple[float, int]] = {}
    for ri, di, ki in zip(r.tolist(), d.tolist(), k.tolist()):
        if ri not in best or di < best[ri][0]:
            best[ri] = (di, ki)
    out = []
    for ri, (di, ki) in best.items():
        a = float(ix["area"][ri])
        if a >= min_area:
            out.append({"i": ri, "dist_km": round(di, 2), "area_km2": round(a), "lat": round(float(ix["plat"][ki]), 4), "lon": round(float(ix["plon"][ki]), 4)})
    out.sort(key=lambda x: x["dist_km"])
    return out


def downstream(i: int, limit: int = 20000) -> list[int]:
    ix = index(); path = [i]
    while len(path) < limit:
        j = int(ix["ds"][path[-1]])
        if j < 0:
            break
        path.append(j)
    return path


def same_river(a: int, b: int) -> bool:
    """Vero se uno dei due tratti è a valle dell'altro sulla rete."""
    if a == b:
        return True
    return b in set(downstream(a)) or a in set(downstream(b))


def _chunk(c: int) -> np.ndarray:
    with _LOCK:
        if c in _CH:
            _CH.move_to_end(c)
            return _CH[c]
    from numcodecs import Blosc
    r = requests.get(f"{ZARR}/Q/0.{c}", timeout=60)
    r.raise_for_status()
    a = np.frombuffer(Blosc().decode(r.content), dtype="<f4").reshape(1020, 250)
    with _LOCK:
        _CH[c] = a
        while len(_CH) > 48:                       # ~50 MB al massimo
            _CH.popitem(last=False)
    return a


def climatology(i: int) -> dict:
    """Statistiche mensili 1994-2023 del tratto i (m³/s)."""
    col = int(index()["col"][i])
    q = _chunk(col // 250)[_M0:_M1, col % 250].astype(np.float64)
    q = np.where(np.isfinite(q) & (q >= 0), q, np.nan)
    by = q.reshape(-1, 12)
    mm = np.nanmean(by, axis=0)
    low = np.nanpercentile(by, 20, axis=0)          # magra: mese superato in 4 anni su 5
    allv = q[np.isfinite(q)]
    return {"mean": round(float(np.nanmean(mm)), 3), "month_mean": [round(float(x), 3) for x in mm],
            "month_q80": [round(float(x), 3) for x in low], "month_min": [round(float(x), 3) for x in np.nanmin(by, axis=0)],
            "q347": round(float(np.percentile(allv, 5)), 3), "min": round(float(allv.min()), 3), "max": round(float(allv.max()), 3),
            "years": [str(Y0), str(Y1)], "n_days": 0}


def _station_reach(s: dict) -> int | None:
    """Il tratto della stazione: entro 8 km, quello col bacino più simile (se la stazione lo dichiara)."""
    near = reaches_near(s["lat"], s["lon"], 15.0 if s["src"] == "unh" else 8.0)   # unh: coordinate approssimate
    if not near:
        return None
    a = float(s.get("area") or 0)
    if a > 0:
        r = min(near, key=lambda x: abs(math.log(x["area_km2"] / a)) + x["dist_km"] / 50)
        return r["i"] if abs(math.log(r["area_km2"] / a)) < math.log(2.5) else None
    return max(near[:3], key=lambda x: x["area_km2"])["i"]


def correction(reach: dict, radius_km: float = 800.0) -> dict | None:
    """Stazione misurata sullo stesso fiume del tratto `reach`, con bacino di dimensione simile."""
    from analysis.river_obs import stations, _dist_km, SOURCES
    i, a0, q0 = reach["i"], reach["area_km2"], float(reach.get("mean") or 0)
    down = set(downstream(i))
    best = None
    cand = []
    for s in stations():
        if abs(s["lat"] - reach["lat"]) > radius_km / 100 or s["mean"] <= 0:
            continue
        sa = float(s.get("area") or 0)
        if sa > 0 and not (a0 / 4 <= sa <= a0 * 4):
            continue
        d = _dist_km(reach["lat"], reach["lon"], s["lat"], s["lon"])
        if d <= radius_km:
            cand.append((d, s))
    cand.sort(key=lambda x: x[0])
    for d, s in cand[:80]:
        j = _station_reach(s)
        if j is None:
            continue
        aj = float(index()["area"][j])
        if not (a0 / 6 <= aj <= a0 * 6):
            continue
        if not (j in down or i in set(downstream(j))):
            continue                                   # non è lo stesso fiume
        # stesso tratto "idraulico": la portata simulata alla stazione è simile a quella della presa
        # (a una confluenza il bacino cresce poco ma la portata può raddoppiare)
        sim = climatology(j)
        if sim["mean"] <= 0 or q0 <= 0:
            continue
        same = abs(math.log(sim["mean"] / q0))
        if same > math.log(2.5) or not (0.05 <= s["mean"] / sim["mean"] <= 10):
            continue                                   # tratto diverso, o stazione di un canale/derivazione
        score = same + d / 1000.0
        if best is None or score < best[0]:
            best = (score, s, j, d, sim)
    if best is None:
        return None
    _, s, j, d, sim = best
    clamp = lambda x: max(0.05, min(20.0, x))  # noqa: E731
    f_year = clamp(s["mean"] / sim["mean"])
    f_month = [round(clamp(o / m), 4) if m > 0 else round(f_year, 4) for o, m in zip(s["mm"], sim["month_mean"])]
    return {
        "station": {"id": s["id"], "name": s["station"], "river": s["river"], "country": s["cc"], "lat": s["lat"], "lon": s["lon"],
                    "area_km2": s.get("area"), "years": s["yrs"], "dist_km": round(d, 1), "source": SOURCES.get(s["src"], s["src"]),
                    "downstream": j in down},
        "obs_mean": s["mean"], "obs_month": s["mm"], "sim_mean": sim["mean"], "sim_month": sim["month_mean"],
        "sim_area_km2": round(float(index()["area"][j])), "ref_mean": None, "f_year": round(f_year, 4), "f_month": f_month,
        "model": "geoglows",
    }


def at(lat: float, lon: float, radius_km: float = 12.0, k: int = 6) -> dict:
    """Tratti GEOGLOWS vicini alla presa (i più grandi prima), con statistiche e correzione."""
    near = reaches_near(lat, lon, radius_km)
    if not near:
        return {"source": SOURCE, "period": [str(Y0), str(Y1)], "cells": [], "pick": -1}
    # un tratto per fiume: il più vicino; i fiumi grandi prima
    rivers: list[dict] = []
    for r in sorted(near, key=lambda x: x["dist_km"]):
        if any(same_river(r["i"], o["i"]) and 0.8 < r["area_km2"] / o["area_km2"] < 1.25 for o in rivers):
            continue
        rivers.append(r)
        if len(rivers) >= 12:
            break
    rivers.sort(key=lambda x: -x["area_km2"])
    rivers = rivers[:k]
    cells = []
    for r in rivers:
        c = climatology(r["i"])
        c.update({"lat": r["lat"], "lon": r["lon"], "dist_km": r["dist_km"], "area_km2": r["area_km2"], "reach": r["i"]})
        cells.append(c)
    # proposta: il fiume più grande entro 3 km dalla presa; se la presa non è su un fiume dell'indice
    # (bacino < 1.000 km²) nessuna proposta: i tratti restano elencati, ma non si usa un fiume lontano
    close = [c for c in cells if c["dist_km"] <= 3]          # punti ogni ~4 km: 3 km = sul fiume
    if not close:
        return {"source": SOURCE, "period": [str(Y0), str(Y1)], "cells": cells, "pick": -1, "corr": None}
    pick = max(close, key=lambda c: c["area_km2"])
    pi = cells.index(pick)
    corr = None
    try:
        corr = correction({"i": pick["reach"], "area_km2": pick["area_km2"], "lat": pick["lat"], "lon": pick["lon"], "mean": pick["mean"]})
        if corr:
            corr["ref_mean"] = pick["mean"]
    except Exception as e:  # noqa: BLE001
        corr = None
        pick["corr_error"] = str(e)[:200]
    return {"source": SOURCE, "period": [str(Y0), str(Y1)], "cells": cells, "pick": pi, "corr": corr}
