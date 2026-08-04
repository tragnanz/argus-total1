"""Geometria center pivot: coordinate polari (raggio, angolo) attorno al centro."""
from __future__ import annotations
import numpy as np
from .base import PlantGeometry, _to_float_profile


class PivotGeometry(PlantGeometry):
    system_type = "center_pivot"

    def __init__(self, grid, center_xy, radius_m, start_azimuth_deg=0.0,
                 n_rings=10, n_sectors=12, span_lengths=None,
                 overhang_m=0.0, end_gun=False):
        super().__init__(grid)
        self.cx, self.cy = center_xy
        self.radius_m = float(radius_m)
        self.start = float(start_azimuth_deg)
        self.n_rings = int(n_rings)
        self.n_sectors = int(n_sectors)
        self.span_lengths = span_lengths
        self.overhang_m = float(overhang_m)
        self.end_gun = bool(end_gun)
        dx = self.X - self.cx
        dy = self.Y - self.cy
        self.r = np.hypot(dx, dy)
        self.theta = (np.degrees(np.arctan2(dy, dx)) - self.start) % 360.0

    def footprint_mask(self):
        extra = 0.15 * self.radius_m if self.end_gun else 0.0
        return self.r <= (self.radius_m + self.overhang_m + extra)

    def zone_descriptors(self, zone_mask):
        r = self.r[zone_mask]
        if r.size == 0:
            return {}
        elong, axis, (cx, cy) = self._shape(zone_mask)
        rad = np.array([cx - self.cx, cy - self.cy])
        nrm = float(np.linalg.norm(rad))
        align = float(abs(np.dot(axis, rad / nrm))) if nrm > 1e-6 else 0.0
        return {
            "radial_pos": round(float(np.mean(r) / self.radius_m), 3),
            "outside_frac": round(float(np.mean(r > self.radius_m)), 3),
            "elongation": round(elong, 3),
            "radial_alignment": round(align, 3),
            "mean_radius_m": round(float(np.mean(r)), 1),
        }

    def axes(self):
        rmax = self.radius_m + self.overhang_m
        ring_edges = np.linspace(0.0, rmax, self.n_rings + 1)
        sector_edges = np.linspace(0.0, 360.0, self.n_sectors + 1)
        return {"radius": (self.r, ring_edges), "angle": (self.theta, sector_edges)}

    def detect_signature(self, agg):
        rp = _to_float_profile(agg["profiles"]["radius"]["mean"])
        sp = _to_float_profile(agg["profiles"]["angle"]["mean"])
        out = {"type": "none", "detail": "nessun pattern d'impianto dominante", "detail_key": "sig_none"}
        if np.all(np.isnan(rp)) or np.all(np.isnan(sp)):
            return out
        sector_dom = np.nanmax(sp) - np.nanmedian(sp)
        ring_dom = np.nanmax(rp) - np.nanmedian(rp)
        if sector_dom > 0.20 and np.nanmax(sp) > 0.40 and sector_dom >= ring_dom:
            k = int(np.nanargmax(sp))
            deg = agg["profiles"]["angle"]["centers"][k]
            out = {"type": "sector",
                   "detail": f"settore ricorrente ~{deg:.0f}° su tutti i raggi "
                             f"(compatibile con valvola/arco irriguo)",
                   "detail_key": "sig_sector", "detail_params": {"deg": f"{deg:.0f}"}}
        elif ring_dom > 0.10 and np.nanmax(rp) > 0.25:
            k = int(np.nanargmax(rp))
            valid = ~np.isnan(rp)
            corr = (np.corrcoef(np.arange(len(rp))[valid], rp[valid])[0, 1]
                    if valid.sum() >= 4 else 0.0)
            if corr > 0.45:
                out = {"type": "radial_gradient",
                       "detail": "ricorrenza crescente col raggio "
                                 "(compatibile con perdita di pressione / fine impianto)",
                       "detail_key": "sig_radial_gradient"}
            elif k >= self.n_rings - 1:
                out = {"type": "end_gun",
                       "detail": "anomalia all'estremità (compatibile con sbalzo / end gun)",
                       "detail_key": "sig_end_gun_pivot"}
            else:
                r_m = agg["profiles"]["radius"]["centers"][k]
                out = {"type": "ring",
                       "detail": f"anello ricorrente ~{r_m:.0f} m su tutti i settori "
                                 f"(compatibile con campata / pressione)",
                       "detail_key": "sig_ring", "detail_params": {"r_m": f"{r_m:.0f}"}}
        return out
