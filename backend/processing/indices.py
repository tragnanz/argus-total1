"""Indici spettrali da bande Sentinel-2 (riflettanza L2A).

Ogni indice: formula, bande, significato agronomico → vedi docs. Le bande a
20 m native (B05, B11) sono ricampionate a 10 m dal provider; il dettaglio
reale resta 20 m.
"""
from __future__ import annotations
import numpy as np

# bande necessarie per calcolare tutti gli indici supportati
REQUIRED_BANDS = ["B02", "B03", "B04", "B05", "B08", "B11"]

SUPPORTED = ["ndvi", "ndre", "ndmi", "msi", "savi", "evi", "gndvi", "ndwi"]


def _ratio(num, den):
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(den != 0, num / den, np.nan)
    return out


def compute_index(name: str, b: dict) -> np.ndarray:
    name = name.lower()
    if name == "ndvi":
        return _ratio(b["B08"] - b["B04"], b["B08"] + b["B04"])
    if name == "ndre":
        return _ratio(b["B08"] - b["B05"], b["B08"] + b["B05"])
    if name == "ndmi":
        return _ratio(b["B08"] - b["B11"], b["B08"] + b["B11"])
    if name == "msi":
        return _ratio(b["B11"], b["B08"])
    if name == "savi":
        L = 0.5
        return _ratio((b["B08"] - b["B04"]) * (1 + L), b["B08"] + b["B04"] + L)
    if name == "evi":
        return 2.5 * _ratio(b["B08"] - b["B04"],
                            b["B08"] + 6 * b["B04"] - 7.5 * b["B02"] + 1)
    if name == "gndvi":
        return _ratio(b["B08"] - b["B03"], b["B08"] + b["B03"])
    if name == "ndwi":  # McFeeters (acqua) — non confondere con NDMI
        return _ratio(b["B03"] - b["B08"], b["B03"] + b["B08"])
    raise ValueError(f"Indice non supportato: {name}. Disponibili: {SUPPORTED}")
