"""Portata del fiume alla presa (Argus Total — Fonte d'acqua).

Due stime indipendenti, da confrontare:

1. GloFAS (Copernicus, rianalisi giornaliera dal 1984, griglia ~5 km) tramite
   l'API Flood di Open-Meteo. La presa raramente cade proprio sulla cella del
   fiume: si leggono le celle vicine e si restituiscono le candidate, con
   media, magra mese per mese e Q347, così l'utente sceglie quella giusta.
2. Bacino dal DEM: Priority-Flood (riempie le depressioni e dà una direzione di
   deflusso a ogni cella, anche sulle piane), accumulo, sbocco agganciato
   all'alveo vicino alla presa e superficie a monte. Se il bacino tocca il
   bordo della finestra la finestra si allarga; all'ultimo livello resta un
   valore minimo ("troncato").
"""
from __future__ import annotations

import heapq
import math
import threading
import time

import numpy as np
import pyproj
import requests

FLOOD_URL = "https://flood-api.open-meteo.com/v1/flood"
_CACHE: dict = {}
_LOCK = threading.Lock()


def _cache_get(key):
    with _LOCK:
        v = _CACHE.get(key)
        return v[1] if v and time.time() - v[0] < 7 * 86400 else None


def _cache_put(key, val):
    with _LOCK:
        if len(_CACHE) > 200:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[key] = (time.time(), val)


def _stats(times: list[str], vals: list) -> dict | None:
    """Statistiche di una serie giornaliera (m³/s)."""
    by_m: list[list[float]] = [[] for _ in range(12)]
    allv: list[float] = []
    for t, v in zip(times, vals):
        if v is None:
            continue
        m = int(t[5:7]) - 1
        by_m[m].append(float(v)); allv.append(float(v))
    if len(allv) < 365:
        return None
    a = np.array(allv)
    mean = float(a.mean())
    if mean <= 0.005:
        return None
    pct = lambda x, q: float(np.percentile(np.array(x), q)) if x else 0.0  # noqa: E731
    years = sorted({t[:4] for t, v in zip(times, vals) if v is not None})
    return {
        "mean": round(mean, 3),
        "q347": round(pct(allv, 5), 3),                     # superata 347 giorni l'anno
        "min": round(float(a.min()), 3),
        "max": round(float(a.max()), 3),
        "month_mean": [round(float(np.mean(x)), 3) if x else 0.0 for x in by_m],
        "month_q80": [round(pct(x, 20), 3) for x in by_m],   # magra: superata l'80% dei giorni del mese
        "month_min": [round(float(np.min(x)), 3) if x else 0.0 for x in by_m],
        "years": [years[0], years[-1]] if years else [],
        "n_days": len(allv),
    }


def glofas(lat: float, lon: float, n: int = 3, step: float = 0.05,
           start: str = "1994-01-01", end: str = "2023-12-31", timeout: float = 90.0) -> dict:
    """Celle GloFAS attorno alla presa con le loro statistiche (m³/s)."""
    key = ("glofas", round(lat, 3), round(lon, 3), n, start, end)
    hit = _cache_get(key)
    if hit is not None:
        return hit
    la, lo = [], []
    for i in range(-n, n + 1):
        for j in range(-n, n + 1):
            la.append(round(lat + i * step, 4)); lo.append(round(lon + j * step, 4))
    r = requests.get(FLOOD_URL, params={
        "latitude": ",".join(map(str, la)), "longitude": ",".join(map(str, lo)),
        "daily": "river_discharge", "start_date": start, "end_date": end,
    }, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    if isinstance(data, dict):
        data = [data]
    seen: set = set()
    cands = []
    kx = 111.32 * math.cos(math.radians(lat))
    for d in data:
        cl, cn = round(float(d["latitude"]), 4), round(float(d["longitude"]), 4)
        if (cl, cn) in seen:
            continue
        seen.add((cl, cn))
        s = _stats(d["daily"]["time"], d["daily"]["river_discharge"])
        if not s:
            continue
        s.update({"lat": cl, "lon": cn, "dist_km": round(math.hypot((cl - lat) * 110.54, (cn - lon) * kx), 2)})
        cands.append(s)
    # le più portanti prima: il fiume principale vicino alla presa
    cands.sort(key=lambda c: -c["mean"])
    # una cella per tratto: tolte quelle quasi uguali (stesso fiume, celle adiacenti)
    out: list[dict] = []
    for c in cands:
        if any(abs(c["mean"] - o["mean"]) / max(o["mean"], 1e-6) < 0.03 and abs(c["dist_km"] - o["dist_km"]) < 8 for o in out):
            continue
        out.append(c)
        if len(out) >= 8:
            break
    # proposta: la più portante entro ~1,5 celle dalla presa, altrimenti la più vicina con acqua
    near = [c for c in out if c["dist_km"] <= step * 111 * 1.6]
    pick = max(near, key=lambda c: c["mean"]) if near else (min(out, key=lambda c: c["dist_km"]) if out else None)
    res = {"source": "GloFAS v4 · Copernicus EMS (Open-Meteo Flood API)", "period": [start[:4], end[:4]],
           "cells": out, "pick": out.index(pick) if pick else -1}
    _cache_put(key, res)
    return res


# ---------------------------------------------------------------- bacino dal DEM
_NB = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]


