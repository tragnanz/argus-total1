"""Setup SQLAlchemy DB-agnostico (SQLite in dev, Postgres in prod)."""
from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings


def _normalize(url: str) -> str:
    # Render fornisce spesso "postgres://": SQLAlchemy vuole il driver psycopg v3.
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+psycopg://", 1)
    elif url.startswith("postgresql://") and "+psycopg" not in url:
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


DATABASE_URL = _normalize(settings.database_url)

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _ensure_columns() -> None:
    """Micro-migrazione idempotente: aggiunge colonne nuove a tabelle già
    esistenti (create_all non altera tabelle preesistenti). Sicura su
    SQLite e Postgres; ignora l'errore se la colonna c'è già."""
    from sqlalchemy import inspect, text
    insp = inspect(engine)
    if "areas" not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns("areas")}
    stmts = []
    if "parent_area_id" not in cols:
        stmts.append("ALTER TABLE areas ADD COLUMN parent_area_id INTEGER")
    if "kind" not in cols:
        stmts.append("ALTER TABLE areas ADD COLUMN kind VARCHAR(20) DEFAULT 'field'")
    for s in stmts:
        try:
            with engine.begin() as conn:
                conn.execute(text(s))
        except Exception:  # noqa: BLE001  (colonna già presente / race)
            pass


def init_db() -> None:
    from . import models  # noqa: F401  (registra le tabelle)
    Base.metadata.create_all(bind=engine)
    _ensure_columns()
