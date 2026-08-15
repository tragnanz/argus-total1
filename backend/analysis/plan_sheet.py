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


def geometry(fmt: str = "a3") -> dict:
    """Geometria della tavola nel formato richiesto.

    L'impaginazione e' disegnata in A3; l'A4 orizzontale e' la stessa tavola in
    scala (fattore 0,707). I CORPI dei testi non seguono la scala geometrica:
    ridotti di altrettanto sarebbero illeggibili, quindi in A4 si stringono di
    meno e ci sta meno roba — che e' esattamente la differenza fra i due
    formati. In A3, viceversa, tratti e testi si assottigliano per far entrare
    piu' informazione.
    """
    fmt = (fmt or "a3").lower()
    if fmt == "a4":
        k = A3_H / A3_W          # 0,707: A4 orizzontale = A3 in scala
        fk, lk = 0.86, 0.80      # testi e tratti: piu' grandi del rapporto
        detail = 0.80            # meno etichette sul disegno
    else:
        k, fk, lk, detail = 1.0, 0.93, 0.85, 1.25
    sc = lambda t: tuple(v * k for v in t)   # noqa: E731
    return {
        "fmt": "a4" if fmt == "a4" else "a3",
        "k": k, "fk": fk, "lk": lk, "detail": detail,
        "W": A3_W * k, "H": A3_H * k,
        "frame": sc(FRAME), "map": sc(MAP_BOX), "side": sc(SIDE_BOX),
        "cart": sc(CART_BOX), "cart_x": [v * k for v in CART_X],
    }


def _y(g: dict, v: float) -> float:
    """Da coordinate con origine in alto (come le misure) a quelle di reportlab."""
    return g["H"] - v


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


def _draw_sidebar(cv, g: dict, pivots: list[dict], centre: tuple[float, float],
                  lang: str, font: str, fontb: str) -> None:
    from reportlab.lib import colors

    k, fk = g["k"], g["fk"]
    x0, y0, x1, y1b = g["side"]
    x = x0 + 13.0 * k
    colw = x1 - x - 6.0 * k      # larghezza utile della colonna
    y = y0 + 16.0 * k

    def T(key, **kw):
        return _shape_ok(lang, tr(lang, key, **kw))

    cv.setFillColor(colors.HexColor(INK))
    head = T("ps_coord")
    cv.setFont(fontb, _fit(cv, head, fontb, 7.6 * fk, colw))
    cv.drawString(x, _y(g, y), head)
    y += 12.0 * fk

    cv.setFont(font, 6.0 * fk)
    cv.setFillColor(colors.HexColor(INK_SOFT))
    cv.drawString(x, _y(g, y), T("ps_centro"))
    y += 8.5 * fk
    cv.setFillColor(colors.HexColor(INK))
    cv.setFont(font, 7.0 * fk)
    cv.drawString(x, _y(g, y), f"{centre[0]:.6f}, {centre[1]:.6f}")
    y += 9.5 * fk
    cv.setFont(font, 6.2 * fk)
    cv.setFillColor(colors.HexColor("#2f7fbf"))
    link = f"https://www.google.com/maps?q={centre[0]:.6f},{centre[1]:.6f}"
    cv.drawString(x, _y(g, y), ">> Google Maps")
    cv.linkURL(link, (x, _y(g, y) - 2, x + 60 * k, _y(g, y) + 7), relative=0, thickness=0)
    y += 16.0 * fk

    cv.setFillColor(colors.HexColor(INK))
    cv.setFont(fontb, 7.6 * fk)
    cv.drawString(x, _y(g, y), T("ps_impianto"))
    y += 11.0 * fk

    xn = x                          # colonna del numero
    xt = x + 14.0 * k               # colonna del testo
    tw = colw - 14.0 * k            # larghezza utile per le righe rientrate
    lh = 8.2 * fk                   # interlinea delle schede
    y_end = y1b - 8.0 * k           # fondo utile della barra
    for i, pv in enumerate(pivots, 1):
        if y > y_end:           # oltre il fondo della barra: si tronca
            cv.setFont(font, 6.0 * fk)
            cv.setFillColor(colors.HexColor(INK_SOFT))
            cv.drawString(xt, _y(g, y), T("ps_altri", n=len(pivots) - i + 1))
            break
        cv.setFillColor(colors.HexColor(INK))
        cv.setFont(font, 6.4 * fk)
        cv.drawString(xn, _y(g, y), str(i))
        cv.drawString(xt, _y(g, y), f"{pv['lat']:.6f}, {pv['lon']:.6f}")
        y += lh

        head = (f"R {fmt_num(lang, pv['r'])}m · 360° · "
                f"{fmt_num(lang, pv['ha'], 2)} ha")
        if pv.get("pct") is not None:
            head += f" · {fmt_num(lang, pv['pct'], 1)}%"
        head = _shape_ok(lang, head)
        cv.setFont(fontb, _fit(cv, head, fontb, 6.6 * fk, tw))
        cv.drawString(xt, _y(g, y), head)
        y += lh

        cv.setFillColor(colors.HexColor(INK))
        qp = []
        if pv.get("q_m3h"):
            qp.append(f"Q {fmt_num(lang, pv['q_m3h'])} m³/h")
        if pv.get("p_bar"):
            qp.append(f"P {fmt_num(lang, pv['p_bar'], 2)} bar")
        if qp:
            line = _shape_ok(lang, " · ".join(qp))
            cv.setFont(font, _fit(cv, line, font, 6.2 * fk, tw))
            cv.drawString(xt, _y(g, y), line)
            y += lh
        if pv.get("elev") is not None:
            q = f"{T('ps_quota')} {fmt_num(lang, pv['elev'])} m"
            if pv.get("dz") is not None:
                q += f" · {fmt_num(lang, pv['dz'], 1)} m"
            q = _shape_ok(lang, q)
            cv.setFont(font, _fit(cv, q, font, 6.2 * fk, tw))
            cv.drawString(xt, _y(g, y), q)
            y += lh
        y += 2.0 * fk


