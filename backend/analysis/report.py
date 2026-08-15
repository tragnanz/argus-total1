"""Scheda progetto Argus Total (PDF brandizzato Nabu) — Milestone 4, multilingua.

Compone una scheda con: dati progetto, sintesi idoneità (M2), configurazione del
layout e KPI (M3), rete idraulica, dimensionamento idrico, fasi di sviluppo e uno
SCHEMA del layout (cerchi pivot colorati per fase, canale, pompe, condotte).

Font: DejaVu Sans (latino/cirillico/arabo) impacchettato in assets/fonts, font CID
STSong-Light per il cinese, reshaping arabo (RTL) se le librerie sono presenti.
"""
from __future__ import annotations

import io
import math
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon as MplPoly

from .report_i18n import tr, RTL, fmt_num, fmt_date

BRAND = "#038037"
# Palette della tavola tecnica (misurata sulle tavole di settore).
_CYAN = "#00d1ff"        # confini dei poligoni e tubazioni
_GREEN = "#2ee0a1"       # cerchi dei pivot
_INK = "#123524"         # riquadri scuri e cornice


def _halo():
    """Contorno scuro attorno al testo bianco: lo rende leggibile sull'ortofoto."""
    import matplotlib.patheffects as pe
    return [pe.withStroke(linewidth=1.6, foreground="#0b2318")]

ACCENT = "#20aae2"
PHASE_COLORS = ["#038037", "#20aae2", "#87bf59", "#f0b429", "#b23b1e", "#6b21a8"]

_ASSETS = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets")
_CJK_TTF = os.path.join(_ASSETS, "fonts", "NabuCJK.ttf")   # cinese incorporato (subset)
_FONTS_READY = False
_HAS_CJK = False


def _ensure_fonts() -> None:
    global _FONTS_READY, _HAS_CJK
    if _FONTS_READY:
        return
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    fdir = os.path.join(_ASSETS, "fonts")
    try:
        pdfmetrics.registerFont(TTFont("Deja", os.path.join(fdir, "DejaVuSans.ttf")))
        pdfmetrics.registerFont(TTFont("Deja-Bold", os.path.join(fdir, "DejaVuSans-Bold.ttf")))
    except Exception:  # noqa: BLE001
        pass
    if os.path.exists(_CJK_TTF):
        try:  # cinese: TTF (TrueType) INCORPORATO nel PDF → resa ovunque
            pdfmetrics.registerFont(TTFont("Nabu-CJK", _CJK_TTF))
            _HAS_CJK = True
        except Exception:  # noqa: BLE001
            _HAS_CJK = False
    if not _HAS_CJK:  # fallback: font CID (richiede font asiatici nel lettore)
        try:
            from reportlab.pdfbase.cidfonts import UnicodeCIDFont
            pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        except Exception:  # noqa: BLE001
            pass
    _FONTS_READY = True


def _fonts(lang: str) -> tuple[str, str]:
    if lang == "zh":
        return ("Nabu-CJK", "Nabu-CJK") if _HAS_CJK else ("STSong-Light", "STSong-Light")
    return "Deja", "Deja-Bold"


def _shape(lang: str, s: str) -> str:
    """Reshaping + bidi per l'arabo (rende corretto il testo RTL)."""
    if lang not in RTL:
        return s
    try:
        import arabic_reshaper
        from bidi.algorithm import get_display
        return get_display(arabic_reshaper.reshape(s))
    except Exception:  # noqa: BLE001 — degrada senza rompere
        return s


def _find_cjk() -> str | None:
    if os.path.exists(_CJK_TTF):          # preferisci il font incorporato (portabile)
        return _CJK_TTF
    import matplotlib.font_manager as fm
    for f in fm.fontManager.ttflist:
        n = (f.name or "")
        if any(k in n for k in ("CJK", "Noto Sans CJK", "WenQuanYi", "SimSun", "Song", "Hei", "Droid Sans Fallback")):
            return f.fname
    return None


# ---------------------------------------------------------------------------
# Sfondo satellitare della planimetria
#
# La scheda mostra il campo sull'ortofoto, con la stessa fonte usata dalla
# mappa del sito (Esri World Imagery), così il PDF e la schermata coincidono.
# Le tessere sono in Web Mercator: per sovrapporre la geometria senza
# deformazioni si proietta tutto in metri Mercator invece di disegnare in
# gradi. Se la rete non risponde si torna allo schema su sfondo bianco.
# ---------------------------------------------------------------------------
_TILE_URL = ("https://server.arcgisonline.com/ArcGIS/rest/services/"
             "World_Imagery/MapServer/tile/{z}/{y}/{x}")
_TILE_PX = 256
_R_MERC = 6378137.0
_WORLD = 2.0 * math.pi * _R_MERC
_SAT_CREDIT = "Esri · Maxar · Earthstar Geographics"


def _merc(lon: float, lat: float) -> tuple[float, float]:
    """lon/lat (gradi) → Web Mercator (metri)."""
    lat = max(-85.05112878, min(85.05112878, lat))
    x = math.radians(lon) * _R_MERC
    y = math.log(math.tan(math.pi / 4.0 + math.radians(lat) / 2.0)) * _R_MERC
    return x, y


def _merc_ring(ring):
    return [_merc(p[0], p[1]) for p in ring]


def _unmerc(x: float, y: float) -> tuple[float, float]:
    """Web Mercator (metri) → lon/lat (gradi)."""
    lon = math.degrees(x / _R_MERC)
    lat = math.degrees(2.0 * math.atan(math.exp(y / _R_MERC)) - math.pi / 2.0)
    return lon, lat


def _tile_of(lon: float, lat: float, z: int) -> tuple[float, float]:
    """Coordinate (frazionarie) di tessera per lon/lat allo zoom z."""
    n = 2 ** z
    x, y = _merc(lon, lat)
    return (x + _WORLD / 2) / _WORLD * n, (_WORLD / 2 - y) / _WORLD * n


_SESSION = None


