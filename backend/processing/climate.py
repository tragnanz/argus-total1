"""Normali climatici mensili per una località (lat, lon).

Sorgente primaria: NASA POWER — Prediction Of Worldwide Energy Resources
(climatology endpoint), gratuito, senza chiave API, copertura globale.
https://power.larc.nasa.gov/

Se la rete non è raggiungibile (es. ambiente di test isolato) si ricade su una
climatologia sintetica dipendente dalla latitudine, chiaramente marcata come
tale nella risposta (climate_source = "stima sintetica").
"""
from __future__ import annotations

import math

import requests

POWER_URL = "https://power.larc.nasa.gov/api/temporal/climatology/point"
PARAMS = "T2M_MAX,T2M_MIN,RH2M,WS2M,ALLSKY_SFC_SW_DWN,PRECTOTCORR"
MONTH_KEYS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
              "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def _months(block: dict) -> list[float]:
    return [float(block[k]) for k in MONTH_KEYS]


def fetch_power(lat: float, lon: float, timeout: float = 25.0) -> dict:
    """Scarica i normali climatici mensili da NASA POWER.

    Ritorna dict con liste di 12 valori: tmax, tmin, rh, wind (m/s a 2 m),
    rs (MJ/m²/giorno), rain (mm/mese). Solleva eccezione in caso di errore rete.
    """
    r = requests.get(POWER_URL, params={
        "parameters": PARAMS, "community": "AG",
        "latitude": lat, "longitude": lon, "format": "JSON",
    }, timeout=timeout)
    r.raise_for_status()
    j = r.json()
    p = j["properties"]["parameter"]
    units = (j.get("parameters") or {})
    # radiazione: POWER può restituirla in MJ/m²/day o kWh/m²/day → normalizza a MJ
    rs = _months(p["ALLSKY_SFC_SW_DWN"])
    ru = str(units.get("ALLSKY_SFC_SW_DWN", {}).get("units", "")).lower()
    if "kw" in ru:                     # kWh/m²/day → MJ/m²/day
        rs = [v * 3.6 for v in rs]
    # precipitazione: PRECTOTCORR è in mm/giorno → mm/mese
    rain_day = _months(p["PRECTOTCORR"])
    rain = [v * DAYS_IN_MONTH[i] for i, v in enumerate(rain_day)]
    return {
        "tmax": _months(p["T2M_MAX"]),
        "tmin": _months(p["T2M_MIN"]),
        "rh": _months(p["RH2M"]),
        "wind": _months(p["WS2M"]),
        "rs": rs,
        "rain": rain,
        "source": "NASA POWER",
    }


def fetch_elevation(lat: float, lon: float, timeout: float = 12.0) -> float:
    """Quota (m) del punto via Open-Meteo elevation API. 0 se non disponibile."""
    try:
        r = requests.get("https://api.open-meteo.com/v1/elevation",
                         params={"latitude": lat, "longitude": lon}, timeout=timeout)
        r.raise_for_status()
        return float(r.json()["elevation"][0])
    except Exception:  # noqa: BLE001
        return 0.0


def synthetic_climate(lat: float) -> dict:
    """Climatologia mensile sintetica dipendente dalla latitudine (fallback).

    Modello stagionale semplice: sinusoide su temperatura e radiazione con
    ampiezza crescente verso i poli; pioggia con minimo estivo tipico
    mediterraneo alle medie latitudini. Solo per demo/test senza rete."""
    absl = abs(lat)
    north = lat >= 0
    tmax, tmin, rh, wind, rs, rain = [], [], [], [], [], []
    base_t = 27 - 0.45 * absl          # media annua approssimata
    amp = 4 + 0.18 * absl              # escursione stagionale
    for m in range(12):
        # fase: picco a luglio (nord) / gennaio (sud)
        phase = (m - 6) if north else (m - 0)
        seas = math.cos(2 * math.pi * phase / 12)
        tm = base_t + amp * seas
        tmax.append(round(tm + 6, 1))
        tmin.append(round(tm - 5, 1))
        rh.append(round(65 - 12 * seas, 1))
        wind.append(2.2)
        # radiazione (MJ/m²/g): alta d'estate, dipende da latitudine
        rs.append(round(max(3.0, 20 + 9 * seas - 0.12 * absl), 1))
        # pioggia: minimo estivo alle medie latitudini
        rain.append(round(max(5.0, 60 - 35 * seas), 1))
    return {"tmax": tmax, "tmin": tmin, "rh": rh, "wind": wind, "rs": rs,
            "rain": rain, "source": "stima sintetica"}


def get_climate(lat: float, lon: float, allow_network: bool = True) -> tuple[dict, float]:
    """Ritorna (climate, elevation). Prova NASA POWER; su errore usa il sintetico."""
    if allow_network:
        try:
            clim = fetch_power(lat, lon)
            elev = fetch_elevation(lat, lon)
            return clim, elev
        except Exception:  # noqa: BLE001
            pass
    return synthetic_climate(lat), 0.0


def fetch_daily_rain(lat: float, lon: float, start: str, end: str,
                     timeout: float = 25.0) -> dict:
    """Pioggia GIORNALIERA (mm) da NASA POWER daily. start/end date ISO (YYYY-MM-DD).
    Ritorna {data ISO: mm}. Su errore di rete ritorna {} (i ristagni restano
    'indeterminati' invece di rompere l'analisi)."""
    s, e = start.replace("-", ""), end.replace("-", "")
    try:
        r = requests.get("https://power.larc.nasa.gov/api/temporal/daily/point", params={
            "parameters": "PRECTOTCORR", "community": "AG",
            "latitude": lat, "longitude": lon, "start": s, "end": e, "format": "JSON",
        }, timeout=timeout)
        r.raise_for_status()
        d = r.json()["properties"]["parameter"]["PRECTOTCORR"]
        out = {}
        for k, v in d.items():
            if v is None or v < -900:      # POWER usa -999 per i mancanti
                continue
            out[f"{k[0:4]}-{k[4:6]}-{k[6:8]}"] = float(v)
        return out
    except Exception:  # noqa: BLE001
        return {}
