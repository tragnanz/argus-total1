"""Export scheda progetto in PDF brandizzato (Milestone 4)."""
from __future__ import annotations

import math

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from ..deps import get_client
from ..schemas import ReportIn

from analysis.layout import compute_layout, TRANSPORT_SLOPE
from analysis.suitability import compute_suitability
from analysis.report import layout_schematic_png, build_pdf

router = APIRouter(prefix="/api/project", tags=["report"])

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
    from ..main import REV  # import lazy per evitare cicli
    geom = body.geom.model_dump()
    transport = body.transport
    slope_max = body.slope_max_pct if body.slope_max_pct is not None \
        else TRANSPORT_SLOPE.get(transport, TRANSPORT_SLOPE["buried"])["max"]

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
    try:
        lay = compute_layout(client, geom, layout_params)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore layout per la scheda: {e}")

    suit_meta = None
    if body.include_suitability and body.date:
        try:
            sp = {"weights": body.suit_weights.model_dump(),
                  "slope_ideal_pct": TRANSPORT_SLOPE.get(transport, TRANSPORT_SLOPE["buried"])["ideal"],
                  "slope_max_pct": slope_max}
            suit_meta = compute_suitability(client, geom, body.date, sp)["meta"]
        except Exception:  # noqa: BLE001 — la scheda si genera comunque senza idoneità
            suit_meta = None

    ring = geom["coordinates"][0]
    lat0 = sum(p[1] for p in ring) / len(ring)
    info = {"project_name": body.project_name, "client_name": body.client_name, "notes": body.notes}
    lang = body.lang or "it"
    # Almeno una sezione deve essere richiesta, altrimenti il file sarebbe vuoto.
    want_sheet = bool(body.include_sheet)
    want_plan = bool(body.include_plan)
    if not want_sheet and not want_plan:
        raise HTTPException(400, "Seleziona almeno una sezione da stampare.")
    # Se il client manda il progetto reale (pivot e tubazioni disegnati a mano),
    # e' quello a fare testo: la tavola e i conteggi devono corrispondere a cio'
    # che l'utente vede sulla mappa, non a un layout ricalcolato.
    plan_gj, meta = _real_plan(body, lay)

    status: dict = {}
    try:
        # Senza planimetria si evita anche lo scaricamento delle tessere.
        png = layout_schematic_png(plan_gj, meta, lat0, lang=lang,
                                   field_geom=geom, status=status) if want_plan else b""
        pdf = build_pdf(info, meta.get("field_ha", 0.0), suit_meta, meta, png,
                        f"v{REV}", lang=lang, with_sheet=want_sheet, with_plan=want_plan)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Errore generazione PDF: {e}")

    fname = "".join(c if c.isalnum() or c in "-_" else "_" for c in body.project_name)[:40] or "scheda"
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="scheda_{fname}.pdf"',
                             # Diagnostica: dice se l'ortofoto e' stata scaricata.
                             "X-Argus-Basemap": str(status.get("basemap", "none")),
                             "X-Argus-Basemap-Error": str(status.get("error", ""))[:180],
                             "Access-Control-Expose-Headers": "X-Argus-Basemap, X-Argus-Basemap-Error"})
