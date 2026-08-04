"""Provider satellitare SINTETICO per Argus Total.

Espone la stessa interfaccia di `CdseClient` (`fetch_bands`, `fetch_dem`,
`search_scenes`) ma genera dati plausibili in locale, in modo deterministico
sull'area richiesta. Serve per far girare l'app e la UI **senza consumare i
crediti Copernicus**: si passa al provider reale impostando
`PROVIDER_MODE=cdse` + le credenziali del secondo account CDSE via env var.

Le bande restituite rispettano l'ordine del motore:
B02, B03, B04, B05, B08, B11, SCL  (array (7, H, W) float32).
"""
from __future__ import annotations

import datetime as dt
import hashlib

import numpy as np


def _seed(*parts) -> int:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return int(h[:8], 16)


def _smooth_field(rng: np.random.RandomState, h: int, w: int,
                  lo: float, hi: float, coarse: int = 10) -> np.ndarray:
    """Campo continuo e liscio in [lo, hi] (rumore a bassa frequenza upsampled)."""
    from scipy.ndimage import zoom, gaussian_filter
    cw = max(2, coarse)
    ch = max(2, int(round(coarse * h / max(1, w))))
    base = rng.rand(ch, cw)
    zy, zx = h / ch, w / cw
    big = zoom(base, (zy, zx), order=1)[:h, :w]
    if big.shape != (h, w):                       # padding di sicurezza
        big = np.pad(big, ((0, max(0, h - big.shape[0])),
                           (0, max(0, w - big.shape[1]))), mode="edge")[:h, :w]
    big = gaussian_filter(big, sigma=max(1.0, min(h, w) / 60.0))
    mn, mx = float(big.min()), float(big.max())
    big = (big - mn) / (mx - mn + 1e-9)
    return (lo + big * (hi - lo)).astype("float32")


class SyntheticClient:
    """Client compatibile con il motore, senza rete né credenziali."""

    def __init__(self, *_, **__):
        pass

    # --- catalogo scene (finto) --------------------------------------------
    def search_scenes(self, bbox_wgs84, date_from, date_to,
                      max_cloud=90, limit=100) -> list[dict]:
        """Date sintetiche ~ ogni 5 giorni (rivisita Sentinel-2), più recenti
        prima. Nuvolosità pseudo-casuale ma stabile per data."""
        d0 = dt.date.fromisoformat(str(date_from)[:10])
        d1 = dt.date.fromisoformat(str(date_to)[:10])
        out: list[dict] = []
        d = d1
        rng = np.random.RandomState(_seed(round(bbox_wgs84[0], 2), round(bbox_wgs84[1], 2)))
        while d >= d0 and len(out) < limit:
            cloud = float(round(rng.rand() * 40, 1))     # 0..40%
            if cloud <= max_cloud:
                out.append({"date": d.isoformat(), "cloud": cloud})
            d -= dt.timedelta(days=5)
        return out

    def search_dates(self, bbox_wgs84, date_from, date_to,
                     max_cloud=80, limit=100) -> list[str]:
        return [s["date"] for s in
                self.search_scenes(bbox_wgs84, date_from, date_to, max_cloud, limit)]

    # --- bande spettrali (finte ma coerenti fra gli indici) ----------------
    def fetch_bands(self, bbox_utm, epsg, width, height, day) -> np.ndarray:
        w, h = int(width), int(height)
        rng = np.random.RandomState(_seed(epsg, round(bbox_utm[0]), round(bbox_utm[1]), day))
        # vigore (guida NDVI/NDRE) e umidità (guida NDMI/MSI): due campi lisci
        veg = _smooth_field(rng, h, w, 0.15, 0.85)             # NDVI target
        moist = _smooth_field(rng, h, w, -0.15, 0.40)          # NDMI target
        # qualche macchia debole (aree meno idonee) per dare varietà
        patch = _smooth_field(rng, h, w, 0.0, 1.0, coarse=5)
        veg = np.where(patch < 0.12, veg * 0.55, veg).astype("float32")

        red = (0.045 + 0.02 * _smooth_field(rng, h, w, 0.0, 1.0, coarse=6)).astype("float32")
        nir = (red * (1 + veg) / np.clip(1 - veg, 1e-3, None)).astype("float32")
        swir = (nir * (1 - moist) / np.clip(1 + moist, 1e-3, None)).astype("float32")
        rededge = (red + 0.5 * (nir - red)).astype("float32")
        green = (0.055 + 0.02 * _smooth_field(rng, h, w, 0.0, 1.0, coarse=6)).astype("float32")
        blue = (0.03 + 0.015 * _smooth_field(rng, h, w, 0.0, 1.0, coarse=6)).astype("float32")

        def c(a):
            return np.clip(a, 0.0, 1.0).astype("float32")

        scl = np.full((h, w), 4.0, dtype="float32")           # 4 = vegetazione (valida)
        return np.stack([c(blue), c(green), c(red), c(rededge),
                         c(nir), c(swir), scl], 0)

    # --- DEM sintetico ------------------------------------------------------
    def fetch_dem(self, bbox_utm, epsg, width, height,
                  dem_instance: str = "COPERNICUS_30") -> np.ndarray:
        w, h = int(width), int(height)
        rng = np.random.RandomState(_seed("dem", epsg, round(bbox_utm[0]), round(bbox_utm[1])))
        yy, xx = np.mgrid[0:h, 0:w].astype("float32")
        # piano inclinato + ondulazioni dolci → quota 150..450 m
        base_min = 150 + rng.rand() * 120
        tilt = (xx / max(1, w)) * (40 + rng.rand() * 60) + (yy / max(1, h)) * (30 + rng.rand() * 50)
        waves = _smooth_field(rng, h, w, 0.0, 90.0, coarse=6)
        dem = base_min + tilt + waves
        return dem.astype("float32")
