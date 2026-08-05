"""Leggibilità del terreno (Argus Total — M6).

Due strumenti per leggere facilmente dislivelli, sensi e pendenze del terreno:

1. `terrain_readability` — rilievo ombreggiato (hillshade) sovrapposto alla
   colorazione per quota + curve di livello (isoipse) etichettate. Il rilievo
   rende immediatamente visibili i sensi delle pendenze; le isoipse ravvicinate
   indicano i tratti più ripidi.
2. `reachable_region` — data la presa, la zona realisticamente collegabile a
   gravità (aree a valle, raggiungibili in discesa): serve a capire dove poter
   collocare il finale di un canale.
"""
from __future__ import annotations

import base64
import math
from collections import deque

import numpy as np
from rasterio import features
from rasterio.transform import from_origin

from processing.satellite_export import _get_cmap, _png_from_rgb
from .canal import _NB, _dem_and_grid, _smooth, _snap_cell
from .macroareas import _rdp, _simplify_ring


def _range(dem, valid) -> tuple[float, float]:
    finite = dem[valid]
    if finite.size < 4:
        raise RuntimeError("DEM non disponibile per l'area.")
    vmin = float(np.percentile(finite, 2))
    vmax = float(np.percentile(finite, 98))
    if vmax - vmin < 1e-3:
        vmax = vmin + 1.0
    return vmin, vmax


def _bounds(ctx) -> list[list[float]]:
    res, wp, hp = ctx["res"], ctx["wp"], ctx["hp"]
    minx, top, to_wgs = ctx["minx"], ctx["top"], ctx["to_wgs"]
    south, east = top - hp * res, minx + wp * res
    lls = [to_wgs.transform(x, y) for x, y in
           ((minx, south), (east, south), (east, top), (minx, top))]
    lons = [p[0] for p in lls]; lats = [p[1] for p in lls]
    return [[min(lats), min(lons)], [max(lats), max(lons)]]


def _nice_interval(span: float, target: int = 12) -> float:
    """Intervallo 'tondo' fra le isoipse per avere ~`target` linee."""
    raw = span / max(1, target)
    if raw <= 0:
        return 1.0
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 2.5, 5, 10):
        if raw <= m * mag:
            return round(m * mag, 3)
    return 10 * mag


def _hillshade_rgb(dem, valid, res, vmin, vmax, vert_exag=2.0) -> np.ndarray:
    """RGB (H,W,3) uint8: colormap 'terrain' fusa con il rilievo ombreggiato."""
    from matplotlib.colors import LightSource
    ls = LightSource(azdeg=315, altdeg=45)
    filled = np.where(valid, dem, vmin).astype("float64")
    rgba = ls.shade(filled, cmap=_get_cmap("terrain"), blend_mode="soft",
                    vert_exag=vert_exag, dx=res, dy=res, vmin=vmin, vmax=vmax)
    rgb = (rgba[..., :3] * 255).astype("uint8")
    rgb[~valid] = 210  # fuori area: grigio neutro
    return rgb


def _seg_len(seg) -> float:
    d = 0.0
    for i in range(1, len(seg)):
        d += math.hypot(seg[i][0] - seg[i - 1][0], seg[i][1] - seg[i - 1][1])
    return d


