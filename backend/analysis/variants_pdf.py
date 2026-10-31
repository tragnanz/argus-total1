"""Confronto tra varianti di progetto in PDF (libreria grafica Nabu) e
ortofoto per la planimetria del file .ceres.

Il PDF arriva gia' composto dall'interfaccia (etichette e valori tradotti e
formattati nella lingua di stampa): qui si impagina soltanto, A4 orizzontale,
con i marchi Argus Total e Nabu, la tabella dei numeri con le differenze
rispetto allo stato attuale e la tabella delle quantita'.
"""
from __future__ import annotations

import base64
import io
import os

from .report import (BRAND, N_BODY, N_BORDER, N_GREEN10, N_HEAD, N_MUTED, N_SOFT, _ASSETS,
                     _ensure_fonts, _font_head, _fonts, _merc, _satellite_bg, _shape, _unmerc,
                     _SAT_CREDIT)

_UP = "#0F7B3A"      # differenza favorevole (verde scuro, leggibile su bianco)
_DOWN = "#B42318"    # differenza sfavorevole


def build_variants_pdf(title: str, subtitle: str, date: str, note: str, columns: list[str],
                       rows: list[dict], qty_title: str, qty_rows: list[dict], rev: str,
                       lang: str = "it", footer: str = "") -> bytes:
    """rows: [{label, cells: [{v, d?, s?}]}] — v valore, d differenza in testo,
    s segno della differenza (1 favorevole, -1 sfavorevole, 0 neutra)."""
    _ensure_fonts()
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_JUSTIFY, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import (BaseDocTemplate, CondPageBreak, Frame, Image as RLImage, PageTemplate,
                                    Paragraph, Spacer, Table, TableStyle)

    FONT, FONTB = _fonts(lang)
    FONTH = _font_head(lang)
    rtl = lang == "ar"
    S = lambda s: _shape(lang, str(s))  # noqa: E731
    W, H = landscape(A4)
    buf = io.BytesIO()

    def _foot(cv, doc):
        cv.saveState()
        cv.setStrokeColor(colors.HexColor(N_BORDER)); cv.setLineWidth(0.6)
        cv.line(14 * mm, 10 * mm, W - 14 * mm, 10 * mm)
        cv.setFont(FONT, 7.5); cv.setFillColor(colors.HexColor(N_MUTED))
        cv.drawString(14 * mm, 6 * mm, S(f"Argus Total {rev} · Nabu S.r.l." + (f" · {footer}" if footer else "")))
        cv.drawRightString(W - 14 * mm, 6 * mm, str(doc.page))
        cv.restoreState()

    doc = BaseDocTemplate(buf, pagesize=landscape(A4), leftMargin=14 * mm, rightMargin=14 * mm,
                          topMargin=12 * mm, bottomMargin=14 * mm, title=f"{title} — {subtitle}")
    doc.addPageTemplates([PageTemplate(id="p", frames=[Frame(14 * mm, 14 * mm, W - 28 * mm, H - 26 * mm, id="f")],
                                       onPage=_foot)])
    al = TA_RIGHT if rtl else TA_LEFT
    st_t = ParagraphStyle("t", fontName=FONTH, fontSize=22, leading=26, textColor=colors.HexColor(N_HEAD), alignment=al)
    st_s = ParagraphStyle("s", fontName=FONT, fontSize=11, leading=14, textColor=colors.HexColor(N_MUTED), alignment=al)
    st_h = ParagraphStyle("h", fontName=FONTH, fontSize=14, leading=18, textColor=colors.HexColor(N_HEAD),
                          spaceBefore=10, spaceAfter=5, alignment=al)
    st_n = ParagraphStyle("n", fontName=FONT, fontSize=9, leading=12.5, textColor=colors.HexColor(N_BODY),
                          alignment=TA_JUSTIFY)
    st_l = ParagraphStyle("l", fontName=FONT, fontSize=9, leading=11.5, textColor=colors.HexColor(N_BODY), alignment=al)
    st_c = ParagraphStyle("c", fontName=FONTB, fontSize=9.5, leading=12, textColor=colors.HexColor(N_HEAD),
                          alignment=TA_RIGHT)
    st_v = ParagraphStyle("v", fontName=FONT, fontSize=9.5, leading=12, textColor=colors.HexColor(N_HEAD),
                          alignment=TA_RIGHT)

    story = []
    logo = os.path.join(_ASSETS, "argus-total-logo.png")
    nabu = os.path.join(_ASSETS, "nabu-logo-color.png")
    left = RLImage(logo, width=48 * mm, height=14 * mm, kind="proportional") if os.path.exists(logo) else Spacer(1, 1)
    right = RLImage(nabu, width=22 * mm, height=15 * mm, kind="proportional") if os.path.exists(nabu) else Spacer(1, 1)
    mid = [Paragraph(S(title), st_t), Paragraph(S(" · ".join(x for x in (subtitle, date) if x)), st_s)]
    head = Table([[left, mid, right]], colWidths=[54 * mm, None, 26 * mm])
    head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                              ("LINEBELOW", (0, 0), (-1, 0), 1.4, colors.HexColor(BRAND)),
                              ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
    story += [head, Spacer(1, 8)]

    n = max(1, len(columns))
    lab_w = 70 * mm
    col_w = (W - 28 * mm - lab_w) / n

    def cell(c: dict):
        v = S(c.get("v", ""))
        d = c.get("d")
        if not d:
            return Paragraph(v, st_v)
        col = _UP if c.get("s", 0) > 0 else _DOWN if c.get("s", 0) < 0 else N_MUTED
        return Paragraph(f'{v}<br/><font size="7.5" color="{col}">{S(d)}</font>', st_v)

    data = [[Paragraph("", st_l)] + [Paragraph(S(c), st_c) for c in columns]]
    for r in rows:
        data.append([Paragraph(S(r.get("label", "")), st_l)] + [cell(c) for c in r.get("cells", [])])
    tb = Table(data, colWidths=[lab_w] + [col_w] * n, repeatRows=1)
    sty = [("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
           ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(N_SOFT)),
           ("LINEBELOW", (0, 0), (-1, 0), 1.0, colors.HexColor(BRAND)),
           ("LINEBELOW", (0, 1), (-1, -1), 0.5, colors.HexColor(N_BORDER)),
           ("BACKGROUND", (1, 1), (1, -1), colors.HexColor(N_GREEN10)),
           ("TOPPADDING", (0, 0), (-1, -1), 3.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5)]
    tb.setStyle(TableStyle(sty))
    story.append(tb)
    if note:
        story += [Spacer(1, 6), Paragraph(S(note), st_n)]

    if qty_rows:
        story.append(CondPageBreak(70 * mm))
        story.append(Paragraph(S(qty_title), st_h))
        st_q = ParagraphStyle("q", parent=st_l, fontSize=8.5, leading=10.5)
        st_qv = ParagraphStyle("qv", parent=st_v, fontSize=8.5, leading=10.5)
        st_qc = ParagraphStyle("qc", parent=st_l, fontName=FONTB, fontSize=8.5, leading=10.5,
                               textColor=colors.HexColor(N_HEAD))
        qd = [[Paragraph("", st_q)] + [Paragraph(S(c), st_c) for c in columns]]
        bold: list[int] = []
        for r in qty_rows:
            if r.get("head"):
                bold.append(len(qd))
                qd.append([Paragraph(S(r.get("label", "")), st_qc)] + [Paragraph("", st_qv) for _ in columns])
            else:
                qd.append([Paragraph(S(r.get("label", "")), st_q)] + [Paragraph(S(v), st_qv) for v in r.get("values", [])])
        qt = Table(qd, colWidths=[lab_w + 20 * mm] + [(W - 28 * mm - lab_w - 20 * mm) / n] * n, repeatRows=1)
        qs = [("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
              ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(N_SOFT)),
              ("LINEBELOW", (0, 0), (-1, 0), 1.0, colors.HexColor(BRAND)),
              ("LINEBELOW", (0, 1), (-1, -1), 0.4, colors.HexColor(N_BORDER)),
              ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2)]
        for i in bold:
            qs.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor(N_GREEN10)))
        qt.setStyle(TableStyle(qs))
        story.append(qt)

    doc.build(story)
    return buf.getvalue()


