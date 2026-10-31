// Disposizione di lineari, rotoloni e goccia su un poligono di campo.
// Tutto in metri su un piano locale ruotato: l'asse y è la direzione di
// marcia (lineari), di srotolamento (rotoloni) o delle ali gocciolanti.

export type LL = [number, number];                       // [lng, lat]
type P = [number, number];                               // metri, sistema ruotato

export type Frame = { toRot: (p: LL) => P; fromRot: (p: P) => LL; az: number; poly: P[] };

const R = 6371008.8;
// Piano locale (equirettangolare attorno al baricentro) e rotazione.
export function frameOf(ring: LL[], azDeg: number | null): Frame {
  const n = ring.length - (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? 1 : 0);
  const pts = ring.slice(0, n);
  const lat0 = pts.reduce((a, p) => a + p[1], 0) / pts.length, lng0 = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const kx = (Math.PI / 180) * R * Math.cos((lat0 * Math.PI) / 180), ky = (Math.PI / 180) * R;
  const loc = (p: LL): P => [(p[0] - lng0) * kx, (p[1] - lat0) * ky];
  const unloc = (p: P): LL => [p[0] / kx + lng0, p[1] / ky + lat0];
  const local = pts.map(loc);
  // direzione dell'asse y: azimut dato, altrimenti lato lungo del rettangolo minimo
  const az = azDeg != null ? azDeg : minRectAz(local);
  const a = (az * Math.PI) / 180;               // azimut da nord in senso orario
  const ux: P = [Math.cos(a), -Math.sin(a)];     // asse x (perpendicolare)
  const uy: P = [Math.sin(a), Math.cos(a)];      // asse y = direzione dell'azimut
  const toRotL = (q: P): P => [q[0] * ux[0] + q[1] * ux[1], q[0] * uy[0] + q[1] * uy[1]];
  const fromRotL = (q: P): P => [q[0] * ux[0] + q[1] * uy[0], q[0] * ux[1] + q[1] * uy[1]];
  return { toRot: (p) => toRotL(loc(p)), fromRot: (q) => unloc(fromRotL(q)), az, poly: local.map(toRotL) };
}

// Azimut del lato lungo del rettangolo di area minima (sui lati dell'inviluppo convesso).
function minRectAz(pts: P[]): number {
  const h = hull(pts);
  let best = { area: Infinity, az: 0 };
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(ang), s = Math.sin(ang);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of h) { const x = p[0] * c + p[1] * s, y = -p[0] * s + p[1] * c; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const area = (x1 - x0) * (y1 - y0);
    if (area < best.area) {
      // lato lungo: se il rettangolo è più lungo lungo l'asse del lato, quello; altrimenti +90°
      const along = x1 - x0 >= y1 - y0 ? ang : ang + Math.PI / 2;
      const azv = (90 - (along * 180) / Math.PI + 360) % 180;   // da nord, senso orario
      best = { area, az: azv };
    }
  }
  return best.az;
}
function hull(p: P[]): P[] {
  const s = [...p].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: P[] = [], up: P[] = [];
  for (const q of s) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of s.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// Intervalli di y interni al poligono sulla verticale x.
function scan(poly: P[], x: number): [number, number][] {
  const ys: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a[0] <= x && b[0] > x) || (b[0] <= x && a[0] > x)) ys.push(a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
  }
  ys.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ys.length; i += 2) out.push([ys[i], ys[i + 1]]);
  return out;
}
// Intervallo comune più lungo su più verticali (striscia interamente dentro il campo).
function commonInterval(poly: P[], x0: number, x1: number, n = 24): [number, number] | null {
  let cur: [number, number][] | null = null;
  for (let k = 0; k <= n; k++) {
    const x = x0 + ((x1 - x0) * k) / n;
    const iv = scan(poly, Math.min(x1 - 1e-6, Math.max(x0 + 1e-6, x)));
    if (!cur) { cur = iv; continue; }
    const nx: [number, number][] = [];
    for (const a of cur) for (const b of iv) { const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]); if (hi > lo) nx.push([lo, hi]); }
    cur = nx;
    if (!cur.length) return null;
  }
  if (!cur || !cur.length) return null;
  return cur.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
}
export function areaM2(poly: P[]): number {
  let s = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}
// Ritaglio del poligono su una striscia x0 ≤ x ≤ x1 (Sutherland–Hodgman su due semipiani).
function clipX(poly: P[], x0: number, x1: number): P[] {
  const half = (pts: P[], keep: (p: P) => boolean, xc: number): P[] => {
    const out: P[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], ia = keep(a), ib = keep(b);
      if (ia) out.push(a);
      if (ia !== ib) { const u = (xc - a[0]) / (b[0] - a[0]); out.push([xc, a[1] + u * (b[1] - a[1])]); }
    }
    return out;
  };
  return half(half(poly, (p) => p[0] >= x0, x0), (p) => p[0] <= x1, x1);
}
const rect = (f: Frame, x0: number, x1: number, y0: number, y1: number): LL[] =>
  [f.fromRot([x0, y0]), f.fromRot([x1, y0]), f.fromRot([x1, y1]), f.fromRot([x0, y1]), f.fromRot([x0, y0])];

