"""Endpoint leggibilità del terreno: rilievo + isoipse e zona a valle della presa."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..deps import get_client
from ..schemas import ReachIn, ReachOut, TerrainIn, TerrainOut, WaterIn, WaterOut

from analysis.terrain import detect_watercourses, reachable_region, terrain_readability

router = APIRouter(prefix="/api", tags=["terrain"])


@router.post("/terrain", response_model=TerrainOut)
def terrain(body: TerrainIn, client=Depends(get_client)):
    try:
        out = terrain_readability(client, body.geom.model_dump(), vert_exag=body.vert_exag,
                                  interval_m=body.interval_m)
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


@router.post("/watercourses", response_model=WaterOut)
def watercourses(body: WaterIn, client=Depends(get_client)):
    try:
        out = detect_watercourses(client, body.geom.model_dump(), body.date,
                                  min_area_ha=body.min_area_ha, ndwi_thr=body.ndwi_thr,
                                  use_dem=body.use_dem, dem_channel_ha=body.dem_channel_ha,
                                  dem_depth_m=body.dem_depth_m)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore rilevamento corsi d'acqua: {e}")
    return WaterOut(**out)