def ortho_for_bbox(west: float, south: float, east: float, north: float, ratio: float = 1.387,
                   width_px: int = 1600, quality: int = 80) -> dict | None:
    """Ortofoto (Esri World Imagery, Web Mercator) del riquadro allargato al
    rapporto larghezza/altezza richiesto. Ritorna il riquadro ESATTO
    dell'immagine in WGS84 e l'immagine JPEG come data URL, oppure None."""
    x0, y0 = _merc(west, south)
    x1, y1 = _merc(east, north)
    w, h = max(1.0, x1 - x0), max(1.0, y1 - y0)
    if w / h < ratio:
        dx = (h * ratio - w) / 2; x0 -= dx; x1 += dx
    else:
        dy = (w / ratio - h) / 2; y0 -= dy; y1 += dy
    lw, ls = _unmerc(x0, y0)
    le, ln = _unmerc(x1, y1)
    img, ext = _satellite_bg(lw, ls, le, ln, max_tiles=80, max_px=2600)
    if img is None:
        return None
    left, right, bottom, top = ext
    sx = img.width / (right - left)
    sy = img.height / (top - bottom)
    box = (int(round((x0 - left) * sx)), int(round((top - y1) * sy)),
           int(round((x1 - left) * sx)), int(round((top - y0) * sy)))
    crop = img.crop(box)
    img.close()
    out_w = min(width_px, max(200, crop.width))
    out_h = max(1, int(round(out_w / ratio)))
    from PIL import Image
    small = crop.resize((out_w, out_h), Image.BILINEAR)
    crop.close()
    b = io.BytesIO()
    small.save(b, "JPEG", quality=quality, optimize=True)
    small.close()
    data = "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode("ascii")
    return {"riquadro": {"ovest": lw, "sud": ls, "est": le, "nord": ln}, "immagine": data,
            "attribuzione": _SAT_CREDIT, "px": [out_w, out_h]}


__all__ = ["build_variants_pdf", "ortho_for_bbox"]
