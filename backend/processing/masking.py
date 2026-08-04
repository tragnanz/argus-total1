"""Cloud/quality masking dalla Scene Classification Layer (SCL) di Sentinel-2 L2A.

Classi SCL escluse: 0 no-data, 1 saturato/difettoso, 3 ombra nuvole,
6 acqua, 8 nuvole (prob. media), 9 nuvole (prob. alta), 10 cirrus, 11 neve.
Restano valide: 4 vegetazione, 5 suolo nudo, 7 non-classificato.
"""
from __future__ import annotations
import numpy as np

SCL_INVALID = {0, 1, 3, 6, 8, 9, 10, 11}


def scl_valid_mask(scl: np.ndarray) -> np.ndarray:
    cls = np.rint(scl).astype(int)
    return ~np.isin(cls, list(SCL_INVALID))


def valid_fraction(valid: np.ndarray, field_mask: np.ndarray) -> float:
    denom = int(field_mask.sum())
    if denom == 0:
        return 0.0
    return float((valid & field_mask).sum()) / denom
