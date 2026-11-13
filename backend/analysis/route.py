"""Tracciato automatico presa → vasca (fonte d'acqua).

Condotta in pressione: percorso più corto sul DEM con un costo che premia
strade e bordi dei campi (scavo e posa più facili, niente attraversamenti di
colture), penalizza l'attraversamento dei cerchi irrigati e ogni metro di
risalita (alza la prevalenza delle pompe).

Canale a gravità: si riusa l'instradamento del canale principale (pendenza il
più costante possibile, mai sopra il carico della presa) tra presa e vasca;
in uscita anche gli scavi e i rilevati lungo il tracciato.
"""
from __future__ import annotations

import heapq
import math

import numpy as np
import pyproj

from .canal import _dem_and_grid, _NB, _smooth, _snap_cell, _route
from .macroareas import _rdp


def _bbox_geom(pts: list, margin_m: float) -> dict:
    lons = [p[0] for p in pts]; lats = [p[1] for p in pts]
    lat0 = sum(lats) / len(lats)
    dlat = margin_m / 110540.0
    dlon = margin_m / (111320.0 * max(0.1, math.cos(math.radians(lat0))))
    x0, x1 = min(lons) - dlon, max(lons) + dlon
    y0, y1 = min(lats) - dlat, max(lats) + dlat
    return {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}


def _burn_lines(shape, ctx, to_utm, lines: list, radius_m: float) -> np.ndarray:
    """Maschera delle celle entro radius_m dalle polilinee (lon/lat)."""
    hp, wp = shape
    res = ctx["res"]
    out = np.zeros(shape, dtype=bool)
    rc = max(0, int(math.ceil(radius_m / res)))
    for ln in lines or []:
        if not ln or len(ln) < 2:
            continue
        xy = [to_utm.transform(float(p[0]), float(p[1])) for p in ln]
        for (xa, ya), (xb, yb) in zip(xy[:-1], xy[1:]):
            seg = math.hypot(xb - xa, yb - ya)
            n = max(1, int(seg / (res * 0.5)))
            for k in range(n + 1):
                x = xa + (xb - xa) * k / n; y = ya + (yb - ya) * k / n
                c = int((x - ctx["minx"]) / res); r = int((ctx["top"] - y) / res)
                r0, r1 = max(0, r - rc), min(hp, r + rc + 1)
                c0, c1 = max(0, c - rc), min(wp, c + rc + 1)
                if r0 < r1 and c0 < c1:
                    out[r0:r1, c0:c1] = True
    return out


def _burn_circles(shape, ctx, to_utm, circles: list) -> np.ndarray:
    hp, wp = shape
    res = ctx["res"]
    out = np.zeros(shape, dtype=bool)
    if not circles:
        return out
    rows, cols = np.mgrid[0:hp, 0:wp]
    xs = ctx["minx"] + (cols + 0.5) * res
    ys = ctx["top"] - (rows + 0.5) * res
    for c in circles:
        try:
            x, y = to_utm.transform(float(c[0]), float(c[1])); r = float(c[2])
        except Exception:  # noqa: BLE001
            continue
        out |= (xs - x) ** 2 + (ys - y) ** 2 <= (r * 0.95) ** 2
    return out


def _profile(dem, ctx, xy_path, path_cells):
    prof, cum = [], 0.0
    for k, (x, y) in enumerate(xy_path):
        if k:
            cum += math.hypot(x - xy_path[k - 1][0], y - xy_path[k - 1][1])
        prof.append([round(cum, 1), round(float(dem[path_cells[k]]), 2)])
    return prof, cum


