"""Tracciamento automatico del CANALE PRINCIPALE a gravità (Argus Total — M6, Fase 2).

Dal punto più alto dell'area (presa) instrada un canale che scende SOLO verso il
basso con una pendenza longitudinale il più possibile COSTANTE (target in ‰),
seguendo il profilo del DEM. Metodo: Dijkstra sulla griglia DEM in cui il costo
di ogni passo penalizza lo scostamento dal dislivello desiderato (grad × distanza)
e vieta la risalita (un canale a gravità non spinge in salita).
"""
from __future__ import annotations

import heapq
import numpy as np

from processing.satellite_export import _utm_bbox, _plan_grid
from .suitability import _poly_mask
from .macroareas import _rdp


def _dem_and_grid(client, geom: dict, max_dim: int = 360):
    epsg, minx, miny, maxx, maxy, to_wgs = _utm_bbox(geom)
    res, wp, hp, nx, ny = _plan_grid(minx, miny, maxx, maxy, max_dim=max_dim, max_tiles=1)
    top = miny + hp * res
    south, east = top - hp * res, minx + wp * res
    dem = client.fetch_dem([minx, south, east, top], epsg, wp, hp).astype("float64")
    mask = _poly_mask(geom, epsg, minx, top, res, wp, hp)
    ctx = dict(epsg=epsg, minx=minx, top=top, res=res, wp=wp, hp=hp, to_wgs=to_wgs)
    return dem, mask, ctx


# vicinato 8-direzionale
_NB = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]


def _route(client, geom: dict, target_permille: float = 1.0,
           tol_up_m: float = 0.05) -> dict:
    """Instrada il canale e ritorna dati grezzi (dem, mask, ctx, percorso in
    celle e in UTM). Riusato dalla Fase 2 (API) e dalla Fase 3 (pivot)."""
    dem, mask, ctx = _dem_and_grid(client, geom)
    res, wp, hp = ctx["res"], ctx["wp"], ctx["hp"]
    to_wgs = ctx["to_wgs"]
    grad = max(1e-4, float(target_permille) / 1000.0)

    valid = mask & np.isfinite(dem)
    if int(valid.sum()) < 10:
        raise RuntimeError("Area troppo piccola o DEM non disponibile.")

    # presa = cella valida più alta; costo Dijkstra da lì (solo discesa)
    demx = np.where(valid, dem, -np.inf)
    s_row, s_col = (int(i) for i in np.unravel_index(int(np.argmax(demx)), demx.shape))

    INF = float("inf")
    dist = np.full((hp, wp), INF)
    prev = np.full((hp, wp, 2), -1, dtype=np.int32)
    dist[s_row, s_col] = 0.0
    pq: list = [(0.0, s_row, s_col)]
    eps = 1e-4  # tie-break minimo sulla lunghezza

    while pq:
        d, r, c = heapq.heappop(pq)
        if d > dist[r, c]:
            continue
        er = dem[r, c]
        for dr, dc in _NB:
            nr, nc = r + dr, c + dc
            if not (0 <= nr < hp and 0 <= nc < wp) or not valid[nr, nc]:
                continue
            en = dem[nr, nc]
            if en > er + tol_up_m:            # vietata la risalita (gravità)
                continue
            dd = res * (1.41421356 if (dr and dc) else 1.0)
            desired = grad * dd
            actual = er - en                  # dislivello reale (>= -tol)
            # scarto QUADRATICO dal dislivello desiderato → dislivelli uniformi
            # (pendenza il più costante possibile lungo il canale).
            step_cost = (actual - desired) ** 2 + eps * dd
            nd = d + step_cost
            if nd < dist[nr, nc]:
                dist[nr, nc] = nd
                prev[nr, nc] = (r, c)
                heapq.heappush(pq, (nd, nr, nc))

    # sbocco = cella di BORDO raggiungibile con quota più bassa (il canale
    # attraversa l'area dalla presa fino a uscire sul lato basso).
    reach = np.isfinite(dist)
    if int(reach.sum()) < 2:
        raise RuntimeError("Impossibile tracciare un canale a gravità nell'area.")
    border = np.zeros((hp, wp), dtype=bool)
    border[:, :] = valid
    inner = np.zeros((hp, wp), dtype=bool)
    inner[1:-1, 1:-1] = (valid[1:-1, 1:-1] & valid[:-2, 1:-1] & valid[2:, 1:-1]
                         & valid[1:-1, :-2] & valid[1:-1, 2:])
    border = valid & ~inner                  # celle valide sul bordo dell'area
    cand = reach & border
    if int(cand.sum()) < 1:
        cand = reach
    demn = np.where(cand, dem, np.inf)
    e_row, e_col = (int(i) for i in np.unravel_index(int(np.argmin(demn)), demn.shape))
    if (e_row, e_col) == (s_row, s_col):
        raise RuntimeError("L'area è pianeggiante o senza dislivello sfruttabile.")

    # ricostruzione percorso presa → sbocco
    path = []
    r, c = e_row, e_col
    while (r, c) != (-1, -1):
        path.append((r, c))
        pr, pc = int(prev[r, c, 0]), int(prev[r, c, 1])
        if (pr, pc) == (-1, -1):
            break
        r, c = pr, pc
    path.reverse()                            # dalla presa (alto) allo sbocco (basso)

    def cell_xy(rc):
        rr, cc = rc
        return (ctx["minx"] + (cc + 0.5) * res, ctx["top"] - (rr + 0.5) * res)

    xy = [cell_xy(p) for p in path]
    return {"dem": dem, "mask": mask, "ctx": ctx, "path": path, "xy": xy}


def trace_canal(client, geom: dict, target_permille: float = 1.0) -> dict:
    """API Fase 2: canale + profilo + statistiche (lon/lat)."""
    r = _route(client, geom, target_permille)
    dem, ctx, path, xy = r["dem"], r["ctx"], r["path"], r["xy"]
    res = ctx["res"]; to_wgs = ctx["to_wgs"]

    profile = []
    cum = 0.0
    for k, (x, y) in enumerate(xy):
        if k > 0:
            cum += ((x - xy[k - 1][0]) ** 2 + (y - xy[k - 1][1]) ** 2) ** 0.5
        profile.append([round(cum, 1), round(float(dem[path[k]]), 2)])
    length_m = cum
    drop_m = float(dem[path[0]]) - float(dem[path[-1]])
    mean_permille = round(1000.0 * drop_m / length_m, 2) if length_m > 0 else 0.0

    # semplifica la polilinea (RDP in UTM) e proietta in lon/lat
    xy_s = _rdp([(float(x), float(y)) for x, y in xy], res * 0.8)
    line_ll = [list(to_wgs.transform(x, y)) for x, y in xy_s]

    # profilo alleggerito (~60 punti)
    if len(profile) > 60:
        step = len(profile) / 60.0
        profile = [profile[int(i * step)] for i in range(60)] + [profile[-1]]

    start_ll = list(to_wgs.transform(*xy[0]))
    end_ll = list(to_wgs.transform(*xy[-1]))
    return {
        "geojson": {"type": "LineString", "coordinates": line_ll},
        "length_m": round(length_m, 1),
        "drop_m": round(drop_m, 2),
        "mean_permille": mean_permille,
        "target_permille": round(float(target_permille), 2),
        "start": start_ll, "end": end_ll,
        "elev_start_m": round(float(dem[path[0]]), 1),
        "elev_end_m": round(float(dem[path[-1]]), 1),
        "profile": profile,
    }
