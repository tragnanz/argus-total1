"""Autenticazione e crediti per Argus Total.

- Hashing password con bcrypt (mai in chiaro).
- Token di sessione JWT (HS256) firmati con SETTINGS.jwt_secret.
- Dipendenze FastAPI: get_current_user (login obbligatorio), get_admin_user.
- charge(): addebita 1 credito alle operazioni costose (owner/admin = illimitati).
"""
from __future__ import annotations

import datetime as dt

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import User

ADMIN_ROLES = ("owner", "admin")
_bearer = HTTPBearer(auto_error=False)


# ---------------- password ----------------
def hash_password(password: str) -> str:
    # bcrypt tronca a 72 byte: proteggiamo esplicitamente.
    return bcrypt.hashpw(password.encode("utf-8")[:72], bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8")[:72], password_hash.encode("utf-8"))
    except Exception:  # noqa: BLE001
        return False


# ---------------- token JWT ----------------
def create_token(user_id: int) -> str:
    now = dt.datetime.now(dt.timezone.utc)
    payload = {"sub": str(user_id), "iat": now, "exp": now + dt.timedelta(minutes=settings.jwt_expire_minutes)}
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_token(token: str) -> int | None:
    try:
        data = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
        return int(data.get("sub"))
    except Exception:  # noqa: BLE001  (scaduto/invalido)
        return None


# ---------------- dipendenze ----------------
def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    if creds is None or not creds.credentials:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Autenticazione richiesta")
    uid = decode_token(creds.credentials)
    if uid is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sessione non valida o scaduta")
    user = db.get(User, uid)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Utente inesistente")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Utente disattivato")
    return user


def get_admin_user(user: User = Depends(get_current_user)) -> User:
    if user.role not in ADMIN_ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Riservato agli amministratori")
    return user


def is_admin(user: User) -> bool:
    return user.role in ADMIN_ROLES


def credits_remaining(user: User) -> int | None:
    """Crediti residui: None se admin/illimitato, altrimenti max(0, tetto − usati)."""
    if is_admin(user) or user.credits is None:
        return None
    return max(0, int(user.credits) - int(user.credits_used or 0))


# ---------------- addebito crediti ----------------
def charge(db: Session, user: User, n: int = 1) -> None:
    """Addebita n crediti PRIMA di lanciare un'operazione costosa (fail-fast).

    - owner/admin o crediti illimitati (None) → nessun addebito.
    - member: se usati + n > tetto → 402 (crediti esauriti); altrimenti incrementa.
    """
    if is_admin(user) or user.credits is None:
        return
    used = int(user.credits_used or 0)
    if used + n > int(user.credits):
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "Crediti esauriti, contatta l'amministratore")
    user.credits_used = used + n
    db.add(user)
    db.commit()
