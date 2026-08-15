"""Argus Total — API FastAPI.

Suite Argus di Nabu. Progetto SEPARATO da Argus Smart (repo/DB/servizio/CDSE
distinti). Riusa il motore satellitare (processing/) senza modificarlo.
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import cors_origin_list, settings
from .db import init_db
from .routers import (admin, auth, canal, elevation, guided, layers, layout,
                      macroareas, projects, report, satellite, share, suitability,
                      terrain, usage)
from .schemas import HealthOut
from .security import decode_token

# Revisione backend: allineala alla REV del frontend a ogni versione.
REV = "0.6.153"

app = FastAPI(title=settings.app_name, version=REV)

# Percorsi pubblici (nessun login): health, registrazione/login e i link di sola
# lettura per i clienti. Tutto il resto di /api richiede un token valido.
_PUBLIC_PATHS = {"/api/health", "/api/auth/register", "/api/auth/login"}


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if (request.method == "OPTIONS" or not path.startswith("/api/")
            or path in _PUBLIC_PATHS or path.startswith("/api/share/")):
        return await call_next(request)
    auth_h = request.headers.get("authorization", "")
    token = auth_h[7:] if auth_h[:7].lower() == "bearer " else ""
    if not token or decode_token(token) is None:
        return JSONResponse({"detail": "Autenticazione richiesta"}, status_code=401)
    return await call_next(request)


# ATTENZIONE all'ordine: Starlette esegue per primo l'ultimo middleware
# aggiunto. Il CORS va quindi registrato DOPO il controllo del login, così
# resta il piu' esterno e aggiunge le sue intestazioni anche alle risposte
# 401/500. Altrimenti il browser scarta la risposta e mostra un opaco
# «Failed to fetch» al posto del vero messaggio d'errore.
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


app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(usage.router)
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
