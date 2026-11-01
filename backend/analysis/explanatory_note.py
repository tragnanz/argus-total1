"""Relazione tecnica generale dell'impianto (PDF per il cliente).

Impostata come le relazioni tecniche di Agrostar («General Explanatory Note»):
copertina con la foto aerea del sito, intestazione «Agrostar srl <> Cliente –
Relazione – Rev – data» e marchio in ogni pagina, piè di pagina con i dati
societari, capitoli numerati in prosa giustificata con tabelle, elenchi e
figure (inquadramento e planimetria su ortofoto).

Grafica dalla libreria Nabu-Agrostar-UI-Library.html: palette del marchio,
titoli ed etichette in Plus Jakarta Sans 700 (Poppins per Nabu), testo in
Inter, etichette MAIUSCOLE in colore primario con spaziatura 0,1 em, loghi
originali della libreria.

Nessun prezzo, costo o importo: i prezzi stanno solo nell'offerta Mercurius
(il controllo rifiuta qualunque «€» nei contenuti; i dati societari del piè di
pagina restano fuori dal controllo perche' sono carta intestata).
"""
from __future__ import annotations

import io
import os
import re

from .report import _ASSETS, _ensure_fonts, _fonts, _shape
from .tech_annex import _no_prices, plan_png

BRANDS = {
    "agrostar": {
        "company": "Agrostar srl",
        "logo": "agrostar-logo.png", "logo_ratio": 571 / 537,
        # palette Agrostar della libreria grafica (Nabu-Agrostar-UI-Library.html)
        "primary": "#009FE3", "dark": "#001A33", "accent": "#009640", "soft": "#F0F4FA", "border": "#BEC7D2", "muted": "#5C636A",
        "text": "#001A33", "heading": "#001A33",
        # titoli, etichette e numeri in Plus Jakarta Sans (libreria, 700), testo in Inter
        "head_font": ("PJS-700", "PlusJakartaSans-700.ttf"), "head_font2": ("PJS-700", "PlusJakartaSans-700.ttf"),
        "footer": ["AGROSTAR S.r.l.  |  Via F.lli Corradini 54  |  42021 Bibbiano (RE)  |  Italia  |  Tel. +39 0522 577741  |  info@agrostar.it  |  www.agrostar.it",
                   "P.IVA e C.F. 02918960358  |  Registro Imprese di Reggio Emilia n. 02918960358  |  Capitale Sociale € 541.310,00 i.v."],
    },
    "nabu": {
        "company": "Nabu srl",
        "logo": "nabu-logo-library.jpg", "logo_ratio": 1.0,
        # palette Nabu della libreria grafica
        "primary": "#4CAF4F", "dark": "#0F172A", "accent": "#4CAF4F", "soft": "#FAFAFA", "border": "#E2E8F0", "muted": "#737373",
        "text": "#525252", "heading": "#1A1D21",
        "head_font": ("Poppins-Bold", "Poppins-Bold.ttf"), "head_font2": ("Poppins-Bold", "Poppins-Bold.ttf"),
        "footer": ["NABU S.r.l.  |  Via Fratelli Manfredi 4  |  42124 Reggio Emilia (RE)  |  Italia  |  info@nabugroup.it  |  www.nabugroup.it",
                   "P.IVA e C.F. 12674660019  |  Codice SDI M5UXCR1  |  Capitale Sociale € 34.000,00 i.v."],
    },
}
_LATIN_HEAD = {"it", "en", "fr", "es", "pt", "ro", "hu", "id", "de", "pl", "af", "ms"}


def _register(name: str, fn: str) -> bool:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    if name in pdfmetrics.getRegisteredFontNames():
        return True
    p = os.path.join(_ASSETS, "fonts", fn)
    try:
        pdfmetrics.registerFont(TTFont(name, p))
        return True
    except Exception:  # noqa: BLE001
        return False


