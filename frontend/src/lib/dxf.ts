// DXF R12 (AC1009, ASCII) in coordinate UTM (metri, fuso del centro del progetto):
// si apre in AutoCAD, BricsCAD, QGIS e Ceres. Un layer per ogni tipo di oggetto.

export type DxfLayer = { name: string; color: number };          // colore ACI (1 rosso, 3 verde, 5 blu, 7 bianco/nero…)
type Ent =
  | { k: "poly"; layer: string; pts: number[][]; closed?: boolean }
  | { k: "circle"; layer: string; c: number[]; r: number }
  | { k: "arc"; layer: string; c: number[]; r: number; a0: number; a1: number }
  | { k: "text"; layer: string; p: number[]; h: number; s: string };

// UTM (WGS84) diretto: Karney/Krüger, sufficiente al millimetro nel fuso
export function utmZone(lng: number) { return Math.floor((lng + 180) / 6) + 1; }
export function toUtm(lat: number, lng: number, zone: number): [number, number] {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const phi = (lat * Math.PI) / 180, lam = (lng * Math.PI) / 180, lam0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2), T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * (lam - lam0);
  const M = a * ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256) * phi - ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * e2 * e2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const x = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  let y = k0 * (M + N * Math.tan(phi) * (A * A / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) y += 10000000;
  return [x, y];
}

export class Dxf {
  ents: Ent[] = [];
  constructor(public layers: DxfLayer[]) {}
  poly(layer: string, pts: number[][], closed = false) { if (pts.length >= 2) this.ents.push({ k: "poly", layer, pts, closed }); }
  circle(layer: string, c: number[], r: number) { if (r > 0) this.ents.push({ k: "circle", layer, c, r }); }
  arc(layer: string, c: number[], r: number, a0: number, a1: number) { if (r > 0) this.ents.push({ k: "arc", layer, c, r, a0, a1 }); }
  text(layer: string, p: number[], h: number, s: string) { this.ents.push({ k: "text", layer, p, h, s }); }
  toString() {
    const o: string[] = [], g = (c: number, v: string | number) => { o.push(String(c), typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : v); };
    const xs: number[] = [], ys: number[] = [];
    for (const e of this.ents) { const ps = e.k === "poly" ? e.pts : e.k === "text" ? [e.p] : [e.c]; for (const p of ps) { xs.push(p[0]); ys.push(p[1]); } }
    g(0, "SECTION"); g(2, "HEADER"); g(9, "$ACADVER"); g(1, "AC1009"); g(9, "$INSUNITS"); g(70, 6);
    if (xs.length) { g(9, "$EXTMIN"); g(10, Math.min(...xs)); g(20, Math.min(...ys)); g(9, "$EXTMAX"); g(10, Math.max(...xs)); g(20, Math.max(...ys)); }
    g(0, "ENDSEC");
    g(0, "SECTION"); g(2, "TABLES");
    g(0, "TABLE"); g(2, "LTYPE"); g(70, 1); g(0, "LTYPE"); g(2, "CONTINUOUS"); g(70, 0); g(3, "Solid line"); g(72, 65); g(73, 0); g(40, 0); g(0, "ENDTAB");
    g(0, "TABLE"); g(2, "LAYER"); g(70, this.layers.length);
    for (const l of this.layers) { g(0, "LAYER"); g(2, l.name); g(70, 0); g(62, l.color); g(6, "CONTINUOUS"); }
    g(0, "ENDTAB"); g(0, "ENDSEC");
    g(0, "SECTION"); g(2, "ENTITIES");
    for (const e of this.ents) {
      if (e.k === "poly") {
        g(0, "POLYLINE"); g(8, e.layer); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, e.closed ? 1 : 0);
        for (const p of e.pts) { g(0, "VERTEX"); g(8, e.layer); g(10, p[0]); g(20, p[1]); g(30, 0); }
        g(0, "SEQEND"); g(8, e.layer);
      } else if (e.k === "circle") { g(0, "CIRCLE"); g(8, e.layer); g(10, e.c[0]); g(20, e.c[1]); g(30, 0); g(40, e.r); }
      else if (e.k === "arc") { g(0, "ARC"); g(8, e.layer); g(10, e.c[0]); g(20, e.c[1]); g(30, 0); g(40, e.r); g(50, e.a0); g(51, e.a1); }
      else { g(0, "TEXT"); g(8, e.layer); g(10, e.p[0]); g(20, e.p[1]); g(30, 0); g(40, e.h); g(1, e.s.replace(/[\r\n]+/g, " ")); }
    }
    g(0, "ENDSEC"); g(0, "EOF");
    return o.join("\r\n") + "\r\n";
  }
}
