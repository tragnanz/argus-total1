"""Endpoint macro-aree di intervento (Milestone 6, Fase 1)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..deps import get_client
from ..schemas import MacroAreasIn, MacroArea

from analysis.macroareas import compute_macroareas

router = APIRouter(prefix="/api/macroareas", tags=["macroareas"])


@router.post("", response_model=list[MacroArea])
def macroareas(body: MacroAreasIn, client=Depends(get_client)):
    params = {
        "weights": body.weights.model_dump(),
        "slope_ideal_pct": body.slope_ideal_pct,
        "slope_max_pct": body.slope_max_pct,
    }
    try:
        rows = compute_macroareas(client, body.geom.model_dump(), body.date, params,
                                  min_suit=body.min_suitability, min_area_ha=body.min_area_ha)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore macro-aree: {e}")
    return rows
