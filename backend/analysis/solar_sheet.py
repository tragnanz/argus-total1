"""Scheda del campo fotovoltaico di un pivot solare (PDF A3 orizzontale).

Vista prospettica, pianta in scala con le quote, sezione delle file e dati di
progetto, con lo stesso dimensionamento della scheda «Pivot solari» di Argus:
potenza del pivot = torri × 0,75 kW (+ 1,5 kW se c'è l'irrigatore finale),
kWp = potenza × fattore, moduli verticali inclinati di 25° a sud del perno
(a nord nell'emisfero australe), file a 3,5 m. I testi arrivano tradotti dal
client (`labels`); mancando, restano quelli italiani.
"""
from __future__ import annotations

import io
import math
import os

from .report import _ASSETS, _shape

IT = {
    "kicker": "CAMPO FOTOVOLTAICO DEL PIVOT SOLARE",
    "title": "{name} · {r} m · {n} campate{gun}",
    "withGun": " · irrigatore finale",
    "sub": "{kw} kW assorbiti → {kwp} kWp: {n} moduli da {wp} Wp in {rows} file, a {off} m dal perno, inclinati di {tilt}° verso {dir}",
    "south": "sud", "north": "nord",
    "persp": "Vista prospettica · il pivot ruota sopra il campo FV: nel raggio dei pannelli (≈ {r} m) niente discese degli irrigatori",
    "plan": "PIANTA · scala grafica", "section": "SEZIONE DELLE FILE", "data": "DATI DI PROGETTO",
    "pivotPt": "perno", "panel": "quadro FV / inverter", "noDrops": "raggio senza discese {r} m", "span1": "1ª campata {l} m",
    "pipe": "tubo della campata ≈ 4,4 m", "truss": "traliccio ≈ 3,2 m", "pitch": "passo {p} m",
    "kPower": "Potenza del pivot", "vPower": "{t} torri × 0,75 kW{g} = {kw} kW", "vGun": " + irrigatore finale 1,5 kW",
    "kField": "Campo FV", "vField": "{kwp} kWp ({k} kWp per kW): {n} moduli da {wp} Wp, 1,134 × 2,278 m",
    "kLayout": "Disposizione", "vLayout": "{rows} file da {cols} moduli verticali, inclinati {tilt}°, passo {p} m",
    "kArea": "Ingombro", "vArea": "{w} × {d} m = {a} m² · bordo a {off} m dal perno",
    "kHeight": "Altezza", "vHeight": "da {h0} a {h1} m: sotto il traliccio (≈ 3,2 m), il pivot ci passa sopra",
    "kFlow": "Portata del pivot", "vFlow": "{q} l/s ({m3} m³/h) a {p} bar",
    "kElec": "Elettrico", "vElecDay": "inverter / regolatore ≈ {inv} kW nel quadro vicino al perno; senza batterie il pivot irriga di giorno",
    "vElecBatt": "inverter / regolatore ≈ {inv} kW nel quadro vicino al perno; batterie {b} kWh ({h} h di autonomia)",
    "foot": "Argus Total · by Nabu · Agrostar Group — schema indicativo: moduli, strutture e altezze da verificare con il costruttore del pivot e dell'impianto FV.",
}


def _num(v: float, d: int, dec: str) -> str:
    s = f"{v:,.{d}f}"
    return s.replace(",", "\x00").replace(".", dec).replace("\x00", "." if dec == "," else ",")