# ---------------------------------------------------------------------------
# Cartiglio: marchio + celle etichetta/valore, come le tavole tecniche
# ---------------------------------------------------------------------------
def _draw_cartouche(cv, g: dict, cells: list[tuple[str, str]], lang: str,
                    font: str, fontb: str, rev: str) -> None:
    from reportlab.lib import colors

    k, fk, lk = g["k"], g["fk"], g["lk"]
    cx_ = g["cart_x"]
    _x0, y0, _x1, y1 = g["cart"]
    cv.setStrokeColor(colors.HexColor(LINE))
    cv.setLineWidth(0.5 * lk)
    cv.rect(cx_[0], _y(g, y1), cx_[-1] - cx_[0], y1 - y0, stroke=1, fill=0)
    for xd in cx_[1:-1]:
        cv.line(xd, _y(g, y0), xd, _y(g, y1))

    # cella del marchio
    logo = os.path.join(_ASSETS, "nabu-logo-color.png")
    lx = cx_[0] + 10.0 * k
    if os.path.exists(logo):
        try:
            cv.drawImage(logo, lx, _y(g, y0 + 30.0 * k), width=26 * k, height=20 * k,
                         preserveAspectRatio=True, mask="auto")
        except Exception:  # noqa: BLE001
            pass
    # La cella del marchio si stringe col foglio: i testi vanno rimisurati,
    # altrimenti in A4 sconfinano nella cella del cliente.
    bx = lx + 31.0 * k
    bw = cx_[1] - bx - 6.0 * k
    cv.setFillColor(colors.HexColor(INK))
    cv.setFont(fontb, _fit(cv, "Argus Total", fontb, 12.0 * fk, bw))
    cv.drawString(bx, _y(g, y0 + 23.0 * k), "Argus Total")
    cv.setFillColor(colors.HexColor(INK_SOFT))
    cv.setFont(font, _fit(cv, "by Nabu, Agrostar Group", font, 5.8 * fk, bw))
    cv.drawString(bx + 1.0 * k, _y(g, y0 + 31.0 * k), "by Nabu, Agrostar Group")
    fw = cx_[1] - lx - 8.0 * k
    sub = _shape_ok(lang, tr(lang, "ps_sottotitolo"))
    cv.setFont(font, _fit(cv, sub, font, 5.8 * fk, fw))
    cv.drawString(lx, _y(g, y0 + 50.0 * k), sub)
    cv.setFont(font, _fit(cv, rev, font, 5.8 * fk, fw))
    cv.drawString(lx, _y(g, y0 + 63.0 * k), rev)

    for i, (label, value) in enumerate(cells):
        if i + 1 >= len(cx_) - 1:
            break
        cw = cx_[i + 2] - cx_[i + 1] - 14.0 * k
        cxx = cx_[i + 1] + 10.0 * k
        cv.setFont(font, _fit(cv, label.upper(), font, 5.6 * fk, cw))
        cv.setFillColor(colors.HexColor(INK_SOFT))
        cv.drawString(cxx, _y(g, y0 + 13.0 * k), _shape_ok(lang, label.upper()))
        val = _shape_ok(lang, value)
        cv.setFont(fontb, _fit(cv, val, fontb, 9.0 * fk, cw))
        cv.setFillColor(colors.HexColor(INK))
        cv.drawString(cxx, _y(g, y0 + 28.0 * k), val)


