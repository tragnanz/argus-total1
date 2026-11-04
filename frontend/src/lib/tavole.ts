/* eslint-disable @typescript-eslint/no-explicit-any */
// Motore delle TAVOLE PDF (A3/A4 orizzontali), portato da Ceres (mpBuildPdf, 78.34)
// perché le tavole di Argus Total e di Ceres siano uguali: doppia cornice,
// planimetria in scala su ortofoto (griglia metrica senza ortofoto), nord e barra
// di scala, colonna dei dati a destra che si comprime per stare in una pagina,
// cartiglio in basso, poi le pagine tecniche (tabelle) e le pagine disegnate
// (sezioni tipo di scavo, profilo longitudinale, schema unifilare).
// I testi arrivano già tradotti: il motore non conosce le lingue.
import { jsPDF } from "jspdf";

export type LL = [number, number];                     // [lat, lng]
export type RGB = [number, number, number];
export type TvPivot = { lat: number; lng: number; r: number; deg: number; az: number; ring: LL[]; gunRing?: LL[] | null;
  spans?: number[]; line1: string; line2?: string; fill?: RGB; pv?: LL[][] };   // pv: moduli fotovoltaici del pivot solare
export type TvLine = { id: string; pts: LL[]; color: string; dash?: boolean; width?: number; lab?: string; labColor?: RGB };
export type TvPoint = { pt: LL; color: string; square?: boolean; resR?: number; resLab?: string; lab?: string };
export type TvNode = { pt: LL; lab: string };
export type TvApp = { pt: LL; lab: string; k: "I" | "S" | "V" | "M" };
export type TvColItem = { head: string; lines: string[] };
export type TvTable = { w: number[]; cols: { t: string; a?: "r" }[]; rows: string[][] };
export type TvTech = { title: string; blocks: { h?: string; kv?: [string, string][]; table?: TvTable }[] };
export type TvTrenchItem = { title: string; w: number; h: number; sandTop: number; tape: number;
  objs: { k: "pipe" | "cable" | "tile"; x: number; y: number; r?: number; w?: number }[]; notes: string[] };
export type TvDraw =
  | { kind: "trench"; title: string; items: TvTrenchItem[] }
  | { kind: "profile"; title: string; sub?: string; L: number; pts: { d: number; z: number; hgl: number }[]; highs: { d: number; z: number }[]; lows: { d: number; z: number }[];
      labT: string; labH: string; labA: string; labD: string }
  | { kind: "unif"; title: string; note?: string; srcs: { cap: string; name: string; info?: string; loads: { name: string; info?: string; cab?: string; cab2?: string }[] }[] }
  // scheda della pompa: curva H-Q del catalogo, rendimento, curva dell'impianto e punto di lavoro
  | { kind: "curve"; title: string; labQ: string; labH: string; labEta: string; labSys: string; labDuty: string;
      items: { name: string; sub: string; pts: number[][]; q: number; H: number }[] }
  // composizione delle campate di ogni pivot (schema in pianta lungo il raggio)
  | { kind: "spans"; title: string; labTower: string; labOh: string; labGun: string;
      items: { name: string; info: string; spans: { len: number; d: string; w: number }[]; oh: number; gun: number }[] }
  // particolari costruttivi tipo (schemi a richiami numerati)
  | { kind: "details"; title: string; items: { key: "pivot" | "air" | "drain" | "station" | "pond"; title: string; notes: string[]; n?: number }[] }
  // sezione tipo dei canali (trapezia: base, tirante, franco, scarpe, rivestimento)
  | { kind: "chan"; title: string; items: { title: string; b: number; y: number; fb: number; m: number; lined: boolean; notes: string[] }[] };
export type TvSheet = {
  title: string;                                       // nel cartiglio: «Planimetria generale», «Tavola delle tubazioni», …
  fields: { pts: LL[] }[]; pivots: TvPivot[]; lines: TvLine[]; points: TvPoint[];
  nodes?: TvNode[]; app?: TvApp[]; vertices?: boolean;
  column: { title: string; items: TvColItem[] }[];      // colonna dei dati a destra
  noMap?: boolean;                                      // solo pagine tecniche e disegni (computo, schede, particolari)
  cells: [string, string][];                            // celle del cartiglio (etichetta, valore)
  tech?: TvTech[]; draw?: TvDraw[];
};
export type TvCommon = {
  format: "a3" | "a4"; brand: string; brandSub: string; version: string; logo?: string | null;
  coordsTitle: string; centroidLabel: string; footer: string; disclaimer: string; client?: string; rev?: string;
  noPlanSat?: boolean;
  compact?: boolean;                                    // tabelle e disegni accorpati sulle stesse pagine
};

