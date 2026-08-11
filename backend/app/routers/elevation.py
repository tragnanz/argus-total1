"""Endpoint profilo altimetrico su polilinea (strumento di misura dislivelli)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..deps import get_client
from ..schemas import ElevationIn, ElevationOut

from analysis.elevation import sample_elevation

router = APIRouter(prefix="/api/elevation", tags=["elevation"])


@router.post("", response_model=ElevationOut)
def elevation(body: ElevationIn, client=Depends(get_client)):
    try:
        out = sample_elevation(client, body.coords)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore profilo altimetrico: {e}")
    return ElevationOut(**out)
