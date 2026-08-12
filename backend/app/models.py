"""Modelli dati Argus Total — gerarchia Cliente → Progetto → Area di progetto.

DB dedicato a Total (nessuna condivisione con Argus Smart). La geometria è
salvata come GeoJSON (TEXT) per restare DB-agnostici: nessuna dipendenza da
PostGIS in questa fase. L'analisi spaziale gira nel motore Python.
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class Client(Base):
    __tablename__ = "clients"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, server_default=func.now())

    projects: Mapped[list["Project"]] = relationship(
        back_populates="client", cascade="all, delete-orphan")


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    client_id: Mapped[int | None] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), nullable=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Progetto agroindustriale: contesto sintetico utile alle milestone future.
    crop: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, server_default=func.now())

    client: Mapped["Client | None"] = relationship(back_populates="projects")
    areas: Mapped[list["Area"]] = relationship(
        back_populates="project", cascade="all, delete-orphan")


class Area(Base):
    __tablename__ = "areas"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    # Sotto-livelli: una macro-area è figlia del campo (poligono) in cui è
    # inscritta. parent_area_id nullo = area di primo livello (campo).
    parent_area_id: Mapped[int | None] = mapped_column(
        ForeignKey("areas.id", ondelete="CASCADE"), nullable=True, index=True)
    # "field" = poligono importato/disegnato; "macro" = sotto-area idonea.
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="field")
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # GeoJSON Polygon (lon/lat) serializzato come stringa.
    geojson: Mapped[str] = mapped_column(Text, nullable=False)
    area_ha: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, server_default=func.now())

    project: Mapped["Project"] = relationship(back_populates="areas")


class ProjectLayer(Base):
    """Livello salvato e ri-editabile del progetto: canale, set di pivot o altra
    struttura disegnata. La geometria/parametri sono in `data` (JSON) per restare
    flessibili senza vincolare lo schema a un tipo specifico."""
    __tablename__ = "project_layers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)   # "canal" | "pivots" | ...
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    data: Mapped[str] = mapped_column(Text, nullable=False)         # JSON serializzato
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, server_default=func.now())


class Share(Base):
    """Link pubblico di sola lettura per un progetto: un token opaco mappa a un
    progetto e permette la visualizzazione (mappa + informazioni) senza modifica.
    Tabella nuova → create_all la crea senza migrazioni."""
    __tablename__ = "shares"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, server_default=func.now())