// ---- Web Mercator e ortofoto (Esri World Imagery), come Ceres -------------------
const mercX = (lng: number) => (lng + 180) / 360;
const mercY = (lat: number) => { const s = Math.sin((lat * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const mercInvY = (f: number) => { const yy = (0.5 - f) * 4 * Math.PI, e = Math.exp(yy), s = (e - 1) / (e + 1); return (Math.asin(s) * 180) / Math.PI; };
function planBox(pts: LL[], aspect: number) {
  let mnLa = Infinity, mxLa = -Infinity, mnLn = Infinity, mxLn = -Infinity;
  for (const q of pts) { if (!q || !isFinite(q[0]) || !isFinite(q[1])) continue; mnLa = Math.min(mnLa, q[0]); mxLa = Math.max(mxLa, q[0]); mnLn = Math.min(mnLn, q[1]); mxLn = Math.max(mxLn, q[1]); }
  if (!isFinite(mnLa)) return null;
  const padLa = (mxLa - mnLa) * 0.08 || 0.001, padLn = (mxLn - mnLn) * 0.08 || 0.001;
  mnLa -= padLa; mxLa += padLa; mnLn -= padLn; mxLn += padLn;
  let fx0 = mercX(mnLn), fx1 = mercX(mxLn), fyTop = mercY(mxLa), fyBot = mercY(mnLa);
  const wS = fx1 - fx0, hS = fyBot - fyTop;
  if (wS / hS < aspect) { const add = (hS * aspect - wS) / 2; fx0 -= add; fx1 += add; mnLn = fx0 * 360 - 180; mxLn = fx1 * 360 - 180; }
  else { const add = (wS / aspect - hS) / 2; fyTop -= add; fyBot += add; mxLa = mercInvY(fyTop); mnLa = mercInvY(fyBot); }
  return { mnLa, mxLa, mnLn, mxLn };
}
type Sat = { dataURL: string; cw: number; ch: number; z: number; x0: number; y0: number; w: number; midLat: number };
export async function satCanvas(pts: LL[], aspect: number, q = 0.85): Promise<Sat | null> {
  if (typeof document === "undefined") return null;
  const bb = planBox(pts, aspect); if (!bb) return null;
  const { mnLa, mxLa, mnLn, mxLn } = bb, world = (z: number) => 256 * Math.pow(2, z);
  let z = 19; for (; z >= 3; z--) { const w = world(z); if ((mercX(mxLn) - mercX(mnLn)) * w <= 1900 && (mercY(mnLa) - mercY(mxLa)) * w <= 1900) break; }
  const w = world(z), x0 = mercX(mnLn) * w, x1 = mercX(mxLn) * w, y0 = mercY(mxLa) * w, y1 = mercY(mnLa) * w;
  const cw = Math.max(1, Math.round(x1 - x0)), ch = Math.max(1, Math.round(y1 - y0));
  const cvs = document.createElement("canvas"); cvs.width = cw; cvs.height = ch;
  const g = cvs.getContext("2d"); if (!g) return null;
  g.fillStyle = "#0c1f16"; g.fillRect(0, 0, cw, ch);
  const n = Math.pow(2, z), tx0 = Math.floor(x0 / 256), tx1 = Math.floor(x1 / 256), ty0 = Math.floor(y0 / 256), ty1 = Math.floor(y1 / 256);
  let ok = 0; const jobs: Promise<void>[] = [];
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
    if (ty < 0 || ty >= n) continue;
    const txx = ((tx % n) + n) % n;
    const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${txx}`;
    jobs.push(new Promise((res) => {
      const im = new Image(); let done = false; const fin = () => { if (!done) { done = true; res(); } };
      const to = setTimeout(fin, 9000); im.crossOrigin = "anonymous";
      im.onload = () => { try { g.drawImage(im, tx * 256 - x0, ty * 256 - y0); ok++; } catch { /* */ } clearTimeout(to); fin(); };
      im.onerror = () => { clearTimeout(to); fin(); }; im.src = url;
    }));
  }
  await Promise.all(jobs);
  if (!ok) return null;
  try { return { dataURL: cvs.toDataURL("image/jpeg", q), cw, ch, z, x0, y0, w, midLat: (mnLa + mxLa) / 2 }; } catch { return null; }
}
const hexRgb = (h: string): RGB => { const s = h.replace("#", ""); const v = s.length === 3 ? s.split("").map((c) => c + c).join("") : s; return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]; };
const rad = (d: number) => (d * Math.PI) / 180;
const nowStr = () => { const d = new Date(), p2 = (n: number) => (n < 10 ? "0" + n : "" + n); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
// caratteri che il font standard di jsPDF non ha
const SAN = (s: unknown) => String(s ?? "").replace(/[₃]/g, "3").replace(/[₂]/g, "2").replace(/[₁]/g, "1").replace(/≈/g, "~").replace(/→/g, "->").replace(/[−–]/g, "-").replace(/×/g, "x").replace(/ΔV/g, "dV").replace(/Δ/g, "d").replace(/η/g, "eta").replace(/[‘’]/g, "'").replace(/[“”«»]/g, "\"").replace(/…/g, "...").replace(/³/g, "3").replace(/²/g, "2");

export async function buildTavole(sheets: TvSheet[], C: TvCommon): Promise<Blob> {
  const fmtId = C.format === "a4" ? "a4" : "a3";
  const doc: any = new jsPDF({ orientation: "landscape", unit: "mm", format: fmtId });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const setDraw = (r: number, g: number, b: number) => doc.setDrawColor(r, g, b), setFill = (r: number, g: number, b: number) => doc.setFillColor(r, g, b), setText = (r: number, g: number, b: number) => doc.setTextColor(r, g, b);
  const gOp = (o: number) => { try { doc.setGState(new doc.GState({ opacity: o })); } catch { /* */ } };
  const poly = (mm: number[][], style: string) => { if (mm.length < 2) return; const rel: number[][] = []; for (let i = 1; i < mm.length; i++) rel.push([mm[i][0] - mm[i - 1][0], mm[i][1] - mm[i - 1][1]]); doc.lines(rel, mm[0][0], mm[0][1], [1, 1], style, true); };
  const polyOpen = (mm: number[][]) => { if (mm.length < 2) return; const rel: number[][] = []; for (let i = 1; i < mm.length; i++) rel.push([mm[i][0] - mm[i - 1][0], mm[i][1] - mm[i - 1][1]]); doc.lines(rel, mm[0][0], mm[0][1], [1, 1], "S", false); };
  const niceStep = (target: number) => [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000].find((v) => v >= target) ?? 10000;
  const dstr = nowStr();
  const T = (s: unknown) => SAN(s);
  const satCache = new Map<string, Sat | null>();
  const frame = () => { setDraw(18, 53, 36); doc.setLineWidth(0.6); doc.rect(6, 6, W - 12, H - 12, "S"); doc.setLineWidth(0.2); doc.rect(7.5, 7.5, W - 15, H - 15, "S"); };

  let pagesUsed = false;   // jsPDF nasce con una pagina vuota: la usa il primo foglio
  for (let si = 0; si < sheets.length; si++) {
    const sh = sheets[si];
    if (!sh.noMap) {
    if (pagesUsed) doc.addPage();
    pagesUsed = true;
    frame();
    const allPts: LL[] = sh.fields.flatMap((f) => f.pts);
    const COLW = fmtId === "a3" ? 58 : 50, TBH = 28, tbY = H - TBH, colX = W - COLW;
    doc.setLineWidth(0.3); setDraw(120, 150, 130); doc.line(colX, 8, colX, tbY); doc.line(8, tbY, W - 8, tbY);
    const aX0 = 10, aX1 = colX - 4, aY0 = 10, aY1 = tbY - 4, pad = 11, availW = aX1 - aX0 - 2 * pad, availH = aY1 - aY0 - 2 * pad;
    const boxX = 8, boxY = 8, boxW = colX - 8, boxH = tbY - 8;
    const extent: LL[] = allPts.concat(sh.pivots.flatMap((p) => p.ring), sh.lines.flatMap((l) => l.pts), sh.points.map((p) => p.pt));
    let sat: Sat | null = null;
    if (!C.noPlanSat) {
      const key = JSON.stringify([extent.length, extent[0], extent[extent.length - 1], fmtId]);
      if (!satCache.has(key)) satCache.set(key, await satCanvas(extent, boxW / boxH).catch(() => null));
      sat = satCache.get(key) ?? null;
    }
    let P: (lat: number, lng: number) => number[], mmPerM: number, denom: number, imgX = 0, imgY = 0, imgW = 0, imgH = 0;
    const NICE = [50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000, 20000, 25000, 50000, 100000, 200000];
    if (sat) {
      const s0 = sat;
      imgX = boxX; imgY = boxY; imgW = boxW; imgH = boxH;
      doc.addImage(s0.dataURL, "JPEG", imgX, imgY, imgW, imgH);
      doc.setLineWidth(0.3); setDraw(120, 150, 130); doc.rect(imgX, imgY, imgW, imgH, "S");
      P = (lat, lng) => [imgX + ((mercX(lng) * s0.w - s0.x0) / s0.cw) * imgW, imgY + ((mercY(lat) * s0.w - s0.y0) / s0.ch) * imgH];
      const mpp = (156543.033928 * Math.cos((s0.midLat * Math.PI) / 180)) / Math.pow(2, s0.z);
      mmPerM = imgW / (s0.cw * mpp);
      const de = 1000 / mmPerM; denom = NICE.find((v) => v >= de) ?? Math.round(de);
    } else {
      let sLat = 0; for (const p of extent) sLat += p[0];
      const refLat = sLat / (extent.length || 1), k = Math.cos(rad(refLat)), R = 6371008.8;
      const toM = (lat: number, lng: number) => [rad(lng) * R * k, rad(lat) * R];
      const all = extent.map((q) => toM(q[0], q[1]));
      let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
      for (const q of all) { mnx = Math.min(mnx, q[0]); mxx = Math.max(mxx, q[0]); mny = Math.min(mny, q[1]); mxy = Math.max(mxy, q[1]); }
      const gW = mxx - mnx || 1, gH = mxy - mny || 1, need = Math.max((gW * 1000) / availW, (gH * 1000) / availH);
      denom = NICE.find((v) => v >= need) ?? NICE[NICE.length - 1];
      mmPerM = 1000 / denom;
      const offX = aX0 + pad + (availW - gW * mmPerM) / 2, offYb = aY1 - pad - (availH - gH * mmPerM) / 2;
      P = (lat, lng) => { const m = toM(lat, lng); return [offX + (m[0] - mnx) * mmPerM, offYb - (m[1] - mny) * mmPerM]; };
      const gStep = niceStep(18 / mmPerM);
      setDraw(70, 110, 85); doc.setLineWidth(0.08); gOp(0.5);
      const topY = offYb - gH * mmPerM, rightX = offX + gW * mmPerM;
      for (let gx = Math.ceil(mnx / gStep) * gStep; gx <= mxx + 1e-6; gx += gStep) { const X = offX + (gx - mnx) * mmPerM; doc.line(X, topY, X, offYb); }
      for (let gy = Math.ceil(mny / gStep) * gStep; gy <= mxy + 1e-6; gy += gStep) { const Y = offYb - (gy - mny) * mmPerM; doc.line(offX, Y, rightX, Y); }
      gOp(1);
    }
    // campi
    sh.fields.forEach((f) => {
      if (f.pts.length < 2) return;
      const fMM = f.pts.map((v) => P(v[0], v[1]));
      gOp(sat ? 0.06 : 0.13); setFill(0, 170, 215); poly(fMM, "F"); gOp(1);
      setDraw(sat ? 90 : 0, sat ? 210 : 150, sat ? 255 : 190); doc.setLineWidth(0.6); poly(fMM, "S");
    });
    // pivot: impronta, end gun, tracce delle campate, raggio, etichetta su due righe
    sh.pivots.forEach((p) => {
      const mm = p.ring.map((a) => P(a[0], a[1]));
      if (p.gunRing && p.gunRing.length > 2) {
        const gmm = p.gunRing.map((a) => P(a[0], a[1]));
        gOp(sat ? 0.11 : 0.13); setFill(...(p.fill ?? [46, 224, 160])); poly(gmm, "F"); gOp(1);
        setDraw(...(p.fill ?? [46, 224, 160])); doc.setLineWidth(0.25); doc.setLineDashPattern([1, 0.8], 0); poly(gmm, "S"); doc.setLineDashPattern([], 0);
      }
      gOp(sat ? (p.fill ? 0.38 : 0.18) : (p.fill ? 0.4 : 0.22)); setFill(...(p.fill ?? [46, 224, 160])); poly(mm, "F"); gOp(1);
      setDraw(...(p.fill ?? [46, 224, 160])); doc.setLineWidth(p.fill ? 0.6 : 0.4); poly(mm, "S");
      if (p.spans && p.spans.length) {
        setDraw(237, 243, 238); doc.setLineWidth(0.18); doc.setLineDashPattern([0.7, 1.1], 0);
        let acc = 0;
        for (const l of p.spans) {
          acc += l; if (acc >= p.r - 0.5) break;
          const ring: LL[] = []; const full = p.deg >= 359.5, st = full ? 72 : Math.max(8, Math.round((72 * p.deg) / 360));
          for (let i = 0; i <= st; i++) { const b = full ? (360 * i) / st : p.az - p.deg / 2 + (p.deg * i) / st; ring.push(dest(p.lat, p.lng, acc, b)); }
          polyOpen(ring.map((a) => P(a[0], a[1])));
        }
        doc.setLineDashPattern([], 0);
      }
      if (p.pv?.length) { setFill(30, 58, 138); setDraw(229, 237, 247); doc.setLineWidth(0.08); for (const m of p.pv) poly(m.map((q) => P(q[0], q[1])), "FD"); }
      const c = P(p.lat, p.lng), az = p.deg < 359.5 ? p.az : 45;
      setFill(sat ? 240 : 11, sat ? 250 : 80, sat ? 240 : 55); doc.circle(c[0], c[1], 0.8, "F");
      const e = dest(p.lat, p.lng, p.r, az), edge = P(e[0], e[1]);
      setDraw(sat ? 235 : 11, sat ? 245 : 80, sat ? 235 : 55); doc.setLineWidth(0.2); doc.setLineDashPattern([0.8, 0.6], 0); doc.line(c[0], c[1], edge[0], edge[1]); doc.setLineDashPattern([], 0);
      doc.setFont("helvetica", "bold"); doc.setFontSize(6.5); const w1 = doc.getTextWidth(T(p.line1));
      doc.setFont("helvetica", "normal"); doc.setFontSize(5.6); const w2 = p.line2 ? doc.getTextWidth(T(p.line2)) : 0;
      const lw = Math.max(w1, w2), bh2 = p.line2 ? 6.7 : 3.6, top = c[1] - 3.2 - bh2;
      setFill(6, 48, 31); gOp(sat ? 0.82 : 0.72); doc.roundedRect(c[0] - lw / 2 - 1.3, top, lw + 2.6, bh2, 0.8, 0.8, "F"); gOp(1);
      setText(237, 243, 238); doc.setFont("helvetica", "bold"); doc.setFontSize(6.5); doc.text(T(p.line1), c[0], top + 2.7, { align: "center" });
      if (p.line2) { setText(150, 232, 184); doc.setFont("helvetica", "normal"); doc.setFontSize(5.6); doc.text(T(p.line2), c[0], top + 5.6, { align: "center" }); }
    });
    // linee (tubazioni, adduttrice, cavi) con l'etichetta del tratto lungo il tratto più lungo
    sh.lines.forEach((o) => {
      if (o.pts.length < 2) return;
      const mm = o.pts.map((a) => P(a[0], a[1])), rgb = hexRgb(o.color);
      setDraw(rgb[0], rgb[1], rgb[2]); doc.setLineWidth(o.width ?? 0.7);
      if (o.dash) doc.setLineDashPattern([1.6, 1.1], 0);
      polyOpen(mm); doc.setLineDashPattern([], 0);
      if (o.lab) {
        let bi = 1, bl = -1; for (let k = 1; k < mm.length; k++) { const l = Math.hypot(mm[k][0] - mm[k - 1][0], mm[k][1] - mm[k - 1][1]); if (l > bl) { bl = l; bi = k; } }
        const a0 = mm[bi - 1], a1 = mm[bi], lab = T(o.lab); doc.setFont("helvetica", "bold"); doc.setFontSize(5.4); const tw = doc.getTextWidth(lab);
        let ang = bl > tw + 1 ? (Math.atan2(a1[1] - a0[1], a1[0] - a0[0]) * 180) / Math.PI : 0; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
        const rd = (ang * Math.PI) / 180, ux = Math.cos(rd), uy = Math.sin(rd), nx = Math.sin(rd), ny = -Math.cos(rd), cx = (a0[0] + a1[0]) / 2, cy = (a0[1] + a1[1]) / 2;
        const sx = cx - (ux * tw) / 2 + nx * 0.9, sy = cy - (uy * tw) / 2 + ny * 0.9;
        const bx = (du: number, dv: number) => [sx + ux * du + nx * dv, sy + uy * du + ny * dv];
        setFill(255, 255, 255); poly([bx(-0.6, -0.6), bx(tw + 0.6, -0.6), bx(tw + 0.6, 2.4), bx(-0.6, 2.4)], "F");
        const lc = o.labColor ?? [0, 123, 182]; setText(lc[0], lc[1], lc[2]); doc.text(lab, sx, sy, { angle: -ang });
      }
    });
    // punti: vasca in scala, stazioni, presa
    sh.points.forEach((o) => {
      const q = P(o.pt[0], o.pt[1]), rgb = hexRgb(o.color);
      if (o.resR) {
        const e = P(o.pt[0], o.pt[1] + o.resR / (111320 * Math.cos(rad(o.pt[0])))); setFill(59, 159, 214); setDraw(29, 111, 184); doc.setLineWidth(0.4);
        doc.circle(q[0], q[1], Math.max(0.8, Math.abs(e[0] - q[0])), "FD");
        if (o.resLab) { doc.setFont("helvetica", "bold"); doc.setFontSize(6); setText(29, 111, 184); doc.text(T(o.resLab), q[0] + 2.4, q[1] + 3.2); }
        return;
      }
      setFill(rgb[0], rgb[1], rgb[2]); setDraw(255, 255, 255); doc.setLineWidth(0.35);
      if (o.square) doc.rect(q[0] - 1.6, q[1] - 1.6, 3.2, 3.2, "FD"); else doc.circle(q[0], q[1], 1.5, "FD");
      if (o.lab) { doc.setFont("helvetica", "bold"); doc.setFontSize(6); const tw = doc.getTextWidth(T(o.lab)); setFill(255, 255, 255); doc.rect(q[0] + 2.2, q[1] - 2.6, tw + 1.2, 3.4, "F"); setText(rgb[0], rgb[1], rgb[2]); doc.text(T(o.lab), q[0] + 2.8, q[1] - 0.1); }
    });
    (sh.nodes ?? []).forEach((n) => {
      const q = P(n.pt[0], n.pt[1]);
      setFill(255, 255, 255); setDraw(0, 26, 51); doc.setLineWidth(0.3); doc.circle(q[0], q[1], 1.3, "FD"); doc.setFont("helvetica", "bold"); doc.setFontSize(5.2); const tw = doc.getTextWidth(n.lab);
      setFill(0, 26, 51); doc.rect(q[0] + 1.6, q[1] - 3.6, tw + 1.2, 2.6, "F"); setText(255, 255, 255); doc.text(n.lab, q[0] + 2.2, q[1] - 1.7);
    });
    {   // valvole e apparecchiature: sigle I/S/V/M sotto a sinistra del punto, impilate nello stesso punto
      const stack: Record<string, number> = {};
      (sh.app ?? []).forEach((n) => {
        const q = P(n.pt[0], n.pt[1]), key = Math.round(q[0] * 2) + "|" + Math.round(q[1] * 2), k = (stack[key] = (stack[key] || 0) + 1);
        const col = ({ I: [162, 59, 31], S: [0, 123, 182], V: [0, 150, 64], M: [122, 63, 176] } as Record<string, number[]>)[n.k] ?? [0, 26, 51];
        setFill(col[0], col[1], col[2]); setDraw(255, 255, 255); doc.setLineWidth(0.2);
        if (k === 1) {
          if (n.k === "S") doc.triangle(q[0] - 1.1, q[1] + 0.8, q[0] + 1.1, q[1] + 0.8, q[0], q[1] - 1.2, "FD");
          else if (n.k === "V") doc.triangle(q[0] - 1.1, q[1] - 1.1, q[0] + 1.1, q[1] + 1.1, q[0] - 1.1, q[1] + 1.1, "FD");
          else doc.rect(q[0] - 0.9, q[1] - 0.9, 1.8, 1.8, "FD");
        }
        doc.setFont("helvetica", "bold"); doc.setFontSize(4.6); const tw = doc.getTextWidth(n.lab), yy = q[1] + 1.6 + (k - 1) * 2.4;
        setFill(255, 255, 255); doc.rect(q[0] - tw - 2.6, yy, tw + 1, 2.2, "F"); setText(col[0], col[1], col[2]); doc.text(n.lab, q[0] - tw - 2.1, yy + 1.7);
      });
    }
    // vertici dei campi (solo se pochi: con i bordi rilevati dal satellite sarebbero centinaia)
    if (sh.vertices !== false && allPts.length <= 80) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(6);
      allPts.forEach((v, i) => { const q = P(v[0], v[1]); setFill(0, sat ? 208 : 150, sat ? 255 : 190); doc.circle(q[0], q[1], 0.8, "F"); setText(sat ? 220 : 0, sat ? 240 : 80, sat ? 250 : 105); doc.text("V" + (i + 1), q[0] + 1, q[1] - 1); });
    }
    // nord
    const nx = sat ? imgX + imgW - 9 : aX1 - 8, ny = sat ? imgY + 10 : aY0 + 10;
    if (sat) { setFill(6, 30, 18); gOp(0.55); doc.roundedRect(nx - 4, ny - 8.5, 8, 16, 1.5, 1.5, "F"); gOp(1); }
    setFill(255, 255, 255); setDraw(sat ? 255 : 18, sat ? 255 : 53, sat ? 255 : 36); doc.setLineWidth(0.3); doc.triangle(nx, ny - 5, nx - 2.2, ny + 2, nx + 2.2, ny + 2, "FD");
    setDraw(255, 255, 255); doc.setLineWidth(0.3); doc.line(nx, ny + 2, nx, ny + 6);
    setText(sat ? 255 : 18, sat ? 255 : 53, sat ? 255 : 36); doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.text("N", nx - 1.3, ny - 6.2);
    // barra di scala
    const barG = niceStep(38 / mmPerM), barL = barG * mmPerM, sbx = sat ? imgX + 5 : aX0 + 4, sby = sat ? imgY + imgH - 5 : aY1 - 3, seg = barL / 4;
    if (sat) { setFill(6, 30, 18); gOp(0.55); doc.roundedRect(sbx - 2.5, sby - 4, barL + 22, 9.5, 1.5, 1.5, "F"); gOp(1); }
    for (let i = 0; i < 4; i++) { if (i % 2) setFill(255, 255, 255); else setFill(18, 53, 36); setDraw(sat ? 235 : 18, sat ? 240 : 53, sat ? 235 : 36); doc.setLineWidth(0.2); doc.rect(sbx + i * seg, sby - 1.5, seg, 1.5, "FD"); }
    setText(sat ? 255 : 18, sat ? 255 : 53, sat ? 255 : 36); doc.setFont("helvetica", "normal"); doc.setFontSize(6); doc.text("0", sbx - 0.5, sby + 3); doc.text(barG + " m", sbx + barL - 3, sby + 3);
    doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.text(`1:${denom}`, sbx + barL + 4, sby);
    // colonna dei dati: si comprime quel tanto che basta per stare in UNA pagina
    const colBottom = tbY - 4, detW = COLW - 16;
    let cLat = 0, cLng = 0; allPts.forEach((v) => { cLat += v[0]; cLng += v[1]; }); const np0 = allPts.length || 1; cLat /= np0; cLng /= np0;
    const drawColumn = (S: number, draw: boolean) => {
      const Sf = Math.max(S, 0.82), cx = colX + 3; let cy = 13;
      const nl = (h?: number) => { cy += S * (h || 3.1); };
      const wrText = (txt: string, h?: number) => { const ls: string[] = doc.splitTextToSize(T(txt), detW); ls.forEach((ln, li) => { if (draw) doc.text(ln, cx + 4, cy); if (li < ls.length - 1) nl(h || 2.7); }); };
      setText(18, 53, 36); doc.setFont("helvetica", "bold"); doc.setFontSize(7.5 * Sf); if (draw) doc.text(T(C.coordsTitle) + " (WGS84)", cx, cy); cy += S * 4;
      doc.setFont("helvetica", "normal"); doc.setFontSize(5.6 * Sf); setText(90, 115, 101); if (draw) doc.text(T(C.centroidLabel), cx, cy); cy += S * 3;
      doc.setFontSize(6.4 * Sf); setText(30, 40, 34); if (draw) doc.text(`${cLat.toFixed(6)}, ${cLng.toFixed(6)}`, cx, cy); cy += S * 3.4;
      setText(60, 110, 170); doc.setFontSize(6 * Sf); if (draw) doc.textWithLink(">> Google Maps", cx, cy, { url: `https://www.google.com/maps?q=${cLat.toFixed(6)},${cLng.toFixed(6)}` }); cy += S * 4.6;
      for (const sec of sh.column) {
        if (!sec.items.length) continue;
        cy += S * 1.6;
        setText(18, 53, 36); doc.setFont("helvetica", "bold"); doc.setFontSize(7 * Sf); if (draw) doc.text(T(sec.title), cx, cy); cy += S * 3.6;
        doc.setFont("helvetica", "normal"); doc.setFontSize(5.8 * Sf);
        for (const it of sec.items) {
          setText(30, 40, 34); if (draw) doc.text(T(it.head), cx, cy, { maxWidth: COLW - 5 }); cy += S * 2.9;
          setText(70, 100, 82);
          it.lines.forEach((ln, k) => { wrText(ln); if (k < it.lines.length - 1) cy += S * 2.9; });
          setText(30, 40, 34); nl();
        }
      }
      return cy;
    };
    const cyEnd = drawColumn(1, false), colAvailH = colBottom - 13, colNeedH = cyEnd - 13;
    drawColumn(colNeedH > colAvailH ? Math.max(0.5, colAvailH / colNeedH) : 1, true);
    // cartiglio
    const tbh = H - 8 - tbY, tbx0 = 8, tbx1 = W - 8;
    doc.setLineWidth(0.2); setDraw(120, 150, 130); doc.rect(tbx0, tbY, 44, tbh, "S");
    if (C.logo) { try { doc.addImage(C.logo, "PNG", tbx0 + 2.5, tbY + 2, 8, 8); } catch { /* */ } }
    setText(18, 53, 36); doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.text(T(C.brand), tbx0 + 12.5, tbY + 6.4);
    setText(90, 115, 101); doc.setFont("helvetica", "normal"); doc.setFontSize(5.6); doc.text(T(C.brandSub), tbx0 + 12.5, tbY + 10);
    doc.setFontSize(5.4); doc.text(T(sh.title), tbx0 + 2.5, tbY + 14, { maxWidth: 40 }); doc.text(T(C.version), tbx0 + 2.5, tbY + 17.4);
    const cell = (x: number, w: number, label: string, value: string) => {
      doc.setLineWidth(0.2); setDraw(120, 150, 130); doc.rect(x, tbY, w, tbh, "S");
      setText(90, 115, 101); doc.setFont("helvetica", "normal"); doc.setFontSize(5.5); doc.text(T(label).toUpperCase(), x + 1.5, tbY + 3, { maxWidth: w - 2 });
      setText(18, 53, 36); doc.setFont("helvetica", "bold");
      let fs = 8.5; const maxW = w - 3; doc.setFontSize(fs);
      while (doc.getTextWidth(T(value)) > maxW && fs > 5) { fs -= 0.5; doc.setFontSize(fs); }
      doc.text(T(value), x + 1.5, tbY + 8, { maxWidth: maxW });
    };
    let bx = tbx0 + 44; const av = tbx1 - bx, wsum = sh.cells.reduce((a, c) => a + Math.max(1, c[1].length + 6), 0);
    sh.cells.forEach(([lab, val], i) => {
      const w = i === sh.cells.length - 1 ? tbx1 - bx : (av * Math.max(1, val.length + 6)) / wsum;
      cell(bx, w, lab, val); bx += w;
    });
    setText(90, 115, 101); doc.setFont("helvetica", "normal"); doc.setFontSize(4.9);
    doc.text(T(C.footer.replace("{d}", dstr)), tbx0, H - 5, { maxWidth: tbx1 - tbx0 });
    setText(120, 140, 128); doc.setFont("helvetica", "italic"); doc.setFontSize(5);
    doc.text(T(C.disclaimer), tbx0, H - 2.4, { maxWidth: tbx1 - tbx0 });
    }

    // ===== pagine tecniche (tabelle) e disegni =====
    // Separata: una pagina per tabella e una per disegno, come Ceres.
    // Accorpata (C.compact): tabelle e disegni scorrono uno dopo l'altro sulle
    // stesse pagine, ciascuno col suo titolo, e si va a pagina nuova solo se non ci stanno.
    const M = fmtId === "a3" ? 14 : 12, bottom = H - 12;
    const footer = () => { setText(90, 115, 101); doc.setFont("helvetica", "normal"); doc.setFontSize(4.9); doc.text(T(`${C.brand} ${C.version} · ${dstr}${C.client ? " · " + C.client : ""}${C.rev ? " · Rev. " + C.rev : ""} · ${sh.title}`), M, H - 6); };
    const title = (s: string) => { setText(18, 53, 36); doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.text(T(s), M, 18); setDraw(120, 150, 130); doc.setLineWidth(0.3); doc.line(M, 21, W - M, 21);
      if (C.logo) { try { doc.addImage(C.logo, "PNG", W - M - 10, 9, 9, 9); } catch { /* */ } } };
    const txt = (s: string, x: number, yy: number, o?: Record<string, unknown>) => doc.text(T(s), x, yy, o || {});
    const f2 = (v: number, d = 2) => v.toLocaleString("it-IT", { minimumFractionDigits: d, maximumFractionDigits: d });
    let y = 28, pageTitle = "";
    const newPg = (pt: string) => { pageTitle = pt; if (pagesUsed) doc.addPage(); pagesUsed = true; frame(); title(pt); y = 28; };
    const ensure = (need: number) => { if (y + need > bottom) { footer(); newPg(pageTitle); } };
    const heading = (s: string) => {   // titolo di sezione nella vista accorpata
      setText(18, 53, 36); doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.text(T(s), M, y);
      setDraw(200, 214, 204); doc.setLineWidth(0.2); doc.line(M, y + 1.6, W - M, y + 1.6); y += 6.5;
    };
    const techBlocks = (pdef: TvTech) => {
      for (const blk of pdef.blocks) {
        if (blk.h) { ensure(9); setText(18, 53, 36); doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.text(T(blk.h), M, y); y += 5.5; }
        if (blk.kv) {
          const colW = (W - 2 * M) / 2; let i = 0;
          for (const kvp of blk.kv) { const c = i % 2, x = M + c * colW; if (c === 0) ensure(5); setText(95, 115, 102); doc.setFont("helvetica", "normal"); doc.setFontSize(8.2); doc.text(T(kvp[0]), x, y, { maxWidth: colW * 0.5 }); setText(28, 40, 34); doc.setFont("helvetica", "bold"); doc.text(T(kvp[1]), x + colW - 3, y, { align: "right", maxWidth: colW * 0.47 }); if (c === 1 || i === blk.kv.length - 1) y += 5; i++; }
        }
        if (blk.table) {
          const tb = blk.table, aW = W - 2 * M, xs: number[] = []; let acc = M; const ws = tb.w.reduce((a, b) => a + b, 0) || 1; tb.w.forEach((fr) => { xs.push(acc); acc += (fr / ws) * aW; });
          const cw = (ci: number) => (tb.w[ci] / ws) * aW;
          const thead = () => { setText(18, 53, 36); doc.setFont("helvetica", "bold"); doc.setFontSize(7.3);
            tb.cols.forEach((c, ci) => { const al = c.a === "r"; doc.text(T(c.t), al ? xs[ci] + cw(ci) - 1.5 : xs[ci] + 1, y, { align: al ? "right" : "left", maxWidth: cw(ci) - 2 }); });
            y += 1.6; setDraw(160, 175, 165); doc.setLineWidth(0.2); doc.line(M, y, W - M, y); y += 3; doc.setFont("helvetica", "normal"); doc.setFontSize(7.3); setText(30, 40, 34); };
          ensure(6 + 4 * Math.min(tb.rows.length, 4)); thead();
          tb.rows.forEach((r, ri) => {
            if (y + 4 > bottom) { footer(); newPg(pageTitle); thead(); }
            if (ri % 2 === 1) { setFill(244, 248, 245); doc.rect(M, y - 2.9, W - 2 * M, 4, "F"); }
            r.forEach((c, ci) => { const al = tb.cols[ci]?.a === "r"; doc.text(T(c), al ? xs[ci] + cw(ci) - 1.5 : xs[ci] + 1, y, { align: al ? "right" : "left", maxWidth: cw(ci) - 1.5 }); }); y += 4;
          });
        }
        y += 2.6;
      }
    };
    // un disegno dentro il riquadro (X0, Y0)–(X1, Y1)
    const drawPanel = (pg: TvDraw, X0: number, Y0: number, X1: number, Y1: number) => {
      if (pg.kind === "trench") {
        const n = Math.max(1, pg.items.length), slot = (X1 - X0) / n, top = Y0 + 10, bot = Y1 - 8;
        pg.items.forEach((it, i) => {
          const x0 = X0 + i * slot, avW = slot * 0.5, avH = bot - top - 10, sc = Math.min(avW / (it.w + 0.8), avH / (it.h + 0.3)), cx = x0 + slot * 0.32, gy = top + 4;
          const X = (m: number) => cx + m * sc, Y = (m: number) => gy + m * sc, hw = it.w / 2;
          setText(0, 123, 182); doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); txt(it.title, x0 + 2, Y0 + 3, { maxWidth: slot - 4 });
          setDraw(92, 99, 106); doc.setLineWidth(0.5); doc.line(X(-hw - 0.4), Y(0), X(-hw), Y(0)); doc.line(X(hw), Y(0), X(hw + 0.4), Y(0));
          setFill(240, 232, 214); doc.rect(X(-hw), Y(0), it.w * sc, it.h * sc, "F"); setDraw(0, 26, 51); doc.setLineWidth(0.4); doc.lines([[0, it.h * sc], [it.w * sc, 0], [0, -it.h * sc]], X(-hw), Y(0), [1, 1], "S", false);
          setFill(255, 244, 196); doc.rect(X(-hw), Y(it.sandTop), it.w * sc, (it.h - it.sandTop) * sc, "F"); doc.setLineWidth(0.15); setDraw(184, 160, 90); doc.rect(X(-hw), Y(it.sandTop), it.w * sc, (it.h - it.sandTop) * sc, "S");
          it.objs.forEach((ob) => {
            if (ob.k === "pipe") { setFill(255, 255, 255); setDraw(0, 123, 182); doc.setLineWidth(0.6); doc.circle(X(ob.x), Y(ob.y), Math.max(0.6, (ob.r ?? 0.05) * sc), "FD"); }
            else if (ob.k === "cable") { setFill(225, 29, 72); doc.circle(X(ob.x), Y(ob.y), Math.max(0.7, (ob.r ?? 0.015) * sc), "F"); }
            else { const w2 = ob.w ?? 0.2; setFill(184, 90, 60); doc.rect(X(ob.x - w2 / 2), Y(ob.y), w2 * sc, 0.03 * sc + 0.4, "F"); }
          });
          setDraw(255, 159, 0); doc.setLineWidth(0.5); doc.setLineDashPattern([1, 0.8], 0); doc.line(X(-hw * 0.8), Y(it.tape), X(hw * 0.8), Y(it.tape)); doc.setLineDashPattern([], 0);
          setDraw(92, 99, 106); doc.setLineWidth(0.15); setText(0, 26, 51); doc.setFont("helvetica", "normal"); doc.setFontSize(6.5);
          const yb = Y(it.h) + 4; doc.line(X(-hw), yb, X(hw), yb); doc.line(X(-hw), yb - 1, X(-hw), yb + 1); doc.line(X(hw), yb - 1, X(hw), yb + 1); txt("B = " + f2(it.w) + " m", cx, yb + 3.5, { align: "center" });
          const xd = X(-hw) - 5; doc.line(xd, Y(0), xd, Y(it.h)); doc.line(xd - 1, Y(0), xd + 1, Y(0)); doc.line(xd - 1, Y(it.h), xd + 1, Y(it.h)); txt("H = " + f2(it.h) + " m", xd - 1.5, Y(it.h / 2), { align: "right" });
          const lx = X(hw) + 5; let ly = Y(0) + 2; doc.setFontSize(6.4);
          it.notes.forEach((nt) => { const ls: string[] = doc.splitTextToSize(T(nt), Math.max(20, slot - (lx - x0) - 3)); ls.forEach((l2) => { txt(l2, lx, ly); ly += 2.8; }); ly += 1; });
        });
      } else if (pg.kind === "profile") {
        const x0 = X0 + 14, x1 = X1 - 4, y0 = Y0 + 7, y1 = Y1 - 13, P2 = pg.pts, L = Math.max(1, pg.L);
        const zs = P2.map((q) => q.z).concat(P2.map((q) => q.hgl)), zMin = Math.floor(Math.min(...zs) - 2), zMax = Math.ceil(Math.max(...zs) + 2);
        const X = (d: number) => x0 + ((x1 - x0) * d) / L, Y = (z: number) => y1 - ((y1 - y0) * (z - zMin)) / Math.max(1, zMax - zMin);
        setDraw(190, 199, 210); doc.setLineWidth(0.1); setText(92, 99, 106); doc.setFont("helvetica", "normal"); doc.setFontSize(6);
        const zs2 = Math.max(1, Math.round((zMax - zMin) / Math.max(3, Math.min(8, (y1 - y0) / 12)))); for (let z = Math.ceil(zMin / zs2) * zs2; z <= zMax; z += zs2) { doc.line(x0, Y(z), x1, Y(z)); txt(z + " m", x0 - 1.5, Y(z) + 1, { align: "right" }); }
        const ds = [50, 100, 200, 250, 500, 1000].find((v) => L / v <= 12) ?? 2000; for (let d = 0; d <= L; d += ds) { doc.line(X(d), y0, X(d), y1); txt(d + " m", X(d), y1 + 4, { align: "center" }); }
        setFill(230, 214, 190); doc.lines(P2.slice(1).map((q, i) => [X(q.d) - X(P2[i].d), Y(q.z) - Y(P2[i].z)]).concat([[0, y1 - Y(P2[P2.length - 1].z)], [X(P2[0].d) - X(P2[P2.length - 1].d), 0]]), X(P2[0].d), Y(P2[0].z), [1, 1], "F", true);
        setDraw(138, 109, 59); doc.setLineWidth(0.5); doc.lines(P2.slice(1).map((q, i) => [X(q.d) - X(P2[i].d), Y(q.z) - Y(P2[i].z)]), X(P2[0].d), Y(P2[0].z), [1, 1], "S", false);
        setDraw(0, 159, 227); doc.setLineWidth(0.8); doc.lines(P2.slice(1).map((q, i) => [X(q.d) - X(P2[i].d), Y(q.hgl) - Y(P2[i].hgl)]), X(P2[0].d), Y(P2[0].hgl), [1, 1], "S", false);
        pg.highs.forEach((q) => { setFill(0, 26, 51); doc.triangle(X(q.d) - 1.4, Y(q.z) - 1.2, X(q.d) + 1.4, Y(q.z) - 1.2, X(q.d), Y(q.z) - 3.6, "F"); });
        pg.lows.forEach((q) => { setFill(0, 123, 182); doc.triangle(X(q.d) - 1.4, Y(q.z) + 1.2, X(q.d) + 1.4, Y(q.z) + 1.2, X(q.d), Y(q.z) + 3.6, "F"); });
        setText(0, 26, 51); doc.setFontSize(7); let lx = X0;
        const leg = (r: number, g: number, b: number, l: string) => { setFill(r, g, b); doc.rect(lx, Y1 - 3.6, 5, 2, "F"); setText(0, 26, 51); txt(l, lx + 6.5, Y1 - 2); lx += 8 + doc.getTextWidth(T(l)) + 6; };
        leg(138, 109, 59, pg.labT); leg(0, 159, 227, pg.labH); if (pg.labA) leg(0, 26, 51, pg.labA); if (pg.labD) leg(0, 123, 182, pg.labD);
        doc.setFontSize(7.5); txt(pg.sub || "", X0, Y0 + 2.5);
      } else if (pg.kind === "unif") {
        let yy = Y0 + 2; const bw = 58, bh = 16, yEnd = Y1 - 7;
        pg.srcs.forEach((src) => {
          if (yy + 22 > yEnd) return;
          const nL = Math.max(1, src.loads.length), step = Math.max(11, Math.min(22, (yEnd - yy - 6) / nL)), lb = Math.min(12, step - 2);
          setFill(240, 244, 250); setDraw(0, 26, 51); doc.setLineWidth(0.4); doc.roundedRect(X0, yy, bw, bh, 2.4, 2.4, "FD");
          setText(0, 123, 182); doc.setFont("helvetica", "bold"); doc.setFontSize(7); txt(src.cap, X0 + 3, yy + 5); setText(0, 26, 51); doc.setFontSize(9); txt(src.name, X0 + 3, yy + 10.5); doc.setFont("helvetica", "normal"); doc.setFontSize(6.5); txt(src.info || "", X0 + 3, yy + 14.2);
          const busX = X0 + bw + 10, busY0 = yy + bh / 2; setDraw(0, 26, 51); doc.setLineWidth(0.6); doc.line(X0 + bw, busY0, busX, busY0);
          const yl = (k: number) => yy + 4 + k * step, busY1 = yl(Math.max(0, nL - 1)) + lb * 0.66; doc.setLineWidth(1.2); doc.line(busX, yy + 2, busX, Math.max(busY1, yy + bh));
          src.loads.forEach((ld, k) => {
            const ly = yl(k) + lb * 0.66; if (ly > yEnd) return; doc.setLineWidth(0.5); setDraw(0, 26, 51); doc.line(busX, ly, busX + 12, ly);
            doc.rect(busX + 12, ly - 2.2, 4.4, 4.4, "S"); doc.line(busX + 12, ly + 2.2, busX + 16.4, ly - 2.2); doc.line(busX + 16.4, ly, busX + 26, ly);
            setDraw(225, 29, 72); doc.setLineWidth(0.8); doc.line(busX + 26, ly, busX + 96, ly); setText(225, 29, 72); doc.setFont("helvetica", "bold"); doc.setFontSize(6.6); txt(ld.cab || "", busX + 28, ly - 1.6); doc.setFont("helvetica", "normal"); doc.setFontSize(6); txt(ld.cab2 || "", busX + 28, ly + 3.4);
            setFill(255, 255, 255); setDraw(0, 26, 51); doc.setLineWidth(0.4); doc.roundedRect(busX + 96, ly - lb / 2, 62, lb, 2.4, 2.4, "FD"); setText(0, 26, 51); doc.setFont("helvetica", "bold"); doc.setFontSize(8); txt(ld.name, busX + 99, ly - lb / 2 + 4.4, { maxWidth: 58 }); doc.setFont("helvetica", "normal"); doc.setFontSize(6.4); txt(ld.info || "", busX + 99, ly - lb / 2 + Math.min(9.4, lb - 1.8));
          });
          yy = Math.max(yy + bh, busY1 + lb / 2) + 8;
        });
        setText(92, 99, 106); doc.setFont("helvetica", "normal"); doc.setFontSize(6.5); txt(pg.note || "", X0, Y1 - 1, { maxWidth: X1 - X0 });
      } else if (pg.kind === "chan") {
        const n = Math.max(1, pg.items.length), slot = (X1 - X0) / n, top = Y0 + 10, bot = Y1 - 10;
        pg.items.forEach((it, i) => {
          const x0 = X0 + i * slot, H = it.y + it.fb, topW = it.b + 2 * it.m * H, ext = topW + 3;
          const avW = slot * 0.55, avH = bot - top - 12, sc = Math.min(avW / ext, avH / (H + 0.6)), cx = x0 + slot * 0.32, gy = top + 6;
          const X = (m: number) => cx + m * sc, Y = (m: number) => gy + (H - m) * sc;     // m = quota sopra il fondo
          setText(0, 123, 182); doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); txt(it.title, x0 + 2, Y0 + 3, { maxWidth: slot - 4 });
          // terreno e scavo
          setFill(240, 232, 214); doc.rect(X(-ext / 2), Y(H), ext * sc, (H + 0.5) * sc, "F");
          setFill(255, 255, 255); doc.triangle(X(-topW / 2), Y(H), X(-it.b / 2), Y(0), X(it.b / 2), Y(0), "F"); doc.triangle(X(-topW / 2), Y(H), X(it.b / 2), Y(0), X(topW / 2), Y(H), "F");
          // acqua
          const wW = it.b + 2 * it.m * it.y; setFill(127, 197, 232);
          doc.triangle(X(-wW / 2), Y(it.y), X(-it.b / 2), Y(0), X(it.b / 2), Y(0), "F"); doc.triangle(X(-wW / 2), Y(it.y), X(it.b / 2), Y(0), X(wW / 2), Y(it.y), "F");
          setDraw(46, 134, 171); doc.setLineWidth(0.5); doc.line(X(-wW / 2), Y(it.y), X(wW / 2), Y(it.y));
          // contorno della sezione (rivestimento più spesso)
          setDraw(0, 26, 51); doc.setLineWidth(it.lined ? 1.1 : 0.5);
          doc.lines([[(-it.b / 2 - -topW / 2) * sc, H * sc], [it.b * sc, 0], [(topW / 2 - it.b / 2) * sc, -H * sc]], X(-topW / 2), Y(H), [1, 1], "S", false);
          setDraw(92, 99, 106); doc.setLineWidth(0.4); doc.line(X(-ext / 2), Y(H), X(-topW / 2), Y(H)); doc.line(X(topW / 2), Y(H), X(ext / 2), Y(H));
          // quote
          setDraw(92, 99, 106); doc.setLineWidth(0.15); setText(0, 26, 51); doc.setFont("helvetica", "normal"); doc.setFontSize(6.5);
          const yb = Y(0) + 4; doc.line(X(-it.b / 2), yb, X(it.b / 2), yb); doc.line(X(-it.b / 2), yb - 1, X(-it.b / 2), yb + 1); doc.line(X(it.b / 2), yb - 1, X(it.b / 2), yb + 1); txt("b = " + f2(it.b) + " m", cx, yb + 3.5, { align: "center" });
          const yt = Y(H) - 3; doc.line(X(-topW / 2), yt, X(topW / 2), yt); doc.line(X(-topW / 2), yt - 1, X(-topW / 2), yt + 1); doc.line(X(topW / 2), yt - 1, X(topW / 2), yt + 1); txt(f2(topW) + " m", cx, yt - 1.2, { align: "center" });
          const xr = X(ext / 2) + 2; doc.line(xr, Y(0), xr, Y(H)); doc.line(xr - 1, Y(0), xr + 1, Y(0)); doc.line(xr - 1, Y(it.y), xr + 1, Y(it.y)); doc.line(xr - 1, Y(H), xr + 1, Y(H));
          txt("y = " + f2(it.y) + " m", xr + 1.5, Y(it.y / 2) + 1); txt("f = " + f2(it.fb) + " m", xr + 1.5, Y(it.y + it.fb / 2) + 1);
          txt("1 : " + f2(it.m), X(-(it.b / 2 + topW / 2) / 2) - 9, Y(H / 2) + 1, { align: "right" });
          const lx = x0 + 2; let ly = bot + 1; doc.setFontSize(6.4);
          it.notes.forEach((nt) => { const ls: string[] = doc.splitTextToSize(T(nt), slot - 6); ls.forEach((l2) => { if (ly < Y1 + 6) txt(l2, lx, ly); ly += 2.8; }); });
        });
      } else if (pg.kind === "curve") {
        const n = pg.items.length, cols = Math.min(2, n), rows = Math.ceil(n / cols), cw = (X1 - X0) / cols, ch = (Y1 - Y0) / rows;
        pg.items.forEach((it, k) => {
          const cx0 = X0 + (k % cols) * cw, cy0 = Y0 + Math.floor(k / cols) * ch;
          setText(0, 26, 51); doc.setFont("helvetica", "bold"); doc.setFontSize(9); txt(it.name, cx0, cy0 + 3);
          setText(92, 99, 106); doc.setFont("helvetica", "normal"); doc.setFontSize(6.8); txt(it.sub, cx0, cy0 + 7, { maxWidth: cw - 6 });
          const P2 = it.pts.filter((q) => q[0] != null && q[1] != null);
          if (P2.length < 2) return;
          const px0 = cx0 + 14, px1 = cx0 + cw - 18, py0 = cy0 + 12, py1 = cy0 + ch - 14;
          const qMax = Math.max(it.q * 1.25, P2[P2.length - 1][0]) * 1.02, hMax = Math.max(...P2.map((q) => q[1]), it.H) * 1.12;
          const X = (q: number) => px0 + ((px1 - px0) * q) / qMax, Y = (h: number) => py1 - ((py1 - py0) * h) / hMax, YE = (e: number) => py1 - ((py1 - py0) * e) / 100;
          doc.setLineWidth(0.1); setDraw(205, 212, 220); doc.setFontSize(5.8); setText(92, 99, 106);
          const qs = niceStep(qMax / 7), hs = niceStep(hMax / 6);
          for (let q = 0; q <= qMax; q += qs) { doc.line(X(q), py0, X(q), py1); txt(String(q), X(q), py1 + 3, { align: "center" }); }
          for (let h = 0; h <= hMax; h += hs) { doc.line(px0, Y(h), px1, Y(h)); txt(String(h), px0 - 1.2, Y(h) + 1, { align: "right" }); }
          for (let e = 0; e <= 100; e += 20) { setText(0, 150, 64); txt(String(e), px1 + 1.2, YE(e) + 1); }
          setDraw(0, 26, 51); doc.setLineWidth(0.3); doc.line(px0, py1, px1, py1); doc.line(px0, py0, px0, py1); setDraw(0, 150, 64); doc.line(px1, py0, px1, py1);
          setText(0, 26, 51); doc.setFontSize(6.2); txt(pg.labQ, (px0 + px1) / 2, py1 + 7, { align: "center" });
          txt(pg.labH, px0 - 10, (py0 + py1) / 2, { angle: 90, align: "center" }); setText(0, 150, 64); txt(pg.labEta, px1 + 9, (py0 + py1) / 2, { angle: 90, align: "center" });
          // curva dell'impianto (parabola per il punto di lavoro)
          setDraw(0, 26, 51); doc.setLineWidth(0.35); doc.setLineDashPattern([1.2, 1], 0);
          const sysP: number[][] = []; for (let i = 0; i <= 24; i++) { const q = (qMax * i) / 24, h = it.H * (q / it.q) ** 2; if (h > hMax) break; sysP.push([X(q), Y(h)]); }
          polyOpen(sysP); doc.setLineDashPattern([], 0);
          // curva H-Q e rendimento
          setDraw(0, 123, 182); doc.setLineWidth(0.9); polyOpen(P2.map((q) => [X(q[0]), Y(q[1])]));
          const E = P2.filter((q) => q[3] != null && q[3] > 0 && q[0] > 0).map((q) => [q[0], Math.min(95, (q[0] * q[1]) / 367 / q[3] * 100)]);
          if (E.length > 1) { setDraw(0, 150, 64); doc.setLineWidth(0.6); polyOpen(E.map((q) => [X(q[0]), YE(q[1])])); }
          // punto di lavoro
          setFill(225, 29, 72); setDraw(255, 255, 255); doc.setLineWidth(0.3); doc.circle(X(it.q), Y(it.H), 1.4, "FD");
          setDraw(225, 29, 72); doc.setLineWidth(0.2); doc.setLineDashPattern([0.6, 0.6], 0); doc.line(X(it.q), Y(it.H), X(it.q), py1); doc.line(px0, Y(it.H), X(it.q), Y(it.H)); doc.setLineDashPattern([], 0);
          const lab = `${pg.labDuty}: Q ${f2(it.q, 1)} m3/h · H ${f2(it.H, 1)} m`; doc.setFont("helvetica", "bold"); doc.setFontSize(6.4); const tw = doc.getTextWidth(T(lab));
          const lx = Math.min(X(it.q) + 2.5, px1 - tw - 2), ly = Math.max(py0 + 4, Y(it.H) - 3);
          setFill(255, 255, 255); doc.rect(lx - 0.8, ly - 2.8, tw + 1.6, 3.8, "F"); setText(225, 29, 72); txt(lab, lx, ly);
          // legenda
          doc.setFont("helvetica", "normal"); doc.setFontSize(6); let gx = px0 + 2; const gy = py0 + 2.5;
          const leg = (rgb: number[], l: string, dash = false) => { setDraw(rgb[0], rgb[1], rgb[2]); doc.setLineWidth(0.6); if (dash) doc.setLineDashPattern([1.2, 1], 0); doc.line(gx, gy - 1, gx + 5, gy - 1); doc.setLineDashPattern([], 0); setText(0, 26, 51); txt(l, gx + 6.2, gy); gx += 9 + doc.getTextWidth(T(l)) + 3; };
          leg([0, 123, 182], "H-Q"); if (E.length > 1) leg([0, 150, 64], pg.labEta.split(" (")[0]); leg([0, 26, 51], pg.labSys, true);
        });
      } else if (pg.kind === "spans") {
        const LW = 46, nI = pg.items.length, rowH = Math.min(22, (Y1 - Y0 - 6) / Math.max(1, nI));
        const maxL = Math.max(...pg.items.map((it) => it.spans.reduce((a, s2) => a + s2.len, 0) + it.oh + it.gun), 1);
        const sx = (X1 - X0 - LW - 8) / maxL;
        pg.items.forEach((it, k) => {
          const ry = Y0 + 4 + k * rowH, my = ry + rowH * 0.45, x0 = X0 + LW;
          if (k % 2 === 1) { setFill(244, 248, 245); doc.rect(X0, ry - 2, X1 - X0, rowH, "F"); }
          setText(0, 26, 51); doc.setFont("helvetica", "bold"); doc.setFontSize(8.4); txt(it.name, X0 + 1, my - 1);
          setText(92, 99, 106); doc.setFont("helvetica", "normal"); doc.setFontSize(6); txt(it.info, X0 + 1, my + 2.6, { maxWidth: LW - 3 });
          setFill(0, 26, 51); doc.rect(x0 - 1.4, my - 1.4, 2.8, 2.8, "F");
          let x = x0;
          it.spans.forEach((sp2) => {
            const xe = x + sp2.len * sx; setDraw(0, 123, 182); doc.setLineWidth(sp2.w); doc.line(x, my, xe, my);
            setFill(0, 26, 51); doc.triangle(xe - 1.2, my + 2.4, xe + 1.2, my + 2.4, xe, my, "F");
            doc.setFontSize(5.4); setText(0, 123, 182); txt(sp2.d, (x + xe) / 2, my - 1.6, { align: "center" }); setText(92, 99, 106); txt(f2(sp2.len, 1), (x + xe) / 2, my + 4, { align: "center" });
            x = xe;
          });
          if (it.oh > 0) { const xe = x + it.oh * sx; setDraw(0, 123, 182); doc.setLineWidth(0.4); doc.setLineDashPattern([1, 0.7], 0); doc.line(x, my, xe, my); doc.setLineDashPattern([], 0); doc.setFontSize(5.4); setText(92, 99, 106); txt(`${pg.labOh} ${f2(it.oh, 1)}`, (x + xe) / 2, my + 4, { align: "center" }); x = xe; }
          if (it.gun > 0) { const xe = x + it.gun * sx; setDraw(0, 150, 64); doc.setLineWidth(0.3); doc.setLineDashPattern([0.5, 0.8], 0); doc.line(x, my, xe, my); doc.setLineDashPattern([], 0); setFill(0, 150, 64); doc.circle(x, my, 0.8, "F"); doc.setFontSize(5.4); setText(0, 150, 64); txt(`${pg.labGun} ${f2(it.gun, 0)} m`, (x + xe) / 2, my - 1.6, { align: "center" }); }
        });
        doc.setFontSize(6.2); setText(92, 99, 106); let lx = X0 + 1;
        setFill(0, 26, 51); doc.triangle(lx, Y1 - 1, lx + 2.4, Y1 - 1, lx + 1.2, Y1 - 3.4, "F"); txt(pg.labTower, lx + 3.6, Y1 - 1.2); lx += 8 + doc.getTextWidth(T(pg.labTower));
        setDraw(0, 123, 182); doc.setLineWidth(1.2); doc.line(lx, Y1 - 2.2, lx + 6, Y1 - 2.2); txt('10"', lx + 7, Y1 - 1.2); lx += 14; doc.setLineWidth(0.8); doc.line(lx, Y1 - 2.2, lx + 6, Y1 - 2.2); txt('8"5/8', lx + 7, Y1 - 1.2); lx += 17; doc.setLineWidth(0.5); doc.line(lx, Y1 - 2.2, lx + 6, Y1 - 2.2); txt('6"5/8', lx + 7, Y1 - 1.2);
      } else if (pg.kind === "details") {
        const n = pg.items.length, cols = Math.min(3, n), rows = Math.ceil(n / cols), cw = (X1 - X0) / cols, ch = (Y1 - Y0) / rows;
        pg.items.forEach((it, k) => {
          const bx0 = X0 + (k % cols) * cw + 1, by0 = Y0 + Math.floor(k / cols) * ch, bw = cw - 4, bh = ch - 3;
          setDraw(200, 214, 204); doc.setLineWidth(0.25); doc.roundedRect(bx0, by0, bw, bh, 1.5, 1.5, "S");
          setText(0, 123, 182); doc.setFont("helvetica", "bold"); doc.setFontSize(8.2); txt(it.title, bx0 + 3, by0 + 5, { maxWidth: bw - 6 });
          const dw = bw * 0.6, dh = bh - 30, dx = bx0 + 3, dy = by0 + 9;      // disegno a sinistra, sotto le note
          drawDetail(it.key, dx, dy, dw, dh, it.n ?? 2);
          // note numerate a destra (richiami 1, 2, 3 …)
          let ny = by0 + 11; doc.setFont("helvetica", "normal"); doc.setFontSize(6);
          it.notes.forEach((nt, i) => {
            const nx = bx0 + dw + 6; setFill(0, 123, 182); doc.circle(nx + 1.3, ny - 1.1, 1.4, "F"); setText(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(5.4); txt(String(i + 1), nx + 1.3, ny - 0.4, { align: "center" });
            setText(0, 26, 51); doc.setFont("helvetica", "normal"); doc.setFontSize(6);
            const ls: string[] = doc.splitTextToSize(T(nt), bw - dw - 12); ls.forEach((l2, j) => txt(l2, nx + 3.8, ny + j * 2.6)); ny += ls.length * 2.6 + 1.6;
          });
        });
      }
    };
    // ---- particolari costruttivi: schemi vettoriali con i richiami numerati ----
    const callout = (n: number, x: number, yy: number, tx2: number, ty2: number) => {
      setDraw(0, 123, 182); doc.setLineWidth(0.15); doc.line(x, yy, tx2, ty2); setFill(0, 123, 182); doc.circle(tx2, ty2, 1.4, "F");
      setText(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(5.4); doc.text(String(n), tx2, ty2 + 0.7, { align: "center" });
    };
    const valve = (x: number, yy: number, s2: number, vert = false) => {   // saracinesca / idrovalvola: farfalla
      setFill(255, 255, 255); setDraw(0, 26, 51); doc.setLineWidth(0.3);
      if (vert) { doc.triangle(x - s2, yy - s2, x + s2, yy - s2, x, yy, "FD"); doc.triangle(x - s2, yy + s2, x + s2, yy + s2, x, yy, "FD"); }
      else { doc.triangle(x - s2, yy - s2, x - s2, yy + s2, x, yy, "FD"); doc.triangle(x + s2, yy - s2, x + s2, yy + s2, x, yy, "FD"); }
    };
    const hatch = (x: number, yy: number, w: number, h: number) => {
      setFill(214, 214, 208); setDraw(120, 120, 112); doc.setLineWidth(0.2); doc.rect(x, yy, w, h, "FD"); doc.setLineWidth(0.1);
      for (let d = -h; d < w; d += 1.6) { const xa = Math.max(x, x + d), ya = yy + (xa - (x + d)), xb = Math.min(x + w, x + d + h), yb = yy + (xb - (x + d)); if (xb > xa) doc.line(xa, ya, xb, yb); }
    };
    const ground = (x0: number, x1: number, yy: number) => { setDraw(92, 99, 106); doc.setLineWidth(0.4); doc.line(x0, yy, x1, yy); doc.setLineWidth(0.15); for (let x = x0; x < x1; x += 2.2) doc.line(x, yy, x - 1.2, yy + 1.2); };
    const pipeH = (x0: number, x1: number, yy: number, r: number) => { setFill(214, 236, 248); setDraw(0, 123, 182); doc.setLineWidth(0.4); doc.rect(x0, yy - r, x1 - x0, 2 * r, "FD"); };
    const pipeV = (x: number, y0: number, y1: number, r: number) => { setFill(214, 236, 248); setDraw(0, 123, 182); doc.setLineWidth(0.4); doc.rect(x - r, Math.min(y0, y1), 2 * r, Math.abs(y1 - y0), "FD"); };
    const drawDetail = (key: string, x: number, yy: number, w: number, h: number, nP: number) => {
      const gy = yy + h * 0.38;
      if (key === "pivot") {
        ground(x, x + w, gy);
        const py = gy + h * 0.32, r = Math.max(1.4, h * 0.035), cx = x + w * 0.55;
        pipeH(x + 2, cx + r, py, r); pipeV(cx, py + r, gy - h * 0.2, r);
        hatch(cx - r - 3.5, py - r, 3.5, 2 * r + 3); hatch(cx - r - 2, py + r, 2 * r + 4, 3);
        valve(cx, gy - h * 0.12, 2.4, true); setDraw(0, 26, 51); doc.setLineWidth(0.3); doc.line(cx, gy - h * 0.12, cx + 4, gy - h * 0.12); doc.rect(cx + 4, gy - h * 0.12 - 1.2, 2.4, 2.4, "S");
        const ty = gy - h * 0.2; setDraw(0, 26, 51); doc.setLineWidth(0.5); doc.line(cx, ty, cx, yy + 1); doc.line(cx - w * 0.22, gy, cx, yy + 4); doc.line(cx + w * 0.22, gy, cx, yy + 4);
        hatch(cx - w * 0.22 - 2, gy, 4, 2.6); hatch(cx + w * 0.22 - 2, gy, 4, 2.6);
        callout(1, x + 8, py, x + 4, py + 6); callout(2, cx - r - 2, py + 1, x + 10, py + 9); callout(3, cx + 2, gy - h * 0.12, cx + 10, gy - h * 0.06); callout(4, cx + 4, gy - h * 0.12, cx + 12, gy - h * 0.2);
        callout(5, cx, yy + 6, cx - 9, yy + 3); callout(6, cx + w * 0.22, gy + 1, cx + w * 0.22 + 4, gy + 6);
      } else if (key === "air" || key === "drain") {
        ground(x, x + w, gy);
        const pw = w * 0.5, px = x + w * 0.25, by = gy + h * 0.42, r = Math.max(1.4, h * 0.04);
        hatch(px - 2, gy - 1, 2, by - gy + 4); hatch(px + pw, gy - 1, 2, by - gy + 4); hatch(px - 2, by + 3, pw + 4, 2.5); hatch(px - 3, gy - 2.2, pw + 6, 1.6);
        pipeH(x + 1, x + w - 1, by, r); const cx = px + pw / 2;
        if (key === "air") {
          pipeV(cx, by - r, by - h * 0.26, r * 0.7); valve(cx, by - h * 0.17, 2.2, true);
          setFill(255, 255, 255); setDraw(0, 26, 51); doc.setLineWidth(0.3); doc.roundedRect(cx - 2.6, by - h * 0.34, 5.2, h * 0.08, 1.6, 1.6, "FD");
          callout(1, x + 4, by, x + 3, by + 7); callout(2, cx - r, by - r, px + 3, by - 6); callout(3, cx + 2, by - h * 0.17, cx + 9, by - h * 0.12); callout(4, cx + 2.6, by - h * 0.3, cx + 9, by - h * 0.3);
          callout(5, px - 1, gy + 4, x + 3, gy + 8); callout(6, px + pw * 0.8, gy - 1.4, px + pw * 0.8 + 3, yy + 4);
        } else {
          pipeV(cx, by + r, by + h * 0.12, r * 0.7); pipeH(cx, x + w - 1, by + h * 0.12, r * 0.7); valve(cx + pw * 0.3, by + h * 0.12, 2.2);
          setFill(205, 190, 160); doc.rect(x + w - 6, by + h * 0.12 - 3, 5, 9, "F");
          callout(1, x + 4, by, x + 3, by + 7); callout(2, cx, by + h * 0.06, px + 3, by + h * 0.2); callout(3, cx + pw * 0.3, by + h * 0.12 - 2, cx + pw * 0.3 + 4, by - 6);
          callout(4, x + w - 3.5, by + h * 0.12 + 2, x + w - 6, by + h * 0.3); callout(5, px - 1, gy + 4, x + 3, gy + 8); callout(6, px + pw * 0.8, gy - 1.4, px + pw * 0.8 + 3, yy + 4);
        }
      } else if (key === "station") {
        const n = Math.max(1, Math.min(4, nP)), my0 = yy + 4, step = (h - 10) / n, xs = x + 4, xc = x + w * 0.78;
        setDraw(0, 26, 51); doc.setLineWidth(0.3); doc.rect(x + 1, yy + 1, w - 2, h - 2, "S");
        pipeV(xs, my0, my0 + (n - 1) * step + 4, 1.2); pipeV(xc, my0, my0 + (n - 1) * step + 4, 1.4);
        for (let i = 0; i < n; i++) {
          const ly = my0 + 2 + i * step; pipeH(xs, xc, ly, 0.8);
          const pxp = x + w * 0.3; setFill(255, 255, 255); setDraw(0, 26, 51); doc.setLineWidth(0.4); doc.circle(pxp, ly, 3, "FD"); setFill(0, 26, 51); doc.triangle(pxp - 1.2, ly - 1.5, pxp - 1.2, ly + 1.5, pxp + 1.6, ly, "F");
          valve(x + w * 0.48, ly, 1.6); setDraw(0, 26, 51); doc.line(x + w * 0.48 - 1.6, ly - 2.4, x + w * 0.48 + 1.6, ly - 2.4);
          valve(x + w * 0.62, ly, 1.6);
          if (i === 0) { callout(1, pxp, ly - 3, pxp - 3, ly - 7 < yy + 2 ? yy + 3 : ly - 7); callout(2, x + w * 0.48, ly - 2.4, x + w * 0.44, yy + 3); callout(3, x + w * 0.62, ly - 1.6, x + w * 0.6, yy + 3); }
        }
        const oy = my0 + (n - 1) * step + 4; pipeH(xc, x + w + 2, oy, 1.4);
        setFill(255, 255, 255); setDraw(122, 63, 176); doc.setLineWidth(0.4); doc.circle(x + w * 0.9, oy, 2, "FD"); setText(122, 63, 176); doc.setFont("helvetica", "bold"); doc.setFontSize(5); doc.text("M", x + w * 0.9, oy + 0.7, { align: "center" });
        setFill(240, 244, 250); setDraw(0, 26, 51); doc.rect(x + w * 0.05, yy + h - 9, 9, 6, "FD"); setText(0, 26, 51); doc.setFontSize(4.6); doc.text("Q.E.", x + w * 0.05 + 4.5, yy + h - 5.4, { align: "center" });
        callout(4, xc, my0 + 1, xc + 3, yy + 3); callout(5, x + w * 0.9, oy - 2, x + w * 0.9 + 1, oy - 7); callout(6, xs, my0 + 1, xs + 4, yy + 3); callout(7, x + w * 0.05 + 9, yy + h - 6, x + w * 0.05 + 14, yy + h - 4);
      } else if (key === "pond") {
        // argini in terra con scarpate 1:2, fondo largo, telo sulle scarpate interne e sul fondo
        const by = yy + h * 0.8, ty = yy + h * 0.28, sl = w * 0.11, cw2 = w * 0.07;
        const xl0 = x + sl + cw2, xl1 = x + 2 * sl + cw2, xr1 = x + w - 2 * sl - cw2, xr0 = x + w - sl - cw2;
        setFill(205, 190, 160); setDraw(120, 100, 70); doc.setLineWidth(0.3);
        doc.lines([[sl, -(by - ty)], [cw2, 0], [sl, by - ty]], x, by, [1, 1], "FD", true);
        doc.lines([[sl, -(by - ty)], [cw2, 0], [sl, by - ty]], xr0 - sl + (sl - sl), by, [1, 1], "FD", true);
        const wl = ty + (by - ty) * 0.25, f = (wl - ty) / (by - ty), wxl = xl0 + sl * f, wxr = xr0 - sl * f;
        setFill(150, 205, 235); doc.lines([[wxr - wxl, 0], [xr1 - wxr, by - wl], [xl1 - xr1, 0]], wxl, wl, [1, 1], "F", true);
        setDraw(17, 24, 39); doc.setLineWidth(0.7); doc.lines([[sl, by - ty], [xr1 - xl1, 0], [sl, -(by - ty)]], xl0, ty, [1, 1], "S", false);
        setDraw(0, 123, 182); doc.setLineWidth(0.3); doc.setLineDashPattern([1, 0.6], 0); doc.line(wxl, wl, wxr, wl); doc.setLineDashPattern([], 0);
        setDraw(92, 99, 106); doc.setLineWidth(0.15); doc.line(xr1 + 3, ty, xr1 + 6, ty); doc.line(xr1 + 3, wl, xr1 + 6, wl); doc.line(xr1 + 4.5, ty, xr1 + 4.5, wl);
        ground(x, x + w, by);
        callout(1, x + sl + cw2 / 2, ty, x + sl + cw2 / 2, yy + 3); callout(2, (xl0 + xl1) / 2, (ty + by) / 2, (xl0 + xl1) / 2 + 5, yy + 8); callout(3, (wxl + wxr) / 2, wl, (wxl + wxr) / 2, yy + 3);
        callout(4, (xl1 + xr1) / 2, by, (xl1 + xr1) / 2 + 6, by + 5); callout(5, xr1 + 4.5, (ty + wl) / 2, xr1 + 10, yy + 6);
      }
    };
    // altezza che serve a un disegno nella vista accorpata
    const avail = bottom - 28;
    const panelH = (pg: TvDraw) => pg.kind === "trench" || pg.kind === "chan" ? Math.min(avail - 8, fmtId === "a3" ? 80 : 70)
      : pg.kind === "profile" ? Math.min(avail - 8, fmtId === "a3" ? 118 : 92)
      : pg.kind === "unif" ? Math.min(avail - 8, 30 + pg.srcs.reduce((a, s) => a + Math.max(1, s.loads.length) * 13 + 8, 0))
      : pg.kind === "curve" ? Math.min(avail - 8, Math.ceil(pg.items.length / 2) * (fmtId === "a3" ? 92 : 72))
      : pg.kind === "spans" ? Math.min(avail - 8, 12 + pg.items.length * 18)
      : Math.min(avail - 8, Math.ceil(pg.items.length / 3) * (fmtId === "a3" ? 96 : 78));
    if (C.compact && ((sh.tech ?? []).length || (sh.draw ?? []).length)) {
      newPg(sh.title);
      for (const pdef of sh.tech ?? []) { ensure(18); heading(pdef.title); techBlocks(pdef); y += 2; }
      // un disegno si restringe fino al minimo leggibile pur di stare nello spazio che resta sulla pagina
      const panelMin = (pg: TvDraw) => pg.kind === "profile" ? 62 : pg.kind === "unif" ? Math.min(panelH(pg), 26 + pg.srcs.reduce((a, s) => a + Math.max(1, s.loads.length) * 11 + 8, 0))
        : pg.kind === "spans" ? Math.min(panelH(pg), 10 + pg.items.length * 13) : panelH(pg);
      for (const pg of sh.draw ?? []) {
        const room = bottom - y - 8, h = room >= panelMin(pg) ? Math.min(panelH(pg), room) : panelH(pg);
        ensure(h + 8); heading(pg.title); drawPanel(pg, M, y, W - M, y + h); y += h + 5;
      }
      footer();
    } else {
      for (const pdef of sh.tech ?? []) { newPg(pdef.title); techBlocks(pdef); footer(); }
      for (const pg of sh.draw ?? []) { newPg(pg.title); drawPanel(pg, M, 26, W - M, H - 14); footer(); }
    }
  }
  return doc.output("blob");
}

