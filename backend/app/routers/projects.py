"""CRUD gerarchia Cliente → Progetto → Area di progetto."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Area, Client, Project, User
from ..security import get_current_user
from ..access import own_area, own_client, own_project, visible_projects_query
from ..schemas import (AreaIn, AreaOut, AreaPatch, ClientIn, ClientOut,
                       ClientPatch, ProjectIn, ProjectOut, ProjectPatch)

router = APIRouter(prefix="/api", tags=["projects"])


def _area_out(a: Area) -> AreaOut:
    return AreaOut(
        id=a.id, project_id=a.project_id,
        parent_area_id=getattr(a, "parent_area_id", None),
        kind=getattr(a, "kind", None) or "field",
        name=a.name,
        geojson=json.loads(a.geojson), area_ha=a.area_ha, created_at=a.created_at)


# ---------------- Clienti ----------------
@router.get("/clients", response_model=list[ClientOut])
def list_clients(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    # Isolamento per organizzazione: ogni utente vede solo i clienti della propria org.
    return db.scalars(
        select(Client).where(Client.organization_id == user.organization_id).order_by(Client.name)
    ).all()


@router.post("/clients", response_model=ClientOut, status_code=201)
def create_client(body: ClientIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    c = Client(name=body.name, notes=body.notes, organization_id=user.organization_id)
    db.add(c); db.commit(); db.refresh(c)
    return c


@router.patch("/clients/{client_id}", response_model=ClientOut)
def update_client(client_id: int, body: ClientPatch, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    c = own_client(db, user, client_id)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(c, k, v)
    db.commit(); db.refresh(c)
    return c


@router.delete("/clients/{client_id}", status_code=204)
def delete_client(client_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    # Solo clienti della propria organizzazione: la cancellazione elimina a
    # cascata tutti i suoi progetti.
    c = own_client(db, user, client_id)
    db.delete(c); db.commit()


# ---------------- Progetti ----------------
@router.get("/projects", response_model=list[ProjectOut])
def list_projects(client_id: int | None = None, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = visible_projects_query(user).order_by(Project.created_at.desc())
    if client_id is not None:
        own_client(db, user, client_id)
        q = q.where(Project.client_id == client_id)
    return db.scalars(q).all()


@router.post("/projects", response_model=ProjectOut, status_code=201)
def create_project(body: ProjectIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if body.client_id is not None:
        try:
            own_client(db, user, body.client_id)
        except HTTPException:
            raise HTTPException(400, "Cliente inesistente") from None
    p = Project(name=body.name, client_id=body.client_id, organization_id=user.organization_id,
                description=body.description, crop=body.crop)
    db.add(p); db.commit(); db.refresh(p)
    return p


@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = own_project(db, user, project_id)
    return p


def project_settings(p: Project) -> dict:
    return dict(p.settings)


@router.patch("/projects/{project_id}", response_model=ProjectOut)
def update_project(project_id: int, body: ProjectPatch, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = own_project(db, user, project_id)
    data = body.model_dump(exclude_unset=True)
    if data.get("client_id") is not None:
        try:
            own_client(db, user, data["client_id"])
        except HTTPException:
            raise HTTPException(400, "Cliente inesistente") from None
    patch_settings = data.pop("settings", None)
    for k, v in data.items():
        setattr(p, k, v)
    if patch_settings is not None:
        cur = project_settings(p)
        for k, v in patch_settings.items():
            if v is None:
                cur.pop(k, None)
            else:
                cur[k] = v
        raw = json.dumps(cur, ensure_ascii=False)
        if len(raw) > 200_000:
            raise HTTPException(413, "Impostazioni di progetto troppo grandi")
        p.settings_json = raw
    db.commit(); db.refresh(p)
    return p


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = own_project(db, user, project_id)
    db.delete(p); db.commit()


# ---------------- Aree di progetto ----------------
@router.get("/projects/{project_id}/areas", response_model=list[AreaOut])
def list_areas(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    own_project(db, user, project_id)
    rows = db.scalars(
        select(Area).where(Area.project_id == project_id).order_by(Area.created_at.desc())
    ).all()
    return [_area_out(a) for a in rows]


@router.post("/areas", response_model=AreaOut, status_code=201)
def create_area(body: AreaIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    try:
        own_project(db, user, body.project_id)
    except HTTPException:
        raise HTTPException(400, "Progetto inesistente") from None
    if body.parent_area_id is not None:
        parent = db.get(Area, body.parent_area_id)
        if not parent or parent.project_id != body.project_id:
            raise HTTPException(400, "Area padre inesistente o di un altro progetto")
    a = Area(project_id=body.project_id, name=body.name,
             geojson=body.geojson.model_dump_json(), area_ha=body.area_ha,
             parent_area_id=body.parent_area_id, kind=body.kind or "field")
    db.add(a); db.commit(); db.refresh(a)
    return _area_out(a)


@router.get("/areas/{area_id}", response_model=AreaOut)
def get_area(area_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    a = own_area(db, user, area_id)
    return _area_out(a)


@router.patch("/areas/{area_id}", response_model=AreaOut)
def update_area(area_id: int, body: AreaPatch, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    a = own_area(db, user, area_id)
    data = body.model_dump(exclude_unset=True)
    if "name" in data:
        a.name = data["name"]
    if "area_ha" in data:
        a.area_ha = data["area_ha"]
    if body.geojson is not None:
        a.geojson = body.geojson.model_dump_json()
    db.commit(); db.refresh(a)
    return _area_out(a)


@router.delete("/areas/{area_id}", status_code=204)
def delete_area(area_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    a = own_area(db, user, area_id)
    # elimina anche le eventuali sotto-aree (il FK cascade non è garantito su
    # tutti i backend, es. SQLite senza PRAGMA foreign_keys).
    for child in db.scalars(select(Area).where(Area.parent_area_id == area_id)).all():
        db.delete(child)
    db.delete(a); db.commit()
