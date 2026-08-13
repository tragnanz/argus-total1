"""Endpoint satellitari: scene disponibili, anteprima indici, anteprima DEM.

Riuso diretto del motore di Argus Smart (satellite_export + provider).
"""
from __future__ import annotations

import base64

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..deps import get_client
from ..db import get_db
from ..models import User
from ..security import charge, get_current_user
from ..schemas import (DemIn, PreviewIn, PreviewOut, ScenesIn, SceneOut)

from processing.satellite_export import (list_scenes, preview,
                                         _utm_bbox, _plan_grid, _png_index,
                                         _cmap_stops)

router = APIRouter(prefix="/api/satellite", tags=["satellite"])

DEM_CMAP = "terrain"


@router.post("/scenes", response_model=list[SceneOut])
def scenes(body: ScenesIn, client=Depends(get_client), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    charge(db, user)
    try:
        rows = list_scenes(client, body.geom.model_dump(),
                           months_back=body.months_back, max_cloud=body.max_cloud)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore ricerca scene: {e}")
    return rows


@router.post("/preview", response_model=PreviewOut)
def preview_index(body: PreviewIn, client=Depends(get_client), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    charge(db, user)
    try:
        image, bounds, meta = preview(client, body.geom.model_dump(),
                                      body.index, body.date, normalized=body.normalized)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore anteprima: {e}")
    return PreviewOut(image=image, bounds=bounds, meta=meta)


@router.post("/dem", response_model=PreviewOut)
def preview_dem(body: DemIn, client=Depends(get_client), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Anteprima DEM (quota) sull'area: 1 sola immagine leggera (nessun timeout)."""
    charge(db, user)
    geom = body.geom.model_dump()
    try:
        epsg, minx, miny, maxx, maxy, to_wgs = _utm_bbox(geom)
        res, wp, hp, nx, ny = _plan_grid(minx, miny, maxx, maxy, max_dim=1000, max_tiles=1)
        top = miny + hp * res
        south = top - hp * res
        east = minx + wp * res
        dem = client.fetch_dem([minx, south, east, top], epsg, wp, hp)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore DEM: {e}")

    finite = dem[np.isfinite(dem)]
    if finite.size < 4:
        raise HTTPException(502, "DEM non disponibile per l'area.")
    vmin = float(np.percentile(finite, 2))
    vmax = float(np.percentile(finite, 98))
    if vmax - vmin < 1e-3:
        vmax = vmin + 1.0
    png = _png_index(dem, DEM_CMAP, vmin, vmax)
    image = "data:image/png;base64," + base64.b64encode(png).decode()

    corners = [(minx, south), (east, south), (east, top), (minx, top)]
    lls = [to_wgs.transform(x, y) for x, y in corners]
    lons = [p[0] for p in lls]; lats = [p[1] for p in lls]
    bounds = [[min(lats), min(lons)], [max(lats), max(lons)]]
    meta = {
        "kind": "dem", "res_m": round(res, 1), "grid": f"{nx}×{ny}",
        "elev_min": round(float(np.nanmin(dem)), 1),
        "elev_max": round(float(np.nanmax(dem)), 1),
        "scale": {"cmap": DEM_CMAP, "vmin": round(vmin, 1),
                  "vmax": round(vmax, 1), "colors": _cmap_stops(DEM_CMAP)},
    }
    return PreviewOut(image=image, bounds=bounds, meta=meta)