def _contours(dem, valid, ctx, vmin, vmax, interval) -> list[dict]:
    """Isoipse come LineString (lon/lat). DEM lisciato per linee pulite; i segmenti
    troppo corti (rumore) sono scartati; ogni 5ª isoipsa è 'principale' e viene
    etichettata UNA sola volta (sul suo tratto più lungo) per non riempire la
    mappa di etichette."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    res, wp, hp = ctx["res"], ctx["wp"], ctx["hp"]
    minx, top, to_wgs = ctx["minx"], ctx["top"], ctx["to_wgs"]
    demS = _smooth(dem)                                   # linee più pulite (meno rumore)
    cols = minx + (np.arange(wp) + 0.5) * res
    rows = top - (np.arange(hp) + 0.5) * res
    X, Y = np.meshgrid(cols, rows)
    demm = np.ma.masked_where(~valid, demS)

    lo = math.ceil(vmin / interval) * interval
    levels = list(np.arange(lo, vmax + interval * 0.5, interval))
    if len(levels) < 2:
        return []

    fig = plt.figure()
    ax = fig.add_subplot(111)
    cs = ax.contour(X, Y, demm, levels=levels)
    min_len = max(4 * res, 120.0)                         # scarta i frammenti di rumore
    feats: list[dict] = []
    for lvl, segs in zip(cs.levels, cs.allsegs):
        principal = (round(lvl / interval) % 5 == 0)
        kept = [s for s in segs if len(s) >= 2 and _seg_len(s) >= min_len]
        # su ogni isoipsa principale etichetto solo il tratto più lungo
        label_idx = max(range(len(kept)), key=lambda i: _seg_len(kept[i])) if (principal and kept) else -1
        for i, seg in enumerate(kept):
            simp = _rdp([(float(x), float(y)) for x, y in seg], res * 0.7)
            if len(simp) < 2:
                continue
            ll = [list(to_wgs.transform(x, y)) for x, y in simp]
            feats.append({
                "type": "Feature",
                "properties": {"elev": round(float(lvl), 1), "principal": principal,
                               "label": (i == label_idx)},
                "geometry": {"type": "LineString", "coordinates": ll},
            })
    plt.close(fig)
    return feats


def terrain_readability(client, geom: dict, vert_exag: float = 2.0) -> dict:
    dem, mask, ctx = _dem_and_grid(client, geom, max_dim=420)
    valid = np.isfinite(dem)                 # rilievo su tutto il riquadro DEM
    vmin, vmax = _range(dem, valid)
    infield = mask & valid                   # isoipse solo dentro l'area
    if int(infield.sum()) < 16:
        infield = valid
    interval = _nice_interval(vmax - vmin)
    rgb = _hillshade_rgb(dem, valid, ctx["res"], vmin, vmax, vert_exag)
    png = _png_from_rgb(rgb)
    image = "data:image/png;base64," + base64.b64encode(png).decode()
    contours = _contours(dem, infield, ctx, vmin, vmax, interval)
    return {
        "image": image,
        "bounds": _bounds(ctx),
        "contours": {"type": "FeatureCollection", "features": contours},
        "interval_m": interval,
        "elev_min": round(float(np.nanmin(dem[valid])), 1),
        "elev_max": round(float(np.nanmax(dem[valid])), 1),
    }


def _centerline_cells(comp: np.ndarray):
    """Asse (scheletro) di una componente lineare: ritorna il percorso più lungo
    del suo scheletro come lista di celle (row, col), o None se troppo corto."""
    from collections import deque
    from skimage.morphology import skeletonize
    sk = skeletonize(comp)
    ys, xs = np.where(sk)
    if len(xs) < 2:
        return None
    S = set(zip(ys.tolist(), xs.tolist()))
    adj = {p: [] for p in S}
    for (r, c) in S:
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr or dc:
                    q = (r + dr, c + dc)
                    if q in S:
                        adj[(r, c)].append(q)

    def bfs(src):
        dist = {src: 0}; par = {src: None}; dq = deque([src]); far = src
        while dq:
            u = dq.popleft()
            for v in adj[u]:
                if v not in dist:
                    dist[v] = dist[u] + 1; par[v] = u; dq.append(v)
                    if dist[v] > dist[far]:
                        far = v
        return far, par

    start = next(iter(S))
    a, _ = bfs(start)
    b, par = bfs(a)                       # a→b = diametro dello scheletro
    path = []; cur = b
    while cur is not None:
        path.append(cur); cur = par[cur]
    path.reverse()
    return path if len(path) >= 2 else None


def detect_watercourses(client, geom: dict, date: str, min_area_ha: float = 0.2,
                        ndwi_thr: float = 0.20) -> dict:
    """Rileva e 'ricalca' i corsi d'acqua esistenti dall'NDWI. Distingue:
    - fiumi/canali stretti (allungati) → ASSE (LineString);
    - bacini (invasi, laghi) → poligono del contorno (kind 'basin');
    - paludi → poligono (kind 'wetland').
    `ndwi_thr` e `min_area_ha` regolano la SENSIBILITÀ (soglie più basse = più
    corsi d'acqua stretti/deboli rilevati). Serve a vederli PRIMA di progettare."""
    from scipy.ndimage import label, binary_closing
    from processing.satellite_export import _stitch
    dem, mask, ctx = _dem_and_grid(client, geom, max_dim=420)
    res, wp, hp = ctx["res"], ctx["wp"], ctx["hp"]
    to_wgs = ctx["to_wgs"]
    minx, top = ctx["minx"], ctx["top"]
    miny = top - hp * res
    mos, _nc, n_ok = _stitch(client, ctx["epsg"], minx, miny, top,
                             res, wp, hp, 1, 1, date, ["ndvi", "ndmi", "ndwi"])
    if n_ok == 0:
        raise RuntimeError("Nessuna scena disponibile per la data scelta.")
    ndvi, ndmi, ndwi = mos["ndvi"], mos["ndmi"], mos["ndwi"]
    fin = np.isfinite(ndwi)
    water = fin & (ndwi > ndwi_thr)                             # acqua libera
    # chiude piccole interruzioni: collega i tratti stretti dei fiumi
    water = binary_closing(water, iterations=1) & fin
    # marsh: soglia legata a ndwi_thr per scalare con la sensibilità
    marsh_ndwi = ndwi_thr - 0.25
    wetland = fin & (~water) & (ndvi > 0.30) & ((ndwi > marsh_ndwi) | (ndmi > 0.55))

    transform = from_origin(minx, top, res, res)
    pixel_ha = (res * res) / 10000.0

    def cell_xy(rc):
        r, c = rc
        return (minx + (c + 0.5) * res, top - (r + 0.5) * res)

    def poly_from(comp):
        for g, _v in features.shapes(comp.astype("uint8"), mask=comp, transform=transform):
            ring_utm = [(float(x), float(y)) for x, y in g["coordinates"][0]]
            ring_utm = _simplify_ring(ring_utm, res * 1.0)
            ring_ll = [list(to_wgs.transform(x, y)) for x, y in ring_utm]
            if len(ring_ll) >= 4:
                if ring_ll[0] != ring_ll[-1]:
                    ring_ll.append(ring_ll[0])
                return ring_ll
        return None

    out: list[dict] = []
    # --- ACQUA: separa fiumi/canali (lineari) dai bacini (invasi/laghi) ---
    lbl, n = label(water)
    for v in range(1, n + 1):
        comp = lbl == v
        area_m2 = float(comp.sum()) * res * res
        area_ha = area_m2 / 10000.0
        if area_ha < min_area_ha:
            continue
        path = _centerline_cells(comp)
        length_m = 0.0
        if path:
            xy = [cell_xy(p) for p in path]
            for i in range(1, len(xy)):
                length_m += math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1])
        equiv_diam = 2.0 * math.sqrt(area_m2 / math.pi) if area_m2 > 0 else 1.0
        elong = (length_m / equiv_diam) if equiv_diam > 0 else 0.0
        mean_width = (area_m2 / length_m) if length_m > 0 else equiv_diam
        # lineare (fiume/canale) se allungato e non troppo largo
        if path and elong >= 2.5 and mean_width <= 250.0 and length_m >= 2 * res:
            xy_s = _rdp([(float(x), float(y)) for x, y in xy], res * 0.8)
            line_ll = [list(to_wgs.transform(x, y)) for x, y in xy_s]
            out.append({"geojson": {"type": "LineString", "coordinates": line_ll},
                        "kind": "river", "area_ha": round(area_ha, 1),
                        "length_m": round(length_m, 1), "mean_width_m": round(mean_width, 1)})
        else:
            ring = poly_from(comp)
            if ring:
                out.append({"geojson": {"type": "Polygon", "coordinates": [ring]},
                            "kind": "basin", "area_ha": round(area_ha, 1)})

    # --- PALUDI: sempre poligoni ---
    lblw, nw = label(wetland)
    for v in range(1, nw + 1):
        comp = lblw == v
        area_ha = float(comp.sum()) * pixel_ha
        if area_ha < min_area_ha:
            continue
        ring = poly_from(comp)
        if ring:
            out.append({"geojson": {"type": "Polygon", "coordinates": [ring]},
                        "kind": "wetland", "area_ha": round(area_ha, 1)})

    out.sort(key=lambda a: a["area_ha"], reverse=True)
    tot = round(sum(a["area_ha"] for a in out), 1)
    return {"features": out, "water_ha": tot,
            "n_river": sum(1 for a in out if a["kind"] == "river"),
            "n_basin": sum(1 for a in out if a["kind"] == "basin"),
            "n_wetland": sum(1 for a in out if a["kind"] == "wetland")}


