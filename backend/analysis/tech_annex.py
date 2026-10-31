"""Allegato tecnico dell'impianto (PDF, libreria grafica Nabu).

Documento tecnico da allegare all'offerta: NON e' un'offerta e non porta
prezzi, costi o importi di nessun tipo (i prezzi stanno solo in Mercurius).
I contenuti arrivano gia' composti e tradotti dall'interfaccia (sezioni a
voci e tabelle); qui si impaginano copertina, sezioni e la planimetria su
ortofoto disegnata dagli stessi elementi del file .ceres (campi, pivot,
tubazioni con diametro, cavi, stazioni di pompaggio).
"""
from __future__ import annotations

import io
import math
import os
import re

from .report import (BRAND, N_BODY, N_BORDER, N_GREEN10, N_HEAD, N_MUTED, N_SOFT, _ASSETS,
                     _ensure_fonts, _font_head, _fonts, _merc, _satellite_bg, _shape, _SAT_CREDIT)

_PRICE = re.compile(r"€|\bEUR\b|\beuro\b", re.I)


def _no_prices(s: str) -> str:
    """Rete di sicurezza: un allegato tecnico non deve mai mostrare importi."""
    if _PRICE.search(s or ""):
        raise ValueError("L'allegato tecnico non può contenere prezzi o importi.")
    return s


