"""Portate MISURATE alle stazioni idrometriche e correzione di GloFAS.

GloFAS è un modello: sui grandi fiumi regolati o in zona arida può sbagliare di
volte (Nilo a Shendi: ~10.200 m³/s simulati contro ~2.300 osservati). Qui si
usano le medie mensili osservate di stazioni vere sullo stesso fiume per
correggere la cella GloFAS scelta alla presa:

    fattore_mese = Q_osservata_mese(stazione) / Q_GloFAS_mese(cella della stazione)

Fonti (data/river_stations.json, costruito una volta dai dataset originali):
- Dai et al. 2026, Global Downstream River Flows (936 grandi fiumi, stazione
  più a valle; Zenodo 10.5281/zenodo.17379716, CC BY 4.0);
- GRDC, dataset WMO State of Global Water Resources 2025 (~3.000 stazioni,
  1991-2025; Zenodo 10.5281/zenodo.23587317; esclusi i dati con licenza non
  commerciale);
- GSIM, Global Streamflow Indices and Metadata Archive (Do et al. 2018,
  Gudmundsson et al. 2018; ~31.000 stazioni in tutto il mondo; PANGAEA
  10.1594/PANGAEA.887470, CC BY-SA 3.0);
- GRDC / UNH Composite Runoff Fields (stazioni storiche del bacino del Nilo).
In tutto ~25.000 stazioni in 151 paesi, doppioni tolti.

Una stazione vale per la presa solo se la sua cella GloFAS ha una portata
dello stesso ordine di quella della presa (stesso fiume, tratto simile).
"""
from __future__ import annotations

import json
import math
import os
from functools import lru_cache

_PATH = os.path.join(os.path.dirname(__file__), "data", "river_stations.json")
SOURCES = {
    "dai": "Dai et al. 2026 · Global Downstream River Flows (CC BY 4.0)",
    "grdc": "GRDC · WMO State of Global Water Resources 2025",
    "unh": "GRDC · UNH Composite Runoff Fields",
    "gsim": "GSIM · Global Streamflow Indices and Metadata (CC BY-SA 3.0)",
    "kzh": "Kazhydromet (kazhydromet.kz), medie mensili 2015-2023",
}


@lru_cache(maxsize=1)
def stations() -> list[dict]:
    with open(_PATH, encoding="utf-8") as f:
        return json.load(f)


def _dist_km(la1, lo1, la2, lo2) -> float:
    p1, p2 = math.radians(la1), math.radians(la2)
    dp, dl = p2 - p1, math.radians(lo2 - lo1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(min(1.0, a)))


def candidates(lat: float, lon: float, q_ref: float, radius_km: float = 800.0, k: int = 4) -> list[dict]:
    """Stazioni vicine con una portata osservata compatibile con q_ref (GloFAS alla presa).
    Il margine è ampio (1/12 … 3×) perché GloFAS stesso può sbagliare di volte."""
    out = []
    for s in stations():
        if abs(s["lat"] - lat) > radius_km / 100 or s["mean"] <= 0 or (s.get("n", 0) < 10 and s["src"] != "kzh"):   # almeno 10 anni di misure
            continue
        d = _dist_km(lat, lon, s["lat"], s["lon"])
        if d > radius_km or not (q_ref / 12 <= s["mean"] <= q_ref * 3):
            continue
        out.append({**s, "dist_km": round(d, 1)})
    out.sort(key=lambda s: s["dist_km"])
    return out[:k]


def correction(lat: float, lon: float, pick: dict, glofas_fn) -> dict | None:
    """Fattori di correzione per la cella GloFAS `pick` dalla stazione migliore.
    glofas_fn(lat, lon, n) → risultato di river.glofas (celle con statistiche)."""
    q = float(pick.get("mean") or 0)
    if q <= 0:
        return None
    best, failed = None, False
    for s in candidates(lat, lon, q):
        if "sc" in s:                                    # GloFAS della stazione già calcolato (data/)
            cells = [{"lat": c[0], "lon": c[1], "mean": c[2], "month_mean": c[3]} for c in s["sc"]]
        else:
            try:
                cells = glofas_fn(s["lat"], s["lon"], 1 if s["src"] == "unh" else 0).get("cells") or []
            except Exception:  # noqa: BLE001
                failed = True                           # una stazione non letta: meglio nessuna correzione che una sbagliata
                continue
        if not cells:
            continue
        # la cella della stazione: fra quelle attorno, quella più vicina alla portata osservata
        # (a una confluenza le celle dei due rami differiscono di volte: così si prende il ramo giusto)
        sim = min((c for c in cells if c["mean"] > 0), key=lambda c: abs(math.log(c["mean"] / s["mean"])), default=None)
        if sim is None:
            continue
        same = abs(math.log(sim["mean"] / q))           # stesso fiume e tratto simile → ~0
        if same > math.log(3):
            continue
        score = same + s["dist_km"] / 2000.0
        if best is None or score < best[0]:
            best = (score, s, sim)
    if best is None or failed:
        return None
    _, s, sim = best
    clamp = lambda x: max(0.05, min(20.0, x))  # noqa: E731
    f_year = clamp(s["mean"] / sim["mean"])
    f_month = [round(clamp(o / m), 4) if m > 0 else round(f_year, 4) for o, m in zip(s["mm"], sim["month_mean"])]
    return {
        "station": {"id": s["id"], "name": s["station"], "river": s["river"], "country": s["cc"],
                    "lat": s["lat"], "lon": s["lon"], "area_km2": s.get("area"), "years": s["yrs"],
                    "dist_km": s["dist_km"], "source": SOURCES.get(s["src"], s["src"])},
        "obs_mean": s["mean"], "obs_month": s["mm"],
        "sim_mean": sim["mean"], "sim_month": sim["month_mean"], "sim_cell": [sim["lat"], sim["lon"]],
        "ref_mean": q, "f_year": round(f_year, 4), "f_month": f_month,
    }
