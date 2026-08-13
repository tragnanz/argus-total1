"""Crediti/consumo: vista differenziata admin (organizzazione) vs member (utente)."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User
from ..schemas import UsageOut
from ..security import get_current_user, is_admin

router = APIRouter(prefix="/api", tags=["usage"])


@router.get("/usage", response_model=UsageOut)
def usage(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if is_admin(user):
        # Vista organizzazione: crediti distribuiti e consumati dai membri.
        rows = db.execute(
            select(func.coalesce(func.sum(User.credits), 0), func.coalesce(func.sum(User.credits_used), 0))
            .where(User.organization_id == user.organization_id, User.credits.is_not(None))
        ).one()
        limit = int(rows[0] or 0)
        used = int(rows[1] or 0)
        pct = round(100.0 * used / limit, 1) if limit > 0 else 0.0
        return UsageOut(scope="org", requests_used=used, requests_limit=limit,
                        requests_remaining=max(0, limit - used), pct_used=pct)
    used = int(user.credits_used or 0)
    limit = user.credits
    if limit is None:
        return UsageOut(scope="user", requests_used=used, requests_limit=None,
                        requests_remaining=None, pct_used=0.0)
    limit = int(limit)
    pct = round(100.0 * used / limit, 1) if limit > 0 else 0.0
    return UsageOut(scope="user", requests_used=used, requests_limit=limit,
                    requests_remaining=max(0, limit - used), pct_used=pct)
