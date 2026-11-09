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
    # doppia lisciatura (mediana anti-rumore + gaussiana) → curve morbide e
    # concentriche, come su una carta topografica.
    demS = _smooth(dem)
    try:
        from scipy.ndimage import gaussian_filter
        demS = gaussian_filter(demS, sigma=1.4)
    except Exception:  # noqa: BLE001
        pass
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


def terrain_readability(client, geom: dict, vert_exag: float = 2.0,
                        interval_m: float = 0.0) -> dict:
    dem, mask, ctx = _dem_and_grid(client, geom, max_dim=420)
    valid = np.isfinite(dem)                 # rilievo su tutto il riquadro DEM
    vmin, vmax = _range(dem, valid)
    infield = mask & valid                   # isoipse solo dentro l'area
    if int(infield.sum()) < 16:
        infield = valid
    # intervallo scelto dall'utente (0,5 / 1 / 2 / 5 m…) oppure automatico
    interval = float(interval_m) if interval_m and interval_m > 0 else _nice_interval(vmax - vmin)
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


def _dem_channels(dem, valid, res, min_cells):
    """Rete di drenaggio dal DEM: riempie le depressioni, calcola direzione di
    deflusso (D8) e accumulo di flusso; le celle con molto bacino a monte sono
    impluvi/alvei (anche asciutti) → assi (LineString). Coglie i corsi d'acqua
    visibili nella morfologia che l'NDWI non vede (letti secchi, wadi)."""
    from skimage.morphology import reconstruction, skeletonize
    from scipy.ndimage import label as _label
    hp, wp = dem.shape
    fillv = float(np.nanmax(dem[valid])) if valid.any() else 0.0
    demf = np.where(valid, dem, fillv).astype("float64")
    # riempimento depressioni (ricostruzione morfologica per erosione)
    seed = np.full_like(demf, demf.max())
    seed[0, :] = demf[0, :]; seed[-1, :] = demf[-1, :]
    seed[:, 0] = demf[:, 0]; seed[:, -1] = demf[:, -1]
    filled = reconstruction(seed, demf, method="erosion")

    nb = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]
    dl = [res, res, res, res, res * 1.41421356, res * 1.41421356, res * 1.41421356, res * 1.41421356]
    dr_n = np.full((hp, wp), -1, np.int32); dc_n = np.full((hp, wp), -1, np.int32)
    for r in range(hp):
        for c in range(wp):
            if not valid[r, c]:
                continue
            e = filled[r, c]; best = 0.0; br = -1; bc = -1
            for k, (dr, dc) in enumerate(nb):
                nr, nc = r + dr, c + dc
                if 0 <= nr < hp and 0 <= nc < wp and valid[nr, nc]:
                    s = (e - filled[nr, nc]) / dl[k]
                    if s > best:
                        best = s; br = nr; bc = nc
            dr_n[r, c] = br; dc_n[r, c] = bc

    acc = np.ones((hp, wp), dtype="float64")
    order = np.argsort(filled, axis=None)[::-1]        # dalla quota più alta
    rows, cols = np.unravel_index(order, (hp, wp))
    for r, c in zip(rows.tolist(), cols.tolist()):
        if not valid[r, c]:
            continue
        nr, nc = int(dr_n[r, c]), int(dc_n[r, c])
        if nr >= 0:
            acc[nr, nc] += acc[r, c]

    channels = valid & (acc >= float(min_cells))
    if not channels.any():
        return channels
    from scipy.ndimage import binary_dilation
    return binary_dilation(channels, iterations=1) & valid


def _dem_lows(dem, valid, res, depth_thr):
    """Alvei INCISI: celle più basse delle zone circostanti (il letto blu scuro
    contornato da sponde più chiare del DEM). Confronta la quota col livello delle
    sponde (apertura morfologica con finestra più larga del letto): dove la
    profondità supera `depth_thr` è alveo. Segue i meandri (lo zig-zag)."""
    from scipy.ndimage import grey_opening, binary_opening
    hp, wp = dem.shape
    fillv = float(np.nanmax(dem[valid])) if valid.any() else 0.0
    demf = np.where(valid, dem, fillv).astype("float64")
    win = max(5, int(round(350.0 / res)))            # > larghezza tipica dell'alveo
    if win % 2 == 0:
        win += 1
    bank = grey_opening(demf, size=win)              # livello delle sponde
    depth = bank - demf                              # quanto è inciso sotto le sponde
    low = valid & (depth >= float(depth_thr))
    return binary_opening(low, iterations=1) & valid


