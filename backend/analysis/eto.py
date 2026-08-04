"""Evapotraspirazione di riferimento ET₀ — FAO-56 Penman-Monteith (mensile).

Calcolata dai normali climatici mensili (NASA POWER o stima sintetica) forniti
da `processing.climate`. Riferimento: Allen et al., FAO Irrigation & Drainage
Paper 56. Unità: ET₀ in mm/giorno (e mm/mese aggregando sui giorni del mese).
"""
from __future__ import annotations

import math

_GSC = 0.0820          # costante solare MJ/m²/min
_SIGMA = 4.903e-9      # Stefan-Boltzmann MJ/K⁴/m²/giorno
DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
# giorno dell'anno a metà mese (approssimazione FAO)
_MID_DOY = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349]


def _e0(t: float) -> float:
    """Pressione di vapore a saturazione (kPa) alla temperatura t (°C)."""
    return 0.6108 * math.exp(17.27 * t / (t + 237.3))


def _ra(lat_deg: float, doy: int) -> float:
    """Radiazione extraterrestre Ra (MJ/m²/giorno)."""
    phi = math.radians(lat_deg)
    dr = 1 + 0.033 * math.cos(2 * math.pi * doy / 365)
    dec = 0.409 * math.sin(2 * math.pi * doy / 365 - 1.39)
    x = -math.tan(phi) * math.tan(dec)
    x = max(-1.0, min(1.0, x))               # evita domini fuori range (poli)
    ws = math.acos(x)
    return (24 * 60 / math.pi) * _GSC * dr * (
        ws * math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.sin(ws))


def eto_month(tmax: float, tmin: float, rh: float, wind: float, rs: float,
              elev: float, lat_deg: float, month_idx: int) -> float:
    """ET₀ (mm/giorno) per un mese. month_idx: 0=gennaio … 11=dicembre."""
    tmean = (tmax + tmin) / 2
    delta = 4098 * _e0(tmean) / (tmean + 237.3) ** 2
    p = 101.3 * ((293 - 0.0065 * elev) / 293) ** 5.26
    gamma = 0.000665 * p
    es = (_e0(tmax) + _e0(tmin)) / 2
    ea = max(0.0, min(es, es * rh / 100.0))

    ra = _ra(lat_deg, _MID_DOY[month_idx])
    rso = (0.75 + 2e-5 * elev) * ra
    rs = min(rs, rso) if rso > 0 else rs      # Rs non può superare Rso (cielo sereno)
    ratio = 0.0 if rso <= 0 else max(0.3, min(1.0, rs / rso))
    rns = (1 - 0.23) * rs
    rnl = _SIGMA * (((tmax + 273.16) ** 4 + (tmin + 273.16) ** 4) / 2) * \
        (0.34 - 0.14 * math.sqrt(max(0.0, ea))) * (1.35 * ratio - 0.35)
    rn = rns - rnl
    u2 = max(0.5, wind)

    num = 0.408 * delta * rn + gamma * (900 / (tmean + 273)) * u2 * (es - ea)
    den = delta + gamma * (1 + 0.34 * u2)
    return max(0.0, num / den)


def eto_year(clim: dict, elev: float, lat_deg: float) -> dict:
    """ET₀ mensile e annua dai normali climatici.

    Ritorna {eto_month[mm/g] ×12, eto_month_mm[mm/mese] ×12, eto_year_mm,
    rain_month_mm ×12, rain_year_mm, deficit_year_mm (ET₀−pioggia)}.
    """
    eto_d, eto_m = [], []
    for i in range(12):
        d = eto_month(clim["tmax"][i], clim["tmin"][i], clim["rh"][i],
                      clim["wind"][i], clim["rs"][i], elev, lat_deg, i)
        eto_d.append(round(d, 2))
        eto_m.append(round(d * DAYS[i], 1))
    rain_m = [round(float(r), 1) for r in clim["rain"]]
    eto_yr = round(sum(eto_m), 0)
    rain_yr = round(sum(rain_m), 0)
    return {
        "eto_day": eto_d, "eto_month_mm": eto_m, "eto_year_mm": eto_yr,
        "rain_month_mm": rain_m, "rain_year_mm": rain_yr,
        "deficit_year_mm": round(eto_yr - rain_yr, 0),
        "aridity_index": round(rain_yr / eto_yr, 2) if eto_yr else None,
        "source": clim.get("source", "?"),
    }
