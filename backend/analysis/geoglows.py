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
    rid = z["rid"].astype(np.int64) if "rid" in z.files else None
    return {"col": col, "ds": ds, "area": area, "pr": pr, "plat": plat, "plon": plon, "tpos": tpos, "rid": rid}


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


@lru_cache(maxsize=1)
def _by_reach():
    ix = index()
    o = np.argsort(ix["pr"], kind="stable")
    starts = np.searchsorted(ix["pr"][o], np.arange(len(ix["col"]) + 1))
    return o, starts


def reach_centroid(i: int) -> list[float] | None:
    ix = index(); o, st = _by_reach()
    k = o[st[i]:st[i + 1]]
    if not len(k):
        return None
    return [round(float(ix["plon"][k].mean()), 5), round(float(ix["plat"][k].mean()), 5)]


def path_between(a: int, b: int, max_pts: int = 400) -> list[list[float]]:
    """Tracciato (centri dei tratti) lungo la rete fra due tratti dello stesso fiume, da monte a valle."""
    da = downstream(a)
    if b in da:
        seq = da[:da.index(b) + 1]
    else:
        db = downstream(b)
        if a not in db:
            return []
        seq = db[:db.index(a) + 1]
    step = max(1, len(seq) // max_pts)
    pts = [reach_centroid(i) for i in seq[::step] + ([seq[-1]] if (len(seq) - 1) % step else [])]
    return [p for p in pts if p]


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
    for k in range(3):                                   # S3: un errore di rete passeggero non deve perdere la stima
        try:
            r = requests.get(f"{ZARR}/Q/0.{c}", timeout=60)
            r.raise_for_status()
            break
        except Exception:  # noqa: BLE001
            if k == 2:
                raise
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
    p10 = np.nanpercentile(by, 10, axis=0)          # anno secco 1 su 10
    allv = q[np.isfinite(q)]
    return {"mean": round(float(np.nanmean(mm)), 3), "month_mean": [round(float(x), 3) for x in mm],
            "month_q80": [round(float(x), 3) for x in low], "month_p10": [round(float(x), 3) for x in p10], "month_min": [round(float(x), 3) for x in np.nanmin(by, axis=0)],
            "q347": round(float(np.percentile(allv, 5)), 3), "min": round(float(allv.min()), 3), "max": round(float(allv.max()), 3),
            "years": [str(Y0), str(Y1)], "n_days": 0}


def _station_reach(s: dict) -> int | None:
    """Il tratto della stazione: entro 8 km, quello col bacino più simile (se la stazione lo dichiara)."""
    near = reaches_near(s["lat"], s["lon"], 15.0 if s["src"] in ("unh", "kzh") else 8.0)   # unh, kzh: coordinate approssimate
    if not near:
        return None
    a = float(s.get("area") or 0)
    if a > 0:
        r = min(near, key=lambda x: abs(math.log(x["area_km2"] / a)) + x["dist_km"] / 50)
        return r["i"] if abs(math.log(r["area_km2"] / a)) < math.log(2.5) else None
    return max(near[:3], key=lambda x: x["area_km2"])["i"]


def correction(reach: dict, radius_km: float = 800.0) -> dict | None:
    """Stazione misurata sullo stesso fiume del tratto `reach`, con bacino di dimensione simile."""
    from analysis.river_obs import stations, usable, _dist_km, SOURCES
    i, a0, q0 = reach["i"], reach["area_km2"], float(reach.get("mean") or 0)
    down = set(downstream(i))
    cand = []
    for s in stations():
        if abs(s["lat"] - reach["lat"]) > radius_km / 100 or not usable(s):
            continue
        sa = float(s.get("area") or 0)
        if sa > 0 and not (a0 / 4 <= sa <= a0 * 4):
            continue
        d = _dist_km(reach["lat"], reach["lon"], s["lat"], s["lon"])
        if d <= radius_km:
            cand.append((d, s))
    cand.sort(key=lambda x: x[0])
    best: dict[str, tuple] = {}                        # la migliore a valle e la migliore a monte
    for d, s in cand[:80]:
        j = _station_reach(s)
        if j is None:
            continue
        aj = float(index()["area"][j])
        if not (a0 / 6 <= aj <= a0 * 6):
            continue
        dn = j in down
        if not (dn or i in set(downstream(j))):
            continue                                   # non è lo stesso fiume
        # stesso tratto "idraulico": la portata simulata alla stazione è simile a quella della presa
        # (a una confluenza il bacino cresce poco ma la portata può raddoppiare)
        try:
            sim = climatology(j)
        except Exception:  # noqa: BLE001
            continue
        if sim["mean"] <= 0 or q0 <= 0:
            continue
        same = abs(math.log(sim["mean"] / q0))
        if same > math.log(1.5) or not (0.05 <= s["mean"] / sim["mean"] <= 10):
            continue                                   # tratto diverso, o stazione di un canale/derivazione
        score = same + d / 1000.0
        side = "down" if dn else "up"
        if side not in best or score < best[side][0]:
            best[side] = (score, s, j, d, sim)
    if not best:
        return None
    clamp = lambda x: max(0.05, min(20.0, x))  # noqa: E731

    def one(b):
        _, s, j, d, sim = b
        fy = clamp(s["mean"] / sim["mean"])
        fm = [clamp(o / m) if m > 0 else fy for o, m in zip(s["mm"], sim["month_mean"])]
        st = {"id": s["id"], "name": s["station"], "river": s["river"], "country": s["cc"], "lat": s["lat"], "lon": s["lon"],
              "area_km2": s.get("area"), "years": s["yrs"], "dist_km": round(d, 1), "source": SOURCES.get(s["src"], s["src"]),
              "downstream": j in down, "f_year": round(fy, 4)}
        return st, fy, fm, s, sim, j, d

    parts = sorted((one(b) for b in best.values()), key=lambda x: x[6])
    st, fy, fm, s, sim, j, d = parts[0]                # la più vicina è quella mostrata
    if len(parts) == 2:
        # presa fra due stazioni: fattori mediati in scala logaritmica, pesati sull'inverso della distanza
        w = [1.0 / max(p[6], 1.0) for p in parts]
        W = sum(w)
        fy = math.exp(sum(wk * math.log(p[1]) for wk, p in zip(w, parts)) / W)
        fm = [math.exp(sum(wk * math.log(p[2][m]) for wk, p in zip(w, parts)) / W) for m in range(12)]
        for wk, p in zip(w, parts):
            p[0]["weight"] = round(wk / W, 3)
    for p in parts:
        try:
            p[0]["path"] = path_between(i, p[5])         # per disegnare sulla mappa il fiume fino alla stazione
        except Exception:  # noqa: BLE001
            p[0]["path"] = []
    return {
        "station": st, "stations": [p[0] for p in parts],
        "obs_mean": s["mean"], "obs_month": s["mm"], "sim_mean": sim["mean"], "sim_month": sim["month_mean"],
        "sim_area_km2": round(float(index()["area"][j])), "ref_mean": None, "f_year": round(fy, 4),
        "f_month": [round(x, 4) for x in fm], "model": "geoglows",
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


# ------------------------------------------------------------------ rete a monte, piogge del bacino
@lru_cache(maxsize=1)
def _upstream_csr():
    ds = index()["ds"]
    n = len(ds)
    src = np.where(ds >= 0)[0]
    dst = ds[src]
    o = np.argsort(dst, kind="stable")
    starts = np.searchsorted(dst[o], np.arange(n + 1))
    return src[o], starts


def upstream(i: int, limit: int = 400000) -> np.ndarray:
    """Tutti i tratti (≥ 1.000 km²) a monte di i, i compreso."""
    src, st = _upstream_csr()
    seen = np.zeros(len(st) - 1, dtype=bool)
    stack = [i]; seen[i] = True; out = [i]
    while stack and len(out) < limit:
        k = stack.pop()
        for j in src[st[k]:st[k + 1]]:
            if not seen[j]:
                seen[j] = True; stack.append(int(j)); out.append(int(j))
    return np.array(out, dtype=np.int64)


def basin_rain(i: int, lat: float, lon: float, k: int = 12) -> dict | None:
    """Pioggia media mensile sul bacino a monte del tratto i (NASA POWER, fino a k celle di 1° sulla rete).
    I bacini sotto i ~1.000 km² non sono nella rete: si usa la pioggia della presa."""
    from concurrent.futures import ThreadPoolExecutor
    from analysis.suitability import _get_climate_cached
    ix = index()
    up = upstream(i)
    m = np.isin(ix["pr"], up)
    if not m.any():
        return None
    cl = np.floor(ix["plat"][m]).astype(np.int64); cn = np.floor(ix["plon"][m]).astype(np.int64)
    cells, cnt = np.unique(np.stack([cl, cn], 1), axis=0, return_counts=True)
    sel = np.linspace(0, len(cells) - 1, min(k, len(cells))).round().astype(int) if len(cells) > k else np.arange(len(cells))
    pts = [(float(cells[j][0]) + 0.5, float(cells[j][1]) + 0.5, float(cnt[j])) for j in sel]
    def one(p):
        try:
            c, _ = _get_climate_cached(p[0], p[1], True)
            return [float(x) for x in c["rain"]], p[2]
        except Exception:  # noqa: BLE001
            return None
    with ThreadPoolExecutor(max_workers=6) as ex:
        res = [r for r in ex.map(one, pts) if r]
    if not res:
        return None
    W = sum(w for _, w in res)
    rain = [round(sum(r[mm] * w for r, w in res) / W, 1) for mm in range(12)]
    return {"rain_month_mm": rain, "cells": len(cells), "samples": len(res), "reaches": int(len(up))}


# ------------------------------------------------------------------ previsione a 15 giorni (REST GEOGLOWS)
API = "https://geoglows.ecmwf.int/api/v2"


def forecast(i: int) -> dict | None:
    ix = index()
    if ix["rid"] is None:
        return None
    rid = int(ix["rid"][i])
    r = requests.get(f"{API}/forecast/{rid}", params={"format": "json"}, timeout=60)
    r.raise_for_status()
    d = r.json()
    by: dict[str, list[float]] = {}
    lo: dict[str, list[float]] = {}; hi: dict[str, list[float]] = {}
    for t, q, a, b in zip(d["datetime"], d["flow_median"], d["flow_uncertainty_lower"], d["flow_uncertainty_upper"]):
        if q is None:
            continue
        day = t[:10]
        by.setdefault(day, []).append(float(q)); lo.setdefault(day, []).append(float(a)); hi.setdefault(day, []).append(float(b))
    days = sorted(by)
    return {"river_id": rid, "gen": d.get("metadata", {}).get("gen_date"),
            "days": [{"date": k, "q": round(sum(by[k]) / len(by[k]), 2), "lo": round(min(lo[k]), 2), "hi": round(max(hi[k]), 2)} for k in days]}


# ------------------------------------------------------------------ livelli dell'acqua (altimetria Hydroweb)
HW = "https://geoglows-v2.s3-us-west-2.amazonaws.com/transformers/hydroweb.zarr"


@lru_cache(maxsize=1)
def _hw_ids() -> dict:
    from numcodecs import Blosc
    b = requests.get(f"{HW}/river_id/0", timeout=60).content
    ids = np.frombuffer(Blosc().decode(b), dtype="<i8")
    return {int(r): k for k, r in enumerate(ids)}


def levels(i: int, max_km: float = 60.0) -> dict | None:
    """Quota dell'acqua mese per mese (m s.l.m., quantili) dal punto altimetrico Hydroweb
    più vicino sullo stesso fiume, entro max_km lungo la rete."""
    from numcodecs import Blosc
    ix = index()
    if ix["rid"] is None:
        return None
    hw = _hw_ids()
    # candidati: il tratto, la rete a valle e l'asta principale a monte (il ramo col bacino più grande)
    src, st = _upstream_csr()
    c0 = reach_centroid(i)
    if not c0:
        return None
    cand = []
    for seq in (downstream(i, 400), None):
        if seq is None:
            seq = [i]
            while len(seq) < 400:
                ups = src[st[seq[-1]]:st[seq[-1] + 1]]
                if not len(ups):
                    break
                seq.append(int(max(ups, key=lambda u: ix["area"][u])))
        dist = 0.0; prev = c0
        for k in seq:
            c = reach_centroid(k) or prev
            dist += math.hypot((c[1] - prev[1]) * 110.6, (c[0] - prev[0]) * 111.3 * math.cos(math.radians(c[1])))
            prev = c
            if dist > max_km:
                break
            rid = int(ix["rid"][k])
            if rid in hw:
                cand.append((dist, k, hw[rid], c))
                break
    if not cand:
        return None
    dist, k, h, c = min(cand, key=lambda x: x[0])
    b = requests.get(f"{HW}/wse/0.0.{h // 200}", timeout=60).content
    a = np.frombuffer(Blosc().decode(b), dtype="<f8").reshape(12, 101, 200)[:, :, h % 200]
    if not np.isfinite(a).any():
        return None
    f = lambda p: [round(float(x), 2) for x in a[:, p]]  # noqa: E731
    return {"dist_km": round(dist, 1), "pt": c, "area_km2": round(float(ix["area"][k])),
            "high": f(95), "median": f(50), "low": f(5), "min": f(0), "max": f(100),   # quantili: p = % del tempo sotto quel livello
            "source": "GEOGLOWS · Hydroweb (altimetria satellitare)"}
