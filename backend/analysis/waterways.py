"""Lettura dei fiumi e dei canali esistenti da Sentinel-2, con larghezza e lunghezza.

Flusso:
1. composito di più date (default 12 mesi, poche nuvole) a 10 m: per ogni pixel
   NDWI e NIR. La classe SCL «acqua» NON va scartata (la maschera nuvole del resto
   dell'app la toglie): qui si escludono solo nuvole, ombre, neve e pixel difettosi.
   Mediana fra le date → piene, risaie allagate e ombre di un giorno spariscono;
2. maschera dell'acqua = nuclei (NDWI sopra soglia) + linee sottili (filtro di
   Sato sull'NDWI, con contrasto locale): così si leggono anche i canali larghi
   1-2 pixel, che una soglia secca perde;
3. scheletro della maschera → grafo: tratti fra nodi (confluenze, derivazioni,
   estremi), rametti corti potati, tratti consecutivi uniti;
4. larghezza a sezioni trasversali ogni 20 m: lungo la normale all'asse, la
   frazione d'acqua di ogni campione si ricava dal NIR (l'acqua lo assorbe quasi
   tutto) fra il terreno ai lati della sezione e l'acqua libera → larghezza anche
   sotto il pixel (un canale da 6 m in un pixel da 10 m conta 0,6 pixel);
5. fiume o canale dalla sinuosità e dalla larghezza; bacini (laghi, invasi) a parte.

Il client è quello satellitare dell'app (CdseClient: search_scenes/search_dates e
fetch_bands): stessa interfaccia in produzione e nei test.
"""
from __future__ import annotations

import datetime as dt
import math
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from rasterio import features
from rasterio.transform import from_origin
from scipy import ndimage as ndi

from processing.providers.cdse import BANDS
from processing.satellite_export import _utm_bbox
from .macroareas import _rdp, _simplify_ring

# SCL esclusi: 0 nessun dato, 1 saturo/difettoso, 3 ombra di nuvola, 8-9 nuvole,
# 10 cirri, 11 neve. L'acqua (6) resta.
SCL_BAD = (0, 1, 3, 8, 9, 10, 11)
MAX_PX = 9_000_000          # ~30×30 km a 10 m; oltre si ricampiona
TILE = 1500                 # lato massimo di una richiesta (Process API ≤ 2500)
NIR_Q = 0.002               # passo del NIR salvato data per data
NIR_DATES_MAX = 120_000_000 # byte massimi per il NIR di tutte le date
N_WATER = 0.02              # NIR dell'acqua libera (riflettanza)

# sensibilità 1..5 → soglie (5 = rileva anche canali deboli)
_SENS = {
    "core": [0.15, 0.05, 0.0, -0.08, -0.15],     # NDWI dei nuclei d'acqua
    "ridge": [0.10, 0.07, 0.05, 0.035, 0.025],    # risposta del filtro lineare
    "contrast": [0.35, 0.28, 0.22, 0.17, 0.12],   # NDWI sopra il terreno circostante
}


# ------------------------------------------------------------------ dati

def _grid(geom: dict, max_px: int = MAX_PX) -> dict:
    epsg, minx, miny, maxx, maxy, to_wgs = _utm_bbox(geom)
    res = 10.0
    while math.ceil((maxx - minx) / res) * math.ceil((maxy - miny) / res) > max_px:
        res *= 1.25
    wp = max(1, math.ceil((maxx - minx) / res))
    hp = max(1, math.ceil((maxy - miny) / res))
    top = miny + hp * res
    lls = [to_wgs.transform(x, y) for x, y in ((minx, miny), (minx + wp * res, top))]
    bbox_wgs = [min(lls[0][0], lls[1][0]), min(lls[0][1], lls[1][1]),
                max(lls[0][0], lls[1][0]), max(lls[0][1], lls[1][1])]
    return dict(epsg=epsg, minx=minx, top=top, res=res, wp=wp, hp=hp, to_wgs=to_wgs, bbox_wgs=bbox_wgs)


def _pick_scenes(client, bbox_wgs, date_to: str, months: int, max_cloud: float, max_scenes: int,
                 max_extra: int = 4) -> list[str]:
    d1 = dt.date.fromisoformat(date_to)
    d0 = d1 - dt.timedelta(days=int(round(months * 30.44)))
    # a finestre di ~3 mesi: il catalogo restituisce al massimo 100 scene per richiesta
    sc, a = [], d0
    while a < d1:
        b = min(d1, a + dt.timedelta(days=91))
        try:
            if hasattr(client, "search_scenes"):
                sc += client.search_scenes(bbox_wgs, a.isoformat(), b.isoformat(), max_cloud=max_cloud, limit=100)
            else:
                sc += [{"date": d, "cloud": None} for d in client.search_dates(bbox_wgs, a.isoformat(), b.isoformat(), max_cloud=max_cloud)]
        except Exception:  # noqa: BLE001 — una finestra fallita non ferma la ricerca
            pass
        a = b + dt.timedelta(days=1)
    if not sc:
        return []
    # UNA SCENA PER MESE (la meno nuvolosa) su tutto il periodo: i corsi d'acqua
    # stagionali e le fiumare scorrono pochi mesi, spesso i più nuvolosi; le nuvole si
    # tolgono pixel per pixel con la SCL. Se avanza posto, seconde scene dei mesi.
    by_month: dict[str, list] = {}
    for s in sc:
        by_month.setdefault(s["date"][:7], []).append(s)
    key = lambda s: (s["cloud"] if s["cloud"] is not None else 50.0)  # noqa: E731
    first = [min(v, key=key) for _, v in sorted(by_month.items())]
    if len(first) > max_scenes:                       # periodo più lungo delle scene: le più pulite
        first = sorted(first, key=key)[:max_scenes]
    # poi la SECONDA scena di ogni mese (le più pulite prima): dove l'area sta a cavallo di
    # due orbite ogni data ne copre solo una parte, e i mesi nuvolosi restano scoperti
    second = sorted((sorted(v, key=key)[1] for v in by_month.values() if len(v) >= 2), key=key)
    rest = sorted((s for v in by_month.values() for s in sorted(v, key=key)[2:]), key=key)
    room = max(0, max_scenes - len(first))
    picked = [s["date"] for s in first + (second + rest)[:room]]
    return sorted(set(picked))


def _nanpct(stack: np.ndarray, q: float) -> np.ndarray:
    """Percentile lungo l'asse 0 ignorando i NaN (interpolazione lineare), vettoriale:
    np.nanpercentile è lentissimo su milioni di pixel."""
    a = np.where(np.isnan(stack), np.inf, stack.astype("float32"))
    a.sort(axis=0)
    n = np.isfinite(a).sum(axis=0)
    pos = np.maximum(n - 1, 0) * (q / 100.0)
    lo = np.floor(pos).astype(np.int64)
    hi = np.minimum(lo + 1, np.maximum(n - 1, 0))
    v_lo = np.take_along_axis(a, lo[None], axis=0)[0]
    v_hi = np.take_along_axis(a, hi[None], axis=0)[0]
    out = v_lo + (v_hi - v_lo) * (pos - lo)
    return np.where(n > 0, out, np.nan).astype("float32")


def _second(stack: np.ndarray, highest: bool) -> np.ndarray:
    """Secondo valore più alto (o più basso) fra le date valide: lo stato di piena con
    l'acqua presente in almeno 2 date; un valore isolato (bordo di nuvola) non basta.
    Con una sola data valida vale quella."""
    fill = -np.inf if highest else np.inf
    a = np.where(np.isnan(stack), fill, stack.astype("float32"))
    a.sort(axis=0)
    n = np.isfinite(a).sum(axis=0)
    if highest:
        i2 = np.full(n.shape, a.shape[0] - 2, np.int64)
        i1 = np.full(n.shape, a.shape[0] - 1, np.int64)
    else:
        i2 = np.ones(n.shape, np.int64)
        i1 = np.zeros(n.shape, np.int64)
    v = np.where(n >= 2, np.take_along_axis(a, i2[None], 0)[0], np.take_along_axis(a, i1[None], 0)[0])
    return np.where(n > 0, v, np.nan).astype("float32")


