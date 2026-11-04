// Calcoli idraulici portati da Nereus (pagine 03 Canali e 18 Pluviometria) e
// verifiche mensili di Argus Total: sezione dei canali a moto uniforme (Manning),
// scavi e rilevati lungo il profilo, uniformità di distribuzione dei pivot
// (sprinkler chart generato, CU Heermann-Hein, DU, intensità di picco),
// bilancio mese per mese fiume/fabbisogno e produzione FV dei pivot solari.

// ---------------------------------------------------------------- CANALI (Nereus pag. 03)
export type LiningId = "earth" | "grass" | "stone" | "liner" | "concr";
export const LININGS: { id: LiningId; label: string; n: number; vmax: number; m: number }[] = [
  { id: "earth", label: "Terra naturale", n: 0.025, vmax: 0.8, m: 1.5 },
  { id: "grass", label: "Terra inerbita", n: 0.03, vmax: 1.5, m: 1.5 },
  { id: "stone", label: "Pietrame", n: 0.035, vmax: 2, m: 1 },
  { id: "liner", label: "Telo impermeabile", n: 0.015, vmax: 2, m: 2 },
  { id: "concr", label: "Calcestruzzo", n: 0.014, vmax: 3, m: 1 },
];
export const lining = (id: string) => LININGS.find((l) => l.id === id) ?? LININGS[0];
const area = (b: number, y: number, m: number) => (b + m * y) * y;
const wetP = (b: number, y: number, m: number) => b + 2 * y * Math.sqrt(1 + m * m);
/** Portata (m³/s) di Manning per la sezione trapezia. */
export function manningQ(b: number, y: number, m: number, n: number, S: number) {
  const A = area(b, y, m), R = A / wetP(b, y, m);
  return (1 / n) * A * Math.pow(R, 2 / 3) * Math.sqrt(S);
}
/** Tirante di moto uniforme per la portata Q (m³/s), per bisezione come in Nereus. */
export function normalDepth(Q: number, b: number, m: number, n: number, S: number) {
  if (!(Q > 0 && S > 0 && n > 0)) return 0;
  let lo = 1e-4, hi = 20;
  for (let k = 0; k < 120; k++) { const mid = (lo + hi) / 2; if (manningQ(b, mid, m, n, S) < Q) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
export type CanalSection = { Q: number; S: number; lin: LiningId; n: number; m: number; b: number; y: number; fb: number; H: number;
  A: number; v: number; topW: number; topWater: number; fast: boolean; slow: boolean; widened: boolean };
/**
 * Sezione di progetto: parte dalla sezione idraulicamente più efficiente (b = 2y(√(1+m²) − m)),
 * arrotonda la base ai 10 cm (minimo 30 cm) e la allarga finché la velocità resta entro il limite
 * del rivestimento. Franco = max(fb, 20% del tirante).
 */
export function designCanal(qLs: number, slopePermille: number, linId: string, opt: { m?: number; fb?: number; b?: number } = {}): CanalSection | null {
  const L = lining(linId), m = opt.m ?? L.m, S = Math.max(1e-5, slopePermille / 1000), Q = qLs / 1000;
  if (!(Q > 0)) return null;
  let b: number;
  if (opt.b && opt.b > 0) b = opt.b;
  else {
    const k = 2 * (Math.sqrt(1 + m * m) - m);           // b/y della sezione più efficiente
    let lo = 0.01, hi = 30;
    for (let i = 0; i < 80; i++) { const y = (lo + hi) / 2; if (manningQ(k * y, y, m, L.n, S) < Q) lo = y; else hi = y; }
    b = Math.max(0.3, Math.ceil(k * hi * 10) / 10);
  }
  let y = normalDepth(Q, b, m, L.n, S), widened = false;
  for (let i = 0; i < 200 && !(opt.b && opt.b > 0); i++) {
    if (Q / area(b, y, m) <= L.vmax) break;
    b = Math.round((b + 0.1) * 10) / 10; y = normalDepth(Q, b, m, L.n, S); widened = true;
  }
  const A = area(b, y, m), v = Q / A, fb = Math.max(opt.fb ?? 0.3, 0.2 * y), H = y + fb;
  return { Q, S, lin: L.id, n: L.n, m, b, y, fb, H, A, v, topW: b + 2 * m * H, topWater: b + 2 * m * y,
    fast: v > L.vmax + 1e-9, slow: v < 0.3, widened };
}
/**
 * Scavi e rilevati lungo il profilo del terreno [[progressiva m, quota m], …]: fondo a pendenza
 * costante S partendo da (terreno all'inizio − H). Sterro = sezione sotto il terreno; dove il
 * terreno scende sotto il ciglio servono argini (coronamento 1 m, scarpe come il canale).
 */
export function canalEarthworks(profile: number[][], sec: CanalSection, crest = 1.0) {
  if (!profile || profile.length < 2) return null;
  const z0 = profile[0][1], bed0 = z0 - sec.H, { b, m, H, S } = sec;
  let cut = 0, fill = 0, cutMax = 0, fillMax = 0;
  const at = (k: number) => {
    const [x, zg] = profile[k], bed = bed0 - S * x, top = bed + H;
    const d = Math.max(0, Math.min(H, zg - bed));                  // parte in sterro della sezione bagnata
    let aCut = (b + m * d) * d;
    if (zg > top) aCut += (zg - top) * (b + 2 * m * H + m * (zg - top));   // sopra il ciglio: scavo più largo
    const h = Math.max(0, top - zg);                                // altezza degli argini
    const aFill = 2 * h * (crest + m * h);
    cutMax = Math.max(cutMax, zg - bed); fillMax = Math.max(fillMax, h);
    return { aCut, aFill };
  };
  let prev = at(0);
  for (let k = 1; k < profile.length; k++) {
    const cur = at(k), dx = profile[k][0] - profile[k - 1][0];
    cut += ((prev.aCut + cur.aCut) / 2) * dx; fill += ((prev.aFill + cur.aFill) / 2) * dx; prev = cur;
  }
  const len = profile[profile.length - 1][0];
  const linedM2 = (b + 2 * H * Math.sqrt(1 + m * m)) * len;          // superficie da rivestire (fondo + sponde)
  return { len, cut, fill, cutMax, fillMax, linedM2, bedDrop: S * len };
}

// ---------------------------------------------------------------- UNIFORMITÀ PIVOT (Nereus pag. 18)
const GPM_LH = 227.12, PSI_BAR = 14.5038;
const NOZ = {
  komet: { den: 128, min: 8, max: 52, q: (nz: number, p: number) => 0.00197882 * Math.pow(nz, 1.9681) * Math.sqrt(p * PSI_BAR) * GPM_LH },
  nelson: { den: 128, min: 14, max: 50, q: (nz: number, p: number) => { const d = nz / 128; return 28.34 * d * d * Math.sqrt(p * PSI_BAR) * GPM_LH; } },
  senninger: { den: 64, min: 7, max: 24, q: (nz: number, p: number) => { const d = nz / 64; return 28.94 * d * d * Math.sqrt(p * PSI_BAR) * GPM_LH; } },
};
type Brand = keyof typeof NOZ;
const nozFor = (brand: Brand, qLh: number, p: number) => {
  const l = qLh / GPM_LH, r = Math.sqrt(p * PSI_BAR);
  if (!(l > 0 && r > 0)) return 0;
  return brand === "komet" ? Math.pow(l / (0.00197882 * r), 1 / 1.9681) : Math.sqrt(l / ((brand === "nelson" ? 28.34 : 28.94) * r)) * NOZ[brand].den;
};
const KPT_NZ = [10, 16, 23, 29, 34, 40, 45, 52], KPT_P = [0.41, 0.69, 1.03, 1.38];
const KPT_BLACK = { H: [0.9, 1.8, 2.7], T: [
  [[8.2, 10.2, 11.8, 12.8], [9.5, 11.5, 13.2, 14.1], [10.6, 12.6, 14.3, 15.3], [11.2, 13.2, 14.9, 15.8], [11.5, 13.4, 15.1, 16.1], [11.4, 13.4, 15.1, 16], [11.1, 13.1, 14.8, 15.8], [10.3, 12.3, 14, 15]],
  [[10, 12, 13.6, 14.6], [11.3, 13.3, 15, 15.9], [12.4, 14.4, 16.1, 17.1], [13, 15, 16.7, 17.6], [13.3, 15.2, 16.9, 17.9], [13.2, 15.2, 16.9, 17.8], [12.9, 14.9, 16.6, 17.6], [12.1, 14.1, 15.8, 16.8]],
  [[11.3, 13.2, 14.9, 15.9], [12.6, 14.6, 16.3, 17.2], [13.7, 15.7, 17.4, 18.3], [14.3, 16.3, 18, 18.9], [14.5, 16.5, 18.2, 19.2], [14.5, 16.5, 18.2, 19.1], [14.2, 16.2, 17.9, 18.8], [13.4, 15.4, 17.1, 18]]] };
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const fracIdx = (x: number, xs: number[]) => { const t = clamp(x, xs[0], xs[xs.length - 1]); for (let i = 0; i < xs.length - 1; i++) if (t <= xs[i + 1]) return i + (t - xs[i]) / (xs[i + 1] - xs[i]); return xs.length - 1; };
function kptRadius(nz: number, p: number, h: number) {
  const r = fracIdx(nz, KPT_NZ), s = fracIdx(p, KPT_P), o = fracIdx(h, KPT_BLACK.H);
  const bil = (M: number[][]) => { const z = Math.floor(r), w = Math.min(z + 1, 7), y = r - z, q = Math.floor(s), u = Math.min(q + 1, 3), v = s - q;
    return M[z][q] * (1 - y) * (1 - v) + M[w][q] * y * (1 - v) + M[z][u] * (1 - y) * v + M[w][u] * y * v; };
  const c = Math.floor(o), hh = Math.min(c + 1, 2), f = o - c;
  return (bil(KPT_BLACK.T[c]) * (1 - f) + bil(KPT_BLACK.T[hh]) * f) / 2;
}
// Kincaid 2005: W = a·(H^c·M)^b, M = q[l/s]·√P[kPa]
const KIN: Record<string, [number, number, number]> = { R3000_Orange: [14.7, 0.12, 1], iWob_Std: [12.2, 0.12, 0.8] };
const kinRadius = (dev: string, qLh: number, p: number, h: number) => { const k = KIN[dev] ?? KIN.R3000_Orange; return 0.5 * k[0] * Math.pow(Math.pow(h, k[2]) * (qLh / 3600) * Math.sqrt(p * 100), k[1]); };
export const SPRINKLERS = [
  { id: "kpt_black", brand: "komet" as Brand, label: "Komet KPT Black", kind: "kpt", p: 1.0 },
  { id: "r3000_or", brand: "nelson" as Brand, label: "Nelson R3000 Orange", kind: "kin", dev: "R3000_Orange", p: 1.38 },
  { id: "iwob_std", brand: "senninger" as Brand, label: "Senninger i-Wob", kind: "kin", dev: "iWob_Std", p: 1.03 },
];
const hw = (qM3h: number, dMm: number, L: number, C: number) => {          // Hazen-Williams, bar
  if (!(qM3h > 0 && dMm > 0 && L > 0)) return 0;
  return (10.67 * L * Math.pow(qM3h / 3600, 1.852)) / (Math.pow(C, 1.852) * Math.pow(dMm / 1000, 4.87)) / 10.197;
};
export type CuResult = { n: number; CU: number; DU: number; CV: number; peak: number; doseMm: number; clamped: number; minMargin: number;
  spk: { r: number; nz: number; q: number; R: number }[]; model: string };
/**
 * Sprinkler chart generato e uniformità, come «Genera» della pagina 18 di Nereus: uscite a passo
 * costante lungo le campate (dalla prima uscita in poi), portata di ogni uscita proporzionale a
 * raggio × larghezza di competenza, ugello commerciale arrotondato (il resto è l'errore che fa il
 * CU), raggio bagnato dalle tabelle del costruttore, profilo ellittico, griglia 0,25 m.
 */
export function pivotUniformity(o: { spans: { len: number; deMm: number }[]; overhang?: number; qSpkM3h: number; pPivotBar: number;
  model?: string; spacing?: number; first?: number; h?: number; steel?: boolean; tRevH?: number }): CuResult | null {
  const mdl = SPRINKLERS.find((s) => s.id === o.model) ?? SPRINKLERS[0], nz0 = NOZ[mdl.brand], p = mdl.p;
  const sp = o.spacing ?? 3, h = o.h ?? 2.7, C = o.steel === false ? 150 : 130, wall = o.steel === false ? 6 : 3;
  const segs = o.spans.map((s) => ({ L: s.len, D: Math.max(10, s.deMm - 2 * wall) }));
  if (o.overhang && o.overhang > 0) segs.push({ L: o.overhang, D: Math.max(10, 141 - 2 * wall) });
  if (!(o.qSpkM3h > 0) || !segs.length) return null;
  const outs: { r: number; D: number; comp: number }[] = [];
  let x0 = 0, v = Math.max(0.1, o.first ?? 7);
  for (const s of segs) { const end = x0 + s.L; if (v < x0) v = x0 + sp; for (; v <= end + 1e-9; v += sp) outs.push({ r: v, D: s.D, comp: 0 }); x0 = end; }
  if (outs.length < 3 || outs.length > 600) return null;
  outs.forEach((u, i) => { const a = i > 0 ? outs[i - 1].r : u.r - sp, b = i < outs.length - 1 ? outs[i + 1].r : u.r + sp; u.comp = (b - a) / 2; });
  const W = outs.reduce((a, u) => a + u.r * u.comp, 0);
  let clamped = 0;
  const spk = outs.map((u) => {
    const qReq = (o.qSpkM3h * 1000 * u.r * u.comp) / W;
    let nz = Math.round(nozFor(mdl.brand, qReq, p));
    if (nz < nz0.min) { nz = nz0.min; clamped++; } else if (nz > nz0.max) { nz = nz0.max; clamped++; }
    const q = nz0.q(nz, p);
    const R = mdl.kind === "kpt" ? kptRadius(nz, p, h) : kinRadius((mdl as { dev?: string }).dev ?? "", q, p, h);
    return { r: u.r, D: u.D, nz, q, R };
  });
  // pressione lungo la macchina (perdite di Hazen-Williams) → margine sul regolatore
  let Qup = spk.reduce((a, s) => a + s.q / 1000, 0), pr = o.pPivotBar, prev = 0, minMargin = Infinity;
  for (const s of spk) { pr -= hw(Qup, s.D, s.r - prev, C); minMargin = Math.min(minMargin, pr - p); Qup -= s.q / 1000; prev = s.r; }
  // simulazione della dose (profilo ellittico) su griglia radiale × marcia
  const dx = 0.25, dy = 0.25, rEnd = Math.max(...spk.map((s) => s.r + s.R)), Rm = Math.max(...spk.map((s) => s.R));
  const nx = Math.max(2, Math.ceil(rEnd / dx)), ny = 2 * Math.ceil(Rm / dy) + 1, T = o.tRevH ?? 24;
  const I = new Float32Array(nx * ny);
  for (const s of spk) {
    const b0 = (3 * s.q) / (2 * Math.PI * s.R * s.R);
    const i0 = Math.max(0, Math.floor((s.r - s.R) / dx) - 1), i1 = Math.min(nx - 1, Math.ceil((s.r + s.R) / dx));
    const j0 = Math.max(0, Math.floor((Rm - s.R) / dy)), j1 = Math.min(ny - 1, Math.ceil((Rm + s.R) / dy));
    for (let i = i0; i <= i1; i++) { const X = (i + 1) * dx - s.r;
      for (let j = j0; j <= j1; j++) { const Y = -Rm + j * dy, rho = Math.sqrt(X * X + Y * Y); if (rho < s.R) I[i * ny + j] += b0 * Math.sqrt(1 - (rho / s.R) ** 2); } }
  }
  const xs: number[] = [], dose: number[] = []; let peak = 0;
  const rHi = spk[spk.length - 1].r;                                // uniformità sulla parte bagnata dalla macchina
  for (let i = 0; i < nx; i++) {
    const x = (i + 1) * dx; let sum = 0, mx = 0;
    for (let j = 0; j < ny; j++) { const w = I[i * ny + j]; sum += w; if (w > mx) mx = w; }
    if (x < (o.first ?? 7) || x > rHi) continue;
    const vt = (2 * Math.PI * x) / T; xs.push(x); dose.push((sum * dy) / vt); peak = Math.max(peak, mx);
  }
  // CU Heermann-Hein, DU low-quarter, CV (pesati sul raggio)
  let sw = 0, swd = 0; xs.forEach((x, k) => { sw += x; swd += x * dose[k]; });
  const Dw = swd / sw; let dev = 0, sq = 0; xs.forEach((x, k) => { dev += x * Math.abs(dose[k] - Dw); sq += x * (dose[k] - Dw) ** 2; });
  const idx = xs.map((_, k) => k).sort((a, b) => dose[a] - dose[b]); let acc = 0, num = 0, den = 0; const tgt = 0.25 * sw;
  for (const k of idx) { const w = Math.min(xs[k], tgt - acc); if (w <= 0) break; num += w * dose[k]; den += w; acc += w; if (acc >= tgt) break; }
  return { n: spk.length, CU: 100 * (1 - dev / swd), DU: (100 * (den > 0 ? num / den : Dw)) / Dw, CV: (100 * Math.sqrt(sq / sw)) / Dw, peak, doseMm: Dw,
    clamped, minMargin: Number.isFinite(minMargin) ? minMargin : 0, spk: spk.map((s) => ({ r: s.r, nz: s.nz, q: s.q, R: s.R })), model: mdl.label };
}
export const cuGrade = (cu: number) => (cu >= 90 ? "eccellente" : cu >= 85 ? "buona" : cu >= 80 ? "discreta" : "scarsa");

// ---------------------------------------------------------------- FV DEI PIVOT SOLARI, MESE PER MESE
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** Durata del giorno (h) al giorno 15 del mese. */
export function dayLength(lat: number, m: number) {
  const doy = DAYS.slice(0, m).reduce((a, d) => a + d, 0) + 15;
  const dec = 0.409 * Math.sin((2 * Math.PI * doy) / 365 - 1.39), phi = (lat * Math.PI) / 180;
  const x = clamp(-Math.tan(phi) * Math.tan(dec), -1, 1);
  return (24 / Math.PI) * Math.acos(x);
}
/**
 * Mese per mese: energia FV (irraggiamento del sito, piano inclinato ≈ +10%, PR 0,80), ore di
 * marcia che servono al pivot per dare il fabbisogno del mese, ore in cui il sole da solo regge il
 * motore (potenza FV a mezza sinusoide sopra i kW del pivot) e batteria che servirebbe.
 */
// Rendimento del campo FV nel mese: caldo (celle a Tmax + 20 °C, −0,4 %/°C oltre 25 °C), polvere (−5 %),
// inverter e cavi (0,86). Senza temperature resta il valore medio 0,8.
export function pvPerf(tmax?: number | null) {
  if (tmax == null || !Number.isFinite(tmax)) return 0.8;
  return 0.86 * (1 - 0.004 * Math.max(0, tmax + 20 - 25)) * 0.95;
}
export function solarMonths(o: { lat: number; rsMJ: number[]; kWp: number; kW: number; hoursNeed: number[]; battKwh: number; pr?: number[] }) {
  return o.rsMJ.map((rs, m) => {
    const N = dayLength(o.lat, m), E = (rs / 3.6) * 1.1 * (o.pr?.[m] ?? 0.8) * o.kWp;       // kWh/giorno
    const Ppk = N > 0 ? (E * Math.PI) / (2 * N) : 0;
    const hSun = Ppk > o.kW ? N * (1 - (2 / Math.PI) * Math.asin(o.kW / Ppk)) : 0;
    const surplus = Math.max(0, E - o.kW * hSun);                            // energia oltre quella usata in diretta
    const hNeed = Math.min(24, o.hoursNeed[m] ?? 0);
    const hBatt = Math.max(0, hNeed - hSun), battNeed = (hBatt * o.kW) / 0.9;
    const hBattOk = Math.min(hBatt, (Math.min(o.battKwh, surplus * 0.9) * 0.9) / Math.max(0.01, o.kW));
    return { m, E, N, hSun, hNeed, battNeed, ok: hNeed <= hSun + hBattOk + 1e-6, cover: hNeed > 0 ? Math.min(1, (hSun + hBattOk) / hNeed) : 1 };
  });
}

// ---------------------------------------------------------------- FIUME ↔ FABBISOGNO, MESE PER MESE
/**
 * qAvail: portata prelevabile del mese (l/s, già al netto di quanto lasciato al fiume);
 * needM3: volume lordo da prelevare nel mese (m³); hoursMax: ore di prelievo consentite al giorno.
 * Ritorna per mese le ore di prelievo che servono, il deficit e la vasca di compenso (picco sequente).
 */
export function riverBalance(qAvail: number[], needM3: number[], hoursMax: number) {
  const rows = qAvail.map((q, m) => {
    const dayNeed = needM3[m] / DAYS[m], qNeed24 = (dayNeed / 86.4);          // l/s medi sulle 24 h
    const hours = q > 0 ? dayNeed / (q * 3.6) : dayNeed > 0 ? Infinity : 0;
    const supply = Math.min(dayNeed, q * 3.6 * Math.min(24, hoursMax)) * DAYS[m];
    return { m, q, needM3: needM3[m], qNeed24, hours, deficit: Math.max(0, needM3[m] - supply), surplus: Math.max(0, q * 3.6 * Math.min(24, hoursMax) * DAYS[m] - needM3[m]) };
  });
  // vasca di compenso: picco sequente su due anni (il deficit di un mese si copre con l'avanzo dei mesi prima)
  let k = 0, store = 0;
  for (let i = 0; i < 24; i++) { const r = rows[i % 12]; k = Math.max(0, k + r.deficit - r.surplus); store = Math.max(store, k); }
  const total = rows.reduce((a, r) => a + r.deficit, 0), yearSurplus = rows.reduce((a, r) => a + r.surplus, 0);
  return { rows, storeM3: store, deficitM3: total, feasible: yearSurplus >= total };
}


/**
 * Pivot solare dimensionato sul MESE PEGGIORE: il più piccolo campo FV (kWp) che in ogni mese irriguo
 * produce l'energia per le ore di marcia che servono — in diretta col sole e, per le ore senza sole,
 * attraverso le batterie (rendimento 0,85) — e le batterie per le ore di marcia senza sole del mese
 * più sfavorevole (scarica utile 90 %). kWa = potenza media assorbita (targa × utilizzo dei motori).
 */
export function solarDesignWorstMonth(o: { lat: number; rsMJ: number[]; tmax?: number[] | null; kWa: number; hoursNeed: number[] }) {
  const pr = o.rsMJ.map((_, m) => pvPerf(o.tmax?.[m]));
  const act = o.hoursNeed.map((h, m) => (h > 0.05 ? m : -1)).filter((m) => m >= 0);
  const evalAt = (kWp: number) => solarMonths({ lat: o.lat, rsMJ: o.rsMJ, kWp, kW: o.kWa, hoursNeed: o.hoursNeed, battKwh: 0, pr });
  const okAt = (kWp: number) => evalAt(kWp).every((r) => {
    if (r.hNeed <= 0.05) return true;
    const direct = Math.min(r.hNeed, r.hSun), night = Math.max(0, r.hNeed - r.hSun);
    return r.E + 1e-9 >= o.kWa * (direct + night / 0.85);
  });
  if (!act.length || o.kWa <= 0) return { kWp: 0, battKwh: 0, worst: -1, pr, rows: evalAt(0) };
  let lo = 0, hi = o.kWa * 2;
  while (!okAt(hi) && hi < o.kWa * 200) hi *= 1.6;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (okAt(mid)) hi = mid; else lo = mid; }
  const rows = evalAt(hi);
  const night = rows.map((r) => (r.hNeed > 0.05 ? Math.max(0, r.hNeed - r.hSun) : 0));
  const worst = act.reduce((a, m) => {
    const need = (r: typeof rows[number]) => o.kWa * (Math.min(r.hNeed, r.hSun) + Math.max(0, r.hNeed - r.hSun) / 0.85) / Math.max(1e-6, r.E);
    return need(rows[m]) > need(rows[a]) ? m : a;
  }, act[0]);
  return { kWp: hi, battKwh: Math.max(...night) * o.kWa / 0.9, worst, pr, rows };
}
