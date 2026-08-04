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


def layout_schematic_png(geojson: dict, meta: dict, lat0: float, lang: str = "it") -> bytes:
    """Disegno schematico del layout dai feature GeoJSON (lon/lat)."""
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
    fig, ax = plt.subplots(figsize=(9, 5.2), dpi=150)
    n_ph = max(1, int(meta.get("n_phases", 1)))

    for f in feats:
        k = f["properties"].get("kind")
        g = f["geometry"]
        if k == "pivot":
            ring = g["coordinates"][0]
            ph = int(f["properties"].get("phase", 1))
            col = PHASE_COLORS[(ph - 1) % len(PHASE_COLORS)]
            ax.add_patch(MplPoly(ring, closed=True, facecolor=col, edgecolor="#0d3b26",
                                 linewidth=0.5, alpha=0.35))
        elif k == "pipe":
            (x1, y1), (x2, y2) = g["coordinates"]
            ax.plot([x1, x2], [y1, y2], color=ACCENT, linewidth=0.7, zorder=3)
        elif k == "header":
            xs = [c[0] for c in g["coordinates"]]; ys = [c[1] for c in g["coordinates"]]
            ax.plot(xs, ys, color="#b23b1e", linewidth=1.6, zorder=3)
        elif k == "canal":
            xs = [c[0] for c in g["coordinates"]]; ys = [c[1] for c in g["coordinates"]]
            ax.plot(xs, ys, color="#0284c7", linewidth=2.2, linestyle=(0, (6, 4)), zorder=2)
        elif k == "pump":
            x, y = g["coordinates"]
            ax.plot(x, y, marker="s", color="#08341c", markersize=3.5, zorder=4)

    ax.set_aspect(1.0 / max(0.2, math.cos(math.radians(lat0))))
    ax.set_xticks([]); ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    cfg = tr(lang, "cfg_" + str(meta.get("config", "")))
    title = LB(f"{cfg} · {fmt_num(lang, meta.get('n_pivots', 0))} {tr(lang, 'pivots_word')} · "
              f"{tr(lang, 'packing')} {fmt_num(lang, meta.get('packing_pct', 0), 1)}%")
    ax.set_title(title, fontsize=10, color="#0d3b26", fontproperties=prop)
    if n_ph > 1:
        handles = [plt.Line2D([0], [0], marker="o", linestyle="", markersize=7,
                              markerfacecolor=PHASE_COLORS[i % len(PHASE_COLORS)],
                              markeredgecolor="#0d3b26", label=LB(f"{tr(lang, 'fase')} {i + 1}"))
                   for i in range(n_ph)]
        ax.legend(handles=handles, loc="upper right", fontsize=7, framealpha=0.9,
                  prop=prop)
    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    return buf.getvalue()


