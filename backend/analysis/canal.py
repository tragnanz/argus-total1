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
import pyproj

from processing.satellite_export import _utm_bbox, _plan_grid
from .suitability import _poly_mask
from .macroareas import _rdp


def _smooth(dem: np.ndarray) -> np.ndarray:
    """DEM lisciato (mediana 3×3) per il routing a gravità: elimina i dossi/buche
    di un solo pixel (rumore) che altrimenti bloccano la propagazione a valle o
    rendono la presa un falso minimo locale. Le quote grezze restano per il
    profilo mostrato all'utente."""
    from scipy.ndimage import median_filter
    fill = float(np.nanmedian(dem)) if np.isfinite(dem).any() else 0.0
    demf = np.where(np.isfinite(dem), dem, fill)
    return median_filter(demf, size=3, mode="nearest")


def _snap_cell(ctx, valid, to_utm, lon: float, lat: float):
    """Cella (row, col) del punto lon/lat, agganciata alla cella valida più vicina."""
    x, y = to_utm.transform(lon, lat)
    col = int((x - ctx["minx"]) / ctx["res"]); row = int((ctx["top"] - y) / ctx["res"])
    hp, wp = ctx["hp"], ctx["wp"]
    if 0 <= row < hp and 0 <= col < wp and valid[row, col]:
        return row, col
    ys, xs = np.where(valid)
    if len(xs) == 0:
        raise RuntimeError("Area non valida per il canale.")
    k = int(np.argmin((xs - col) ** 2 + (ys - row) ** 2))
    return int(ys[k]), int(xs[k])


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
           tol_up_m: float = 1.0, start_ll=None, end_ll=None, bundle=None) -> dict:
    """Instrada il canale e ritorna dati grezzi (dem, mask, ctx, percorso in
    celle e in UTM). Riusato dalla Fase 2 (API) e dalla Fase 3 (pivot).
    Se start_ll/end_ll (lon,lat) sono dati, presa/finale sono manuali.
    `bundle` = (dem, mask, ctx) precalcolato, per riusare il DEM fra più segmenti
    (tracciatura con waypoint) senza rifare la chiamata satellitare."""
    dem, mask, ctx = bundle if bundle is not None else _dem_and_grid(client, geom)
    res, wp, hp = ctx["res"], ctx["wp"], ctx["hp"]
    to_wgs = ctx["to_wgs"]
    to_utm = pyproj.Transformer.from_crs(4326, ctx["epsg"], always_xy=True)
    grad = max(1e-4, float(target_permille) / 1000.0)

    valid = mask & np.isfinite(dem)
    if int(valid.sum()) < 10:
        raise RuntimeError("Area troppo piccola o DEM non disponibile.")

    # presa: manuale se indicata, altrimenti la cella valida più alta
    if start_ll is not None:
        s_row, s_col = _snap_cell(ctx, valid, to_utm, start_ll[0], start_ll[1])
    else:
        demx = np.where(valid, dem, -np.inf)
        s_row, s_col = (int(i) for i in np.unravel_index(int(np.argmax(demx)), demx.shape))

    demS = _smooth(dem)                       # quote lisciate per il routing
    head = float(demS[s_row, s_col])          # carico idraulico della presa
    head_cap = head + max(0.5, float(tol_up_m))  # mai sopra il carico (tol rumore)
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
        er = demS[r, c]
        for dr, dc in _NB:
            nr, nc = r + dr, c + dc
            if not (0 <= nr < hp and 0 <= nc < wp) or not valid[nr, nc]:
                continue
            en = demS[nr, nc]
            # A gravità l'acqua non può superare la quota (carico) della presa.
            # Sul DEM lisciato questo basta: il costo quadratico spinge comunque
            # verso una discesa regolare. Un blocco 'strettamente in discesa'
            # cella-per-cella si ferma al primo dosso di rumore e non raggiunge i
            # finali lontani anche quando il dislivello complessivo c'è.
            if en > head_cap:
                continue
            dd = res * (1.41421356 if (dr and dc) else 1.0)
            desired = grad * dd
            actual = er - en                  # dislivello reale (può essere <0)
            # scarto QUADRATICO dal dislivello desiderato → dislivelli uniformi
            # (pendenza il più costante possibile lungo il canale).
            step_cost = (actual - desired) ** 2 + eps * dd
            nd = d + step_cost
            if nd < dist[nr, nc]:
                dist[nr, nc] = nd
                prev[nr, nc] = (r, c)
                heapq.heappush(pq, (nd, nr, nc))

    # sbocco: manuale se indicato, altrimenti la cella di BORDO raggiungibile
    # con quota più bassa (il canale attraversa l'area dalla presa fino a
    # uscire sul lato basso).
    reach = np.isfinite(dist)
    if int(reach.sum()) < 2:
        raise RuntimeError("Impossibile tracciare un canale a gravità nell'area.")
    if end_ll is not None:
        e_row, e_col = _snap_cell(ctx, valid, to_utm, end_ll[0], end_ll[1])
        if not np.isfinite(dist[e_row, e_col]):
            raise RuntimeError(
                "Punto finale non raggiungibile in discesa dalla presa: "
                "si trova più in alto o oltre una risalita. Scegli un finale "
                "più a valle o sposta la presa.")
        if (e_row, e_col) == (s_row, s_col):
            raise RuntimeError("Presa e finale coincidono: scegli due punti distinti.")
    else:
        border = np.zeros((hp, wp), dtype=bool)
        border[:, :] = valid
        inner = np.zeros((hp, wp), dtype=bool)
        inner[1:-1, 1:-1] = (valid[1:-1, 1:-1] & valid[:-2, 1:-1] & valid[2:, 1:-1]
                             & valid[1:-1, :-2] & valid[1:-1, 2:])
        border = valid & ~inner              # celle valide sul bordo dell'area
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


