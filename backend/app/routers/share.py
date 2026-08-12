"""Link pubblico di sola lettura di un progetto.

`POST /api/projects/{id}/share` crea (o riusa) un token opaco per il progetto.
`GET /api/share/{token}` restituisce, senza autenticazione, il nome del progetto
con aree e livelli, così la pagina cliente può disegnare la mappa in sola lettura.
"""
from __future__ import annotations

import json
import secrets

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Area, Project, ProjectLayer, Share

router = APIRouter(prefix="/api", tags=["share"])


@router.post("/projects/{project_id}/share")
def create_share(project_id: int, db: Session = Depends(get_db)):
    p = db.get(Project, project_id)
    if not p:
        raise HTTPException(404, "Progetto non trovato")
    s = db.scalar(select(Share).where(Share.project_id == project_id))
    if not s:
        s = Share(token=secrets.token_urlsafe(9), project_id=project_id)
        db.add(s)
        db.commit()
        db.refresh(s)
    return {"token": s.token}


@router.get("/share/{token}")
def get_share(token: str, db: Session = Depends(get_db)):
    s = db.scalar(select(Share).where(Share.token == token))
    if not s:
        raise HTTPException(404, "Link non valido o revocato")
    p = db.get(Project, s.project_id)
    if not p:
        raise HTTPException(404, "Progetto non trovato")
    areas = db.scalars(select(Area).where(Area.project_id == p.id)).all()
    layers = db.scalars(select(ProjectLayer).where(ProjectLayer.project_id == p.id)).all()
    return {
        "project": {"name": p.name, "crop": p.crop},
        "areas": [
            {
                "id": a.id,
                "parent_area_id": getattr(a, "parent_area_id", None),
                "kind": getattr(a, "kind", None) or "field",
                "name": a.name,
                "geojson": json.loads(a.geojson),
                "area_ha": a.area_ha,
            }
            for a in areas
        ],
        "layers": [
            {"kind": l.kind, "name": l.name, "data": json.loads(l.data)}
            for l in layers
        ],
    }
