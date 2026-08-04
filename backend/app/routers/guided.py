"""Endpoint pivot lungo il canale + connessioni (Milestone 6, Fase 3)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..deps import get_client
from ..schemas import GuidedIn, GuidedOut

from analysis.guided import design_pivots

router = APIRouter(prefix="/api/guided", tags=["guided"])


@router.post("", response_model=GuidedOut)
def guided(body: GuidedIn, client=Depends(get_client)):
    params = {
        "target_permille": body.target_permille, "radius_m": body.radius_m,
        "gap_m": body.gap_m, "per_side": body.per_side,
        "conn_max_permille": body.conn_max_permille, "fill": body.fill,
    }
    try:
        out = design_pivots(client, body.geom.model_dump(), params)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore progettazione guidata: {e}")
    return GuidedOut(**out)
