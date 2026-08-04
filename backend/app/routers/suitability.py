"""Endpoint idoneità del terreno (Milestone 2)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..deps import get_client
from ..schemas import SuitabilityIn, SuitabilityOut

from analysis.suitability import compute_suitability

router = APIRouter(prefix="/api/suitability", tags=["suitability"])


@router.post("", response_model=SuitabilityOut)
def suitability(body: SuitabilityIn, client=Depends(get_client)):
    params = {
        "weights": body.weights.model_dump(),
        "slope_ideal_pct": body.slope_ideal_pct,
        "slope_max_pct": body.slope_max_pct,
        "ndvi_min": body.ndvi_min, "ndvi_good": body.ndvi_good,
        "ndmi_min": body.ndmi_min, "ndmi_good": body.ndmi_good,
    }
    try:
        out = compute_suitability(client, body.geom.model_dump(), body.date, params)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore idoneità: {e}")
    return SuitabilityOut(**out)
