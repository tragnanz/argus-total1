"""Link pubblici di sola lettura di un progetto.

Ogni progetto può avere PIÙ link, ognuno con la propria configurazione di
visibilità (quali campi/aree e gruppi di pivot mostrare). Così si possono far
vedere a clienti diversi viste diverse dello stesso impianto.

- POST   /api/projects/{id}/shares  → crea un nuovo link (nome + config)
- GET    /api/projects/{id}/shares  → elenca i link del progetto
- DELETE /api/shares/{token}        → elimina un link
- GET    /api/share/{token}         → dati pubblici (progetto + aree + layer + config)

Commenti dei clienti:
- GET    /api/share/{token}/comments      → (pubblico) commenti del link
- POST   /api/share/{token}/comments      → (pubblico) nuovo commento, con limiti anti-abuso
- GET    /api/projects/{id}/comments      → tutti i commenti del progetto (autenticato)
- POST   /api/projects/{id}/comments/seen → segna tutti come letti
- PATCH  /api/comments/{id}               → letto / risolto
- DELETE /api/comments/{id}               → elimina
"""
from __future__ import annotations

import json
import secrets
import threading
import time
from collections import deque

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Area, Project, ProjectLayer, Share, ShareComment, ShareView, User
from ..security import get_current_user
from ..access import own_project

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
def create_share_legacy(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = own_project(db, user, project_id)
    s = db.scalar(select(Share).where(Share.project_id == project_id))
    if not s:
        s = Share(token=secrets.token_urlsafe(9), project_id=project_id)
        db.add(s)
        db.commit()
        db.refresh(s)
    return {"token": s.token}


# ---- Link multipli con configurazione di visibilità ----
@router.post("/projects/{project_id}/shares", response_model=ShareOut)
def create_share(project_id: int, body: ShareIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = own_project(db, user, project_id)
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
def list_shares(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    own_project(db, user, project_id)
    rows = db.scalars(
        select(ShareView).where(ShareView.project_id == project_id)
        .order_by(ShareView.created_at.desc())
    ).all()
    return [ShareOut(token=x.token, name=x.name, created_at=x.created_at.isoformat() if x.created_at else None) for x in rows]


@router.delete("/shares/{token}", status_code=204)
def delete_share(token: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    sv = db.scalar(select(ShareView).where(ShareView.token == token))
    if sv:
        own_project(db, user, sv.project_id)          # 404 se il link è di un'altra organizzazione
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


# ---------------- Commenti dei clienti ----------------
COMMENT_MAX_PER_LINK = 500            # tetto di commenti per singolo link
_RATE_N, _RATE_WINDOW_S = 10, 600     # max 10 commenti ogni 10 minuti per IP e link
_rate: dict[str, deque] = {}
_rate_lock = threading.Lock()


def _rate_ok(key: str) -> bool:
    now = time.monotonic()
    with _rate_lock:
        q = _rate.setdefault(key, deque())
        while q and now - q[0] > _RATE_WINDOW_S:
            q.popleft()
        if len(q) >= _RATE_N:
            return False
        q.append(now)
        if len(_rate) > 5000:                      # pulizia: niente crescita illimitata
            for k in [k for k, v in _rate.items() if not v]:
                _rate.pop(k, None)
        return True


def _share_of(db: Session, token: str) -> tuple[int, str]:
    """(project_id, nome del link) dal token; 404 se il link non esiste più."""
    sv = db.scalar(select(ShareView).where(ShareView.token == token))
    if sv:
        return sv.project_id, sv.name
    s = db.scalar(select(Share).where(Share.token == token))
    if s:
        return s.project_id, ""
    raise HTTPException(404, "Link non valido o revocato")


class CommentIn(BaseModel):
    author: str = Field(default="", max_length=80)
    body: str = Field(min_length=1, max_length=2000)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)


class CommentPatch(BaseModel):
    seen: bool | None = None
    resolved: bool | None = None


def _c_public(c: ShareComment) -> dict:
    return {"id": c.id, "author": c.author, "body": c.body, "lat": c.lat, "lng": c.lng,
            "resolved": bool(c.resolved), "created_at": c.created_at.isoformat() if c.created_at else None}


def _c_full(c: ShareComment) -> dict:
    return {**_c_public(c), "token": c.token, "share_name": c.share_name, "seen": bool(c.seen)}


@router.get("/share/{token}/comments")
def list_link_comments(token: str, db: Session = Depends(get_db)):
    _share_of(db, token)
    rows = db.scalars(select(ShareComment).where(ShareComment.token == token)
                      .order_by(ShareComment.created_at.asc(), ShareComment.id.asc())).all()
    return [_c_public(c) for c in rows]


@router.post("/share/{token}/comments", status_code=201)
def add_link_comment(token: str, body: CommentIn, request: Request, db: Session = Depends(get_db)):
    project_id, share_name = _share_of(db, token)
    text = body.body.strip()
    if not text:
        raise HTTPException(400, "Commento vuoto")
    ip = (request.headers.get("x-forwarded-for", "").split(",")[0].strip()
          or (request.client.host if request.client else "?"))
    if not _rate_ok(f"{ip}|{token}"):
        raise HTTPException(429, "Troppi commenti in poco tempo: riprova tra qualche minuto")
    n = len(db.scalars(select(ShareComment.id).where(ShareComment.token == token)).all())
    if n >= COMMENT_MAX_PER_LINK:
        raise HTTPException(429, "Raggiunto il numero massimo di commenti per questo link")
    c = ShareComment(project_id=project_id, token=token, share_name=share_name[:200],
                     author=(body.author or "").strip()[:80], body=text,
                     lat=body.lat if body.lng is not None else None,
                     lng=body.lng if body.lat is not None else None)
    db.add(c); db.commit(); db.refresh(c)
    return _c_public(c)


@router.get("/projects/{project_id}/comments")
def list_project_comments(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    own_project(db, user, project_id)
    rows = db.scalars(select(ShareComment).where(ShareComment.project_id == project_id)
                      .order_by(ShareComment.created_at.desc(), ShareComment.id.desc())).all()
    return [_c_full(c) for c in rows]


@router.post("/projects/{project_id}/comments/seen", status_code=204)
def mark_comments_seen(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    own_project(db, user, project_id)
    for c in db.scalars(select(ShareComment).where(ShareComment.project_id == project_id,
                                                   ShareComment.seen.is_(False))).all():
        c.seen = True
    db.commit()


def _own_comment(db: Session, user: User, comment_id: int) -> ShareComment:
    c = db.get(ShareComment, comment_id)
    if not c:
        raise HTTPException(404, "Commento non trovato")
    try:
        own_project(db, user, c.project_id)
    except HTTPException:
        raise HTTPException(404, "Commento non trovato") from None
    return c


@router.patch("/comments/{comment_id}")
def update_comment(comment_id: int, body: CommentPatch, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    c = _own_comment(db, user, comment_id)
    if body.seen is not None:
        c.seen = body.seen
    if body.resolved is not None:
        c.resolved = body.resolved
        if body.resolved:
            c.seen = True
    db.commit(); db.refresh(c)
    return _c_full(c)


@router.delete("/comments/{comment_id}", status_code=204)
def delete_comment(comment_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    c = _own_comment(db, user, comment_id)
    db.delete(c); db.commit()

