"""Tavola di progetto Argus Total — foglio A3 orizzontale.

Riproduce l'impaginazione delle tavole di settore (cornice tecnica, cartiglio
in basso, barra laterale con le schede delle macchine) con l'ortofoto a tutta
pagina e sopra il progetto realmente disegnato.

Geometria in punti PDF, A3 orizzontale (1191 x 842):
  cornice esterna   16 .. 1175 x 16 .. 826   (linea spessa + filetto interno)
  mappa             21 .. 1027 x 21 .. 741
  barra laterale  1027 .. 1169
  cartiglio         21 .. 1169 x 741 .. 819  (8 celle)
"""
from __future__ import annotations

import io
import math
import os

from .report_i18n import tr, RTL, fmt_num, fmt_date

# --- palette ---------------------------------------------------------------
INK = "#123524"          # verde Nabu scuro: cornice, testi, riquadri
INK_SOFT = "#5b7166"     # etichette secondarie
LINE = "#b9c6bd"         # filetti del cartiglio
CYAN = "#00d1ff"         # confini dei poligoni e tubazioni
GREEN = "#2ee0a1"        # cerchi dei pivot
WHITE = "#ffffff"

A3_W, A3_H = 1191.0, 842.0
FRAME = (16.0, 16.0, 1175.0, 826.0)      # x0, y0, x1, y1 (origine in alto)
MAP_BOX = (21.0, 21.0, 1027.0, 741.0)
SIDE_BOX = (1027.0, 21.0, 1169.0, 741.0)
CART_BOX = (21.0, 741.0, 1169.0, 819.0)
# Divisori del cartiglio, misurati sulla tavola di riferimento.
CART_X = [21.0, 147.0, 341.0, 494.0, 647.0, 749.0, 923.0, 1056.0, 1169.0]

_ASSETS = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets")


def _y(v: float) -> float:
    """Da coordinate con origine in alto (come le misure) a quelle di reportlab."""
    return A3_H - v


def _shape_ok(lang: str, s: str) -> str:
    from .report import _shape
    return _shape(lang, s)


# ---------------------------------------------------------------------------
# Barra laterale: coordinate del centro campo e una scheda per macchina
# ---------------------------------------------------------------------------
def _fit(cv, text: str, fontname: str, size: float, maxw: float) -> float:
    """Riduce il corpo finche' la riga sta nella colonna (min 4,6 pt)."""
    from reportlab.pdfbase.pdfmetrics import stringWidth
    while size > 4.6 and stringWidth(text, fontname, size) > maxw:
        size -= 0.2
    return size


