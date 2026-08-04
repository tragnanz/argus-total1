"""Esportazione immagini satellitari per la pagina "Immagini satellitari".

Per un'area (poligono lon/lat) e delle date scelte, produce per ogni indice
agricolo un GeoTIFF georeferenziato (valori reali, apribile in QGIS) e un PNG
colorato per la visualizzazione, più il colore reale RGB. Tutto in un unico ZIP.
"""
from __future__ import annotations

import datetime as dt
import io
import zipfile

import math

import numpy as np
import pyproj

from .geo_prep import utm_epsg
from .geometry.grid import Grid
from .indices import REQUIRED_BANDS, SUPPORTED, compute_index
from .masking import scl_valid_mask
from .providers.cdse import BANDS

# indici selezionabili: gli 8 spettrali + il colore reale RGB
EXPORTABLE = list(SUPPORTED) + ["rgb"]

# (cmap matplotlib, vmin, vmax) per il PNG colorato di ogni indice
_CMAP = {
    "ndvi": ("RdYlGn", -0.1, 0.9),
    "ndre": ("RdYlGn", -0.1, 0.8),
    "ndmi": ("BrBG", -0.4, 0.4),
    "msi": ("BrBG_r", 0.2, 1.6),
    "savi": ("RdYlGn", -0.1, 0.9),
    "evi": ("RdYlGn", -0.1, 0.9),
    "gndvi": ("RdYlGn", -0.1, 0.9),
    "ndwi": ("Blues", -0.3, 0.6),
}


def _grid_for(geom: dict, res_m: float = 10.0, max_dim: int = 1200):
    """Griglia UTM (solo bounding box) per l'area. Calcolo LEGGERO: niente
    maschera punto-per-punto del poligono (per l'export scarico tutto il riquadro,
    non serve). Sceglie subito la risoluzione per stare sotto `max_dim`, così
    un'area di decine di km non fa esaurire la RAM (che darebbe 'Failed to fetch').
    Ritorna (grid, epsg, res_m)."""
    rings = geom.get("coordinates") or []
    pts = [p for ring in rings for p in ring]
    if not pts:
        raise ValueError("Geometria vuota")
    lon0 = sum(p[0] for p in pts) / len(pts)
    lat0 = sum(p[1] for p in pts) / len(pts)
    epsg = utm_epsg(lon0, lat0)
    to_utm = pyproj.Transformer.from_crs(4326, epsg, always_xy=True)
    xs, ys = [], []
    for x, y in pts:
        ux, uy = to_utm.transform(x, y)
        xs.append(ux); ys.append(uy)
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    span = max(maxx - minx, maxy - miny, res_m)
    while span / res_m > max_dim:      # coarsening cheap, senza costruire griglie
        res_m *= 1.5
    W = max(1, int(math.ceil((maxx - minx) / res_m)))
    H = max(1, int(math.ceil((maxy - miny) / res_m)))
    return Grid(H, W, res_m, x0=minx, y0=miny), epsg, res_m


def _bbox_utm(grid, res_m):
    minx, miny = grid.x0, grid.y0
    return [minx, miny, minx + grid.width * res_m, miny + grid.height * res_m]


def list_scenes(client, geom: dict, months_back: int = 12,
                max_cloud: float = 95, limit: int = 80) -> list[dict]:
    """Scene Sentinel-2 disponibili per l'area negli ultimi `months_back` mesi,
    più recenti prima: [{date, cloud}]."""
    _epsg, minx, miny, maxx, maxy, to_wgs = _utm_bbox(geom)
    lo_a, la_a = to_wgs.transform(minx, miny)
    lo_b, la_b = to_wgs.transform(maxx, maxy)
    bbox = [min(lo_a, lo_b), min(la_a, la_b), max(lo_a, lo_b), max(la_a, la_b)]
    today = dt.date.today()
    start = today - dt.timedelta(days=int(months_back * 31))
    return client.search_scenes(bbox, start.isoformat(), today.isoformat(),
                                max_cloud=max_cloud, limit=limit)


def _geotiff_bytes(arr, epsg, x0, maxy, res_m, dtype="float32") -> bytes:
    """GeoTIFF in memoria (nord in alto). arr (H,W) o (C,H,W)."""
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.transform import from_origin

    arr = np.asarray(arr)
    if arr.ndim == 2:
        arr = arr[None]
    transform = from_origin(x0, maxy, res_m, res_m)
    nodata = float("nan") if dtype == "float32" else None
    with MemoryFile() as mf:
        with mf.open(driver="GTiff", height=arr.shape[1], width=arr.shape[2],
                     count=arr.shape[0], dtype=dtype,
                     crs=rasterio.crs.CRS.from_epsg(epsg),
                     transform=transform, nodata=nodata) as ds:
            ds.write(arr.astype(dtype))
        return mf.read()