// punto a distanza d (m) e azimut b (gradi da nord) — sfera, come Ceres
export function dest(lat: number, lng: number, d: number, b: number): LL {
  const R = 6371008.8, d2 = d / R, br = rad(b), la1 = rad(lat), lo1 = rad(lng);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d2) + Math.cos(la1) * Math.sin(d2) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d2) * Math.cos(la1), Math.cos(d2) - Math.sin(la1) * Math.sin(la2));
  return [(la2 * 180) / Math.PI, (lo2 * 180) / Math.PI];
}
// impronta di un pivot (cerchio o settore) come anello [lat, lng]
export function pivotRing(lat: number, lng: number, r: number, deg = 360, az = 0, steps = 72): LL[] {
  if (deg >= 359.5) return Array.from({ length: steps + 1 }, (_, i) => dest(lat, lng, r, (360 * i) / steps));
  const st = Math.max(8, Math.round((steps * deg) / 360)), out: LL[] = [[lat, lng]];
  for (let i = 0; i <= st; i++) out.push(dest(lat, lng, r, az - deg / 2 + (deg * i) / st));
  out.push([lat, lng]); return out;
}
// sezione di scavo di un tubo interrato (come mpTrench di Ceres)
export function trench(dnMm: number, cover = 1.0, bed = 0.1) {
  const od = dnMm / 1000, extra = od <= 0.225 ? 0.4 : od <= 0.35 ? 0.5 : od <= 0.7 ? 0.7 : 0.85;
  const w = Math.max(0.4, od + extra), h = cover + od + bed;
  return { cover, w, h, bed, od };
}
