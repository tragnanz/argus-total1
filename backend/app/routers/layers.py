"""CRUD dei livelli salvati del progetto (canali, pivot, altre strutture).

I livelli sono ri-editabili: il frontend salva geometria/parametri in `data`
(JSON) e li ricarica per rimetterli in modifica sulla mappa."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Project, ProjectLayer
from ..schemas import LayerIn, LayerOut, LayerPatch

router = APIRouter(prefix="/api", tags=["layers"])


def _out(x: ProjectLayer) -> LayerOut:
    return LayerOut(id=x.id, project_id=x.project_id, kind=x.kind, name=x.name,
                    data=json.loads(x.data), created_at=x.created_at)


@router.get("/projects/{project_id}/layers", response_model=list[LayerOut])
def list_layers(project_id: int, db: Session = Depends(get_db)):
    rows = db.scalars(
        select(ProjectLayer).where(ProjectLayer.project_id == project_id)
        .order_by(ProjectLayer.created_at.desc())
    ).all()
    return [_out(x) for x in rows]


@router.post("/layers", response_model=LayerOut, status_code=201)
def create_layer(body: LayerIn, db: Session = Depends(get_db)):
    if not db.get(Project, body.project_id):
        raise HTTPException(400, "Progetto inesistente")
    x = ProjectLayer(project_id=body.project_id, kind=body.kind, name=body.name,
                     data=json.dumps(body.data))
    db.add(x); db.commit(); db.refresh(x)
    return _out(x)


@router.patch("/layers/{layer_id}", response_model=LayerOut)
def update_layer(layer_id: int, body: LayerPatch, db: Session = Depends(get_db)):
    x = db.get(ProjectLayer, layer_id)
    if not x:
        raise HTTPException(404, "Livello non trovato")
    if body.name is not None:
        x.name = body.name
    if body.data is not None:
        x.data = json.dumps(body.data)
    db.commit(); db.refresh(x)
    return _out(x)


@router.delete("/layers/{layer_id}", status_code=204)
def delete_layer(layer_id: int, db: Session = Depends(get_db)):
    x = db.get(ProjectLayer, layer_id)
    if not x:
        raise HTTPException(404, "Livello non trovato")
    db.delete(x); db.commit()
