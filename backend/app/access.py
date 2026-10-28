"""Isolamento per organizzazione dei dati di progetto.

Il middleware `require_login` garantisce solo che l'utente sia autenticato;
qui si verifica che clienti, progetti, aree e livelli appartengano alla SUA
organizzazione. Chi chiede un oggetto di un'altra organizzazione riceve 404
(non 403), così non scopre nemmeno che l'oggetto esiste.

Dati legacy senza organizzazione (cliente o progetto con organization_id NULL e
nessun cliente con organizzazione) restano accessibili a qualunque utente
autenticato, come prima: non c'è modo di sapere a chi appartengano.
"""
from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from .models import Area, Client, Project, ProjectLayer, User


def project_org(p: Project) -> int | None:
    """Organizzazione del progetto: la sua, altrimenti quella del cliente."""
    if getattr(p, "organization_id", None) is not None:
        return p.organization_id
    return p.client.organization_id if p.client else None


def own_client(db: Session, user: User, client_id: int) -> Client:
    c = db.get(Client, client_id)
    if not c or (c.organization_id is not None and c.organization_id != user.organization_id):
        raise HTTPException(404, "Cliente non trovato")
    return c


def own_project(db: Session, user: User, project_id: int) -> Project:
    p = db.get(Project, project_id)
    org = project_org(p) if p else None
    if not p or (org is not None and org != user.organization_id):
        raise HTTPException(404, "Progetto non trovato")
    return p


def own_area(db: Session, user: User, area_id: int) -> Area:
    a = db.get(Area, area_id)
    if not a:
        raise HTTPException(404, "Area non trovata")
    try:
        own_project(db, user, a.project_id)
    except HTTPException:
        raise HTTPException(404, "Area non trovata") from None
    return a


def own_layer(db: Session, user: User, layer_id: int) -> ProjectLayer:
    x = db.get(ProjectLayer, layer_id)
    if not x:
        raise HTTPException(404, "Livello non trovato")
    try:
        own_project(db, user, x.project_id)
    except HTTPException:
        raise HTTPException(404, "Livello non trovato") from None
    return x


def visible_projects_query(user: User):
    """Progetti visibili all'utente: della sua organizzazione, più i legacy senza
    organizzazione (né propria né del cliente)."""
    org = user.organization_id
    return (select(Project).outerjoin(Client, Project.client_id == Client.id)
            .where(or_(Project.organization_id == org,
                       and_(Project.organization_id.is_(None),
                            or_(Client.organization_id == org, Client.organization_id.is_(None))))))