def _draw_sidebar(cv, pivots: list[dict], centre: tuple[float, float], lang: str,
                  font: str, fontb: str) -> None:
    from reportlab.lib import colors

    x0, y0, x1, _y1 = SIDE_BOX
    x = x0 + 13.0
    colw = x1 - x - 6.0          # larghezza utile della colonna
    y = y0 + 16.0

    def T(key, **kw):
        return _shape_ok(lang, tr(lang, key, **kw))

    cv.setFillColor(colors.HexColor(INK))
    head = T("ps_coord")
    cv.setFont(fontb, _fit(cv, head, fontb, 7.6, colw))
    cv.drawString(x, _y(y), head)
    y += 12.0

    cv.setFont(font, 6.0)
    cv.setFillColor(colors.HexColor(INK_SOFT))
    cv.drawString(x, _y(y), T("ps_centro"))
    y += 8.5
    cv.setFillColor(colors.HexColor(INK))
    cv.setFont(font, 7.0)
    cv.drawString(x, _y(y), f"{centre[0]:.6f}, {centre[1]:.6f}")
    y += 9.5
    cv.setFont(font, 6.2)
    cv.setFillColor(colors.HexColor("#2f7fbf"))
    link = f"https://www.google.com/maps?q={centre[0]:.6f},{centre[1]:.6f}"
    cv.drawString(x, _y(y), ">> Google Maps")
    cv.linkURL(link, (x, _y(y) - 2, x + 60, _y(y) + 7), relative=0, thickness=0)
    y += 16.0

    cv.setFillColor(colors.HexColor(INK))
    cv.setFont(fontb, 7.6)
    cv.drawString(x, _y(y), T("ps_impianto"))
    y += 11.0

    xn = x                      # colonna del numero
    xt = x + 14.0               # colonna del testo
    tw = colw - 14.0            # larghezza utile per le righe rientrate
    for i, pv in enumerate(pivots, 1):
        if y > 700.0:           # oltre il fondo della barra: si tronca
            cv.setFont(font, 6.0)
            cv.setFillColor(colors.HexColor(INK_SOFT))
            cv.drawString(xt, _y(y), T("ps_altri", n=len(pivots) - i + 1))
            break
        cv.setFillColor(colors.HexColor(INK))
        cv.setFont(font, 6.4)
        cv.drawString(xn, _y(y), str(i))
        cv.drawString(xt, _y(y), f"{pv['lat']:.6f}, {pv['lon']:.6f}")
        y += 8.2

        head = (f"R {fmt_num(lang, pv['r'])}m · 360° · "
                f"{fmt_num(lang, pv['ha'], 2)} ha")
        if pv.get("pct") is not None:
            head += f" · {fmt_num(lang, pv['pct'], 1)}%"
        head = _shape_ok(lang, head)
        cv.setFont(fontb, _fit(cv, head, fontb, 6.6, tw))
        cv.drawString(xt, _y(y), head)
        y += 8.2

        cv.setFillColor(colors.HexColor(INK))
        qp = []
        if pv.get("q_m3h"):
            qp.append(f"Q {fmt_num(lang, pv['q_m3h'])} m³/h")
        if pv.get("p_bar"):
            qp.append(f"P {fmt_num(lang, pv['p_bar'], 2)} bar")
        if qp:
            line = _shape_ok(lang, " · ".join(qp))
            cv.setFont(font, _fit(cv, line, font, 6.2, tw))
            cv.drawString(xt, _y(y), line)
            y += 8.2
        if pv.get("elev") is not None:
            q = f"{T('ps_quota')} {fmt_num(lang, pv['elev'])} m"
            if pv.get("dz") is not None:
                q += f" · {fmt_num(lang, pv['dz'], 1)} m"
            q = _shape_ok(lang, q)
            cv.setFont(font, _fit(cv, q, font, 6.2, tw))
            cv.drawString(xt, _y(y), q)
            y += 8.2
        y += 2.0


# ---------------------------------------------------------------------------
# Cartiglio: marchio + celle etichetta/valore, come le tavole tecniche
# ---------------------------------------------------------------------------
def _draw_cartouche(cv, cells: list[tuple[str, str]], lang: str,
                    font: str, fontb: str, rev: str) -> None:
    from reportlab.lib import colors

    _x0, y0, _x1, y1 = CART_BOX
    cv.setStrokeColor(colors.HexColor(LINE))
    cv.setLineWidth(0.5)
    cv.rect(CART_X[0], _y(y1), CART_X[-1] - CART_X[0], y1 - y0, stroke=1, fill=0)
    for xd in CART_X[1:-1]:
        cv.line(xd, _y(y0), xd, _y(y1))

    # cella del marchio
    logo = os.path.join(_ASSETS, "nabu-logo-color.png")
    lx = CART_X[0] + 10.0
    if os.path.exists(logo):
        try:
            cv.drawImage(logo, lx, _y(y0 + 30.0), width=26, height=20,
                         preserveAspectRatio=True, mask="auto")
        except Exception:  # noqa: BLE001
            pass
    cv.setFillColor(colors.HexColor(INK))
    cv.setFont(fontb, 12.0)
    cv.drawString(lx + 31.0, _y(y0 + 23.0), "Argus Total")
    cv.setFont(font, 5.8)
    cv.setFillColor(colors.HexColor(INK_SOFT))
    cv.drawString(lx + 32.0, _y(y0 + 31.0), "by Nabu, Agrostar Group")
    cv.drawString(lx, _y(y0 + 50.0), _shape_ok(lang, tr(lang, "ps_sottotitolo")))
    cv.drawString(lx, _y(y0 + 63.0), rev)

    for i, (label, value) in enumerate(cells):
        cx = CART_X[i + 1] + 10.0
        cv.setFont(font, 5.6)
        cv.setFillColor(colors.HexColor(INK_SOFT))
        cv.drawString(cx, _y(y0 + 13.0), _shape_ok(lang, label.upper()))
        cv.setFont(fontb, 9.0)
        cv.setFillColor(colors.HexColor(INK))
        cv.drawString(cx, _y(y0 + 28.0), _shape_ok(lang, value))


