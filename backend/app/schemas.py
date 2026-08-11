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
    parent_area_id: int | None = None   # se valorizzato, è una sotto-area
    kind: str = "field"                  # "field" | "macro"


class AreaPatch(BaseModel):
    name: str | None = None
    geojson: GeoPolygon | None = None
    area_ha: float | None = None


class AreaOut(BaseModel):
    id: int
    project_id: int
    parent_area_id: int | None = None
    kind: str = "field"
    name: str
    geojson: GeoPolygon
    area_ha: float | None = None
    created_at: dt.datetime


# ---------- Livelli salvati e ri-editabili (canali, pivot, …) ----------
class LayerIn(BaseModel):
    project_id: int
    kind: str
    name: str
    data: dict[str, Any]


class LayerPatch(BaseModel):
    name: str | None = None
    data: dict[str, Any] | None = None


class LayerOut(BaseModel):
    id: int
    project_id: int
    kind: str
    name: str
    data: dict[str, Any]
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


# ---------- Macro-aree di intervento (M6, Fase 1) ----------
class MacroAreasIn(BaseModel):
    geom: GeoPolygon
    date: str
    weights: SuitWeights = Field(default_factory=SuitWeights)
    slope_ideal_pct: float = Field(default=0.5, ge=0, le=45)
    slope_max_pct: float = Field(default=7.0, ge=0, le=60)
    min_suitability: float = Field(default=60.0, ge=0, le=100)
    min_area_ha: float = Field(default=10.0, ge=0, le=1_000_000)


class MacroArea(BaseModel):
    geojson: GeoPolygon
    area_ha: float
    mean_score: float


# ---------- Canale principale automatico (M6, Fase 2) ----------
class CanalIn(BaseModel):
    geom: GeoPolygon
    target_permille: float = Field(default=1.0, ge=0.1, le=100)
    start: list[float] | None = None  # [lon, lat] presa manuale
    end: list[float] | None = None    # [lon, lat] finale manuale
    waypoints: list[list[float]] | None = None  # punti intermedi [lon,lat] (percorso trascinabile)
    manual: list[list[float]] | None = None     # polilinea disegnata a mano [lon,lat]…
    snap: bool = False                           # aggancia il tracciato all'alveo (DEM)
    snap_buffer_m: float = Field(default=250.0, ge=30, le=2000)


class CanalOut(BaseModel):
    geojson: dict[str, Any]
    length_m: float
    drop_m: float
    mean_permille: float
    target_permille: float
    start: list[float]
    end: list[float]
    elev_start_m: float
    elev_end_m: float
    profile: list[list[float]]
    waypoints: list[list[float]] = []


# ---------- Leggibilità del terreno (rilievo + isoipse, zona a valle) ----------
class TerrainIn(BaseModel):
    geom: GeoPolygon
    vert_exag: float = Field(default=2.0, ge=0.5, le=6)
    interval_m: float = Field(default=0.0, ge=0, le=1000)  # 0 = automatico


class TerrainOut(BaseModel):
    image: str
    bounds: list[list[float]]
    contours: dict[str, Any]     # FeatureCollection di isoipse
    interval_m: float
    elev_min: float
    elev_max: float


class ReachIn(BaseModel):
    geom: GeoPolygon
    start: list[float]           # [lon, lat] presa
    tol_up_m: float = Field(default=0.5, ge=0.0, le=5.0)  # tolleranza rumore DEM


class ReachOut(BaseModel):
    polygons: list[dict[str, Any]]
    elev_start_m: float
    elev_min_m: float
    area_ha: float


# ---------- Corsi d'acqua esistenti (NDWI) ----------
class WaterIn(BaseModel):
    geom: GeoPolygon
    date: str
    min_area_ha: float = Field(default=0.2, ge=0.0, le=10000)
    ndwi_thr: float = Field(default=0.20, ge=-0.5, le=0.8)  # soglia acqua (sensibilità)
    use_dem: bool = True                                    # drenaggio dal DEM (alvei asciutti)
    dem_channel_ha: float = Field(default=25.0, ge=1.0, le=100000)  # area di bacino minima
    dem_depth_m: float = Field(default=1.2, ge=0.1, le=50)  # profondità incisione min (alvei)


class WaterOut(BaseModel):
    features: list[dict[str, Any]]
    water_ha: float
    n_river: int
    n_basin: int
    n_wetland: int
    n_drainage: int = 0


# ---------- Pivot lungo il canale (M6, Fase 3) ----------
class GuidedIn(BaseModel):
    geom: GeoPolygon
    target_permille: float = Field(default=1.0, ge=0.1, le=100)
    radius_m: float = Field(default=400.0, ge=30, le=1000)
    gap_m: float = Field(default=0.0, ge=0, le=2000)
    safety_m: float = Field(default=20.0, ge=0, le=500)  # distanza di rispetto tra i bordi dei pivot
    clear_road_m: float = Field(default=0.0, ge=0, le=500)   # franco da strade/canali (corpi lineari)
    clear_water_m: float = Field(default=0.0, ge=0, le=500)  # franco da acqua/invasi
    per_side: int = Field(default=2, ge=1, le=4)
    conn_max_permille: float = Field(default=5.0, ge=0.1, le=100)
    fill: bool = True                                  # riempi gli spazi vuoti
    date: str | None = None                            # per esclusione acqua (NDWI)
    exclude_water: bool = True                          # niente pivot su acqua/paludi
    avoid: list[dict[str, Any]] | None = None          # corsi d'acqua confermati da evitare
    roads: list[dict[str, Any]] | None = None          # strade segnate (linee) da rispettare


class GuidedOut(BaseModel):
    geojson: dict[str, Any]
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
