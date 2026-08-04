"""Provider satellitari (astratti). CDSE = Copernicus Data Space Ecosystem."""
from .cdse import CdseClient, build_cdse_inputs

__all__ = ["CdseClient", "build_cdse_inputs"]