def build_pdf(info: dict, field_ha: float, suit_meta: dict | None,
              layout_meta: dict, schematic_png: bytes, rev: str, lang: str = "it") -> bytes:
    _ensure_fonts()
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_RIGHT, TA_LEFT
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                    TableStyle, Image as RLImage)

    FONT, FONTB = _fonts(lang)
    rtl = lang in RTL
    align = TA_RIGHT if rtl else TA_LEFT

    def T(key, **fmt):
        return _shape(lang, tr(lang, key, **fmt))

    def L(s):
        return _shape(lang, str(s))

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=15 * mm, bottomMargin=15 * mm,
                            title=f"{tr(lang, 'sheet_title')} — {info.get('project_name','')}")
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

    # --- dati progetto ---
    story.append(Paragraph(T("dati_progetto"), h))
    story.append(kv_table([
        (T("progetto"), info.get("project_name", "—")),
        (T("cliente"), info.get("client_name") or "—"),
        (T("superficie_area"), f"{N(field_ha)} ha"),
        (T("note"), info.get("notes") or "—"),
    ]))

    # --- idoneità ---
    if suit_meta:
        story.append(Paragraph(T("sec_idoneita"), h))
        rows = [[T("classe"), T("ettari"), "%"]] + \
               [[tr(lang, "cls_" + c["key"]), N(c["ha"]), f"{N(c['pct'], 1)}%"] for c in suit_meta.get("classes", [])]
        story.append(data_table(rows, BRAND, [50 * mm, 30 * mm, 20 * mm]))
        cm = suit_meta.get("climate", {})
        ai = cm.get("aridity_index")
        story.append(Spacer(1, 3))
        story.append(kv_table([
            (T("superficie_idonea"), f"{N(suit_meta.get('suitable_ha', 0))} ha"),
            (T("idoneita_media"), f"{N(suit_meta.get('mean_score', 0), 1)}/100"),
            (T("et0_pioggia"), f"{N(cm.get('eto_year_mm', 0))} mm · {N(cm.get('rain_year_mm', 0))} mm"),
            (T("deficit_aridita"), f"{N(cm.get('deficit_year_mm', 0))} mm · {N(ai, 2) if ai is not None else '—'}"),
        ]))

    # --- layout ---
    lm = layout_meta
    story.append(Paragraph(T("sec_layout"), h))
    orient = f"{N(lm.get('orientation_deg', 0), 1)}°" + (f" ({tr(lang,'auto')})" if lm.get("auto_orient") else "")
    story.append(kv_table([
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
    story.append(Paragraph(T("sec_rete"), h))
    story.append(kv_table([
        (T("pompe"), N(lm.get("n_pumps", 0))),
        (T("tubaz_spine"), f"{N(lm.get('pipe_total_m', 0) / 1000, 1)} km ({tr(lang,'maxw')} {N(lm.get('pipe_max_m', 0))} m)"),
        (T("collettore"), f"{N(lm.get('header_m', 0) / 1000, 1)} km"),
        (T("rete_totale"), f"{N(lm.get('network_total_m', 0) / 1000, 1)} km"),
    ]))

    # --- dimensionamento idrico ---
    w = lm.get("water", {})
    story.append(Paragraph(T("sec_dim"), h))
    story.append(kv_table([
        (T("et0_etc"), f"{N(w.get('et0_peak_mm', 0), 2)} {u_mm} · ETc {N(w.get('etc_peak_mm', 0), 2)} {u_mm}"),
        (T("fabbisogno"), f"{N(w.get('gross_mm_day', 0), 2)} {u_mm} ({tr(lang,'effw')} {N(w.get('efficiency', 0), 2)}, {N(w.get('hours_day', 0))} {u_h})"),
        (T("portata_pivot"), f"{N(w.get('q_pivot_ls', 0), 1)} l/s ({N(w.get('q_pivot_m3h', 0), 1)} m³/h)"),
        (T("portata_totale"), f"{N(w.get('q_total_ls', 0))} l/s ({N(w.get('q_total_m3h', 0))} m³/h)"),
        (T("volume_giorn"), f"{N(w.get('vol_total_day_m3', 0))} m³"),
    ]))

    # --- fasi ---
    phases = lm.get("phases", [])
    if len(phases) > 1:
        story.append(Paragraph(T("sec_fasi"), h))
        rows = [[T("fase"), T("pivot_h"), T("ettari"), T("portata_ls")]] + \
               [[N(p["phase"]), N(p["n_pivots"]), N(p["net_ha"]), N(p["q_ls"])] for p in phases]
        story.append(data_table(rows, ACCENT, [20 * mm, 25 * mm, 30 * mm, 35 * mm]))

    # --- schema layout ---
    story.append(Paragraph(T("sec_schema"), h))
    story.append(RLImage(io.BytesIO(schematic_png), width=170 * mm, height=98 * mm, kind="proportional"))

    story.append(Spacer(1, 6))
    import datetime as _dt
    foot = tr(lang, "footer", rev=rev) + " · " + fmt_date(lang, _dt.date.today())
    story.append(Paragraph(_shape(lang, foot), small))

    doc.build(story)
    return buf.getvalue()