// ---- LINEARI ---------------------------------------------------------------
export type Linear = { i: number; L: number; travel: number; areaHa: number; ring: LL[]; start: LL; az: number; feed: LL[] };
export function linearLayout(ring: LL[], o: { maxLen: number; minTravel: number; az: number | null }): { machines: Linear[]; az: number; fieldHa: number } {
  const f = frameOf(ring, o.az);
  const xs = f.poly.map((p) => p[0]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs), W = xmax - xmin;
  const n = Math.max(1, Math.ceil(W / Math.max(50, o.maxLen)));
  const Lm = W / n;
  const out: Linear[] = [];
  for (let i = 0; i < n; i++) {
    const x0 = xmin + i * Lm, x1 = x0 + Lm;
    // si stringe un poco dai bordi del campo (1 m) per stare dentro
    const iv = commonInterval(f.poly, x0 + 1, x1 - 1);
    if (!iv || iv[1] - iv[0] < o.minTravel) continue;
    const travel = iv[1] - iv[0];
    out.push({ i: out.length + 1, L: Lm, travel, areaHa: (Lm * travel) / 10000, ring: rect(f, x0, x1, iv[0], iv[1]),
      start: f.fromRot([(x0 + x1) / 2, iv[0]]), az: f.az, feed: [f.fromRot([x0, iv[0]]), f.fromRot([x0, iv[1]])] });
  }
  return { machines: out, az: f.az, fieldHa: areaM2(f.poly) / 10000 };
}

// ---- ROTOLONI --------------------------------------------------------------
export type ReelRun = { lane: number; y0: number; y1: number; len: number; areaHa: number; ring: LL[]; axis: LL[] };
export function reelLayout(ring: LL[], o: { spacing: number; hoseLen: number; throw: number; az: number | null }): { runs: ReelRun[]; lanes: number; az: number; fieldHa: number; coveredHa: number } {
  const f = frameOf(ring, o.az);
  const xs = f.poly.map((p) => p[0]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const S = Math.max(10, o.spacing);
  const lanes = Math.max(1, Math.round((xmax - xmin) / S));
  const s2 = (xmax - xmin) / lanes;
  const runs: ReelRun[] = [];
  const maxRun = Math.max(20, o.hoseLen + o.throw);        // una tirata: tubo + gittata a fine corsa
  for (let k = 0; k < lanes; k++) {
    const x = xmin + (k + 0.5) * s2;
    for (const iv of scan(f.poly, x)) {
      const L = iv[1] - iv[0]; if (L < 30) continue;
      const nRun = Math.max(1, Math.ceil(L / maxRun)), lr = L / nRun;
      for (let j = 0; j < nRun; j++) {
        const y0 = iv[0] + j * lr, y1 = y0 + lr;
        runs.push({ lane: k + 1, y0, y1, len: lr, areaHa: (lr * s2) / 10000,
          ring: rect(f, x - s2 / 2, x + s2 / 2, y0, y1), axis: [f.fromRot([x, y0]), f.fromRot([x, y1])] });
      }
    }
  }
  return { runs, lanes, az: f.az, fieldHa: areaM2(f.poly) / 10000, coveredHa: runs.reduce((a, r) => a + r.areaHa, 0) };
}

// ---- GOCCIA ----------------------------------------------------------------
export type DripSector = { i: number; areaHa: number; ring: LL[] };
export function dripLayout(ring: LL[], o: { latMax: number; nSectors: number; az: number | null }): { fieldHa: number; sectors: DripSector[]; submains: LL[][]; subLen: number; az: number } {
  const f = frameOf(ring, o.az);
  const fieldM2 = areaM2(f.poly);
  // Settori: strisce di pari superficie lungo x
  const xs = f.poly.map((p) => p[0]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const n = Math.max(1, Math.round(o.nSectors));
  const cuts = [xmin];
  for (let k = 1; k < n; k++) {
    const target = (fieldM2 * k) / n;
    let lo = cuts[cuts.length - 1], hi = xmax;
    for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (areaM2(clipX(f.poly, xmin, mid)) < target) lo = mid; else hi = mid; }
    cuts.push((lo + hi) / 2);
  }
  cuts.push(xmax);
  const sectors: DripSector[] = [];
  for (let k = 0; k < n; k++) {
    const pc = clipX(f.poly, cuts[k], cuts[k + 1]);
    if (pc.length >= 3) sectors.push({ i: k + 1, areaHa: areaM2(pc) / 10000, ring: [...pc, pc[0]].map(f.fromRot) });
  }
  // Condotte secondarie perpendicolari alle ali (lungo x), a passo 2 × ala
  // massima: ogni secondaria alimenta le ali a monte e a valle.
  const ys = f.poly.map((p) => p[1]);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const step = Math.max(20, 2 * o.latMax);
  const submains: LL[][] = []; let subLen = 0;
  for (let y = ymin + step / 2; y < ymax; y += step) {
    // intervalli interni lungo x alla quota y: si scambiano gli assi
    const swapped = f.poly.map((p) => [p[1], p[0]] as P);
    for (const iv of scan(swapped, y)) {
      submains.push([f.fromRot([iv[0], y]), f.fromRot([iv[1], y])]); subLen += iv[1] - iv[0];
    }
  }
  return { fieldHa: fieldM2 / 10000, sectors, submains, subLen, az: f.az };
}
