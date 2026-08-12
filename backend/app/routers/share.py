"""Link pubblici di sola lettura di un progetto.

Ogni progetto può avere PIÙ link, ognuno con la propria configurazione di
visibilità (quali campi/aree e gruppi di pivot mostrare). Così si possono far
vedere a clienti diversi viste diverse dello stesso impianto.

- POST   /api/projects/{id}/shares  → crea un nuovo link (nome + config)
- GET    /api/projects/{id}/shares  → elenca i link del progetto
- DELETE /api/shares/{token}        → elimina un link
- GET    /api/share/{token}         → dati pubblici (progetto + aree + layer + config)
"""
from __future__ import annotations

import json
import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Area, Project, ProjectLayer, Share, ShareView

router = APIRouter(prefix="/api", tags=["share"])


class ShareIn(BaseModel):
    name: str | None = None
    # eslint: config di visibilità del link (hiddenFields/hiddenPivots per id area)
    config: dict | None = None


class ShareOut(BaseModel):
    token: str
    name: str
    created_at: str | None = None


# ---- Compat: singolo link legacy (una tantum per progetto) ----
@router.post("/projects/{project_id}/share")
def create_share_legacy(project_id: int, db: Session = Depends(get_db)):
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


# ---- Link multipli con configurazione di visibilità ----
@router.post("/projects/{project_id}/shares", response_model=ShareOut)
def create_share(project_id: int, body: ShareIn, db: Session = Depends(get_db)):
    p = db.get(Project, project_id)
    if not p:
        raise HTTPException(404, "Progetto non trovato")
    name = (body.name or "").strip() or "Vista"
    sv = ShareView(
        token=secrets.token_urlsafe(9), project_id=project_id,
        name=name[:200], config=json.dumps(body.config or {}),
    )
    db.add(sv)
    db.commit()
    db.refresh(sv)
    return ShareOut(token=sv.token, name=sv.name, created_at=sv.created_at.isoformat() if sv.created_at else None)


@router.get("/projects/{project_id}/shares", response_model=list[ShareOut])
def list_shares(project_id: int, db: Session = Depends(get_db)):
    rows = db.scalars(
        select(ShareView).where(ShareView.project_id == project_id)
        .order_by(ShareView.created_at.desc())
    ).all()
    return [ShareOut(token=x.token, name=x.name, created_at=x.created_at.isoformat() if x.created_at else None) for x in rows]


@router.delete("/shares/{token}", status_code=204)
def delete_share(token: str, db: Session = Depends(get_db)):
    sv = db.scalar(select(ShareView).where(ShareView.token == token))
    if sv:
        db.delete(sv)
        db.commit()


@router.get("/share/{token}")
def get_share(token: str, db: Session = Depends(get_db)):
    # cerca prima tra i link multipli (con config), poi tra i legacy
    sv = db.scalar(select(ShareView).where(ShareView.token == token))
    config = None
    project_id = None
    if sv:
        project_id = sv.project_id
        try:
            config = json.loads(sv.config) if sv.config else {}
        except Exception:  # noqa: BLE001
            config = {}
    else:
        s = db.scalar(select(Share).where(Share.token == token))
        if not s:
            raise HTTPException(404, "Link non valido o revocato")
        project_id = s.project_id

    p = db.get(Project, project_id)
    if not p:
        raise HTTPException(404, "Progetto non trovato")
    areas = db.scalars(select(Area).where(Area.project_id == p.id)).all()
    layers = db.scalars(select(ProjectLayer).where(ProjectLayer.project_id == p.id)).all()
    return {
        "project": {"name": p.name, "crop": p.crop},
        "config": config,
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