def _composite(client, g: dict, dates: list[str], pct: float = 50.0, workers: int = 4) -> dict:
    """Composito sulla griglia g: NDWI, NIR e SWIR mediani (maschera dell'acqua) e
    NIR «bagnato» (25° percentile: lo stato con più acqua, per la larghezza; i canali
    irrigui vanno in asciutta per parte dell'anno). Tessera per tessera: in memoria
    restano solo le date di una tessera, non dell'intera area."""
    wp, hp, res, minx, top = g["wp"], g["hp"], g["res"], g["minx"], g["top"]
    nx, ny = math.ceil(wp / TILE), math.ceil(hp / TILE)
    xs = [round(k * wp / nx) for k in range(nx + 1)]
    ys = [round(k * hp / ny) for k in range(ny + 1)]
    tiles = [(xs[i], xs[i + 1], ys[j], ys[j + 1]) for j in range(ny) for i in range(nx)]
    out = {k: np.full((hp, wp), np.nan, "float32")
           for k in ("ndwi", "nir", "swir", "nir_wet", "ndwi_wet", "swir_wet", "nir_flow", "ndvi", "red")}
    n_valid = np.zeros((hp, wp), "int16")
    # per ogni pixel, 12 bit: mesi con acqua e mesi con un dato valido (senza nuvole)
    m_wet = np.zeros((hp, wp), "uint16")
    m_seen = np.zeros((hp, wp), "uint16")
    mon = [int(d[5:7]) - 1 for d in dates]
    # NIR di ogni data (uint8, passo 0,002; 255 = nuvola/nessun dato) per la larghezza
    # data per data: minimo e massimo con la loro data. Solo se sta in ~120 MB.
    keep_dates = len(dates) * hp * wp <= NIR_DATES_MAX
    nir_d = np.full((len(dates), hp, wp), 255, "uint8") if keep_dates else None
    iG, iN, iS, iR = BANDS.index("B03"), BANDS.index("B08"), BANDS.index("B11"), BANDS.index("B04")
    n_ok = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        for c0, c1, r0, r1 in tiles:
            bbox = [minx + c0 * res, top - r1 * res, minx + c1 * res, top - r0 * res]
            h, w = r1 - r0, c1 - c0

            def job(day, bbox=bbox, w=w, h=h):
                try:
                    return client.fetch_bands(bbox, g["epsg"], w, h, day)
                except Exception:  # noqa: BLE001 — una scena fallita non ferma il composito
                    return None

            nd = np.full((len(dates), h, w), np.nan, "float16")
            nir = np.full((len(dates), h, w), np.nan, "float16")
            sw = np.full((len(dates), h, w), np.nan, "float16")
            vi = np.full((len(dates), h, w), np.nan, "float16")
            rd = np.full((len(dates), h, w), np.nan, "float16")
            for k, a in enumerate(ex.map(job, dates)):
                if a is None:
                    continue
                n_ok += 1
                G, N, Sw, scl = a[iG], a[iN], a[iS], np.rint(a[-1])
                ok = np.isfinite(G) & np.isfinite(N) & ~np.isin(scl, SCL_BAD) & ((G + N) > 1e-4)
                with np.errstate(invalid="ignore", divide="ignore"):
                    v = (G - N) / (G + N)
                nd[k] = np.where(ok, v, np.nan)
                nir[k] = np.where(ok, N, np.nan)
                if nir_d is not None:
                    nir_d[k, r0:r1, c0:c1] = np.where(ok, np.clip(np.rint(N / NIR_Q), 0, 254), 255).astype("uint8")
                sw[k] = np.where(ok, Sw, np.nan)
                Rr = a[iR]
                with np.errstate(invalid="ignore", divide="ignore"):
                    vi[k] = np.where(ok & ((N + Rr) > 1e-4), (N - Rr) / (N + Rr), np.nan)
                rd[k] = np.where(ok, Rr, np.nan)
                del a
            n_valid[r0:r1, c0:c1] = np.isfinite(nd).sum(axis=0)
            out["ndwi"][r0:r1, c0:c1] = _nanpct(nd, pct)
            out["nir"][r0:r1, c0:c1] = _nanpct(nir, 100.0 - pct)
            out["swir"][r0:r1, c0:c1] = _nanpct(sw, 100.0 - pct)
            out["nir_wet"][r0:r1, c0:c1] = _nanpct(nir, 25.0)
            # stato di piena: l'acqua presente almeno in ~2 date su 12 (corsi stagionali)
            out["ndwi_wet"][r0:r1, c0:c1] = _second(nd, True)
            out["swir_wet"][r0:r1, c0:c1] = _second(sw, False)
            out["nir_flow"][r0:r1, c0:c1] = _second(nir, False)
            out["ndvi"][r0:r1, c0:c1] = _nanpct(vi, 50.0)
            out["red"][r0:r1, c0:c1] = _nanpct(rd, 50.0)
            # acqua in quella data: NDWI ben sopra il terreno circostante (anche pixel misti)
            win = max(7, int(round(150 / res)) | 1)
            for k in range(len(dates)):
                v = nd[k].astype("float32")
                okk = np.isfinite(v)
                if not okk.any():
                    continue
                bgk = _local_mean(np.where(okk, v, 0.0), okk & (v < -0.1), win)
                bgk = np.where(np.isfinite(bgk), bgk, -0.5)
                wk = okk & (v > -0.45) & ((v - bgk) > 0.2) & (np.nan_to_num(sw[k].astype("float32"), nan=1.0) < 0.15)
                bit = np.uint16(1 << mon[k])
                m_seen[r0:r1, c0:c1] |= np.where(okk, bit, np.uint16(0))
                m_wet[r0:r1, c0:c1] |= np.where(wk, bit, np.uint16(0))
            del nd, nir, sw, vi, rd
    out.update(n_valid=n_valid, m_wet=m_wet, m_seen=m_seen, ok=n_ok, jobs=len(dates) * len(tiles), nir_dates=nir_d)
    return out


# ------------------------------------------------------------------ maschera

def _local_mean(v: np.ndarray, w: np.ndarray, size: int) -> np.ndarray:
    num = ndi.uniform_filter(np.where(w, v, 0.0), size)
    den = ndi.uniform_filter(w.astype("float32"), size)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(den > 0.05, num / den, np.nan)


def _water_mask(ndwi: np.ndarray, swir: np.ndarray, sens: int, res: float):
    from skimage.filters import sato
    s = min(5, max(1, int(sens))) - 1
    fin = np.isfinite(ndwi)
    v = np.where(fin, ndwi, -1.0).astype("float32")
    core = fin & (v > _SENS["core"][s])
    # terreno circostante: media locale dell'NDWI fuori dall'acqua (≈150 m)
    land = fin & ~ndi.binary_dilation(core, iterations=1)
    bg = _local_mean(v, land, max(7, int(round(150 / res)) | 1))
    bg = np.where(np.isfinite(bg), bg, np.nanmedian(v[land]) if land.any() else -0.5)
    ridge = sato(v, sigmas=(0.8, 1.2, 1.8), black_ridges=False)
    thin = fin & (ridge > _SENS["ridge"][s]) & ((v - bg) > _SENS["contrast"][s]) & (v > -0.45)
    # l'acqua assorbe anche lo SWIR (B11), asfalto, tetti e terra no: strade e
    # ferrovie (lineari e con NDWI sopra i campi) restano fuori
    sw_ok = np.isfinite(swir)
    sbg = _local_mean(np.where(sw_ok, swir, 0.0), sw_ok & land, max(7, int(round(150 / res)) | 1))
    sbg = np.where(np.isfinite(sbg), sbg, np.nanmedian(swir[sw_ok & land]) if (sw_ok & land).any() else 0.2)
    with np.errstate(invalid="ignore", divide="ignore"):
        sr = np.where(sw_ok, swir / np.maximum(sbg, 0.02), 1.0)
    thin &= sr < 0.85
    core &= (sr < 0.8) | (v > 0.3)
    m = core | thin
    m = ndi.binary_closing(m, structure=np.ones((3, 3), bool), iterations=1) & fin
    lab, n = ndi.label(m, structure=np.ones((3, 3), bool))
    if n:
        sizes = ndi.sum(m, lab, index=np.arange(1, n + 1))
        keep = np.zeros(n + 1, bool); keep[1:] = sizes >= 6
        m = keep[lab]
    m = _bridge(m, max(3, int(round(60 / res))))
    return m, core, sr, ridge / _SENS["ridge"][s]