def build_note(doc: dict, rev: str, cover_jpeg: bytes | None = None) -> bytes:
    """doc = {lang, brand, cover_title, title, revision, date, client, recipient:[righe], header,
    chapters:[{title, blocks:[{p}|{h}|{bullets}|{numbered}|{table:{header,rows,widths}}|{figure:"site"|"plan", caption}]}],
    site:{features}, plan:{features}, toc_title, figure_label}"""
    _ensure_fonts()
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_JUSTIFY, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import (BaseDocTemplate, CondPageBreak, Frame, Image as RLImage, KeepTogether, ListFlowable,
                                    ListItem, NextPageTemplate, PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle)

    lang = doc.get("lang") or "it"
    B = BRANDS.get(doc.get("brand") or "agrostar", BRANDS["agrostar"])
    FONT, FONTB = _fonts(lang)
    if lang in _LATIN_HEAD and _register(*B["head_font"]) and _register(*B["head_font2"]):
        FH, FH2 = B["head_font"][0], B["head_font2"][0]
    else:
        FH, FH2 = FONTB, FONTB
    rtl = lang == "ar"
    S = lambda s: _shape(lang, _no_prices(str(s)))  # noqa: E731
    C = lambda h: colors.HexColor(h)  # noqa: E731
    W, H = A4
    M = 18 * mm
    al = TA_RIGHT if rtl else TA_LEFT
    logo = os.path.join(_ASSETS, B["logo"])
    header = S(doc.get("header", ""))
    foot = B["footer"]

    def logo_size(h):
        try:
            iw, ih = ImageReader(logo).getSize()
            return h * iw / ih, h
        except Exception:  # noqa: BLE001
            return h, h

    dark_rgb = tuple(int(B["dark"][i:i + 2], 16) / 255 for i in (1, 3, 5))
    LBL = FH2 if lang in _LATIN_HEAD else FONTB

    def caps(cv, x, y, text, size=8.5):
        """Etichetta MAIUSCOLA della libreria: 700, spaziatura 0,1 em, colore primario."""
        if not text:
            return
        cv.saveState(); cv.setFillColor(C(B["primary"]))
        t = cv.beginText(x, y); t.setFont(LBL, size); t.setCharSpace(size * 0.1)
        t.textOut(_shape(lang, str(text).upper())); cv.drawText(t); cv.restoreState()

    from reportlab.platypus.flowables import Flowable

    class CapsLabel(Flowable):
        def __init__(self, text):
            super().__init__(); self.text = text

        def wrap(self, aw, ah):
            self.aw = aw
            return aw, (5 * mm if self.text else 0)

        def draw(self):
            if rtl:
                self.canv.saveState(); self.canv.setFillColor(C(B["primary"])); self.canv.setFont(LBL, 8.5)
                self.canv.drawRightString(self.aw, 1.2 * mm, _shape(lang, str(self.text).upper())); self.canv.restoreState()
            else:
                caps(self.canv, 0, 1.2 * mm, self.text)

    # ---------------- copertina (disegnata sul canvas) ----------------
    def cover(cv, _d):
        cv.saveState()
        ph = H * 0.56
        if cover_jpeg:
            cv.drawImage(ImageReader(io.BytesIO(cover_jpeg)), 0, H - ph, width=W, height=ph, preserveAspectRatio=False)
        else:
            cv.setFillColor(C(B["dark"])); cv.rect(0, H - ph, W, ph, stroke=0, fill=1)
        # velo scuro in basso per leggere il titolo
        for i in range(40):
            a = 0.62 * (i / 39) ** 1.6
            cv.setFillColor(colors.Color(*dark_rgb, alpha=a))
            cv.rect(0, H - ph + (39 - i) * ph * 0.012, W, ph * 0.012 + 0.5, stroke=0, fill=1)
        cv.setFillColor(colors.white); cv.setFont(FH, 34)
        lines = [l for l in str(doc.get("cover_title", "")).upper().split("\n") if l.strip()]
        y = H - ph + 22 * mm + (len(lines) - 1) * 38
        for ln in lines:
            cv.drawString(M, y, _shape(lang, ln)); y -= 38
        # revisione in verticale, a destra della foto (come le relazioni Agrostar)
        cv.saveState(); cv.translate(W - 9 * mm, H - ph + 18 * mm); cv.rotate(90)
        cv.setFont(FONT, 8); cv.setFillColor(colors.white)
        cv.drawString(0, 0, _shape(lang, f"{doc.get('revision', '')} – {doc.get('date', '')}")); cv.restoreState()
        # titolo del documento e destinatario
        caps(cv, M, H - ph - 11 * mm, doc.get("label", ""))
        cv.setFillColor(C(B["heading"])); cv.setFont(FH, 22)
        cv.drawString(M, H - ph - 20 * mm, _shape(lang, str(doc.get("title", ""))))
        cv.setFillColor(C(B["muted"])); cv.setFont(FONT, 10)
        cv.drawString(M, H - ph - 28 * mm, _shape(lang, f"{doc.get('revision', '')} – {doc.get('date', '')}"))
        yy = H - ph - 52 * mm
        cv.setFillColor(C(B["muted"])); cv.setFont(FONT, 9.5)
        cv.drawString(M + 30 * mm, yy, _shape(lang, str(doc.get("recipient_label", ""))))
        cv.setFillColor(C(B["dark"])); cv.setFont(FH2, 13)
        cv.drawString(M + 30 * mm, yy - 8 * mm, _shape(lang, str(doc.get("client", ""))))
        cv.setFont(FONT, 9.5); cv.setFillColor(C(B["muted"]))
        for i, r in enumerate(doc.get("recipient") or []):
            cv.drawString(M + 30 * mm, yy - 15 * mm - i * 5 * mm, _shape(lang, str(r)))
        lw, lh = logo_size(24 * mm)
        if os.path.exists(logo):
            cv.drawImage(logo, M, 16 * mm, width=lw, height=lh, mask="auto")
        cv.restoreState()

    # ---------------- pagine interne ----------------
    def page(cv, d):
        cv.saveState()
        cv.setFont(FONT, 7.5); cv.setFillColor(C(B["muted"]))
        cv.drawString(M, H - 12 * mm, header)
        lw, lh = logo_size(11 * mm)
        if os.path.exists(logo):
            cv.drawImage(logo, W - M - lw, H - 15 * mm, width=lw, height=lh, mask="auto")
        cv.setStrokeColor(C(B["primary"])); cv.setLineWidth(0.8)
        cv.line(M, H - 17 * mm, W - M, H - 17 * mm)
        cv.setStrokeColor(C(B["border"])); cv.setLineWidth(0.5)
        cv.line(M, 16 * mm, W - M, 16 * mm)
        cv.setFont(FONT, 6.3); cv.setFillColor(C(B["muted"]))
        for i, ln in enumerate(foot):
            cv.drawString(M, 12 * mm - i * 3.4 * mm, ln)
        cv.setFont(FH2, 9); cv.setFillColor(C(B["dark"]))
        cv.drawRightString(W - M, 10 * mm, str(d.page))
        cv.restoreState()

    buf = io.BytesIO()
    dt = BaseDocTemplate(buf, pagesize=A4, title=f"{doc.get('title', '')} — {doc.get('client', '')}",
                         author=B["company"], subject=str(doc.get("cover_title", "")).replace("\n", " "))
    dt.addPageTemplates([
        PageTemplate(id="cover", frames=[Frame(M, M, W - 2 * M, 10 * mm, id="fc")], onPage=cover),
        PageTemplate(id="body", frames=[Frame(M, 20 * mm, W - 2 * M, H - 41 * mm, id="fb")], onPage=page),
    ])
    st_h1 = ParagraphStyle("h1", fontName=FH, fontSize=15, leading=19, textColor=C(B["heading"]), spaceBefore=2, spaceAfter=7, alignment=al)
    st_h2 = ParagraphStyle("h2", fontName=FH2, fontSize=11, leading=14, textColor=C(B["primary"]), spaceBefore=8, spaceAfter=4, alignment=al)
    st_p = ParagraphStyle("p", fontName=FONT, fontSize=9.6, leading=13.6, textColor=C(B["text"]), alignment=TA_JUSTIFY, spaceAfter=6)
    st_li = ParagraphStyle("li", parent=st_p, spaceAfter=1.5)
    st_cap = ParagraphStyle("cap", fontName=FONT, fontSize=8, leading=10.5, textColor=C(B["muted"]), alignment=TA_LEFT, spaceBefore=3, spaceAfter=8)
    st_th = ParagraphStyle("th", fontName=FH2 if FH2 != FONTB else FONTB, fontSize=8.5, leading=11, textColor=colors.white, alignment=al)
    st_td = ParagraphStyle("td", fontName=FONT, fontSize=8.5, leading=11, textColor=C(B["text"]), alignment=al)
    st_tn = ParagraphStyle("tn", parent=st_td, alignment=TA_RIGHT)
    st_toc = ParagraphStyle("toc", fontName=FONT, fontSize=10, leading=17, textColor=C(B["dark"]), alignment=al)
    num = re.compile(r"^[\s\d.,+−\-×x/%°]+$")
    avail = W - 2 * M

    def table(tb):
        head = tb.get("header") or []
        rows = tb.get("rows") or []
        n = max([len(head)] + [len(r) for r in rows] or [1])
        ws = tb.get("widths")
        cw = [avail * x / sum(ws) for x in ws] if ws and len(ws) == n else [avail / n] * n
        data = ([[Paragraph(S(h), st_th) for h in head]] if head else []) + [
            [Paragraph(S(c), st_tn if (i and num.match(str(c) or "x")) else st_td) for i, c in enumerate(r)] for r in rows]
        if rtl:
            data = [r[::-1] for r in data]; cw = cw[::-1]
        t = Table(data, colWidths=cw, repeatRows=1 if head else 0)
        sty = [("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
               ("LINEBELOW", (0, 0), (-1, -1), 0.4, C(B["border"]))]
        if head:
            sty += [("BACKGROUND", (0, 0), (-1, 0), C(B["dark"]))]
        k0 = 1 if head else 0
        for i in range(k0, len(data)):
            if (i - k0) % 2 == 1:
                sty.append(("BACKGROUND", (0, i), (-1, i), C(B["soft"])))
        t.setStyle(TableStyle(sty))
        return t

    figs = {}

    def figure(kind):
        if kind not in figs:
            feats = (doc.get(kind) or {}).get("features") or []
            png = plan_png(feats, 2400, 1500) if feats else None
            if png:   # ortofoto: in JPEG il PDF pesa un decimo che in PNG
                from PIL import Image
                with Image.open(io.BytesIO(png)) as im:
                    jb = io.BytesIO(); im.convert("RGB").save(jb, "JPEG", quality=85, optimize=True); png = jb.getvalue()
            figs[kind] = png
        return figs[kind]

    story = [NextPageTemplate("body"), PageBreak()]
    # indice
    chapters = doc.get("chapters") or []
    if doc.get("toc_title"):
        story.append(Paragraph(S(doc["toc_title"]), st_h1))
        st_toc2 = ParagraphStyle("toc2", parent=st_toc, fontSize=9, leading=14, leftIndent=8 * mm, textColor=C(B["muted"]))
        for i, ch in enumerate(chapters):
            story.append(Paragraph(S(f"{i + 1}.&nbsp;&nbsp;{ch.get('title', '')}"), st_toc))
            for b in ch.get("blocks") or []:
                if b.get("toc") and b.get("h"):
                    story.append(Paragraph(S(b["h"]), st_toc2))
        story.append(PageBreak())
    fig_n = 0
    for i, ch in enumerate(chapters):
        # capitoli di seguito, senza mezze pagine vuote: a capo pagina solo se manca spazio
        if i:
            story.append(PageBreak() if ch.get("new_page") else CondPageBreak(70 * mm))
            story.append(Spacer(1, 4 * mm))
        first = [CapsLabel(f"{doc.get('chapter_label', '')} {i + 1}".strip()), Paragraph(S(ch.get("title", "")), st_h1)]
        for b in ch.get("blocks") or []:
            if "p" in b:
                el = [Paragraph(S(b["p"]), st_p)]
            elif "h" in b:
                el = [CondPageBreak(30 * mm), Paragraph(S(b["h"]), st_h2)]
            elif "bullets" in b or "numbered" in b:
                items = b.get("bullets") or b.get("numbered") or []
                el = [ListFlowable([ListItem(Paragraph(S(x), st_li), leftIndent=12, value=None) for x in items],
                                   bulletType="1" if "numbered" in b else "bullet", start="1" if "numbered" in b else "•",
                                   leftIndent=14, bulletFontName=FONT, bulletFontSize=9, bulletColor=C(B["primary"])), Spacer(1, 5)]
            elif "table" in b:
                el = [table(b["table"]), Spacer(1, 7)]
                if b.get("caption"):
                    el.insert(1, Paragraph(S(b["caption"]), st_cap))
            elif "figure" in b:
                png = figure(b["figure"])
                if not png:
                    continue
                fig_n += 1
                iw = avail; ih = iw * 1500 / 2400
                el = [CondPageBreak(ih + 20 * mm), RLImage(io.BytesIO(png), width=iw, height=ih),
                      Paragraph(S(f"{doc.get('figure_label', 'Figura')} {fig_n} – {b.get('caption', '')}"), st_cap)]
            else:
                continue
            if first:
                story.append(KeepTogether(first + el[:1])); story += el[1:]; first = None
            else:
                story += el
        if first:
            story += first
    dt.build(story)
    return buf.getvalue()
