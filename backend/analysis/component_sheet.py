"""Tavola di disegno (PDF A3 orizzontale) di uno o più componenti: canale, strada, tubazione.

Pianta in scala con i pivot attorno, sezione tipo quotata (canale + strada affiancati se presenti
insieme), profilo longitudinale dal modello del terreno con fondo, pelo libero, argini e salti di
quota, dati di progetto e cartiglio. I testi arrivano tradotti dal client (`labels`).
"""
from __future__ import annotations

import io
import math
import os
from datetime import date

from .canal_design import design_canal, terrain_profile
from .report import _ASSETS, _shape

IT = {
    "kicker": "TAVOLA DI PROGETTO",
    "plan": "PIANTA", "section": "SEZIONE TIPO", "profile": "PROFILO LONGITUDINALE", "data": "DATI DI PROGETTO",
    "canal": "Canale", "road": "Strada", "pipe": "Tubazione",
    "terrain": "terreno", "bed": "fondo canale", "water": "pelo libero", "bank": "sommità argini",
    "grade": "piano stradale", "invert": "scorrimento tubo",
    "drop": "salto", "drops": "{n} salti di quota, {h} m in tutto (max {m} m l'uno)", "noDrops": "nessun salto necessario",
    "kFlow": "Portata", "kLen": "Lunghezza", "kSlope": "Pendenza di progetto", "kTerr": "Pendenza del terreno",
    "kSec": "Sezione", "vSec": "base {b} m · tirante {y} m · franco {fb} m · scarpe 1:{m} · larghezza in sommità {B} m",
    "kVel": "Velocità", "kCut": "Scavo", "vCut": "{v} m³ (max {h} m)", "kFill": "Rilevato", "kDrops": "Salti di quota",
    "kRoad": "Piattaforma", "vRoad": "carreggiata {w} m · banchine {s} m · massicciata {l} cm · rilevato {f} m · pendenza trasversale 2,5%",
    "kPipe": "Condotta", "vPipe": "DN {dn} · ricoprimento {c} m · trincea {t} m",
    "bTop": "larghezza in sommità", "cover": "ricoprimento", "trench": "trincea",
    "proj": "Progetto", "client": "Cliente", "field": "Campo", "scale": "Scala", "date": "Data", "sheet": "Tavola",
    "vexag": "scala verticale esagerata ×{k}", "km": "progressiva (m)", "elev": "quota (m s.l.m.)",
    "foot": "Argus Total · by Nabu · Agrostar Group — disegno di progetto da verificare con il rilievo topografico di dettaglio.",
}


def _num(v: float, d: int, dec: str) -> str:
    s = f"{v:,.{d}f}"
    return s.replace(",", "§").replace(".", dec).replace("§", "." if dec == "," else ",")


def _fonts(lang: str):
    import matplotlib
    matplotlib.use("Agg")
    from matplotlib import font_manager as fm
    fam = famH = "DejaVu Sans"
    fd = os.path.join(_ASSETS, "fonts")
    if lang == "zh" and os.path.exists(os.path.join(fd, "NabuCJK.ttf")):
        fm.fontManager.addfont(os.path.join(fd, "NabuCJK.ttf")); fam = famH = fm.FontProperties(fname=os.path.join(fd, "NabuCJK.ttf")).get_name()
    elif lang not in ("ar", "zh"):
        for f in ("Inter-Regular.ttf", "Inter-SemiBold.ttf", "Inter-Bold.ttf", "PlusJakartaSans-700.ttf"):
            p = os.path.join(fd, f)
            if os.path.exists(p):
                fm.fontManager.addfont(p)
        fam = "Inter"; famH = "Plus Jakarta Sans" if lang in ("it", "en", "fr", "es", "pt", "de", "ro", "hu", "pl", "af", "ms", "id") else "Inter"
    return fam, famH