_PNG_MAX_PX = 1400   # i PNG servono solo a visualizzare: cap sul lato (il GeoTIFF
#                       resta a piena risoluzione). Evita array RGBA giganti → OOM.


def _downsample(a: np.ndarray, max_px: int = _PNG_MAX_PX) -> np.ndarray:
    h, w = a.shape[:2]
    s = max(1, int(math.ceil(max(h, w) / max_px)))
    return a[::s, ::s] if s > 1 else a


import os

# Logo Nabu (bianco, PNG con trasparenza) applicato in basso alle foto esportate.
# Se il file esiste viene usato il logo reale; altrimenti si disegna il wordmark
# testuale "NABU". Percorso configurabile via env NABU_LOGO_PATH.
_LOGO_CANDIDATES = [
    os.environ.get("NABU_LOGO_PATH", ""),
    os.path.join(os.path.dirname(__file__), "..", "assets", "nabu-logo-white.png"),
]
_BRAND = "NABU"


def _brand_font(size: int):
    """Font TrueType (DejaVuSans-Bold via matplotlib, sempre presente); fallback
    al font bitmap di PIL se qualcosa va storto."""
    from PIL import ImageFont
    try:
        import matplotlib.font_manager as fm
        path = fm.findfont(fm.FontProperties(weight="bold"))
        return ImageFont.truetype(path, size)
    except Exception:  # noqa: BLE001
        try:
            return ImageFont.load_default()
        except Exception:  # noqa: BLE001
            return None


def _brand_logo(target_h: int):
    """Logo Nabu ritagliato al contenuto (via canale alfa) e ridimensionato
    all'altezza della fascia, o None se non presente."""
    from PIL import Image
    for p in _LOGO_CANDIDATES:
        if p and os.path.isfile(p):
            try:
                logo = Image.open(p).convert("RGBA")
                alpha = np.asarray(logo)[..., 3]
                ys, xs = np.where(alpha > 10)      # bbox del contenuto opaco
                if len(xs):
                    logo = logo.crop((int(xs.min()), int(ys.min()),
                                      int(xs.max()) + 1, int(ys.max()) + 1))
                scale = target_h / logo.height
                return logo.resize((max(1, int(logo.width * scale)), target_h), Image.LANCZOS)
            except Exception:  # noqa: BLE001
                return None
    return None


