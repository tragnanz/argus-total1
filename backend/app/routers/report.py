"""Export scheda progetto in PDF brandizzato (Milestone 4)."""
from __future__ import annotations

import math
import threading

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from ..deps import get_client
from ..schemas import ReportIn

from analysis.layout import TRANSPORT_SLOPE

router = APIRouter(prefix="/api/project", tags=["report"])


# Un export alla volta. L'endpoint e' sincrono, quindi FastAPI lo esegue nel
# threadpool: due richieste in parallelo raddoppierebbero il picco di memoria e
# su un'istanza piccola basta questo a far riavviare il servizio. Chi arriva
# dopo aspetta qualche secondo invece di far cadere tutti.
_EXPORT_LOCK = threading.Semaphore(1)
_EXPORT_WAIT_S = 120.0


def _trim_memory() -> None:
    """Restituisce al sistema operativo le pagine liberate.

    Dopo un export l'allocatore di glibc tiene le arene libere nel processo:
    la memoria e' libera per Python ma il sistema continua a vedere l'RSS
    alto, e su un'istanza piccola bastano pochi export per farla riavviare.
    """
    import ctypes
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:  # noqa: BLE001 — non su glibc: si prosegue
        pass

def _ring_area_ha(ring: list[list[float]]) -> float:
    """Area di un anello lon/lat in ettari (proiezione locale equivalente)."""
    if len(ring) < 4:
        return 0.0
    lat0 = sum(p[1] for p in ring) / len(ring)
    kx = 111320.0 * math.cos(math.radians(lat0))
    a = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i][0] * kx, ring[i][1] * 110540.0
        x2, y2 = ring[i + 1][0] * kx, ring[i + 1][1] * 110540.0
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0 / 10000.0


def _covered_ha(ring: list[list[float]], pivots: list[dict], field_ha: float) -> float:
    """Superficie del campo effettivamente coperta dai pivot, in ettari.

    Sommare le aree dei cerchi sbaglia due volte: conta due volte le
    sovrapposizioni e include le parti che escono dal poligono. Si campiona
    quindi una griglia e si misura l'unione dei cerchi intersecata col campo.
    """
    import numpy as np

    if not ring or not pivots or field_ha <= 0:
        return 0.0
    lons = np.array([p[0] for p in ring]); lats = np.array([p[1] for p in ring])
    lat0 = float(lats.mean())
    kx = 111320.0 * math.cos(math.radians(lat0)); ky = 110540.0
    px, py = lons * kx, lats * ky

    # 500x500 in float32: ~1 MB per griglia invece di 4. L'errore sulla
    # copertura resta sotto il decimo di punto percentuale.
    n = 500
    gx = np.linspace(px.min(), px.max(), n, dtype=np.float32)
    gy = np.linspace(py.min(), py.max(), n, dtype=np.float32)
    X, Y = np.meshgrid(gx, gy)

    inside = np.zeros(X.shape, dtype=bool)      # ray casting vettorizzato
    for i in range(len(px) - 1):
        x1, y1, x2, y2 = px[i], py[i], px[i + 1], py[i + 1]
        if y1 == y2:
            continue
        cross = ((y1 > Y) != (y2 > Y)) & (X < (x2 - x1) * (Y - y1) / (y2 - y1) + x1)
        inside ^= cross
    tot = int(inside.sum())
    if not tot:
        return 0.0

    cov = np.zeros(X.shape, dtype=bool)
    dx = np.empty(X.shape, dtype=np.float32)
    dy = np.empty(X.shape, dtype=np.float32)
    for pv in pivots:
        # Operazioni in place: con oltre cento macchine le copie temporanee
        # costerebbero piu' della griglia stessa.
        np.subtract(X, np.float32(pv["lon"] * kx), out=dx)
        np.subtract(Y, np.float32(pv["lat"] * ky), out=dy)
        np.multiply(dx, dx, out=dx)
        np.multiply(dy, dy, out=dy)
        np.add(dx, dy, out=dx)
        cov |= dx <= np.float32(pv["r"] ** 2)
    return field_ha * float((inside & cov).sum()) / tot