def _priority_flood(dem: np.ndarray):
    """Ricevente di ogni cella (indice lineare, -1 sul bordo) e ordine di visita."""
    hp, wp = dem.shape
    z = dem.ravel().copy()
    n = hp * wp
    rec = np.full(n, -1, dtype=np.int64)
    seen = np.zeros(n, dtype=bool)
    heap: list = []
    cnt = 0
    for r in range(hp):
        for c in (0, wp - 1) if wp > 1 else (0,):
            i = r * wp + c
            if not seen[i]:
                seen[i] = True; heapq.heappush(heap, (z[i], cnt, i)); cnt += 1
    for c in range(1, wp - 1):
        for r in (0, hp - 1) if hp > 1 else (0,):
            i = r * wp + c
            if not seen[i]:
                seen[i] = True; heapq.heappush(heap, (z[i], cnt, i)); cnt += 1
    order = np.empty(n, dtype=np.int64); k = 0
    while heap:
        zc, _, i = heapq.heappop(heap)
        order[k] = i; k += 1
        r, c = divmod(i, wp)
        for dr, dc in _NB:
            rr, cc = r + dr, c + dc
            if 0 <= rr < hp and 0 <= cc < wp:
                j = rr * wp + cc
                if not seen[j]:
                    seen[j] = True
                    rec[j] = i
                    if z[j] < zc:
                        z[j] = zc                      # depressione riempita
                    heapq.heappush(heap, (z[j], cnt, j)); cnt += 1
    return rec, order[:k]


def _window(client, lon: float, lat: float, half_m: float, px: int):
    epsg = 32600 + int((lon + 180) // 6) + 1 + (0 if lat >= 0 else 100)
    to_utm = pyproj.Transformer.from_crs(4326, epsg, always_xy=True)
    to_wgs = pyproj.Transformer.from_crs(epsg, 4326, always_xy=True)
    x0, y0 = to_utm.transform(lon, lat)
    res = 2 * half_m / px
    minx, miny, maxx, maxy = x0 - half_m, y0 - half_m, x0 + half_m, y0 + half_m
    inst = "COPERNICUS_30" if res < 60 else "COPERNICUS_90"
    try:
        dem = client.fetch_dem([minx, miny, maxx, maxy], epsg, px, px, dem_instance=inst)
    except TypeError:
        dem = client.fetch_dem([minx, miny, maxx, maxy], epsg, px, px)
    dem = np.asarray(dem, dtype="float64")
    if not np.isfinite(dem).any():
        raise RuntimeError("DEM non disponibile")
    dem = np.where(np.isfinite(dem), dem, np.nanmin(dem))
    return dem, dict(minx=minx, maxy=maxy, res=res, to_wgs=to_wgs, x0=x0, y0=y0)


def basin(client, lon: float, lat: float, snap_m: float = 1000.0) -> dict:
    """Bacino che drena fino alla presa (superficie km², sbocco, contorno)."""
    key = ("basin", round(lat, 4), round(lon, 4))
    hit = _cache_get(key)
    if hit is not None:
        return hit
    levels = [(6000.0, 400), (20000.0, 400), (60000.0, 400)]
    out = None
    for li, (half, px) in enumerate(levels):
        dem, g = _window(client, lon, lat, half, px)
        hp, wp = dem.shape
        rec, order = _priority_flood(dem)
        acc = np.ones(hp * wp)
        for i in order[::-1]:
            j = rec[i]
            if j >= 0:
                acc[j] += acc[i]
        # sbocco: la cella con più bacino entro snap_m dalla presa (l'alveo)
        res = g["res"]
        rc, cc = hp // 2, wp // 2
        rad = max(2, int(round(snap_m / res)))
        r0, r1, c0, c1 = max(0, rc - rad), min(hp, rc + rad + 1), max(0, cc - rad), min(wp, cc + rad + 1)
        sub = acc.reshape(hp, wp)[r0:r1, c0:c1]
        rr, cc2 = np.unravel_index(int(np.argmax(sub)), sub.shape)
        outlet = (r0 + rr) * wp + (c0 + cc2)
        inb = np.zeros(hp * wp, dtype=bool)
        inb[outlet] = True
        for i in order:
            j = rec[i]
            if j >= 0 and inb[j]:
                inb[i] = True
        m = inb.reshape(hp, wp)
        touches = bool(m[0, :].any() or m[-1, :].any() or m[:, 0].any() or m[:, -1].any())
        area_km2 = float(m.sum()) * res * res / 1e6
        orow, ocol = divmod(outlet, wp)
        ox, oy = g["minx"] + (ocol + 0.5) * res, g["maxy"] - (orow + 0.5) * res
        olon, olat = g["to_wgs"].transform(ox, oy)
        zb = dem[m]
        # contorno (per la mappa)
        ring: list = []
        try:
            from skimage.measure import find_contours
            cs = find_contours(np.pad(m.astype(float), 1), 0.5)
            if cs:
                cbig = max(cs, key=len)
                stepc = max(1, len(cbig) // 400)
                for (yy, xx) in cbig[::stepc]:
                    x = g["minx"] + (xx - 1 + 0.5) * res; y = g["maxy"] - (yy - 1 + 0.5) * res
                    ring.append([round(v, 6) for v in g["to_wgs"].transform(x, y)])
                if ring and ring[0] != ring[-1]:
                    ring.append(ring[0])
        except Exception:  # noqa: BLE001
            ring = []
        out = {"area_km2": round(area_km2, 2), "truncated": touches and li == len(levels) - 1,
               "outlet": [round(olon, 6), round(olat, 6)], "res_m": round(res, 1),
               "z_outlet": round(float(dem[orow, ocol]), 1), "z_max": round(float(zb.max()), 1) if zb.size else None,
               "z_mean": round(float(zb.mean()), 1) if zb.size else None, "ring": ring}
        if not touches:
            break
    _cache_put(key, out)
    return out
