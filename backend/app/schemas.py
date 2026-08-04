"""Schemi Pydantic v2 (I/O API)."""
from __future__ import annotations

import datetime as dt
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


# ---------- Geometria ----------
class GeoPolygon(BaseModel):
    """GeoJSON Polygon minimale (coordinate lon/lat)."""
    type: Literal["Polygon"] = "Polygon"
    coordinates: list[list[list[float]]]


# ---------- Client ----------
class ClientIn(BaseModel):
    name: str
    notes: str | None = None


class ClientPatch(BaseModel):
    name: str | None = None
    notes: str | None = None


class ClientOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    notes: str | None = None
    created_at: dt.datetime


# ---------- Project ----------
class ProjectIn(BaseModel):
    name: str
    client_id: int | None = None
    description: str | None = None
    crop: str | None = None


class ProjectPatch(BaseModel):
    name: str | None = None
    client_id: int | None = None
    description: str | None = None
    crop: str | None = None


class ProjectOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    client_id: int | None = None
    name: str
    description: str | None = None
    crop: str | None = None
    created_at: dt.datetime


# ---------- Area ----------
class AreaIn(BaseModel):
    project_id: int
    name: str
    geojson: GeoPolygon
    area_ha: float | None = None


class AreaPatch(BaseModel):
    name: str | None = None
    geojson: GeoPolygon | None = None
    area_ha: float | None = None


class AreaOut(BaseModel):
    id: int
    project_id: int
    name: str
    geojson: GeoPolygon
    area_ha: float | None = None
    created_at: dt.datetime


# ---------- Satellite ----------
class ScenesIn(BaseModel):
    geom: GeoPolygon
    months_back: int = Field(default=12, ge=1, le=60)
    max_cloud: float = Field(default=95, ge=0, le=100)


class SceneOut(BaseModel):
    date: str
    cloud: float | None = None


class PreviewIn(BaseModel):
    geom: GeoPolygon
    index: str = "ndvi"
    date: str
    normalized: bool = False


class PreviewOut(BaseModel):
    image: str                                   # data URL PNG
    bounds: list[list[float]]                     # [[S,W],[N,E]]
    meta: dict[str, Any]


class DemIn(BaseModel):
    geom: GeoPolygon


# ---------- Idoneità del terreno ----------
class SuitWeights(BaseModel):
    slope: float = 0.45
    vigor: float = 0.25
    moisture: float = 0.15
    climate: float = 0.15


class SuitabilityIn(BaseModel):
    geom: GeoPolygon
    date: str
    weights: SuitWeights = Field(default_factory=SuitWeights)
    slope_ideal_pct: float = Field(default=0.5, ge=0, le=45)   # % ( = ‰/10 lato UI)
    slope_max_pct: float = Field(default=7.0, ge=0, le=60)
    ndvi_min: float = 0.20
    ndvi_good: float = 0.60
    ndmi_min: float = 0.00
    ndmi_good: float = 0.40


class SuitabilityOut(BaseModel):
    image: str
    bounds: list[list[float]]
    meta: dict[str, Any]


# ---------- Layout pivot + dimensionamento idrico (M3) ----------
class LayoutIn(BaseModel):
    geom: GeoPolygon
    config: Literal["square", "staggered"] = "staggered"
    radius_m: float = Field(default=400.0, ge=30, le=1000)
    gap_m: float = Field(default=0.0, ge=0, le=2000)              # distanza tra i bordi
    transport: Literal["canal", "buried"] = "buried"
    slope_max_pct: float | None = Field(default=None, ge=0, le=60)  # override vincolo pendenza (%)
    slope_ideal_pct: float | None = Field(default=None, ge=0, le=45)  # pendenza ideale (%) per idoneità
    # orientamento del reticolo (rispetto al canale/campo)
    auto_orient: bool = True                                       # allinea al bordo più lungo
    canal_azimuth_deg: float | None = Field(default=None, ge=-360, le=360)
    canal_flip: bool = False                                       # canale sul bordo opposto
    # incrocio con l'idoneità (M2): posa i pivot solo su aree idonee
    only_suitable: bool = False
    min_suitability: float = Field(default=60.0, ge=0, le=100)
    date: str | None = None                                        # data indici (se only_suitable)
    overhang_pct: float = Field(default=0.0, ge=0, le=40)          # sbordo controllato
    n_phases: int = Field(default=1, ge=1, le=6)                   # fasi di sviluppo
    phase_order: Literal["canal_distance", "suitability", "rows"] = "canal_distance"
    kc_peak: float = Field(default=1.15, ge=0.3, le=1.6)
    efficiency: float = Field(default=0.85, ge=0.4, le=1.0)
    hours_per_day: float = Field(default=20.0, ge=1, le=24)


class LayoutOut(BaseModel):
    geojson: dict[str, Any]
    bounds: list[list[float]]
    meta: dict[str, Any]


# ---------- Scheda progetto / export (M4) ----------
class ReportIn(LayoutIn):
    project_name: str = "Progetto"
    client_name: str | None = None
    notes: str | None = None
    include_suitability: bool = True
    suit_weights: SuitWeights = Field(default_factory=SuitWeights)
    lang: str = "it"                                              # lingua della scheda PDF


class HealthOut(BaseModel):
    status: str
    provider_mode: str
    rev: str
