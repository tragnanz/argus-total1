"""Endpoint macro-aree di intervento (Milestone 6, Fase 1)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..deps import get_client
from ..db import get_db
from ..models import User
from ..security import charge, get_current_user
from ..schemas import MacroAreasIn, MacroArea

from analysis.macroareas import compute_macroareas

router = APIRouter(prefix="/api/macroareas", tags=["macroareas"])


@router.post("", response_model=list[MacroArea])
def macroareas(body: MacroAreasIn, client=Depends(get_client), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    charge(db, user)
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
