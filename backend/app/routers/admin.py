"""Gestione utenti e crediti (solo amministratori dell'organizzazione)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User
from ..schemas import AdminUserCreate, AdminUserOut, AdminUserPatch
from ..security import (ADMIN_ROLES, credits_remaining, get_admin_user,
                        hash_password)

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _out(u: User) -> AdminUserOut:
    return AdminUserOut(
        id=u.id, email=u.email, full_name=u.full_name, role=u.role,
        is_active=bool(u.is_active), credits=u.credits, credits_used=u.credits_used or 0,
        credits_remaining=credits_remaining(u), created_at=u.created_at)


def _target(db: Session, admin: User, user_id: int) -> User:
    u = db.get(User, user_id)
    if u is None or u.organization_id != admin.organization_id:
        raise HTTPException(404, "Utente non trovato.")
    return u


@router.get("/users", response_model=list[AdminUserOut])
def list_users(admin: User = Depends(get_admin_user), db: Session = Depends(get_db)):
    users = db.scalars(
        select(User).where(User.organization_id == admin.organization_id).order_by(User.created_at)
    ).all()
    return [_out(u) for u in users]


@router.post("/users", response_model=AdminUserOut)
def create_user(body: AdminUserCreate, admin: User = Depends(get_admin_user), db: Session = Depends(get_db)):
    email = (body.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(400, "Email non valida.")
    if len(body.password or "") < 8:
        raise HTTPException(400, "La password deve avere almeno 8 caratteri.")
    exists = db.scalar(select(func.count()).select_from(User).where(func.lower(User.email) == email))
    if exists:
        raise HTTPException(400, "Esiste già un utente con questa email.")
    u = User(
        organization_id=admin.organization_id, email=email,
        password_hash=hash_password(body.password), full_name=(body.full_name or None),
        role="member", is_active=1, credits=body.credits, credits_used=0)
    db.add(u); db.commit(); db.refresh(u)
    return _out(u)


@router.patch("/users/{user_id}", response_model=AdminUserOut)
def update_user(user_id: int, body: AdminUserPatch, admin: User = Depends(get_admin_user), db: Session = Depends(get_db)):
    u = _target(db, admin, user_id)
    if u.role == "owner":
        raise HTTPException(403, "Il proprietario non è modificabile.")
    if body.credits is not None:
        u.credits = max(0, int(body.credits))
    if body.reset_used:
        u.credits_used = 0
    if body.is_active is not None:
        u.is_active = 1 if body.is_active else 0
    if body.full_name is not None:
        u.full_name = body.full_name or None
    if body.password:
        if len(body.password) < 8:
            raise HTTPException(400, "La password deve avere almeno 8 caratteri.")
        u.password_hash = hash_password(body.password)
    db.add(u); db.commit(); db.refresh(u)
    return _out(u)


@router.delete("/users/{user_id}")
def delete_user(user_id: int, admin: User = Depends(get_admin_user), db: Session = Depends(get_db)):
    u = _target(db, admin, user_id)
    if u.role == "owner":
        raise HTTPException(403, "Il proprietario non è eliminabile.")
    db.delete(u); db.commit()
    return {"ok": True}