def _sheet_kit(body, geom: dict, plan_gj: dict, meta: dict, lang: str, rev: str,
               status: dict) -> dict | None:
    """Prepara la TAVOLA A3: mappa, schede dei pivot e celle del cartiglio.

    Serve il progetto reale: senza pivot disegnati non c'e' nulla da mettere
    nelle schede laterali e si resta sulla tavola semplice.
    """
    import datetime as _dt
    from analysis.report_i18n import tr, fmt_num, fmt_date

    feats = plan_gj.get("features") or []
    pivs = [f for f in feats if (f.get("properties") or {}).get("kind") == "pivot"]
    if not pivs:
        return None

    field_ha = meta.get("field_ha", 0.0) or 0.0
    cards, ring_of = [], []
    for i, f in enumerate(pivs, 1):
        pr = f.get("properties") or {}
        ring = (f.get("geometry") or {}).get("coordinates", [[]])[0]
        if not ring:
            continue
        lons = [p[0] for p in ring]; lats = [p[1] for p in ring]
        lat = (min(lats) + max(lats)) / 2.0
        lon = (min(lons) + max(lons)) / 2.0
        r = pr.get("r")
        if not r:      # ricavato dal raggio del cerchio, se non arriva dal client
            r = (max(lats) - min(lats)) / 2.0 * 110540.0
        ha = _ring_area_ha(ring)
        cards.append({
            "n": i, "lat": pr.get("lat", lat), "lon": pr.get("lng", lon),
            "r": round(r), "ha": ha,
            "pct": (ha / field_ha * 100.0) if field_ha else None,
            "q_m3h": pr.get("q_m3h"), "p_bar": pr.get("p_bar"), "elev": pr.get("z"),
        })
        ring_of.append(ring)

    rings = [geom["coordinates"][0]] + [r for r in (body.plan_rings or [])]
    pipes = [(f.get("geometry") or {}).get("coordinates", [])
             for f in feats if (f.get("properties") or {}).get("kind") == "pipe"]
    canals = list(body.plan_canals or [])

    from analysis.report import plan_map_png
    png, denom = plan_map_png(rings, cards, pipes, canals, lang=lang, status=status)

    all_lat = [c["lat"] for c in cards] or [0.0]
    all_lon = [c["lon"] for c in cards] or [0.0]
    centre = (sum(all_lat) / len(all_lat), sum(all_lon) / len(all_lon))

    net = _covered_ha(geom["coordinates"][0], cards, field_ha)
    non = max(0.0, field_ha - net)
    scale = f"1:{round(denom / 500) * 500:d}"
    now = _dt.datetime.now()
    cells = [
        (tr(lang, "ps_cliente"), body.client_name or "—"),
        (tr(lang, "ps_riferimento"), body.project_name or "—"),
        (tr(lang, "ps_sup_campo"), f"{fmt_num(lang, field_ha, 2)} ha"),
        (tr(lang, "ps_copertura"), f"{fmt_num(lang, (net / field_ha * 100.0) if field_ha else 0, 1)} %"),
        (tr(lang, "ps_cop_non"), f"{fmt_num(lang, net, 1)} / {fmt_num(lang, non, 1)} ha"),
        (tr(lang, "ps_macchine"), f"{len(cards)} · {scale}"),
        (tr(lang, "ps_data"), f"{fmt_date(lang, now.date())} {now:%H:%M}"),
    ]
    return {"map_png": png, "pivots": cards, "centre": centre, "cells": cells,
            "rev": f"{rev} · {now:%Y-%m-%d}"}


def _real_plan(body, lay) -> tuple[dict, dict]:
    """Sostituisce layout e conteggi con il progetto realmente disegnato.

    Ritorna (geojson da disegnare, meta per scheda e titolo). Senza `plan_fc`
    restituisce il layout ricalcolato, come prima.
    """
    fc = body.plan_fc or {}
    feats = list(fc.get("features") or [])
    if not feats:
        return lay["geojson"], lay["meta"]

    # I canali arrivano a parte (sono livelli di rilievo, non del layout).
    for coords in (body.plan_canals or []):
        if coords and len(coords) >= 2:
            feats.append({"type": "Feature", "properties": {"kind": "canal"},
                          "geometry": {"type": "LineString", "coordinates": coords}})

    meta = dict(lay["meta"])
    pivots = [f for f in feats if (f.get("properties") or {}).get("kind") == "pivot"]
    net_ha = sum(_ring_area_ha((f.get("geometry") or {}).get("coordinates", [[]])[0]) for f in pivots)
    field_ha = meta.get("field_ha", 0.0) or 0.0

    old_net = meta.get("net_ha") or 0.0
    meta["n_pivots"] = len(pivots)
    meta["net_ha"] = net_ha
    if field_ha > 0:
        meta["packing_pct"] = net_ha / field_ha * 100.0
        meta["coverage_pct"] = net_ha / field_ha * 100.0
    # Il fabbisogno segue la superficie irrigata: si riscalano i totali, non i
    # valori unitari (che restano quelli del dimensionamento).
    if old_net > 0 and net_ha > 0:
        k = net_ha / old_net
        w = dict(meta.get("water") or {})
        for key in ("q_total_ls", "q_total_m3h", "vol_total_day_m3"):
            if w.get(key):
                w[key] = w[key] * k
        meta["water"] = w
    # Il progetto reale non ha fasi: una sola classe in legenda.
    meta["n_phases"] = 1
    meta["phases"] = []
    return {"type": "FeatureCollection", "features": feats}, meta