def auto_route(client, src_ll: list, dst_ll: list, mode: str = "pipe", roads: list | None = None,
               edges: list | None = None, circles: list | None = None,
               target_permille: float = 0.3, climb_m: float = 15.0) -> dict:
    d0 = math.hypot((src_ll[0] - dst_ll[0]) * 111320 * math.cos(math.radians(src_ll[1])),
                    (src_ll[1] - dst_ll[1]) * 110540)
    geom = _bbox_geom([src_ll, dst_ll], max(400.0, 0.35 * d0))
    dem, mask, ctx = _dem_and_grid(client, geom, max_dim=320)
    res, hp, wp = ctx["res"], ctx["hp"], ctx["wp"]
    to_utm = pyproj.Transformer.from_crs(4326, ctx["epsg"], always_xy=True)
    to_wgs = ctx["to_wgs"]
    valid = mask & np.isfinite(dem)

    if mode == "canal":
        r = _route(client, geom, target_permille=target_permille, tol_up_m=1.0,
                   start_ll=src_ll, end_ll=dst_ll, bundle=(dem, mask, ctx))
        path, xy = r["path"], r["xy"]
        prof, length = _profile(dem, ctx, xy, path)
        z0 = float(_smooth(dem)[path[0]])
        s = max(1e-5, target_permille / 1000.0)
        cut = max(0.0, max(z - (z0 - s * d) + 0.5 for d, z in prof))
        fill = max(0.0, max((z0 - s * d) + 0.5 - z for d, z in prof))
    else:
        cost = np.ones((hp, wp))
        if edges:
            cost[_burn_lines((hp, wp), ctx, to_utm, edges, 15.0)] = 0.8
        if roads:
            cost[_burn_lines((hp, wp), ctx, to_utm, roads, 20.0)] = 0.55
        if circles:
            cost[_burn_circles((hp, wp), ctx, to_utm, circles)] = 2.5
        demS = _smooth(dem)
        s_rc = _snap_cell(ctx, valid, to_utm, src_ll[0], src_ll[1])
        e_rc = _snap_cell(ctx, valid, to_utm, dst_ll[0], dst_ll[1])
        INF = float("inf")
        dist = np.full((hp, wp), INF)
        prev = np.full((hp, wp, 2), -1, dtype=np.int32)
        dist[s_rc] = 0.0
        pq = [(0.0, s_rc[0], s_rc[1])]
        while pq:
            dd0, r, c = heapq.heappop(pq)
            if dd0 > dist[r, c]:
                continue
            if (r, c) == e_rc:
                break
            for dr, dc in _NB:
                nr, nc = r + dr, c + dc
                if not (0 <= nr < hp and 0 <= nc < wp) or not valid[nr, nc]:
                    continue
                step = res * (1.41421356 if (dr and dc) else 1.0)
                up = max(0.0, float(demS[nr, nc] - demS[r, c]))
                nd = dd0 + step * 0.5 * (cost[r, c] + cost[nr, nc]) + climb_m * up
                if nd < dist[nr, nc]:
                    dist[nr, nc] = nd; prev[nr, nc] = (r, c)
                    heapq.heappush(pq, (nd, nr, nc))
        if not np.isfinite(dist[e_rc]):
            raise RuntimeError("Nessun percorso tra presa e vasca.")
        path, rc = [], e_rc
        while rc != (-1, -1):
            path.append(rc)
            pr, pc = int(prev[rc][0]), int(prev[rc][1])
            if (pr, pc) == (-1, -1):
                break
            rc = (pr, pc)
        path.reverse()
        xy = [(ctx["minx"] + (c + 0.5) * res, ctx["top"] - (r + 0.5) * res) for r, c in path]
        prof, length = _profile(dem, ctx, xy, path)
        cut = fill = 0.0

    xy_s = _rdp([(float(x), float(y)) for x, y in xy], res * 0.8)
    line = [list(to_wgs.transform(x, y)) for x, y in xy_s]
    line[0] = [float(src_ll[0]), float(src_ll[1])]
    line[-1] = [float(dst_ll[0]), float(dst_ll[1])]
    if len(prof) > 80:
        step = len(prof) / 80.0
        prof = [prof[int(i * step)] for i in range(80)] + [prof[-1]]
    zs = [z for _, z in prof]
    return {"coords": line, "length_m": round(length, 1), "profile": prof,
            "z_max": round(max(zs), 1) if zs else None, "z_min": round(min(zs), 1) if zs else None,
            "cut_max_m": round(cut, 2), "fill_max_m": round(fill, 2), "res_m": round(res, 1)}