def _ring_area_ha(ring_utm: list) -> float:
    """Area (ha) di un anello in coordinate UTM (metri)."""
    n = len(ring_utm)
    if n < 3:
        return 0.0
    a = 0.0
    for i in range(n):
        x1, y1 = ring_utm[i]
        x2, y2 = ring_utm[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0 / 10000.0


def _reach_mask(dem, valid, s_row, s_col, head, head_tol) -> np.ndarray:
    """Flood dalla presa a gravità. Un canale a gravità non può portare l'acqua
    sopra la quota della presa (il 'carico' idraulico di partenza), ma può
    attraversare avvallamenti e piccoli dossi: quello che conta è NON superare la
    quota della presa. Quindi la cella è transitabile se `quota <= quota_presa +
    tol`. Il `tol` assorbe il rumore del DEM (dossi fittizi di pochi decimetri)
    che altrimenti bloccherebbero la propagazione a valle già a pochi metri.
    (Un flood 'strettamente in discesa' cella-per-cella si ferma al primo dosso
    e fa sembrare la zona a valle piccolissima: era il bug segnalato.)"""
    hp, wp = dem.shape
    thr = head + head_tol
    reach = np.zeros((hp, wp), dtype=bool)
    reach[s_row, s_col] = True
    dq = deque([(s_row, s_col)])
    while dq:
        r, c = dq.popleft()
        for dr, dc in _NB:
            nr, nc = r + dr, c + dc
            if not (0 <= nr < hp and 0 <= nc < wp):
                continue
            if valid[nr, nc] and not reach[nr, nc] and dem[nr, nc] <= thr:
                reach[nr, nc] = True
                dq.append((nr, nc))
    return reach


def reachable_region(client, geom: dict, start_ll, tol_up_m: float = 0.5,
                     min_drop_m: float = 0.3) -> dict:
    """Zona dove il finale è realisticamente collocabile: le celle collegate alla
    presa senza superarne la quota (carico idraulico) E più basse della presa.
    `tol_up_m` = tolleranza sul rumore DEM; `min_drop_m` = dislivello minimo
    perché una cella conti come 'a valle'."""
    dem, mask, ctx = _dem_and_grid(client, geom)
    res, wp, hp = ctx["res"], ctx["wp"], ctx["hp"]
    to_wgs = ctx["to_wgs"]
    import pyproj
    to_utm = pyproj.Transformer.from_crs(4326, ctx["epsg"], always_xy=True)
    valid = mask & np.isfinite(dem)
    if int(valid.sum()) < 10:
        raise RuntimeError("Area troppo piccola o DEM non disponibile.")

    s_row, s_col = _snap_cell(ctx, valid, to_utm, start_ll[0], start_ll[1])
    demS = _smooth(dem)                       # stesso DEM lisciato del routing
    head = float(demS[s_row, s_col])
    # corridoio raggiungibile senza superare il carico della presa
    corridor = _reach_mask(demS, valid, s_row, s_col, head, tol_up_m)
    # finale valido = raggiungibile E realmente più in basso della presa
    reach = corridor & (demS <= head - min_drop_m)
    if int(reach.sum()) < 1:
        return {"polygons": [], "elev_start_m": round(head, 1),
                "elev_min_m": round(head, 1), "area_ha": 0.0}

    transform = from_origin(ctx["minx"], ctx["top"], res, res)
    m = reach.astype("uint8")
    polys: list[dict] = []
    for g, _v in features.shapes(m, mask=reach, transform=transform):
        ring_utm = [(float(x), float(y)) for x, y in g["coordinates"][0]]
        ring_utm = _simplify_ring(ring_utm, res * 1.2)
        ring_ll = [list(to_wgs.transform(x, y)) for x, y in ring_utm]
        if len(ring_ll) < 4:
            continue
        if ring_ll[0] != ring_ll[-1]:
            ring_ll.append(ring_ll[0])
        polys.append({"type": "Polygon", "coordinates": [ring_ll]})

    pixel_ha = (res * res) / 10000.0
    return {
        "polygons": polys,
        "elev_start_m": round(head, 1),
        "elev_min_m": round(float(demS[reach].min()), 1),
        "area_ha": round(float(reach.sum()) * pixel_ha, 1),
    }
