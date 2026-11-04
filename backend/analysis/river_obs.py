"""Archivio delle portate MISURATE alle stazioni idrometriche (medie mensili).

Serve a correggere il modello GEOGLOWS sullo stesso fiume (analysis/geoglows.py):
i modelli globali sui grandi fiumi regolati o in zona arida possono sbagliare di
volte (Nilo a Shendi: ~14.800 m³/s simulati contro ~2.300 osservati).

Fonti (data/river_stations.json, costruito una volta dai dataset originali):
- Dai et al. 2026, Global Downstream River Flows (936 grandi fiumi, stazione
  più a valle; Zenodo 10.5281/zenodo.17379716, CC BY 4.0);
- GRDC, dataset WMO State of Global Water Resources 2025 (~3.000 stazioni,
  1991-2025; Zenodo 10.5281/zenodo.23587317; esclusi i dati con licenza non
  commerciale);
- GSIM, Global Streamflow Indices and Metadata Archive (Do et al. 2018,
  Gudmundsson et al. 2018; ~31.000 stazioni in tutto il mondo; PANGAEA
  10.1594/PANGAEA.887470, CC BY-SA 3.0);
- GRDC / UNH Composite Runoff Fields (stazioni storiche del bacino del Nilo);
- Kazhydromet (Ili a Konaev, 2015-2023).
In tutto ~25.000 stazioni in 151 paesi, doppioni tolti.
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


def usable(s: dict) -> bool:
    """Stazione utilizzabile: portata positiva e almeno 10 anni di misure (Kazhydromet: serie recente ufficiale)."""
    return s["mean"] > 0 and (s.get("n", 0) >= 10 or s["src"] == "kzh")


def _dist_km(la1, lo1, la2, lo2) -> float:
    p1, p2 = math.radians(la1), math.radians(la2)
    dp, dl = p2 - p1, math.radians(lo2 - lo1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(min(1.0, a)))