def _draw_frame(cv) -> None:
    from reportlab.lib import colors
    x0, y0, x1, y1 = FRAME
    cv.setStrokeColor(colors.HexColor(INK))
    cv.setLineWidth(1.7)
    cv.rect(x0, _y(y1), x1 - x0, y1 - y0, stroke=1, fill=0)
    cv.setLineWidth(0.5)
    cv.rect(x0 + 5, _y(y1 - 5), (x1 - x0) - 10, (y1 - y0) - 10, stroke=1, fill=0)


# ---------------------------------------------------------------------------
def draw_sheet(cv, map_png: bytes, pivots: list[dict], centre: tuple[float, float],
               cells: list[tuple[str, str]], lang: str, rev: str) -> None:
    """Disegna l'intera tavola sul canvas corrente (pagina gia' impostata A3).

    Si lavora sul canvas invece di comporre un PDF a parte: cosi' la tavola
    convive con la scheda A4 nello stesso documento, senza dover unire file.
    """
    from reportlab.lib import colors
    from reportlab.lib.utils import ImageReader
    from .report import _ensure_fonts, _fonts

    _ensure_fonts()
    font, fontb = _fonts(lang)

    mx0, my0, mx1, my1 = MAP_BOX
    if map_png:
        cv.drawImage(ImageReader(io.BytesIO(map_png)), mx0, _y(my1),
                     width=mx1 - mx0, height=my1 - my0,
                     preserveAspectRatio=False, mask=None)
    else:
        cv.setFillColor(colors.HexColor("#eef3ef"))
        cv.rect(mx0, _y(my1), mx1 - mx0, my1 - my0, stroke=0, fill=1)

    _draw_frame(cv)
    cv.setStrokeColor(colors.HexColor(INK))
    cv.setLineWidth(0.5)
    cv.line(mx1, _y(my0), mx1, _y(my1))

    _draw_sidebar(cv, pivots, centre, lang, font, fontb)
    _draw_cartouche(cv, cells, lang, font, fontb, rev)

    cv.setFont(font, 5.2)
    cv.setFillColor(colors.HexColor(INK_SOFT))
    cv.drawString(FRAME[0] + 4, _y(FRAME[3] + 10), _shape_ok(lang, tr(lang, "ps_disclaimer")))


def plan_sheet(map_png: bytes, pivots: list[dict], centre: tuple[float, float],
               cells: list[tuple[str, str]], lang: str, rev: str,
               title: str) -> bytes:
    """Tavola da sola, come PDF autonomo (usata nei test)."""
    from reportlab.pdfgen import canvas as rl_canvas
    buf = io.BytesIO()
    cv = rl_canvas.Canvas(buf, pagesize=(A3_W, A3_H))
    cv.setTitle(title)
    draw_sheet(cv, map_png, pivots, centre, cells, lang, rev)
    cv.showPage()
    cv.save()
    return buf.getvalue()
