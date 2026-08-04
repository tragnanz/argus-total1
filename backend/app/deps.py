"""Dipendenze condivise: selezione del provider satellitare."""
from __future__ import annotations

from functools import lru_cache

from .config import settings


@lru_cache(maxsize=1)
def get_client():
    """Ritorna il client satellitare secondo PROVIDER_MODE.

    - synthetic (default): dati locali, nessun credito consumato.
    - cdse: Copernicus reale, con le credenziali del SECONDO account (env var).
    """
    if settings.provider_mode == "cdse":
        if not settings.cdse_client_id or not settings.cdse_client_secret:
            raise RuntimeError(
                "PROVIDER_MODE=cdse ma mancano CDSE_CLIENT_ID/CDSE_CLIENT_SECRET.")
        from processing.providers.cdse import CdseClient
        return CdseClient(settings.cdse_client_id, settings.cdse_client_secret)
    from processing.providers.synthetic import SyntheticClient
    return SyntheticClient()
