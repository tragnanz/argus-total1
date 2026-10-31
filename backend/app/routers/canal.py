"""Endpoint tracciamento canale principale a gravità (Milestone 6, Fase 2)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..deps import get_client
from ..schemas import BranchIn, BranchOut, CanalIn, CanalOut

from analysis.branch import branch_pivots
from analysis.canal import trace_canal, trace_manual, trace_manual_snap

router = APIRouter(prefix="/api/canal", tags=["canal"])


@router.post("", response_model=CanalOut)
def canal(body: CanalIn, client=Depends(get_client)):
    try:
        if body.manual and body.snap:
            out = trace_manual_snap(client, body.geom.model_dump(), body.manual,
                                    target_permille=body.target_permille,
                                    buffer_m=body.snap_buffer_m)
        elif body.manual:
            out = trace_manual(client, body.geom.model_dump(), body.manual,
                               target_permille=body.target_permille)
        else:
            out = trace_canal(
                client, body.geom.model_dump(),
                target_permille=body.target_permille,
                start_ll=body.start, end_ll=body.end, waypoints=body.waypoints,
            )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore tracciamento canale: {e}")
    return CanalOut(**out)


@router.post("/branch", response_model=BranchOut)
def branch(body: BranchIn, client=Depends(get_client)):
    """Posa in automatico fino a N pivot lungo il canale, con la tubazione più
    corta per alimentarne ciascuno dal canale (Accessori)."""
    try:
        out = branch_pivots(body.geom.model_dump(), body.canal, {
            "radius_m": body.radius_m, "gap_m": body.gap_m, "clear_m": body.clear_m,
            "canal_width_m": body.canal_width_m, "max_pivots": body.max_pivots,
            "side": body.side, "existing": body.existing,
        })
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore diramazioni: {e}")
    return BranchOut(**out)


class RouteIn(BaseModel):
    src: list[float]                                   # [lon, lat] presa
    dst: list[float]                                   # [lon, lat] vasca
    mode: str = "pipe"                                 # pipe | canal
    roads: list[list[list[float]]] | None = None       # strade da seguire
    edges: list[list[list[float]]] | None = None       # bordi dei campi
    circles: list[list[float]] | None = None           # [lon, lat, r] da evitare
    target_permille: float = 0.3
    climb_m: float = 15.0                              # metri di percorso equivalenti a 1 m di risalita


@router.post("/route")
def auto_route_ep(body: RouteIn, client=Depends(get_client)):
    """Tracciato automatico presa → vasca: condotta (strade, bordi, meno risalite) o canale a gravità."""
    from analysis.route import auto_route
    if len(body.src) != 2 or len(body.dst) != 2:
        raise HTTPException(400, "Presa e vasca non valide.")
    try:
        return auto_route(client, body.src, body.dst, mode=body.mode, roads=body.roads, edges=body.edges,
                          circles=body.circles, target_permille=body.target_permille, climb_m=body.climb_m)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Errore tracciato automatico: {e}")
