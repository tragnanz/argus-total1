"""Griglia planare in metri (CRS locale UTM).

Tutte le geometrie lavorano in metri su una griglia fissa allineata all'UTM:
è il vincolo di co-registrazione (stessa griglia per tutti gli anni).
"""
from __future__ import annotations
from dataclasses import dataclass
import numpy as np


@dataclass
class Grid:
    height: int
    width: int
    res_m: float = 10.0
    x0: float = 0.0  # coordinata X dell'angolo in alto a sinistra (m)
    y0: float = 0.0  # coordinata Y dell'angolo in alto a sinistra (m)

    @property
    def shape(self) -> tuple[int, int]:
        return (self.height, self.width)

    def coords(self) -> tuple[np.ndarray, np.ndarray]:
        """Coordinate (in metri) del centro di ogni pixel."""
        cols = np.arange(self.width)
        rows = np.arange(self.height)
        xs = self.x0 + (cols + 0.5) * self.res_m
        ys = self.y0 + (rows + 0.5) * self.res_m
        return np.meshgrid(xs, ys)

    @property
    def pixel_area_ha(self) -> float:
        return (self.res_m ** 2) / 10_000.0