def build_solar_sheet(d: dict) -> bytes:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
    from matplotlib import font_manager as fm
    from matplotlib.patches import Circle, Rectangle
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    lang = d.get("lang") or "it"
    L = {**IT, **(d.get("labels") or {})}
    dec = "." if lang in ("en", "zh", "ms") else ","
    N = lambda v, k=1: _num(v, k, dec)  # noqa: E731
    S = (lambda s: _shape(lang, s)) if lang == "ar" else (lambda s: s)  # noqa: E731
    fam, famH = "DejaVu Sans", "DejaVu Sans"
    fd = os.path.join(_ASSETS, "fonts")
    if lang == "zh" and os.path.exists(os.path.join(fd, "NabuCJK.ttf")):
        fm.fontManager.addfont(os.path.join(fd, "NabuCJK.ttf")); fam = famH = fm.FontProperties(fname=os.path.join(fd, "NabuCJK.ttf")).get_name()
    elif lang not in ("ar", "zh"):
        for f in ("Inter-Regular.ttf", "Inter-SemiBold.ttf", "Inter-Bold.ttf", "PlusJakartaSans-700.ttf"):
            p = os.path.join(fd, f)
            if os.path.exists(p):
                fm.fontManager.addfont(p)
        fam = "Inter"; famH = "Plus Jakarta Sans" if lang in ("it", "en", "fr", "es", "pt", "de", "ro", "hu", "pl", "af", "ms", "id") else "Inter"
    plt.rcParams.update({"font.family": fam, "font.size": 9})
    NAVY, BLUE, MUT, BOR = "#001A33", "#009FE3", "#5C636A", "#BEC7D2"

    spans = d.get("spans") or [{"len": 54.0, "d": '6"5/8'}] * 5
    nt = len(spans); gun = float(d.get("gun") or 0); r = float(d.get("r") or sum(s["len"] for s in spans))
    cfg = d.get("cfg") or {}
    wp, k, batt, off = float(cfg.get("wp", 550)), float(cfg.get("k", 1.6)), float(cfg.get("batt", 0)), float(cfg.get("off", 6))
    kW = nt * 0.75 + (1.5 if gun > 0 else 0)
    n = max(2, math.ceil(kW * k * 1000 / max(100, wp))); cols = max(2, math.ceil(math.sqrt(n * 1.8))); rows = math.ceil(n / cols); kWp = n * wp / 1000
    bkwh = math.ceil(kW * batt / 0.9) if batt > 0 else 0; inv = math.ceil(kW * 1.25)
    mw, ml, tilt, h0, pitch, gap = 1.134, 2.278, 25, 0.50, 3.5, 0.02
    md = ml * math.cos(math.radians(tilt)); htop = h0 + ml * math.sin(math.radians(tilt))
    W = cols * (mw + gap) - gap; D = (rows - 1) * pitch + md
    Rnd = math.ceil(off + D + 3)                      # raggio senza discese
    south = (d.get("lat") or 0) >= 0
    mods = []
    for i in range(n):
        rr, c = divmod(i, cols); mods.append((-W / 2 + c * (mw + gap), -(off + rr * pitch)))
    L1 = float(spans[0]["len"])

    fig = plt.figure(figsize=(16.54, 11.69))
    fig.text(0.035, 0.955, S(L["kicker"]), fontsize=8.5, color=BLUE, fontweight="bold", family=famH)
    fig.text(0.035, 0.925, S(L["title"].format(name=d.get("name", "P1"), r=N(r, 0), n=nt, gun=L["withGun"] if gun > 0 else "")), fontsize=19, color=NAVY, fontweight="bold", family=famH)
    fig.text(0.035, 0.902, S(L["sub"].format(kw=N(kW, 2), kwp=N(kWp, 1), n=n, wp=N(wp, 0), rows=rows, off=N(off, 0), tilt=tilt, dir=L["south"] if south else L["north"])), fontsize=10.5, color=MUT)
    # ---- prospettiva
    ax = fig.add_axes([-0.04, 0.27, 0.68, 0.68], projection="3d"); ax.computed_zorder = False
    ax.set_proj_type("persp", focal_length=0.45)
    X0, X1, Y0, Y1 = -10, 15, -(off + D + 9), 7
    ax.add_collection3d(Poly3DCollection([[[X0, Y0, 0], [X1, Y0, 0], [X1, Y1, 0], [X0, Y1, 0]]], facecolor="#d9c9a3", edgecolor="none", zorder=0))
    for R in np.arange(8, 40, 4):
        t = np.linspace(-math.pi, math.pi, 160); xs, ys = R * np.cos(t), R * np.sin(t); m = (xs > X0) & (xs < X1) & (ys > Y0) & (ys < Y1)
        xs, ys = np.where(m, xs, np.nan), np.where(m, ys, np.nan); ax.plot(xs, ys, 0.005, color="#c4b28a", lw=0.6)

    def box(x0, x1, y0, y1, z0, z1, fc):
        V = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
        Fc = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
        ax.add_collection3d(Poly3DCollection([[V[i] for i in f] for f in Fc], facecolor=fc, edgecolor="#33404d", linewidths=0.3))
    for rr in range(rows):
        y0 = -(off + rr * pitch); yb = y0 - md
        for x in np.linspace(-W / 2 + 0.2, W / 2 - 0.2, 4):
            ax.plot([x, x], [yb + 0.15] * 2, [0, h0 + 0.05], color="#8a949e", lw=1.2); ax.plot([x, x], [y0 - 0.15] * 2, [0, htop - 0.05], color="#8a949e", lw=1.2)
    for (x0, y0) in mods:
        ax.add_collection3d(Poly3DCollection([[[x0, y0 - md, h0], [x0 + mw, y0 - md, h0], [x0 + mw, y0, htop], [x0, y0, htop]]], facecolor="#1f3b7a", edgecolor="#d7e3f4", linewidths=0.5))
    box(2.4, 3.2, -3.6, -3.0, 0, 1.6, "#e8edf2"); ax.plot([2.8, 0], [-3.3, -off], [0.05, 0.05], color="#e11d48", lw=1.2, ls="--")
    box(-1.75, 1.75, -1.75, 1.75, 0, 0.2, "#bfbfbf")
    for sx, sy in [(-1.6, -1.6), (1.6, -1.6), (1.6, 1.6), (-1.6, 1.6)]:
        ax.plot([sx, 0], [sy, 0], [0.2, 3.9], color="#4a5560", lw=2.2)
    ax.plot([0, 0], [0, 0], [0, 4.6], color="#4a5560", lw=4)
    ang = math.radians(35); ux, uy = math.cos(ang), math.sin(ang); Lc = 17
    ax.plot([0, Lc * ux], [0, Lc * uy], [4.4, 4.4], color="#6b7680", lw=3)
    for dd in np.arange(2, Lc - 1, 4):
        ax.plot([dd * ux, (dd + 2) * ux], [dd * uy, (dd + 2) * uy], [4.4, 3.2], color="#6b7680", lw=0.8)
        ax.plot([(dd + 2) * ux, (dd + 4) * ux], [(dd + 2) * uy, (dd + 4) * uy], [3.2, 4.4], color="#6b7680", lw=0.8)
    ax.plot([0, Lc * ux], [0, Lc * uy], [3.2, 3.2], color="#6b7680", lw=0.6)
    for dd in np.arange(Rnd, Lc, 1.5):
        ax.plot([dd * ux] * 2, [dd * uy] * 2, [4.4, 1.8], color="#20aae2", lw=0.7)
    ax.quiver(-8.5, 3, 0, 0, 3, 0, color=NAVY, arrow_length_ratio=0.35, lw=1.5); ax.text(-8.5, 6.6, 0, "N", color=NAVY, fontweight="bold")
    ax.set_xlim(X0, X1); ax.set_ylim(Y0, Y1); ax.set_zlim(0, 7); ax.set_box_aspect((X1 - X0, Y1 - Y0, 7)); ax.view_init(elev=22, azim=-62); ax.set_axis_off()
    fig.text(0.04, 0.31, S(L["persp"].format(r=Rnd)), fontsize=8.5, color=MUT)
    # ---- pianta
    pa = fig.add_axes([0.62, 0.40, 0.35, 0.48]); pa.set_aspect("equal")
    pa.add_patch(Rectangle((-1.75, -1.75), 3.5, 3.5, fc="#e6e6e6", ec="#555", lw=0.6)); pa.add_patch(Circle((0, 0), 0.25, fc="#555"))
    pa.add_patch(Circle((0, 0), Rnd, fill=False, ec=BOR, lw=0.8, ls="--"))
    for (x0, y0) in mods:
        pa.add_patch(Rectangle((x0, y0 - md), mw, md, fc="#1f3b7a", ec="#d7e3f4", lw=0.4))
    pa.add_patch(Rectangle((2.4, -3.6), 0.8, 0.6, fc="#e8edf2", ec="#333", lw=0.5)); pa.plot([2.8, 0], [-3.6, -off], color="#e11d48", lw=0.8, ls="--")
    pa.plot([0, 22 * ux], [0, 22 * uy], color="#6b7680", lw=1.6)

    def dim(p0, p1, txt, o=(0, 0), rot=0, axx=pa):
        axx.annotate("", xy=p1, xytext=p0, arrowprops=dict(arrowstyle="<->", color=NAVY, lw=0.6))
        axx.text((p0[0] + p1[0]) / 2 + o[0], (p0[1] + p1[1]) / 2 + o[1], txt, ha="center", va="center", fontsize=7.5, color=NAVY, rotation=rot, bbox=dict(fc="white", ec="none", pad=0.5))
    yb = -(off + D)
    dim((-W / 2, yb - 1.2), (W / 2, yb - 1.2), f"{N(W, 2)} m", (0, -0.9))
    dim((W / 2 + 1.2, -off), (W / 2 + 1.2, yb), f"{N(D, 2)} m", (1.4, 0), 90)
    dim((-W / 2 - 1.2, 0), (-W / 2 - 1.2, -off), f"{N(off, 1)} m", (-1.3, 0), 90)
    pa.text(0, 2.6, S(L["pivotPt"]), ha="center", fontsize=7.5, color=MUT)
    pa.text(3.6, -3.3, S(L["panel"]), fontsize=7, color=MUT, va="center")
    pa.text(Rnd * 0.72 + 0.5, -Rnd * 0.72 - 0.5, S(L["noDrops"].format(r=Rnd)), fontsize=7, color=MUT, rotation=45, ha="left", va="top")
    pa.text(18.5 * ux + 0.6, 18.5 * uy + 0.8, S(L["span1"].format(l=N(L1, 1))), fontsize=7, color=MUT, rotation=35)
    lo = min(-22, yb - 4)
    pa.set_xlim(-16, 22); pa.set_ylim(lo, 12); pa.axis("off")
    pa.annotate("N", xy=(-14, 10.5), xytext=(-14, 6.5), ha="center", fontsize=9, fontweight="bold", color=NAVY, arrowprops=dict(arrowstyle="-|>", color=NAVY, lw=1))
    for i in range(4):
        pa.add_patch(Rectangle((-14 + i * 2.5, lo + 1.5), 2.5, 0.5, fc=NAVY if i % 2 == 0 else "white", ec=NAVY, lw=0.5))
    pa.text(-14, lo + 0.4, "0", fontsize=7, ha="center"); pa.text(-4, lo + 0.4, "10 m", fontsize=7, ha="center")
    fig.text(0.62, 0.895, S(L["plan"]), fontsize=8.5, color=BLUE, fontweight="bold", family=famH)
    # ---- sezione
    sa = fig.add_axes([0.62, 0.08, 0.35, 0.26]); sa.set_aspect("equal")
    span_x = (rows - 1) * pitch + md + 1.5
    sa.plot([-1, span_x], [0, 0], color="#7a6a48", lw=1)
    for rr in range(rows):
        y = rr * pitch
        sa.plot([y, y + md], [htop, h0], color="#1f3b7a", lw=3.2, solid_capstyle="butt")
        sa.plot([y + 0.15] * 2, [0, htop - 0.05], color="#8a949e", lw=1.2); sa.plot([y + md - 0.15] * 2, [0, h0 + 0.05], color="#8a949e", lw=1.2)
    sa.plot([-1, span_x], [4.4, 4.4], color="#6b7680", lw=2.4); sa.text(span_x, 4.65, S(L["pipe"]), fontsize=7, ha="right", color=MUT)
    sa.plot([-1, span_x], [3.2, 3.2], color="#6b7680", lw=0.6, ls=":"); sa.text(span_x, 2.85, S(L["truss"]), fontsize=7, ha="right", color=MUT)
    dim((-0.6, 0), (-0.6, htop), f"{N(htop, 2)} m", (-0.55, 0), 90, sa)
    if rows > 1:
        dim((0, -0.6), (pitch, -0.6), S(L["pitch"].format(p=N(pitch, 1))), (0, -0.45), 0, sa)
    sa.text(md * 0.5 + 0.2, htop + 0.35, f"{tilt}°", fontsize=7, color=NAVY)
    sa.text(-0.9, 5.3, "N" if south else "S", fontsize=7, color=MUT); sa.text(span_x - 0.4, 5.3, "S" if south else "N", fontsize=7, color=MUT)
    sa.set_xlim(-1.8, span_x + 0.3); sa.set_ylim(-1.4, 5.8); sa.axis("off")
    fig.text(0.62, 0.345, S(L["section"]), fontsize=8.5, color=BLUE, fontweight="bold", family=famH)
    # ---- dati
    rws = [(L["kPower"], L["vPower"].format(t=nt, g=L["vGun"] if gun > 0 else "", kw=N(kW, 2))),
           (L["kField"], L["vField"].format(kwp=N(kWp, 1), k=N(k, 1), n=n, wp=N(wp, 0))),
           (L["kLayout"], L["vLayout"].format(rows=rows, cols=cols, tilt=tilt, p=N(pitch, 1))),
           (L["kArea"], L["vArea"].format(w=N(W, 1), d=N(D, 1), a=N(W * D, 0), off=N(off, 0))),
           (L["kHeight"], L["vHeight"].format(h0=N(h0, 2), h1=N(htop, 2)))]
    if d.get("show_flow") and d.get("q_ls"):
        q = float(d["q_ls"]); rws.append((L["kFlow"], L["vFlow"].format(q=N(q, 1), m3=N(q * 3.6, 0), p=N(float(d.get("p_bar") or 0), 1))))
    rws.append((L["kElec"], (L["vElecBatt"] if bkwh else L["vElecDay"]).format(inv=inv, b=bkwh, h=N(batt, 0))))
    fig.text(0.04, 0.255, S(L["data"]), fontsize=8.5, color=BLUE, fontweight="bold", family=famH)
    for i, (a, b) in enumerate(rws):
        yy = 0.225 - i * 0.025
        fig.text(0.04, yy, S(a), fontsize=9, color=MUT); fig.text(0.17, yy, S(b), fontsize=9.5, color=NAVY)
    fig.text(0.04, 0.03, S(L["foot"]), fontsize=7.5, color=MUT)
    buf = io.BytesIO(); fig.savefig(buf, format="pdf"); plt.close(fig)
    return buf.getvalue()
