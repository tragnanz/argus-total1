"""Endpoint leggibilità del terreno: rilievo + isoipse e zona a valle della presa."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..deps import get_client
from ..schemas import ReachIn, ReachOut, TerrainIn, TerrainOut

from analysis.terrain import reachable_region, terrain_readability

router = APIRouter(prefix="/api", tags=["terrain"])


@router.post("/terrain", response_model=TerrainOut)
def terrain(body: TerrainIn, client=Depends(get_client)):
    try:
        out = terrain_readability(client, body.geom.model_dump(), vert_exag=body.vert_exag)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore rilievo terreno: {e}")
    return TerrainOut(**out)


@router.post("/canal/reachable", response_model=ReachOut)
def canal_reachable(body: ReachIn, client=Depends(get_client)):
    try:
        out = reachable_region(client, body.geom.model_dump(), body.start, tol_up_m=body.tol_up_m)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore zona a valle: {e}")
    return ReachOut(**out)