@router.post("/report")
def project_report(body: ReportIn, client=Depends(get_client)):
    geom = body.geom.model_dump()
    transport = body.transport
    slope_max = body.slope_max_pct if body.slope_max_pct is not None \
        else TRANSPORT_SLOPE.get(transport, TRANSPORT_SLOPE["buried"])["max"]

    ring = geom["coordinates"][0]
    want_sheet = bool(body.include_sheet)
    want_plan = bool(body.include_plan)
    if not want_sheet and not want_plan:
        raise HTTPException(400, "Seleziona almeno una sezione da stampare.")
    has_real = bool((body.plan_fc or {}).get("features"))

    # Stampando la SOLA tavola di un progetto gia' disegnato non serve
    # ricalcolare il layout: della scheda non si usa nulla, e compute_layout su
    # un poligono di migliaia di ettari e' la parte piu' pesante dell'export.
    # Basta la superficie del campo, che si ricava dal poligono.
    if has_real and not want_sheet:
        lay = {"geojson": {"type": "FeatureCollection", "features": []},
               "meta": {"field_ha": _ring_area_ha(ring), "n_phases": 1, "phases": [],
                        "config": body.config, "radius_m": body.radius_m,
                        "net_ha": 0.0, "water": {}}}
        return _finish(body, geom, ring, lay, None, want_sheet, want_plan)

    layout_params = {
        "config": body.config, "radius_m": body.radius_m, "gap_m": body.gap_m,
        "transport": transport, "slope_max_pct": slope_max,
        "auto_orient": body.auto_orient, "canal_azimuth_deg": body.canal_azimuth_deg,
        "canal_flip": body.canal_flip,
        "only_suitable": body.only_suitable, "min_suitability": body.min_suitability,
        "date": body.date, "overhang_pct": body.overhang_pct,
        "n_phases": body.n_phases, "phase_order": body.phase_order,
        "kc_peak": body.kc_peak, "efficiency": body.efficiency, "hours_per_day": body.hours_per_day,
    }
    # scipy/scikit-image entrano in memoria solo se il layout va ricalcolato
    from analysis.layout import compute_layout
    try:
        lay = compute_layout(client, geom, layout_params)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore layout per la scheda: {e}")

    suit_meta = None
    if body.include_suitability and body.date:
        try:
            from analysis.suitability import compute_suitability
            sp = {"weights": body.suit_weights.model_dump(),
                  "slope_ideal_pct": TRANSPORT_SLOPE.get(transport, TRANSPORT_SLOPE["buried"])["ideal"],
                  "slope_max_pct": slope_max}
            suit_meta = compute_suitability(client, geom, body.date, sp)["meta"]
        except Exception:  # noqa: BLE001 — la scheda si genera comunque senza idoneità
            suit_meta = None

    return _finish(body, geom, ring, lay, suit_meta, want_sheet, want_plan)


def _finish(body, geom: dict, ring: list, lay: dict, suit_meta, want_sheet: bool,
            want_plan: bool):
    """Dal layout (vero o minimo) al PDF: disegno, composizione, risposta."""
    import gc
    from ..main import REV
    from analysis.report import layout_schematic_png, build_pdf

    lat0 = sum(p[1] for p in ring) / len(ring)
    info = {"project_name": body.project_name, "client_name": body.client_name, "notes": body.notes}
    lang = body.lang or "it"
    # Se il client manda il progetto reale (pivot e tubazioni disegnati a mano),
    # e' quello a fare testo: la tavola e i conteggi devono corrispondere a cio'
    # che l'utente vede sulla mappa, non a un layout ricalcolato.
    plan_gj, meta = _real_plan(body, lay)

    if not _EXPORT_LOCK.acquire(timeout=_EXPORT_WAIT_S):
        raise HTTPException(503, "Server occupato con un'altra esportazione. Riprova fra poco.")
    status: dict = {}
    try:
        kit = None
        png = b""
        if want_plan:
            # Con il progetto reale si stampa la TAVOLA A3; altrimenti si resta
            # sulla tavola A4 generata dal layout ricalcolato.
            kit = _sheet_kit(body, geom, plan_gj, meta, lang, f"v{REV}", status)
            if kit is None:
                png = layout_schematic_png(plan_gj, meta, lat0, lang=lang,
                                           field_geom=geom, status=status)
        pdf = build_pdf(info, meta.get("field_ha", 0.0), suit_meta, meta, png,
                        f"v{REV}", lang=lang, with_sheet=want_sheet, with_plan=want_plan,
                        sheet_kit=kit)
        # La mappa e il layout pesano decine di MB: si lasciano andare prima di
        # tenere in memoria anche il PDF finito.
        if kit:
            kit["map_png"] = b""
        kit = None; png = b""; plan_gj = None; lay = None
        gc.collect()
        _trim_memory()
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Errore generazione PDF: {e}")
    finally:
        _EXPORT_LOCK.release()

    fname = "".join(c if c.isalnum() or c in "-_" else "_" for c in body.project_name)[:40] or "scheda"
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="scheda_{fname}.pdf"',
                             # Diagnostica: dice se l'ortofoto e' stata scaricata.
                             "X-Argus-Basemap": str(status.get("basemap", "none")),
                             "X-Argus-Basemap-Error": str(status.get("error", ""))[:180],
                             "Access-Control-Expose-Headers": "X-Argus-Basemap, X-Argus-Basemap-Error"})