def _session():
    """Sessione HTTP riusata fra le tessere.

    Con una GET indipendente per tessera si paga handshake TLS e risoluzione
    DNS decine di volte: su un'istanza che si sta risvegliando basta questo a
    far scadere i tempi e a lasciare la tavola senza ortofoto.
    """
    global _SESSION
    if _SESSION is None:
        import requests
        from requests.adapters import HTTPAdapter
        se = requests.Session()
        se.headers.update({"User-Agent": "ArgusTotal/1.0 (scheda PDF)"})
        ad = HTTPAdapter(pool_connections=4, pool_maxsize=16, max_retries=1)
        se.mount("https://", ad)
        se.mount("http://", ad)
        _SESSION = se
    return _SESSION


def _fetch_tile(z: int, x: int, y: int, timeout: float):
    from PIL import Image
    # (connessione, lettura): la connessione deve essere rapida, il download
    # di una tessera puo' invece prendersi qualche secondo in piu'.
    r = _session().get(_TILE_URL.format(z=z, x=x, y=y), timeout=(timeout, timeout * 2))
    r.raise_for_status()
    return Image.open(io.BytesIO(r.content)).convert("RGB")


def _satellite_bg(lon_min: float, lat_min: float, lon_max: float, lat_max: float,
                  max_tiles: int = 80, max_zoom: int = 18, timeout: float = 6.0,
                  budget_s: float = 25.0, max_px: int = 2200):
    """Mosaico di ortofoto che copre il riquadro. Ritorna (immagine, estensione
    in metri Mercator) oppure (None, None) se le tessere non arrivano.

    Lo zoom si sceglie sulla LARGHEZZA UTILE (`max_px`), non sul massimo che sta
    nel tetto di tessere: scaricare un mosaico da 4000 px per poi ridurlo a 2200
    costa banda e, soprattutto, memoria — su un'istanza piccola e' la differenza
    fra una scheda e un riavvio del servizio.
    """
    try:
        from concurrent.futures import ThreadPoolExecutor
        from PIL import Image
    except Exception:  # noqa: BLE001
        return None, None

    chosen = None
    for z in range(max_zoom, 2, -1):
        x0f, y0f = _tile_of(lon_min, lat_max, z)     # angolo alto-sinistra
        x1f, y1f = _tile_of(lon_max, lat_min, z)     # angolo basso-destra
        tx0, ty0, tx1, ty1 = int(x0f), int(y0f), int(x1f), int(y1f)
        nx_, ny_ = tx1 - tx0 + 1, ty1 - ty0 + 1
        if nx_ * ny_ <= max_tiles and nx_ * _TILE_PX <= max_px * 1.35:
            chosen = (z, tx0, ty0, tx1, ty1)
            break
    if chosen is None:
        return None, None
    z, tx0, ty0, tx1, ty1 = chosen
    nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1

    # Tetto complessivo: se la rete e' lenta si rinuncia allo sfondo invece di
    # tenere in sospeso la generazione della scheda.
    import time
    deadline = time.monotonic() + budget_s

    def grab(t):
        if time.monotonic() > deadline:
            return None
        return _safe_tile(z, t[0], t[1], timeout)

    jobs = [(tx0 + i, ty0 + j) for j in range(ny) for i in range(nx)]
    canvas = Image.new("RGB", (nx * _TILE_PX, ny * _TILE_PX), (18, 53, 36))
    got = 0
    try:
        # Le tessere si incollano man mano che arrivano e si liberano subito:
        # tenerle tutte in una lista significa una copia in piu' del mosaico.
        with ThreadPoolExecutor(max_workers=12) as pool:
            for (tx, ty), img in zip(jobs, pool.map(grab, jobs)):
                if img is None:
                    continue
                canvas.paste(img, ((tx - tx0) * _TILE_PX, (ty - ty0) * _TILE_PX))
                img.close()
                got += 1
    except Exception:  # noqa: BLE001
        canvas.close()
        return None, None
    if got < max(1, len(jobs) // 2):
        canvas.close()
        return None, None      # quasi nulla e' arrivato: meglio lo schema pulito
    # Con qualche buco si procede comunque: un'ortofoto parziale e' piu' utile
    # di una tavola bianca.

    if canvas.width > max_px:
        h = max(1, round(canvas.height * max_px / canvas.width))
        small = canvas.resize((max_px, h), Image.BILINEAR)
        canvas.close()
        canvas = small

    n = 2 ** z
    left = -_WORLD / 2 + tx0 * _WORLD / n
    right = -_WORLD / 2 + (tx1 + 1) * _WORLD / n
    top = _WORLD / 2 - ty0 * _WORLD / n
    bottom = _WORLD / 2 - (ty1 + 1) * _WORLD / n
    return canvas, (left, right, bottom, top)


def _safe_tile(z: int, x: int, y: int, timeout: float):
    try:
        return _fetch_tile(z, x, y, timeout)
    except Exception:  # noqa: BLE001
        return None


def layout_schematic_png(geojson: dict, meta: dict, lat0: float, lang: str = "it",
                         field_geom: dict | None = None, satellite: bool = True,
                         aspect: float = 261.0 / 170.0, status: dict | None = None) -> bytes:
    """Planimetria del layout sull'ortofoto (come la mappa del sito).

    Il disegno avviene in metri Web Mercator, gli stessi delle tessere: la
    sovrapposizione è quindi esatta e non serve correggere l'aspetto con il
    coseno della latitudine. Senza rete si ricade sullo schema su bianco.
    """
    import matplotlib.font_manager as fm
    prop = None
    if lang == "zh":
        cjk = _find_cjk()
        if cjk:
            prop = fm.FontProperties(fname=cjk)
        else:
            lang = "en"   # nessun font CJK disponibile: etichette in inglese

    def LB(s: str) -> str:
        return _shape(lang, s)

    feats = geojson.get("features", [])
    # Foglio orizzontale: la figura ha lo stesso rapporto della cornice in cui
    # verra' impaginata, così la planimetria riempie la pagina.
    fig, ax = plt.subplots(figsize=(10.4, 10.4 / max(0.5, aspect)), dpi=200)
    n_ph = max(1, int(meta.get("n_phases", 1)))

    # Riquadro dei dati in lon/lat: serve a scegliere zoom e tessere.
    lons: list[float] = []
    lats: list[float] = []

    def note(coords) -> None:
        for p in coords:
            lons.append(p[0]); lats.append(p[1])

    field_ring = None
    if field_geom and field_geom.get("coordinates"):
        field_ring = field_geom["coordinates"][0]
        note(field_ring)
    for f in feats:
        g = f.get("geometry") or {}
        k = f.get("properties", {}).get("kind")
        c = g.get("coordinates")
        if c is None:
            continue
        if k == "pivot":
            note(c[0])
        elif k == "pump":
            lons.append(c[0]); lats.append(c[1])
        elif k == "canal" and field_ring:
            pass          # il canale puo' correre lontano: non allarga la tavola
        else:
            note(c)
    if not lons:
        lons, lats = [0.0], [0.0]
    lon_min, lon_max = min(lons), max(lons)
    lat_min, lat_max = min(lats), max(lats)

    # Inquadratura: si parte dai dati, si aggiunge un margine e si allarga il
    # lato corto fino al rapporto del foglio. Va fatto PRIMA di scegliere le
    # tessere, altrimenti l'ortofoto non copre le fasce laterali.
    mx0, my0 = _merc(lon_min, lat_min)
    mx1, my1 = _merc(lon_max, lat_max)
    padx = max((mx1 - mx0) * 0.05, 40.0)
    pady = max((my1 - my0) * 0.05, 40.0)
    mx0 -= padx; mx1 += padx; my0 -= pady; my1 += pady
    w, hgt = mx1 - mx0, my1 - my0
    cx, cy = (mx0 + mx1) / 2.0, (my0 + my1) / 2.0
    if w / hgt < aspect:
        w = hgt * aspect
    else:
        hgt = w / aspect
    mx0, mx1 = cx - w / 2.0, cx + w / 2.0
    my0, my1 = cy - hgt / 2.0, cy + hgt / 2.0
    lon_min, lat_min = _unmerc(mx0, my0)
    lon_max, lat_max = _unmerc(mx1, my1)

    # --- sfondo satellitare ---
    # `status` riporta l'esito al chiamante: senza, un fallimento di rete
    # resterebbe invisibile e la tavola uscirebbe su bianco senza spiegazione.
    bg = None
    if satellite:
        try:
            bg, extent = _satellite_bg(lon_min, lat_min, lon_max, lat_max)
            if status is not None:
                status["basemap"] = "ok" if bg is not None else "failed"
        except Exception as e:  # noqa: BLE001 — la scheda esce comunque
            bg, extent = None, None
            if status is not None:
                status["basemap"] = "failed"
                status["error"] = f"{type(e).__name__}: {e}"[:200]
        if bg is not None:
            ax.imshow(bg, extent=extent, origin="upper", zorder=0, interpolation="bilinear")
    elif status is not None:
        status["basemap"] = "off"

    on_sat = bg is not None
    # Su ortofoto servono tratti chiari e pieni piu' trasparenti per leggere il
    # terreno sotto; su bianco si tiene lo schema originale.
    edge = "#ffffff" if on_sat else "#0d3b26"
    fill_alpha = 0.22 if on_sat else 0.35

    if field_ring:
        ax.add_patch(MplPoly(_merc_ring(field_ring), closed=True, facecolor="none",
                             edgecolor="#f0b429" if on_sat else BRAND,
                             linewidth=1.8, zorder=2))

    kinds: dict[str, bool] = {}
    for f in feats:
        k = f["properties"].get("kind")
        g = f["geometry"]
        kinds[k] = True
        if k == "pivot":
            ring = _merc_ring(g["coordinates"][0])
            ph = int(f["properties"].get("phase", 1))
            col = PHASE_COLORS[(ph - 1) % len(PHASE_COLORS)]
            ax.add_patch(MplPoly(ring, closed=True, facecolor=col, edgecolor=edge,
                                 linewidth=0.7, alpha=fill_alpha, zorder=3))
            ax.add_patch(MplPoly(ring, closed=True, facecolor="none", edgecolor=edge,
                                 linewidth=0.7, zorder=4))
        elif k == "pipe":
            # Il layout automatico produce segmenti a due punti, il progetto
            # disegnato a mano polilinee con piu' vertici: si gestiscono uguale.
            pts = _merc_ring(g["coordinates"])
            if len(pts) >= 2:
                ax.plot([q[0] for q in pts], [q[1] for q in pts], color=ACCENT,
                        linewidth=1.1, zorder=5)
        elif k == "header":
            pts = _merc_ring(g["coordinates"])
            ax.plot([p[0] for p in pts], [p[1] for p in pts], color="#b23b1e",
                    linewidth=1.8, zorder=5)
        elif k == "canal":
            pts = _merc_ring(g["coordinates"])
            ax.plot([p[0] for p in pts], [p[1] for p in pts], color="#0b74b8",
                    linewidth=3.0, zorder=5, solid_capstyle="round")
        elif k == "pump":
            x, y = _merc(*g["coordinates"])
            ax.plot(x, y, marker="s", color="#08341c", markeredgecolor="#ffffff",
                    markeredgewidth=0.6, markersize=4, zorder=6)

    ax.set_xlim(mx0, mx1)
    ax.set_ylim(my0, my1)
    ax.set_aspect(1.0)
    ax.set_xticks([]); ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)

    cfg = tr(lang, "cfg_" + str(meta.get("config", "")))
    title = LB(f"{cfg} · {fmt_num(lang, meta.get('n_pivots', 0))} {tr(lang, 'pivots_word')} · "
              f"{tr(lang, 'packing')} {fmt_num(lang, meta.get('packing_pct', 0), 1)}%")
    ax.set_title(title, fontsize=10, color="#0d3b26", fontproperties=prop)

    # --- legenda: solo le voci effettivamente disegnate ---
    from matplotlib.lines import Line2D
    from matplotlib.patches import Patch
    handles = []
    if field_ring:
        handles.append(Line2D([0], [0], color="#f0b429" if on_sat else BRAND, linewidth=1.8,
                              label=LB(tr(lang, "leg_confine"))))
    if kinds.get("pivot"):
        if n_ph > 1:
            for i in range(n_ph):
                handles.append(Patch(facecolor=PHASE_COLORS[i % len(PHASE_COLORS)], edgecolor=edge,
                                     alpha=max(0.45, fill_alpha), label=LB(f"{tr(lang, 'fase')} {i + 1}")))
        else:
            handles.append(Patch(facecolor=PHASE_COLORS[0], edgecolor=edge, alpha=max(0.45, fill_alpha),
                                 label=LB(tr(lang, "leg_pivot"))))
    if kinds.get("pipe"):
        handles.append(Line2D([0], [0], color=ACCENT, linewidth=1.4, label=LB(tr(lang, "leg_tubazione"))))
    if kinds.get("header"):
        handles.append(Line2D([0], [0], color="#b23b1e", linewidth=1.8, label=LB(tr(lang, "leg_collettore"))))
    if kinds.get("canal"):
        handles.append(Line2D([0], [0], color="#0b74b8", linewidth=3.0,
                              label=LB(tr(lang, "leg_canale"))))
    if kinds.get("pump"):
        handles.append(Line2D([0], [0], color="#08341c", marker="s", linestyle="", markersize=6,
                              markeredgecolor="#ffffff", label=LB(tr(lang, "leg_pompa"))))
    if handles:
        leg = ax.legend(handles=handles, loc="lower left", fontsize=7.5, framealpha=0.92,
                        facecolor="#ffffff", edgecolor="#0d3b26", borderpad=0.7,
                        labelspacing=0.55, prop=prop,
                        title=LB(tr(lang, "leg_titolo")))
        if leg.get_title() is not None:
            leg.get_title().set_fontsize(8)
            leg.get_title().set_color("#0d3b26")
            if prop is not None:
                leg.get_title().set_fontproperties(prop)
        leg.set_zorder(8)

    # --- scala grafica ---
    # In Web Mercator le distanze sono dilatate di 1/cos(lat): per una barra in
    # metri reali si riporta la lunghezza nelle unita' della mappa.
    lat_mid = _unmerc(0.0, (my0 + my1) / 2.0)[1]
    k = max(0.05, math.cos(math.radians(lat_mid)))     # metri veri per unita' mappa
    span_m = (mx1 - mx0) * k
    raw = span_m / 5.0
    step = 10.0 ** math.floor(math.log10(max(1.0, raw)))
    bar_m = next((step * f for f in (5, 2, 1) if step * f <= raw), step)
    bar_u = bar_m / k
    # In basso al centro: la legenda occupa l'angolo sinistro e la rosa dei
    # venti quello destro.
    bx = (mx0 + mx1) / 2.0 - bar_u / 2.0
    by = my0 + (my1 - my0) * 0.045
    hbar = (my1 - my0) * 0.008
    for i in range(4):     # barra a scacchi, come nelle tavole tecniche
        ax.add_patch(MplPoly([(bx + i * bar_u / 4, by), (bx + (i + 1) * bar_u / 4, by),
                              (bx + (i + 1) * bar_u / 4, by + hbar), (bx + i * bar_u / 4, by + hbar)],
                             closed=True, facecolor="#ffffff" if i % 2 else "#0d3b26",
                             edgecolor="#0d3b26", linewidth=0.6, zorder=8))
    lab = f"{fmt_num(lang, bar_m / 1000.0, 1)} km" if bar_m >= 1000 else f"{fmt_num(lang, bar_m)} m"
    ax.text(bx + bar_u / 2, by + hbar * 1.5, LB(lab), ha="center", va="bottom", fontsize=7,
            color="#ffffff" if on_sat else "#0d3b26", fontproperties=prop,
            bbox=dict(facecolor="#00000055" if on_sat else "#ffffffcc", edgecolor="none", pad=1.2),
            zorder=8)

    # --- freccia del nord (in Mercator il nord e' sempre verso l'alto) ---
    nx = mx1 - (mx1 - mx0) * 0.035
    ny = my0 + (my1 - my0) * 0.045
    nl = (my1 - my0) * 0.075
    ax.annotate("", xy=(nx, ny + nl), xytext=(nx, ny),
                arrowprops=dict(facecolor="#ffffff" if on_sat else "#0d3b26",
                                edgecolor="#0d3b26", width=2.2, headwidth=8, headlength=8),
                zorder=8)
    ax.text(nx, ny + nl * 1.12, "N", ha="center", va="bottom", fontsize=9, fontweight="bold",
            color="#ffffff" if on_sat else "#0d3b26",
            bbox=dict(facecolor="#00000055" if on_sat else "#ffffffcc", edgecolor="none", pad=1.2),
            zorder=8)

    if not on_sat and satellite:
        ax.text(0.995, 0.008, LB(tr(lang, "leg_no_sat")), transform=ax.transAxes,
                ha="right", va="bottom", fontsize=5.5, color="#8a9a90",
                fontproperties=prop, zorder=7)
    if on_sat:
        ax.text(0.995, 0.008, _SAT_CREDIT, transform=ax.transAxes, ha="right", va="bottom",
                fontsize=5.5, color="#ffffff",
                bbox=dict(facecolor="#00000055", edgecolor="none", pad=1.5), zorder=7)
    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    return buf.getvalue()