def build_component_sheet(client, doc: dict) -> bytes:
    import matplotlib.pyplot as plt
    import numpy as np
    from matplotlib.patches import Circle, Polygon, Rectangle

    lang = doc.get("lang") or "it"
    L = {**IT, **(doc.get("labels") or {})}
    dec = "." if lang in ("en", "zh", "ms") else ","
    N = lambda v, k=1: _num(float(v), k, dec)  # noqa: E731
    S = (lambda s: _shape(lang, s)) if lang == "ar" else (lambda s: s)  # noqa: E731
    fam, famH = _fonts(lang)
    plt.rcParams.update({"font.family": fam, "font.size": 9})
    NAVY, BLUE, MUT, BOR, BROWN, WATER, ROAD = "#001A33", "#009FE3", "#5C636A", "#BEC7D2", "#8a6d3b", "#38bdf8", "#6b7280"

    comps = [c for c in (doc.get("components") or []) if len(c.get("coords") or []) >= 2]
    if not comps:
        raise ValueError("Nessun componente da disegnare.")
    canal = next((c for c in comps if c["type"] == "canal"), None)
    road = next((c for c in comps if c["type"] == "road"), None)
    pipe = next((c for c in comps if c["type"] == "pipe"), None)

    # ---- profili dal terreno (e progetto del canale con i salti)
    for c in comps:
        c["_prof"] = terrain_profile(client, c["coords"], step=20.0)
    des = None
    if canal:
        des = design_canal(canal["_prof"], float(canal["b"]), float(canal["y"]), float(canal["fb"]), float(canal.get("m", 1.5)),
                           float(canal["S"]), drop_max=float(canal.get("drop_max", 1.0)))

    fig = plt.figure(figsize=(16.54, 11.69))
    names = " + ".join(f"{L[c['type']]} {c.get('name') or ''}".strip() for c in comps)
    fig.text(0.035, 0.955, S(L["kicker"]), fontsize=8.5, color=BLUE, fontweight="bold", family=famH)
    fig.text(0.035, 0.925, S(names), fontsize=19, color=NAVY, fontweight="bold", family=famH)
    sub = []
    if canal:
        sub.append(f"{L['canal']}: {N(canal.get('q', 0), 0)} l/s · {N(des['length_m'], 0)} m · {N(canal['S'], 2)}‰")
    if road:
        sub.append(f"{L['road']}: {N(road.get('width', 6), 1)} m")
    if pipe:
        sub.append(f"{L['pipe']}: DN {int(pipe.get('dn') or 0)}")
    fig.text(0.035, 0.902, S("  ·  ".join(sub)), fontsize=10.5, color=MUT)

    # ---- pianta (metri locali)
    lat0 = float(np.mean([p[1] for c in comps for p in c["coords"]])); lon0 = float(np.mean([p[0] for c in comps for p in c["coords"]]))
    kx = 111320 * math.cos(math.radians(lat0)); ky = 110540
    P = lambda ll: ((ll[0] - lon0) * kx, (ll[1] - lat0) * ky)  # noqa: E731
    xs = [P(p)[0] for c in comps for p in c["coords"]]; ys = [P(p)[1] for c in comps for p in c["coords"]]
    span = max(max(xs) - min(xs), max(ys) - min(ys), 200.0)
    pad = span * 0.12 + 60
    x0, x1, y0, y1 = min(xs) - pad, max(xs) + pad, min(ys) - pad, max(ys) + pad
    pa = fig.add_axes([0.035, 0.37, 0.52, 0.51]); pa.set_aspect("equal")
    ctx = doc.get("context") or {}
    ring = ctx.get("field_ring")
    if ring:
        q = [P(p) for p in ring]; pa.plot([a for a, _ in q], [b for _, b in q], color="#f59e0b", lw=1.0, ls="--")
    for (lo, la, r) in ctx.get("pivots") or []:
        cx, cy = P((lo, la))
        if x0 - r < cx < x1 + r and y0 - r < cy < y1 + r:
            pa.add_patch(Circle((cx, cy), r, fc="#16a34a18", ec="#15803d", lw=0.6))
            pa.plot([cx], [cy], marker="^", ms=4, color="#15803d")

    def band(coords, w, fc, ec):
        pts = [P(p) for p in coords]
        for (ax_, ay_), (bx_, by_) in zip(pts[:-1], pts[1:]):
            dx, dy = bx_ - ax_, by_ - ay_; Ls = math.hypot(dx, dy) or 1; nx, ny = -dy / Ls * w / 2, dx / Ls * w / 2
            pa.add_patch(Polygon([(ax_ + nx, ay_ + ny), (bx_ + nx, by_ + ny), (bx_ - nx, by_ - ny), (ax_ - nx, ay_ - ny)], fc=fc, ec=ec, lw=0.4))
        pa.plot([a for a, _ in pts], [b for _, b in pts], color=ec, lw=0.8, ls="--" if fc != "none" else "-")
    for c in comps:
        if c["type"] == "canal":
            B = float(c["b"]) + 2 * float(c.get("m", 1.5)) * (float(c["y"]) + float(c["fb"]))
            band(c["coords"], max(B, span / 250), "#38bdf880", "#0369a1")
        elif c["type"] == "road":
            band(c["coords"], max(float(c.get("width", 6)) + 2 * float(c.get("shoulder", 0.5)), span / 300), "#9ca3af90", "#374151")
        else:
            pts = [P(p) for p in c["coords"]]; pa.plot([a for a, _ in pts], [b for _, b in pts], color="#1d4ed8", lw=1.8)
    if des:
        for k, dr in enumerate(des["drops"]):
            dx, dy = P(dr["ll"])
            pa.plot([dx], [dy], marker="v", ms=7, color="#dc2626", mec="white", mew=0.6)
            if len(des["drops"]) <= 25:
                pa.text(dx, dy + span * 0.012, f"S{k + 1} {N(dr['h'], 1)} m", fontsize=6.5, color="#dc2626", ha="center")
        a0 = P(canal["coords"][0]); pa.text(a0[0], a0[1] - span * 0.02, "▶ " + S(L["water"]), fontsize=7, color="#0369a1")
    pa.set_xlim(x0, x1); pa.set_ylim(y0, y1); pa.axis("off")
    # barra di scala e nord
    nice = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000]
    sb = min(nice, key=lambda v: abs(v - (x1 - x0) / 5))
    for i in range(4):
        pa.add_patch(Rectangle((x0 + pad * 0.3 + i * sb / 4, y0 + pad * 0.25), sb / 4, (y1 - y0) / 140, fc=NAVY if i % 2 == 0 else "white", ec=NAVY, lw=0.5))
    pa.text(x0 + pad * 0.3, y0 + pad * 0.12, "0", fontsize=7, ha="center"); pa.text(x0 + pad * 0.3 + sb, y0 + pad * 0.12, f"{sb} m", fontsize=7, ha="center")
    pa.annotate("N", xy=(x1 - pad * 0.3, y1 - pad * 0.2), xytext=(x1 - pad * 0.3, y1 - pad * 0.2 - (y1 - y0) * 0.06), ha="center", fontsize=9,
                fontweight="bold", color=NAVY, arrowprops=dict(arrowstyle="-|>", color=NAVY, lw=1))
    fig.text(0.035, 0.885, S(L["plan"]), fontsize=8.5, color=BLUE, fontweight="bold", family=famH)
    # scala nominale della pianta sull'A3 (0,52 × 420 mm)
    scale = (x1 - x0) / (0.52 * 0.420)
    sc_nom = min([500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000], key=lambda v: abs(v - scale))

    # ---- sezione tipo
    sa = fig.add_axes([0.60, 0.56, 0.37, 0.30]); sa.set_aspect("equal")

    def dim(ax, p0, p1, txt, o=(0, 0), rot=0):
        ax.annotate("", xy=p1, xytext=p0, arrowprops=dict(arrowstyle="<->", color=NAVY, lw=0.6))
        ax.text((p0[0] + p1[0]) / 2 + o[0], (p0[1] + p1[1]) / 2 + o[1], txt, ha="center", va="center", fontsize=7.5, color=NAVY,
                rotation=rot, bbox=dict(fc="white", ec="none", pad=0.4))
    xmin, xmax, ymin, ymax = 0.0, 0.0, -0.5, 1.0
    if canal:
        b, y, fb, m = float(canal["b"]), float(canal["y"]), float(canal["fb"]), float(canal.get("m", 1.5))
        H = y + fb; B = b + 2 * m * H
        sa.add_patch(Polygon([(-B / 2 - 3, 0), (-B / 2, 0), (-b / 2, -H), (b / 2, -H), (B / 2, 0), (B / 2 + 3, 0), (B / 2 + 3, -H - 0.8), (-B / 2 - 3, -H - 0.8)],
                             fc="#e9dcc0", ec="none"))
        bw = b + 2 * m * y
        sa.add_patch(Polygon([(-bw / 2, -fb), (-b / 2, -H), (b / 2, -H), (bw / 2, -fb)], fc=WATER, ec="none", alpha=0.85))
        sa.plot([-B / 2 - 3, -B / 2, -b / 2, b / 2, B / 2, B / 2 + 3], [0, 0, -H, -H, 0, 0], color=BROWN, lw=1.4)
        dim(sa, (-b / 2, -H - 0.35), (b / 2, -H - 0.35), f"{N(b, 2)} m", (0, -0.25))
        dim(sa, (-B / 2, 0.45), (B / 2, 0.45), f"{N(B, 2)} m", (0, 0.25))
        dim(sa, (B / 2 + 0.6, -H), (B / 2 + 0.6, -fb), f"{N(y, 2)}", (0.55, 0), 90)
        dim(sa, (B / 2 + 0.6, -fb), (B / 2 + 0.6, 0), f"{N(fb, 2)}", (0.55, 0), 90)
        sa.text(-(b / 2 + B / 2) / 2 - 0.35, -H / 2, f"1:{N(m, 1)}", fontsize=7.5, color=NAVY, rotation=-math.degrees(math.atan(1 / m)), ha="right")
        sa.text(0, -fb + 0.12, S(L["water"]), fontsize=7, color="#0369a1", ha="center", va="bottom")
        xmin, xmax, ymin = -B / 2 - 3.5, B / 2 + 3.5, -H - 1.2
    if road:
        w, sh = float(road.get("width", 6)), float(road.get("shoulder", 0.5))
        lay, fill = float(road.get("layer_cm", 30)) / 100, float(road.get("fill_m", 0.3))
        off = float(road.get("offset", 10)) if canal else 0.0
        side = 1 if canal else 0
        cx = side * off
        tot = w + 2 * sh; top = fill
        sa.add_patch(Polygon([(cx - tot / 2 - 1.5 * top, 0), (cx - tot / 2, top), (cx + tot / 2, top), (cx + tot / 2 + 1.5 * top, 0)], fc="#d6c7a1", ec=BROWN, lw=0.8))
        sa.add_patch(Polygon([(cx - w / 2, top - lay), (cx + w / 2, top - lay), (cx + w / 2, top - 0.025 * w / 2), (cx, top), (cx - w / 2, top - 0.025 * w / 2)],
                             fc="#9ca3af", ec=ROAD, lw=0.8, hatch="..."))
        dim(sa, (cx - w / 2, top + 0.45), (cx + w / 2, top + 0.45), f"{N(w, 1)} m", (0, 0.25))
        dim(sa, (cx + tot / 2 + 1.5 * top + 0.4, 0), (cx + tot / 2 + 1.5 * top + 0.4, top), f"{N(fill, 2)}", (0.5, 0), 90)
        sa.text(cx, top - lay - 0.15, f"{N(lay * 100, 0)} cm", fontsize=7, color=MUT, ha="center", va="top")
        sa.plot([cx - tot / 2 - 4, cx + tot / 2 + 4], [0, 0], color=BROWN, lw=1.0)
        if canal:
            dim(sa, (0, ymax + 0.9), (cx, ymax + 0.9), f"{N(off, 1)} m", (0, 0.25))
        xmin, xmax = min(xmin, cx - tot / 2 - 4), max(xmax, cx + tot / 2 + 4)
        ymax = max(ymax, top + 1.4)
    if pipe and not canal and not road:
        dn = float(pipe.get("dn") or 250) / 1000; cov = float(pipe.get("cover", 1.0)); tw = dn + 0.6
        sa.add_patch(Rectangle((-tw / 2, -(cov + dn + 0.1)), tw, cov + dn + 0.1, fc="#e9dcc0", ec=BROWN, lw=1))
        sa.add_patch(Circle((0, -(cov + dn / 2)), dn / 2, fc="#1d4ed8", ec=NAVY))
        sa.plot([-tw * 2, tw * 2], [0, 0], color=BROWN, lw=1.2)
        dim(sa, (tw / 2 + 0.2, -cov), (tw / 2 + 0.2, 0), f"{N(cov, 1)} m", (0.25, 0), 90)
        dim(sa, (-tw / 2, -(cov + dn + 0.25)), (tw / 2, -(cov + dn + 0.25)), f"{N(tw, 2)} m", (0, -0.12))
        xmin, xmax, ymin, ymax = -tw * 2, tw * 2, -(cov + dn + 0.6), 0.6
    sa.set_xlim(xmin, xmax); sa.set_ylim(ymin, ymax + 0.6); sa.axis("off")
    fig.text(0.60, 0.885, S(L["section"]), fontsize=8.5, color=BLUE, fontweight="bold", family=famH)

    # ---- profilo longitudinale
    main = canal or road or pipe
    pr = des["profile"] if des else {"d": main["_prof"]["d"], "z": main["_prof"]["z"]}
    pfa = fig.add_axes([0.06, 0.10, 0.49, 0.20])
    d_ = np.array(pr["d"]); z_ = np.array(pr["z"])
    pfa.fill_between(d_, z_, z_.min() - 2, color="#e9dcc0"); pfa.plot(d_, z_, color=BROWN, lw=1.2, label=S(L["terrain"]))
    if des:
        pfa.plot(d_, pr["bank"], color=MUT, lw=0.8, ls="--", label=S(L["bank"]))
        pfa.plot(d_, pr["wl"], color="#0284c7", lw=1.0, label=S(L["water"]))
        pfa.plot(d_, pr["bed"], color=NAVY, lw=1.3, label=S(L["bed"]))
        for k, dr in enumerate(des["drops"]):
            zz = float(np.interp(dr["d"], d_, pr["bed"]))
            pfa.plot([dr["d"]], [zz], marker="v", color="#dc2626", ms=5)
    elif road and main is road:
        pfa.plot(d_, z_ + float(road.get("fill_m", 0.3)), color=ROAD, lw=1.2, label=S(L["grade"]))
    elif pipe:
        cov = float(pipe.get("cover", 1.0)) + float(pipe.get("dn") or 250) / 1000
        pfa.plot(d_, z_ - cov, color="#1d4ed8", lw=1.2, label=S(L["invert"]))
    lo_ = min(z_.min(), min(pr.get("bed", z_)) if des else z_.min()) - 1
    hi_ = max(z_.max(), max(pr.get("bank", z_)) if des else z_.max()) + 1
    pfa.set_ylim(lo_, hi_); pfa.set_xlim(0, d_[-1])
    pfa.set_xlabel(S(L["km"]), fontsize=7.5, color=MUT); pfa.set_ylabel(S(L["elev"]), fontsize=7.5, color=MUT)
    pfa.tick_params(labelsize=7, colors=MUT); [s_.set_color(BOR) for s_ in pfa.spines.values()]
    pfa.grid(color="#e5e7eb", lw=0.5); pfa.legend(fontsize=7, loc="upper right", frameon=False, ncol=4)
    vex = (d_[-1] / 0.49 / 16.54) / max(0.5, (hi_ - lo_) / 0.20 / 11.69)
    fig.text(0.035, 0.325, S(L["profile"]) + "  ·  " + S(L["vexag"].format(k=N(vex, 0))), fontsize=8.5, color=BLUE, fontweight="bold", family=famH)

    # ---- dati di progetto
    rows = []
    if canal:
        b, y, fb, m = float(canal["b"]), float(canal["y"]), float(canal["fb"]), float(canal.get("m", 1.5))
        rows += [(L["kFlow"], f"{N(canal.get('q', 0), 0)} l/s ({N(float(canal.get('q', 0)) * 3.6, 0)} m³/h)"),
                 (L["kLen"], f"{N(des['length_m'], 0)} m"),
                 (L["kSlope"], f"{N(canal['S'], 2)}‰"), (L["kTerr"], f"{N(des['terrain_permille'], 2)}‰"),
                 (L["kSec"], L["vSec"].format(b=N(b, 2), y=N(y, 2), fb=N(fb, 2), m=N(m, 1), B=N(b + 2 * m * (y + fb), 2))),
                 (L["kVel"], f"{N(canal.get('v', 0), 2)} m/s"),
                 (L["kCut"], L["vCut"].format(v=N(des["cut_m3"], 0), h=N(des["cut_max_m"], 1))),
                 (L["kFill"], f"{N(des['fill_m3'], 0)} m³"),
                 (L["kDrops"], L["drops"].format(n=des["n_drops"], h=N(des["drop_total_m"], 1), m=N(float(canal.get("drop_max", 1.0)), 1)) if des["n_drops"] else L["noDrops"])]
    if road:
        rows.append((L["kRoad"], L["vRoad"].format(w=N(road.get("width", 6), 1), s=N(road.get("shoulder", 0.5), 1), l=N(road.get("layer_cm", 30), 0), f=N(road.get("fill_m", 0.3), 2))))
        if not canal:
            rows.append((L["kLen"], f"{N(road['_prof']['d'][-1], 0)} m"))
    if pipe:
        rows.append((L["kPipe"], L["vPipe"].format(dn=int(pipe.get("dn") or 0), c=N(pipe.get("cover", 1.0), 1), t=N(float(pipe.get("dn") or 250) / 1000 + 0.6, 2))))
        rows.append((L["kFlow"] + " · " + L["pipe"], f"{N(pipe.get('q', 0), 0)} l/s · {N(pipe['_prof']['d'][-1], 0)} m"))
    fig.text(0.60, 0.515, S(L["data"]), fontsize=8.5, color=BLUE, fontweight="bold", family=famH)
    import textwrap
    yy = 0.488
    for a, b_ in rows:
        lines = textwrap.wrap(str(b_), 62) or [""]
        fig.text(0.60, yy, S(a), fontsize=8.5, color=MUT)
        for j, ln in enumerate(lines):
            fig.text(0.735, yy - j * 0.017, S(ln), fontsize=8.5, color=NAVY)
        yy -= 0.024 + 0.017 * (len(lines) - 1)

    # ---- cartiglio
    cart = [(L["proj"], doc.get("project", "")), (L["client"], doc.get("client", "")), (L["field"], doc.get("field", "")),
            (L["scale"], f"1:{sc_nom:,}".replace(",", ".")), (L["date"], doc.get("date") or date.today().strftime("%d/%m/%Y")),
            (L["sheet"], doc.get("sheet", "C-01"))]
    cx0, cy0, cw, ch = 0.60, 0.06, 0.37, 0.12
    fig.patches.append(Rectangle((cx0, cy0), cw, ch, transform=fig.transFigure, fc="white", ec=NAVY, lw=0.8))
    for i, (k, v) in enumerate(cart):
        col, row = i % 3, i // 3
        xx = cx0 + 0.008 + col * cw / 3; yy = cy0 + ch - 0.028 - row * 0.05
        fig.text(xx, yy, S(k).upper(), fontsize=6.5, color=MUT); fig.text(xx, yy - 0.02, S(str(v))[:38], fontsize=9, color=NAVY, fontweight="bold")
    fig.text(0.035, 0.03, S(L["foot"]), fontsize=7.5, color=MUT)
    buf = io.BytesIO(); fig.savefig(buf, format="pdf"); plt.close(fig)
    return buf.getvalue()