def _finalize(dem, ctx, path, xy, target_permille, waypoints_ll=None) -> dict:
    """Da (path in celle, xy in UTM) → output API: geojson, profilo, statistiche."""
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

    xy_s = _rdp([(float(x), float(y)) for x, y in xy], res * 0.8)
    line_ll = [list(to_wgs.transform(x, y)) for x, y in xy_s]

    if len(profile) > 60:
        step = len(profile) / 60.0
        profile = [profile[int(i * step)] for i in range(60)] + [profile[-1]]

    return {
        "geojson": {"type": "LineString", "coordinates": line_ll},
        "length_m": round(length_m, 1),
        "drop_m": round(drop_m, 2),
        "mean_permille": mean_permille,
        "target_permille": round(float(target_permille), 2),
        "start": list(to_wgs.transform(*xy[0])),
        "end": list(to_wgs.transform(*xy[-1])),
        "elev_start_m": round(float(dem[path[0]]), 1),
        "elev_end_m": round(float(dem[path[-1]]), 1),
        "profile": profile,
        "waypoints": [list(w) for w in (waypoints_ll or [])],
    }


def trace_manual(client, geom: dict, coords_ll: list, target_permille: float = 1.0) -> dict:
    """Canale tracciato A MANO: prende la polilinea disegnata (lon/lat) e ne
    campiona la quota lungo il DEM per lunghezza, dislivello, pendenza e profilo.
    Non re-instrada (è manuale); se sale, il dislivello sarà negativo."""
    if not coords_ll or len(coords_ll) < 2:
        raise RuntimeError("Servono almeno due punti per il canale manuale.")
    dem, mask, ctx = _dem_and_grid(client, geom)
    res, wp, hp = ctx["res"], ctx["wp"], ctx["hp"]
    to_utm = pyproj.Transformer.from_crs(4326, ctx["epsg"], always_xy=True)
    pts = [to_utm.transform(float(lo), float(la)) for lo, la in coords_ll]
    # densifica a passo ~res per un profilo regolare
    xy = [pts[0]]
    for i in range(1, len(pts)):
        x0, y0 = pts[i - 1]; x1, y1 = pts[i]
        d = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        n = max(1, int(d / res))
        for k in range(1, n + 1):
            xy.append((x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n))

    def to_cell(x, y):
        row = min(hp - 1, max(0, int((ctx["top"] - y) / res)))
        col = min(wp - 1, max(0, int((x - ctx["minx"]) / res)))
        return (row, col)

    path = [to_cell(x, y) for x, y in xy]
    return _finalize(dem, ctx, path, xy, target_permille)


def trace_canal(client, geom: dict, target_permille: float = 1.0,
                start_ll=None, end_ll=None, waypoints=None) -> dict:
    """API Fase 2: canale + profilo + statistiche (lon/lat).
    Se start_ll/end_ll (lon,lat) sono dati, presa/finale sono manuali.
    Se `waypoints` (lista di [lon,lat]) è data, il percorso passa in ordine per
    quei punti: la tracciatura è la concatenazione di segmenti presa→wp1→…→finale,
    ognuno instradato in DISCESA (l'acqua scorre a gravità). Un waypoint più in
    alto del punto precedente rende il segmento non percorribile → errore chiaro."""
    wps = [list(w) for w in (waypoints or [])]
    if not wps:
        r = _route(client, geom, target_permille, start_ll=start_ll, end_ll=end_ll)
        return _finalize(r["dem"], r["ctx"], r["path"], r["xy"], target_permille)

    if start_ll is None or end_ll is None:
        raise RuntimeError("Con i waypoint servono presa e finale definiti.")
    bundle = _dem_and_grid(client, geom)          # DEM una sola volta per tutti i segmenti
    pts = [list(start_ll)] + wps + [list(end_ll)]
    path_all: list = []
    xy_all: list = []
    for i in range(len(pts) - 1):
        seg = _route(client, geom, target_permille,
                     start_ll=pts[i], end_ll=pts[i + 1], bundle=bundle)
        p, x = seg["path"], seg["xy"]
        if i > 0:                                  # evita di duplicare il nodo condiviso
            p = p[1:]; x = x[1:]
        path_all.extend(p); xy_all.extend(x)
    dem, _mask, ctx = bundle
    return _finalize(dem, ctx, path_all, xy_all, target_permille, waypoints_ll=wps)