def build_pdf(info: dict, field_ha: float, suit_meta: dict | None,
              layout_meta: dict, schematic_png: bytes, rev: str, lang: str = "it",
              with_sheet: bool = True, with_plan: bool = True,
              sheet_kit: dict | None = None) -> bytes:
    """Compone il PDF. `with_sheet` stampa i dati di progetto, `with_plan` la
    tavola della planimetria: si possono chiedere separatamente o insieme.

    Con `sheet_kit` la planimetria diventa la TAVOLA A3 in stile tecnico
    (cornice, cartiglio, barra laterale); senza, resta la tavola A4 semplice.
    """
    _ensure_fonts()
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.units import mm
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_RIGHT, TA_LEFT
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, NextPageTemplate,
                                    PageBreak, Paragraph, Spacer, Table,
                                    TableStyle, Image as RLImage)

    FONT, FONTB = _fonts(lang)
    rtl = lang in RTL
    align = TA_RIGHT if rtl else TA_LEFT

    def T(key, **fmt):
        return _shape(lang, tr(lang, key, **fmt))

    def L(s):
        return _shape(lang, str(s))

    buf = io.BytesIO()
    # Due formati nello stesso documento: i dati in verticale, la planimetria su
    # una pagina ORIZZONTALE dedicata (come le tavole dei software di settore).
    doc = BaseDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
                          topMargin=15 * mm, bottomMargin=15 * mm,
                          title=f"{tr(lang, 'sheet_title')} — {info.get('project_name','')}")
    _pw, _ph = A4
    _lw, _lh = landscape(A4)
    # La TAVOLA A3 si disegna interamente sul canvas della pagina: il modello
    # ha una cornice minima e tutto il contenuto arriva da onPage.
    kit = sheet_kit if (with_plan and sheet_kit) else None
    if kit:
        from .plan_sheet import draw_sheet, geometry

        _g = geometry(kit.get("fmt", "a3"))

        def _paint(cv, _doc):
            draw_sheet(cv, kit.get("map_png", b""), kit.get("pivots", []),
                       kit.get("centre", (0.0, 0.0)), kit.get("cells", []),
                       lang, kit.get("rev", rev), kit.get("fmt", "a3"))

        tavola = PageTemplate(id="tavola", pagesize=(_g["W"], _g["H"]),
                              frames=[Frame(20, 20, 40, 40, id="ft")], onPage=_paint)
    _tpl = {
        "ritratto": PageTemplate(id="ritratto", pagesize=A4, frames=[
            Frame(18 * mm, 15 * mm, _pw - 36 * mm, _ph - 30 * mm, id="fp")]),
        "orizzontale": PageTemplate(id="orizzontale", pagesize=landscape(A4), frames=[
            Frame(14 * mm, 12 * mm, _lw - 28 * mm, _lh - 24 * mm, id="fl")]),
    }
    if kit:
        _tpl["tavola"] = tavola
    # Il primo modello dell'elenco vale per la pagina 1: stampando la sola
    # planimetria si parte direttamente dalla tavola, senza pagina vuota.
    _first = "ritratto" if with_sheet else ("tavola" if kit else "orizzontale")
    _order = [_first] + [k for k in _tpl if k != _first]
    doc.addPageTemplates([_tpl[k] for k in _order])
    PLAN_W = _lw - 28 * mm
    # Spazio da lasciare a titolo, spaziatura e piè di pagina; senza la scheda
    # sulla tavola c'e' anche l'intestazione con il marchio.
    PLAN_H = _lh - 24 * mm - (26 * mm if with_sheet else 48 * mm)
    ss = getSampleStyleSheet()
    h = ParagraphStyle("h", parent=ss["Heading2"], fontName=FONTB, textColor=colors.HexColor(BRAND),
                       spaceBefore=8, spaceAfter=4, alignment=align)
    small = ParagraphStyle("s", parent=ss["Normal"], fontName=FONT, fontSize=8,
                           textColor=colors.grey, alignment=align)
    story = []

    logo = os.path.join(_ASSETS, "nabu-logo-color.png")
    title = Paragraph(f"<b>{T('sheet_title')}</b><br/><font size=11 color='#20aae2'>{L('Argus Total — Nabu')}</font>",
                      ParagraphStyle("t", parent=ss["Title"], fontName=FONTB, fontSize=17, leading=20,
                                     textColor=colors.HexColor(BRAND), alignment=align))
    # Sulla TAVOLA A3 il marchio sta nel cartiglio: l'intestazione serve solo
    # quando il documento comincia con la scheda.
    if with_sheet or not kit:
        if os.path.exists(logo):
            cells = [RLImage(logo, width=30 * mm, height=30 * mm, kind="proportional"), title]
            head = Table([cells[::-1] if rtl else cells], colWidths=[34 * mm, None] if not rtl else [None, 34 * mm])
            head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
            story.append(head)
        else:
            story.append(title)
        story.append(Spacer(1, 6))

    p_lab = ParagraphStyle("kvl", fontName=FONT, fontSize=9.5, leading=12,
                           textColor=colors.HexColor("#3b5654"), alignment=align)
    p_val = ParagraphStyle("kvv", fontName=FONT, fontSize=9.5, leading=12, alignment=align)

    def kv_table(rows):
        data = []
        for a, b in rows:
            pa = Paragraph(L(a), p_lab); pb = Paragraph(L(b), p_val)
            data.append([pb, pa] if rtl else [pa, pb])
        cols = [None, 55 * mm] if rtl else [55 * mm, None]
        tb = Table(data, colWidths=cols)
        tb.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3), ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#e3ebe5")),
        ]))
        return tb

    def data_table(rows, header_color, colw):
        data = [[L(c) for c in r] for r in rows]
        if rtl:
            data = [list(reversed(r)) for r in data]
            colw = list(reversed(colw))
        tb = Table(data, colWidths=colw)
        tb.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(header_color)),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, -1), FONT), ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("ALIGN", (0, 0), (-1, -1), "RIGHT" if rtl else "LEFT"),
            ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e3ebe5")),
        ]))
        return tb

    u_mm = tr(lang, "u_mm_day"); u_h = tr(lang, "u_h_day")

    def N(v, dec=0):
        return fmt_num(lang, v, dec)

    # Le sezioni di dati si accumulano a parte: la scheda e la tavola sono
    # stampabili separatamente (selezione lato interfaccia).
    sheet: list = []
    # --- dati progetto ---
    sheet.append(Paragraph(T("dati_progetto"), h))
    sheet.append(kv_table([
        (T("progetto"), info.get("project_name", "—")),
        (T("cliente"), info.get("client_name") or "—"),
        (T("superficie_area"), f"{N(field_ha)} ha"),
        (T("note"), info.get("notes") or "—"),
    ]))

    # --- idoneità ---
    if suit_meta:
        sheet.append(Paragraph(T("sec_idoneita"), h))
        rows = [[T("classe"), T("ettari"), "%"]] + \
               [[tr(lang, "cls_" + c["key"]), N(c["ha"]), f"{N(c['pct'], 1)}%"] for c in suit_meta.get("classes", [])]
        sheet.append(data_table(rows, BRAND, [50 * mm, 30 * mm, 20 * mm]))
        cm = suit_meta.get("climate", {})
        ai = cm.get("aridity_index")
        sheet.append(Spacer(1, 3))
        sheet.append(kv_table([
            (T("superficie_idonea"), f"{N(suit_meta.get('suitable_ha', 0))} ha"),
            (T("idoneita_media"), f"{N(suit_meta.get('mean_score', 0), 1)}/100"),
            (T("et0_pioggia"), f"{N(cm.get('eto_year_mm', 0))} mm · {N(cm.get('rain_year_mm', 0))} mm"),
            (T("deficit_aridita"), f"{N(cm.get('deficit_year_mm', 0))} mm · {N(ai, 2) if ai is not None else '—'}"),
        ]))

    # --- layout ---
    lm = layout_meta
    sheet.append(Paragraph(T("sec_layout"), h))
    orient = f"{N(lm.get('orientation_deg', 0), 1)}°" + (f" ({tr(lang,'auto')})" if lm.get("auto_orient") else "")
    sheet.append(kv_table([
        (T("configurazione"), tr(lang, "cfg_" + str(lm.get("config", "")))),
        (T("orientamento"), orient),
        (T("npivot_raggio"), f"{N(lm.get('n_pivots', 0))} · {N(lm.get('radius_m', 0))} m"),
        (T("sup_netta"), f"{N(lm.get('net_ha', 0))} ha"),
        (T("eff_pack"), f"{N(lm.get('packing_pct', 0), 1)}%"),
        (T("copertura"), f"{N(lm.get('coverage_pct', 0), 1)}%"),
        (T("trasporto"), tr(lang, "tr_" + str(lm.get("transport", "")))),
        (T("pend_max"), f"{N(lm.get('slope_max_pct', 0) * 10, 1)}‰"),
    ]))

    # --- rete idraulica ---
    sheet.append(Paragraph(T("sec_rete"), h))
    sheet.append(kv_table([
        (T("pompe"), N(lm.get("n_pumps", 0))),
        (T("tubaz_spine"), f"{N(lm.get('pipe_total_m', 0) / 1000, 1)} km ({tr(lang,'maxw')} {N(lm.get('pipe_max_m', 0))} m)"),
        (T("collettore"), f"{N(lm.get('header_m', 0) / 1000, 1)} km"),
        (T("rete_totale"), f"{N(lm.get('network_total_m', 0) / 1000, 1)} km"),
    ]))

    # --- dimensionamento idrico ---
    w = lm.get("water", {})
    sheet.append(Paragraph(T("sec_dim"), h))
    sheet.append(kv_table([
        (T("et0_etc"), f"{N(w.get('et0_peak_mm', 0), 2)} {u_mm} · ETc {N(w.get('etc_peak_mm', 0), 2)} {u_mm}"),
        (T("fabbisogno"), f"{N(w.get('gross_mm_day', 0), 2)} {u_mm} ({tr(lang,'effw')} {N(w.get('efficiency', 0), 2)}, {N(w.get('hours_day', 0))} {u_h})"),
        (T("portata_pivot"), f"{N(w.get('q_pivot_ls', 0), 1)} l/s ({N(w.get('q_pivot_m3h', 0), 1)} m³/h)"),
        (T("portata_totale"), f"{N(w.get('q_total_ls', 0))} l/s ({N(w.get('q_total_m3h', 0))} m³/h)"),
        (T("volume_giorn"), f"{N(w.get('vol_total_day_m3', 0))} m³"),
    ]))

    # --- fasi ---
    phases = lm.get("phases", [])
    if len(phases) > 1:
        sheet.append(Paragraph(T("sec_fasi"), h))
        rows = [[T("fase"), T("pivot_h"), T("ettari"), T("portata_ls")]] + \
               [[N(p["phase"]), N(p["n_pivots"]), N(p["net_ha"]), N(p["q_ls"])] for p in phases]
        sheet.append(data_table(rows, ACCENT, [20 * mm, 25 * mm, 30 * mm, 35 * mm]))

    if with_sheet:
        story.extend(sheet)

    # --- planimetria ---
    if with_plan and kit:
        # Tavola A3: il contenuto lo disegna onPage, alla pagina basta un
        # segnaposto per essere emessa.
        if with_sheet:
            story.append(NextPageTemplate("tavola"))
            story.append(PageBreak())
        story.append(Spacer(1, 1))
    elif with_plan and schematic_png:
        if with_sheet:      # la tavola segue la scheda, su una pagina propria
            story.append(NextPageTemplate("orizzontale"))
            story.append(PageBreak())
        story.append(Paragraph(T("sec_schema"), h))
        story.append(RLImage(io.BytesIO(schematic_png), width=PLAN_W, height=PLAN_H, kind="proportional"))

    if not (with_plan and kit):
        story.append(Spacer(1, 6))
        import datetime as _dt
        foot = tr(lang, "footer", rev=rev) + " · " + fmt_date(lang, _dt.date.today())
        story.append(Paragraph(_shape(lang, foot), small))

    doc.build(story)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Mappa della TAVOLA (stile tecnico): ortofoto a tutta area, poligoni ciano con
