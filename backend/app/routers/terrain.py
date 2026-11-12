"""Endpoint leggibilità del terreno: rilievo + isoipse e zona a valle della presa."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..deps import get_client
from ..db import get_db
from ..models import User
from ..security import charge, get_current_user
from ..schemas import ReachIn, ReachOut, TerrainIn, TerrainOut, WaterIn, WaterOut

from analysis.terrain import detect_watercourses, reachable_region, terrain_readability

router = APIRouter(prefix="/api", tags=["terrain"])


@router.post("/terrain", response_model=TerrainOut)
def terrain(body: TerrainIn, client=Depends(get_client), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    charge(db, user)
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
def watercourses(body: WaterIn, client=Depends(get_client), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    charge(db, user)
    try:
        out = detect_watercourses(client, body.geom.model_dump(), body.date,
                                  min_area_ha=body.min_area_ha, ndwi_thr=body.ndwi_thr,
                                  use_dem=body.use_dem, dem_channel_ha=body.dem_channel_ha,
                                  dem_depth_m=body.dem_depth_m, sens=body.sens, months=body.months, osm=body.osm)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore rilevamento corsi d'acqua: {e}")
    return WaterOut(**out)


@router.post("/watercourses/osm")
def watercourses_osm(body: WaterIn, user: User = Depends(get_current_user)):
    """Anteprima rapida dei corsi d'acqua da OpenStreetMap (pochi secondi), mentre il
    rilevamento completo legge le immagini Sentinel-2."""
    from analysis.osm_tiles import courses_in_polygon
    import requests
    try:
        return courses_in_polygon(body.geom.model_dump())
    except requests.RequestException as e:
        raise HTTPException(502, f"Importazione topografica: servizio cartografico non raggiungibile ({str(e)[:120]})")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Importazione topografica non riuscita: {str(e)[:160]}")


@router.post("/terraform/termites")
def terraform_termites(body: WaterIn, client=Depends(get_client), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Problemi del terreno per origine da Sentinel-2 (ultimi 12 mesi): termitai, aree saline,
    ristagni stagionali, alberi e arbusti, acqua permanente."""
    from analysis.termites import detect_termites
    charge(db, user)
    try:
        return detect_termites(client, body.geom.model_dump(), body.date, sens=body.sens)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore rilevamento problemi del terreno: {e}")