def plan_png(features: list[dict], px_w: int = 2400, px_h: int = 1560) -> bytes | None:
    """Planimetria su ortofoto (Web Mercator) dagli elementi GeoJSON del .ceres."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Circle, Polygon as MplPoly, Wedge
    import matplotlib.patheffects as pe

    lons: list[float] = []
    lats: list[float] = []

    def walk(c):
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            lons.append(float(c[0])); lats.append(float(c[1]))
        elif isinstance(c, (list, tuple)):
            for x in c:
                walk(x)

    for f in features:
        walk((f.get("geometry") or {}).get("coordinates"))
        pr = f.get("properties") or {}
        if pr.get("tipo") == "impianto" and pr.get("raggio_m"):
            lo, la = f["geometry"]["coordinates"]
            r = float(pr["raggio_m"]) + float(pr.get("gittata_m") or 0)
            dla = r / 110540.0; dlo = r / (111320.0 * max(0.1, math.cos(math.radians(la))))
            lons += [lo - dlo, lo + dlo]; lats += [la - dla, la + dla]
    if not lons:
        return None
    x0, y0 = _merc(min(lons), min(lats)); x1, y1 = _merc(max(lons), max(lats))
    pad = max((x1 - x0), (y1 - y0)) * 0.06 + 40
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad
    aspect = px_w / px_h
    w, h = x1 - x0, y1 - y0
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    if w / h < aspect:
        w = h * aspect
    else:
        h = w / aspect
    x0, x1, y0, y1 = cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2

    fig = plt.figure(figsize=(px_w / 200, px_h / 200), dpi=200)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(x0, x1); ax.set_ylim(y0, y1); ax.set_aspect("equal"); ax.axis("off")
    from .report import _unmerc
    lw0, ls0 = _unmerc(x0, y0); le0, ln0 = _unmerc(x1, y1)
    img, ext = _satellite_bg(lw0, ls0, le0, ln0, max_tiles=80, max_px=2600)
    if img is not None:
        ax.imshow(img, extent=ext, origin="upper", zorder=0)
        ax.add_patch(plt.Rectangle((x0, y0), w, h, color="white", alpha=0.18, zorder=1))
        img.close()
    else:
        ax.add_patch(plt.Rectangle((x0, y0), w, h, color="#F4F6F4", zorder=0))
    halo = [pe.withStroke(linewidth=2.6, foreground="#0b2318")]
    lat0 = (ls0 + ln0) / 2
    k = 1.0 / max(0.1, math.cos(math.radians(lat0)))     # metri → metri Mercator

    order = {"campo": 0, "impronta": 1, "tubazione": 2, "cavo": 3, "attrezzatura": 4, "impianto": 5}
    for f in sorted(features, key=lambda f: order.get((f.get("properties") or {}).get("tipo"), 9)):
        pr = f.get("properties") or {}; g = f.get("geometry") or {}; t = pr.get("tipo"); c = g.get("coordinates")
        try:
            if t == "campo" and g.get("type") == "Polygon":
                pts = [_merc(p[0], p[1]) for p in c[0]]
                ax.add_patch(MplPoly(pts, closed=True, fill=False, edgecolor="#FFFFFF", lw=1.6, zorder=2))
                if pr.get("nome"):
                    mx = sum(p[0] for p in pts) / len(pts); my = sum(p[1] for p in pts) / len(pts)
                    ax.text(mx, my, pr["nome"], color="white", fontsize=7, ha="center", va="center", zorder=9, path_effects=halo, alpha=0.9)
            elif t == "tubazione" and g.get("type") == "LineString":
                pts = [_merc(p[0], p[1]) for p in c]
                ax.plot([p[0] for p in pts], [p[1] for p in pts], color="#20AAE2", lw=2.4, zorder=4, solid_capstyle="round")
                if pr.get("DN"):
                    m = pts[len(pts) // 2] if len(pts) > 2 else ((pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2)
                    ax.text(m[0], m[1], f"DN {pr['DN']}", color="white", fontsize=7, ha="center", va="bottom", zorder=9, path_effects=halo)
            elif t == "cavo" and g.get("type") == "LineString":
                pts = [_merc(p[0], p[1]) for p in c]
                off = w * 0.0025
                ax.plot([p[0] + off for p in pts], [p[1] - off for p in pts], color="#F0B429", lw=1.3, ls=(0, (4, 3)), zorder=5)
            elif t == "attrezzatura" and g.get("type") == "Point":
                x, y = _merc(c[0], c[1])
                ax.add_patch(Circle((x, y), w * 0.008, facecolor=BRAND, edgecolor="white", lw=1.4, zorder=8))
                ax.text(x, y, "P", color="white", fontsize=7, ha="center", va="center", zorder=9, weight="bold")
            elif t == "impianto" and g.get("type") == "Point":
                x, y = _merc(c[0], c[1]); r = float(pr.get("raggio_m") or 0) * k
                deg = float(pr.get("angolo_gradi") or 360); sett = pr.get("settore_gradi")
                if r > 0:
                    if deg < 359.5 and isinstance(sett, list) and len(sett) == 2:
                        a0 = 90 - float(sett[1]); a1 = 90 - float(sett[0])     # da nord orario → matplotlib
                        ax.add_patch(Wedge((x, y), r, a0, a1, facecolor="#2EE0A1", alpha=0.16, lw=0, zorder=6))
                        ax.add_patch(Wedge((x, y), r, a0, a1, fill=False, edgecolor="#2EE0A1", lw=2.2, zorder=6))
                    else:
                        ax.add_patch(Circle((x, y), r, facecolor="#2EE0A1", alpha=0.16, lw=0, zorder=6))
                        ax.add_patch(Circle((x, y), r, fill=False, edgecolor="#2EE0A1", lw=2.2, zorder=6))
                ax.add_patch(Circle((x, y), w * 0.003, color="white", zorder=7))
                if pr.get("impianto"):
                    ax.text(x, y + w * 0.006, pr["impianto"], color="white", fontsize=8, ha="center", va="bottom", zorder=9, weight="bold", path_effects=halo)
        except Exception:  # noqa: BLE001 — un elemento rotto non ferma la tavola
            continue

    # nord e scala
    nx, ny = x1 - w * 0.04, y1 - h * 0.1
    ax.annotate("", xy=(nx, ny + h * 0.06), xytext=(nx, ny), arrowprops=dict(arrowstyle="-|>", color="white", lw=2), zorder=10)
    ax.text(nx, ny + h * 0.065, "N", color="white", fontsize=10, ha="center", va="bottom", weight="bold", path_effects=halo, zorder=10)
    real_w = w / k
    step = [50, 100, 200, 250, 500, 1000, 2000, 5000][min(7, max(0, sum(1 for s in [50, 100, 200, 250, 500, 1000, 2000] if s * 5 < real_w)))]
    sx, sy = x0 + w * 0.03, y0 + h * 0.04
    ax.plot([sx, sx + step * k], [sy, sy], color="white", lw=4, zorder=10, solid_capstyle="butt", path_effects=halo)
    ax.text(sx + step * k / 2, sy + h * 0.012, f"{step} m", color="white", fontsize=8, ha="center", va="bottom", path_effects=halo, zorder=10)
    if img is not None:
        ax.text(x1 - w * 0.01, y0 + h * 0.012, _SAT_CREDIT, color="white", fontsize=5.5, ha="right", va="bottom", alpha=0.85, zorder=10)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=200)
    plt.close(fig)
    return buf.getvalue()


def build_tech_annex(doc: dict, rev: str) -> bytes:
    """doc = {lang, title, subtitle, client, project, date, reference, cover_rows:[[l,v]],
    sections:[{title, intro?, kv?:[[l,v]], table?:{header:[...], rows:[[...]], widths?:[...]}, note?}],
    plan:{features, legend:[[colore, testo]], title}}"""
    _ensure_fonts()
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_JUSTIFY, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import (BaseDocTemplate, CondPageBreak, Frame, Image as RLImage, KeepTogether,
                                    NextPageTemplate, PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle)

    lang = doc.get("lang") or "it"
    FONT, FONTB = _fonts(lang)
    FONTH = _font_head(lang)
    rtl = lang == "ar"
    S = lambda s: _shape(lang, _no_prices(str(s)))  # noqa: E731
    al = TA_RIGHT if rtl else TA_LEFT
    W, H = A4
    LW, LH = landscape(A4)
    buf = io.BytesIO()
    title = doc.get("title", "")
    foot_txt = " · ".join(x for x in (doc.get("reference"), doc.get("project"), doc.get("date")) if x)

    def _foot(cv, d):
        pw, ph = cv._pagesize
        cv.saveState()
        cv.setStrokeColor(colors.HexColor(N_BORDER)); cv.setLineWidth(0.6)
        cv.line(16 * mm, 11 * mm, pw - 16 * mm, 11 * mm)
        cv.setFont(FONT, 7.5); cv.setFillColor(colors.HexColor(N_MUTED))
        cv.drawString(16 * mm, 7 * mm, S(f"{title} · {foot_txt}"))
        cv.drawRightString(pw - 16 * mm, 7 * mm, S(f"Argus Total {rev} · Nabu S.r.l. · {d.page}"))
        cv.restoreState()

    dt = BaseDocTemplate(buf, pagesize=A4, title=f"{title} — {doc.get('project', '')}", author="Nabu S.r.l. · Argus Total")
    dt.addPageTemplates([
        PageTemplate(id="v", pagesize=A4, frames=[Frame(16 * mm, 15 * mm, W - 32 * mm, H - 30 * mm, id="fv")], onPage=_foot),
        PageTemplate(id="o", pagesize=landscape(A4), frames=[Frame(14 * mm, 15 * mm, LW - 28 * mm, LH - 28 * mm, id="fo")], onPage=_foot),
    ])
    st_t = ParagraphStyle("t", fontName=FONTH, fontSize=26, leading=31, textColor=colors.HexColor(N_HEAD), alignment=al)
    st_s = ParagraphStyle("s", fontName=FONT, fontSize=12, leading=16, textColor=colors.HexColor(N_MUTED), alignment=al)
    st_h = ParagraphStyle("h", fontName=FONTH, fontSize=15, leading=19, textColor=colors.HexColor(N_HEAD), spaceBefore=12, spaceAfter=6, alignment=al)
    st_p = ParagraphStyle("p", fontName=FONT, fontSize=9.5, leading=13.5, textColor=colors.HexColor(N_BODY), alignment=TA_JUSTIFY, spaceAfter=4)
    st_l = ParagraphStyle("l", fontName=FONT, fontSize=9.5, leading=12.5, textColor=colors.HexColor(N_MUTED), alignment=al)
    st_v = ParagraphStyle("v", fontName=FONT, fontSize=9.5, leading=12.5, textColor=colors.HexColor(N_HEAD), alignment=al)
    st_th = ParagraphStyle("th", fontName=FONTB, fontSize=8.5, leading=11, textColor=colors.HexColor(N_HEAD), alignment=al)
    st_td = ParagraphStyle("td", fontName=FONT, fontSize=8.5, leading=11, textColor=colors.HexColor(N_BODY), alignment=al)
    st_tn = ParagraphStyle("tn", parent=st_td, alignment=TA_RIGHT)

    def kv(rows, lab_w=62 * mm):
        data = [[Paragraph(S(a), st_l), Paragraph(S(b), st_v)] for a, b in rows]
        if rtl:
            data = [r[::-1] for r in data]
        t = Table(data, colWidths=([None, lab_w] if rtl else [lab_w, None]))
        t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.5, colors.HexColor(N_BORDER)),
                               ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
        return t

    num = re.compile(r"^[\s\d.,+−\-×x/%]+$")

    def table(tb, avail):
        head = tb.get("header") or []
        rows = tb.get("rows") or []
        n = max([len(head)] + [len(r) for r in rows] or [1])
        ws = tb.get("widths")
        cw = [avail * x / sum(ws) for x in ws] if ws and len(ws) == n else [avail / n] * n
        data = []
        if head:
            data.append([Paragraph(S(h), st_th) for h in head])
        for r in rows:
            data.append([Paragraph(S(c), st_tn if (i and num.match(str(c) or "x")) else st_td) for i, c in enumerate(r)])
        if rtl:
            data = [r[::-1] for r in data]; cw = cw[::-1]
        t = Table(data, colWidths=cw, repeatRows=1 if head else 0)
        sty = [("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LINEBELOW", (0, 0), (-1, -1), 0.4, colors.HexColor(N_BORDER)),
               ("TOPPADDING", (0, 0), (-1, -1), 2.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5)]
        if head:
            sty += [("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(N_SOFT)), ("LINEBELOW", (0, 0), (-1, 0), 1.0, colors.HexColor(BRAND))]
        for i, r in enumerate(rows):
            if len(r) >= 1 and all((c == "" or c is None) for c in r[1:]) and r[0]:
                sty.append(("BACKGROUND", (0, i + (1 if head else 0)), (-1, i + (1 if head else 0)), colors.HexColor(N_GREEN10)))
        t.setStyle(TableStyle(sty))
        return t

    story = []
    # --- copertina ---
    logo = os.path.join(_ASSETS, "argus-total-logo.png")
    nabu = os.path.join(_ASSETS, "nabu-logo-color.png")
    hd = Table([[RLImage(logo, width=58 * mm, height=17 * mm, kind="proportional") if os.path.exists(logo) else Spacer(1, 1), "",
                 RLImage(nabu, width=26 * mm, height=18 * mm, kind="proportional") if os.path.exists(nabu) else Spacer(1, 1)]],
               colWidths=[66 * mm, None, 30 * mm])
    hd.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LINEBELOW", (0, 0), (-1, 0), 1.4, colors.HexColor(BRAND)),
                            ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
    story += [hd, Spacer(1, 26 * mm), Paragraph(S(title), st_t), Spacer(1, 3 * mm), Paragraph(S(doc.get("subtitle", "")), st_s), Spacer(1, 12 * mm)]
    story.append(kv(doc.get("cover_rows") or []))
    if doc.get("cover_note"):
        story += [Spacer(1, 8 * mm), Paragraph(S(doc["cover_note"]), st_p)]

    # --- planimetria (pagina orizzontale) ---
    plan = doc.get("plan") or {}
    png = plan_png(plan.get("features") or []) if plan.get("features") else None
    if png:
        story += [NextPageTemplate("o"), PageBreak(), Paragraph(S(plan.get("title", "")), st_h)]
        iw = LW - 28 * mm; ih = iw * 1560 / 2400
        maxh = LH - 28 * mm - 30 * mm
        if ih > maxh:
            ih = maxh; iw = ih * 2400 / 1560
        story.append(RLImage(io.BytesIO(png), width=iw, height=ih))
        leg = plan.get("legend") or []
        if leg:
            cells = [Paragraph(f'<font color="{c}">■</font> {S(tx)}', st_td) for c, tx in leg]
            story += [Spacer(1, 3 * mm), Table([cells], colWidths=[iw / len(cells)] * len(cells))]
        story += [NextPageTemplate("v"), PageBreak()]
    else:
        story += [PageBreak()]

    # --- sezioni ---
    avail = W - 32 * mm
    for i, sec in enumerate(doc.get("sections") or []):
        block = [Paragraph(S(sec.get("title", "")), st_h)]
        if sec.get("intro"):
            block.append(Paragraph(S(sec["intro"]), st_p))
        if sec.get("kv"):
            block.append(kv(sec["kv"]))
        story.append(CondPageBreak(45 * mm))
        story.append(KeepTogether(block) if not sec.get("table") else block[0])
        if sec.get("table"):
            story += block[1:]
            story.append(table(sec["table"], avail))
        if sec.get("note"):
            story += [Spacer(1, 2 * mm), Paragraph(S(sec["note"]), st_p)]
    dt.build(story)
    return buf.getvalue()