# vertici numerati, pivot verdi con etichetta, badge del nord e barra di scala
# con il rapporto. Le proporzioni sono quelle del riquadro mappa della tavola.
# ---------------------------------------------------------------------------
def plan_map_png(rings: list[list[list[float]]], pivots: list[dict],
                 pipes: list[list[list[float]]], canals: list[list[list[float]]],
                 lang: str = "it", px_w: int = 1810, px_h: int = 1296,
                 status: dict | None = None, lk: float = 1.0, fk: float = 1.0,
                 detail: float = 1.0, printed_pt: float = 1006.0) -> tuple[bytes, float]:
    """Ritorna (png, denominatore della scala) per il riquadro mappa.

    `pivots` = [{lat, lon, r, ha, q_m3h, p_bar, n}], `rings` gli anelli dei
    poligoni in lon/lat. La scala e' calcolata sulla larghezza stampata del
    riquadro (1006 pt = 354,9 mm).
    """
    import matplotlib.font_manager as fm
    from matplotlib.patches import Circle, FancyBboxPatch

    prop = None
    if lang == "zh":
        cjk = _find_cjk()
        if cjk:
            prop = fm.FontProperties(fname=cjk)
        else:
            lang = "en"

    def LB(s: str) -> str:
        return _shape(lang, s)

    aspect = px_w / float(px_h)
    fig = plt.figure(figsize=(px_w / 200.0, px_h / 200.0), dpi=200)
    ax = fig.add_axes([0, 0, 1, 1])          # la mappa riempie tutto il riquadro

    lons: list[float] = []
    lats: list[float] = []
    for rg in rings:
        for p in rg:
            lons.append(p[0]); lats.append(p[1])
    for pv in pivots:
        dlat = pv["r"] / 110540.0
        dlon = pv["r"] / (111320.0 * max(0.1, math.cos(math.radians(pv["lat"]))))
        lons += [pv["lon"] - dlon, pv["lon"] + dlon]
        lats += [pv["lat"] - dlat, pv["lat"] + dlat]
    if not lons:
        lons, lats = [0.0], [0.0]

    mx0, my0 = _merc(min(lons), min(lats))
    mx1, my1 = _merc(max(lons), max(lats))
    padx = max((mx1 - mx0) * 0.06, 60.0)
    pady = max((my1 - my0) * 0.06, 60.0)
    mx0 -= padx; mx1 += padx; my0 -= pady; my1 += pady
    w, hgt = mx1 - mx0, my1 - my0
    cx, cy = (mx0 + mx1) / 2.0, (my0 + my1) / 2.0
    if w / hgt < aspect:
        w = hgt * aspect
    else:
        hgt = w / aspect
    mx0, mx1 = cx - w / 2.0, cx + w / 2.0
    my0, my1 = cy - hgt / 2.0, cy + hgt / 2.0

    lo0, la0 = _unmerc(mx0, my0)
    lo1, la1 = _unmerc(mx1, my1)
    bg = None
    try:
        bg, extent = _satellite_bg(lo0, la0, lo1, la1, max_tiles=110, max_px=px_w)
        if status is not None:
            status["basemap"] = "ok" if bg is not None else "failed"
    except Exception as e:  # noqa: BLE001
        bg, extent = None, None
        if status is not None:
            status["basemap"] = "failed"
            status["error"] = f"{type(e).__name__}: {e}"[:200]

    # L'ortofoto NON passa da imshow: matplotlib la convertirebbe in RGBA a
    # virgola mobile, decine di MB per una tavola grande. Si disegna invece il
    # solo vettoriale su fondo trasparente e si compone con PIL, in uint8.
    base_img = None
    if bg is not None:
        from PIL import Image
        left, right, bottom, top = extent
        sx = bg.width / (right - left)
        sy = bg.height / (top - bottom)
        box = (int(round((mx0 - left) * sx)), int(round((top - my1) * sy)),
               int(round((mx1 - left) * sx)), int(round((top - my0) * sy)))
        box = (max(0, box[0]), max(0, box[1]),
               min(bg.width, max(box[0] + 1, box[2])), min(bg.height, max(box[1] + 1, box[3])))
        base_img = bg.resize((px_w, px_h), Image.BILINEAR, box=box)
        bg.close()

    # --- canali e tubazioni ---
    for cc in canals:
        pts = _merc_ring(cc)
        ax.plot([p[0] for p in pts], [p[1] for p in pts], color="#0b74b8",
                linewidth=3.4 * lk, zorder=3, solid_capstyle="round", solid_joinstyle="round")
    for pl in pipes:
        pts = _merc_ring(pl)
        if len(pts) >= 2:
            ax.plot([p[0] for p in pts], [p[1] for p in pts], color=_CYAN,
                    linewidth=1.6 * lk, zorder=4, solid_capstyle="round")

    # --- poligoni con vertici numerati ---
    vn = 0
    for rg in rings:
        pts = _merc_ring(rg)
        ax.plot([p[0] for p in pts], [p[1] for p in pts], color=_CYAN,
                linewidth=2.2 * lk, zorder=5, solid_capstyle="round")
        uniq = pts[:-1] if len(pts) > 2 and pts[0] == pts[-1] else pts
        # Oltre un centinaio di vertici le sigle si accavallano: restano i punti.
        show_labels = len(uniq) <= int(120 * detail)
        for (vx, vy) in uniq:
            vn += 1
            ax.plot(vx, vy, marker="o", color=_CYAN, markersize=3.4 * lk,
                    markeredgecolor="#ffffff", markeredgewidth=0.5, zorder=6)
            if show_labels:
                ax.text(vx + w * 0.004, vy + hgt * 0.004, f"V{vn}", fontsize=5.2 * fk,
                        color="#ffffff", fontproperties=prop, zorder=7,
                        path_effects=_halo())

    # --- pivot ---
    # Quanto e' grande un pivot sul foglio decide cosa vale la pena disegnare:
    # a scale piccole la trama dei getti diventa una macchia grigia e le
    # etichette complete si sovrappongono, quindi si degrada con eleganza.
    # E' anche la voce piu' pesante del disegno: con oltre cento macchine i
    # cerchi tratteggiati generano milioni di segmenti.
    px_per_unit = px_w / (mx1 - mx0)
    for pv in pivots:
        pc = _merc(pv["lon"], pv["lat"])
        # il raggio va convertito nelle unita' della mappa (Mercator dilata)
        ru = pv["r"] / max(0.05, math.cos(math.radians(pv["lat"])))
        r_px = ru * px_per_unit
        ax.add_patch(Circle(pc, ru, facecolor="none", edgecolor=_GREEN,
                            linewidth=1.6 * lk, zorder=8))
        if r_px >= 26 / detail:
            rings = max(3, min(14, int(r_px / 9)))
            for j in range(1, rings + 1):
                ax.add_patch(Circle(pc, ru * j / (rings + 1.0), facecolor="none",
                                    edgecolor="#ffffff", linewidth=0.4 * lk, alpha=0.5,
                                    linestyle=(0, (1.6, 3.2)), zorder=8))
        ax.plot(pc[0], pc[1], marker="o", color="#ffffff", markersize=3.2 * lk,
                markeredgecolor=_INK, markeredgewidth=0.7 * lk, zorder=9)

        if r_px < 46 / detail:
            # Troppo piccolo per una targhetta: resta il numero, i dettagli
            # sono nella barra laterale.
            ax.text(pc[0], pc[1] + ru * 0.42, str(pv["n"]), fontsize=6.0 * fk,
                    fontweight="bold", color="#ffffff", ha="center", va="center",
                    fontproperties=prop, zorder=11, path_effects=_halo())
            continue

        head = f"{pv['n']} · {fmt_num(lang, pv['r'])}m · {fmt_num(lang, pv['ha'], 1)}ha"
        sub = []
        if pv.get("q_m3h"):
            sub.append(f"Q {fmt_num(lang, pv['q_m3h'])} m³/h")
        if pv.get("p_bar"):
            sub.append(f"P {fmt_num(lang, pv['p_bar'], 2)} bar")
        ty = pc[1] + ru * 0.52
        ax.text(pc[0], ty, LB(head), fontsize=7.0 * fk, fontweight="bold", color="#ffffff",
                ha="center", va="center", fontproperties=prop, zorder=11,
                bbox=dict(boxstyle="round,pad=0.45", facecolor=_INK + "e0", edgecolor="none"))
        if sub:
            ax.text(pc[0], ty - hgt * 0.021, LB(" · ".join(sub)), fontsize=6.0 * fk,
                    color="#dfeee7", ha="center", va="center", fontproperties=prop, zorder=11,
                    bbox=dict(boxstyle="round,pad=0.35", facecolor=_INK + "e0", edgecolor="none"))

    ax.set_xlim(mx0, mx1); ax.set_ylim(my0, my1)
    ax.set_aspect(1.0)
    ax.set_xticks([]); ax.set_yticks([])
    for sp in ax.spines.values():
        sp.set_visible(False)

    # --- scala: rapporto reale sulla larghezza stampata (1006 pt) ---
    lat_mid = _unmerc(0.0, cy)[1]
    k = max(0.05, math.cos(math.radians(lat_mid)))     # metri veri per unita' mappa
    span_m = (mx1 - mx0) * k
    printed_m = printed_pt / 72.0 * 0.0254             # larghezza del riquadro in metri
    denom = span_m / printed_m
    raw = span_m / 4.5
    step = 10.0 ** math.floor(math.log10(max(1.0, raw)))
    bar_m = next((step * f for f in (5, 2, 1) if step * f <= raw), step)
    bar_u = bar_m / k

    bx = mx0 + (mx1 - mx0) * 0.030
    by = my0 + (my1 - my0) * 0.045
    hb = (my1 - my0) * 0.010
    ax.add_patch(FancyBboxPatch((bx - bar_u * 0.06, by - hb * 2.2),
                                bar_u * 1.55, hb * 5.2,
                                boxstyle="round,pad=0.0,rounding_size=" + str(hb),
                                facecolor=_INK + "c8", edgecolor="none", zorder=12))
    for i in range(4):
        ax.add_patch(MplPoly([(bx + i * bar_u / 4, by), (bx + (i + 1) * bar_u / 4, by),
                              (bx + (i + 1) * bar_u / 4, by + hb), (bx + i * bar_u / 4, by + hb)],
                             closed=True, facecolor="#ffffff" if i % 2 else _INK,
                             edgecolor="#ffffff", linewidth=0.6, zorder=13))
    ax.text(bx, by - hb * 0.7, "0", fontsize=5.6 * fk, color="#ffffff", ha="left", va="top",
            fontproperties=prop, zorder=13)
    lab = f"{fmt_num(lang, bar_m / 1000.0, 1)} km" if bar_m >= 1000 else f"{fmt_num(lang, bar_m)} m"
    ax.text(bx + bar_u, by - hb * 0.7, LB(lab), fontsize=5.6 * fk, color="#ffffff",
            ha="right", va="top", fontproperties=prop, zorder=13)
    ax.text(bx + bar_u * 1.12, by + hb * 0.4, f"1:{round(denom / 500) * 500:d}",
            fontsize=8.0 * fk, fontweight="bold", color="#ffffff", ha="left", va="center",
            fontproperties=prop, zorder=13)

    # --- badge del nord, in alto a destra dentro la mappa ---
    W = mx1 - mx0
    H = my1 - my0
    nx = mx1 - W * 0.030
    nbw, nbh = W * 0.026, H * 0.075          # riquadro del badge
    nby = my1 - H * 0.020 - nbh
    ax.add_patch(FancyBboxPatch((nx - nbw / 2, nby), nbw, nbh,
                                boxstyle="round,pad=0.0,rounding_size=" + str(nbw * 0.18),
                                facecolor=_INK + "c8", edgecolor="none", zorder=12))
    ax.text(nx, nby + nbh * 0.80, "N", fontsize=8.0 * fk, fontweight="bold", color="#ffffff",
            ha="center", va="center", zorder=13)
    ax.annotate("", xy=(nx, nby + nbh * 0.62), xytext=(nx, nby + nbh * 0.10),
                arrowprops=dict(facecolor="#ffffff", edgecolor="none", width=1.8,
                                headwidth=6.5, headlength=6.5), zorder=13)

    from PIL import Image
    over = io.BytesIO()
    fig.savefig(over, format="png", dpi=200, transparent=True)
    plt.close(fig)
    over.seek(0)
    layer = Image.open(over).convert("RGBA")
    if base_img is None:
        base_img = Image.new("RGB", layer.size, (221, 230, 223))
    elif base_img.size != layer.size:
        base_img = base_img.resize(layer.size, Image.BILINEAR)
    base_img.paste(layer, (0, 0), layer)
    layer.close(); over.close()

    # JPEG e non PNG: e' una fotografia. Il PNG senza perdite pesa 3-4 volte
    # tanto e reportlab lo deve comunque ricodificare in RGB grezzo.
    buf = io.BytesIO()
    base_img.save(buf, format="JPEG", quality=88, optimize=False, progressive=False)
    base_img.close()
    return buf.getvalue(), denom
