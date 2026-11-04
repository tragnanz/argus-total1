"""Suolo del sito da SoilGrids (ISRIC, 250 m): sabbia, limo, argilla e sostanza organica
negli strati 0-5, 5-15 e 15-30 cm, media pesata sugli spessori. Classe tessiturale USDA,
capacità di campo e punto di appassimento con le equazioni di Saxton (come Nereus pag. 18),
acqua disponibile (TAW, mm per metro di suolo) e infiltrazione di base tipica della classe."""
from __future__ import annotations

import math
import threading
import time

import requests

URL = "https://rest.isric.org/soilgrids/v2.0/properties/query"
_CACHE: dict = {}
_LOCK = threading.Lock()

# classe USDA → chiave del suolo in Argus (tabella SOILS del frontend) e infiltrazione di base (mm/h)
CLASS_KEY = {
    "sand": ("sabbioso", 30), "loamy sand": ("sabbioso", 25), "sandy loam": ("franco_sabbioso", 20),
    "loam": ("franco", 12), "silt loam": ("franco_limoso", 8), "silt": ("franco_limoso", 7),
    "sandy clay loam": ("franco_argilloso", 6), "clay loam": ("franco_argilloso", 4), "silty clay loam": ("franco_argilloso", 4),
    "sandy clay": ("argilloso", 3), "silty clay": ("argilloso", 2), "clay": ("argilloso", 2),
}


def usda_class(sand: float, silt: float, clay: float) -> str:
    """Triangolo tessiturale USDA (percentuali)."""
    if silt + 1.5 * clay < 15:
        return "sand"
    if silt + 1.5 * clay >= 15 and silt + 2 * clay < 30:
        return "loamy sand"
    if (7 <= clay < 20 and sand > 52 and silt + 2 * clay >= 30) or (clay < 7 and silt < 50 and silt + 2 * clay >= 30):
        return "sandy loam"
    if 7 <= clay < 27 and 28 <= silt < 50 and sand <= 52:
        return "loam"
    if (silt >= 50 and 12 <= clay < 27) or (50 <= silt < 80 and clay < 12):
        return "silt loam"
    if silt >= 80 and clay < 12:
        return "silt"
    if 20 <= clay < 35 and silt < 28 and sand > 45:
        return "sandy clay loam"
    if 27 <= clay < 40 and 20 < sand <= 45:
        return "clay loam"
    if 27 <= clay < 40 and sand <= 20:
        return "silty clay loam"
    if clay >= 35 and sand > 45:
        return "sandy clay"
    if clay >= 40 and silt >= 40:
        return "silty clay"
    return "clay"


def saxton(sand: float, clay: float) -> dict:
    """Saxton et al. (1986): contenuti d'acqua (m³/m³) a -33 e -1500 kPa."""
    s, c = max(5.0, min(95.0, sand)), max(5.0, min(60.0, clay))
    a = math.exp(-4.396 - 0.0715 * c - 4.88e-4 * s * s - 4.285e-5 * s * s * c) * 100
    b = -3.14 - 0.00222 * c * c - 3.484e-5 * s * s * c
    th = lambda psi: (psi / a) ** (1 / b)  # noqa: E731
    fc, wp = th(33.0), th(1500.0)
    return {"fc": fc, "wp": wp, "taw_mm_m": (fc - wp) * 1000}


def soil_at(lat: float, lon: float, timeout: float = 30.0) -> dict:
    key = (round(lat, 3), round(lon, 3))
    with _LOCK:
        hit = _CACHE.get(key)
        if hit and time.time() - hit[0] < 30 * 86400:
            return hit[1]
    params = [("lon", f"{lon:.5f}"), ("lat", f"{lat:.5f}"), ("value", "mean")]
    params += [("property", p) for p in ("sand", "silt", "clay", "soc")]
    params += [("depth", d) for d in ("0-5cm", "5-15cm", "15-30cm")]
    last: Exception | None = None
    for _ in range(2):                                  # SoilGrids a volte non risponde al primo colpo
        try:
            r = requests.get(URL, params=params, timeout=timeout)
            r.raise_for_status()
            break
        except Exception as e:  # noqa: BLE001
            last = e
    else:
        raise last or RuntimeError("SoilGrids")
    w = {"0-5cm": 5, "5-15cm": 10, "15-30cm": 15}
    vals: dict[str, float] = {}
    for layer in r.json()["properties"]["layers"]:
        num = den = 0.0
        for d in layer["depths"]:
            v = d["values"].get("mean")
            if v is None:
                continue
            num += float(v) / float(layer["unit_measure"]["d_factor"]) * w.get(d["label"], 0)
            den += w.get(d["label"], 0)
        if den:
            vals[layer["name"]] = num / den
    if not all(k in vals for k in ("sand", "silt", "clay")):
        raise ValueError("SoilGrids non ha dati per questo punto (acqua, roccia o area urbana).")
    tot = vals["sand"] + vals["silt"] + vals["clay"]
    sand, silt, clay = (vals[k] * 100 / tot for k in ("sand", "silt", "clay"))
    cls = usda_class(sand, silt, clay)
    k, inf = CLASS_KEY[cls]
    sx = saxton(sand, clay)
    out = {"sand": round(sand, 1), "silt": round(silt, 1), "clay": round(clay, 1), "soc_gkg": round(vals.get("soc", 0), 1),
           "usda": cls, "key": k, "inf_mmh": inf, "fc": round(sx["fc"], 3), "wp": round(sx["wp"], 3),
           "taw_mm_m": round(sx["taw_mm_m"]), "source": "SoilGrids 2.0 (ISRIC), 0-30 cm"}
    with _LOCK:
        if len(_CACHE) > 500:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[key] = (time.time(), out)
    return out
