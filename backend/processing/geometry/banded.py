"""Geometria "a bande" in coordinate cartesiane along/cross.

Un unico modello per tutti gli impianti organizzati lungo una direzione
dominante con struttura parallela:

  - linear_move : laterale ad avanzamento frontale
  - hose_reel   : rotolone / irrigatore semovente (traveling gun)
  - drip        : ala gocciolante / manichette

Assi locali:
  u = "along"  → direzione di avanzamento / traino / lungo il laterale.
                 È la dimensione lunga; porta le firme legate a velocità,
                 tempo, fermate, e (per la goccia) alla lunghezza del laterale.
  v = "cross"  → posizione lungo la barra / attraverso le corsie / tra i
                 laterali, con origine nel punto di alimentazione. Porta le
                 firme di ugello, campata, corsia, laterale e gradiente di
                 pressione dal punto di alimentazione.

Nota di risoluzione (goccia): a 10 m si distinguono solo interi laterali o
settori valvola, non il singolo gocciolatore. Il campo `min_feature_note`
lo esplicita per il report.
"""
from __future__ import annotations
import numpy as np
from .base import PlantGeometry, _to_float_profile

_LABELS = {
    "linear_move": "campata/ugello o traccia ruota",
    "hose_reel": "bordo corsia / sovrapposizione tra passate",
    "drip": "laterale o settore valvola",
}
_NOTE = {
    "linear_move": "Scala rilevabile ≥ campata; il singolo ugello è sotto i 10 m.",
    "hose_reel": "Rilevabili corsie e sovrapposizioni; non il singolo irrigatore.",
    "drip": "Rilevabili solo interi laterali o settori valvola; non il gocciolatore.",
}


class BandedGeometry(PlantGeometry):
    def __init__(self, grid, system_type, along_dir_deg, origin_xy,
                 extent_along_m, extent_cross_m, n_along=12, n_cross=12,
                 lane_spacing_m=None, span_lengths=None, feed="end", end_gun=False):
        super().__init__(grid)
        if system_type not in _LABELS:
            raise ValueError(f"system_type non banded: {system_type}")
        self.system_type = system_type
        self.a = np.radians(float(along_dir_deg))
        self.ox, self.oy = origin_xy
        self.extent_along = float(extent_along_m)
        self.extent_cross = float(extent_cross_m)
        self.n_along = int(n_along)
        self.n_cross = int(n_cross)
        self.lane_spacing = lane_spacing_m
        self.span_lengths = span_lengths
        self.feed = feed
        self.end_gun = bool(end_gun)
        ua = np.array([np.cos(self.a), np.sin(self.a)])      # versore avanzamento
        up = np.array([-np.sin(self.a), np.cos(self.a)])     # versore barra
        dx = self.X - self.ox
        dy = self.Y - self.oy
        self.u = dx * ua[0] + dy * ua[1]   # along
        self.v = dx * up[0] + dy * up[1]   # cross

    @property
    def min_feature_note(self):
        return _NOTE[self.system_type]

    def footprint_mask(self):
        return ((self.u >= 0) & (self.u <= self.extent_along) &
                (self.v >= 0) & (self.v <= self.extent_cross))

    def zone_descriptors(self, zone_mask):
        u = self.u[zone_mask]
        v = self.v[zone_mask]
        if u.size == 0:
            return {}
        ea = self.extent_along or 1.0
        ec = self.extent_cross or 1.0
        along_spread = float((u.max() - u.min()) / ea)
        cross_spread = float((v.max() - v.min()) / ec)
        return {
            "cross_pos": round(float(np.mean(v) / ec), 3),
            "along_pos": round(float(np.mean(u) / ea), 3),
            "along_spread": round(along_spread, 3),
            "cross_spread": round(cross_spread, 3),
            "along_track_like": round(along_spread - cross_spread, 3),
        }

    def axes(self):
        cross_edges = np.linspace(0.0, self.extent_cross, self.n_cross + 1)
        along_edges = np.linspace(0.0, self.extent_along, self.n_along + 1)
        return {"cross": (self.v, cross_edges), "along": (self.u, along_edges)}

    def detect_signature(self, agg):
        cp = _to_float_profile(agg["profiles"]["cross"]["mean"])
        ap = _to_float_profile(agg["profiles"]["along"]["mean"])
        out = {"type": "none", "detail": "nessun pattern d'impianto dominante",
               "detail_key": "sig_none", "note": self.min_feature_note}
        if np.all(np.isnan(cp)) or np.all(np.isnan(ap)):
            return out
        cross_dom = np.nanmax(cp) - np.nanmedian(cp)
        along_dom = np.nanmax(ap) - np.nanmedian(ap)
        valid = ~np.isnan(cp)
        grad = (np.corrcoef(np.arange(len(cp))[valid], cp[valid])[0, 1]
                if valid.sum() >= 4 else 0.0)

        if grad > 0.6:
            out.update(type="boom_gradient",
                       detail="ricorrenza crescente lungo la barra dal punto di "
                              "alimentazione (compatibile con perdita di pressione)",
                       detail_key="sig_boom_gradient")
        elif cross_dom > 0.20 and cross_dom >= along_dom and np.nanmax(cp) > 0.40:
            k = int(np.nanargmax(cp))
            if k >= self.n_cross - 1 and self.end_gun:
                out.update(type="end_gun",
                           detail="anomalia all'estremità della barra "
                                  "(compatibile con sbalzo / end gun)",
                           detail_key="sig_end_gun_boom")
            else:
                v_m = agg["profiles"]["cross"]["centers"][k]
                out.update(type="along_track_stripe",
                           detail=f"striscia parallela all'avanzamento a ~{v_m:.0f} m "
                                  f"lungo la barra ({_LABELS[self.system_type]})",
                           detail_key="sig_along_track_stripe",
                           detail_params={"v_m": f"{v_m:.0f}", "sys": self.system_type})
        elif along_dom > 0.20 and np.nanmax(ap) > 0.40:
            k = int(np.nanargmax(ap))
            u_m = agg["profiles"]["along"]["centers"][k]
            out.update(type="cross_track_band",
                       detail=f"banda trasversale a ~{u_m:.0f} m di avanzamento "
                              f"(compatibile con velocità/pressione variabili nel tempo)",
                       detail_key="sig_cross_track_band", detail_params={"u_m": f"{u_m:.0f}"})
        return out
