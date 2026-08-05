"""Endpoint tracciamento canale principale a gravità (Milestone 6, Fase 2)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..deps import get_client
from ..schemas import CanalIn, CanalOut

from analysis.canal import trace_canal, trace_manual

router = APIRouter(prefix="/api/canal", tags=["canal"])


@router.post("", response_model=CanalOut)
def canal(body: CanalIn, client=Depends(get_client)):
    try:
        if body.manual:
            out = trace_manual(client, body.geom.model_dump(), body.manual,
                               target_permille=body.target_permille)
        else:
            out = trace_canal(
                client, body.geom.model_dump(),
                target_permille=body.target_permille,
                start_ll=body.start, end_ll=body.end, waypoints=body.waypoints,
            )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore tracciamento canale: {e}")
    return CanalOut(**out)
