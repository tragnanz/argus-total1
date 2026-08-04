"""Configurazione 12-factor via variabili d'ambiente (Argus Total).

Progetto SEPARATO da Argus Smart: DB dedicato e SECONDO account Copernicus.
Nessuna credenziale nel codice — solo env var (su Render: sync:false).
"""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Identità build (mostrata nel footer del frontend è separata: vedi REV)
    app_name: str = "Argus Total"

    # Database dedicato a Total: SQLite in dev, Postgres in prod.
    # Prod: postgresql+psycopg://user:pass@host:5432/argus_total
    database_url: str = "sqlite:///./argus_total.db"

    # Provider satellitare: synthetic (default, nessun credito) | cdse (reale).
    provider_mode: str = "synthetic"          # synthetic | cdse
    # Credenziali del SECONDO account CDSE (solo via env var su Render).
    cdse_client_id: str = ""
    cdse_client_secret: str = ""
    # Limiti mensili del piano CDSE (per il contatore quota, milestone futura).
    cdse_monthly_requests: int = 10_000
    cdse_monthly_pu: int = 10_000

    # CORS: origini del frontend autorizzate (CSV). "*" per aprire tutto in dev.
    cors_origins: str = "*"

    # Storage locale (export, cache)
    storage_dir: str = "./storage"


settings = Settings()


def cors_origin_list() -> list[str]:
    raw = settings.cors_origins.strip()
    if raw in ("", "*"):
        return ["*"]
    return [o.strip() for o in raw.split(",") if o.strip()]
