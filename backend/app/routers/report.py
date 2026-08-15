"""Export scheda progetto in PDF brandizzato (Milestone 4)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from ..deps import get_client
from ..schemas import ReportIn

from analysis.layout import compute_layout, TRANSPORT_SLOPE
from analysis.suitability import compute_suitability
from analysis.report import layout_schematic_png, build_pdf

router = APIRouter(prefix="/api/project", tags=["report"])


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
    try:
        png = layout_schematic_png(lay["geojson"], lay["meta"], lat0, lang=lang,
                                   field_geom=geom)
        pdf = build_pdf(info, lay["meta"].get("field_ha", 0.0), suit_meta, lay["meta"], png, f"v{REV}", lang=lang)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Errore generazione PDF: {e}")

    fname = "".join(c if c.isalnum() or c in "-_" else "_" for c in body.project_name)[:40] or "scheda"
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="scheda_{fname}.pdf"'})