def _bridge(mask: np.ndarray, max_gap_px: int = 6) -> np.ndarray:
    """Cuce le interruzioni (ponti, alberi sulle sponde, attraversamenti): ogni capo
    libero dello scheletro si collega al pezzo d'acqua più vicino DAVANTI a sé (entro
    `max_gap_px` e 50° dalla sua direzione)."""
    from skimage.draw import line as _line
    from skimage.morphology import skeletonize
    sk = skeletonize(mask)
    deg, _ = _crossing(sk)
    lab, _ = ndi.label(mask, structure=np.ones((3, 3), bool))
    H, W = mask.shape
    out = mask.copy()
    ends = np.argwhere(sk & (deg == 1))
    skp = sk.copy()
    for r, c in ends:
        # direzione: dal punto 6 px indietro lungo lo scheletro al capo
        path, prev, cur = [(r, c)], None, (r, c)
        for _ in range(6):
            nx_ = [(cur[0] + dr, cur[1] + dc) for dr, dc in _RING
                   if 0 <= cur[0] + dr < H and 0 <= cur[1] + dc < W and skp[cur[0] + dr, cur[1] + dc] and (cur[0] + dr, cur[1] + dc) != prev
                   and (cur[0] + dr, cur[1] + dc) not in path]
            if not nx_:
                break
            prev, cur = cur, nx_[0]; path.append(cur)
        if len(path) < 3:
            continue
        d = np.array([r - path[-1][0], c - path[-1][1]], float)
        d /= max(1e-6, np.hypot(*d))
        R = max_gap_px
        r0, r1, c0, c1 = max(0, r - R), min(H, r + R + 1), max(0, c - R), min(W, c + R + 1)
        win = np.argwhere(mask[r0:r1, c0:c1] & (lab[r0:r1, c0:c1] != lab[r, c]))
        best, bd = None, 1e9
        for wr, wc in win:
            q = np.array([wr + r0 - r, wc + c0 - c], float)
            L = np.hypot(*q)
            if L < 1 or L > R or (q @ d) / L < 0.64:
                continue
            if L < bd:
                best, bd = (wr + r0, wc + c0), L
        if best is not None:
            rr, cc = _line(r, c, best[0], best[1])
            out[rr, cc] = True
    return out


def _trace(mask: np.ndarray, ev: np.ndarray, res: float, max_m: float = 600.0,
           ev_min: float = 0.35) -> np.ndarray:
    """Ricuce i corsi d'acqua spezzati seguendo l'immagine, non in linea retta: da ogni capo
    libero di un pezzo lungo almeno 50 m, il percorso di costo minimo (costo = 1/evidenza
    lineare d'acqua) verso un altro pezzo entro `max_m`. Il collegamento vale solo se lungo
    il percorso la traccia d'acqua c'è davvero (evidenza media ≥ `ev_min` della soglia, al
    più 25% di tratti senza traccia) e il percorso non gira a vuoto (≤ 3 volte la distanza)."""
    from skimage.graph import MCP_Geometric
    from skimage.morphology import skeletonize
    sk = skeletonize(mask)
    deg, _ = _crossing(sk)
    lab, n = ndi.label(mask, structure=np.ones((3, 3), bool))
    if n < 2:
        return mask
    sklen = ndi.sum(sk, lab, index=np.arange(n + 1))
    # solo corsi STRETTI (larghezza media ≤ 40 m): sui fiumi larghi a più rami la
    # ricucitura farebbe grovigli fra i rami
    area = ndi.sum(mask, lab, index=np.arange(n + 1))
    narrow = (area / np.maximum(sklen, 1)) * res <= 40.0
    H, W = mask.shape
    R = max(5, int(round(max_m / res)))
    ev = np.nan_to_num(ev, nan=0.0).astype("float32")
    out = mask.copy()
    for r, c in np.argwhere(sk & (deg == 1)):
        lv = lab[r, c]
        if sklen[lv] < 5 or not narrow[lv]:
            continue
        r0, r1, c0, c1 = max(0, r - R), min(H, r + R + 1), max(0, c - R), min(W, c + R + 1)
        lw = lab[r0:r1, c0:c1]
        tg = sk[r0:r1, c0:c1] & (lw != lv) & (lw > 0) & (sklen[lw] >= 5) & narrow[lw]
        if not tg.any():
            continue
        e = ev[r0:r1, c0:c1]
        cost = 1.0 / (0.05 + np.clip(e, 0, 3))
        cost[lw == lv] = 1e4                                  # non tornare indietro sul proprio pezzo
        cost[r - r0, c - c0] = 1.0
        mcp = MCP_Geometric(cost)
        cum, _ = mcp.find_costs([(r - r0, c - c0)])
        tpts = np.argwhere(tg)
        d = np.hypot(tpts[:, 0] - (r - r0), tpts[:, 1] - (c - c0))
        ok = d <= R
        if not ok.any():
            continue
        tpts, d = tpts[ok], d[ok]
        k = int(np.argmin(cum[tpts[:, 0], tpts[:, 1]]))
        path = np.array(mcp.traceback(tuple(tpts[k])))
        if len(path) < 2:
            continue
        pe = e[path[:, 0], path[:, 1]]
        if pe.mean() < ev_min or (pe < 0.1).mean() > 0.25 or len(path) > 3 * d[k] + 5:
            continue
        out[path[:, 0] + r0, path[:, 1] + c0] = True
    return out


# ------------------------------------------------------------------ grafo dello scheletro

_RING = [(-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1)]


