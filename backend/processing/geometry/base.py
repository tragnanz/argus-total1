"""Interfaccia comune delle geometrie d'impianto."""
from __future__ import annotations
from abc import ABC, abstractmethod
import numpy as np


def _to_float_profile(seq):
    return np.array([np.nan if v is None else v for v in seq], dtype=float)


def _profile(values, mask, axis_vals, edges):
    """Media dei valori nei bin definiti su `axis_vals`."""
    idx = np.digitize(axis_vals, edges) - 1
    n = len(edges) - 1
    mean = np.full(n, np.nan)
    count = np.zeros(n, dtype=int)
    v = values[mask]
    a = idx[mask]
    for b in range(n):
        sel = a == b
        count[b] = int(sel.sum())
        if count[b] > 0:
            mean[b] = float(np.nanmean(v[sel]))
    centers = 0.5 * (edges[:-1] + edges[1:])
    return centers, mean, count


class PlantGeometry(ABC):
    """Converte i pixel nelle coordinate proprie dell'impianto e aggrega.

    Le sottoclassi definiscono `axes()` (assi locali continui + bin) e
    `detect_signature()` (interpretazione del pattern). `aggregate()` è comune.
    """
    system_type = "generic"

    def __init__(self, grid):
        self.grid = grid
        self.X, self.Y = grid.coords()

    @abstractmethod
    def axes(self) -> dict:
        """dict nome_asse -> (array_valori_pixel, edges_bin). Ordine significativo:
        i primi due assi formano la heatmap 2D."""

    @abstractmethod
    def detect_signature(self, agg: dict) -> dict:
        """Interpreta i profili aggregati e restituisce {'type':..., 'detail':...}."""

    def footprint_mask(self) -> np.ndarray | None:
        """Maschera opzionale dell'area effettivamente servita dall'impianto."""
        return None

    def zone_descriptors(self, zone_mask: np.ndarray) -> dict:
        """Descrittori geometrici di una zona rispetto all'impianto
        (posizione, forma). Serve alla separazione delle cause."""
        return {}

    def _shape(self, zone_mask):
        """Elongazione (0=tondeggiante, 1=lineare) e asse principale in metri."""
        xs = self.X[zone_mask]
        ys = self.Y[zone_mask]
        cx, cy = float(xs.mean()), float(ys.mean())
        if xs.size <= 2:
            return 0.0, np.array([1.0, 0.0]), (cx, cy)
        cov = np.cov(np.vstack([xs - cx, ys - cy]))
        w, v = np.linalg.eigh(cov)
        order = np.argsort(w)[::-1]
        w = w[order]
        axis = v[:, order][:, 0]
        elong = float(1.0 - (w[1] / w[0])) if w[0] > 1e-9 else 0.0
        return elong, axis, (cx, cy)

    def aggregate(self, values: np.ndarray, mask: np.ndarray) -> dict:
        axes = self.axes()
        agg: dict = {"system_type": self.system_type, "profiles": {}}
        for name, (arr, edges) in axes.items():
            c, m, cnt = _profile(values, mask, arr, edges)
            agg["profiles"][name] = {
                "centers": c.tolist(),
                "mean": [None if np.isnan(x) else round(float(x), 4) for x in m],
                "count": cnt.tolist(),
            }
        names = list(axes.keys())
        if len(names) >= 2:
            (a1, e1) = axes[names[0]]
            (a2, e2) = axes[names[1]]
            Z = self._heatmap(values, mask, a1, e1, a2, e2)
            agg["heatmap"] = {
                "axis0": names[0], "axis1": names[1],
                "edges0": e1.tolist(), "edges1": e2.tolist(),
                "z": [[None if np.isnan(x) else round(float(x), 4) for x in row] for row in Z],
            }
        agg["signature"] = self.detect_signature(agg)
        return agg

    @staticmethod
    def _heatmap(values, mask, a1, e1, a2, e2):
        i1 = np.digitize(a1, e1) - 1
        i2 = np.digitize(a2, e2) - 1
        n1, n2 = len(e1) - 1, len(e2) - 1
        Z = np.full((n1, n2), np.nan)
        v = values[mask]; x = i1[mask]; y = i2[mask]
        for b1 in range(n1):
            xb = x == b1
            for b2 in range(n2):
                sel = xb & (y == b2)
                if sel.any():
                    Z[b1, b2] = float(np.nanmean(v[sel]))
        return Z


def build_geometry(grid, config: dict) -> PlantGeometry:
    """Factory: istanzia la geometria giusta dal tipo di impianto.

    config['type'] ∈ {center_pivot, linear_move, hose_reel, drip}.
    """
    from .pivot import PivotGeometry
    from .banded import BandedGeometry

    t = config["type"]
    if t == "center_pivot":
        return PivotGeometry(grid, **{k: v for k, v in config.items() if k != "type"})
    if t in ("linear_move", "hose_reel", "drip"):
        return BandedGeometry(grid, system_type=t,
                              **{k: v for k, v in config.items() if k != "type"})
    raise ValueError(f"Tipo impianto non supportato: {t}")