def _watermark_rgb(rgb: np.ndarray) -> np.ndarray:
    """Aggiunge in basso una fascia con il logo Nabu (bianco) e il copyright."""
    import datetime as _dt
    from PIL import Image, ImageDraw
    rgb = np.ascontiguousarray(rgb)
    h, w = rgb.shape[:2]
    band_h = max(22, int(round(w * 0.05)))
    img = Image.fromarray(rgb).convert("RGBA")
    # fascia scura semitrasparente → il bianco resta leggibile su ogni sfondo
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(overlay).rectangle([0, h - band_h, w, h], fill=(0, 0, 0, 120))
    img = Image.alpha_composite(img, overlay)
    draw = ImageDraw.Draw(img)
    pad = max(6, int(band_h * 0.28))
    top = h - band_h
    white = (255, 255, 255, 255)

    x = pad
    logo = _brand_logo(int(band_h * 0.78))
    if logo is not None:
        img.paste(logo, (x, top + (band_h - logo.height) // 2), logo)
        x += logo.width + pad
    else:
        f_big = _brand_font(int(band_h * 0.55))
        if f_big is not None:
            tb = draw.textbbox((0, 0), _BRAND, font=f_big)
            ty = top + (band_h - (tb[3] - tb[1])) // 2 - tb[1]
            draw.text((x, ty), _BRAND, font=f_big, fill=white)
            x += (tb[2] - tb[0]) + pad

    cright = f"© {_dt.date.today().year} {_BRAND} · Argus Smart"
    f_small = _brand_font(max(9, int(band_h * 0.36)))
    if f_small is not None:
        cb = draw.textbbox((0, 0), cright, font=f_small)
        cy = top + (band_h - (cb[3] - cb[1])) // 2 - cb[1]
        draw.text((w - pad - (cb[2] - cb[0]), cy), cright, font=f_small, fill=white)
    return np.asarray(img.convert("RGB"))


def _png_from_rgb(rgb: np.ndarray, watermark: bool = False) -> bytes:
    """PNG da un array RGB (H,W,3) uint8. Usa Pillow (presente: matplotlib lo
    richiede) → leggero. Ridimensiona sopra il cap per non esaurire la memoria.
    watermark=True: logo Nabu + copyright in basso (solo per le foto esportate)."""
    from PIL import Image
    rgb = np.ascontiguousarray(_downsample(rgb))
    if watermark:
        rgb = _watermark_rgb(rgb)
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="PNG")
    return buf.getvalue()


def _get_cmap(name):
    """Colormap robusta fra versioni di matplotlib: la API moderna è
    matplotlib.colormaps[name]; cm.get_cmap è stato rimosso in matplotlib ≥3.9."""
    import matplotlib
    try:
        return matplotlib.colormaps[name]
    except Exception:  # noqa: BLE001 — fallback per matplotlib vecchie
        import matplotlib.cm as cm
        return cm.get_cmap(name)


def _png_index(arr, cmap, vmin, vmax, watermark: bool = False) -> bytes:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.colors as mcolors

    arr = _downsample(arr)              # ridimensiona PRIMA della colorazione (memoria)
    norm = mcolors.Normalize(vmin=vmin, vmax=vmax, clip=True)
    filled = np.where(np.isfinite(arr), arr, vmin)
    rgb = (_get_cmap(cmap)(norm(filled))[..., :3] * 255).astype("uint8")
    rgb[~np.isfinite(arr)] = 200        # NaN → grigio neutro
    return _png_from_rgb(rgb, watermark=watermark)


def _cmap_stops(cmap_name, n: int = 16) -> list[str]:
    """Elenco di colori HEX campionati dalla colormap (per disegnare la barra di
    scala/legenda nel frontend, da vmin a vmax)."""
    cmap = _get_cmap(cmap_name)
    stops = []
    for i in range(n):
        r, g, b = cmap(i / (n - 1))[:3]
        stops.append(f"#{int(r*255):02x}{int(g*255):02x}{int(b*255):02x}")
    return stops


def _auto_range(arr, cmap_name, vmin, vmax) -> tuple[float, float]:
    """Range normalizzato sui dati reali dell'area (percentili 2–98), per il
    contrasto massimo. Se i dati sono insufficienti, ricade sul range fisso."""
    finite = arr[np.isfinite(arr)]
    if finite.size < 16:
        return vmin, vmax
    lo = float(np.percentile(finite, 2))
    hi = float(np.percentile(finite, 98))
    if not np.isfinite(lo) or not np.isfinite(hi) or hi - lo < 1e-4:
        return vmin, vmax
    return lo, hi


def _rgb_uint8(bd: dict) -> np.ndarray:
    """Colore reale (3,H,W) uint8 da riflettanza 0..1 (stretch 0..0.3)."""
    def st(x):
        return np.clip(np.nan_to_num(x) / 0.3, 0, 1)
    return (np.stack([st(bd["B04"]), st(bd["B03"]), st(bd["B02"])], 0) * 255).astype("uint8")


# ---- Tiling: aree grandi divise in tessere, scaricate a piena risoluzione e
# ricomposte in un mosaico. Tetto tessere per non superare il timeout di Render.
MAX_TILES = 4   # 2×2: compromesso sicuro tempo/quota (auto-adatta sotto questo)


def _utm_bbox(geom: dict):
    pts = [p for ring in (geom.get("coordinates") or []) for p in ring]
    if not pts:
        raise ValueError("Geometria vuota")
    lon0 = sum(p[0] for p in pts) / len(pts)
    lat0 = sum(p[1] for p in pts) / len(pts)
    epsg = utm_epsg(lon0, lat0)
    to_utm = pyproj.Transformer.from_crs(4326, epsg, always_xy=True)
    to_wgs = pyproj.Transformer.from_crs(epsg, 4326, always_xy=True)
    xs, ys = [], []
    for x, y in pts:
        ux, uy = to_utm.transform(x, y)
        xs.append(ux); ys.append(uy)
    return epsg, min(xs), min(ys), max(xs), max(ys), to_wgs


def _plan_grid(minx, miny, maxx, maxy, res_m=10.0, max_dim=1200, max_tiles=MAX_TILES):
    """Numero di tessere (nx×ny) e risoluzione: usa più tessere per tenere la
    piena risoluzione, ma non oltre `max_tiles` (poi ricampiona)."""
    spanx, spany = maxx - minx, maxy - miny

    def plan(res):
        wp = max(1, int(math.ceil(spanx / res)))
        hp = max(1, int(math.ceil(spany / res)))
        nx = max(1, int(math.ceil(wp / max_dim)))
        ny = max(1, int(math.ceil(hp / max_dim)))
        return wp, hp, nx, ny

    res = res_m
    wp, hp, nx, ny = plan(res)
    while nx * ny > max_tiles:
        res *= 1.25
        wp, hp, nx, ny = plan(res)
    return res, wp, hp, nx, ny


def _edges(n_px, n_tiles):
    return [int(round(k * n_px / n_tiles)) for k in range(n_tiles + 1)]


def _stitch(client, epsg, minx, miny, top, res, wp, hp, nx, ny, day, sel):
    """Scarica le tessere e ricompone un mosaico per ciascun indice in `sel`.
    Ritorna (mosaici: dict indice→array, n_calls, n_ok)."""
    xs, ys = _edges(wp, nx), _edges(hp, ny)
    mos = {idx: (np.zeros((3, hp, wp), "uint8") if idx == "rgb"
                 else np.full((hp, wp), np.nan, "float32")) for idx in sel}
    n_calls = n_ok = 0
    for j in range(ny):
        r0, r1 = ys[j], ys[j + 1]
        for i in range(nx):
            c0, c1 = xs[i], xs[i + 1]
            w, h = c1 - c0, r1 - r0
            if w <= 0 or h <= 0:
                continue
            tx0, tx1 = minx + c0 * res, minx + c1 * res
            ty_top, ty_bot = top - r0 * res, top - r1 * res
            n_calls += 1
            try:
                arr = client.fetch_bands([tx0, ty_bot, tx1, ty_top], epsg, w, h, day)
            except Exception:  # noqa: BLE001
                continue
            n_ok += 1
            bd = {n: arr[k] for k, n in enumerate(BANDS)}
            valid = scl_valid_mask(bd["SCL"])
            for idx in sel:
                if idx == "rgb":
                    mos[idx][:, r0:r1, c0:c1] = _rgb_uint8(bd)
                else:
                    vals = compute_index(idx, {b: bd[b] for b in REQUIRED_BANDS})
                    mos[idx][r0:r1, c0:c1] = np.where(valid, vals, np.nan)
            del arr, bd, valid
    return mos, n_calls, n_ok


def preview(client, geom: dict, index: str, date: str,
            max_tiles: int = MAX_TILES, normalized: bool = False) -> tuple[str, list, dict]:
    """Anteprima sulla mappa: mosaico dell'indice per una data → PNG (data URL) +
    bounds lat/lon per l'overlay Leaflet, + meta (tessere, risoluzione, scala).

    normalized=True: la scala colori si adatta ai valori reali dell'area
    (percentili 2–98) → contrasto massimo. Altrimenti scala fissa dell'indice."""
    import base64
    idx = index.lower()
    if idx not in EXPORTABLE:
        idx = "ndvi"
    epsg, minx, miny, maxx, maxy, to_wgs = _utm_bbox(geom)
    # Anteprima = UNA sola immagine leggera dell'intera area (mostrata a
    # risoluzione schermo sulla mappa): 1 chiamata, memoria minima → non può
    # andare in timeout/OOM a nessuna dimensione. Il tiling a piena risoluzione
    # resta per il download (GeoTIFF). max_tiles=1, lato ≤ 1000 px.
    res, wp, hp, nx, ny = _plan_grid(minx, miny, maxx, maxy, max_dim=1000, max_tiles=1)
    top = miny + hp * res
    mos, n_calls, n_ok = _stitch(client, epsg, minx, miny, top, res, wp, hp, nx, ny, date, [idx])
    if n_ok == 0:
        raise RuntimeError("Nessuna tessera scaricata per la data scelta.")
    arr = mos[idx]

    def _url(png_bytes):
        return "data:image/png;base64," + base64.b64encode(png_bytes).decode()

    scale = None
    variants = None
    if idx == "rgb":
        # colore reale: nessuna scala/normalizzazione
        dataurl = _url(_png_from_rgb(np.transpose(arr, (1, 2, 0))))
    else:
        cmap, fmin, fmax = _CMAP.get(idx, ("viridis", -1.0, 1.0))
        nmin, nmax = _auto_range(arr, cmap, fmin, fmax)
        stops = _cmap_stops(cmap)
        # Una sola chiamata Copernicus → produce ENTRAMBE le rese (scala fissa e
        # normalizzata). Il frontend commuta tra le due senza riscaricare nulla.
        fixed = {"image": _url(_png_index(arr, cmap, fmin, fmax)),
                 "scale": {"cmap": cmap, "vmin": round(float(fmin), 3),
                           "vmax": round(float(fmax), 3), "colors": stops}}
        norm = {"image": _url(_png_index(arr, cmap, nmin, nmax)),
                "scale": {"cmap": cmap, "vmin": round(float(nmin), 3),
                          "vmax": round(float(nmax), 3), "colors": stops}}
        variants = {"fixed": fixed, "normalized": norm}
        chosen = norm if normalized else fixed
        dataurl = chosen["image"]
        scale = chosen["scale"]
    corners = [(minx, miny), (minx + wp * res, miny), (minx + wp * res, top), (minx, top)]
    lls = [to_wgs.transform(x, y) for x, y in corners]
    lons = [p[0] for p in lls]; lats = [p[1] for p in lls]
    bounds = [[min(lats), min(lons)], [max(lats), max(lons)]]   # [[S,W],[N,E]]
    meta = {"index": idx, "date": date, "grid": f"{nx}×{ny}", "tiles": nx * ny,
            "res_m": round(res, 1), "calls": n_calls, "normalized": bool(normalized)}
    if scale:
        meta["scale"] = scale
    if variants:
        meta["variants"] = variants
    return dataurl, bounds, meta


def export_bundle(client, geom: dict, dates: list[str],
                  indices: list[str]) -> tuple[bytes, dict]:
    """Ritorna (zip_bytes, meta). Aree grandi divise in tessere e ricomposte a
    piena risoluzione. Tetto chiamate: tessere ridotte se ci sono molte date."""
    sel = [i.lower() for i in indices if i.lower() in EXPORTABLE] or ["ndvi"]
    epsg, minx, miny, maxx, maxy, to_wgs = _utm_bbox(geom)
    # meno tessere se molte date, così le chiamate totali restano sotto ~6
    tile_cap = max(1, 6 // max(1, len(dates)))
    tile_cap = min(tile_cap, MAX_TILES)
    res, wp, hp, nx, ny = _plan_grid(minx, miny, maxx, maxy, max_tiles=tile_cap)
    top = miny + hp * res

    zbuf = io.BytesIO()
    meta = {"scenes": 0, "requests": 0, "epsg": epsg, "res_m": round(res, 1),
            "grid": f"{nx}×{ny}", "tiles": nx * ny}
    with zipfile.ZipFile(zbuf, "w", zipfile.ZIP_DEFLATED) as z:
        for day in dates:
            mos, n_calls, n_ok = _stitch(client, epsg, minx, miny, top, res,
                                         wp, hp, nx, ny, day, sel)
            meta["requests"] += n_calls
            if n_ok == 0:
                continue
            meta["scenes"] += 1
            for idx in sel:
                arr = mos[idx]
                if idx == "rgb":
                    z.writestr(f"{day}/RGB_{day}.tif",
                               _geotiff_bytes(arr, epsg, minx, top, res, dtype="uint8"))
                    z.writestr(f"{day}/RGB_{day}.png",
                               _png_from_rgb(np.transpose(arr, (1, 2, 0)), watermark=True))
                else:
                    z.writestr(f"{day}/{idx.upper()}_{day}.tif",
                               _geotiff_bytes(arr, epsg, minx, top, res))
                    cmap, vmin, vmax = _CMAP.get(idx, ("viridis", -1.0, 1.0))
                    z.writestr(f"{day}/{idx.upper()}_{day}.png",
                               _png_index(arr, cmap, vmin, vmax, watermark=True))
            del mos
            import gc
            gc.collect()
        readme = (
            "Argus Smart - Immagini satellitari (Sentinel-2 L2A, Copernicus/CDSE)\n\n"
            f"Area EPSG:{epsg}, risoluzione {res:.0f} m, mosaico {nx}x{ny} tessere.\n"
            "Per ogni data e indice: file .tif georeferenziato (valori reali, QGIS)\n"
            "e .png colorato per la visualizzazione. RGB = colore reale.\n"
            "Indici: NDVI, NDRE, NDMI, MSI, SAVI, EVI, GNDVI, NDWI.\n"
        )
        z.writestr("LEGGIMI.txt", readme)
    return zbuf.getvalue(), meta