def _crossing(sk: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Numero di vicini e numero di attraversamenti (transizioni 0→1 attorno al pixel)."""
    p = np.pad(sk, 1).astype("int8")
    H, W = sk.shape
    ring = [p[1 + dr:1 + dr + H, 1 + dc:1 + dc + W] for dr, dc in _RING]
    deg = sum(ring)
    cn = sum(((ring[i] == 0) & (ring[(i + 1) % 8] == 1)).astype("int8") for i in range(8))
    return deg, cn


def _graph(sk: np.ndarray):
    """Tratti dello scheletro fra nodi. Ritorna (edges, node_of) con
    edges = [{a, b, px: [(r,c),...]}] e nodi numerati (cluster di incroci o estremi)."""
    H, W = sk.shape
    deg, cn = _crossing(sk)
    node = sk & ((cn >= 3) | (deg <= 1))
    nlab, nn = ndi.label(node, structure=np.ones((3, 3), bool))
    on = set(zip(*np.nonzero(sk)))

    def nbs(p):
        r, c = p
        for dr, dc in _RING:
            q = (r + dr, c + dc)
            if q in on:
                yield q

    edges, seen = [], set()
    for p in zip(*np.nonzero(node)):
        a = int(nlab[p])
        for q in nbs(p):
            if node[q]:
                if int(nlab[q]) != a:
                    key = (min(p, q), max(p, q))
                    if key not in seen:
                        seen.add(key); edges.append({"a": a, "b": int(nlab[q]), "px": [p, q]})
                continue
            if q in seen:
                continue
            path, prev, cur = [p, q], p, q
            seen.add(q)
            while True:
                nxt = [x for x in nbs(cur) if x != prev and x not in seen and x not in path[-3:]]
                hit = [x for x in nxt if node[x] and int(nlab[x]) != 0]
                if hit and (len(path) > 2 or int(nlab[hit[0]]) != a):
                    path.append(hit[0]); b = int(nlab[hit[0]]); break
                nxt = [x for x in nxt if not node[x]]
                if not nxt:
                    b = None; break
                nxt.sort(key=lambda x: abs(x[0] - cur[0]) + abs(x[1] - cur[1]))   # prima i 4-vicini
                prev, cur = cur, nxt[0]
                seen.add(cur); path.append(cur)
                for x in nxt[1:]:               # gradini dello scheletro: assorbiti nel tratto
                    if all(y == cur or y == prev or y in seen or node[y] for y in nbs(x)):
                        seen.add(x)
            if b is None:
                nn += 1; b = nn
            edges.append({"a": a, "b": b, "px": path})
    # anelli senza nodi (es. isola chiusa): un tratto chiuso
    rest = on - seen - set(zip(*np.nonzero(node)))
    while rest:
        p = rest.pop(); path = [p]; cur = p
        while True:
            nxt = [x for x in nbs(cur) if x in rest]
            if not nxt:
                break
            cur = nxt[0]; rest.discard(cur); path.append(cur)
        if len(path) >= 3:
            nn += 1
            edges.append({"a": nn, "b": nn, "px": path + [p]})
    return edges


def _plen(px, res) -> float:
    return sum(math.hypot(px[i][0] - px[i - 1][0], px[i][1] - px[i - 1][1]) for i in range(1, len(px))) * res


def _prune_merge(edges: list[dict], res: float, min_spur_m: float, dt_px: np.ndarray) -> list[dict]:
    """Pota i rametti terminali corti (rumore dello scheletro e sponde frastagliate)
    e unisce i tratti consecutivi a un nodo con due soli tratti."""
    for _ in range(4):
        cnt: dict[int, int] = {}
        for e in edges:
            cnt[e["a"]] = cnt.get(e["a"], 0) + 1
            cnt[e["b"]] = cnt.get(e["b"], 0) + 1
        keep = []
        for e in edges:
            L = _plen(e["px"], res)
            term = (cnt[e["a"]] == 1) != (cnt[e["b"]] == 1)       # un solo capo libero
            if term:
                j = e["px"][0] if cnt[e["a"]] > 1 else e["px"][-1]
                lim = max(min_spur_m, 2.5 * float(dt_px[j]) * res)
                if L < lim:
                    continue
            keep.append(e)
        if len(keep) == len(edges):
            break
        edges = keep
    # unione ai nodi di grado 2
    changed = True
    while changed:
        changed = False
        inc: dict[int, list[int]] = {}
        for k, e in enumerate(edges):
            inc.setdefault(e["a"], []).append(k)
            if e["b"] != e["a"]:
                inc.setdefault(e["b"], []).append(k)
        for nd_, ks in inc.items():
            if len(ks) != 2 or ks[0] == ks[1]:
                continue
            e1, e2 = edges[ks[0]], edges[ks[1]]
            p1 = e1["px"] if e1["b"] == nd_ else e1["px"][::-1]
            p2 = e2["px"] if e2["a"] == nd_ else e2["px"][::-1]
            a = e1["a"] if e1["b"] == nd_ else e1["b"]
            b = e2["b"] if e2["a"] == nd_ else e2["a"]
            if a == nd_ or b == nd_:
                continue
            merged = {"a": a, "b": b, "px": p1 + p2[1:] if p1[-1] == p2[0] else p1 + p2}
            edges = [e for k, e in enumerate(edges) if k not in ks] + [merged]
            changed = True
            break
    return edges


# ------------------------------------------------------------------ misure

def _smooth(px: list, w: int = 5) -> np.ndarray:
    a = np.asarray(px, dtype="float64")
    if len(a) < w + 2:
        return a
    k = np.ones(w) / w
    out = a.copy()
    for d in range(2):
        pad = np.concatenate([np.repeat(a[:1, d], w // 2), a[:, d], np.repeat(a[-1:, d], w // 2)])
        out[:, d] = np.convolve(pad, k, mode="valid")
    out[0], out[-1] = a[0], a[-1]
    return out


def _widths(pts: np.ndarray, mask: np.ndarray, nir: np.ndarray, dt_px: np.ndarray,
            res: float, land_nir: float, water_nir: float, step_m: float = 20.0,
            nan_ok: bool = False, md: np.ndarray | None = None, snap_px: float = 0.0):
    """Larghezza bagnata a sezioni trasversali. Ritorna [(progressiva_m, larghezza_m)].
    Frazione d'acqua di ogni campione = (NIR terreno − NIR) / (NIR terreno − NIR acqua):
    il terreno si legge ai lati della sezione, l'acqua nel nucleo (se largo almeno 3 px).
    La somma lineare non dipende dalla sfocatura del sensore, purché la finestra prenda
    le code: si allarga di 2 px per lato e i valori negativi (rumore) non si tagliano."""
    n = len(pts)
    if n < 3:
        return []
    seg = np.hypot(*np.diff(pts, axis=0).T)
    s = np.concatenate([[0.0], np.cumsum(seg)]) * res
    out = []
    half_end = 0
    t_next = 0.0
    if md is None:
        md = ndi.binary_dilation(mask, iterations=1)
    for i in range(n):
        if s[i] < t_next:
            continue
        t_next = s[i] + step_m
        j0, j1 = max(0, i - 3), min(n - 1, i + 3)
        d = pts[j1] - pts[j0]
        L = math.hypot(*d)
        if L < 1e-6:
            continue
        nr, nc = -d[1] / L, d[0] / L                      # normale (riga, colonna)
        r0, c0 = pts[i]
        ri, ci = int(round(r0)), int(round(c0))
        if not (0 <= ri < mask.shape[0] and 0 <= ci < mask.shape[1]):
            continue
        reach = float(dt_px[ri, ci])
        # niente misure a ridosso delle confluenze (sezione falsata)
        if min(s[i], s[-1] - s[i]) < 1.2 * reach * res and s[-1] > 3 * reach * res:
            continue
        T = min(400.0, reach + 10.0)
        t = np.arange(-T, T + 0.25, 0.5)
        rr, cc = r0 + t * nr, c0 + t * nc
        inside = (rr >= 0) & (rr <= mask.shape[0] - 1) & (cc >= 0) & (cc <= mask.shape[1] - 1)
        rr, cc = np.clip(rr, 0, mask.shape[0] - 1), np.clip(cc, 0, mask.shape[1] - 1)
        mv = md[np.rint(rr).astype(int), np.rint(cc).astype(int)] & inside
        nv = ndi.map_coordinates(nir, [rr, cc], order=1, mode="nearest")
        if nan_ok:
            # data singola: una sezione con nuvole (NIR mancante) sull'acqua non si misura
            mv0 = mv.copy()
            if np.isnan(nv[mv0]).any():
                continue
        z = len(t) // 2
        if not mv[z] and snap_px > 0:
            # asse disegnato a mano o da OSM: aggancio all'acqua più vicina lungo la sezione
            near = np.flatnonzero(mv & (np.abs(t) <= snap_px))
            if near.size:
                z = int(near[np.argmin(np.abs(t[near]))])
        if not mv[z]:
            continue
        lo = z
        while lo > 0 and mv[lo - 1]:
            lo -= 1
        hi = z
        while hi < len(t) - 1 and mv[hi + 1]:
            hi += 1
        core_n = nv[lo:hi + 1]
        lo, hi = max(0, lo - 4), min(len(t) - 1, hi + 4)
        side = np.concatenate([nv[max(0, lo - 10):lo], nv[hi + 1:hi + 11]])
        side = side[np.isfinite(side)]
        bg = float(np.median(side)) if side.size >= 4 else land_nir
        nw = float(np.percentile(core_n, 5)) if core_n.size >= 6 else water_nir
        nw = min(max(nw, N_WATER), 0.12)
        if bg < nw + 0.05:
            continue                                        # contrasto troppo basso: sezione inaffidabile
        f = np.clip((bg - nv[lo:hi + 1]) / (bg - nw), -0.3, 1.0)
        f = np.where(np.isfinite(f), f, 0.0)
        out.append((float(s[i]), max(0.0, float(f.sum() * 0.5 * res))))
    return out


def _to_ll(pts_rc: np.ndarray, g: dict) -> list[list[float]]:
    res, minx, top, to_wgs = g["res"], g["minx"], g["top"], g["to_wgs"]
    xy = [(minx + (c + 0.5) * res, top - (r + 0.5) * res) for r, c in pts_rc]
    xy = _rdp([(float(x), float(y)) for x, y in xy], res * 0.5)
    return [[round(v, 7) for v in to_wgs.transform(x, y)] for x, y in xy]


def _width_by_date(pts, mask, nir_d, dates, dt_px, res, land_nir, water_nir, n_all: int,
                   md: np.ndarray | None = None) -> list[tuple[str, float, float]]:
    """Larghezza mediana del tratto in ogni data: [(data, larghezza_m, quota di sezioni valide)].
    Le sezioni con nuvole (NIR mancante) non contano; una data vale se copre ≥ 50% del tratto."""
    n_all = max(1, n_all)                     # sezioni misurate sul composito
    out = []
    if md is None:
        md = ndi.binary_dilation(mask, iterations=1)
    for k, d in enumerate(dates):
        q = nir_d[k]
        v = np.where(q == 255, np.nan, q.astype("float32") * NIR_Q)
        prof = _widths(pts, mask, v, dt_px, res, land_nir, water_nir, nan_ok=True, md=md)
        if len(prof) >= 0.5 * n_all and len(prof) >= 2:
            out.append((d, float(np.median([w for _, w in prof])), len(prof) / n_all))
    return out


def _bank_slope(pts: np.ndarray, width_m: float, dem: np.ndarray | None, res: float) -> float | None:
    """Pendenza delle sponde (m verticale per m orizzontale) dal DEM, fra il bordo
    dell'acqua e 60 m più in là, su sezioni ogni ~200 m, mediana dei due lati."""
    if dem is None or len(pts) < 7:
        return None
    sl = []
    e0 = width_m / 2 / res + 2.0
    for i in range(3, len(pts) - 3, max(1, int(200 / res))):
        d = pts[i + 3] - pts[i - 3]
        L = math.hypot(*d)
        if L < 1e-6:
            continue
        nr, nc = -d[1] / L, d[0] / L
        for sgn in (1, -1):
            a = (pts[i][0] + sgn * e0 * nr, pts[i][1] + sgn * e0 * nc)
            b = (pts[i][0] + sgn * (e0 + 60 / res) * nr, pts[i][1] + sgn * (e0 + 60 / res) * nc)
            za, zb = ndi.map_coordinates(dem, [[a[0], b[0]], [a[1], b[1]]], order=1, mode="nearest")
            if np.isfinite(za) and np.isfinite(zb):
                sl.append(max(0.0, float(zb - za)) / 60.0)
    if len(sl) < 2:
        return None
    return float(np.median(sl))


REGIME = ("perennial", "seasonal", "ephemeral")


def _months_axis(px: list, m_wet: np.ndarray, m_seen: np.ndarray) -> tuple[list[int], list[int]]:
    """Mesi (1-12) in cui il tratto ha acqua e mesi osservati: un mese conta se l'acqua
    c'è in almeno metà dei pixel dell'asse visti senza nuvole quel mese."""
    wet, seen = [], []
    for b in range(12):
        bit = 1 << b
        sv = [p for p in px if m_seen[p] & bit]
        if len(sv) < max(3, 0.3 * len(px)):
            continue
        seen.append(b + 1)
        if sum(1 for p in sv if m_wet[p] & bit) >= 0.5 * len(sv):
            wet.append(b + 1)
    return wet, seen


def _regime(wet: list[int], seen: list[int]) -> str | None:
    """Perenne: acqua in quasi tutti i mesi osservati; stagionale: almeno 3; effimero
    (fiumara, wadi): 1-2 mesi o solo nello stato di piena."""
    if len(seen) < 4:
        return None
    f = len(wet) / len(seen)
    if f >= 0.8:
        return "perennial"
    return "seasonal" if len(wet) >= 3 else "ephemeral"


def _classify(length_m: float, width_m: float, sinuosity: float, net_max_w: float) -> str:
    """Fiume o canale. In un sistema fluviale largo (≥ 60 m) un tratto resta canale
    solo se lungo, diritto e molto più stretto del fiume (es. un canale che prende dal
    fiume); altrove decide la sinuosità."""
    if net_max_w >= 60:
        return "canal" if (length_m >= 1000 and sinuosity <= 1.15 and width_m <= min(60.0, 0.5 * net_max_w)) else "river"
    return "canal" if sinuosity <= 1.12 else "river"


# ------------------------------------------------------------------ principale

def detect_waterways(client, geom: dict, date_to: str | None = None, months: int = 12,
                     max_scenes: int = 24, max_cloud: float = 60.0, sens: int = 3,
                     min_len_m: float = 150.0, pct: float = 50.0, *, composite=None,
                     osm: list[dict] | None = None) -> dict:
    """Fiumi e canali esistenti nel poligono `geom` con lunghezza e larghezza.
    `composite` (dict del composito, g, dates) permette ai test di saltare il download."""
    if composite is None:
        g = _grid(geom)
        date_to = date_to or (dt.date.today() - dt.timedelta(days=3)).isoformat()
        dates = _pick_scenes(client, g["bbox_wgs"], date_to, months, max_cloud, max_scenes)
        if not dates:
            raise RuntimeError("Nessuna scena Sentinel-2 con poche nuvole nel periodo.")
        C = _composite(client, g, dates, pct=pct)
        if C["ok"] == 0:
            raise RuntimeError("Nessuna scena scaricata.")
    else:
        C, g, dates = composite
    ndwi, nir, swir, nir_wet = C["ndwi"], C["nir"], C["swir"], C["nir_wet"]
    n_ok, n_jobs = C.get("ok", len(dates)), C.get("jobs", len(dates))
    res = g["res"]
    # area del poligono (la griglia è il suo riquadro)
    poly_mask = _poly_mask(geom, g)
    ndwi = np.where(poly_mask, ndwi, np.nan)

    m_perm, core, sratio, ev = _water_mask(ndwi, swir, sens, res)
    # stato di piena (2° NDWI più alto, 2° SWIR più basso fra le date): fiumare e stagionali.
    # Dalla piena si tengono solo le forme lineari: le risaie allagate e i campi
    # bagnati per qualche settimana non diventano «bacini».
    ndwi_wet = C.get("ndwi_wet")
    if ndwi_wet is not None:
        ndwi_wet = np.where(poly_mask, ndwi_wet, np.nan)
        m_flood, _c2, sr_wet, ev_wet = _water_mask(ndwi_wet, C["swir_wet"], sens, res)
        ev = np.maximum(ev, ev_wet)
        extra = m_flood & ~ndi.binary_dilation(m_perm, iterations=2)
        lab_e, ne = ndi.label(extra, structure=np.ones((3, 3), bool))
        if ne:
            from skimage.morphology import skeletonize as _sk
            ske = _sk(extra)
            area = ndi.sum(extra, lab_e, index=np.arange(1, ne + 1))
            skl = ndi.sum(ske, lab_e, index=np.arange(1, ne + 1))
            lin = np.zeros(ne + 1, bool)
            lin[1:] = (skl >= 30) & (area / np.maximum(skl, 1) <= 12)     # lunghe ≥300 m, larghe ≤120 m
            extra = lin[lab_e]
        mask = m_perm | (m_flood & (extra | m_perm | ndi.binary_dilation(extra, iterations=1)))
        sratio = np.minimum(sratio, sr_wet)
    else:
        mask = m_perm
    # ricucitura lungo la traccia: i fiumi stretti a meandri si leggono a pezzi; ogni capo
    # libero si collega al pezzo successivo seguendo la linea d'acqua più evidente
    mask = _trace(mask & poly_mask, np.where(sratio < 0.85, ev, 0.0) * poly_mask, res)
    # mare e lagune: specchi enormi a quota ~0 sul DEM → fuori (non sono fiumi né canali)
    dem = C.get("dem")
    if dem is None and client is not None:
        try:
            k = max(1, math.ceil(max(g["wp"], g["hp"]) / 600))
            wd, hd = math.ceil(g["wp"] / k), math.ceil(g["hp"] / k)
            d = client.fetch_dem([g["minx"], g["top"] - hd * k * res, g["minx"] + wd * k * res, g["top"]], g["epsg"], wd, hd)
            dem = np.repeat(np.repeat(d, k, axis=0), k, axis=1)[:g["hp"], :g["wp"]]
        except Exception:  # noqa: BLE001 — senza DEM il mare resta (raro nei progetti)
            dem = None
    if dem is not None:
        # il Copernicus DEM mette il mare esattamente a 0,0 m (le coste e i polder no)
        sea = mask & np.isfinite(dem) & (np.abs(dem) < 0.05)
        lab0, n0 = ndi.label(sea, structure=np.ones((3, 3), bool))
        if n0:
            big = np.zeros(n0 + 1, bool)
            big[1:] = ndi.sum(sea, lab0, index=np.arange(1, n0 + 1)) * res * res >= 5e5
            mask &= ~ndi.binary_dilation(big[lab0], iterations=6)   # anche la battigia
    m_wet_b = C.get("m_wet", np.zeros(mask.shape, "uint16"))
    m_seen_b = C.get("m_seen", np.zeros(mask.shape, "uint16"))
    nir_flow = C.get("nir_flow", nir_wet)
    fin = np.isfinite(nir)
    land = fin & ~ndi.binary_dilation(mask, iterations=2)
    land_nir = float(np.nanmedian(nir[land])) if land.any() else 0.25
    wat = mask & (ndwi > 0.3) & np.isfinite(nir_wet)
    water_nir = float(np.percentile(nir_wet[wat], 10)) if wat.sum() >= 20 else 0.03
    nir_f = np.where(fin, nir, land_nir).astype("float32")
    nir_w = np.where(np.isfinite(nir_wet), nir_wet, nir_f).astype("float32")
    dt_px = ndi.distance_transform_edt(mask)

    from skimage.morphology import skeletonize
    md_all = ndi.binary_dilation(mask, iterations=1)
    lab, ncomp = ndi.label(mask, structure=np.ones((3, 3), bool))
    transform = from_origin(g["minx"], g["top"], res, res)
    segments, basins = [], []
    sk_all = skeletonize(mask)
    for v in range(1, ncomp + 1):
        comp = lab == v
        sl = ndi.find_objects(comp.astype("int8"))[0]
        sub = comp[sl]
        area_m2 = float(sub.sum()) * res * res
        sk = sk_all[sl] & sub
        sk_len = float(sk.sum()) * res
        mean_w = area_m2 / sk_len if sk_len > 0 else 1e9
        eq_d = 2 * math.sqrt(area_m2 / math.pi)
        if (sk_len < 2 * res or (mean_w > 60 and sk_len < 3 * eq_d)) and not (comp & m_perm).sum() >= 0.3 * comp.sum():
            continue                                           # bacino solo di piena (campo allagato): fuori
        if sk_len < 2 * res or (mean_w > 60 and sk_len < 3 * eq_d):
            # bacino (lago, invaso, cava allagata): contorno
            if area_m2 >= 2000:
                for gj, _ in features.shapes(comp.astype("uint8"), mask=comp, transform=transform):
                    ring = _simplify_ring([(float(x), float(y)) for x, y in gj["coordinates"][0]], res)
                    ring_ll = [[round(c, 7) for c in g["to_wgs"].transform(x, y)] for x, y in ring]
                    if len(ring_ll) >= 4:
                        if ring_ll[0] != ring_ll[-1]:
                            ring_ll.append(ring_ll[0])
                        basins.append({"kind": "basin", "area_ha": round(area_m2 / 1e4, 2),
                                       "geojson": {"type": "Polygon", "coordinates": [ring_ll]}})
                        break
            continue
        edges = _graph(sk)
        edges = _prune_merge(edges, res, max(3 * res, 30.0), dt_px[sl])
        r0, c0 = sl[0].start, sl[1].start
        for e in edges:
            px = [(r + r0, c + c0) for r, c in e["px"]]
            pts = _smooth(px)
            L = float(np.hypot(*np.diff(pts, axis=0).T).sum()) * res if len(pts) > 1 else 0.0
            closed = e["a"] == e["b"]
            iso = not closed and _is_iso(e, edges)
            if L < (min_len_m if iso else max(2 * res, 20.0)):
                continue
            perm_frac = sum(1 for p in px if m_perm[p]) / len(px)
            seasonal_axis = perm_frac < 0.5
            # corso stagionale: larghezza nei mesi in cui scorre (2° NIR più basso fra le date)
            nir_meas = np.where(np.isfinite(nir_flow), nir_flow, nir_f).astype("float32") if seasonal_axis else nir_f
            prof = _widths(pts, mask, nir_meas, dt_px, res, land_nir, water_nir)
            prof_w = _widths(pts, mask, nir_w if not seasonal_axis else nir_meas, dt_px, res, land_nir, water_nir)
            ws = np.array([w for _, w in prof]) if prof else np.array([])
            w_wet = float(np.median([w for _, w in prof_w])) if prof_w else None
            if ws.size == 0:
                w_med = float(np.mean([2 * dt_px[p] for p in px])) * res
                w_lo = w_hi = w_med
            else:
                w_med, w_lo, w_hi = (float(np.median(ws)), float(np.percentile(ws, 10)), float(np.percentile(ws, 90)))
            # verifica: lungo l'asse ci deve essere acqua vera, non una strada o un'ombra
            nd_src = ndwi_wet if (seasonal_axis and ndwi_wet is not None) else ndwi
            nd_axis = np.array([nd_src[p] for p in px if np.isfinite(nd_src[p])])
            sr_axis = float(np.median([sratio[p] for p in px]))
            if nd_axis.size == 0 or float(np.median(nd_axis)) < -0.5 or sr_axis > 0.7:
                continue
            wet_m, seen_m = _months_axis(px, m_wet_b, m_seen_b)
            reg = _regime(wet_m, seen_m)
            if reg is None:
                reg = "ephemeral" if seasonal_axis else None      # troppo pochi mesi osservati: non determinato
            elif reg == "perennial" and seasonal_axis:
                reg = "seasonal"
            if reg != "perennial" and L < 200:
                continue                                    # spezzoni di piena (barre, golene allagate)
            chord = math.hypot(*(np.asarray(px[-1]) - np.asarray(px[0]))) * res
            sinu = L / chord if chord > 1 else 9.9
            coords = _to_ll(pts, g)
            if len(coords) < 2:
                continue
            # larghezza data per data → minima e massima osservate, con la data
            lvl = {}
            nir_d = C.get("nir_dates")
            if nir_d is not None and prof:
                by_d = _width_by_date(pts, mask, nir_d, dates, dt_px, res, land_nir, water_nir, len(prof), md_all)
                if len(by_d) >= 3:
                    srt = sorted(by_d, key=lambda x: x[1])
                    j = 1 if len(srt) >= 6 else 0                   # 2° estremo: una data storta non decide
                    lo_, hi_ = srt[j], srt[-1 - j]
                    lvl = {"width_low_m": round(lo_[1], 1), "date_low": lo_[0],
                           "width_high_m": round(hi_[1], 1), "date_high": hi_[0],
                           "widths_by_date": [[d_, round(w_, 1)] for d_, w_, _ in by_d]}
            segments.append({
                "kind": "", "net": v, **lvl, "_pts": pts,
                "geojson": {"type": "LineString", "coordinates": coords},
                "length_m": round(L, 1),
                "width_m": round(w_med, 1), "width_min_m": round(w_lo, 1), "width_max_m": round(w_hi, 1),
                "width_wet_m": round(max(w_wet, w_med), 1) if w_wet is not None else None,
                "sinuosity": round(sinu, 3),
                "below_pixel": bool(w_med < res),
                "profile": [[round(a, 0), round(b, 1)] for a, b in prof],
                "ndwi": round(float(np.median(nd_axis)), 2), "swir_ratio": round(sr_axis, 2),
                "regime": reg, "months_wet": wet_m, "months_seen": seen_m,
            })
    # alvei asciutti: si escludono solo accanto all'acqua PERMANENTE (lì sono barre del
    # fiume); le pozze di piena dentro un greto non lo spezzano
    segments += _dry_beds(C, m_perm & mask, poly_mask, res, g, m_wet_b, m_seen_b, dem)
    n_osm = 0
    if osm:
        oc, gone = _osm_courses(osm, segments, g, poly_mask, mask, nir_f, dt_px, res, land_nir, water_nir,
                                m_wet_b, m_seen_b, md_all)
        segments = [sg for k, sg in enumerate(segments) if k not in gone] + oc
        n_osm = len(oc)
    nets: dict[int, list] = {}
    for sg in segments:
        nets.setdefault(sg["net"], []).append(sg)
    for lst in nets.values():
        wmax = max((x["width_m"] or 0) for x in lst)
        for x in lst:
            if not x.get("bed") and not x.get("osm"):
                x["kind"] = _classify(x["length_m"], x["width_m"], x["sinuosity"], wmax)
    # escursione di livello stimata: Δh = ΔB / (2·m), m = scarpa delle sponde.
    # Canali: sezione tipo in terra 1:1,5 (il DEM a 30 m non vede le sponde di un canale);
    # fiumi: pendenza delle sponde dal DEM.
    for sg in segments:
        pts_ = sg.pop("_pts", None)
        if sg.get("bed") or sg.get("width_low_m") is None:
            continue
        if sg.get("regime") != "perennial" or sg["width_low_m"] < 1:
            continue                    # corso che va in secca: l'escursione dalla larghezza non ha senso
        dB = max(0.0, sg["width_high_m"] - sg["width_low_m"])
        if sg["kind"] == "canal":
            m_, how = 1.5, "canal"
        else:
            s_ = _bank_slope(pts_, sg["width_m"], dem, res) if pts_ is not None else None
            if s_ is None:
                continue
            m_, how = 1.0 / max(s_, 1e-3), "dem"
            if m_ > 10:
                continue                # sponda non risolta dal DEM (golena piatta): niente stima
        sg.update({"bank_m": round(m_, 2), "bank_from": how, "level_range_m": round(dB / (2 * m_), 2)})
    for sg in segments:
        sg.pop("_pts", None)
    segments.sort(key=lambda s: s["length_m"], reverse=True)
    for k, s in enumerate(segments):
        s["id"] = k + 1
    surface = _surface(mask, g)
    return {
        "segments": segments, "basins": basins, "surface": surface,
        "n_river": sum(1 for s in segments if s["kind"] == "river"),
        "n_canal": sum(1 for s in segments if s["kind"] == "canal"),
        "n_drain": sum(1 for s in segments if s["kind"] == "drain"),
        "n_seasonal": sum(1 for s in segments if s["regime"] not in ("perennial", None)),
        "n_osm": n_osm,
        "length_m": round(sum(s["length_m"] for s in segments), 0),
        "water_ha": round(float(mask.sum()) * res * res / 1e4, 1),
        "res_m": round(res, 1), "dates": dates, "scenes_ok": n_ok, "requests": n_jobs,
    }


def _dry_beds(C: dict, water: np.ndarray, poly_mask: np.ndarray, res: float, g: dict,
              m_wet_b: np.ndarray, m_seen_b: np.ndarray, dem: np.ndarray | None,
              min_len_m: float = 600.0) -> list[dict]:
    """Alvei asciutti (greti di fiumare e torrenti): strisce lunghe di ghiaia nuda e chiara
    (NDVI mediano < 0,15, rosso > 0,15: l'asfalto è più scuro) in mezzo a terreno diverso.
    Si tengono solo le forme allungate (lunghe ≥ `min_len_m`, larghe 30-1500 m, ≥ 4 volte
    più lunghe che larghe) e non attaccate a un fiume con acqua (lì sono barre del fiume).
    Larghezza = larghezza dell'alveo (non dell'acqua)."""
    ndvi, red = C.get("ndvi"), C.get("red")
    if ndvi is None or red is None or dem is None:
        return []                       # senza quote non si distingue un alveo da un piazzale
    fin = np.isfinite(ndvi) & np.isfinite(red) & poly_mask
    bare = fin & (ndvi < 0.15) & (red > 0.15) & ~ndi.binary_erosion(water, iterations=1)
    bare = ndi.binary_opening(bare, iterations=1)                       # fuori strade e sentieri
    bare = ndi.binary_closing(bare, structure=np.ones((3, 3), bool), iterations=2) & fin
    if not bare.any():
        return []
    from skimage.morphology import skeletonize
    near_w = ndi.binary_dilation(water, iterations=2)
    demf = np.where(np.isfinite(dem), dem, np.nan).astype("float32")
    lab, n = ndi.label(bare, structure=np.ones((3, 3), bool))
    sk_all = skeletonize(bare)
    dt_px = ndi.distance_transform_edt(bare)
    out = []
    for v, sl in enumerate(ndi.find_objects(lab), start=1):
        if sl is None:
            continue
        comp = lab[sl] == v
        area = float(comp.sum()) * res * res
        sk = sk_all[sl] & comp
        L = float(sk.sum()) * res
        if L < min_len_m:
            continue
        mean_w = area / L
        eq_d = 2 * math.sqrt(area / math.pi)
        if not (30.0 <= mean_w <= 1500.0) or L < 4 * eq_d * 0.5 or L / max(mean_w, 1) < 4:
            continue
        if float((near_w[sl] & comp).sum()) > 0.2 * comp.sum():
            continue
        # contrasto: nella fascia di 300 m attorno all'alveo, poco terreno nudo
        pad = max(3, int(round(300 / res)))
        H_, W_ = bare.shape
        r0e, r1e = max(0, sl[0].start - pad), min(H_, sl[0].stop + pad)
        c0e, c1e = max(0, sl[1].start - pad), min(W_, sl[1].stop + pad)
        compe = lab[r0e:r1e, c0e:c1e] == v
        ring = ndi.binary_dilation(compe, iterations=pad) & ~compe & fin[r0e:r1e, c0e:c1e]
        if ring.sum() < 10 or float(bare[r0e:r1e, c0e:c1e][ring].mean()) > 0.33:
            continue
        edges = _prune_merge(_graph(sk), res, max(3 * mean_w, 60.0), dt_px[sl])
        r0, c0 = sl[0].start, sl[1].start
        for e in edges:
            px = [(r + r0, c + c0) for r, c in e["px"]]
            pts = _smooth(px)
            Le = float(np.hypot(*np.diff(pts, axis=0).T).sum()) * res if len(pts) > 1 else 0.0
            if Le < max(200.0, 2 * mean_w):
                continue
            ws = np.array([max(1.0, 2 * dt_px[p] - 1) * res for p in px[len(px) // 10: len(px) - len(px) // 10 or None]])
            if ws.size == 0:
                continue
            # l'alveo sta più in basso delle sponde (DEM): strade, piazzali e cave a fossa no
            off = float(np.median(ws)) / 2 / res + max(5.0, 150.0 / res)
            lows = []
            for i in range(3, len(pts) - 3, max(1, int(100 / res))):
                d = pts[i + 3] - pts[i - 3]
                Ld = math.hypot(*d)
                if Ld < 1e-6:
                    continue
                nr, nc = -d[1] / Ld, d[0] / Ld
                zc = ndi.map_coordinates(demf, [[pts[i][0]], [pts[i][1]]], order=1, mode="nearest")[0]
                za = ndi.map_coordinates(demf, [[pts[i][0] + off * nr], [pts[i][1] + off * nc]], order=1, mode="nearest")[0]
                zb = ndi.map_coordinates(demf, [[pts[i][0] - off * nr], [pts[i][1] - off * nc]], order=1, mode="nearest")[0]
                if np.isfinite([zc, za, zb]).all():
                    lows.append(min(za, zb) - zc)
            if len(lows) < 3 or float(np.median(lows)) < 0.5:
                continue
            if Le < max(500.0, 3 * float(np.median(ws))):
                continue                                    # un alveo è molto più lungo che largo
            chord = math.hypot(*(np.asarray(px[-1]) - np.asarray(px[0]))) * res
            wet_m, seen_m = _months_axis(px, m_wet_b, m_seen_b)
            reg = _regime(wet_m, seen_m)
            if reg in (None, "perennial"):
                reg = "ephemeral"
            coords = _to_ll(pts, g)
            if len(coords) < 2:
                continue
            out.append({"kind": "river", "bed": True, "net": -v,
                        "geojson": {"type": "LineString", "coordinates": coords},
                        "length_m": round(Le, 1), "width_m": round(float(np.median(ws)), 1),
                        "width_min_m": round(float(np.percentile(ws, 10)), 1), "width_max_m": round(float(np.percentile(ws, 90)), 1),
                        "width_wet_m": None, "sinuosity": round(Le / chord if chord > 1 else 9.9, 3),
                        "below_pixel": False, "profile": [], "ndwi": None, "swir_ratio": None,
                        "regime": reg, "months_wet": wet_m, "months_seen": seen_m, "_pts": pts})
    return out


# fiumi e torrenti sono naturali (non si spostano); canali, dreni e fossi sono artificiali
OSM_KIND = {"river": "river", "stream": "river", "wadi": "river", "canal": "canal", "drain": "drain", "ditch": "drain"}


def _osm_courses(osm: list[dict], segments: list[dict], g: dict, poly_mask: np.ndarray, mask: np.ndarray,
                 nir_f: np.ndarray, dt_px: np.ndarray, res: float, land_nir: float, water_nir: float,
                 m_wet_b: np.ndarray, m_seen_b: np.ndarray, md: np.ndarray) -> tuple[list[dict], set[int]]:
    """Corsi d'acqua da OpenStreetMap come tracciato COMPLETO (fiumi, torrenti, wadi, canali,
    dreni), ritagliati sull'area. Il satellite li misura: larghezza dove c'è acqua (sezioni
    agganciate all'acqua entro 50 m), mesi con acqua e regime, quota del tracciato confermata.
    I pezzi letti dal satellite che stanno sopra a un corso OSM (≥ 60% entro 60 m + metà
    larghezza) vengono assorbiti: niente doppioni. Ritorna (corsi, indici dei pezzi assorbiti)."""
    import pyproj
    from scipy.spatial import cKDTree
    to_utm = pyproj.Transformer.from_crs(4326, g["epsg"], always_xy=True)
    H, W = poly_mask.shape
    # mesi con acqua «vicino» all'asse (l'asse OSM può essere spostato di qualche pixel)
    wet_d = np.zeros_like(m_wet_b)
    for b in range(12):
        bit = (m_wet_b & np.uint16(1 << b)) > 0
        if bit.any():
            wet_d |= np.where(ndi.binary_dilation(bit, iterations=3), np.uint16(1 << b), np.uint16(0))
    pieces = []
    for w in osm:
        kind = OSM_KIND.get(str(w.get("waterway", "")))
        co = w.get("coords") or []
        if not kind or len(co) < 2:
            continue
        xy = [to_utm.transform(float(p[0]), float(p[1])) for p in co]
        rc = np.array([((g["top"] - y) / res - 0.5, (x - g["minx"]) / res - 0.5) for x, y in xy])
        dense = [rc[0]]
        for a, b in zip(rc[:-1], rc[1:]):
            n = max(1, int(math.ceil(math.hypot(*(b - a)) / 0.5)))
            dense += [a + (b - a) * (k / n) for k in range(1, n + 1)]
        dense = np.array(dense)
        ri, ci = np.rint(dense[:, 0]).astype(int), np.rint(dense[:, 1]).astype(int)
        ins = (ri >= 0) & (ri < H) & (ci >= 0) & (ci < W)
        ins[ins] = poly_mask[ri[ins], ci[ins]]
        # pezzi dentro l'area (un fiume che esce e rientra dà più pezzi)
        k = 0
        while k < len(dense):
            if not ins[k]:
                k += 1
                continue
            j = k
            while j < len(dense) and ins[j]:
                j += 1
            pc = dense[k:j]
            if len(pc) >= 2 and float(np.hypot(*np.diff(pc, axis=0).T).sum()) * res >= 50:
                pieces.append({"w": w, "kind": kind, "pts": pc})
            k = j
    if not pieces:
        return [], set()
    allp = np.concatenate([p["pts"] for p in pieces])
    pid = np.concatenate([np.full(len(p["pts"]), i) for i, p in enumerate(pieces)])
    tree = cKDTree(allp)
    absorbed: dict[int, list[int]] = {}
    gone: set[int] = set()
    for si, sg in enumerate(segments):
        P = sg.get("_pts")
        if P is None or len(P) < 2:
            continue
        lim = (60.0 + (sg.get("width_m") or 0) / 2) / res
        d, ix = tree.query(P)
        near = d <= lim
        if near.mean() >= 0.6:
            vals, cnt = np.unique(pid[ix[near]], return_counts=True)
            absorbed.setdefault(int(vals[np.argmax(cnt)]), []).append(si)
            gone.add(si)
    # acqua di ogni pezzo di satellite (asse ± metà larghezza): un corso OSM si misura solo
    # sulla SUA acqua, non su quella di un canale o di un fiume che attraversa
    seg_lab = np.zeros((H, W), "int32")
    for si, sg in enumerate(segments):
        P = sg.get("_pts")
        if P is None or si not in gone:
            continue
        rad = int(math.ceil((sg.get("width_m") or res) / 2 / res)) + 2
        Pi = np.rint(np.asarray(P)).astype(int)
        r0, r1 = max(0, Pi[:, 0].min() - rad - 1), min(H, Pi[:, 0].max() + rad + 2)
        c0, c1 = max(0, Pi[:, 1].min() - rad - 1), min(W, Pi[:, 1].max() + rad + 2)
        win = np.zeros((r1 - r0, c1 - c0), bool)
        ok_ = (Pi[:, 0] >= r0) & (Pi[:, 0] < r1) & (Pi[:, 1] >= c0) & (Pi[:, 1] < c1)
        win[Pi[ok_, 0] - r0, Pi[ok_, 1] - c0] = True
        win = ndi.binary_dilation(win, iterations=rad) & md[r0:r1, c0:c1]
        seg_lab[r0:r1, c0:c1][win] = si + 1
    out = []
    for i, pc in enumerate(pieces):
        w, kind, pts = pc["w"], pc["kind"], pc["pts"]
        sm = _smooth([tuple(p) for p in pts[::2]] if len(pts) > 6 else [tuple(p) for p in pts])
        L = float(np.hypot(*np.diff(pts, axis=0).T).sum()) * res
        own = absorbed.get(i, [])
        if own:
            md_own = np.isin(seg_lab, np.array(own) + 1)
            prof = _widths(sm, mask & md_own, nir_f, dt_px, res, land_nir, water_nir, md=md_own, snap_px=50.0 / res)
            near_own = ndi.binary_dilation(md_own, iterations=3)
        else:
            prof, near_own = [], None
        px = list({(int(round(r)), int(round(c))) for r, c in pts[::4]})
        px = [p for p in px if 0 <= p[0] < H and 0 <= p[1] < W]
        wet_m, seen_m = _months_axis(px, wet_d, m_seen_b)
        reg = _regime(wet_m, seen_m)
        # quota del tracciato confermata dal satellite: acqua entro 3 pixel
        cover = float(np.mean([near_own[p] for p in px])) if (px and near_own is not None) else 0.0
        subs = [segments[j] for j in absorbed.get(i, [])]
        ws = np.array([x for _, x in prof if x > 0.5])           # sezioni senza acqua: niente misura
        ws = ws if ws.size >= 3 else np.array([])
        width = w_lo = w_hi = None
        if ws.size:
            width, w_lo, w_hi = float(np.median(ws)), float(np.percentile(ws, 10)), float(np.percentile(ws, 90))
        elif subs:
            lens = np.array([x["length_m"] for x in subs]); wv = np.array([x["width_m"] for x in subs])
            o = np.argsort(wv); cw = np.cumsum(lens[o]); width = float(wv[o][np.searchsorted(cw, cw[-1] / 2)])
            w_lo, w_hi = float(min(x["width_min_m"] for x in subs)), float(max(x["width_max_m"] for x in subs))
        elif w.get("width"):
            try:
                width = float(str(w["width"]).replace(",", ".").split()[0])
            except ValueError:
                width = None
        best = max(subs, key=lambda x: x["length_m"]) if subs else {}
        beds = [x for x in subs if x.get("bed")]
        use_bed = bool(beds) and (not ws.size or cover < 0.3)    # fiumara: conta l'alveo, non le pozze
        if use_bed:
            # fiumara: il corso OSM prende la larghezza dell'alveo di ghiaia letto dal satellite
            lens = np.array([x["length_m"] for x in beds]); wv = np.array([x["width_m"] for x in beds])
            o = np.argsort(wv); cw = np.cumsum(lens[o]); width = float(wv[o][np.searchsorted(cw, cw[-1] / 2)])
            w_lo, w_hi = float(min(x["width_min_m"] for x in beds)), float(max(x["width_max_m"] for x in beds))
        coords = _to_ll(pts, g)
        if len(coords) < 2:
            continue
        chord = math.hypot(*(pts[-1] - pts[0])) * res
        out.append({
            "kind": kind, "osm": True, "osm_id": w.get("id"), "osm_type": w.get("waterway"),
            "name": w.get("name") or None, "net": -100000 - i,
            "geojson": {"type": "LineString", "coordinates": coords},
            "length_m": round(L, 1),
            "width_m": round(width, 1) if width is not None else None,
            "width_min_m": round(w_lo, 1) if w_lo is not None else None,
            "width_max_m": round(w_hi, 1) if w_hi is not None else None,
            "width_wet_m": best.get("width_wet_m"),
            "sinuosity": round(L / chord if chord > 1 else 9.9, 3),
            "below_pixel": bool(width is not None and width < res),
            "profile": [[round(a, 0), round(b, 1)] for a, b in prof],
            "ndwi": None, "swir_ratio": None,
            # senza acqua vista dal satellite il regime non si sa (corso troppo stretto o asciutto):
            # resta da determinare, salvo che OSM lo segni intermittente
            "regime": ("ephemeral" if (str(w.get("intermittent", "")) == "yes" or beds) else None) if (cover < 0.05 and not wet_m) else reg,
            "bed": use_bed,
            "months_wet": wet_m, "months_seen": seen_m, "sat_cover": round(cover, 2),
            **{k: best[k] for k in ("width_low_m", "date_low", "width_high_m", "date_high", "widths_by_date") if k in best},
            "_pts": sm,
        })
    # pezzi dello stesso corso (stesso nome e tipo) senza misura: larghezza e regime dei pezzi
    # misurati (un fiume diviso alle confluenze resta lo stesso fiume)
    by_name: dict[tuple, list] = {}
    for o in out:
        if o.get("name"):
            by_name.setdefault((o["name"], o["kind"]), []).append(o)
    for grp in by_name.values():
        meas = [o for o in grp if o.get("width_m") is not None]
        if not meas or len(meas) == len(grp):
            continue
        lens = np.array([o["length_m"] for o in meas]); wv = np.array([o["width_m"] for o in meas])
        o_ = np.argsort(wv); cw = np.cumsum(lens[o_]); wmed = float(wv[o_][np.searchsorted(cw, cw[-1] / 2)])
        ref = max(meas, key=lambda o: o["length_m"])
        for o in grp:
            if o.get("width_m") is None:
                o.update(width_m=round(wmed, 1), width_min_m=ref.get("width_min_m"), width_max_m=ref.get("width_max_m"),
                         bed=ref.get("bed", False), width_from="same_course")
                if o.get("regime") is None:
                    o["regime"] = ref.get("regime")
    return out, gone


def _is_iso(e, edges) -> bool:
    """Tratto isolato (nessun altro tratto ai suoi nodi)."""
    for o in edges:
        if o is e:
            continue
        if o["a"] in (e["a"], e["b"]) or o["b"] in (e["a"], e["b"]):
            return False
    return True


def _poly_mask(geom: dict, g: dict) -> np.ndarray:
    import pyproj
    to_utm = pyproj.Transformer.from_crs(4326, g["epsg"], always_xy=True)
    rings = [[to_utm.transform(x, y) for x, y, *_ in ring] for ring in geom["coordinates"]]
    shp = {"type": "Polygon", "coordinates": rings}
    tr = from_origin(g["minx"], g["top"], g["res"], g["res"])
    return features.rasterize([(shp, 1)], out_shape=(g["hp"], g["wp"]), transform=tr, fill=0, dtype="uint8").astype(bool)


def _surface(mask: np.ndarray, g: dict, max_rings: int = 400) -> list[dict]:
    """Superficie d'acqua (poligoni) per il KMZ."""
    res = g["res"]
    tr = from_origin(g["minx"], g["top"], res, res)
    out = []
    for gj, _ in features.shapes(mask.astype("uint8"), mask=mask, transform=tr):
        rings = []
        for k, ring in enumerate(gj["coordinates"]):
            if k and len(ring) < 8:
                continue                                     # isolotti minimi
            r = _simplify_ring([(float(x), float(y)) for x, y in ring], res * 0.7)
            ll = [[round(c, 7) for c in g["to_wgs"].transform(x, y)] for x, y in r]
            if len(ll) >= 4:
                if ll[0] != ll[-1]:
                    ll.append(ll[0])
                rings.append(ll)
        if rings:
            out.append({"type": "Polygon", "coordinates": rings})
        if len(out) >= max_rings:
            break
    return out
