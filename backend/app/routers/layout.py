"""Endpoint layout automatico dei pivot + dimensionamento idrico (Milestone 3)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..deps import get_client
from ..schemas import LayoutIn, LayoutOut

from analysis.layout import compute_layout

router = APIRouter(prefix="/api/layout", tags=["layout"])


@router.post("", response_model=LayoutOut)
def layout(body: LayoutIn, client=Depends(get_client)):
    params = {
        "config": body.config, "radius_m": body.radius_m, "gap_m": body.gap_m,
        "transport": body.transport,
        "auto_orient": body.auto_orient, "canal_azimuth_deg": body.canal_azimuth_deg,
        "canal_flip": body.canal_flip,
        "only_suitable": body.only_suitable, "min_suitability": body.min_suitability,
        "date": body.date, "overhang_pct": body.overhang_pct,
        "n_phases": body.n_phases, "phase_order": body.phase_order,
        "kc_peak": body.kc_peak, "efficiency": body.efficiency,
        "hours_per_day": body.hours_per_day,
        "roads": body.roads, "clear_road_m": body.clear_road_m,
        "min_pivot_pct": body.min_pivot_pct,
    }
    if body.slope_max_pct is not None:
        params["slope_max_pct"] = body.slope_max_pct
    if body.slope_ideal_pct is not None:
        params["slope_ideal_pct"] = body.slope_ideal_pct
    try:
        out = compute_layout(client, body.geom.model_dump(), params)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore layout: {e}")
    return LayoutOut(**out)