def _draw_frame(cv, g: dict) -> None:
    from reportlab.lib import colors
    k, lk = g["k"], g["lk"]
    x0, y0, x1, y1 = g["frame"]
    cv.setStrokeColor(colors.HexColor(INK))
    cv.setLineWidth(1.7 * lk)
    cv.rect(x0, _y(g, y1), x1 - x0, y1 - y0, stroke=1, fill=0)
    cv.setLineWidth(0.5 * lk)
    cv.rect(x0 + 5 * k, _y(g, y1 - 5 * k), (x1 - x0) - 10 * k, (y1 - y0) - 10 * k,
            stroke=1, fill=0)


# ---------------------------------------------------------------------------
def draw_sheet(cv, map_png: bytes, pivots: list[dict], centre: tuple[float, float],
               cells: list[tuple[str, str]], lang: str, rev: str,
               fmt: str = "a3") -> None:
    """Disegna l'intera tavola sul canvas corrente (pagina gia' impostata).

    Si lavora sul canvas invece di comporre un PDF a parte: cosi' la tavola
    convive con la scheda A4 nello stesso documento, senza dover unire file.
    """
    from reportlab.lib import colors
    from reportlab.lib.utils import ImageReader
    from .report import _ensure_fonts, _fonts

    _ensure_fonts()
    font, fontb = _fonts(lang)
    g = geometry(fmt)

    mx0, my0, mx1, my1 = g["map"]
    if map_png:
        cv.drawImage(ImageReader(io.BytesIO(map_png)), mx0, _y(g, my1),
                     width=mx1 - mx0, height=my1 - my0,
                     preserveAspectRatio=False, mask=None)
    else:
        cv.setFillColor(colors.HexColor("#eef3ef"))
        cv.rect(mx0, _y(g, my1), mx1 - mx0, my1 - my0, stroke=0, fill=1)

    _draw_frame(cv, g)
    cv.setStrokeColor(colors.HexColor(INK))
    cv.setLineWidth(0.5 * g["lk"])
    cv.line(mx1, _y(g, my0), mx1, _y(g, my1))

    _draw_sidebar(cv, g, pivots, centre, lang, font, fontb)
    _draw_cartouche(cv, g, cells, lang, font, fontb, rev)

    cv.setFont(font, 5.2 * g["fk"])
    cv.setFillColor(colors.HexColor(INK_SOFT))
    cv.drawString(g["frame"][0] + 4 * g["k"], _y(g, g["frame"][3] + 10 * g["k"]),
                  _shape_ok(lang, tr(lang, "ps_disclaimer")))


def plan_sheet(map_png: bytes, pivots: list[dict], centre: tuple[float, float],
               cells: list[tuple[str, str]], lang: str, rev: str,
               title: str, fmt: str = "a3") -> bytes:
    """Tavola da sola, come PDF autonomo (usata nei test)."""
    from reportlab.pdfgen import canvas as rl_canvas
    g = geometry(fmt)
    buf = io.BytesIO()
    cv = rl_canvas.Canvas(buf, pagesize=(g["W"], g["H"]))
    cv.setTitle(title)
    draw_sheet(cv, map_png, pivots, centre, cells, lang, rev, fmt)
    cv.showPage()
    cv.save()
    return buf.getvalue()