def canal_network(client, head_ll: list, stations_ll: list, circles: list | None = None,
                  target_permille: float = 0.3, head_m: float | None = None,
                  climb_m: float = 60.0, dev_w: float = 20.0, circle_pen: float = 25.0) -> dict:
    """Rete di canali dalla testa (vasca o fine dell'adduttrice) alle stazioni di settore.

    Ogni ramo segue il terreno: costo = lunghezza + `climb_m` metri per ogni metro di risalita
    (la risalita è scavo) + scarto quadratico dalla discesa voluta (pendenza del canale), con i
    cerchi dei pivot molto penalizzati (un canale aperto non passa sotto il pivot). Il pelo libero non
    può stare sotto il terreno oltre il carico in testa (`head_m`, o la quota del terreno in testa).
    I rami si aggiungono uno alla volta: ogni stazione si collega alla rete già tracciata nel punto
    più conveniente (Dijkstra con sorgenti = tutte le celle della rete), dalla stazione più facile."""
    pts = [head_ll] + list(stations_ll)
    geom = _bbox_geom(pts, 600.0)
    dem, mask, ctx = _dem_and_grid(client, geom, max_dim=300)
    res, hp, wp = ctx["res"], ctx["hp"], ctx["wp"]
    to_utm = pyproj.Transformer.from_crs(4326, ctx["epsg"], always_xy=True)
    to_wgs = ctx["to_wgs"]
    valid = mask & np.isfinite(dem)
    demS = _smooth(dem)
    pen = np.ones((hp, wp))
    if circles:
        pen[_burn_circles((hp, wp), ctx, to_utm, circles)] = 1.0 + circle_pen
    h_rc = _snap_cell(ctx, valid, to_utm, head_ll[0], head_ll[1])
    head = float(head_m) if head_m is not None else float(demS[h_rc])
    cap = head + 1.0
    grad = max(1e-5, target_permille / 1000.0)
    st_rc = [_snap_cell(ctx, valid, to_utm, p[0], p[1]) for p in stations_ll]

    net_cells: dict = {h_rc: (-1, 0.0)}        # cella → (ramo, distanza lungo il ramo)
    branches: list = []
    left = list(range(len(stations_ll)))
    INF = float("inf")
    while left:
        dist = np.full((hp, wp), INF)
        prev = np.full((hp, wp, 2), -1, dtype=np.int32)
        pq = []
        for rc in net_cells:
            dist[rc] = 0.0; pq.append((0.0, rc[0], rc[1]))
        heapq.heapify(pq)
        targets = {st_rc[i]: i for i in left}
        found = 0
        while pq and found < len(targets):
            d0, r, c = heapq.heappop(pq)
            if d0 > dist[r, c]:
                continue
            if (r, c) in targets:
                found += 1
            er = demS[r, c]
            for dr, dc in _NB:
                nr, nc = r + dr, c + dc
                if not (0 <= nr < hp and 0 <= nc < wp) or not valid[nr, nc]:
                    continue
                en = demS[nr, nc]
                if en > cap:
                    continue
                dd = res * (1.41421356 if (dr and dc) else 1.0)
                actual = er - en
                nd = (d0 + dd * 0.5 * (pen[r, c] + pen[nr, nc]) + climb_m * max(0.0, -actual)
                      + dev_w * (actual - grad * dd) ** 2)
                if nd < dist[nr, nc]:
                    dist[nr, nc] = nd; prev[nr, nc] = (r, c)
                    heapq.heappush(pq, (nd, nr, nc))
        reach = [(dist[st_rc[i]], i) for i in left if np.isfinite(dist[st_rc[i]])]
        if not reach:
            break                                  # le altre stazioni sono più in alto del carico
        _, i = min(reach)
        path, rc = [], st_rc[i]
        while rc not in net_cells:
            path.append(rc)
            pr, pc = int(prev[rc][0]), int(prev[rc][1])
            if (pr, pc) == (-1, -1):
                break
            rc = (pr, pc)
        attach = rc
        path.append(attach)
        path.reverse()                             # dall'attacco alla stazione
        xy = [(ctx["minx"] + (c + 0.5) * res, ctx["top"] - (r + 0.5) * res) for r, c in path]
        prof, length = _profile(dem, ctx, xy, path)
        par, par_d = net_cells.get(attach, (-1, 0.0))
        bi = len(branches)
        for k, cell in enumerate(path[1:], start=1):
            if cell not in net_cells:
                net_cells[cell] = (bi, prof[k][0])
        xy_s = _rdp([(float(x), float(y)) for x, y in xy], res * 0.8)
        line = [list(to_wgs.transform(x, y)) for x, y in xy_s]
        line[-1] = [float(stations_ll[i][0]), float(stations_ll[i][1])]
        if par < 0 and len(branches) == 0:
            line[0] = [float(head_ll[0]), float(head_ll[1])]
        circ = float(np.mean([pen[p] > 1.0 for p in path])) if path else 0.0
        if len(prof) > 60:
            stp = len(prof) / 60.0
            prof = [prof[int(j * stp)] for j in range(60)] + [prof[-1]]
        branches.append({"station": i, "parent": par, "attach_m": round(par_d, 1), "coords": line,
                         "length_m": round(length, 1), "profile": prof, "in_circles": round(circ, 3)})
        left.remove(i)
    return {"head_m": round(head, 2), "res_m": round(res, 1), "branches": branches,
            "unreached": left}
