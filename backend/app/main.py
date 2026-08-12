"""Argus Total — API FastAPI.

Suite Argus di Nabu. Progetto SEPARATO da Argus Smart (repo/DB/servizio/CDSE
distinti). Riusa il motore satellitare (processing/) senza modificarlo.
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import cors_origin_list, settings
from .db import init_db
from .routers import (canal, elevation, guided, layers, layout, macroareas, projects,
                      report, satellite, share, suitability, terrain)
from .schemas import HealthOut

# Revisione backend: allineala alla REV del frontend a ogni versione.
REV = "0.6.101"

app = FastAPI(title=settings.app_name, version=REV)

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origin_list(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Crea le tabelle all'avvio (idempotente). In produzione strutturata si
# passerebbe a migrazioni Alembic; per lo scaffold create_all è sufficiente.
init_db()


@app.get("/api/health", response_model=HealthOut, tags=["meta"])
def health() -> HealthOut:
    return HealthOut(status="ok", provider_mode=settings.provider_mode, rev=REV)


app.include_router(projects.router)
app.include_router(satellite.router)
app.include_router(suitability.router)
app.include_router(layout.router)
app.include_router(macroareas.router)
app.include_router(canal.router)
app.include_router(guided.router)
app.include_router(layers.router)
app.include_router(terrain.router)
app.include_router(elevation.router)
app.include_router(share.router)
app.include_router(report.router)
