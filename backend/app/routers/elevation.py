"""Endpoint profilo altimetrico su polilinea (strumento di misura dislivelli)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..deps import get_client
from ..schemas import ElevationIn, ElevationOut

from analysis.elevation import elevation_stats, sample_elevation

router = APIRouter(prefix="/api/elevation", tags=["elevation"])


class GeomIn(BaseModel):
    geom: dict


@router.post("", response_model=ElevationOut)
def elevation(body: ElevationIn, client=Depends(get_client)):
    try:
        out = sample_elevation(client, body.coords)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore profilo altimetrico: {e}")
    return ElevationOut(**out)


@router.post("/stats")
def elevation_stats_ep(body: GeomIn, client=Depends(get_client)):
    try:
        return elevation_stats(client, body.geom)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore quota area: {e}")
