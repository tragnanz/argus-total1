"""Autenticazione: registrazione del primo owner, login, profilo corrente."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Client, Organization, User
from ..schemas import LoginIn, MeOut, RegisterIn, TokenOut
from ..security import (create_token, credits_remaining, get_current_user,
                        hash_password, is_admin, verify_password)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _me(user: User) -> MeOut:
    return MeOut(
        id=user.id, email=user.email, full_name=user.full_name, role=user.role,
        is_admin=is_admin(user), organization_id=user.organization_id,
        credits=user.credits, credits_used=user.credits_used or 0,
        credits_remaining=credits_remaining(user))


@router.post("/register", response_model=TokenOut)
def register(body: RegisterIn, db: Session = Depends(get_db)):
    """La PRIMA registrazione crea l'organizzazione e l'utente owner (super-admin,
    crediti illimitati). Dopo, la registrazione è chiusa: i nuovi utenti li crea
    l'amministratore. I clienti/progetti già esistenti (senza organizzazione)
    vengono assegnati a questa prima organizzazione."""
    n_users = db.scalar(select(func.count()).select_from(User)) or 0
    if n_users > 0:
        raise HTTPException(403, "Registrazione chiusa: chiedi all'amministratore di crearti un accesso.")
    email = (body.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(400, "Email non valida.")
    if len(body.password or "") < 8:
        raise HTTPException(400, "La password deve avere almeno 8 caratteri.")
    org = Organization(name=(body.organization_name or "La mia organizzazione").strip())
    db.add(org); db.flush()
    owner = User(
        organization_id=org.id, email=email, password_hash=hash_password(body.password),
        full_name=(body.full_name or None), role="owner", is_active=1,
        credits=None, credits_used=0)
    db.add(owner)
    # Backfill: i dati preesistenti (clienti senza org) diventano dell'owner.
    db.execute(update(Client).where(Client.organization_id.is_(None)).values(organization_id=org.id))
    db.commit(); db.refresh(owner)
    return TokenOut(access_token=create_token(owner.id))


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, db: Session = Depends(get_db)):
    email = (body.email or "").strip().lower()
    user = db.scalar(select(User).where(func.lower(User.email) == email))
    if user is None or not verify_password(body.password or "", user.password_hash):
        raise HTTPException(401, "Email o password non corretti.")
    if not user.is_active:
        raise HTTPException(403, "Utente disattivato: contatta l'amministratore.")
    return TokenOut(access_token=create_token(user.id))


@router.get("/me", response_model=MeOut)
def me(user: User = Depends(get_current_user)):
    return _me(user)