def detect_watercourses(client, geom: dict, date: str | None = None, min_area_ha: float = 0.2,
                        ndwi_thr: float = 0.20, use_dem: bool = True,
                        dem_channel_ha: float = 25.0, dem_depth_m: float = 1.2,
                        sens: int = 3, months: int = 12) -> dict:
    """Corsi d'acqua esistenti. Fiumi, canali e bacini dal composito Sentinel-2 di
    più date (analysis/waterways.py: asse, lunghezza e larghezza misurata per tratto);
    impluvi e alvei asciutti dalla morfologia (DEM), esclusi dove c'è già acqua.
    `ndwi_thr` resta per compatibilità: la sensibilità la decide `sens` (1..5)."""
    from scipy.ndimage import label
    from .waterways import detect_waterways
    ww = detect_waterways(client, geom, date_to=date, months=months, sens=sens)
    out: list[dict] = []
    for sg in ww["segments"]:
        out.append({"geojson": sg["geojson"], "kind": sg["kind"], "source": "s2",
                    "area_ha": round(sg["length_m"] * sg["width_m"] / 1e4, 2),
                    "length_m": sg["length_m"], "mean_width_m": sg["width_m"],
                    "width_min_m": sg["width_min_m"], "width_max_m": sg["width_max_m"],
                    "width_wet_m": sg["width_wet_m"], "sinuosity": sg["sinuosity"],
                    "below_pixel": sg["below_pixel"], "profile": sg["profile"],
                    "regime": sg.get("regime"), "months_wet": sg.get("months_wet", []),
                    "months_seen": sg.get("months_seen", []), "bed": bool(sg.get("bed"))})
    for b in ww["basins"]:
        if b["area_ha"] >= min_area_ha:
            out.append({**b, "source": "s2"})

    # --- DRENAGGIO DAL DEM: impluvi/alvei (anche asciutti) come assi ---
    n_dem = 0
    if use_dem:
        try:
            dem, _mask, ctx = _dem_and_grid(client, geom, max_dim=420)
            res, wp, hp = ctx["res"], ctx["wp"], ctx["hp"]
            to_wgs, minx, top = ctx["to_wgs"], ctx["minx"], ctx["top"]

            def cell_xy(rc):
                return (minx + (rc[1] + 0.5) * res, top - (rc[0] + 0.5) * res)

            water = np.zeros((hp, wp), bool)
            if ww["surface"]:
                import pyproj
                to_utm = pyproj.Transformer.from_crs(4326, ctx["epsg"], always_xy=True)
                shp = [({"type": "Polygon", "coordinates": [[to_utm.transform(x, y) for x, y in r] for r in poly["coordinates"]]}, 1)
                       for poly in ww["surface"]]
                water = features.rasterize(shp, out_shape=(hp, wp), transform=from_origin(minx, top, res, res),
                                           fill=0, dtype="uint8", all_touched=True).astype(bool)
            demv = np.isfinite(dem)
            if demv.any():
                min_cells = max(20, int(float(dem_channel_ha) * 10000.0 / (res * res)))
                demx = np.where(demv, dem, np.nan)
                ch = _dem_channels(demx, demv, res, min_cells) | _dem_lows(demx, demv, res, dem_depth_m)
                ch = ch & ~water                              # non duplicare l'acqua del satellite
                lblc, nc = label(ch)
                for v in range(1, nc + 1):
                    comp = lblc == v
                    path = _centerline_cells(comp)
                    if not path or len(path) < 3:
                        continue
                    xy = [cell_xy(p) for p in path]
                    length_m = sum(math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1])
                                   for i in range(1, len(xy)))
                    if length_m < 4 * res:
                        continue
                    area_m2 = float(comp.sum()) * res * res
                    mean_width = max(float(res), area_m2 / length_m) if length_m > 0 else float(res)
                    xy_s = _rdp([(float(x), float(y)) for x, y in xy], res * 0.8)
                    line_ll = [list(to_wgs.transform(x, y)) for x, y in xy_s]
                    out.append({"geojson": {"type": "LineString", "coordinates": line_ll},
                                "kind": "drainage", "source": "dem", "area_ha": round(area_m2 / 10000.0, 1),
                                "length_m": round(length_m, 1), "mean_width_m": round(mean_width, 1)})
                    n_dem += 1
        except Exception:  # noqa: BLE001 — se il calcolo idrologico fallisce, salto
            pass

    return {"features": out, "water_ha": ww["water_ha"],
            "n_river": ww["n_river"], "n_canal": ww["n_canal"], "n_seasonal": ww.get("n_seasonal", 0),
            "n_basin": sum(1 for a in out if a["kind"] == "basin"),
            "n_wetland": 0, "n_drainage": n_dem, "surface": ww["surface"],
            "dates": ww["dates"], "res_m": ww["res_m"],
            "length_m": ww["length_m"]}


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
