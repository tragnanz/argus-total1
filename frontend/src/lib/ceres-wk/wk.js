// @ts-nocheck
/* eslint-disable */
// Motore dei DISEGNI TECNICI DELLE OPERE di Ceres (wk_module, Ceres 78.34): piazzola del pivot, stazione di pompaggio,
// pompa verticale, basamenti di motopompa e gruppo elettrogeno, filtri, reservoir. Copiato senza modifiche al disegno.
import { jsPDF } from "jspdf";
import { WK_PUMPS, WK_ART, WK_GEN } from "./catalog.js";
// ---- DISEGNI TECNICI DELLE OPERE (77.28): piazzola del pivot, basamento della motopompa, basamento del gruppo elettrogeno, stazione di pompaggio ----
// Ogni tavola è una lista di viste in metri (x a destra, y in alto) con primitive semplici; la stessa lista si disegna in SVG (anteprima) e in jsPDF (A3).
// Le misure sono PROPOSTE (tipiche per taglia) e si correggono nella pagina: la tavola dice sempre che vanno verificate con il costruttore e lo strutturista.
const WK_TYPES = ["pad", "moto", "gen", "station", "vpump", "pivotSet", "filter", "set", "reservoir"];
const wkLerp = (tab, x) => {   // tab: [[x, a, b, c...]] crescente in x → interpolazione lineare (fuori tabella: estremi)
  if (!(x > 0)) x = tab[0][0];
  if (x <= tab[0][0]) return tab[0].slice(1);
  for (let i = 1; i < tab.length; i++) if (x <= tab[i][0]) { const a = tab[i - 1], b = tab[i], f = (x - a[0]) / (b[0] - a[0]); return a.slice(1).map((v, k) => v + (b[k + 1] - v) * f); }
  return tab[tab.length - 1].slice(1);
};
// ingombri indicativi (m): motopompa su slitta con serbatoio nel telaio, per potenza del motore (kW) · gruppo elettrogeno cofanato, per taglia (kVA)
const WK_MOTO_T = [[15, 1.6, 0.9, 1.2], [30, 2.0, 1.0, 1.4], [60, 2.5, 1.2, 1.6], [100, 3.0, 1.4, 1.9], [160, 3.5, 1.6, 2.1], [250, 4.2, 1.8, 2.3], [400, 4.8, 2.1, 2.5]];
const WK_GEN_T = [[10, 1.6, 0.8, 1.1], [30, 2.2, 1.0, 1.4], [60, 2.7, 1.1, 1.6], [100, 3.3, 1.2, 1.9], [200, 4.0, 1.4, 2.2], [400, 5.0, 1.7, 2.5], [630, 6.0, 2.2, 2.6], [1000, 7.0, 2.4, 2.8]];
const wkLc = (t, s) => t("wk_lcN") === "0" ? String(s) : String(s).toLowerCase();   // minuscole a metà frase, ma non per i sostantivi tedeschi (78.29)
const wkR = (v, d = 2) => Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
const wkDnOf = (q_ls) => { const A = (q_ls / 1000) / 1.8; const d = Math.sqrt(4 * A / Math.PI) * 1000; return [50, 65, 80, 100, 125, 150, 200, 250, 300, 350, 400, 450, 500].find(x => x >= d) || 500; };   // diametro per ~1,8 m/s

// PIAZZOLA DEL PIVOT: misure dei costruttori (m). Star Pivot: tavole di fondazione del costruttore (08/2015) — platea quadrata con soletta
// e quattro piedi d'angolo, tirafondi M20 × 300 sporgenti 3,7 cm (2,7 cm trainabile), calcestruzzo 350 kg di cemento per m³; il tubo centrale segue il Ø
// più grande delle campate, «el» = profilo standard, «e» = alto. Valley: platea tracciata a 132" (11') di lato, diagonale 186 3/4", con quattro pilastrini Ø 2' profondi 4' a interasse 9',
// tirafondi 7/8" UNC × 24" a interasse 114 3/8", 5 yd³ (guida di installazione del punto pivot compatibile Valley); spessore della soletta ricavato dal volume.
// Zimmatic, Reinke, RKD: misure non pubblicate → riferimento Star Pivot, da verificare con lo schema del costruttore (Reinke: piazzola 5 1/2" fuori terra col carrello a 4 ruote).
const WK_PAD_STAR = {
  "168-std": { L: 3.50, B: 2.75, F: 0.75, Hs: 0.15, V: 3.75, st: "1200 (250 × 950)", bar: "3350", dia: "4700" },
  "168-high": { L: 3.80, B: 3.10, F: 0.75, Hs: 0.15, V: 4.10, st: "1200 (250 × 950)", bar: "3700", dia: "5200" },
  "203-std": { L: 3.50, B: 2.71, F: 0.75, Hs: 0.20, V: 4.30, st: "1200 (250 × 950)", bar: "3350", dia: "4700" },
  "203-high": { L: 3.90, B: 3.09, F: 0.80, Hs: 0.20, V: 5.10, st: "1200 (250 × 950)", bar: "3700", dia: "5200" },
  "254-std": { L: 3.55, B: 2.75, F: 0.80, Hs: 0.20, V: 4.57, st: "1200 (250 × 950)", bar: "3350", dia: "4700" },
  "254-high": { L: 3.95, B: 3.13, F: 0.85, Hs: 0.20, V: 5.43, st: "1225 (275 × 950)", bar: "3700", dia: "5200" },
  "skid": { L: 4.40, B: 3.60, F: 0.80, Hs: 0.20, V: 5.90, st: "1200 (250 × 950)", bar: "4200", dia: "5600" },
};
const WK_PAD_MK = ["starpivot", "valley", "zimmatic", "reinke", "rkd"];
const WK_PAD_PP = ["fix", "skid", "cart"];
const WK_PAD_TUBE = [168, 203, 254];
function wkPadDefaults(ctx) {
  const mk = WK_PAD_MK.includes(ctx.mk) ? ctx.mk : "starpivot", pp = WK_PAD_PP.includes(ctx.pp) ? ctx.pp : "fix";
  const prof = ctx.prof === "high" || ctx.prof === "ultra" ? "high" : "std", tube = WK_PAD_TUBE.includes(+ctx.tube) ? +ctx.tube : 203;
  const base = { mk, pp, prof, tube, ultra: ctx.prof === "ultra" ? 1 : 0, dn: ctx.pivDn || 200, depth: 1.2, feed: ctx.feed || (pp === "fix" ? "riser" : "hyd"), hyMat: "pe", hyV: "both", emerg: mk === "reinke" && pp !== "fix" ? 0.14 : 0.05 };
  if (pp === "cart") return { ...base, shape: "plinths", F: 0.60, Ht: 1.20, Bx: 4.25, By: 2.25, boltD: 20, boltL: 0.30, boltP: 0.027, src: mk === "starpivot" ? "star" : "ref" };
  if (mk === "valley" && pp === "fix") return { ...base, shape: "slab", round: 1, L: 3.35, B: 2.905, F: 0.61, Fc: 2.745, Hs: 0.24, Ht: 1.22, boltD: 22, boltL: 0.61, boltP: 0.10, src: "valley" };
  const c = WK_PAD_STAR[pp === "skid" ? "skid" : tube + "-" + prof];
  return { ...base, shape: "slab", round: 0, L: c.L, B: c.B, F: c.F, Fc: wkR(c.L - c.F), Hs: c.Hs, Ht: 1.00, boltD: 20, boltL: 0.30, boltP: pp === "skid" ? 0.027 : 0.037, src: mk === "starpivot" ? "star" : "ref", cat: c };
}

// ---- misure e pesi della pompa scelta, dal catalogo (WK_PUMPS, mm e kg → m e kg) ----
const wkPipeKg = (dn) => { const od = { 50: 60.3, 65: 76.1, 80: 88.9, 100: 114.3, 125: 139.7, 150: 168.3, 200: 219.1, 250: 273, 300: 323.9 }[dn] || dn * 1.1, t = od < 120 ? 4 : od < 200 ? 5 : 6.3; return Math.PI * (od - t) * t * 7.85e-3 + Math.PI * Math.pow((od - 2 * t) / 1000, 2) / 4 * 1000; };   // tubo di mandata in acciaio pieno d'acqua (kg/m): con la valvola di ritegno si estrae pieno
// DN DELLE TUBAZIONI FLANGIATE (78.29): dal progetto possono arrivare i Ø esterni del PE (160, 180, 225…), che non sono DN della EN 1092-1;
// si passa al DN unificato più vicino al Ø interno (PE100 SDR 17 ≈ 0,88 del Ø esterno), salendo di una taglia se la velocità supera 2 m/s
const WK_PE_OD = [63, 75, 90, 110, 125, 140, 160, 180, 225, 280, 315, 355, 450, 560, 630];
function wkDnStd(v, qls) { v = +v || 0; if (!v) return v; const DNs = [50, 65, 80, 100, 125, 150, 200, 250, 300, 350, 400, 450, 500, 600]; if (DNs.includes(v) && !WK_PE_OD.includes(v)) return v;
  if (!WK_PE_OD.includes(v)) return DNs.find(x => x >= v) || 600;
  const id = v * 0.88; let i = 0; DNs.forEach((x, k) => { if (Math.abs(x - id) < Math.abs(DNs[i] - id)) i = k; });
  if (qls > 0) while (i < DNs.length - 1 && (qls / 1000) / (Math.PI / 4 * Math.pow(DNs[i] / 1000, 2)) > 2.0) i++;
  return DNs[i]; }
// Ø ESTERNO REALE DEI TUBI PE/PVC NELLE ETICHETTE (78.30): il progetto dà il Ø esterno del PE (160, 200, 225…), la tavola lavora sul DN unificato (wkDnStd);
// l'etichetta del tubo riporta il Ø del progetto (odX) finché il DN non è stato cambiato a mano (odXDn = DN calcolato), altrimenti il Ø del PE per quel DN (WK_PEOD)
const WK_PE_SER = [50, 63, 75, 90, 110, 125, 140, 160, 180, 200, 225, 250, 280, 315, 355, 400, 450, 500, 560, 630];
const wkOdOf = (v) => WK_PE_SER.includes(+v) ? +v : 0;
const wkPeOd = (p, k) => { const dn = p["dn" + k], od = +p["od" + k] || 0; return od && +p["od" + k + "Dn"] === +dn ? od : WK_PEOD[dn] || dn; };
const WK_CASING = [100, 125, 150, 200, 250, 300, 350, 400, 450, 500, 600];   // Ø interni tipici dei tubi pozzo (mm)
function wkMotorV1(kw, rpm) {   // motore V1 normalizzato: il primo con potenza ≥ kW; 2 poli sopra i 2000 giri, altrimenti 4 poli
  const M = WK_PUMPS.motor, ks = Object.keys(M).map(Number).sort((a, b) => a - b); if (!ks.length) return null;
  const k = ks.find(x => x >= (+kw || 0) - 1e-6); const row = M[String(k != null ? k : ks[ks.length - 1])]; if (!row) return null;
  const i = rpm && rpm < 2000 ? 1 : 0, m = row[i] || row[1 - i]; if (!m) return null;
  return { kw: k != null ? k : ks[ks.length - 1], L: m[0] / 1000, F: m[1] / 1000, shaft: m[2], size: m[3], kg: m[4], poles: rpm && rpm < 2000 ? 4 : 2 };
}
function wkPumpOf(model, type, kw, rpm, drive) {
  const P = WK_PUMPS; if (!model) return null;
  if (type === "subm") { const s = P.subm[String(model).replace(/\s/g, "")]; return s ? { kind: "subm", D: s[0] / 1000, kg: s[1], L: s[2] / 1000, Lp: s[3] / 1000, Lm: s[4] / 1000 } : null; }
  if (type === "horiz") {
    const h = P.hz[String(model).replace(/\s/g, "").replace(/[A-Z]+$/, "")]; if (!h) return null;
    const mo = kw ? wkMotorV1(kw, rpm) : null;
    return { kind: "horiz", kgP: h[0], Lp: h[1] / 1000, hs: h[2] / 1000, ht: (h[3] || 0) / 1000, w: h[4] / 1000, dnD: h[5], dnS: h[6], motor: mo };
  }
  if (type === "vert") {
    const m = String(model).match(/^P(\d+)([A-Z]+?\d*?)(T\d)?\/([\d-]+)\/(\d+)\/(\d+)([A-Z]*)$/), c = P.cp[model]; if (!m || !c) return null;
    const b = P.bowl["P" + m[1] + m[2] + (m[3] || "") + "/" + m[4]] || P.bowl["P" + m[1] + m[2] + "/" + m[4]]; if (!b) return null;
    const st = +m[6], ex = Math.max(0, st - b[1]), size = +m[1], ser = m[2][0];
    const ls = P.ls[c[0]] || P.ls[c[0] + "/2,5"] || null, diesel = drive === "diesel";
    let hk = !diesel && c[1] ? c[1] : null;
    if (!diesel && !hk) {   // elettrica senza gruppo di comando nelle tabelle d'accoppiamento: quello del catalogo con la stessa colonna e lo stesso albero, flangia del motore
      const mo0 = wkMotorV1(+kw || 0, rpm), fl = mo0 ? ({ 90: 11, 100: 11, 112: 11, 132: 13, 160: 18, 180: 18, 200: 20, 225: 22, 250: 28, 280: 28, 315: 31, 355: 35 })[mo0.size] : 0;
      const re = new RegExp("^E[A-Z]*(\\d+)[A-Z0-9]*/(\\d+)A?/" + m[4].replace(/[-]/g, "\\-") + "L?/" + m[5] + "A?$"), hs = Object.keys(P.head).filter(k => re.test(k));
      hk = hs.sort((a, b) => Math.abs(+a.match(re)[1] - fl) - Math.abs(+b.match(re)[1] - fl) || (mo0 ? Math.abs(+a.match(re)[2] - mo0.shaft) - Math.abs(+b.match(re)[2] - mo0.shaft) : 0))[0] || null;
    }
    const headE = hk ? P.head[hk] : null, gear = c[4] ? P.gear[c[4]] : null, head = headE;
    const [su, vfa] = size === 6 ? ["SUP6", null] : size === 8 ? ["SUP8", null] : size <= 10 ? ["SU6", "VFA6"] : size === 12 ? ["SU8", "VFA8"] : size === 14 ? ["SU9", "VFA9"] : size === 16 ? (ser === "D" ? ["SU12", "VFA16D"] : ["SU10", "VFA16C"]) : ["SU18", null];
    const mo = head ? wkMotorV1(Math.max(+kw || 0, c[3] || 0), rpm) : null, sz = mo ? mo.size : c[2] || 0;
    const tsK = !head ? null : sz <= 180 ? "TSA/2" : sz <= 225 ? "TSB/2" : sz <= 280 ? "TSC/2" : "TSD/2";
    const out = { kind: "vert", bowl: { code: "P" + m[1] + m[2] + (m[3] || "") + "/" + m[4], kg: b[0] + ex * b[2], H: (b[3] + ex * b[4]) / 1000, D: b[5] / 1000, st, F: b[4] / 1000, Df: (b[6] || b[5]) / 1000 },
      ls: ls ? { code: c[0], kg: ls[0], L: ls[1] / 1000, Df: ls[2] / 1000, D: ls[3] / 1000 } : null,
      gearH: gear ? { code: c[4], kg: gear[0], H: gear[1] / 1000, pH: (gear[2] || 550) / 1000, pL: (gear[3] || 550) / 1000, dn: gear[4] || 0, gear: 1, B: (gear[5] || 0) / 1000, C: (gear[6] || 0) / 1000, Dm: (gear[2] || 550) / 1000 * 0.6, J: (gear[9] || 0) / 1000, M: (gear[10] || 0) / 1000, N: gear[11] || 22, P: gear[12] || 8, Q: gear[13] || 18 } : null,
      head: head ? { code: hk, kg: head[0], H: head[1] / 1000, pH: head[2] / 1000, pL: head[3] / 1000, dn: [32, 40, 50, 65, 80, 100, 125, 150, 175, 200, 250, 300, 350, 400, 500].reduce((b, x) => Math.abs(x - head[4]) < Math.abs(b - head[4]) ? x : b, 80), Dm: head[5] / 1000, B: (head[6] || 0) / 1000, C: (head[7] || 0) / 1000, E: (head[8] || 0) / 1000, J: (head[9] || 0) / 1000, M: (head[10] || 0) / 1000, Q: head[11] || 18, P: head[12] || 4, N: head[13] || 22 } : null,
      pul: (() => { const re = new RegExp("^V\\d+[A-Z]/" + m[4].replace(/[-]/g, "\\-") + "L?/" + m[5] + "A?$"), ks = Object.keys(P.pul || {}).filter(k => re.test(k) && !/L\//.test(k)).sort((a, b) => P.pul[b][0] - P.pul[a][0]); const v = ks.length ? P.pul[ks[0]] : null;
        return v ? { code: ks[0], kg: v[0], H: v[1] / 1000, B: v[2] / 1000, C: v[3] / 1000, pH: v[5] / 1000, pL: v[6] / 1000, dn: v[9], P: v[10], Q: v[11], Dm: v[5] / 1000 * 0.7 } : null; })(),
      motor: mo, su: P.acc[su] ? { code: su, kg: P.acc[su][0], H: P.acc[su][1] / 1000, D: P.acc[su][2] / 1000 } : null,
      vfa: vfa && P.acc[vfa] ? { code: vfa, kg: P.acc[vfa][0], H: P.acc[vfa][1] / 1000, D: P.acc[vfa][2] / 1000 } : null,
      ts: tsK && P.ts[tsK] ? { code: tsK, kg: P.ts[tsK][0], H: P.ts[tsK][1] / 1000 } : null };
    if (!out.head && out.gearH) out.head = out.gearH;   // diesel (o nessun gruppo elettrico): rinvio ad angolo
    return out;
  }
  return null;
}

const Q2n = (Q, dn) => { const A = Math.PI * Math.pow((+dn || 200) / 2000, 2); return Math.max(1, Math.min(4, Math.ceil(((+Q || 0) / 3600) / (A * 1.0) - 1e-9))); };   // tubazioni di presa a 1 m/s
// configurazioni d'installazione delle pompe: pozzo · pozzetto con presa da canale o lago · su galleggianti · ad asse orizzontale sulla sponda
const WK_INST = ["well", "sump", "float", "bank", "flooded", "inline"];   // flooded: sotto battente dal reservoir · inline: booster sulla condotta (78.18)
const WK_INST_OF = { vert: ["well", "sump", "float"], subm: ["well", "float"], horiz: ["bank", "float", "flooded", "inline"], moto: ["bank", "float", "flooded"] };
// misure proposte per ogni tavola, dai dati del progetto (ctx) quando ci sono
function wkDefaults(type, ctx) {
  ctx = ctx || {};
  if (type === "pad") return wkPadDefaults(ctx);
  if (type === "moto") {
    const kw = ctx.motoKw || 60, [Ls, Ws, Hs] = wkLerp(WK_MOTO_T, kw);
    return { kw: Math.round(kw), n: ctx.motoN || 1, Ls: wkR(Ls), Ws: wkR(Ws), Hs: wkR(Hs), marg: 0.5, gap: 1.0, H: 0.25, kerb: 0.10, dnS: ctx.dnS || wkDnOf(ctx.qLine || 40), dnD: ctx.dnD || wkDnOf((ctx.qLine || 40)) };
  }
  if (type === "gen") {   // gruppo elettrogeno del catalogo: il primo con potenza ≥ kVA richiesti, nella cofanatura scelta (se manca a quella potenza, la più vicina)
    const kva = ctx.kva || 100, g = wkGenOf(kva, WK_GEN_K.includes(ctx.genK) ? ctx.genK : kva > 500 ? "sb" : "s");
    if (!g) { const [Lg, Wg, Hg] = wkLerp(WK_GEN_T, kva); return { kva: Math.round(kva), genK: "s", Lg: wkR(Lg), Wg: wkR(Wg), Hg: wkR(Hg), kgG: Math.round(450 + 8 * kva), tank: 0, cat: 0, marg: 0.6, H: kva > 300 ? 0.35 : 0.25, kerb: 0.10 }; }
    return { kva: Math.round(kva), kvaC: g.kva, genK: g.enc, Lg: wkR(g.L), Wg: wkR(g.W), Hg: wkR(g.H), kgG: g.kg, tank: g.tank, cat: 1, marg: 0.6, H: g.kg > 4000 ? 0.4 : kva > 300 ? 0.35 : 0.25, kerb: 0.10 };
  }
  if (type === "vpump") {   // una pompa verticale con il dettaglio del catalogo: tutte le parti, con le loro misure e i pesi
    const st = wkDefaults("station", { ...ctx, kind: "vert" }), pu = wkPumpOf(ctx.model, "vert", ctx.motorKw || ctx.stKw, ctx.rpm, ctx.drive);
    const hk0 = pu && pu.head && pu.head.gear ? "gear" : "el", headK = ["el", "gear", "pulley"].includes(ctx.headK) ? ctx.headK : hk0;
    const hdC = pu ? (headK === "gear" ? pu.gearH : headK === "pulley" ? pu.pul : pu.head && !pu.head.gear ? pu.head : null) : null, hd = hdC || (pu && pu.head), hNoCat = pu && !hdC ? 1 : 0, b = pu && pu.bowl, ls = pu && pu.ls, mo = pu && pu.motor, su = pu && pu.su, vf = pu && pu.vfa;
    return { ...st, inst: st.inst === "well" ? "well" : "sump", wellH: wkR(st.lift + Math.max(st.sub, 2.5 * st.D) + 6), headK, Hh: wkR(hd ? hd.H : st.Hh), kgH: hd ? Math.round(hd.kg) : st.kgH, kgM: headK === "el" ? st.kgM : 0, n: 1, nLs: 0, hD: wkR(hd && hd.Dm ? hd.Dm : st.Dm * 0.8, 3), hB: wkR(hd && hd.B ? hd.B : st.Hh * 0.25, 3), hC: wkR(hd && hd.C ? hd.C : st.pL * 0.55, 3), hJ: wkR(hd && hd.J ? hd.J : st.pL * 0.8, 3), hM: wkR(hd && hd.M ? hd.M : st.pL * 0.8, 3), hQ: hd && hd.Q || 18, hP: hd && hd.P || 4, hN: hd && hd.N || 22,
      pH: wkR(hd ? hd.pH : st.pL, 3), pL: wkR(hd ? hd.pL : st.pL, 3), dnH: hd && hd.dn ? hd.dn : st.dnD, lsF: wkR(ls ? ls.Df : st.lsD * 1.6, 3), bA: wkR(b ? b.H : st.Hb * 0.75, 3), bD: wkR(b ? b.D : st.D, 3), bF: wkR(b ? b.F : 0.15, 3), bSt: b ? b.st : 1,
      suA: wkR(su ? su.H : 0.25, 3), suD: wkR(su ? su.D : st.D, 3), vfA: wkR(vf ? vf.H : 0, 3), vfD: wkR(vf ? vf.D : 0, 3), kgSu: su ? su.kg : 0, kgVf: vf ? vf.kg : 0, kgTs: pu && pu.ts ? pu.ts.kg : 0,
      cM: mo && headK === "el" ? mo.kw + " kW · " + mo.poles + " poli · " + mo.size : "", cH: hd && !hNoCat ? hd.code : "", hNoCat, cLs: ls ? ls.code : "", cB: b ? b.code + " · " + b.st : "", cSu: su ? su.code : "", cVf: vf ? vf.code : "", cTs: pu && pu.ts ? pu.ts.code : "" };
  }
  if (type === "filter") {   // batteria di filtri: tipo, numero e taglia dalla portata (valori tipici, da confermare con il fornitore)
    const Q = wkR(ctx.stQ ? ctx.stQ * 3.6 : ctx.Q || 60, 1), fK = WK_FILT_K.includes(ctx.filtK) ? ctx.filtK : "sand", f = wkFiltOf(fK, Q);
    return { fK, Q, n: f.n, sz: f.sz, D: f.D, Hf: f.H, qU: f.q, kgU: f.kg, kgM: f.kgM, dn: f.dn, dnC: wkDnOf(Q / 3.6), H: 0.25, marg: 0.6, Qs: wkR(f.n * f.q, 1) };
  }
  if (type === "set") {   // gruppo completo su una platea: gruppo elettrogeno, pompa (elettrica o motopompa), batteria di filtri
    const isV = ctx.kind === "vert" && ctx.stType !== "moto";   // stazione con la pompa verticale (78.29): nel gruppo va la verticale (componente «vpump»), non una pompa di superficie
    const kind = ctx.kind === "moto" || ctx.stType === "moto" || ctx.drive === "diesel" ? "moto" : "horiz", st = wkDefaults("station", { ...ctx, kind, inst: "bank", stN: 1, model: isV ? "" : ctx.model });
    const fl = wkDefaults("filter", ctx), g = wkDefaults("gen", { ...ctx, kva: ctx.kva || Math.max(20, Math.round((ctx.stKw || 30) * 1.6)) });
    const pe = kind === "horiz" ? st : wkDefaults("station", { ...ctx, kind: "horiz", inst: "bank", stN: 1 }), pm = kind === "moto" ? st : wkDefaults("station", { ...ctx, kind: "moto", inst: "bank", stN: 1 });
    const PU = (q) => ({ Lu: q.Lu, Wu: q.Wu, Hu: q.Hu, hLp: q.hLp, hHs: q.hHs, mL: q.mL, kgU: q.kgU, dnO: q.dnO, dnI: q.dnI, kwE: q.kwE || 0, poE: q.poE || 0, ieE: q.ieE || 0, vE: q.vE || 0, hzE: q.hzE || 0 });
    return { kind, vert: isV ? 1 : 0, pv: wkDefaults("vpump", { ...ctx, model: ctx.vModel || (isV ? ctx.model || "" : ""), water: ctx.water === "well" ? "well" : "surf", stN: 1 }), moto: st.moto, model: st.model, cat: st.cat, Lu: st.Lu, Wu: st.Wu, Hu: st.Hu, hLp: st.hLp, hHs: st.hHs, mL: st.mL, kgU: st.kgU, dnS: st.dnS, dnD: st.dnD, dnC: st.dnC, lift: st.lift,
      ...(ctx.pvX != null ? (() => { const pd = wkPadDefaults(ctx); return { pvX: ctx.pvX, pvY: ctx.pvY, pvLab: ctx.pvLab || "", pvL: pd.L || pd.Bx || 4.25, pvB: pd.B || pd.Bx || 3.4, pvT: pd.tube, pvProf: ctx.prof === "ultra" ? "ultra" : pd.prof, pvMk: pd.mk, pvPp: pd.pp }; })() : {}), src: ctx.water === "well" ? "well" : "canal", sucL: 3, srcTip: 0, pvPan: "s", fK: fl.fK, Q: fl.Q, fn: fl.n, fsz: fl.sz, fD: fl.D, fH: fl.Hf, fq: fl.qU, fkg: fl.kgU, fkgM: fl.kgM, fdn: fl.dn, hasP: 1, hasF: 1, hasG: kind === "moto" ? 0 : 1, kva: g ? g.kva : 0, genK: g ? g.genK : "s", Lg: g ? g.Lg : 0, Wg: g ? g.Wg : 0, Hg: g ? g.Hg : 0, kgG: g ? g.kgG : 0, H: 0.3, marg: 0.6, pe: PU(pe), pm: PU(pm) };
  }
  if (type === "pivotSet") {   // il pivot con la sua piazzola e accanto il gruppo di pompaggio: pompa verticale in pozzo, motopompa, gruppo elettrogeno
    const pad = wkPadDefaults(ctx), v = wkDefaults("station", { ...ctx, kind: "vert", water: "well" }), mo = wkDefaults("moto", ctx), g = wkDefaults("gen", { ...ctx, kva: ctx.kva || Math.max(20, Math.round((ctx.stKw || ctx.motorKw || 30) * 1.6)) });   // gruppo elettrogeno dalla potenza del motore, come nel gruppo completo (78.29)
    const hasV = ctx.stKind ? (ctx.stKind === "vert" ? 1 : 0) : 1, hasM = ctx.stKind === "moto" || (ctx.drive === "diesel" && ctx.stKind === "vert") ? 1 : 0, hasG = ctx.kva ? 1 : (ctx.drive === "diesel" ? 0 : 1);
    return { ...pad, padL: pad.L, wX: ctx.wX, wY: ctx.wY, farD: ctx.farD || 0, hasV, hasM, hasG, dist: 1.5, distG: 2.0, lift: v.lift, D: v.D, Hh: v.Hh, pLv: v.pL, Hm: v.Hm, Dm: v.Dm, lsD: v.lsD, kgV: Math.round(v.kgM + v.kgH + v.kgB + v.kgA + v.kgT + Math.max(1, Math.ceil((v.lift + v.sub) / v.lsL)) * v.kgLs),
      wellD: WK_CASING.find(x => x / 1000 >= v.D + 0.06) || 600, dnP: wkDnStd(ctx.dnD, ctx.stQ) || v.dnD, odP: wkOdOf(ctx.dnD), odPDn: wkDnStd(ctx.dnD, ctx.stQ) || v.dnD, kw: mo.kw, mLs: mo.Ls, mWs: mo.Ws, mHs: mo.Hs, kgM: Math.round(14 * mo.kw + 250), kva: g.kvaC || g.kva, wSrc: ctx.water && ctx.water !== "well" ? "sump" : "well", Lg: g.Lg, Wg: g.Wg, Hg: g.Hg, kgG: g.kgG || Math.round(450 + 8 * g.kva), genK: g.genK, model: ctx.model || "" };
  }
  if (type === "reservoir") {   // RESERVOIR (78.18): dalla stazione che ne preleva (consumo × giorni di riserva); bacino in terra col motore di Nereus
    const rv = ctx.rv && ctx.rv.ok ? ctx.rv : null, rType = rv ? rv.type : "earth", qR = ((rv ? rv.Q : 100) || 100) / 3.6, dn = wkDnStd(ctx.dnOut, qR) || wkDnOf(qR);   // DN della EN 1092-1 per saracinesca e kit flangia (78.29)
    return { rType, V: Math.round(rv ? rv.V : 2200), H: wkR(rv ? rv.H : rType === "steel" ? 3.6 : rType === "conc" ? 3 : 4, 2), soil: rv && rv.soil ? rv.soil : "loam", mode: rv && rv.mode ? rv.mode : "eff",
      Vday: Math.round(rv ? rv.Vday : 2000), days: rv ? rv.days : 1, fillQ: wkR(rv ? rv.fillQ : 90, 1), dnIn: wkDnStd(ctx.dnIn, (rv ? rv.fillQ : 90) / 3.6) || dn, dnOut: dn,
      odIn: wkOdOf(ctx.dnIn), odInDn: wkDnStd(ctx.dnIn, (rv ? rv.fillQ : 90) / 3.6) || dn, odOut: wkOdOf(ctx.dnOut), odOutDn: dn };   // Ø reale del PE per le etichette (78.30)
  }
  // stazione di pompaggio: con la pompa del catalogo (modello) misure e pesi del costruttore; senza, ingombri tipici per potenza
  const n = ctx.stN || 2, kw = ctx.stKw || 30, kind = ctx.kind || (ctx.stType === "moto" ? "moto" : "horiz"), moto = kind === "moto";
  const qTot = ctx.stQ || 60, dnS = wkDnStd(ctx.dnS, qTot / n) || wkDnOf(qTot / n), dnD = wkDnStd(ctx.dnD, qTot / n) || wkDnOf(qTot / n), dnC = wkDnStd(ctx.dnC, qTot) || wkDnOf(qTot), lift = ctx.lift != null ? ctx.lift : 3;   // DN flangiati, non Ø del PE (78.29)
  const pu = wkPumpOf(ctx.model, kind, ctx.motorKw || kw, ctx.rpm, ctx.drive), instOk = WK_INST_OF[kind] || WK_INST_OF.horiz;
  const inst = instOk.includes(ctx.inst) ? ctx.inst : ctx.water === "well" && instOk.includes("well") ? "well" : instOk.includes("sump") ? "sump" : kind === "subm" ? "float" : "bank";
  const base = { kind, n, dnS, dnD, dnC, odC: wkOdOf(ctx.dnC), odCDn: dnC, lift, rvT: ctx.rvType || "", Q: wkR(qTot * 3.6, 1), model: ctx.model || "", kwE: !moto && +ctx.motorKw > 0 ? +ctx.motorKw : 0, poE: +ctx.motorPoles || 0, ieE: +ctx.motorIE || 0, vE: +ctx.motorV || 0, hzE: +ctx.motorHz || 0, stE: ["dol", "yd", "soft", "vfd"].includes(ctx.motorStart) ? ctx.motorStart : "", cat: pu ? 1 : 0, well: inst === "well" ? 1 : 0, inst, batt: ctx.batt != null && ctx.batt !== "" ? +ctx.batt : 0.5, pIn: +ctx.pIn || 0, canW: 4, canD: 1.5, intL: 6, sF: "pipe", sFl: "low", dFl: 0.5, bmF: 2, slope: 1.5, shore: kind === "vert" ? 12 : 8, fD: kind === "vert" ? 1.0 : 0.6 };   // pontone delle verticali: galleggianti Ø 1 m (77.76)
  if (kind === "subm") {
    const D = pu ? pu.D : wkR(0.14 + 0.002 * kw), L = pu ? pu.L : wkR(1.2 + 0.03 * kw), Lm = pu ? pu.Lm : wkR(L * 0.45);
    const wd = WK_CASING.find(x => x / 1000 >= D + 0.05) || 600;
    return { ...base, D: wkR(D, 3), L: wkR(L), Lm: wkR(Lm), kgP: pu ? pu.kg : Math.round(30 + 6 * kw), imm: 3, wellD: wd, H: 0.25, riserKg: wkR(wkPipeKg(dnD), 1) };
  }
  if (kind === "vert") {
    const b = pu && pu.bowl, hd = pu && pu.head, mo = pu && pu.motor, su = pu && (pu.vfa || pu.su), ls = pu && pu.ls;
    const D = wkR(Math.max(b ? b.D : 0.2 + 0.002 * kw, su ? su.D : 0), 3);
    return { ...base, D, Hb: wkR(b ? b.H + (su ? su.H : 0) : 0.8, 2), Hh: wkR(hd ? hd.H : 0.6), pL: wkR(hd ? Math.max(hd.pL, hd.pH) : 0.5), Hm: wkR(mo ? mo.L : (hd && hd.gear ? 0.4 : 0.6 + 0.004 * kw)), Dm: wkR(mo ? mo.F : 0.35 + 0.001 * kw),
      bA: wkR(b ? b.H : 0.6, 3), bSt: b ? b.st : 2,   // corpo pompa del catalogo (77.80): altezza senza succheruola e numero di stadi
      lsL: ls ? ls.L : 3.05, lsD: wkR(ls ? ls.D : wkDnOf(qTot / n) / 1000, 3), sub: wkR(2.5 * D), floor: wkR(0.5 * D), gear: hd && hd.gear ? 1 : 0,
      dnH: hd && hd.dn ? hd.dn : 0,   // bocca di mandata della testata del catalogo (78.29)
      kgB: b ? Math.round(b.kg) : Math.round(40 + 3 * kw), kgH: hd ? Math.round(hd.kg) : 120, kgM: mo ? Math.round(mo.kg) : hd && hd.gear ? 0 : Math.round(8 * kw), kgLs: ls ? ls.kg : 60, kgA: Math.round((pu && pu.su ? pu.su.kg : 0) + (pu && pu.vfa ? pu.vfa.kg : 0)), kgT: pu && pu.ts ? Math.round(pu.ts.kg) : 0, H: 0.30 };
  }
  let Lu, Wu, Hu, kgU;
  if (kind === "horiz" && pu) { const mo = pu.motor; Lu = pu.Lp + 0.12 + (mo ? mo.L : 0.6); Wu = Math.max(pu.w, mo ? mo.F : 0.3) + 0.1; Hu = pu.hs + Math.max(pu.ht, mo ? mo.F / 2 : 0.2); kgU = Math.round(pu.kgP + (mo ? mo.kg : 0) + 0.12 * (pu.kgP + (mo ? mo.kg : 0))); }
  else [Lu, Wu, Hu] = moto ? wkLerp(WK_MOTO_T, kw) : [Math.min(2.8, 1.0 + 0.008 * kw), Math.min(1.2, 0.55 + 0.0025 * kw), Math.min(1.5, 0.7 + 0.004 * kw)];
  const mo1 = kind === "horiz" && pu ? pu.motor : null, hLp = pu && kind === "horiz" ? pu.Lp : Lu * (moto ? 0.3 : 0.4), mL = mo1 ? mo1.L : pu && kind === "horiz" ? 0.6 : Lu - hLp - (moto ? 0.08 : 0.12);
  const dnO = kind === "horiz" && pu && pu.dnD ? pu.dnD : WK_DN[Math.max(0, WK_DN.indexOf(WK_DN.find(x => x >= dnD) || dnD) - 1)] || dnD;   // bocca di mandata della pompa: dal catalogo, altrimenti una taglia sotto la tubazione
  const dnI = kind === "horiz" && pu && pu.dnS ? pu.dnS : WK_DN[Math.max(0, WK_DN.indexOf(WK_DN.find(x => x >= dnS) || dnS) - 1)] || dnS;   // bocca d'aspirazione della pompa
  return { ...base, dnO, dnI, moto: moto ? 1 : 0, Lu: wkR(Lu), Wu: wkR(Wu), Hu: wkR(Hu), hLp: wkR(hLp), hHs: wkR(pu && kind === "horiz" ? pu.hs : Hu * (moto ? 0.36 : 0.45)), mL: wkR(mL), kgU: kgU || Math.round((moto ? 14 : 9) * kw + 60), gap: moto ? 1.2 : 1.0, H: 0.30, panel: moto ? 0 : 1 };
}


// ---- DISEGNI DELLE MACCHINE in prospetto, come le tavole del catalogo (metri; y verso l'alto; Y = trasformazione delle quote per le sezioni interrotte) ----
const wkPg = (pts, f, s, w) => ({ t: "pg", pts, f: f == null ? 255 : f, s: s || "m", w });
// disegno di una parte presa dalle tavole del catalogo (WK_ART): mx, my portano le coordinate della parte (pt) in metri; Y = interruzione delle sezioni profonde
const wkArt = (name, mx, my, Y, wm) => {   // wm: spessore del tratto in metri (0,4 pt del catalogo nella scala della parte)
  const a = WK_ART[name], Yf = Y || ((v) => v), P = (u, v) => [mx(u / 100), Yf(my(v / 100))], out = [];
  if (!a) return out;
  if (a.sil && a.sil.length > 4) { const q = []; for (let i = 0; i < a.sil.length; i += 2) q.push(P(a.sil[i], a.sil[i + 1])); out.push(wkPg(q, 255, "-")); }
  a.it.forEach(it => { const q = []; for (let i = 3; i < it.length; i += 2) q.push(P(it[i], it[i + 1]));
    if (it[0] >= 0) out.push(wkPg(q, it[0], it[1] ? "a" : "-")); else if (it[1]) out.push(Lgs(it[2] ? q.concat([q[0]]) : q, "a")); });
  if (wm) out.forEach(o => { o.wm = wm; });
  return out;
};
// verticale: v (pt, dall'alto) → y (m, verso l'alto) con le estremità in scala k e il tratto centrale [z0, z1] allungato fino all'altezza H
const wkVmap = (yTop, a, H, k, z0, z1) => {
  const v0 = a.v0 / 100, v1 = a.v1 / 100, hp = v1 - v0;
  if (z0 == null || !(k > 0)) return (v) => yTop - (v - v0) / hp * H;
  const ends = (z0 - v0 + v1 - z1) * k, km = (H - ends) / (z1 - z0);
  if (!(km > k * 0.15)) return (v) => yTop - (v - v0) / hp * H;
  return (v) => v <= z0 ? yTop - (v - v0) * k : v <= z1 ? yTop - (z0 - v0) * k - (v - z0) * km : yTop - (z0 - v0) * k - (z1 - z0) * km - (v - z1) * k;
};
const WK_GEN_K = ["open", "sv", "s", "sb"];
function wkGenOf(kva, enc) {   // riga del catalogo dei gruppi elettrogeni: misure in m
  if (typeof WK_GEN === "undefined" || !WK_GEN.length) return null;
  const rows = WK_GEN.filter(r => r[0] >= kva - 0.01), row0 = rows.length ? rows[0] : WK_GEN[WK_GEN.length - 1];
  const same = WK_GEN.filter(r => r[0] === row0[0]), withK = same.filter(r => r[1][enc]);
  const pickRow = withK.length ? withK.sort((a, b) => a[1][enc][1] - b[1][enc][1])[0] : same[0];
  const k = pickRow[1][enc] ? enc : enc === "open" ? (pickRow[1].open ? "open" : Object.keys(pickRow[1])[0]) : ["s", "sb", "sv", "open"].find(x => pickRow[1][x]);
  const v = pickRow[1][k]; return { kva: pickRow[0], enc: k, tank: v[0], L: v[1] / 1000, W: v[2] / 1000, H: v[3] / 1000, kg: v[4] };
}

// ---- ACCESSORI DELLE TUBAZIONI: consigliati in automatico lungo la mandata o aggiunti a mano e trascinati sulla tavola ----
// scartamento (mm) per DN: ritegno wafer a doppio battente EN 558 s.16, farfalla wafer s.20, saracinesca a corpo piatto s.14, giunto di smontaggio, giunto antivibrante, misuratore elettromagnetico
const WK_DN = [50, 65, 80, 100, 125, 150, 200, 250, 300, 350, 400, 500];
const WK_FLD = [165, 185, 200, 220, 250, 285, 340, 405, 460, 520, 580, 715];   // Ø esterno delle flange PN 16 (EN 1092-1)
const WK_ACC = {   // [sigla, scartamento mm per DN, peso kg per DN (stima PN 16)]
  flex: ["GA", [105, 115, 130, 135, 170, 180, 205, 240, 260, 265, 265, 265], [3, 4, 5, 6, 8, 10, 15, 22, 30, 38, 48, 70]],
  check: ["VR", [43, 46, 64, 64, 70, 76, 89, 114, 114, 127, 140, 152], [1.5, 2, 3, 4, 6, 8, 14, 23, 33, 45, 60, 95]],
  wafer: ["VF", [43, 46, 46, 52, 56, 56, 60, 68, 78, 78, 102, 127], [2.5, 3, 3.5, 4.5, 6, 7.5, 12, 17, 25, 35, 48, 80]],
  gate: ["SR", [150, 170, 180, 190, 200, 210, 230, 250, 270, 290, 310, 350], [11, 14, 18, 24, 32, 40, 65, 95, 130, 180, 240, 380]],
  joint: ["GS", [200, 200, 200, 200, 220, 220, 230, 250, 250, 260, 260, 280], [8, 10, 12, 15, 19, 23, 33, 45, 60, 75, 95, 140]],
  meter: ["MP", [200, 200, 200, 250, 250, 300, 350, 450, 500, 550, 600, 650], [9, 11, 13, 16, 20, 25, 38, 55, 75, 95, 120, 180]],
  red: ["RD", [127, 127, 140, 152, 178, 190, 203, 330, 356, 356, 356, 508], [2, 2.5, 3, 4, 5, 7, 10, 16, 22, 30, 38, 60]],
  hyd: ["IV", [230, 290, 310, 350, 400, 480, 600, 730, 850, 980, 1100, 1250], [10, 14, 18, 26, 38, 55, 95, 160, 240, 330, 450, 700]],   // idrovalvola flangiata a globo con il pilota (EN 558 serie 1)
  gauge: ["MN", null, [0.8]], air: ["SF", null, [3, 3, 3, 3, 5, 5, 5, 8, 8, 8, 12, 12]], foot: ["VD", [170, 190, 200, 230, 260, 290, 340, 400, 460, 520, 580, 700], [6, 8, 10, 14, 19, 25, 40, 60, 85, 115, 150, 240]],
};
const WK_ACC_K = Object.keys(WK_ACC);
const wkDnI = (dn) => { let b = 0; WK_DN.forEach((d, i) => { if (Math.abs(d - dn) < Math.abs(WK_DN[b] - dn)) b = i; }); return b; };
const wkAccL = (k, dn) => { const a = WK_ACC[k]; return a && a[1] ? a[1][wkDnI(dn)] / 1000 : 0; };
const wkAccKg = (k, dn) => { const a = WK_ACC[k]; return a ? (a[2].length === 1 ? a[2][0] : a[2][wkDnI(dn)]) : 0; };
// simbolo in prospetto: asse del tubo lungo u (angolo ang in gradi), v perpendicolare; x, y = centro
function wkAccDraw(k, x, y, dn, ang) {
  const it = [], a = (ang || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), P = (u, v) => [x + u * ca - v * sa, y + u * sa + v * ca];
  const d = dn / 1000, Df = WK_FLD[wkDnI(dn)] / 1000, tf = Math.max(0.016, 0.07 * Df), L = wkAccL(k, dn) || 0.1, wm = Math.max(0.0015, Df * 0.012);
  const B = (u0, v0, u1, v1, f) => wkPg([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], f == null ? 255 : f, "a"), Pg = (pts, f) => wkPg(pts.map(q => P(q[0], q[1])), f == null ? 255 : f, "a"), Ln = (pts) => Lgs(pts.map(q => P(q[0], q[1])), "a");
  const fl = (u0) => { it.push(B(u0, -Df / 2, u0 + tf, Df / 2, 236)); [-0.36, 0.36].forEach(f => it.push(Ln([[u0 - tf * 0.4, f * Df], [u0 + tf * 1.4, f * Df]]))); };   // flangia con i bulloni
  if (k === "check") {   // ritegno wafer a doppio battente fra due flange
    fl(-L / 2 - tf); fl(L / 2); it.push(B(-L / 2, -Df * 0.4, L / 2, Df * 0.4, 244), Ln([[-L * 0.3, 0], [L * 0.3, 0]]), Pg([[L * 0.3, 0], [L * 0.1, Df * 0.09], [L * 0.1, -Df * 0.09]], 60));
    it.push({ t: "c", x: P(0, Df * 0.25)[0], y: P(0, Df * 0.25)[1], r: Df * 0.05, s: "a" });
  } else if (k === "wafer") {   // farfalla wafer con albero e riduttore a volantino
    fl(-L / 2 - tf); fl(L / 2); it.push(B(-L / 2, -Df * 0.42, L / 2, Df * 0.42, 244), Ln([[0, -Df * 0.3], [0, Df * 0.3]]));
    it.push(B(-Df * 0.04, Df * 0.42, Df * 0.04, Df * 0.75, 255), B(-Df * 0.16, Df * 0.75, Df * 0.16, Df * 0.95, 225), B(-Df * 0.3, Df * 0.98, Df * 0.3, Df * 1.03, 255), Ln([[0, Df * 0.95], [0, Df * 0.98]]));
  } else if (k === "gate") {   // saracinesca a corpo piatto con cappello, asta e volantino
    fl(-L / 2); fl(L / 2 - tf); it.push(B(-L / 2 + tf, -d * 0.6, L / 2 - tf, d * 0.6, 244), Pg([[-L * 0.32, d * 0.6], [L * 0.32, d * 0.6], [L * 0.2, Df * 0.95], [-L * 0.2, Df * 0.95]], 236));
    it.push(B(-Df * 0.025, Df * 0.95, Df * 0.025, Df * 1.25, 255), B(-Df * 0.45, Df * 1.25, Df * 0.45, Df * 1.31, 225));
  } else if (k === "joint") {   // giunto di smontaggio: due flange, manicotto telescopico, tiranti
    fl(-L / 2); fl(L / 2 - tf); it.push(B(-L / 2 + tf, -d * 0.58, 0.1 * L, d * 0.58, 250), B(-0.05 * L, -d * 0.66, L / 2 - tf, d * 0.66, 238), B(-0.12 * L, -d * 0.72, 0.02 * L, d * 0.72, 225));
    [-0.4, 0.4].forEach(f => it.push(Ln([[-L / 2 - tf * 0.5, f * Df], [L / 2 + tf * 0.5, f * Df]])));
  } else if (k === "flex") {   // giunto antivibrante in gomma a sfera
    fl(-L / 2); fl(L / 2 - tf); const up = [], dw = []; for (let i = 0; i <= 12; i++) { const f = i / 12, u = -L / 2 + tf + f * (L - 2 * tf), r = d * 0.55 + d * 0.22 * Math.sin(f * Math.PI); up.push([u, r]); dw.push([u, -r]); }
    it.push(Pg(up.concat(dw.reverse()), 70));
  } else if (k === "meter") {   // misuratore di portata elettromagnetico con il convertitore
    fl(-L / 2); fl(L / 2 - tf); it.push(B(-L / 2 + tf, -Df * 0.45, L / 2 - tf, Df * 0.45, 244), B(-Df * 0.06, Df * 0.45, Df * 0.06, Df * 0.62, 255), B(-Df * 0.22, Df * 0.62, Df * 0.22, Df * 0.9, 236), { t: "c", x: P(0, Df * 0.76)[0], y: P(0, Df * 0.76)[1], r: Df * 0.08, s: "a" });
  } else if (k === "red") {   // riduzione eccentrica (DN e DN della pompa)
    fl(-L / 2); fl(L / 2 - tf); it.push(Pg([[-L / 2 + tf, -d * 0.55], [L / 2 - tf, -d * 0.55], [L / 2 - tf, d * 0.55], [-L / 2 + tf, d * 0.3]], 248));
  } else if (k === "hyd") {   // idrovalvola a globo: corpo panciuto fra le flange, cappello del diaframma, circuito del pilota con il pilota e il filtrino
    fl(-L / 2); fl(L / 2 - tf); const ub = [], db = []; for (let i = 0; i <= 12; i++) { const f = i / 12, u = -L / 2 + tf + f * (L - 2 * tf), r = d * 0.5 + d * 0.32 * Math.sin(f * Math.PI); ub.push([u, r]); db.push([u, -r]); }
    it.push(Pg(ub.concat(db.reverse()), 244), B(-L * 0.24, d * 0.8, L * 0.24, d * 0.98, 236), Pg([[-L * 0.3, d * 0.98], [L * 0.3, d * 0.98], [L * 0.22, d * 1.2], [-L * 0.22, d * 1.2]], 225));
    it.push(Ln([[-L * 0.38, d * 0.55], [-L * 0.38, d * 1.5], [L * 0.38, d * 1.5], [L * 0.38, d * 0.55]]), B(-L * 0.08, d * 1.42, L * 0.08, d * 1.62, 255), { t: "c", x: P(L * 0.25, d * 1.5)[0], y: P(L * 0.25, d * 1.5)[1], r: d * 0.06, s: "a" });
  } else if (k === "gauge") {   // manometro con rubinetto
    it.push(B(-d * 0.08, d * 0.55, d * 0.08, d * 0.55 + 0.08, 255), B(-0.025, d * 0.55 + 0.08, 0.025, d * 0.55 + 0.1, 225), { t: "c", x: P(0, d * 0.55 + 0.16)[0], y: P(0, d * 0.55 + 0.16)[1], r: 0.06, s: "a" }, Ln([[0, d * 0.55 + 0.16], [0.035, d * 0.55 + 0.19]]));
  } else if (k === "air") {   // sfiato automatico con valvola d'intercettazione
    it.push(B(-0.03, d * 0.55, 0.03, d * 0.55 + 0.06, 225), Pg([[-0.06, d * 0.55 + 0.06], [0.06, d * 0.55 + 0.06], [0.05, d * 0.55 + 0.2], [-0.05, d * 0.55 + 0.2]], 244), B(-0.02, d * 0.55 + 0.2, 0.02, d * 0.55 + 0.24, 255));
  } else if (k === "foot") {   // valvola di fondo con succheruola (77.90): flangia verso il tubo, corpo panciuto con l'otturatore a clapet incernierato, anello, succheruola a cestello Ø 1,6 DN con le asole e il fondo forato (la bocca)
    const u0 = -L / 2 + tf, u1 = -L / 2 + 0.44 * L, u2 = u1 + tf * 0.8, rs = d * 0.8, ub = [], db = [];
    fl(-L / 2); for (let i = 0; i <= 12; i++) { const f = i / 12, u = u0 + f * (u1 - u0), r = d * 0.55 + d * 0.26 * Math.sin(f * Math.PI) - d * 0.05 * f; ub.push([u, r]); db.push([u, -r]); }
    it.push(Pg(ub.concat(db.reverse()), 244), Ln([[u0 + (u1 - u0) * 0.62, -d * 0.5], [u0 + (u1 - u0) * 0.62, d * 0.5]]));   // sede con il clapet chiuso
    it.push({ t: "c", x: P(u0 + (u1 - u0) * 0.62, d * 0.5)[0], y: P(u0 + (u1 - u0) * 0.62, d * 0.5)[1], r: d * 0.045, s: "a" }, B(u1, -d * 0.62, u2, d * 0.62, 225));   // cerniera e anello
    it.push(B(u2, -rs, L / 2 - tf * 0.5, rs, 170), B(L / 2 - tf * 0.5, -rs, L / 2, rs, 120));   // cestello e fondo
    const ua = u2 + (L / 2 - u2) * 0.12, ue = L / 2 - tf * 0.5 - (L / 2 - u2) * 0.1; [-0.66, -0.33, 0, 0.33, 0.66].forEach(f => it.push(Lgs([P(ua, f * rs), P(ue, f * rs)], "wh")));   // asole
  }
  it.forEach(o => { if (o.s !== "wh") o.wm = wm; });
  return it;
}
// accessori consigliati per tipo di tavola, nell'ordine dalla pompa verso la rete
const wkAccRec = (kind, o) => (kind === "subm" ? ["check", "wafer", "gauge", "air", "joint"] : kind === "vert" ? ["flex", "check", "wafer", "joint", "gauge", "air"] : ["flex", "check", "wafer", "joint", "gauge"]).concat(o && o.meter ? ["meter"] : []);
// posa lungo la mandata: path = punti del tubo dalla pompa; restituisce [{k, dn, x, y, r}]
function wkAccAlong(path, keys, dn, s0) {
  // tratti dritti fra i gomiti (77.61): stesso raggio del disegno (asse 1,5 × Ø esterno), così un accessorio non finisce sulla curva
  const odm = Math.max(0.05, (dn || 100) / 1000 * 1.1), Ln = (i) => Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  const Tv = path.map((q, j) => { if (j === 0 || j === path.length - 1) return 0; const a = path[j - 1], b = path[j + 1], l1 = Ln(j), l2 = Ln(j + 1); if (l1 < 1e-6 || l2 < 1e-6) return 0;
    const c = ((q[0] - a[0]) * (b[0] - q[0]) + (q[1] - a[1]) * (b[1] - q[1])) / (l1 * l2), th = Math.acos(Math.max(-1, Math.min(1, c))); if (th < 0.02) return 0;
    const tn = Math.tan(th / 2), lim = Math.min((j === 1 ? 0.92 : 0.45) * l1, (j === path.length - 2 ? 0.92 : 0.45) * l2); return Math.min(odm * 1.5, lim / tn) * tn + 0.05; });
  const segs = []; for (let i = 1; i < path.length; i++) { const a0 = path[i - 1], b0 = path[i], L0 = Ln(i); if (L0 < 1e-6) continue; const ux = (b0[0] - a0[0]) / L0, uy = (b0[1] - a0[1]) / L0, t0 = Tv[i - 1], t1 = Tv[i], L = L0 - t0 - t1;
    if (L > 0.05) segs.push({ a: [a0[0] + ux * t0, a0[1] + uy * t0], b: [b0[0] - ux * t1, b0[1] - uy * t1], L, ang: Math.atan2(b0[1] - a0[1], b0[0] - a0[0]) * 180 / Math.PI }); }
  const out = [], used = segs.map(() => 0); let si = 0, s = s0 == null ? 0.2 : s0;
  const put = (k, g, at, l) => out.push({ k, dn, x: wkR(g.a[0] + (g.b[0] - g.a[0]) * (at + l / 2) / g.L, 3), y: wkR(g.a[1] + (g.b[1] - g.a[1]) * (at + l / 2) / g.L, 3), r: Math.round(g.ang) });
  keys.forEach(k => { const l = Math.max(0.16, wkAccL(k, dn) + 0.1);
    while (si < segs.length && s + l > segs[si].L) { s = 0.12; si++; }
    if (si >= segs.length) {   // in fila non ci sta più: nel primo tratto con spazio libero dopo gli altri accessori (77.63)
      const lk = k === "gauge" ? 0.08 : Math.max(0.1, wkAccL(k, dn) + 0.03), fr = segs.map((g, i) => g.L - used[i]), j = fr.indexOf(Math.max(...fr));   // il manometro è una presa: basta un palmo di tubo
      if (j >= 0 && fr[j] >= lk + 0.04) { put(k, segs[j], used[j] + Math.max(0.02, (fr[j] - lk) / 2), lk); used[j] = segs[j].L; } return; }
    put(k, segs[si], s, l); s += l + 0.14; used[si] = s; });
  return out;
}
// accessori di una vista: quelli scelti a mano (p.acc) oppure i consigliati; ognuno è un gruppo trascinabile "a<i>"
function wkAccPut(items, pos, list, t) {
  (list || []).forEach((a, i) => { const g = "a" + i; pos[g] = [a.x, a.y];
    const sym = wkAccDraw(a.k, a.x, a.y, a.dn, a.r), rr = (a.r || 0) * Math.PI / 180, off = (WK_FLD[wkDnI(a.dn)] / 1000) * (a.k === "gate" ? 1.45 : a.k === "wafer" ? 1.15 : 0.75) + 0.08;
    const up = a.up || a.k === "gauge" || a.k === "air" || i % 2 === 0, off2 = up ? off : -((WK_FLD[wkDnI(a.dn)] / 1000) * 0.75 + 0.14), tx = a.up ? a.x : a.x - Math.sin(rr) * off2, ty = a.up ? a.y + Math.abs(Math.cos(rr)) * off + Math.abs(Math.sin(rr)) * 0.12 : a.y + Math.cos(rr) * off2;   // up: sempre sopra il tubo   // sigle alternate sopra e sotto il tubo
    sym.push({ t: "x", x: tx, y: ty, s: (WK_ACC[a.k] ? WK_ACC[a.k][0] : "?") + (i + 1), h: 1.9, al: "c" });
    items.push(...sym.map(o => ({ ...o, g })));
  });
}
function wkAccQty(qty, notes, list, t) {   // una riga di quantità (peso) e la legenda delle sigle nelle note
  if (!list || !list.length) return;
  let kg = 0; const leg = list.map((a, i) => { const w = wkAccKg(a.k, a.dn); kg += w; return (WK_ACC[a.k] ? WK_ACC[a.k][0] : "?") + (i + 1) + " " + wkLc(t, t("wk_acc_" + a.k)) + (WK_ACC[a.k] && WK_ACC[a.k][1] ? " DN " + a.dn : "") + " (" + (Math.round(w * 10) / 10).toString().replace(".", WK_DEC) + " kg)"; });
  qty.push([t("wk_qKgAcc").replace("{n}", list.length), Math.round(kg), "kg"]); notes.push(t("wk_nAcc") + " " + leg.join(" · ") + ".");
}
// acqua in esercizio (kg): tubo pieno per DN, colonna della linea d'asse (Ø interno ~ 0,92 dell'esterno, meno l'albero), corpo pompa, accessori
const wkPipeWater = (dn) => { const od = { 50: 60.3, 65: 76.1, 80: 88.9, 100: 114.3, 125: 139.7, 150: 168.3, 200: 219.1, 250: 273, 300: 323.9 }[dn] || dn * 1.1, t = od < 120 ? 4 : od < 200 ? 5 : 6.3; return Math.PI * Math.pow((od - 2 * t) / 1000, 2) / 4 * 1000; };
const WK_HEB = [[100, 100, 89.9, 450, 20.4], [120, 120, 144, 864, 26.7], [140, 140, 216, 1510, 33.7], [160, 160, 311, 2490, 42.6], [180, 180, 426, 3830, 51.2], [200, 200, 570, 5700, 61.3], [220, 220, 736, 8090, 71.5], [240, 240, 938, 11260, 83.2], [260, 260, 1150, 14920, 93], [280, 280, 1380, 19270, 103], [300, 300, 1680, 25170, 117], [320, 300, 1930, 30820, 127], [340, 300, 2160, 36660, 134], [360, 300, 2400, 43190, 142], [400, 300, 2880, 57680, 155], [450, 300, 3550, 79890, 171], [500, 300, 4290, 107200, 187]];   // HEB: h, b mm, Wy cm³, Iy cm⁴, kg/m
// coppia di travi sotto le pompe: luce L m, peso in esercizio kg per pompa, nP pompe sulla stessa coppia; S275 con 160 MPa ammissibili, carico × 1,5, freccia ≤ L/1000, almeno HEB 120
function wkBeam(L, kg, nP, hMin) { const P = kg * 9.81 / 2, Lm = L * 1000, k = nP > 1 ? 8 : 4;   // hMin (77.88): altezza minima del profilo, mm
  for (const b of WK_HEB) { if (b[0] < Math.max(120, hMin || 0)) continue; const q = b[4] * 9.81 / 1000, M = 1.5 * (nP * P * Lm / k) + q * Lm * Lm / 8, f = (nP > 1 ? 5 * nP * P / Lm * Math.pow(Lm, 4) / 384 : P * Math.pow(Lm, 3) / 48) / (210000 * b[3] * 1e4);
    const r = { h: b[0], b: b[1], kg: b[4], name: "HEB " + b[0], P: P / 1000, nP, M: M / 1e6, s: M / (b[2] * 1000), f, fl: Lm / 1000, L };   // P kN per trave, M kNm, s MPa, f e fl mm
    if (r.s <= 160 && f <= Lm / 1000 || b === WK_HEB[WK_HEB.length - 1]) return r; } }
const wkColWater = (D, L) => Math.max(0, Math.PI / 4 * (Math.pow(D * 0.92, 2) - Math.pow(D * 0.18, 2)) * L * 1000);
const wkAccWet = (list) => (list || []).reduce((a, x) => a + wkAccKg(x.k, x.dn) + (wkAccL(x.k, x.dn) ? Math.PI / 4 * Math.pow(x.dn / 1000, 2) * wkAccL(x.k, x.dn) * 1000 : 0), 0);   // accessori pieni d'acqua
// FILTRI (taglie e portate tipiche): graniglia [Ø mm, H mm, m³/h, kg, kg graniglia, DN]; dischi, rete e idrocicloni [pollici, Ø m, H o L m, m³/h, kg, DN]
const WK_FILT = { sand: [[508, 1100, 10, 45, 100, 50], [610, 1250, 15, 60, 150, 50], [762, 1400, 23, 90, 250, 80], [914, 1550, 33, 130, 380, 80], [1220, 1900, 58, 260, 750, 100]],
  disc: [[2, 0.3, 0.55, 25, 8, 50], [3, 0.42, 0.7, 50, 15, 80]],
  screen: [[2, 0.16, 0.6, 25, 12, 50], [3, 0.2, 0.75, 50, 20, 80], [4, 0.27, 0.9, 80, 35, 100], [6, 0.36, 1.2, 180, 70, 150], [8, 0.46, 1.45, 300, 120, 200]],
  hydro: [[1.5, 0.2, 1.0, 10, 15, 40], [2, 0.27, 1.2, 20, 25, 50], [3, 0.36, 1.6, 45, 45, 80], [4, 0.46, 1.9, 80, 75, 100], [6, 0.6, 2.4, 180, 140, 150]] };
const WK_FILT_K = ["sand", "disc", "screen", "hydro"];
function wkFiltOf(fK, Q) {
  const T = WK_FILT[fK] || WK_FILT.sand, nMin = fK === "sand" || fK === "disc" ? 2 : 1, nMax = fK === "disc" ? 6 : 3;
  let i = T.findIndex(r => Math.max(nMin, Math.ceil(Q / (fK === "sand" ? r[2] : r[3]) - 1e-9)) <= nMax); if (i < 0) i = T.length - 1;
  const r = T[i], q = fK === "sand" ? r[2] : r[3], n = Math.max(nMin, Math.ceil(Q / q - 1e-9));
  return fK === "sand" ? { n, sz: Math.round(r[0] / 25.4) + '"', D: r[0] / 1000, H: r[1] / 1000, q, kg: r[3], kgM: r[4], dn: r[5] } : { n, sz: r[0] + '"', D: r[1], H: r[2], q, kg: r[4], kgM: 0, dn: r[5] };
}
// gruppo completo: componenti sulla platea (centro in metri); senza composizione a mano, quelli scelti uno accanto all'altro
const WK_SET_K = ["pump", "vpump", "moto", "filter", "gen", "panel"];
// POZZETTO DELLA POMPA VERTICALE (77.93) con le regole d'installazione del costruttore: parete di fondo a 1,5 D dall'asse, 6 D d'acqua davanti verso la presa,
// 2 D dalle pareti laterali, velocità d'arrivo ≤ 0,3 m/s al livello minimo; piastra con 40 cm di margine; Lin lungo la corrente (asse x locale verso la fonte), Win di traverso
// MOTORI ELETTRICI (78.13–78.14): rendimento per classe IE (IEC 60034-30-1, 50 Hz) e poli, cos φ tipico per poli; assorbimento in ampere a 400 V trifase (230 V monofase se mono)
const WK_MOT_KW = [0.75, 1.5, 4, 11, 30, 90, 200];
const WK_MOT_ETA_T = { 1: { 2: [72.1, 77.2, 83.1, 87.6, 90.7, 93.0, 94.0], 4: [72.1, 77.2, 83.1, 88.4, 91.4, 93.6, 94.5] }, 2: { 2: [77.4, 81.3, 85.8, 89.4, 92.0, 94.1, 95.0], 4: [79.6, 82.8, 86.6, 89.8, 92.3, 94.2, 95.1] }, 3: { 2: [80.7, 84.2, 88.1, 91.2, 93.3, 95.0, 95.8], 4: [82.5, 85.3, 88.6, 91.4, 93.6, 95.2, 96.0] } };
const WK_MOT_COS_T = { 2: [0.80, 0.83, 0.86, 0.88, 0.89, 0.90, 0.91], 4: [0.73, 0.78, 0.82, 0.84, 0.86, 0.87, 0.88] };
const wkMotI = (tab, kw) => { const x = Math.log(Math.max(WK_MOT_KW[0], Math.min(WK_MOT_KW[6], kw))); for (let i = 1; i < 7; i++) { const a = Math.log(WK_MOT_KW[i - 1]), b = Math.log(WK_MOT_KW[i]); if (x <= b) return tab[i - 1] + (tab[i] - tab[i - 1]) * (x - a) / (b - a); } return tab[6]; };
// 60 Hz (78.15): IE3 = NEMA Premium, IE2 = NEMA Energy Efficient (EPAct); IE1 a 60 Hz stimata: IE1 50 Hz + lo scarto IE2 60/50 Hz
WK_MOT_ETA_T[60] = { 3: { 2: [77.0, 85.5, 88.5, 91.0, 92.4, 95.0, 95.8], 4: [85.5, 86.5, 89.5, 92.4, 94.1, 95.4, 96.2] }, 2: { 2: [75.5, 84.0, 87.5, 90.2, 91.7, 94.5, 95.0], 4: [82.5, 84.0, 87.5, 91.0, 93.0, 94.5, 95.0] } };
WK_MOT_ETA_T[60][1] = { 2: WK_MOT_ETA_T[1][2].map((v, i) => wkR1(v + WK_MOT_ETA_T[60][2][2][i] - WK_MOT_ETA_T[2][2][i])), 4: WK_MOT_ETA_T[1][4].map((v, i) => wkR1(v + WK_MOT_ETA_T[60][2][4][i] - WK_MOT_ETA_T[2][4][i])) };
function wkR1(v) { return Math.round(v * 10) / 10; }
const wkMotEta = (kw, poles, ie, hz) => { const c = [1, 2, 3].includes(+ie) ? +ie : 3, T = +hz === 60 ? WK_MOT_ETA_T[60] : WK_MOT_ETA_T; return wkMotI(T[c][+poles === 4 ? 4 : 2], kw) / 100; };   // ie: 1 · 2 · 3 (IE3 di norma; IE1 per i paesi dove è ammesso, l'export)
const wkMotCos = (kw, poles) => wkMotI(WK_MOT_COS_T[+poles === 4 ? 4 : 2], kw);
const wkPolesOfRpm = (rpm) => +rpm > 0 && +rpm < 2000 ? 4 : 2;   // 2 poli ~2900 giri/min (3500 a 60 Hz), 4 poli ~1450 (1750)
// CARICO PARZIALE (78.15): rendimento e cos φ scendono sotto il 75% del carico; con l'inverter perdite armoniche nel motore (−1,5%), rendimento dell'inverter 97% e cos φ di rete 0,95
const wkMotLoadF = (L) => L >= 0.75 ? 1 : L >= 0.5 ? 0.985 + 0.06 * (L - 0.5) : L >= 0.25 ? 0.94 + 0.18 * (L - 0.25) : Math.max(0.6, 0.94 - 1.36 * (0.25 - L));
const wkMotCosF = (L) => L >= 1 ? 1 : L >= 0.75 ? 0.97 + 0.12 * (L - 0.75) : L >= 0.5 ? 0.88 + 0.36 * (L - 0.5) : L >= 0.25 ? 0.65 + 0.92 * (L - 0.25) : Math.max(0.3, 0.65 - 1.4 * (0.25 - L));
const WK_VFD_ETA = 0.97, WK_VFD_COS = 0.95;
function wkMotEtaOp(kwOut, kwMotor, poles, ie, o) { o = o || {}; const km = +kwMotor > 0 ? +kwMotor : +kwOut, P = +kwOut; if (!(P > 0) || !(km > 0)) return wkMotEta(km || 1, poles, ie, o.hz); return wkMotEta(km, poles, ie, o.hz) * wkMotLoadF(P / km) * (o.vfd ? 0.985 * WK_VFD_ETA : 1); }   // dalla rete all'albero
// NEREUS (78.16): i motori di calcolo di Nereus, portati qui senza cambiarli — pagina 04 Invasi (invaso a bilancio di terra: solo scavo
// o scavo e argine a bilancio pareggiato) e pagina Pompaggio › Galleggianti (zattera su tubi tappati: peso con i tappi, affondamento, numero minimo)
const nerKo = (b1, b2, h, m) => h / 6 * (b1 * b2 + 4 * (b1 + m * h) * (b2 + m * h) + (b1 + 2 * m * h) * (b2 + 2 * m * h));   // prismatoide: tronco di piramide a base rettangolare
function nerW0(V, H, m, r) { if (!(V > 0 && H > 0 && r > 0)) return 0; let lo = 0.001, hi = 5e3; if (nerKo(r * hi, hi, H, m) < V) return 0; for (let s = 0; s < 200; s++) { const o = (lo + hi) / 2; nerKo(r * o, o, H, m) < V ? lo = o : hi = o; } return (lo + hi) / 2; }
function nerF0(b1, b2, Hb, c, mi, me) { const A = c * Hb + (mi + me) / 2 * Hb * Hb, wb = c + (mi + me) * Hb, L = 2 * (b1 + b2) + 8 * (wb / 2); return { V: A * L, Asez: A, Lmed: L, wbase: wb }; }
const NER_SOILS = [{ key: "sand", miMin: 3, K: 90 }, { key: "loam", miMin: 2, K: 85 }, { key: "clay", miMin: 1.5, K: 80 }];
function nerK0({ V, H, r, mi, me, c, fb, K }) {
  if (!(V > 0 && H > 0 && r > 0 && mi >= 0 && K > 0)) return { ok: false };
  const b2 = nerW0(V, H, mi, r), b1 = r * b2; if (!(b2 > 0) || !isFinite(b2)) return { ok: false };
  const wWat = b1 + 2 * mi * H, lWat = b2 + 2 * mi * H, hc = H + fb, dg = nerKo(b1, b2, hc, mi), w0 = b1 + 2 * mi * hc, l0 = b2 + 2 * mi * hc;
  const cut = { hs: hc, ha: 0, Hb: 0, dig: dg, bank: 0, away: dg, moved: dg, b1s: w0, b2s: l0, wbase: 0, crestLen: 0, Asez: 0, w: w0, l: l0, area: w0 * l0, yield: V / dg };
  const at = (D) => { const P = H - D, x = P + fb, q = nerKo(b1, b2, D, mi), Rr = b1 + 2 * mi * D, Cc = b2 + 2 * mi * D, j = nerF0(Rr, Cc, x, c, mi, me); return { hs: D, ha: P, Hb: x, dig: q, b1s: Rr, b2s: Cc, bank: j.V, Asez: j.Asez, crestLen: j.Lmed, wbase: j.wbase, d: q * K - j.V }; };
  let lo = 1e-4, hi = H, b, bal = true; const k0 = at(H);
  if (k0.d < 0) { b = k0; bal = false; } else { for (let D = 0; D < 200; D++) { const P = (lo + hi) / 2; at(P).d < 0 ? lo = P : hi = P; } b = at((lo + hi) / 2); }
  const A = b.b1s + 2 * b.wbase, T = b.b2s + 2 * b.wbase;
  const eff = { hs: b.hs, ha: b.ha, Hb: b.Hb, dig: b.dig, bank: b.bank, away: Math.max(0, b.d), moved: b.dig, b1s: b.b1s, b2s: b.b2s, wbase: b.wbase, crestLen: b.crestLen, Asez: b.Asez, w: A, l: T, area: A * T, yield: V / b.dig };
  return { ok: true, b1, b2, wWat, lWat, V, H, mi, me, c, fb, K, cut, eff, balanced: bal, save: 1 - eff.dig / cut.dig };
}
const nerKc = (r, a) => { if (a <= 0) return 0; if (a >= 2 * r) return Math.PI * r * r; const t = r - a; return r * r * Math.acos(t / r) - t * Math.sqrt(Math.max(r * r - t * t, 0)); };   // segmento circolare immerso
const NER_FMAT = { pe100: 960, pe80: 950, pvc: 1400, steel: 7850, inox: 7900 }, NER_FILL = { air: 1.2, foam: 30, water: 1000 }, NER_LIQ = { fresh: 1000, dirty: 1030 };
function nerRaft(o) {   // o: n tubi, L m, De m (Ø esterno), wall m, mat, fill, liq, load kg (carico esterno), capW kg (tappo a mano, se no stimato)
  const j = Math.max(Math.round(+o.n || 0), 0), E = +o.L || 0, H = +o.De || 0, se = +o.wall || 0, K = +o.load || 0, rho = NER_FMAT[o.mat] || NER_FMAT.pe100, rF = NER_FILL[o.fill] || NER_FILL.air, rL = NER_LIQ[o.liq] || NER_LIQ.fresh;
  if (!(j > 0 && E > 0 && H > 0 && se > 0)) return { ok: false };
  const Z = H / 2, G = Z - se; if (!(G > 0)) return { ok: false };
  const ke = Math.PI * (Z * Z - G * G) * E * rho, W = o.capW > 0 ? +o.capW : Math.PI * Z * Z * (1.5 * se) * rho, xe = ke + 2 * W, qe = Math.PI * G * G * E, me = qe * rF, X = j * (xe + me), Q = X + K, ee = j * Math.PI * Z * Z * E * rL, V = ee > Q;
  let lo = 0, hi = 2 * Z; for (let I = 0; I < 120; I++) { const re = (lo + hi) / 2; j * nerKc(Z, re) * E * rL < Q ? lo = re : hi = re; }
  const U = V ? (lo + hi) / 2 : 2 * Z; let nMin = 0; for (let I = 1; I <= 60; I++) if (I * nerKc(Z, Z) * E * rL >= I * (xe + me) + K) { nMin = I; break; }
  return { ok: true, Ptube: xe, Pcaps: 2 * W, Pin: me, Pself: X, Ptot: Q, Smax: ee, floats: V, a: U, pct: U / (2 * Z) * 100, free: 2 * Z - U, reserve: ee - Q, nMin, n: j, selfOk: nerKc(Z, Z) * E * rL >= xe + me, capacity: ee / 2 - X, vFrac: V ? nerKc(Z, U) / (Math.PI * Z * Z) : 1 };
}
const wkFWall = (p) => +p.fWall > 0 ? +p.fWall : Math.max(0.004, (+p.fD || 0.8) / 17);   // galleggianti in PE100 SDR 17 se non detto altrimenti
// CAVI DI ALIMENTAZIONE DELLE POMPE (78.20): sezione minima per portata (rame in tubo interrato, ~IEC 60364 B2/D, con margine 1,25) e caduta ≤ 3%
const WK_CAB_S = [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240], WK_CAB_I = [17.5, 24, 32, 41, 57, 76, 101, 125, 151, 192, 232, 269, 300, 341, 400];
function wkCableSec(I, L, V, mat, maxPct, minS) { const rho = mat === "Al" ? 0.0284 : 0.0178, kA = mat === "Al" ? 0.78 : 1, U = +V > 0 ? +V : 400, lim = maxPct || 3; let last = null;   // minS (78.29): sezione minima (alimentazione dei motori in tubo interrato: 2,5 mm²)
  for (let i = 0; i < WK_CAB_S.length; i++) { const S = WK_CAB_S[i]; if (mat === "Al" && S < 16) continue; if (minS && S < minS) continue; const dP = Math.sqrt(3) * rho * L * I * 0.85 / S / U * 100; last = { S, dPct: dP }; if (WK_CAB_I[i] * kA >= I * 1.25 && dP <= lim) return last; } return last; }
function wkAmps(kwOut, kwMotor, V, mono, poles, ie, o) { o = o || {}; const km = +kwMotor > 0 ? +kwMotor : +kwOut, P = +kwOut; if (!(P > 0) || !(km > 0)) return 0; const U = +V > 0 ? +V : (mono ? 230 : 400), Pin = P / wkMotEtaOp(P, km, poles, ie, o) * 1000;
  return Pin / ((mono ? 1 : Math.sqrt(3)) * U * (o.vfd ? WK_VFD_COS : wkMotCos(km, poles) * wkMotCosF(P / km))); }   // corrente di linea: a monte dell'inverter se c'è
const WK_VP_MINW = 1.2, WK_VP_MINL = 1.5;   // pozzetto della verticale: misure interne minime pratiche (si scende per pulire e ispezionare), oltre alle regole idrauliche (78.07)
function wkVpSump(p) { const q = p.pv || {}, D = q.D || q.bD || 0.3, Q = Math.max(0, +p.Q || 60) / 3600, asp = q.vfA > 0 ? q.vfA : (q.suA || 0.25), d = (q.vfA > 0 ? q.vfD : q.suD) || D, pl = q.pL || 0.6;
  const v = Q / (Math.PI / 4 * d * d), S = Math.max(d * (1 + 2.3 * v / Math.sqrt(9.81 * d)), (q.bA || 0.6) + asp + 0.3, +q.sub || 0, 2.5 * D), cl = Math.max(+q.floor || 0.5 * D, 0.3 * D), hw = S + asp + cl;
  const back = Math.max(1.5 * D, pl / 2 + 0.4), front = Math.max(6 * D, pl / 2 + 0.4), Win = wkR(Math.max(4 * D, pl + 0.8, Q / (0.3 * hw), WK_VP_MINW), 2), Lin = wkR(Math.max(back + front, WK_VP_MINL), 2);
  return { D, Lin, Win, xa: wkR(-Lin / 2 + back, 3), back, front: wkR(Lin - back, 3), side: Win / 2 }; }   // pompa verticale nel gruppo (77.91): metà lato interno del pozzetto (2 D dalle pareti, piastra con 40 cm di margine)
const WK_SRC = ["canal", "river", "lake", "well", "net"];   // da dove arriva l'acqua al gruppo completo
function wkSetFoot(k, p) {
  if (k === "gen") return { L: p.Lg || 2.2, W: p.Wg || 1.0 };
  if (k === "panel") return { L: 0.8, W: 0.4 };
  if (k === "vpump") { const q = p.pv || {}; if (p.src === "well") return { L: wkR((q.pL || 0.6) + 0.6, 2), W: wkR((q.pL || 0.6) + 0.6, 2) }; const z = wkVpSump(p); return { L: wkR(z.Lin + 0.6, 2), W: wkR(z.Win + 0.6, 2) }; }   // pozzetto aperto con le pareti (o basamento sul pozzo)   // pozzetto aperto con le pareti (o basamento sul pozzo)
  if (k === "filter") { const n = Math.max(1, Math.round(p.fn || 2)), pt = p.fK === "screen" ? Math.max(0.9, p.fD + 0.6) : p.fD + Math.max(0.35, p.fD * 0.4); return { L: n * pt + 0.3, W: Math.max(p.fD + 1.0, 1.4) }; }
  const q = k === "moto" ? p.pm || p : p.pe || p; return { L: q.Lu || 1.6, W: q.Wu || 0.8 };
}
function wkSetComps(p) {
  if (Array.isArray(p.lay)) return p.lay.filter(c => WK_SET_K.includes(c.k));
  const out = []; let x = 0; const add = (k) => { const f = wkSetFoot(k, p); out.push({ k, x: wkR(x + f.L / 2), y: 0 }); x += f.L + 1.0; };
  if (+p.hasG) add("gen"); if (p.hasP !== 0 && p.hasP !== "0") add(p.moto ? "moto" : +p.vert ? "vpump" : "pump"); if (+p.hasF) add("filter");
  return out;
}
const wkStages = (m) => { const r = /\/(\d+)/.exec(String(m || "")); return r ? +r[1] : 0; };   // stadi dal nome del modello (E6P35/12A → 12)
const wkSym = {
  // motore elettrico verticale V1 (flangia in basso alla quota y, altezza A, Ø F)
  motor(x, y, F, A) { const sx = F / 22.8; return wkArt("vMotor", (u) => x + u * sx, wkVmap(y + A, WK_ART.vMotor, A), null, 0.4 * sx); },
  // testa di scarico con la mandata laterale verso destra: comando elettrico (lanterna), a puleggia, con rinvio ad angolo
  head(x, y, o) {
    const nm = o.kind === "gear" ? "vHeadGear" : o.kind === "pulley" ? "vHeadPul" : "vHeadEl", ref = o.kind === "gear" ? 19.5 : o.kind === "pulley" ? 19.2 : 24.0, sx = o.pL / ref;
    let an = nm; if (o.noOut && WK_ART[nm]) { an = nm + "_n"; if (!WK_ART[an]) { const a = WK_ART[nm], thr = { vHeadEl: 800, vHeadGear: 712, vHeadPul: 670 }[nm], cl = { vHeadEl: 1222, vHeadGear: 1227, vHeadPul: 1184 }[nm], cx = (arr, k0) => arr.map((v, k) => (k - k0) % 2 === 0 && k >= k0 ? Math.min(v, cl) : v);   // mandata girata verso chi guarda o dietro (78.00): senza la bocca laterale
        WK_ART[an] = { ...a, sil: cx(a.sil || [], 0), it: a.it.filter(it => { let m = 1e9; for (let k = 3; k < it.length; k += 2) m = Math.min(m, it[k]); return m < thr; }).map(it => cx(it, 3)) }; } }
    const out = wkArt(an, (u) => x + u * sx, wkVmap(y + o.A, WK_ART[nm], o.A), null, 0.4 * sx), fr = o.kind === "gear" ? 0.197 : o.kind === "pulley" ? 0.22 : 0.256;
    out.dis = [x + (WK_ART[nm] ? WK_ART[nm].x1 / 100 : 14) * sx, y + fr * o.A];   // faccia della flangia di mandata
    return out;
  },
  // colonna di mandata con la linea d'asse: tubo e manicotti di giunzione a ogni elemento
  column(x, yTop, yBot, D, Df, L, Y) {
    Y = Y || ((v) => v); const it = [wkPg([[x - D / 2, Y(yTop)], [x + D / 2, Y(yTop)], [x + D / 2, Y(yBot)], [x - D / 2, Y(yBot)]], 255, "-"), Lgs([[x - D / 2, Y(yTop)], [x - D / 2, Y(yBot)]], "a"), Lgs([[x + D / 2, Y(yTop)], [x + D / 2, Y(yBot)]], "a")], sx = D / 9.5;
    for (let yj = yTop - L; yj > yBot + 0.15; yj -= L) { if (Math.abs((Y(yj) - Y(yj - 0.1)) - 0.1) > 0.02) continue; const yy = Y(yj); it.push(...wkArt("vJoint", (u) => x + u * sx, (v) => yy + (5.3 - v) * sx, null, 0.4 * sx)); }   // nell'interruzione i giunti non si vedono
    return it;
  },
  // corpo pompa: diffusore di mandata, stadi, ultimo stadio e corpo d'aspirazione
  bowl(x, yTop, H, n, F, Dm, Dc, Y) {
    const ns = Math.max(1, Math.min(Math.round(n) || 1, 24)), tot = 7.5 + 7.8 * (ns - 1) + 11.5 + 9.5, k = H / tot, sx = Dm / 9.7, it = [];
    let yc = yTop; const put = (nm, h) => { const y0 = yc; it.push(...wkArt(nm, (u) => x + u * sx, (v) => y0 - v * k, Y, 0.4 * sx)); yc -= h * k; };
    put("vBTop", 7.5); for (let i = 1; i < ns; i++) put("vStage", 7.8); put("vBLast", 11.5); put("vSuct", 9.5);
    return it;
  },
  // succheruola e valvola di fondo sopra, se c'è
  strainer(x, yTop, H, D, valve, Y) {
    Y = Y || ((v) => v); const it = [], P = (xx, yy) => [xx, Y(yy)];
    let y0 = yTop;
    if (valve > 0) { const hv = Math.min(valve * 0.55, H * 0.6), pts = []; for (let k = 0; k <= 10; k++) { const f = k / 10; pts.push([D * (0.32 + 0.16 * Math.sin(f * Math.PI)), y0 - f * hv]); }
      it.push(wkPg(pts.map(q => P(x + q[0], q[1])).concat(pts.slice().reverse().map(q => P(x - q[0], q[1]))), 255, "a"), Lgs([P(x - D * 0.32, y0 - hv * 0.5), P(x + D * 0.32, y0 - hv * 0.5)], "a")); y0 -= hv; }
    const h = Math.max(0.05, y0 - (yTop - H)), sx = D / 9.2;
    it.push(...wkArt("vStrainer", (u) => x + u * sx, wkVmap(y0, WK_ART.vStrainer, h), Y, 0.4 * sx));
    return it;
  },
  // elettropompa sommersa: valvola di ritegno in testa, stadi, aspirazione con la griglia, motore sommerso sotto
  subm(x, yTop, D, Lp, Lm, n, Y) {
    const sx = D / 14.4, ns = Math.max(1, Math.min(40, Math.round(n) || Math.round((Lp / sx - 16.3 - 26.3) / 10.3) || 1)), k = Lp / (16.3 + 10.3 * ns + 26.3), it = [];
    let yc = yTop; const put = (nm, h) => { const y0 = yc; it.push(...wkArt(nm, (u) => x + u * sx, (v) => y0 - v * k, Y, 0.4 * sx)); yc -= h * k; };
    put("sHead", 16.3); for (let i = 0; i < ns; i++) put("sStage", 10.3); put("sIntake", 26.3);
    it.push(...wkArt("sMotor", (u) => x + u * sx, wkVmap(yTop - Lp, WK_ART.sMotor, Lm, sx, 6, 40), Y, 0.4 * sx));
    return it;
  },
  // motore diesel (per le motopompe): coppa, basamento, testata, coperchio punterie, filtro aria, scarico con marmitta, puleggia e ventola, radiatore
  diesel(x, yb, L, H, hs) {
    const it = [], P = (u, v) => [x + u * L, yb + v * H], B = (u0, v0, u1, v1, f, s) => wkPg([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], f == null ? 255 : f, s || "a");
    const ys = Math.max(0.25, Math.min(0.6, hs / H));
    it.push(B(0.04, 0, 0.66, 0.05, 235), B(0.08, 0.05, 0.6, 0.14, 250));   // longheroni e coppa dell'olio
    it.push(wkPg([P(0, ys - 0.3), P(0.12, ys - 0.36), P(0.12, ys + 0.36), P(0, ys + 0.3)], 248, "a"));   // campana del volano
    it.push(B(0.12, 0.14, 0.6, 0.62, 244));   // basamento con i cilindri
    for (let i = 1; i < 6; i++) it.push(Lgs([P(0.12 + i * 0.08, 0.2), P(0.12 + i * 0.08, 0.58)], "a"));
    it.push(B(0.15, 0.62, 0.58, 0.74, 236), B(0.17, 0.74, 0.56, 0.82, 250));   // testata e coperchio
    for (let i = 1; i < 8; i++) it.push(Lgs([P(0.17 + i * 0.049, 0.75), P(0.17 + i * 0.049, 0.81)], "a"));
    const fl = []; for (let k = 0; k <= 12; k++) { const a = Math.PI * k / 12; fl.push(P(0.39 + 0.08 * Math.cos(a), 0.9 + 0.08 * Math.sin(a) * L / H * 0.5)); }
    it.push(B(0.31, 0.82, 0.47, 0.9, 250), wkPg(fl, 250, "a"), Lgs([P(0.31, 0.86), P(0.47, 0.86)], "a"));   // filtro dell'aria
    it.push(B(0.52, 0.82, 0.555, 0.97, 255), wkPg([P(0.45, 0.97), P(0.66, 0.97), P(0.67, 1.0), P(0.66, 1.03), P(0.45, 1.03), P(0.44, 1.0)], 230, "a"), B(0.63, 1.03, 0.65, 1.12, 255));   // scarico e marmitta
    it.push(B(0.22, 0.3, 0.36, 0.44, 255), Lgs([P(0.24, 0.37), P(0.34, 0.37)], "a"));   // pompa d'iniezione
    it.push(B(0.6, 0.14, 0.7, 0.6, 250));   // convogliatore della ventola
    const cx = 0.635, cy = Math.min(0.5, ys), r = Math.min(0.06 * L, 0.12 * H); it.push({ t: "c", x: x + cx * L, y: yb + cy * H, r, s: "a" }, { t: "c", x: x + cx * L, y: yb + (cy + 0.2) * H, r: r * 0.6, s: "a" }, Lgs([[x + cx * L - r, yb + cy * H], [x + cx * L - r * 0.6, yb + (cy + 0.2) * H]], "a"), Lgs([[x + cx * L + r, yb + cy * H], [x + cx * L + r * 0.6, yb + (cy + 0.2) * H]], "a"));
    it.push(B(0.7, 0.05, 0.84, 0.92, 255), B(0.72, 0.1, 0.82, 0.86, 240));   // radiatore e massa radiante
    for (let v = 0.14; v < 0.84; v += 0.045) it.push(Lgs([P(0.72, v), P(0.82, v)], "a"));
    it.push(B(0.74, 0.92, 0.8, 0.97, 255));   // tappo del radiatore
    it.push(B(0.86, 0.05, 1.0, 0.42, 248), Lgs([P(0.88, 0.32), P(0.98, 0.32)], "a"), { t: "c", x: x + 0.9 * L, y: yb + 0.2 * H, r: 0.012 * L + 0.01, s: "a" }, { t: "c", x: x + 0.96 * L, y: yb + 0.2 * H, r: 0.012 * L + 0.01, s: "a" });   // quadro strumenti
    it.forEach(o => { o.wm = Math.min(L, H) * 0.004; });
    return it;
  },
  // filtro a graniglia in prospetto: gambe, fondi bombati, mantello con le saldature, passo d'uomo, ingresso in alto, scarico, manometro
  sandFilter(xc, yb, D, H) {
    const it = [], r = D / 2, hl = Math.max(0.15, 0.12 * H), hd = 0.18 * D, wm = Math.max(0.002, D * 0.006), P = (u, v) => [xc + u, yb + v];
    const dome = (v0, up) => { const pts = []; for (let k = 0; k <= 12; k++) { const a = Math.PI * k / 12; pts.push(P(-r * Math.cos(a), v0 + (up ? 1 : -1) * hd * Math.sin(a))); } return pts; };
    [-0.8, 0.8].forEach(f => it.push(wkPg([P(f * r - 0.025, 0), P(f * r + 0.025, 0), P(f * r * 0.85 + 0.02, hl + hd * 0.6), P(f * r * 0.85 - 0.02, hl + hd * 0.6)], 200, "a"), wkPg([P(f * r - 0.05, 0), P(f * r + 0.05, 0), P(f * r + 0.05, 0.012), P(f * r - 0.05, 0.012)], 120, "a")));
    const y0 = hl + hd, y1 = H - hd;
    it.push(wkPg(dome(y0, false).concat([P(r, y1)]).concat(dome(y1, true).reverse()).concat([P(-r, y0)]), 244, "a"));
    it.push(Lgs([P(-r, y0), P(r, y0)], "a"), Lgs([P(-r, y1), P(r, y1)], "a"), Lgs([P(-r, (y0 + y1) / 2), P(r, (y0 + y1) / 2)], "a"));
    it.push({ t: "c", x: xc + r * 0.35, y: yb + (y0 + y1) / 2 + 0.12 * (y1 - y0), r: Math.min(0.12, r * 0.28), s: "a" });   // passo d'uomo
    it.push(wkPg([P(-0.04, H), P(0.04, H), P(0.04, H + 0.12), P(-0.04, H + 0.12)], 255, "a"), wkPg([P(-0.07, H + 0.12), P(0.07, H + 0.12), P(0.07, H + 0.14), P(-0.07, H + 0.14)], 220, "a"));   // ingresso con flangia
    it.push(wkPg([P(-0.035, hl - 0.06), P(0.035, hl - 0.06), P(0.035, hl + hd * 0.4), P(-0.035, hl + hd * 0.4)], 255, "a"));   // uscita dal fondo
    it.push(Lgs([P(r * 0.55, H - hd * 0.3), P(r * 0.55, H + 0.05)], "a"), { t: "c", x: xc + r * 0.55, y: yb + H + 0.09, r: 0.04, s: "a" });   // manometro
    it.forEach(o => { o.wm = wm; }); return it;
  },
  // filtro a dischi: corpo con la fascetta, coperchio, attacco al collettore in basso
  discFilter(xc, yb, D, H) {
    const it = [], r = D / 2, wm = Math.max(0.0015, D * 0.008), P = (u, v) => [xc + u, yb + v];
    it.push(wkPg([P(-r * 0.45, 0), P(r * 0.45, 0), P(r * 0.45, 0.12 * H), P(-r * 0.45, 0.12 * H)], 236, "a"));
    it.push(wkPg([P(-r, 0.12 * H), P(r, 0.12 * H), P(r, 0.62 * H), P(-r, 0.62 * H)], 70, "a"), wkPg([P(-r * 1.06, 0.58 * H), P(r * 1.06, 0.58 * H), P(r * 1.06, 0.68 * H), P(-r * 1.06, 0.68 * H)], 200, "a"));
    const cap = []; for (let k = 0; k <= 10; k++) { const a = Math.PI * k / 10; cap.push(P(-r * Math.cos(a), 0.68 * H + 0.32 * H * Math.sin(a))); }
    it.push(wkPg(cap, 225, "a")); for (let k = 1; k < 6; k++) it.push(Lgs([P(-r + k * D / 6, 0.15 * H), P(-r + k * D / 6, 0.58 * H)], "wh"));
    it.forEach(o => { if (o.s !== "wh") o.wm = wm; }); return it;
  },
  // filtro a rete in linea: corpo cilindrico orizzontale flangiato, coperchio a fascetta, scarico sotto, manometri
  screenFilter(x0, yc, L, D) {
    const it = [], r = D / 2, wm = Math.max(0.0015, D * 0.008), P = (u, v) => [x0 + u, yc + v], Df = D * 0.75;
    it.push(wkPg([P(0, -Df / 2), P(0.03, -Df / 2), P(0.03, Df / 2), P(0, Df / 2)], 220, "a"), wkPg([P(L - 0.03, -Df / 2), P(L, -Df / 2), P(L, Df / 2), P(L - 0.03, Df / 2)], 220, "a"));
    it.push(wkPg([P(0.03, -r * 0.5), P(0.12 * L, -r * 0.5), P(0.12 * L, r * 0.5), P(0.03, r * 0.5)], 250, "a"), wkPg([P(0.12 * L, -r), P(0.8 * L, -r), P(0.8 * L, r), P(0.12 * L, r)], 244, "a"));
    it.push(wkPg([P(0.8 * L, -r * 1.05), P(0.86 * L, -r * 1.05), P(0.86 * L, r * 1.05), P(0.8 * L, r * 1.05)], 200, "a"), wkPg([P(0.86 * L, -r * 0.9), P(L - 0.03, -r * 0.5), P(L - 0.03, r * 0.5), P(0.86 * L, r * 0.9)], 236, "a"));
    it.push(wkPg([P(0.45 * L - 0.02, -r), P(0.45 * L + 0.02, -r), P(0.45 * L + 0.02, -r - 0.1), P(0.45 * L - 0.02, -r - 0.1)], 255, "a"));
    [0.2, 0.7].forEach(f => it.push(Lgs([P(f * L, r), P(f * L, r + 0.06)], "a"), { t: "c", x: x0 + f * L, y: yc + r + 0.1, r: 0.035, s: "a" }));
    it.forEach(o => { o.wm = wm; }); return it;
  },
  // idrociclone: parte cilindrica con l'ingresso tangenziale, cono, serbatoio di raccolta della sabbia
  hydroFilter(xc, yb, D, H) {
    const it = [], r = D / 2, wm = Math.max(0.0015, D * 0.008), P = (u, v) => [xc + u, yb + v], hc = 0.22 * H;
    it.push(wkPg([P(-r * 0.9, 0), P(r * 0.9, 0), P(r * 0.9, hc), P(-r * 0.9, hc)], 236, "a"), wkPg([P(-r * 0.3, hc), P(r * 0.3, hc), P(r * 0.3, hc + 0.05), P(-r * 0.3, hc + 0.05)], 200, "a"));
    it.push(wkPg([P(-r * 0.12, hc + 0.05), P(r * 0.12, hc + 0.05), P(r, 0.72 * H), P(-r, 0.72 * H)], 244, "a"), wkPg([P(-r, 0.72 * H), P(r, 0.72 * H), P(r, H), P(-r, H)], 244, "a"));
    it.push(wkPg([P(-r - 0.12, 0.86 * H - r * 0.25), P(-r, 0.86 * H - r * 0.25), P(-r, 0.86 * H + r * 0.25), P(-r - 0.12, 0.86 * H + r * 0.25)], 255, "a"), wkPg([P(-0.04, H), P(0.04, H), P(0.04, H + 0.1), P(-0.04, H + 0.1)], 255, "a"));
    it.forEach(o => { o.wm = wm; }); return it;
  },
  // gruppo elettrogeno in prospetto laterale, come nelle foto del catalogo: aperto (alternatore, motore, radiatore, marmitta, quadro su colonnina)
  // o insonorizzato (sv: cofano ad apertura verticale; s: porte laterali e finestra del quadro; sb: grandi potenze con griglie e due porte); basamento con il serbatoio
  genset(x, y, L, H, enc) {
    const it = [], P = (u, v) => [x + u * L, y + v * H], B = (u0, v0, u1, v1, f, st) => wkPg([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], f == null ? 255 : f, st || "a"), Ln = (pts) => Lgs(pts.map(q => P(q[0], q[1])), "a");
    const hb = Math.min(0.3, Math.max(0.1, 0.13 * H)) / H, cyc = (u, v, r) => ({ t: "c", x: x + u * L, y: y + v * H, r, s: "a" });
    it.push(B(0, 0, 1, hb, 70), B(0.015, hb * 0.25, 0.985, hb * 0.75, 95));   // basamento con il serbatoio incorporato
    [0.22, 0.72].forEach(u => it.push(B(u, hb * 0.2, u + 0.09, hb * 0.62, 30)));   // tasche per le forche
    [0.3, 0.68].forEach(u => it.push(cyc(u, hb * 0.5, Math.min(0.012 * L, 0.3 * hb * H))));   // tappi di scarico
    if (enc === "open") {
      const ys = hb + 0.33;   // asse alternatore-motore
      it.push(B(0.09, hb, 0.13, hb + 0.06, 40), B(0.31, hb, 0.35, hb + 0.06, 40), B(0.42, hb, 0.46, hb + 0.05, 40), B(0.7, hb, 0.74, hb + 0.05, 40));   // antivibranti
      const al = []; for (let k = 0; k <= 8; k++) { const a = -Math.PI / 2 + Math.PI * k / 8; al.push(P(0.1 - 0.035 * Math.cos(a), ys + 0.22 * Math.sin(a))); }
      it.push(wkPg(al.concat([P(0.36, ys + 0.22), P(0.36, ys - 0.22)]), 238, "a"));   // alternatore
      for (let k = 0; k < 6; k++) it.push(Ln([[0.12 + k * 0.035, ys - 0.17], [0.12 + k * 0.035, ys + 0.17]]));
      it.push(B(0.17, ys + 0.22, 0.3, ys + 0.33, 250), Ln([[0.19, ys + 0.275], [0.28, ys + 0.275]]));   // morsettiera
      it.push(B(0.36, ys - 0.25, 0.39, ys + 0.25, 225));   // campana di accoppiamento
      it.push(B(0.39, hb + 0.04, 0.76, ys + 0.24, 244), B(0.41, ys + 0.24, 0.74, ys + 0.34, 230), B(0.43, ys + 0.34, 0.72, ys + 0.41, 250));   // basamento motore, testata, coperchio
      for (let k = 1; k < 6; k++) it.push(Ln([[0.39 + k * 0.062, hb + 0.1], [0.39 + k * 0.062, ys + 0.2]]));
      it.push(cyc(0.5, ys - 0.05, 0.035 * H), cyc(0.6, ys - 0.05, 0.035 * H), B(0.62, ys + 0.03, 0.7, ys + 0.18, 250));   // filtri e turbina
      it.push(B(0.66, ys + 0.41, 0.69, hb + 0.82, 255), wkPg([P(0.42, hb + 0.8), P(0.72, hb + 0.8), P(0.74, hb + 0.85), P(0.72, hb + 0.9), P(0.42, hb + 0.9), P(0.4, hb + 0.85)], 225, "a"), B(0.44, hb + 0.9, 0.47, 1.0, 255));   // marmitta e scarico
      it.push(B(0.76, hb + 0.08, 0.8, hb + 0.66, 250), cyc(0.78, ys + 0.05, 0.12 * H));   // ventola
      it.push(B(0.8, hb, 0.97, hb + 0.78, 255), B(0.82, hb + 0.04, 0.95, hb + 0.74, 236));   // radiatore
      for (let v = hb + 0.08; v < hb + 0.72; v += 0.04) it.push(Ln([[0.82, v], [0.95, v]]));
      it.push(B(0.86, hb + 0.78, 0.9, hb + 0.82, 255));
      it.push(B(0.035, hb, 0.05, hb + 0.52, 60), B(0.0, hb + 0.52, 0.16, hb + 0.86, 248), B(0.02, hb + 0.66, 0.1, hb + 0.8, 225), cyc(0.13, hb + 0.6, 0.02 * H));   // quadro su colonnina
      return it;
    }
    const top = 1, lip = 0.025;
    it.push(B(0, hb, 1, top - lip, 250), B(-0.006, top - lip, 1.006, top, 236));   // cofano e tetto
    const door = (u0, u1, v0, v1) => { it.push(B(u0, v0, u1, v1, 246), B(u0 + 0.01, v0 + 0.02, u1 - 0.01, v1 - 0.02, 250));
      it.push(B(u0 + 0.015, (v0 + v1) / 2 - 0.04, u0 + 0.025, (v0 + v1) / 2 + 0.04, 40), B(u1 - 0.01, v1 - 0.12, u1 - 0.004, v1 - 0.06, 120), B(u1 - 0.01, v0 + 0.06, u1 - 0.004, v0 + 0.12, 120)); };
    const louv = (u0, u1, v0, v1, n) => { it.push(B(u0, v0, u1, v1, 230)); for (let k = 1; k < n; k++) it.push(Ln([[u0 + 0.004, v0 + (v1 - v0) * k / n], [u1 - 0.004, v0 + (v1 - v0) * k / n]])); };
    const eye = (u) => it.push(wkPg([P(u - 0.012, top), P(u - 0.012, top + 0.035), P(u - 0.006, top + 0.06), P(u + 0.006, top + 0.06), P(u + 0.012, top + 0.035), P(u + 0.012, top)], 255, "a"), cyc(u, top + 0.035, 0.012 * H));
    const exh = (u) => it.push(B(u - 0.015, top, u + 0.015, top + 0.07, 255), B(u - 0.022, top + 0.07, u + 0.022, top + 0.085, 225));
    if (enc === "sv") {   // cofano ad apertura verticale: giunto del coperchio a metà, gancio di sollevamento
      it.push(Ln([[0.53, hb], [0.53, top - lip]]), B(0.47, hb + 0.06, 0.5, hb + 0.1, 40), B(0.56, hb + 0.06, 0.59, hb + 0.1, 40), B(0.505, top - 0.18, 0.525, top - 0.06, 120));
      louv(0.06, 0.2, hb + 0.05, hb + 0.14, 4); louv(0.84, 0.95, top - 0.2, top - 0.06, 5); eye(0.53); exh(0.85);
    } else if (enc === "s") {   // porte laterali, finestra del quadro e pulsante d'emergenza
      door(0.04, 0.42, hb + 0.06, top - 0.06); it.push(B(0.08, top - 0.34, 0.3, top - 0.14, 210), B(0.1, top - 0.31, 0.2, top - 0.2, 170), cyc(0.36, top - 0.24, 0.025 * H), B(0.1, hb + 0.1, 0.36, hb + 0.14, 40));
      door(0.46, 0.8, hb + 0.06, top - 0.06); louv(0.84, 0.97, hb + 0.08, top - 0.08, 12); eye(0.5); exh(0.88);
      it.push(cyc(0.44, top - 0.08, 0.012 * H));
    } else {   // sb: griglie d'aspirazione, due porte, golfari di sollevamento
      louv(0.035, 0.12, hb + 0.08, top - 0.06, 22); it.push(B(0.035, hb + 0.03, 0.12, hb + 0.07, 40));
      door(0.25, 0.47, hb + 0.06, top - 0.12); door(0.47, 0.69, hb + 0.06, top - 0.12);
      it.push(Ln([[0.2, top - 0.1], [0.74, top - 0.1]]), Ln([[0.73, hb], [0.73, top - lip]]));
      eye(0.22); eye(0.71); exh(0.86);
    }
    return it;
  },
  // gruppo elettrogeno visto dal lato del radiatore (uscita dell'aria)
  gensetEnd(xc, y, W, H, enc) {
    const it = [], P = (u, v) => [xc + (u - 0.5) * W, y + v * H], B = (u0, v0, u1, v1, f) => wkPg([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], f == null ? 255 : f, "a"), Ln = (pts) => Lgs(pts.map(q => P(q[0], q[1])), "a");
    const hb = Math.min(0.3, Math.max(0.1, 0.13 * H)) / H;
    it.push(B(0, 0, 1, hb, 70), B(0.03, hb * 0.25, 0.97, hb * 0.75, 95));
    if (enc === "open") {
      it.push(B(0.1, hb, 0.9, hb + 0.78, 255), B(0.15, hb + 0.04, 0.85, hb + 0.74, 236), { t: "c", x: xc, y: y + (hb + 0.39) * H, r: Math.min(W * 0.33, H * 0.33), s: "a" });
      for (let v = hb + 0.08; v < hb + 0.72; v += 0.04) it.push(Ln([[0.15, v], [0.85, v]]));
      it.push(B(0.42, hb + 0.8, 0.5, 1, 255));
      return it;
    }
    it.push(B(0, hb, 1, 0.975, 250), B(-0.015, 0.975, 1.015, 1, 236), B(0.1, hb + 0.3, 0.9, 0.92, 230));
    for (let v = hb + 0.33; v < 0.9; v += 0.025) it.push(Ln([[0.12, v], [0.88, v]]));
    it.push(B(0.38, hb + 0.08, 0.62, hb + 0.2, 246), { t: "c", x: xc + 0.3 * W, y: y + (hb + 0.14) * H, r: 0.02 * W, s: "a" });   // sportello del rifornimento
    return it;
  },
  // MOTOPOMPA COFANATA (77.83), come le motopompe carrellate: cofano insonorizzato con porta del quadro (display e pulsante d'emergenza), porta d'ispezione e griglia
  // dell'aria, telaio scuro con il serbatoio; su carrello (ruota con parafango, timone con ruotino, piedi di stazionamento) o su slitta. Aspirazione in basso e
  // mandata in alto sulla testata di sinistra, con gli attacchi rapidi; x0 = testata, yb = appoggio, L lunghezza del cofano, H altezza totale
  motoCan(x0, yb, L, H, mode, dS, dD) {
    const it = [], tr = mode !== "skid", rw = tr ? Math.max(0.2, Math.min(0.36, 0.2 * H)) : 0, yc0 = yb + (tr ? rw * 1.15 : 0), hc = Math.max(0.12, 0.14 * H), yc1 = yc0 + hc, top = yb + H, he = top - yc1;
    const B = (a, b, c, d, f) => wkPg([[a, b], [c, b], [c, d], [a, d]], f == null ? 255 : f, "a"), Ln = (pts) => Lgs(pts, "a"), cyc = (x, y, r, f) => ({ t: "c", x, y, r, s: "a", ...(f != null ? { fg: f } : {}) });
    const X = (u) => x0 + u * L, V = (v) => yc1 + v * he;
    it.push(B(X(0), yc0, X(1), yc1, 70), B(X(0.02), yc0 + hc * 0.3, X(0.98), yc0 + hc * 0.7, 95));   // telaio con il serbatoio
    it.push(B(X(0), yc1, X(1), top - 0.03, 248), B(X(-0.005), top - 0.03, X(1.005), top, 232));   // cofano e tetto
    const door = (u0, u1, v0, v1) => { it.push(B(X(u0), V(v0), X(u1), V(v1), 244), B(X(u0) + 0.015, V(v0) + 0.015, X(u1) - 0.015, V(v1) - 0.015, 250), B(X(u1) - 0.03, V((v0 + v1) / 2) - 0.04, X(u1) - 0.015, V((v0 + v1) / 2) + 0.04, 40)); [v0 + 0.12, v1 - 0.12].forEach(v => it.push(B(X(u0) - 0.008, V(v) - 0.02, X(u0) + 0.008, V(v) + 0.02, 30))); };
    door(0.52, 0.72, 0.1, 0.92); it.push(B(X(0.555), V(0.5), X(0.685), V(0.82), 215), B(X(0.575), V(0.66), X(0.665), V(0.78), 120), B(X(0.59), V(0.56), X(0.65), V(0.6), 200));   // porta del quadro con la finestra e il display
    it.push(B(X(0.45), V(0.48), X(0.49), V(0.58), 40), cyc(X(0.405), V(0.53), Math.min(0.035, 0.02 * L), 235), cyc(X(0.405), V(0.53), Math.min(0.018, 0.01 * L), 60));   // interruttore e pulsante d'emergenza
    door(0.27, 0.5, 0.1, 0.92); door(0.02, 0.25, 0.1, 0.92);
    it.push(B(X(0.05), V(0.22), X(0.22), V(0.8), 232)); for (let v = 0.26; v < 0.78; v += 0.06) it.push(Ln([[X(0.055), V(v)], [X(0.215), V(v)]]));   // griglia dell'aria
    it.push(B(X(0.86), top, X(0.89), top + 0.08, 255), B(X(0.85), top + 0.08, X(0.9), top + 0.1, 225), wkPg([[X(0.5) - 0.03, top], [X(0.5) - 0.03, top + 0.05], [X(0.5) + 0.03, top + 0.05], [X(0.5) + 0.03, top]], 255, "a"), cyc(X(0.5), top + 0.05, 0.025));   // scarico e golfare di sollevamento
    // testata: aspirazione in basso e mandata in alto, attacchi rapidi; adescamento sopra l'aspirazione
    const ys = yc1 + Math.max(0.18, he * 0.25), yd = yc1 + he * 0.68, oS = Math.max(0.06, (dS || 100) / 1000 * 1.1), oD = Math.max(0.06, (dD || 100) / 1000 * 1.1);
    [[ys, oS], [yd, oD]].forEach(([y, od]) => { it.push(cyc(x0, y, od * 0.75, 250), B(x0 - 0.16, y - od / 2, x0, y + od / 2, 238), B(x0 - 0.24, y - od * 0.62, x0 - 0.16, y + od * 0.62, 215), B(x0 - 0.28, y - od * 0.5, x0 - 0.24, y + od * 0.5, 245)); });
    it.push(B(x0 - 0.1, ys + oS / 2, x0 - 0.07, ys + oS / 2 + 0.12, 200), cyc(x0 - 0.085, ys + oS / 2 + 0.15, 0.03, 245));   // valvola d'adescamento con il vuotometro
    if (tr) {   // carrello: ruota con parafango, assale, piedi di stazionamento, timone con il ruotino
      const xa = X(0.55); it.push(wkPg([[xa - rw * 1.25, yc0], [xa - rw * 1.15, yc0 + rw * 0.55], [xa - rw * 0.6, yc0 + rw * 0.85], [xa + rw * 0.6, yc0 + rw * 0.85], [xa + rw * 1.15, yc0 + rw * 0.55], [xa + rw * 1.25, yc0]], 220, "a"));
      it.push(cyc(xa, yb + rw, rw, 50), cyc(xa, yb + rw, rw * 0.6, 225), cyc(xa, yb + rw, rw * 0.16, 60));
      [X(0.04), X(0.94)].forEach(xj => it.push(B(xj - 0.025, yb + 0.03, xj + 0.025, yc0, 225), B(xj - 0.07, yb, xj + 0.07, yb + 0.03, 200), B(xj + 0.025, yc0 - 0.15, xj + 0.07, yc0 - 0.13, 40)));
      const xt = X(1) + Math.max(0.8, L * 0.32), yt = yc0 + hc * 0.35; it.push(wkPg([[X(1), yc0 + hc * 0.15], [xt - 0.12, yt - 0.02], [xt - 0.12, yt + 0.04], [X(1), yc0 + hc * 0.65]], 205, "a"), B(xt - 0.14, yt - 0.04, xt + 0.02, yt + 0.06, 180), cyc(xt, yt + 0.01, 0.045, 225));
      it.push(B(X(1) + 0.25, yb + 0.1, X(1) + 0.29, yt, 200), cyc(X(1) + 0.27, yb + 0.07, 0.07, 60));   // ruotino d'appoggio del timone
    } else it.push(B(X(0.03), yb, X(0.13), yb + 0.03, 40), B(X(0.87), yb, X(0.97), yb + 0.03, 40));   // pattini della slitta
    it.suc = [x0 - 0.28, ys]; it.del = [x0 - 0.28, yd]; it.end = X(1) + (tr ? Math.max(0.8, L * 0.32) + 0.05 : 0); it.top = top + 0.1; it.can = 1; it.yd = yd;
    return it;
  },
  // la stessa vista dalla testata (pompa girata verso chi guarda): cofano, telaio, le due ruote, aspirazione in basso e mandata in alto verso chi guarda
  motoCanEnd(xc, yb, W, H, mode, dS, dD) {
    const it = [], tr = mode !== "skid", rw = tr ? Math.max(0.2, Math.min(0.36, 0.2 * H)) : 0, yc0 = yb + (tr ? rw * 1.15 : 0), hc = Math.max(0.12, 0.14 * H), yc1 = yc0 + hc, top = yb + H, he = top - yc1;
    const B = (a, b, c, d, f) => wkPg([[a, b], [c, b], [c, d], [a, d]], f == null ? 255 : f, "a"), cyc = (x, y, r, f) => ({ t: "c", x, y, r, s: "a", ...(f != null ? { fg: f } : {}) });
    if (tr) [-1, 1].forEach(sg => it.push(B(xc + sg * W * 0.42 - 0.09, yb, xc + sg * W * 0.42 + 0.09, yb + 2 * rw, 50), B(xc + sg * W * 0.42 - 0.13, yb + 2 * rw - 0.02, xc + sg * W * 0.42 + 0.13, yc0 + 0.02, 220)));   // ruote e parafanghi di testa
    it.push(B(xc - W / 2, yc0, xc + W / 2, yc1, 70), B(xc - W / 2, yc1, xc + W / 2, top - 0.03, 248), B(xc - W / 2 - 0.01, top - 0.03, xc + W / 2 + 0.01, top, 232), B(xc - W * 0.42, yc1 + he * 0.08, xc + W * 0.42, top - he * 0.06, 244));
    const ys = yc1 + Math.max(0.18, he * 0.25), yd = yc1 + he * 0.68, oS = Math.max(0.06, (dS || 100) / 1000 * 1.1), oD = Math.max(0.06, (dD || 100) / 1000 * 1.1);
    it.push(cyc(xc, ys, oS * 0.85, 225), cyc(xc, ys, oS / 2, 255), cyc(xc, yd, oD * 0.85, 225), cyc(xc, yd, oD / 2, 255));
    it.suc = [xc, ys]; it.del = [xc, yd]; it.top = top + 0.05; it.front = 1; it.can = 1;
    return it;
  },
  // pompa ad asse orizzontale sul basamento (yb = piano d'appoggio), aspirazione a sinistra, mandata in alto; con motore elettrico o diesel.
  // o: Lp lunghezza della pompa, hs altezza dell'asse, Lc giunto, Lm lunghezza del motore, diesel, Hd altezza del motore diesel. Restituisce anche suc, del, end
  horiz(x0, yb, o) {
    if (o.diesel && o.can) { const Ld = o.Lm || o.Lp * 2, L = o.Lp + Math.max(0.04, o.Lc || 0.08) + Ld, H = Math.max(0.9, (o.Hd || o.hs * 2.4) * 1.12) + (o.can === "skid" ? 0.06 : 0.42); return wkSym.motoCan(x0, yb, L, H, o.can, o.dS, o.dD); }   // motopompa cofanata (77.83)
    const sxP = o.Lp / 84.6, syP = o.hs / 22.86, ya = yb + o.hs, it = [];
    it.push(...wkArt("hPump", (u) => x0 + (u + 4.84) * sxP, (v) => ya - v * syP, null, 0.4 * sxP));
    let xe = x0 + o.Lp;
    if (o.diesel) { const Ld = o.Lm || o.Lp * 2, Hd = o.Hd || o.hs * 2.4, xd = xe + Math.max(0.04, o.Lc || 0.08);
      it.push(wkPg([[xe, ya - 0.04], [xd, ya - 0.04], [xd, ya + 0.04], [xe, ya + 0.04]], 255, "a"), ...wkSym.diesel(xd, yb, Ld, Hd, o.hs)); xe = xd + Ld; }
    else { const Lc = o.Lc || 0.12, sxG = Lc / 20.73, sxM = (o.Lm || 0.6) / 69.26, syM = o.hs / 22.57;
      it.push(...wkArt("hGuard", (u) => xe + (u - 0.26) * sxG, (v) => ya - v * syP, null, 0.4 * sxP)); xe += Lc;
      it.push(...wkArt("hMotor", (u) => xe + (u - 0.32) * sxM, (v) => ya - v * syM, null, 0.4 * sxM)); xe += o.Lm || 0.6; }
    it.suc = [x0, ya]; it.del = [x0 + (22 + 4.84) * sxP, ya + 36.93 * syP]; it.end = xe; it.top = ya + 36.93 * syP;
    return it;
  },
};
const Lgs = (pts, s) => ({ t: "l", pts, s: s || "k" });
const wkCan = (p, def) => p && p.motoT === "open" ? null : ((p && p.motoT) || def || "trailer");   // motopompa: cofanata su carrello (di serie), su slitta, o a vista (77.83)
// plinti della piazzola del pivot (77.61): uno sotto ogni gamba, come nei disegni di fondazione dei costruttori (Bauer e gli altri): lato e profondità sotto il piano campagna
const WK_PLINTO = 0.8, WK_PLINTO_D = 1.0;
// sezioni molto profonde: il tratto fra ya e yb si accorcia a un'interruzione di g metri (le quote portano la misura vera)
const wkBreakY = (ya, yb, g) => (y) => !(yb < ya - 3) ? y : y >= ya ? y : y <= yb ? y + (ya - yb) - g : ya - g * (ya - y) / (ya - yb);

// ---- COMPUTO DELLA TAVOLA (77.72): tubi e pezzi speciali, valvole, kit flangia per DN, macchine e opere civili ----
// bulloneria EN 1092-1 PN 16 per DN (WK_DN): fori, filetto, spessore della flangia (mm, tipo 11); bulloni ISO 4014/4017, dadi ISO 4032, rondelle ISO 7089
const WK_FB = { n: [4, 8, 8, 8, 8, 8, 12, 12, 12, 16, 16, 20], M: [16, 16, 16, 16, 16, 20, 20, 24, 24, 24, 27, 30], C: [18, 18, 20, 20, 22, 22, 24, 26, 28, 30, 32, 34] };
const WK_BLT = [50, 55, 60, 65, 70, 75, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200, 220, 240, 260, 280, 300];
const WK_PEOD = { 50: 63, 65: 75, 80: 90, 100: 110, 125: 140, 150: 160, 200: 225, 250: 280, 300: 315, 350: 355, 400: 450, 500: 560 };   // tubo PE / PVC: Ø esterno per il DN della flangia
// kit di un giunto: F = scartamento della valvola wafer serrata fra le flange (mm, 0 = giunto semplice) → n × M×L (tiranti per le wafer)
function wkFKit(dn, F) {
  const i = wkDnI(dn), n = WK_FB.n[i], M = WK_FB.M[i], C = WK_FB.C[i], w = M >= 24 ? 4 : 3, m = { 16: 14.8, 20: 18, 24: 21.5, 27: 23.8, 30: 25.6 }[M], P = { 16: 2, 20: 2.5, 24: 3, 27: 3, 30: 3.5 }[M];
  if (F) return { n, M, L: Math.ceil((2 * C + 6 + F + 2 * w + 2 * m + 2 * P) / 10) * 10, rod: 1 };
  const l0 = 2 * C + 3 + 2 * w + m + 2 * P; return { n, M, L: WK_BLT.find(x => x >= l0) || Math.ceil(l0 / 10) * 10 };
}
function wkBomMk() {
  const rows = {}, pipes = {}, joints = {};
  return { rows, pipes, joints,
    add(cat, sig, desc, qty, u) { if (!(qty > 0)) return; if (!rows[sig]) rows[sig] = { cat, sig, desc, qty: 0, u }; rows[sig].qty += qty; },
    joint(dn, F, g, mult) { const k = dn + "|" + (F || 0) + "|" + g; (joints[k] = joints[k] || { dn, F: F || 0, g, n: 0 }).n += mult; } };
}
// una linea flangiata dalla monte a valle: {k:"end", dn} attacco di una macchina o di un tubo esistente · {k:"pipe", dn, L} tubo (pezzi da 6 m al massimo)
// · {k:"elb", dn} curva 90° · {k:"red", a, b, ecc} riduzione · {k:"acc", a, dn} accessorio (le wafer stanno serrate fra due flange) · {k:"piece", sig, desc, dn} pezzo flangiato · {k:"tap", a, dn} presa filettata
function wkBomChain(B, seq, mult, t) {
  mult = mult || 1; let prev = null, waf = [];
  const link = (dn) => { if (prev != null) { if (waf.length) waf.forEach(w => B.joint(dn, w.F, w.g, mult)); else B.joint(dn, 0, 1, mult); } waf = []; };
  seq.forEach(s => { if (!s) return;
    if (s.k === "tap") { B.add("valv", "wk_tap_" + s.a + (s.dn ? "_" + s.dn : ""), t("wk_acc_" + s.a), mult, "n°"); return; }
    if (s.k === "acc" && (s.a === "check" || s.a === "wafer")) { waf.push({ F: Math.round(wkAccL(s.a, s.dn) * 1000), g: s.a === "check" ? 2 : 0 }); B.add("valv", "wk_v_" + s.a + "_" + s.dn, t("wk_acc_" + s.a) + " DN " + s.dn + " PN 16", mult, "n°"); return; }
    if (s.k === "acc" && (s.a === "gauge" || s.a === "air")) { B.add("valv", "wk_tap_" + s.a, t("wk_acc_" + s.a), mult, "n°"); return; }
    if (s.k === "pipe") { if (!(s.L > 0.05)) return; const nS = Math.max(1, Math.ceil(s.L / 6 - 1e-6)), q = (B.pipes[s.dn] = B.pipes[s.dn] || { L: 0, n: 0 }); q.L += s.L * mult; q.n += nS * mult; for (let j = 0; j < nS; j++) { link(s.dn); prev = s.dn; } return; }
    const dIn = s.k === "red" ? s.a : s.dn, dOut = s.k === "red" ? s.b : s.dn;
    if (s.k === "elb") B.add("pipe", "wk_elb_" + s.dn, t("wk_bmElb").replace("{dn}", s.dn), mult, "n°");
    else if (s.k === "red" && s.a !== s.b) B.add("pipe", "wk_red_" + (s.ecc ? "e" : "c") + "_" + Math.max(s.a, s.b) + "_" + Math.min(s.a, s.b), t(s.ecc ? "wk_bmRedE" : "wk_bmRedC").replace("{a}", s.a).replace("{b}", s.b), mult, "n°");
    else if (s.k === "acc") B.add("valv", "wk_v_" + s.a + "_" + s.dn, t("wk_acc_" + s.a) + " DN " + s.dn + " PN 16", mult, "n°");
    else if (s.k === "piece") B.add(s.cat || "pipe", s.sig, s.desc, mult, "n°");
    link(dIn); prev = dOut; });
}
// linea lungo un percorso del disegno (metri) con gli accessori posati sopra: tubi fra le curve, accessori al loro posto; hz = lunghezza in pianta dei tratti orizzontali (se diversa dal prospetto)
function wkBomPath(path, acc, dn, hz) {
  const seg = []; let sTot = 0;
  for (let i = 1; i < path.length; i++) { const a = path[i - 1], b = path[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1e-6) continue; seg.push({ a, b, L, s0: sTot, h: Math.abs(b[1] - a[1]) < 1e-3 }); sTot += L; }
  const hL = seg.filter(g => g.h).reduce((m, g) => m + g.L, 0), kh = hz && hL > 0.05 ? hz / hL : 1;
  const ev = [];   // eventi lungo il percorso: curve e accessori
  for (let i = 1; i < seg.length; i++) { const u1 = [seg[i - 1].b[0] - seg[i - 1].a[0], seg[i - 1].b[1] - seg[i - 1].a[1]], u2 = [seg[i].b[0] - seg[i].a[0], seg[i].b[1] - seg[i].a[1]]; if (Math.abs(u1[0] * u2[1] - u1[1] * u2[0]) > 1e-6 * seg[i - 1].L * seg[i].L) ev.push({ s: seg[i].s0, k: "elb" }); }
  (acc || []).forEach(a => { let best = null; seg.forEach(g => { const dx = g.b[0] - g.a[0], dy = g.b[1] - g.a[1], tt = Math.max(0, Math.min(1, ((a.x - g.a[0]) * dx + (a.y - g.a[1]) * dy) / (g.L * g.L))), d = Math.hypot(a.x - g.a[0] - dx * tt, a.y - g.a[1] - dy * tt); if (!best || d < best.d) best = { d, s: g.s0 + tt * g.L }; }); ev.push({ s: best ? best.s : sTot, k: "acc", a: a.k }); });
  ev.sort((x, y) => x.s - y.s);
  const od = Math.max(0.05, dn / 1000 * 1.1), seq = []; let s = 0, carry = 0;   // carry: tratti corti fra due pezzi (si imbullonano diretti), sommati al tubo successivo
  const lenOf = (s0, s1) => { let L = 0; seg.forEach(g => { const a = Math.max(s0, g.s0), b = Math.min(s1, g.s0 + g.L); if (b > a) L += (b - a) * (g.h ? kh : 1); }); return L; };
  ev.forEach(e => { const lp = e.k === "elb" ? od * 1.5 : e.a === "gauge" || e.a === "air" ? 0 : wkAccL(e.a, dn) / 2; let L = lenOf(s, e.s) - lp - (seq.length && seq[seq.length - 1]._t ? seq[seq.length - 1]._t : 0);
    if (L >= 0.3) { seq.push({ k: "pipe", dn, L: L + carry }); carry = 0; } else if (L > 0) carry += L;
    seq.push(e.k === "elb" ? { k: "elb", dn, _t: od * 1.5 } : e.a === "gauge" || e.a === "air" ? { k: "tap", a: e.a } : { k: "acc", a: e.a, dn, _t: wkAccL(e.a, dn) / 2 }); s = e.s; });
  const Lr = lenOf(s, sTot) - (seq.length && seq[seq.length - 1]._t ? seq[seq.length - 1]._t : 0) + carry;
  if (Lr >= 0.3) seq.push({ k: "pipe", dn, L: Lr }); else if (Lr > 0.05) { const lp = [...seq].reverse().find(q => q.k === "pipe"); if (lp) lp.L += Lr; else seq.push({ k: "pipe", dn, L: Lr }); }
  return seq;
}
// righe finali: tubi, kit flangia (con la bulloneria), macchine e opere civili dalle quantità della tavola
function wkBomOut(B, qty, t) {
  Object.keys(B.pipes).map(Number).sort((a, b) => a - b).forEach(dn => { const q = B.pipes[dn]; B.add("pipe", "wk_pipe_fl_" + dn, t(q.n === 1 ? "wk_bmPipe1" : "wk_bmPipe").replace("{dn}", dn).replace("{n}", q.n), Math.ceil(q.L * 10) / 10, "m"); });
  const kits = Object.values(B.joints).sort((a, b) => a.dn - b.dn || a.F - b.F).map(j => { const k = wkFKit(j.dn, j.F); return { dn: j.dn, F: j.F, n: j.n, b: k.n, M: k.M, L: k.L, rod: !!k.rod, bolts: j.n * k.n, nuts: j.n * k.n * (k.rod ? 2 : 1), wash: j.n * k.n * 2, gask: j.n * j.g }; });
  kits.forEach(k => { const g = k.gask / k.n, desc = t(k.rod ? "wk_bmKitW" : "wk_bmKit").replace("{dn}", k.dn).replace("{f}", k.F).split("{n}").join(k.b).replace("{m}", "M" + k.M).replace("{l}", k.L).replace("{nd}", k.b * (k.rod ? 2 : 1)).replace("{w}", k.b * 2) + (g ? " · " + t(g > 1 ? "wk_bmGask2" : "wk_bmGask1") : "");
    B.add("kit", "wk_kit_" + k.dn + "_m" + k.M + "x" + k.L + (k.rod ? "_w" + k.F : "") + "_g" + g, desc, k.n, "n°"); });
  const civ = { [t("wk_qConc")]: "conc", [t("wk_qConcPad")]: "conc_pad", [t("wk_qConcWell")]: "conc_well", [t("wk_qConcSump")]: "conc_well", [t("wk_qConcMoto")]: "conc_moto", [t("wk_qConcGen")]: "conc_gen", [t("wk_qLean")]: "lean", [t("wk_qDig")]: "dig", [t("wk_qSteel")]: "steel" };   // calcestruzzi delle singole opere su righe separate (78.29)
  const resv = Object.keys(B.rows).some(k => /^wk_res_/.test(k));   // reservoir: scavo, calcestruzzo e ferro hanno già le loro voci (78.28: niente righe doppie)
  (qty || []).forEach(q => { const c = civ[q[0]]; if (resv && (c === "dig" || /^conc/.test(c || "") || c === "steel")) return; if (c && +String(q[1]).replace(",", ".") > 0) B.add("civ", "wk_civ_" + c, q[0], +String(q[1]).replace(",", "."), q[2]); });
  const ord = { mach: 0, pipe: 1, valv: 2, kit: 3, civ: 4 };
  return { rows: Object.values(B.rows).sort((a, b) => ord[a.cat] - ord[b.cat]).map(r => ({ ...r, qty: Math.round(r.qty * 100) / 100 })), kits,
    T: { pcs: t("wk_uPcs"), more: t("wk_notesMore"), notesC: t("wk_notesCont"), title: t("wk_bmTitle"), cats: { mach: t("wk_bmCMach"), pipe: t("wk_bmCPipe"), valv: t("wk_bmCValv"), kit: t("wk_bmCKit"), civ: t("wk_bmCCiv") }, cols: [t("wk_bmPos"), t("wk_bmItem"), t("wk_bmQty"), t("wk_bmU")],
      kc: [t("wk_bmKDn"), t("wk_bmKJoint"), t("wk_bmKN"), t("wk_bmKBolts"), t("wk_bmKNuts"), t("wk_bmKWash"), t("wk_bmKGask")], kn: t("wk_bmKitNorm"), kw: t("wk_bmKitWaf"), note: t("wk_bmNote"), tot: t("wk_bmTot") } };
}
// GEOMETRIA DELLA POMPA VERTICALE IN VASCA O IN POZZO (78.29): un'unica fonte per la tavola della stazione e per quella della pompa verticale
// (sommergenza, travi o soletta, linea d'asse, fondo, pesi): le due tavole della stessa stazione disegnano le stesse misure
function wkVertGeo(p) {
    const n = Math.max(1, Math.round(p.n || 1)), D = Math.max(0.1, p.D), H0 = p.H, lift = Math.max(0.3, +p.lift || 3), well = p.inst ? p.inst === "well" : !!p.well, canal = p.inst === "sump";
    const pitch = Math.max(4 * D, p.pL + 0.4), side = Math.max(2 * D, p.pL / 2 + 0.4), W = (n - 1) * pitch + 2 * side, back = Math.max(1.5 * D, p.pL / 2 + 0.15), Lf = Math.max(6 * D, 1.5);
    // pozzetto aperto (77.78): niente soletta, le pareti salgono al piano campagna e ogni pompa poggia su due travi d'acciaio HEB appoggiate sui muri,
    // sulla luce minore (fra le pareti laterali o fra la parete di presa e quella di fondo); profilo dal peso in esercizio × 1,5 (avviamento e vibrazioni), freccia ≤ L/1000
    // sommergenza minima (77.80), dalla bocca della succheruola: la più severa fra corpo pompa sempre sott'acqua con 0,30 m di battente (prescrizione del catalogo),
    // 2,5 D dello schema d'installazione e ANSI/HI 9.8 contro i vortici S = D (1 + 2,3 F), F = V / √(g D), V velocità nella bocca
    const qP = (+p.Q || 0) / 3600 / n, vB = qP / (Math.PI / 4 * D * D), sHI = D * (1 + 2.3 * vB / Math.sqrt(9.81 * D)), sBody = p.Hb + 0.3, s25 = Math.max(p.sub, 2.5 * D), Sreq = Math.max(s25, sHI, sBody);
    // carico sulle travi (77.88): macchina più l'acqua che la riempie in esercizio (colonna, corpo pompa, testata e accessori della mandata pieni)
    const LcE = Math.max(1, lift + Sreq - p.Hb + 0.2), kgDry = p.kgM + p.kgH + LcE / p.lsL * p.kgLs + p.kgB + p.kgA + p.kgT;
    const kgWet = wkColWater(p.lsD, LcE) + Math.PI / 4 * Math.pow(D * 0.9, 2) * p.Hb * 0.45 * 1000 + Math.PI / 4 * Math.pow(p.dnD / 1000, 2) * p.Hh * 0.6 * 1000 + wkAccWet(wkAccRec("vert").map(k => ({ k, dn: p.dnD })));
    const kgE = kgDry + kgWet;
    const spT = W, spL = Lf + 0.3 + back, trans = spT <= spL, bmL = (trans ? spT : spL) + 0.6, bmC = well ? null : wkBeam(trans ? spT : spL, kgE, trans ? n : 1), bmF = Math.max(1, +p.bmF || 2), bm = bmC && bmF > 1 ? wkBeam(trans ? spT : spL, kgE, trans ? n : 1, Math.round(bmC.h * bmF - 1)) : bmC;   // trave posata: alta bmF volte quella di calcolo (di serie il doppio)
    const H = well ? H0 : -(bm.h / 1000 + 0.02), aB = bm ? Math.max(D / 2 + 0.06 + bm.b / 2000, p.pL / 2 - bm.b / 2000) : 0;   // H < 0: la piastra di base sopra le travi
    const cl = Math.max(p.floor, 0.3 * D), need = lift + Sreq - p.Hb - H;   // linea d'asse fra soletta e testa del corpo pompa
    const sF = canal ? (["pipe", "side", "end"].includes(p.sF) ? p.sF : "pipe") : null, dnI = [300, 400, 500, 600, 800, 1000, 1200].find(d => d >= (p.dnC || p.dnD)) || 1200, nI = Q2n(p.Q, dnI);
    const sW = canal && sF !== "pipe" ? (["win", "gate", "rack", "pipes"].includes(p.sWall) ? p.sWall : "win") : null;   // parete fra pozzetto e canale (77.82): finestra con griglia e panconi, paratoia, griglia a tutta altezza, tubi passanti   // presa: tubo corrugato SN8 o pozzetto a fianco / in testa al canale
    const bedC = -lift - (+p.canD || 1.5), sFl = canal ? (["low", "same", "high"].includes(p.sFl) ? p.sFl : "low") : "low", dFl = Math.max(0, p.dFl != null && p.dFl !== "" ? +p.dFl : (sFl === "high" ? 0.3 : 0.5));
    let Lc = Math.max(1.0, Math.ceil(need / 0.5 - 1e-6) * 0.5), yFfix = null, flForced = false;
    if (sFl !== "low") { yFfix = bedC + (sFl === "high" ? dFl : 0); const Lmax = Math.floor((-H - (yFfix + cl + p.Hb)) / 0.5 + 1e-6) * 0.5;   // la pompa si alza fin dove il fondo fissato lo permette
      if (Lmax >= 1.0) Lc = Lmax; else { Lc = 1.0; flForced = true; } }
    const nF = Math.floor(Lc / p.lsL + 1e-6), rem = Math.round((Lc - nF * p.lsL) * 100) / 100, nLs = nF + (rem > 0.01 ? 1 : 0), nEq = Lc / p.lsL;
    const yt = -H - Lc, yI = yt - p.Hb, S = -lift - yI, yF = sFl === "low" ? Math.min(yI - cl, canal ? bedC - dFl : yI - cl) : (flForced ? yI - cl : yFfix);
    const kgU = Math.round(p.kgM + p.kgH + nEq * p.kgLs + p.kgB + p.kgA + p.kgT), wd = WK_CASING.find(x => x / 1000 >= D + 0.06) || 600;
  return { n, D, H0, lift, well, canal, pitch, side, W, back, Lf, qP, vB, sHI, sBody, s25, Sreq, LcE, kgDry, kgWet, kgE, spT, spL, trans, bmL, bmC, bmF, bm, H, aB, cl, need, sF, dnI, nI, sW, bedC, sFl, dFl, Lc, yFfix, flForced, nF, rem, nLs, nEq, yt, yI, S, yF, kgU, wd };
}
// ---- costruzione delle tavole: viste in metri ----
function wkBuild(type, p, t) {
  WK_DEC = t("wk_decSep") === "." ? "." : ",";
  const V = [], notes = [], qty = [], pos = {};   // pos: posizioni degli elementi trascinabili (metri), per la pagina
  let accL = null, layL = null;   // accessori della mandata della tavola (consigliati o scelti a mano)
  const BM = wkBomMk(), bomL = (path, dn, mult, d0) => wkBomChain(BM, [{ k: "end", dn: d0 || dn }, d0 && d0 < dn ? { k: "red", a: d0, b: dn } : null, ...wkBomPath(path, accL, dn), { k: "end", dn }], Math.max(1, Math.round(+mult || 1)), t);   // computo della mandata (77.72)
  const view = (title, items, extra) => { const v = { title, items, ...(extra || {}) }; V.push(v); return v; };
  const R = (x, y, w, h, s) => ({ t: "r", x, y, w, h, s: s || "k" });
  const Lg = (pts, s) => ({ t: "l", pts, s: s || "k" });
  const C = (x, y, r, s) => ({ t: "c", x, y, r, s: s || "k" });
  const Dm = (a, b, o, txt) => ({ t: "d", a, b, o, txt });
  const Tx = (x, y, s, h, al) => ({ t: "x", x, y, s, h: h || 2.6, al: al || "c" });
  const Ld = (a, b, s) => ({ t: "ld", a, b, s });
  const Pp = (pts, dn, ek) => ({ t: "p", pts, dn, ...(ek ? { ek } : {}) });   // ek: diametro modificabile cliccando sul tubo (77.63)
  // piramide del pivot vista dall'alto: piazzola, quattro gambe dai tirafondi al collettore, tubo centrale (punto pivot)
  const pyrTop = (x, y, L, B, tube, lab, F, By) => { const h = L / 2, b = B / 2, bY = (By || B) / 2, pl = F || WK_PLINTO, rt = Math.max(0.08, (tube || 203) / 2000), rc = rt + 0.12, out = [R(x - h, y - h, L, L, "h")];
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy]) => { const fx = x + sx * b, fy = y + sy * bY; out.push(R(fx - pl / 2, fy - pl / 2, pl, pl, "h"), R(fx - 0.13, fy - 0.13, 0.26, 0.26, "k"), Lg([[fx, fy], [x + sx * rc * 0.72, y + sy * rc * 0.72]], "k"), Lg([[fx - sy * 0.05, fy + sx * 0.05], [x + sx * rc * 0.72 - sy * 0.03, y + sy * rc * 0.72 + sx * 0.03]], "t")); });
    out.push(Lg([[x - b, y - bY], [x + b, y - bY], [x + b, y + bY], [x - b, y + bY], [x - b, y - bY]], "t"), C(x, y, rc, "k"), C(x, y, rt, "k"), C(x, y, 0.03, "k"), Lg([[x - h - 0.3, y], [x + h + 0.3, y]], "cl"), Lg([[x, y - h - 0.3], [x, y + h + 0.3]], "cl"));
    if (lab) out.push(Tx(x, y - h - 0.45, lab, 2.4, "c")); return out; };
  // TRACCIA DEL TAGLIO IN PIANTA (78.29): linea mista, tratti forti e frecce agli estremi (verso di vista: sg = +1 a sinistra del percorso), lettera fuori dal contorno
  const cutT = (pts, lab, sg) => [{ t: "cut", pts, lab, sg: sg || 1 }];   // segni in misure di carta, disegnati da wkDraw
  // TUBO NASCOSTO (78.29): tubo interrato o dietro il piano di sezione, a tratteggio (i due contorni)
  const hidP = (pts, dn) => { const r = Math.max(0.05, (dn || 100) / 1000 * 1.1) / 2, side = (sg) => pts.map((q, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], u1 = i ? [q[0] - a[0], q[1] - a[1]] : [b[0] - q[0], b[1] - q[1]], u2 = i < pts.length - 1 ? [b[0] - q[0], b[1] - q[1]] : u1;
      const n1 = (() => { const l = Math.hypot(u1[0], u1[1]) || 1; return [-u1[1] / l, u1[0] / l]; })(), n2 = (() => { const l = Math.hypot(u2[0], u2[1]) || 1; return [-u2[1] / l, u2[0] / l]; })(), m = [n1[0] + n2[0], n1[1] + n2[1]], ml = Math.hypot(m[0], m[1]) || 1, c = Math.max(0.3, (m[0] * n1[0] + m[1] * n1[1]) / ml);
      return [q[0] + sg * r * m[0] / ml / c, q[1] + sg * r * m[1] / ml / c]; });
    return [{ t: "l", pts: side(1), s: "h" }, { t: "l", pts: side(-1), s: "h" }]; };
  const Vv = (x, y, ang, k) => ({ t: "v", x, y, ang: ang || 0, k: k || "gate" });
  const ground = (x0, x1, y) => ({ t: "g", x0, x1, y });
  // SOMMERGENZA (77.80), dalla bocca d'aspirazione (succheruola, valvola di fondo o griglia della sommersa): la più severa fra ANSI/HI 9.8 contro i vortici
  // S = d (1 + 2,3 F) con F = V / √(g d), corpo pompa sempre sommerso (body m sopra la bocca più il battente b) e un minimo pratico m0
  const subQ = (d, q, body, b, m0) => { const dd = Math.max(0.05, d), v = Math.max(0, q) / (Math.PI / 4 * dd * dd), hi = dd * (1 + 2.3 * v / Math.sqrt(9.81 * dd)), cb = body > 0 ? body + b : 0; return { v, hi, cb, m0: m0 || 0, S: Math.max(hi, cb, m0 || 0) }; };
  const subG = (arr, x, yI, c, xl, xr, Yf, lf, rt) => { const F = Yf || ((v) => v), yM = yI + c.S; arr.push(Lg([[xl - (lf ? 0.5 : 0), F(yM)], [xr + (lf ? 0 : 0.5), F(yM)]], "h"), Dm([x, F(yI)], [x, F(yM)], rt ? -0.01 : 0, "S min " + fmtM(c.S)), lf ? Tx(xl - 0.6, F(yM) - 0.07, t("wk_minLev"), 1.9, "r") : Tx(xr + 0.6, F(yM) - 0.07, t("wk_minLev"), 1.9, "l")); };   // lf: la scritta a sinistra   // livello minimo ammesso, tratteggiato, e la quota S min
  const subN = (lab, c, Sa) => { const v = (Math.round(c.v * 100) / 100).toFixed(2).replace(".", WK_DEC), li = [t("wk_subHI").replace("{h}", fmtM(c.hi)).replace("{v}", v)].concat(c.cb ? [t("wk_subBody").replace("{c}", fmtM(c.cb))] : [], c.m0 ? [t("wk_subMin0").replace("{m}", fmtM(c.m0))] : []);
    notes.push(t("wk_nSubChk").replace("{p}", lab).replace("{a}", fmtM(Sa)).replace("{s}", fmtM(c.S)).replace("{list}", li.join(", ")) + " " + t(Sa >= c.S - 0.005 ? "wk_subOk" : "wk_subKo")); };
  // ALTEZZA MINIMA DELLA VALVOLA DI FONDO DAL FONDO (77.89): 1,5 volte il Ø della bocca, mai meno di 0,30 m, per non aspirare sabbia e fango
  const flQ = (d) => Math.max(0.3, Math.ceil(1.5 * Math.max(0.05, d) * 20 - 1e-6) / 20);
  const flG = (arr, x, yI, yFl, hm, Yf, xr) => { const F = Yf || ((v) => v), yM = yFl + hm; if (yI - yM > 0.03) arr.push(Lg([[x - 0.3, F(yM)], [xr != null ? xr : x + 0.3, F(yM)]], "h")); arr.push(Dm([x, F(yFl)], [x, F(yM)], 0, "h min " + fmtM(hm))); };   // quota minima tratteggiata sopra il fondo
  const flN = (lab, a, hm, d) => notes.push(t("wk_nFlChk").replace("{p}", lab).replace("{a}", fmtM(a)).replace("{m}", fmtM(hm)).replace("{d}", fmtM(d)) + " " + t(a >= hm - 0.005 ? "wk_subOk" : "wk_flKo") + (hm > 0.305 && 1.5 * d < hm - 0.005 ? t("wk_nFlRnd").replace("{d}", fmtM(d)).replace("{r}", fmtM(1.5 * d)).replace("{m}", fmtM(hm)) : ""));
  // DETTAGLIO C DELLA PRESA (77.89): la valvola di fondo in grande, con il livello e la sommergenza, il fondo sotto la bocca e l'altezza minima
  const clipX = (pl, xa, xb) => { const o = []; for (let i = 0; i < pl.length; i++) { const q = pl[i], r = pl[i + 1]; if (q[0] >= xa && q[0] <= xb) o.push(q); if (r) { [xa, xb].forEach(xc => { if ((q[0] - xc) * (r[0] - xc) < 0) { const u = (xc - q[0]) / (r[0] - q[0]); o.push([xc, q[1] + u * (r[1] - q[1])]); } }); } }
    return o.sort((u, v) => u[0] - v[0] || u[1] - v[1]); };
  const footDet = (o) => { const xa = o.xm - 1.8, xb = o.xm + 1.8, it = [];
    o.gnd.forEach(pl => { const c = pl.every(q => q[0] >= xa && q[0] <= xb) ? pl : clipX(pl, xa, xb); if (c.length > 1) it.push(Lg(c, "k")); });
    const xc = o.xm - (o.dx || 0.55), xn = xc - 0.55;   // in catena le quote reali (livello → bocca → fondo), più in fuori le minime (S min sopra la bocca, h min sopra il fondo)
    it.push(...o.vit, Dm([xc, o.lvl], [xc, o.yM], 0, "S " + fmtM(o.lvl - o.yM)), Dm([xc, o.yM], [xc, o.g], 0, fmtM(o.yM - o.g)), Lg([[xn - 0.75, o.g], [o.xm, o.g]], "h"), Lg([[xn - 0.3, o.yM], [o.xm - o.dS / 2, o.yM]], "h"));
    subG(it, xn, o.yM, o.cS, xn - 0.3, o.xm + 0.4); flG(it, xn - 0.45, o.yM, o.g, o.hF, null, o.xm + 0.4);
    it.push(Ld([o.xm + o.dS / 2, o.yM + 0.12], [o.xm + 0.95, o.yM + 0.45 + (o.lvl - o.yM) * 0.35], t("wk_footValve")), { t: "w", x0: Math.max(xa, o.wx0 != null ? o.wx0 : xa), x1: Math.min(xb, o.wx1 != null ? o.wx1 : xb), y: o.lvl });   // l'acqua per ultima: resta visibile anche sopra la linea del livello minimo
    view(t("wk_vFootDet"), it, { inset: 1 }); };
  const m3 = (v) => wkR(v, 2);
  if (type === "pad") {
    const e = p.emerg, top = e, mg = 0.10, bp = p.boltP, bl = p.boltL, fix = p.pp === "fix", dn = p.dn / 1000, d = p.depth;
    const bolt = t("wk_bolts").replace("{n}", "4").replace("{d}", p.boltD === 22 ? '7/8" UNC' : "M" + p.boltD).replace("{l}", Math.round(bl * 1000));
    const plan = [], sec = [];
    let vc, vm, vs;
    // IDRANTE A S (77.72): la tubazione interrata in PE o PVC arriva a fianco della piazzola; idrante a S d'acciaio con lo sfiato sulla curva alta,
    // idrovalvola e/o valvola manuale, tubo sopra la piazzola fino al centro e curva d'ingresso nella colonna del pivot (come nelle installazioni dei costruttori)
    const isHy = p.feed === "hyd", dnH = +p.dn || 150, odH = Math.max(0.05, dnH / 1000 * 1.1), yh = top + odH / 2 + 0.15, yp = yh + 0.55, ybq = -Math.max(0.6, +d || 1);
    const hyV = ["hyd", "man", "both"].includes(p.hyV) ? p.hyV : "both", mat = p.hyMat === "pvc" ? "pvc" : "pe";
    const hydr = (xe) => { const xh = xe + 0.8, xa = xh + 0.4, xs = xh + 2.3, Lh = wkAccL("hyd", dnH), Lw = wkAccL("wafer", dnH), vs = [];
      let x = xh - odH / 2 - 0.25; if (hyV !== "man") { vs.push(["hyd", x - Lh / 2]); x -= Lh; } if (hyV !== "hyd") { vs.push(["wafer", x - Lw / 2]); x -= Lw; }
      const Lab = { hyd: "IV", wafer: "VF" };
      // sezione: tubo interrato senza flange fino al collare (PE) o all'adattatore (PVC), idrante a S, valvole, tubo al centro, curva d'ingresso
      sec.push(...hidP([[xs, ybq], [xa, ybq], [xh, ybq], [xh, 0]], dnH), { t: "p", pts: [[xh, 0], [xh, yh + odH * 0.7]], dn: dnH, nf: 1, noBeg: 1 }, { t: "p", pts: [[xh - odH / 2, yh], [xh - odH / 2 - 0.25, yh]], dn: dnH, nf: 1, noBeg: 1 });   // idrante: sotto terra a tratteggio (78.29), risalita con il tee in alto
      sec.push(...wkAccDraw("air", xh, yh + odH * 0.7 + 0.02 - dnH / 1000 * 0.55, dnH, 0), Tx(xh + 0.12, yh + odH * 0.7 + 0.18, "SF", 1.9, "l"));
      vs.forEach(([k, xv]) => sec.push(...wkAccDraw(k, xv, yh, dnH, 0), Tx(xv, yh + (k === "hyd" ? dnH / 1000 * 1.62 + 0.12 : WK_FLD[wkDnI(dnH)] / 1000 * 1.03 + 0.12), Lab[k], 1.9, "c")));
      sec.push(Pp([[x, yh], [0, yh], [0, yp]], dnH, "dn"), R(-odH / 2, yp + 0.03, odH, 1.25, "h"), Ld([odH / 2, yp + 0.9], [-1.0, yp + 1.35], t("wk_pvColumn")));
      sec.push(Ld([xh + odH / 2, (ybq + 0) / 2], [xh + 1.0, top + 1.0], t("wk_hydS").replace("{d}", WK_PEOD[dnH] || dnH).replace("{dn}", dnH)), Tx(xs + 0.3, ybq - odH / 2 - 0.8, t(mat === "pe" ? "wk_hyPE" : "wk_hyPVC").replace("{d}", WK_PEOD[dnH] || dnH), 2, "r"));
      sec.push(Dm([xs - 0.25, 0], [xs - 0.25, ybq], -0.25), ground(xe + 0.7, xs + 0.3, 0));
      // pianta: idrante dall'alto, valvole, tubo al centro della piazzola; tubazione interrata tratteggiata
      plan.push(Lg([[xh + odH / 2, -odH / 2], [xs, -odH / 2]], "h"), Lg([[xh + odH / 2, odH / 2], [xs, odH / 2]], "h"), { t: "p", pts: [[xh - odH / 2, 0], [xh - odH / 2 - 0.25, 0]], dn: dnH, nf: 1, noBeg: 1 }, C(xh, 0, odH / 2, "k"), C(xh, 0, odH * 0.22, "t"));
      vs.forEach(([k, xv]) => plan.push(...wkAccDraw(k, xv, 0, dnH, 0), Tx(xv, odH + 0.35, Lab[k], 1.9, "c")));
      plan.push(Pp([[x, 0], [0, 0]], dnH), C(0, 0, odH / 2, "k"), Tx(xs, -odH / 2 - 0.42, t(mat === "pe" ? "wk_hyPE" : "wk_hyPVC").replace("{d}", WK_PEOD[dnH] || dnH), 2, "r"), Ld([xh + odH * 0.35, odH * 0.35], [xh + 0.7, odH + 0.8], t("wk_hydS").replace("{d}", WK_PEOD[dnH] || dnH).replace("{dn}", dnH)));
      wkBomChain(BM, [{ k: "piece", sig: "wk_hy_ad_" + mat + "_" + dnH, desc: t(mat === "pe" ? "wk_bmAdPE" : "wk_bmAdPVC").replace("{dn}", dnH).replace("{d}", WK_PEOD[dnH] || dnH), dn: dnH },
        { k: "piece", sig: "wk_hy_spe_" + dnH, desc: t("wk_bmHydS").replace("{d}", WK_PEOD[dnH] || dnH).replace("{dn}", dnH), dn: dnH }, { k: "tap", a: "air" }, hyV !== "man" ? { k: "acc", a: "hyd", dn: dnH } : null, hyV !== "hyd" ? { k: "acc", a: "wafer", dn: dnH } : null,
        { k: "pipe", dn: dnH, L: x - odH * 1.5 + 0 }, { k: "elb", dn: dnH }, { k: "pipe", dn: dnH, L: Math.max(0, yp - yh - odH * 1.5) }, { k: "end", dn: dnH }], 1, t);
      return xs; };
    if (p.shape === "plinths") {
      const F = p.F, hx = p.Bx / 2, hy = p.By / 2, H = p.Ht, cs = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
      cs.forEach(([x, y]) => { plan.push(R(x - F / 2, y - F / 2, F, F, "k"), C(x, y, 0.035, "k"), Lg([[x - 0.09, y], [x + 0.09, y]], "t"), Lg([[x, y - 0.09], [x, y + 0.09]], "t")); });
      plan.push(R(-hx, -hy, 2 * hx, 2 * hy, "h"), Lg([[-hx - F, 0], [hx + F, 0]], "cl"), Lg([[0, -hy - F], [0, hy + F]], "cl"));
      plan.push(Dm([-hx, -hy - F / 2], [hx, -hy - F / 2], -0.45), Dm([-hx - F / 2, -hy], [-hx - F / 2, hy], 0.45), Dm([-hx - F / 2, hy + F / 2], [-hx + F / 2, hy + F / 2], 0.3));   // interasse in y sul lato sinistro, lontano dall'idrante (78.29)
      plan.push(Ld([hx, hy], [hx - 0.9, hy + F / 2 + 0.55], bolt), Tx(0, -hy * 0.45, t("wk_cart"), 2.4, "c"));
      const xsC = isHy ? hydr(hx + F / 2) : hx + F / 2;
      plan.push(...cutT([[-hx - F / 2 - 0.7, 0], [xsC + 0.6, 0]], "A", 1));   // il taglio A-A sull'asse con la colonna e l'idrante (78.29)
      view(t("wk_vPlan"), plan);
      sec.push(ground(-hx - F / 2 - 0.7, hx + F / 2 + 0.7, 0));
      [-hx, hx].forEach(x => { sec.push(R(x - F / 2, top - H, F, H, "conc"), R(x - F / 2 - 0.05, top - H - mg, F + 0.1, mg, "lean"), Lg([[x, top + bp], [x, top - bl], [x + 0.05, top - bl - 0.04]], "k")); });
      sec.push(Dm([-hx, top - H - mg], [hx, top - H - mg], -0.35), Dm([hx + F / 2, top - H], [hx + F / 2, top], -0.3), Dm([-hx - F / 2, top - H], [-hx + F / 2, top - H], -0.6));
      sec.push(Tx(-hx - F / 2 - 0.2, 0.1, "±0" + WK_DEC + "00", 2.2, "r"), Ld([-hx - F / 4, top - H / 2], [-hx - F / 2 - 0.6, top - H * 0.25], t("wk_concPlinth")));   // fuori dalle valvole e dai tubi (78.29)
      view(t("wk_vSec") + " A-A", sec);
      vc = 4 * F * F * H; vm = 4 * (F + 0.1) * (F + 0.1) * mg; vs = 4 * (F + 0.4) * (F + 0.4) * (H - e + mg);
    } else {
      const L = p.L, h = L / 2, b = p.B / 2, F = p.F, fc = p.Fc / 2, Hs = p.Hs, Ht = p.Ht, rnd = !!p.round;
      plan.push(R(-h, -h, L, L, "k"));
      [[-fc, -fc], [fc, -fc], [fc, fc], [-fc, fc]].forEach(([x, y]) => plan.push(rnd ? C(x, y, F / 2, "h") : R(x - F / 2, y - F / 2, F, F, "h")));
      [[-b, -b], [b, -b], [b, b], [-b, b]].forEach(([x, y]) => plan.push(C(x, y, 0.04, "k"), Lg([[x - 0.1, y], [x + 0.1, y]], "t"), Lg([[x, y - 0.1], [x, y + 0.1]], "t")));
      plan.push(Lg([[-h - 0.3, 0], [h + 0.3, 0]], "cl"), Lg([[0, -h - 0.3], [0, h + 0.3]], "cl"));
      if (fix && !isHy) plan.push(C(0, 0, (dn + 0.1) / 2, "k"), C(0, 0, dn / 2, "t"), Ld([-dn / 2 - 0.03, -0.05], [-h - 0.35, -h * 0.45], t("wk_riser").replace("{dn}", p.dn)));
      plan.push(Dm([-h, -h], [h, -h], -0.45), Dm([-h, -h], [-h, h], 0.45), Dm([-b, b], [b, b], (h - b) + 0.3), isHy ? Dm([-b, -b], [-b, b], (h - b) + 1.0) : Dm([b, -b], [b, b], -((h - b) + 0.3)), Dm([b, -h], [h, -h], -0.2));   // con l'idrante a destra l'interasse in y va a sinistra (78.29)
      plan.push(Ld([b, b], [h + 0.45, h + 0.35], bolt), Ld([fc + (rnd ? 0 : F / 2) - 0.02, -fc], [h + 0.45, -fc + 0.55], t(rnd ? "wk_piers" : "wk_feet").split("{f}").join(fmtM(F))));
      const xsP = isHy ? hydr(h) : h + 1.15;
      if (fix && !isHy) plan.push(...hidP([[dn / 2 + 0.05, 0], [h + 1.15, 0]], p.dn), Tx(h + 1.2, -dn / 2 - 0.35, t("wk_buriedDN").replace("{dn}", WK_PEOD[p.dn] || p.dn), 2, "r"));   // tubo interrato anche in pianta, a tratteggio
      plan.push(...cutT([[-h - 0.6, 0], [xsP + 0.6, 0]], "A", 1));   // traccia del taglio A-A, le frecce fuori dalla platea (78.29)
      view(t("wk_vPlan"), plan);
      // sezione A-A sull'asse della piazzola: soletta tagliata, risalita al centro; piedi e tirafondi in vista dietro il piano di sezione
      sec.push(R(-h, top - Hs, L, Hs, "conc"));
      [-fc, fc].forEach(x => sec.push(R(x - F / 2, top - Ht, F, Ht - Hs, "t"), R(x - F / 2 - 0.05, top - Ht - mg, F + 0.1, mg, "lean")));
      [-b, b].forEach(x => sec.push(Lg([[x, top + Math.max(bp, 0.06)], [x, top - bl], [x + 0.06, top - bl - 0.04]], "t")));
      sec.push(ground(-h - 0.7, h + (isHy ? 0.7 : 1.2), 0));
      if (fix && !isHy) { sec.push(...hidP([[h + 1.15, -d + dn / 2], [0, -d + dn / 2], [0, top]], p.dn), Pp([[0, top], [0, top + 0.25]], p.dn), Dm([h + 0.75, 0], [h + 0.75, -d], -0.25));   // interrato e nella platea: a tratteggio
        wkBomChain(BM, [{ k: "end", dn: p.dn }, ...wkBomPath([[h + 1.15, -d + dn / 2], [0, -d + dn / 2], [0, top + 0.25]], [], p.dn), { k: "end", dn: p.dn }], 1, t); }   // risalita centrale
      sec.push(Dm([-h, top - Hs], [-h, top], 0.35), Dm([-fc - F / 2, top - Ht], [-fc - F / 2, top], 0.75), Dm([-fc - F / 2, top - Ht - mg], [-fc + F / 2, top - Ht - mg], -0.3), (isHy ? Dm([-h, top - Ht - mg], [h, top - Ht - mg], -0.8) : Dm([-h, top], [h, top], 0.35)));
      sec.push(Tx(-h - 0.55, 0.14, "±0" + WK_DEC + "00", 2.2, "r"), Ld([-h * 0.3, top - Hs / 2], [-h * 0.4, top - Ht * 0.62], t("wk_concPad")), Ld([fc + F / 4, top - Ht + 0.2], [fc + F / 2 + 0.5, top - Ht - 0.45], t(rnd ? "wk_piers" : "wk_feet").split("{f}").join(fmtM(F))));
      view(t("wk_vSec") + " A-A", sec);
      const fa = rnd ? Math.PI * F * F / 4 : F * F;
      vc = L * L * Hs + 4 * fa * (Ht - Hs); vm = 4 * (fa + 0.1 * Math.PI * F) * mg; vs = (L + 0.4) * (L + 0.4) * Math.max(0, Hs - e) + 4 * (F + 0.4) * (F + 0.4) * (Ht - Hs + mg);
    }
    qty.push([t("wk_qConc"), m3(vc), "m³"], [t("wk_qLean"), m3(vm), "m³"], [t("wk_qDig"), m3(vs), "m³"], [t("wk_qSteel"), Math.round(vc * 60), "kg"]);
    const c = p.cat;
    notes.push(t("wk_nConcPiv"));
    if (p.shape === "plinths") notes.push(t("wk_nRebarCart"));
    else if (p.src === "valley") { const cv = 0.05, lb = p.L - 2 * cv, nb = Math.floor(lb / 0.1 + 1e-6) + 1; notes.push(t("wk_nRebarValley").replace("{l}", Math.ceil(2 * nb * lb / 5) * 5 + " m")); }   // rete Ø 12 / 10 cm nei due sensi sulla platea: lunghezza dalle misure (78.29)
    else notes.push(t("wk_nRebarStar").replace("{st}", c ? c.st : "1200 (250 × 950)").replace("{bar}", c ? c.bar : "3350").replace("{dia}", c ? c.dia : "4700"));
    notes.push(t("wk_nBoltsP").replace("{b}", bolt).replace("{p}", String(Math.round(bp * 1000) / 10).replace(".", WK_DEC)));
    if (fix && !isHy) notes.push(t("wk_nRiser").replace("{d}", fmtM(d)));
    if (isHy) notes.push(t("wk_nHyd").replace("{m}", mat === "pe" ? "PE 100" : "PVC").split("{d}").join(WK_PEOD[dnH] || dnH).replace("{dn}", dnH).replace("{v}", wkLc(t, t("wk_hyV_" + hyV))).replace("{z}", fmtM(-ybq)));
    if (p.ultra && p.pp === "fix") notes.push(t("wk_nUltra"));
    notes.push(t(p.src === "star" ? "wk_nSrcStar" : p.src === "valley" ? "wk_nSrcValley" : "wk_nSrcRef"));
  }
  if (type === "moto" || type === "gen") {
    const isG = type === "gen", n = isG ? 1 : Math.max(1, Math.round(p.n || 1));
    const lu = isG ? p.Lg : p.Ls, wu = isG ? p.Wg : p.Ws, hu = isG ? p.Hg : p.Hs, mg = p.marg, gap = isG ? 0 : p.gap;
    const Wp = n * wu + (n - 1) * gap + 2 * mg, Lp = lu + 2 * mg, H = p.H;
    // MOTOPOMPA (78.29): la macchina del prospetto si calcola prima, così la pianta riporta la stessa mandata (risalita, tratto in alto verso est con gli accessori), l'aspirazione e il carrello
    const cnM = isG ? null : wkCan(p), haM = isG ? null : cnM ? wkSym.motoCan(mg, 0.18, lu, Math.max(0.9, hu - 0.18), cnM, p.dnS, p.dnD) : wkSym.horiz(mg + 0.04, 0.4, { Lp: lu * 0.3, hs: (hu - 0.4) * 0.36, Lc: 0.06, Lm: lu * 0.62, diesel: 1, Hd: hu - 0.4 });
    const odDm = Math.max(0.05, p.dnD / 1000 * 1.1), xRm = isG ? 0 : cnM ? haM.del[0] - Math.max(0.45, odDm * 1.6) : haM.del[0], hTm = isG ? 0 : Math.max(hu, haM.top, haM.del[1] + 0.45) + 0.55;
    const pthM0 = isG ? null : cnM ? [haM.del, [xRm, haM.del[1]], [xRm, hTm], [xRm + 2.2, hTm]] : [haM.del, [xRm, hTm], [xRm + 1.8, hTm]];
    if (!isG) accL = p.acc || wkAccAlong(pthM0, wkAccRec("moto"), p.dnD, 0.04);
    // pianta: la platea è Lp (lungo la macchina, x) per Wp (y)
    const plan = [R(0, 0, Lp, Wp, "k"), R(0.12, 0.12, Lp - 0.24, Wp - 0.24, "h")];
    for (let i = 0; i < n; i++) {
      const y0 = mg + i * (wu + gap);
      plan.push(R(mg, y0, lu, wu, "eq"));
      [[mg + 0.15, y0 + 0.12], [mg + lu - 0.15, y0 + 0.12], [mg + 0.15, y0 + wu - 0.12], [mg + lu - 0.15, y0 + wu - 0.12]].forEach(([x, y]) => plan.push(C(x, y, 0.035, "k")));
      if (isG) { plan.push(R(mg + 0.05, y0 + 0.05, lu * 0.18, wu - 0.1, "t"), R(mg + lu * 0.78, y0 + 0.05, lu * 0.2, wu - 0.1, "t"), C(mg + lu * 0.6, y0 + wu / 2, 0.09, "k"), Tx(mg + lu * 0.42, y0 + wu / 2 - 0.05, "G" + (n > 1 ? i + 1 : ""), 3, "c")); }
      else {
        const px = cnM ? mg : mg + lu * 0.22, yc = y0 + wu / 2, ySu = yc - Math.min(0.3, wu * 0.22);
        plan.push(R(mg + lu * 0.42, y0 + 0.1, lu * 0.46, wu - 0.2, "t"), R(mg + lu * 0.88, y0 + 0.08, lu * 0.1, wu - 0.16, "t"));
        if (!cnM) plan.push(C(px, yc, Math.min(wu * 0.32, 0.35), "k"));   // chiocciola della pompa a vista
        plan.push(Pp([[cnM ? haM.suc[0] : px, ySu], [-0.6, ySu]], p.dnS), C(-0.6, ySu, Math.max(0.05, p.dnS / 1000 * 1.1) / 2, "k"));   // aspirazione: esce dalla testata e scende fuori dalla platea
        plan.push(Pp(cnM ? [[haM.del[0], yc], [xRm, yc], [xRm + 2.2, yc]] : [[xRm, yc], [xRm + 1.8, yc]], p.dnD), C(xRm, yc, odDm / 2, "k"));   // mandata: risalita e tratto in alto verso est, come nel prospetto
        (accL || []).forEach((a, j) => { if (Math.abs(a.y - hTm) < 0.05 && (a.r || 0) % 180 === 0) plan.push(...wkAccDraw(a.k, a.x, yc, a.dn || p.dnD, 0), Tx(a.x, yc + (WK_FLD[wkDnI(a.dn || p.dnD)] / 1000) * 0.75 + 0.18, (WK_ACC[a.k] ? WK_ACC[a.k][0] : "?") + (j + 1), 1.9, "c")); });
        if (cnM === "trailer") { const xa = mg + lu * 0.55, rw = Math.max(0.2, Math.min(0.36, 0.2 * Math.max(0.9, hu - 0.18))), xt = mg + lu + Math.max(0.8, lu * 0.32);   // carrello in pianta: ruote ai fianchi e timone
          [y0 - 0.14, y0 + wu + 0.02].forEach(yw => plan.push(R(xa - rw, yw, 2 * rw, 0.12, "k"))); plan.push(Lg([[mg + lu, y0 + wu * 0.2], [xt - 0.12, yc], [mg + lu, y0 + wu * 0.8]], "k"), C(xt, yc, 0.05, "k")); }
        plan.push(Tx(mg + lu * 0.65, yc - 0.05, "MP" + (n > 1 ? i + 1 : ""), 3, "c"));
      }
    }
    if (!isG) plan.push(Tx(-0.85, mg + wu / 2 - Math.min(0.3, wu * 0.22) + 0.25, t("wk_suction") + " DN " + p.dnS, 2.2, "r"), Ld([xRm + (cnM ? 2.2 : 1.8) - 0.1, mg + wu / 2], [xRm + (cnM ? 2.2 : 1.8) + 0.3, Wp + 0.6], t("wk_delivery") + " DN " + p.dnD));
    else plan.push(Lg([[Lp * 0.3, -0.6], [Lp * 0.3, mg + 0.2]], "el"), Lg([[Lp * 0.36, -0.6], [Lp * 0.36, mg + 0.2]], "el"), Tx(Lp * 0.33, -0.85, t("wk_ducts"), 2.2, "c"), C(Lp + 0.5, Wp + 0.4, 0.06, "k"), Ld([Lp + 0.5, Wp + 0.4], [Lp + 0.8, Wp + 0.9], t("wk_earth")));
    plan.push(Dm([0, 0], [Lp, 0], -0.5), Dm([0, 0], [0, Wp], 0.5), Dm([mg, mg], [mg + lu, mg], -0.25), Dm([mg + lu, mg], [mg + lu, mg + wu], -0.25));
    plan.push(Ld([Lp - 0.06, Wp * 0.3], [Lp + 0.6, Wp * 0.15], t("wk_kerb").replace("{h}", Math.round(p.kerb * 100))));
    view(t("wk_vPlan"), plan);
    // prospetto laterale
    const el = [R(0, -H, Lp, H, "conc"), R(-0.1, -H - 0.1, Lp + 0.2, 0.1, "lean"), ground(-1.0, Lp + 1.0, 0), R(0.06, 0, 0.1, p.kerb, "k"), R(Lp - 0.16, 0, 0.1, p.kerb, "k")];
    const x0 = mg, fh = 0.18;
    if (!isG) el.push(wkPg([[x0, 0], [x0 + lu, 0], [x0 + lu, fh], [x0, fh]], 244, "a"));
    const gk = p.genK || "s";
    if (isG) {   // gruppo elettrogeno disegnato dalle foto del catalogo, con le misure del catalogo
      el.push(...wkSym.genset(x0, 0, lu, hu, gk));
      const ue = gk === "open" ? 0.455 : gk === "sv" ? 0.85 : gk === "s" ? 0.88 : 0.86;
      el.push(Ld([x0 + lu * ue, hu * 1.04], [x0 + lu * ue + 0.15, hu + 0.3], t("wk_exhaust")), Ld([x0 + lu * 0.08, hu * 0.07], [x0 - 0.25, hu * 0.45], p.tank ? t("wk_tankL").replace("{l}", p.tank) : t("wk_tank")));
      el.push(Ld([x0 + lu * 0.3, hu * 0.7], [x0 + lu * 0.36, hu + 0.6], wkLc(t, t(gk === "open" ? "wk_genOpen" : "wk_gk_" + gk))));
    } else {
      const cn = wkCan(p); if (!cn) el.push(wkPg([[x0, fh], [x0 + lu, fh], [x0 + lu, fh + 0.22], [x0, fh + 0.22]], 250, "a"), Tx(x0 + lu * 0.5, fh + 0.06, t("wk_tank"), 2, "c"));
      const by = fh + 0.22, ha = haM, pcx = xRm, hT = hTm - 0.55;   // cofanata (77.83) o a vista sul telaio con il serbatoio: la stessa macchina della pianta
      el.push(...ha);   // pompa del catalogo e motore diesel sul telaio con il serbatoio
      const pthM = pthM0, pthS = [ha.suc, [-0.6, ha.suc[1]], [-0.6, -p.H - 0.9]];
      el.push(Pp(pthS, p.dnS), Pp(pthM, p.dnD)); wkAccPut(el, pos, accL, t); bomL(pthM, p.dnD, p.n);
      wkBomChain(BM, [{ k: "end", dn: p.dnS }, ...wkBomPath(pthS, [], p.dnS), { k: "end", dn: p.dnS }], Math.max(1, Math.round(+p.n || 1)), t);   // tubazione d'aspirazione fino al pescante (78.29)
      el.push(Ld([x0 + lu * 0.55, by + (hu - by) * 0.4], [x0 + lu * 0.85, hT + 0.9], t("wk_engine")), Ld(cn ? [x0 - 0.12, (ha.suc[1] + ha.del[1]) / 2] : [x0 + 0.04 + lu * 0.12, ha.suc[1]], [pcx - 0.6, hT + 1.0], t("wk_pump")));   // il richiamo «pompa» sulla testata della pompa (voluta)
    }
    el.push(Dm([0, -H], [Lp, -H], -0.35), Dm([Lp, -H], [Lp, 0], -0.3), Dm([x0 + lu, 0], [x0 + lu, hu], -0.4));
    view(t(isG ? "wk_vElevG" : "wk_vElevM"), el);
    if (isG) {   // prospetto dal lato del radiatore
      const en = [R(0, -H, Wp, H, "conc"), R(-0.1, -H - 0.1, Wp + 0.2, 0.1, "lean"), ground(-0.8, Wp + 0.8, 0), R(0.06, 0, 0.1, p.kerb, "k"), R(Wp - 0.16, 0, 0.1, p.kerb, "k"), ...wkSym.gensetEnd(Wp / 2, 0, wu, hu, gk)];
      en.push(Dm([Wp / 2 - wu / 2, hu], [Wp / 2 + wu / 2, hu], 0.3), Dm([0, -H], [Wp, -H], -0.35));
      view(t("wk_vEndG"), en);
    }
    const vc = Lp * Wp * H + 2 * (Lp + Wp) * 0.1 * p.kerb, vm = (Lp + 0.2) * (Wp + 0.2) * 0.1;
    qty.push([t("wk_qConc"), m3(vc), "m³"], [t("wk_qLean"), m3(vm), "m³"], [t("wk_qDig"), m3((Lp + 0.6) * (Wp + 0.6) * (H + 0.15)), "m³"], [t("wk_qSteel"), Math.round(vc * 70), "kg"]);
    qty.push([t(isG ? "wk_qGen" : "wk_qMoto"), isG ? (p.kvaC || p.kva) + " kVA" : n + " × " + p.kw + " kW", ""]);
    if (isG) { qty.push([t("wk_fGenK"), t("wk_gk_" + gk), ""]); if (p.kgG) qty.push([t("wk_qKgGen"), p.kgG, "kg"]); if (p.tank) qty.push([t("wk_qTank"), p.tank, "l"]); }
    notes.push(t("wk_nConc"), t("wk_nRebarSlab").replace("{s}", Math.round(H * 100)), t(isG ? "wk_nKerbG" : "wk_nKerbM"), t("wk_nAnchor"), ...((isG && p.cat) ? [] : [t(isG ? "wk_nGen" : "wk_nMoto")]));
    if (isG) notes.push(t(p.cat ? "wk_nGenCat" : "wk_nGenNoCat").replace("{k}", p.kvaC || p.kva).replace("{c}", wkLc(t, t("wk_gk_" + gk))));
  }
  if (type === "vpump") {
    // POMPA VERTICALE AD ASSE LUNGO, vista d'insieme con le misure del catalogo: motore V1, gruppo di comando con testa di scarico e piastra,
    // elementi di linea d'asse con le flange, corpo pompa a stadi, succheruola o valvola di fondo; piastra di base in pianta con i fori
    // stessa geometria della tavola della stazione (78.29): sommergenza, travi o soletta, linea d'asse, fondo e pesi da wkVertGeo
    const G = wkVertGeo({ ...p, n: 1 }), D = G.D, H = G.H, Ht = Math.max(0, H), y0p = H < 0 ? -H : 0, lift = G.lift, well = G.well;   // H < 0: piastra di base sulle travi del pozzetto aperto
    const asp = p.vfA > 0 ? p.vfA : p.suA, aspD = p.vfA > 0 ? p.vfD : p.suD, Sreq = G.Sreq, cS = { ...subQ(G.D, (+p.Q || 0) / 3600, 0, 0, 0), S: Sreq };
    const nLs = G.nLs, yt = G.yt, yb = yt - p.bA, yI = yb - asp, S = -lift - yI;
    const yA = -Ht - Math.min(p.lsL * 0.9, 1.0), Y = wkBreakY(yA, Math.min(-lift + 0.8, yt + 0.6), 0.6), Rr = (x, y0, w, h, st) => R(x, Y(y0), w, Y(y0 + h) - Y(y0), st), wd = G.wd, hw = wd / 2000;
    const side = G.side, hFv = p.vfA > 0 ? flQ(aspD || D) : 0, yF = Math.min(G.yF, yI - hFv);
    const el = [ground(well ? -1.4 : -side - 1.0, well ? 1.8 : side + 1.4, 0)];
    if (well) {   // POZZO: perforo con dreno in ghiaietto, cementazione in testa, tubo pozzo, filtro sotto la pompa, fondello; testa pozzo su plinto
      const wb = Math.min(+p.wellH > 0 ? -p.wellH : yI - 5, yI - 2), ys = yI - 1.0, hb = hw + Math.max(0.1, 0.45 * hw), tc = Math.max(0.006, wd / 1000 * 0.02), y0c = yI - 0.8, fC = Math.min(1, 2.2 / Math.max(0.01, y0c - wb));
      const Yw = (y) => y >= y0c ? Y(y) : Y(y0c) - (y0c - y) * fC, ySe = Math.max(yA + 0.05, -H - 3);   // sotto la pompa il filtro si accorcia nel disegno (le quote portano la misura vera)
      el.push(Lg([[-hb, -H], [-hb, Yw(wb - 0.3)], [hb, Yw(wb - 0.3)], [hb, -H]], "t"));   // perforo
      el.push(R(-hb, Yw(ySe), hb - hw, Yw(-H) - Yw(ySe), "conc"), R(hw, Yw(ySe), hb - hw, Yw(-H) - Yw(ySe), "conc"));   // cementazione
      const gr = (y1, y2, st) => { for (let yy = y1; yy > y2; yy -= st) { const q = Yw(yy); [-1, 1].forEach(sg => el.push(C(sg * (hw + (hb - hw) * (0.3 + 0.4 * (Math.round(-yy / st) % 2))), q, (hb - hw) * 0.18, "t"))); } };
      gr(Math.min(-lift + 0.6, yt + 0.4), y0c, 0.3); gr(y0c - 0.05, wb, 0.3 / fC);   // ghiaietto (nell'interruzione non si vede)
      [-1, 1].forEach(sg => el.push(wkPg([[sg * hw, -H], [sg * (hw - tc), -H], [sg * (hw - tc), Yw(wb)], [sg * hw, Yw(wb)]], 200, "a")));   // tubo pozzo
      for (let yy = ys - 0.1; yy > wb + 0.1; yy -= 0.12 / fC) { const q = Yw(yy); [-1, 1].forEach(sg => el.push(Lgs([[sg * (hw + tc * 0.5), q], [sg * (hw - tc * 1.5), q]], "wh"))); }   // feritoie del filtro
      if (fC < 1) [-1, 1].forEach(sg => el.push(Lg([[-hb - 0.12, Yw(ys - 0.3) + 0.04 * sg], [-0.03, Yw(ys - 0.3) + 0.04 * sg + 0.06], [0.03, Yw(ys - 0.3) + 0.04 * sg - 0.06], [hb + 0.12, Yw(ys - 0.3) + 0.04 * sg]], "t")));
      el.push(R(-hw, Yw(wb) - 0.04, 2 * hw, 0.04, "k"), R(-0.9, -H, 1.8, H, "conc"));
      el.push(Ld([-(hw + hb) / 2, Yw((ySe - H) / 2)], [-hb - 0.6, Yw((ySe - H) / 2) - 0.15], t("wk_seal")), Ld([-hw, Y(-lift) - 0.35], [-hb - 0.6, Y(-lift) - 0.55], t("wk_casing").replace("{d}", wd)));
      el.push(Ld([hw, Yw((ys + wb) / 2)], [hb + 0.5, Yw((ys + wb) / 2) - 0.1], t("wk_screen")), Ld([-(hw + hb) / 2, Yw(ys - 0.5)], [-hb - 0.6, Yw(ys - 0.5) - 0.2], t("wk_gravel")));
      notes.push(t("wk_nWellV").replace("{d}", wd).replace("{f}", fmtM(ys - wb)).replace("{h}", fmtM(-wb)));
      el.push(Dm([hb + 0.2, 0], [hb + 0.2, Yw(wb)], 0.3, t("wk_wellH") + " " + fmtM(-wb)), Dm([-hb - 0.15, Yw(ys)], [-hb - 0.15, Yw(wb)], -0.2, fmtM(ys - wb)));
    } else {   // POZZETTO: pareti e fondo in c.a., distanza della bocca dal fondo, arrivo dell'acqua
      if (Ht > 0) el.push(R(-side - 0.3, -H, 2 * side + 0.6, H, "conc"));
      else { const hb = G.bm.h / 1000, bb = G.bm.b / 1000; [-G.aB, G.aB].forEach(a => el.push(R(a - bb / 2, 0, bb, hb, "eq"))); el.push(Ld([G.aB + bb / 2, hb * 0.5], [side + 0.9, -0.5], t("wk_beams").replace("{p}", G.bm.name).replace("{l}", fmtM(G.bmL)))); }   // travi HEB sotto la piastra, come nella stazione
      el.push(Rr(-side - 0.3, yF - 0.3, 0.3, -yF + 0.3 - Ht, "conc"), Rr(side, yF - 0.3, 0.3, -yF + 0.3 - Ht, "conc"), Rr(-side - 0.3, yF - 0.3, 2 * side + 0.6, 0.3, "conc"));
      el.push(Lg([[-side + 0.1, Y(-lift - 0.4)], [-side * 0.35, Y(-lift - 0.4)]], "k"), Lg([[-side * 0.35, Y(-lift - 0.4)], [-side * 0.35 - 0.12, Y(-lift - 0.34)]], "k"), Lg([[-side * 0.35, Y(-lift - 0.4)], [-side * 0.35 - 0.12, Y(-lift - 0.46)]], "k"), Tx(-side + 0.1, Y(-lift - 0.4) - 0.2, t("wk_vIn"), 2, "l"));
      el.push(Dm([-side, Y(yF) - 0.45], [side, Y(yF) - 0.45], -0.15));
    }
    el.push({ t: "w", x0: well ? -hw : -side, x1: well ? hw : side, y: Y(-lift) });
    // sopra la soletta: testa di scarico (elettrica, a puleggia o rinvio ad angolo) e motore V1; sotto: colonna con i giunti, corpo pompa, aspirazione
    const tP = 0.03, zH = y0p + p.Hh, zM = zH + (p.headK === "el" ? p.Hm : 0), dnH = p.dnH / 1000;
    const hvP = wkSym.head(0, y0p, { kind: p.headK, pL: p.pL, A: p.Hh, B: p.hB, C: p.hC, D: p.hD, E: p.Dm * 0.9, dn: p.dnH }); el.push(...hvP);
    const dnA = Math.max(p.dnH || 0, p.dnD || 0) || p.dnH, LrP = p.dnH < dnA ? Math.max(0.3, wkAccL("red", dnA)) : 0, d0P = [hvP.dis[0] + LrP, hvP.dis[1]];   // accessori al DN della mandata della stazione, con la riduzione dalla bocca (78.29)
    if (LrP) el.push({ t: "p", pts: [hvP.dis, d0P], dn: p.dnH, cone: dnA }, Ld([hvP.dis[0] + LrP / 2, hvP.dis[1] - dnA / 2000], [hvP.dis[0] + LrP / 2 + 0.4, hvP.dis[1] - dnA / 1000 - 0.45], "DN " + p.dnH + " → DN " + dnA));
    const pthP = [d0P, [hvP.dis[0] + 2.4 + LrP, hvP.dis[1]]]; el.push(Pp(pthP, dnA)); accL = p.acc || wkAccAlong(pthP, wkAccRec("vert"), dnA, 0.04); wkAccPut(el, pos, accL, t); bomL(pthP, dnA, 1, LrP ? p.dnH : 0);   // mandata con gli accessori
    if (p.headK === "el") el.push(...wkSym.motor(0, zH, p.Dm, p.Hm));
    el.push(...wkSym.column(0, -H, yt, p.lsD, p.lsF, p.lsL, Y));
    el.push(...wkSym.bowl(0, yt, p.bA, p.bSt, p.bF, p.bD, p.lsD, Y));
    el.push(...wkSym.strainer(0, yb, asp, aspD, p.vfA > 0 ? p.vfA : 0, Y));
    if (Math.min(-lift + 0.8, yt + 0.6) < yA - 3) { const yb0 = yA - 0.3; [-1, 1].forEach(sg => el.push(Lg([[-0.4, Y(yb0) + 0.05 * sg], [-0.1, Y(yb0) + 0.05 * sg + 0.08], [0.1, Y(yb0) + 0.05 * sg - 0.08], [0.4, Y(yb0) + 0.05 * sg]], "t"))); }
    // quote del catalogo
    if (p.headK === "el") el.push(Dm([-p.Dm / 2 - 0.12, zH], [-p.Dm / 2 - 0.12, zM], 0.25));
    el.push(Dm([-p.pL / 2 - 0.08, y0p], [-p.pL / 2 - 0.08, zH], 0.2), Dm([p.hD / 2 + 0.1, y0p], [p.hD / 2 + 0.1, y0p + p.hB], -0.08));
    el.push(Dm([0, y0p + p.hB + dnH / 2 + 0.08], [p.hC, y0p + p.hB + dnH / 2 + 0.08], 0.12), p.headK === "el" ? Dm([-p.Dm / 2, zM + 0.12], [p.Dm / 2, zM + 0.12], 0.12, "Ø " + fmtM(p.Dm).replace(" m", "")) : Tx(0, zH + 0.12, "", 2), Dm([-p.pL / 2, y0p - 0.05], [p.pL / 2, y0p - 0.05], -0.55));
    el.push(Dm([-p.lsF / 2 - 0.15, -Ht], [-p.lsF / 2 - 0.15, Y(-Ht - Math.min(p.lsL, G.Lc))], 0.3, fmtM(Math.min(p.lsL, G.Lc))), Dm([p.bD / 2 + 0.1, Y(yt)], [p.bD / 2 + 0.1, Y(yb)], 0.12, fmtM(p.bA)));   // Ø del corpo pompa e altezza della succheruola nei richiami (77.85): in fondo alla pompa non c'è posto per altre quote
    const xo = well ? -(hw + Math.max(0.1, 0.45 * hw) + 0.3) : -(side + 0.55);   // quote fuori dal pozzo o dalla vasca (78.29)
    el.push(Dm([xo - 0.75, 0], [xo - 0.75, Y(yI)], 0, fmtM(-yI)), Dm([xo, 0], [xo, Y(-lift)], 0, t("wk_level") + " " + fmtM(lift)), Dm([xo, Y(-lift)], [xo, Y(yI)], 0, "S " + fmtM(S)));
    subG(el, xo - 1.5, yI, cS, well ? -hw : -side, well ? hw : side, Y); if (hFv && !well) flN(t("wk_k_vert"), yI - yF, hFv, aspD || D);
    notes.push(t("wk_nSubMin").replace("{s}", fmtM(Sreq)).replace("{c}", fmtM(G.sBody)).replace("{d}", fmtM(G.s25)).replace("{h}", fmtM(G.sHI)).replace("{v}", (Math.round(G.vB * 100) / 100).toFixed(2).replace(".", WK_DEC)).replace("{l}", fmtM(-(yI + Sreq))).replace("{w}", fmtM(lift)).replace("{a}", fmtM(S)));   // la stessa verifica della stazione
    // richiami con codici e pesi
    if (p.headK === "el") el.push(Ld([p.Dm * 0.42, zH + p.Hm * 0.55], [p.Dm / 2 + 0.55, zM + 0.25], (p.cM ? t("wk_motorV1") + " " + p.cM : t("wk_motorV1")) + " · " + p.kgM + " kg"));
    el.push(Ld([p.hD * 0.3, p.Hh * 0.75], [p.hC + 0.35, zH + 0.05], (p.headK === "gear" ? t("wk_gearHead") + " " : p.headK === "pulley" ? t("wk_pulleyHead") + " " : "") + (p.cH || t("wk_head")) + " · DN " + p.dnH + " · " + p.kgH + " kg"));
    el.push(Ld([p.lsD / 2, Y(-Ht - 0.5)], [p.lsF / 2 + 0.5, Y(-Ht - 0.5)], t("wk_lineShaft").replace("{n}", G.rem > 0.01 ? (G.nF ? G.nF + " × " + fmtM(p.lsL) + " + 1" : "1") : String(G.nF)).replace("{l}", G.rem > 0.01 ? fmtM(G.rem) : fmtM(p.lsL)).replace("{kg}", Math.round(p.kgLs)) + (p.cLs ? " · " + p.cLs : "")));
    el.push(Ld([p.bD / 2, Y(yb + p.bA * 0.5)], [p.bD / 2 + 0.55, Y(yb + p.bA * 0.5) + 0.15], (p.cB ? t("wk_bowlSt").replace("{c}", p.cB) : t("wk_bowl")) + " · Ø " + fmtM(p.bD).replace(" m", "") + " · " + p.kgB + " kg"));
    el.push(Ld([aspD / 2, Y(yI + asp * 0.4)], [aspD / 2 + 0.55, Y(yI) - 0.1], (p.vfA > 0 ? (p.cVf || t("wk_footValve")) : (p.cSu || t("wk_strainer"))) + " · h " + fmtM(asp) + (!well ? " · " + (hFv ? t("wk_offFloorMin").replace("{m}", fmtM(hFv)) : t("wk_offFloor")).replace("{d}", fmtM(yI - yF)) : "") + ((p.vfA > 0 ? p.kgVf : p.kgSu) > 0 ? " · " + String(p.vfA > 0 ? p.kgVf : p.kgSu).replace(".", WK_DEC) + " kg" : "")));
    view(t("wk_vAssy"), el);
    // piastra di base: lati H × L, fori P × Ø Q agli interassi J × M, testa Ø D, motore Ø F, mandata DN a distanza C dall'asse
    const pl = [R(-p.pL / 2, -p.pH / 2, p.pL, p.pH, "k"), C(0, 0, p.hD / 2, "k"), C(0, 0, p.Dm / 2, "h"), C(0, 0, p.lsD / 2, "t"), Lg([[-p.pL / 2 - 0.1, 0], [p.pL / 2 + 0.1, 0]], "cl"), Lg([[0, -p.pH / 2 - 0.1], [0, p.pH / 2 + 0.1]], "cl")];
    const hj = p.hJ / 2, hm = p.hM / 2;
    [[-hm, -hj], [hm, -hj], [hm, hj], [-hm, hj]].forEach(([x, y]) => pl.push(C(x, y, p.hN / 2000, "k")));
    pl.push(Pp([[p.hD / 2, 0], [p.hC, 0]], p.dnH), R(p.hC - 0.02, -dnH / 2 - 0.05, 0.02, dnH + 0.1, "k"));
    pl.push(Dm([-p.pL / 2, -p.pH / 2], [p.pL / 2, -p.pH / 2], -0.15), Dm([-p.pL / 2, -p.pH / 2], [-p.pL / 2, p.pH / 2], 0.15), Dm([-hm, hj], [hm, hj], (p.pH / 2 - hj) + 0.12), Dm([hm, -hj], [hm, hj], -((p.pL / 2 - hm) + 0.12)), Dm([0, -p.pH / 2 - 0.3], [p.hC, -p.pH / 2 - 0.3], -0.05));
    pl.push(Ld([-hm, -hj], [-p.pL / 2 - 0.15, -p.pH / 2 - 0.35], t("wk_holes").replace("{n}", 4).replace("{q}", p.hN)), Ld([p.hC, dnH / 2], [p.hC + 0.15, p.pH / 2 + 0.2], t("wk_flange").replace("{dn}", p.dnH).replace("{n}", p.hP).replace("{q}", p.hQ)));
    view(t("wk_vPlate"), pl);
    const kgL = G.nEq * p.kgLs, kgU = Math.round(p.kgM + p.kgH + kgL + p.kgB + p.kgSu + p.kgVf + p.kgTs);   // linea d'asse posata (elemento di testa accorciato), come nella stazione
    if (p.headK === "el") qty.push([t("wk_motorV1") + (p.cM ? " " + p.cM : ""), p.kgM, "kg"]);
    qty.push([(p.headK === "gear" ? t("wk_gearHead") : p.headK === "pulley" ? t("wk_pulleyHead") : t("wk_head")) + (p.cH ? " " + p.cH : ""), p.kgH, "kg"], [t("wk_lsQ").replace("{n}", nLs) + (p.cLs ? " " + p.cLs : ""), Math.round(kgL), "kg"], [t("wk_bowl0") + (p.cB ? " " + p.cB.split(" ·")[0] : ""), p.kgB, "kg"]);
    if (p.kgSu) qty.push([t("wk_strainer") + (p.cSu ? " " + p.cSu : ""), p.kgSu, "kg"]); if (p.kgVf) qty.push([t("wk_footValve") + (p.cVf ? " " + p.cVf : ""), p.kgVf, "kg"]); if (p.kgTs) qty.push([t("wk_frame") + (p.cTs ? " " + p.cTs : ""), p.kgTs, "kg"]);
    const kgWv = Math.round(wkColWater(p.lsD, G.Lc) + Math.PI / 4 * Math.pow(D * 0.9, 2) * p.Hb * 0.45 * 1000 + Math.PI / 4 * Math.pow(p.dnD / 1000, 2) * p.Hh * 0.6 * 1000), kgAw = Math.round(wkAccWet(accL));
    qty.push([t("wk_qKgUnit"), kgU, "kg"], [t("wk_qWater"), kgWv, "kg"], [t("wk_qKgRun"), kgU + kgWv + kgAw, "kg"], [t("wk_qLen"), fmtM(-yI + zM).replace(" m", ""), "m"]);
    notes.push(t("wk_nRun").replace("{w}", kgWv).replace("{a}", kgAw));
    notes.push(t(well ? "wk_nVertWell" : "wk_nVert").replace("{s}", fmtM(S)).replace("{d}", fmtM(D)).replace("{w}", wd), t("wk_nVpump").replace("{n}", G.rem > 0.01 ? (G.nF ? G.nF + " × " + fmtM(p.lsL) + " + 1" : "1") : String(G.nF)).replace("{l}", G.rem > 0.01 ? fmtM(G.rem) : fmtM(p.lsL)), t(p.cat ? "wk_nCat" : "wk_nNoCat").replace("{m}", p.model || "—"));
    if (p.hNoCat) notes.push(t("wk_nHeadNoCat").replace("{h}", t("wk_hk_" + p.headK)));
  }
  if (type === "pivotSet") {
    // PIVOT CON IL POMPAGGIO ACCANTO: piazzola del pivot e, a lato, pompa verticale in pozzo, motopompa e gruppo elettrogeno sui loro basamenti
    const L = p.padL || p.L, h = L / 2, dn = p.dnP / 1000, d = p.depth || 1.2, dist = Math.max(0.5, p.dist), hw = p.wellD / 2000, Wp = 1.4;
    // posizioni in pianta (centro della piazzola = 0,0): proposte dalle distanze, oppure trascinate sulla tavola (wX/wY, mX/mY, gX/gY)
    const num = (v, d0) => v != null && v !== "" && isFinite(+v) ? +v : d0;
    const wX = num(p.wX, h + dist + Wp / 2), wY = num(p.wY, 0);
    const mX = num(p.mX, (p.hasV ? wX + Wp / 2 : h) + dist + p.mLs / 2 + 0.4), mY = num(p.mY, p.hasV ? wY : 0);
    const gX = num(p.gX, 0), gY = num(p.gY, -h - p.distG - (p.Wg + 1.2) / 2);
    const plan = [R(-h, -h, L, L, "k"), ...pyrTop(0, 0, L * 0.98, p.B || p.Bx || L * 0.8, p.tube, ""), Tx(0, h - 0.35, t("wk_padShort"), 2.4, "c")];
    const route = (x, y) => Math.abs(y) < 0.05 ? [[x, y], [0, 0]] : Math.abs(x) <= h ? [[x, y], [x, 0], [0, 0]] : [[x, y], [x, 0], [0, 0]];
    const G = (g, arr) => arr.map(it => ({ ...it, g }));
    let oX = null, oY = null;
    const sump = p.wSrc === "sump", swv = Wp / 2 - 0.12;   // fonte canale o lago: pozzetto in calcestruzzo, non pozzo (78.29)
    if (p.hasV) { plan.push(...G("w", [R(wX - Wp / 2, wY - Wp / 2, Wp, Wp, "k"), ...(sump ? [R(wX - swv, wY - swv, 2 * swv, 2 * swv, "t")] : [C(wX, wY, hw + 0.03, "k"), C(wX, wY, hw, "t")]), R(wX - p.pLv / 2, wY - p.pLv / 2, p.pLv, p.pLv, "eq"), C(wX, wY, p.Dm / 2, "k"), Tx(wX, wY + Wp / 2 + 0.18, t(sump ? "wk_vpShortS" : "wk_vpShort"), 2.4, "c")])); oX = wX; oY = wY; }
    if (p.hasM) { plan.push(...G("m", [R(mX - p.mLs / 2 - 0.4, mY - p.mWs / 2 - 0.4, p.mLs + 0.8, p.mWs + 0.8, "k"), R(mX - p.mLs / 2, mY - p.mWs / 2, p.mLs, p.mWs, "eq"), Tx(mX, mY - 0.05, "MP", 3, "c"), Tx(mX, mY + p.mWs / 2 + 0.6, t("wk_moto") + " · " + p.kw + " kW", 2.4, "c")].concat(p.hasV ? [] : [Pp([[mX + p.mLs / 2, mY - 0.15], [mX + p.mLs / 2 + 1.6, mY - 0.15]], p.dnP), Tx(mX + p.mLs / 2 + 1.7, mY - 0.1, t("wk_suction"), 2.2, "l")])));
      if (p.hasV) plan.push(Lg([[wX, wY], [mX, mY]], "k"), Tx((wX + mX) / 2, (wY + mY) / 2 + 0.15, t("wk_cardan"), 2.1, "c")); else { oX = mX; oY = mY; } }
    // mandata interrata fino alla risalita al centro della piazzola
    if (oX != null) { const rt = route(oX, oY); plan.push(Pp(rt, p.dnP), Tx((rt[rt.length - 2][0] + 0) / 2 + 0.2, rt[rt.length - 2][1] / 2 + 0.25, "Ø " + wkPeOd(p, "P"), 2.2, "c")); }
    if (p.hasG) { plan.push(...G("g", [R(gX - (p.Lg + 1.2) / 2, gY - (p.Wg + 1.2) / 2, p.Lg + 1.2, p.Wg + 1.2, "k"), R(gX - p.Lg / 2, gY - p.Wg / 2, p.Lg, p.Wg, "eq"), Tx(gX, gY - 0.05, "G", 3.2, "c"), Tx(gX + p.Lg / 2 + 0.75, gY, t("wk_gen") + " · " + p.kva + " kVA", 2.4, "l")]));
      plan.push(Lg([[gX + 0.35, gY], [gX + 0.35, gY > 0 ? 0.45 : -0.45], [0.2, gY > 0 ? 0.3 : -0.3]], "el"), Tx(gX + 0.5, gY / 2, t("wk_ductPiv"), 2.1, "l"));
      if (p.hasV && !p.hasM) plan.push(Lg([[gX, gY], [wX, gY], [wX, wY]], "el"), Tx(wX + 0.15, (gY + wY) / 2, t("wk_ductPump"), 2.1, "l")); }
    const dW = Math.hypot(wX, wY) - h, dM = Math.hypot(mX, mY) - h, dG = Math.hypot(gX, gY) - h;
    plan.push(Lg([[-h - 0.9, h - 0.2], [-h - 0.9, h + 0.5]], "k"), Lg([[-h - 1.0, h + 0.3], [-h - 0.9, h + 0.5], [-h - 0.8, h + 0.3]], "k"), Tx(-h - 0.9, h + 0.62, "N", 3, "c"));
    plan.push(Dm([-h, -h], [h, -h], -0.4));
    if (p.hasV) plan.push(Ld([wX - Wp / 2, wY - Wp / 2], [wX - Wp / 2 - 0.3, wY - Wp / 2 - 0.5], t("wk_fromPad") + " " + fmtM(dW)));
    if (p.hasM) plan.push(Ld([mX + p.mLs / 2, mY - p.mWs / 2], [mX + p.mLs / 2 + 0.3, mY - p.mWs / 2 - 0.5], t("wk_fromPad") + " " + fmtM(dM)));
    if (p.hasG) plan.push(Ld([gX - p.Lg / 2, gY + p.Wg / 2], [gX - p.Lg / 2 - 0.4, gY + p.Wg / 2 + 0.5], t("wk_fromPad") + " " + fmtM(dG)));
    pos.w = [wX, wY]; pos.m = [mX, mY]; pos.g = [gX, gY];
    { const tp = [[-h - 0.9, 0], [0, 0]]; if (p.hasV) tp.push([wX, wY]); if (p.hasM) tp.push([mX, mY]); if (tp.length < 3) tp.push([h + 1.0, 0]);   // traccia della sezione A-A sull'asse (78.29)
      const e = tp[tp.length - 1], q = tp[tp.length - 2], l = Math.hypot(e[0] - q[0], e[1] - q[1]) || 1, ext = p.hasM ? p.mLs / 2 + 0.9 : 1.2; tp[tp.length - 1] = [e[0] + (e[0] - q[0]) / l * ext, e[1] + (e[1] - q[1]) / l * ext]; plan.push(...cutT(tp, "A", 1)); }
    view(t("wk_vPlan"), plan, { drag: 1 });
    const xW = Math.hypot(wX, wY), xM = p.hasV ? xW + Math.hypot(mX - wX, mY - wY) : Math.hypot(mX, mY), xOut = p.hasV ? xW : p.hasM ? xM : h;
    // sezione A-A sull'asse: piazzola con la risalita, condotta interrata, pozzo con la pompa, basamento della motopompa
    const e = p.emerg || 0.05, top = e, Hs = p.Hs || 0.2, Ht = p.Ht || 1.0, F = p.F || 0.75, fc = (p.Fc || (L - F)) / 2, lift = Math.max(0.5, +p.lift || 3);
    const Y = wkBreakY(-2.2, -lift + 0.6, 0.8);
    const sec = [ground(-h - 0.6, (p.hasM ? xM + p.mLs / 2 + 1.0 : p.hasV ? xW + 1.4 : h + 1.5), 0), R(-h, top - Hs, L, Hs, "conc")];
    [-fc, fc].forEach(x => sec.push(R(x - F / 2, top - Ht, F, Ht - Hs, "t")));
    // MANDATA (78.29): dalla flangia di mandata in superficie (testata della verticale o bocca della motopompa) giù in trincea, interrata (a tratteggio) fino al centro
    // della piazzola e su nella risalita del pivot; se la mandata è più grande del tubo del pivot, riduzione al piede della risalita
    const dnR = { 168: 150, 203: 200, 219: 200, 254: 250 }[p.tube] || (p.tube ? WK_DN.find(x => x * 1.05 >= p.tube - 20) || 200 : p.dnP), dnRis = Math.min(p.dnP, dnR);
    const xW0 = xW, hw2 = sump ? swv : hw;
    let dis = [xOut, 0.1], pthB = null;
    if (p.hasV) {
      sec.push(R(xW - Wp / 2, -0.25, Wp, 0.3, "conc"), Lg([[xW - hw2, -0.25], [xW - hw2, Y(-lift - 3)]], "k"), Lg([[xW + hw2, -0.25], [xW + hw2, Y(-lift - 3)]], "k"), { t: "w", x0: xW - hw2, x1: xW + hw2, y: Y(-lift) });
      const yt2 = -lift - 2, Yv = (v) => Y(v);
      sec.push(...wkSym.column(xW, -0.25, yt2, p.lsD, p.lsD * 1.5, 3.05, Yv), ...wkSym.bowl(xW, yt2, 0.6, 3, 0.16, p.D * 0.9, p.lsD, Yv), ...wkSym.strainer(xW, yt2 - 0.6, 0.18, p.D, 0, Yv));
      const hvW = wkSym.head(xW, 0.05, { kind: p.hasM ? "gear" : "el", pL: p.pLv, A: p.Hh, B: p.Hh * 0.3, C: p.pLv * 0.6, D: p.pLv * 0.6, E: p.Dm * 0.9, dn: p.dnP }); sec.push(...hvW); dis = hvW.dis;
      if (!p.hasM) sec.push(...wkSym.motor(xW, 0.05 + p.Hh, p.Dm, p.Hm));
      sec.push(Dm([xW - hw2 - 0.25, 0], [xW - hw2 - 0.25, Y(-lift)], -0.3, t("wk_level") + " " + fmtM(lift)));
    }
    const odP = Math.max(0.05, p.dnP / 1000 * 1.1), xDn = dis[0] + Math.max(0.6, odP * 1.6);   // curva in giù accanto alla testata, poi in trincea
    if (p.hasV) { pthB = [dis, [xDn, dis[1]], [xDn, -0.05]]; sec.push(Pp(pthB, p.dnP)); }
    sec.push(...hidP([[p.hasV ? xDn : xOut, p.hasV ? -0.05 : 0.1], [p.hasV ? xDn : xOut, -d], [0, -d], [0, top]], p.dnP));
    if (dnRis < p.dnP) sec.push(Ld([0, -d + 0.15], [-h * 0.55, -d - 0.45], t("wk_redRiser").replace("{a}", wkPeOd(p, "P")).replace("{b}", dnRis)));
    sec.push(Pp([[0, top], [0, top + 0.3]], dnRis), R(-0.05, top + 0.3, 0.1, 0.25, "k"), Ld([0.05, top + 0.45], [h * 0.45, top + 0.95], t("wk_pivotPt")));
    if (p.hasM) { sec.push(R(xM - p.mLs / 2 - 0.4, -0.25, p.mLs + 0.8, 0.25 + 0.1, "conc"), ...(p.hasV ? wkSym.diesel(xM - p.mLs / 2, 0.1, p.mLs, p.mHs, p.mHs * 0.4) : wkSym.horiz(xM - p.mLs / 2, 0.1, { can: wkCan(p), dS: p.dnS, dD: p.dnD, Lp: p.mLs * 0.3, hs: p.mHs * 0.36, Lc: 0.06, Lm: p.mLs * 0.64, diesel: 1, Hd: p.mHs })), Tx(xM, 0.1 + p.mHs * 1.15 + 0.15, "MP", 3, "c"));
      if (p.hasV) sec.push(Lg([[xW + p.pLv * 0.3, 0.08 + p.Hh * 0.6], [xM - p.mLs / 2, 0.1 + p.mHs * 0.4]], "k")); }
    sec.push(Dm([h + 0.2, 0], [h + 0.2, -d], -0.2, fmtM(d)), Dm([-h, top - Ht], [h, top - Ht], -0.3));
    view(t("wk_vSec") + " A-A", sec);
    const vPad = L * L * Hs + 4 * F * F * (Ht - Hs), vW = p.hasV ? Wp * Wp * 0.3 : 0, vM = p.hasM ? (p.mLs + 0.8) * (p.mWs + 0.8) * 0.35 : 0, vG = p.hasG ? (p.Lg + 1.2) * (p.Wg + 1.2) * 0.3 : 0;
    // COMPUTO (78.29): macchine, mandata (curve, tratto interrato, riduzione, risalita) e i calcestruzzi separati
    if (p.hasV) BM.add("mach", "wk_m_vp" + (p.model ? "_" + p.model : ""), t("pst_k_vert") + (p.model ? " · " + p.model : ""), 1, "n°");
    if (p.hasM) BM.add("mach", "wk_m_moto_" + (p.kw || 0), t("wk_sk_moto") + (p.kw ? " · " + p.kw + " kW" : ""), 1, "n°");
    if (p.hasG) BM.add("mach", "wk_m_gen_" + p.kva, t("wk_sk_gen") + " · " + p.kva + " kVA", 1, "n°");
    if (oX != null) { const Ltr = Math.abs(oX) + Math.abs(oY), up = p.hasV ? dis[1] + 0.05 + d : d + 0.1;
      wkBomChain(BM, [{ k: "end", dn: p.dnP }, ...(p.hasV ? [{ k: "pipe", dn: p.dnP, L: Math.max(0.3, xDn - dis[0] - odP * 1.5) }, { k: "elb", dn: p.dnP }] : []), { k: "pipe", dn: p.dnP, L: up }, { k: "elb", dn: p.dnP }, { k: "pipe", dn: p.dnP, L: Math.max(0.5, Ltr) }, { k: "elb", dn: p.dnP },
        ...(dnRis < p.dnP ? [{ k: "red", a: p.dnP, b: dnRis }] : []), { k: "pipe", dn: dnRis, L: d + top + 0.3 }, { k: "end", dn: dnRis }], 1, t); }
    qty.push([t("wk_qConcPad"), m3(vPad), "m³"]); if (p.hasV) qty.push([t(sump ? "wk_qConcSump" : "wk_qConcWell"), m3(vW), "m³"]); if (p.hasM) qty.push([t("wk_qConcMoto"), m3(vM), "m³"]); if (p.hasG) qty.push([t("wk_qConcGen"), m3(vG), "m³"]);
    qty.push([t("wk_qTrench"), fmtM(oX != null ? Math.abs(oX) + Math.abs(oY) : 0).replace(" m", ""), "m"]);
    if (p.hasV) qty.push([t("wk_qKgV"), p.kgV, "kg"]); if (p.hasM) qty.push([t("wk_qKgM"), p.kgM, "kg"]); if (p.hasG) qty.push([t("wk_qKgG"), p.kgG, "kg"]);
    notes.push(t("wk_nPivSet"), t("wk_nRiser").replace("{d}", fmtM(d)));
    if (p.farD) notes.push(t("wk_nFar").replace("{d}", p.farD));
    if (p.hasV) notes.push(sump ? t("wk_nPivSetVS") : t("wk_nPivSetV").replace("{d}", p.wellD));
    if (p.hasM) notes.push(t("wk_nPivSetMG")); else if (p.hasG) notes.push(t("wk_nPivSetG"));   // con la pompa elettrica non si parla di motopompa (78.29)
    notes.push(t(p.src === "star" ? "wk_nSrcStar" : p.src === "valley" ? "wk_nSrcValley" : "wk_nSrcRef")); if (p.hasM) notes.push(t("wk_nKgEst")); else if (p.hasG) notes.push(t("wk_nKgEstG"));
  }
  if (type === "station" && p.inst === "float" && p.kind === "vert") {
    // POMPE VERTICALI SU PONTONE (77.76), come nelle installazioni Agrostar: piattaforma d'acciaio con grigliato e parapetto su galleggianti cilindrici
    // trasversali, pompe in fila con il motore sopra la testa e la linea d'asse che scende in acqua; ogni pompa ha la sua linea galleggiante in PE fino alla
    // platea a riva, con la valvola a farfalla e la curva verso la condotta interrata (collettore). Galleggianti dal peso: volume, immersione, bordo libero, stabilità
    const n = Math.max(1, Math.round(p.n || 1)), D = Math.max(0.1, p.D || 0.3), fD = Math.max(0.4, +p.fD || 0.8), rF = fD / 2, cS = subQ(D, (+p.Q || 0) / 3600 / n, Math.max(0.3, p.Hb || 0.8), 0.3, Math.max(+p.sub || 0, 2.5 * D, 0.8)), Sreq = cS.S, shore = Math.max(4, +p.shore || 12);   // sommergenza (77.80)
    const pL = Math.max(0.3, p.pL || 0.5), Dmo = Math.max(0.25, p.Dmo || 0.45), Hh = Math.max(0.2, p.Hh || 0.45), Hm = Math.max(0.3, p.Hm || 0.9), lsL = Math.max(0.5, p.lsL || 2.5), lsD = Math.max(0.08, p.lsD || D * 0.6), Hb = Math.max(0.3, p.Hb || 0.8);
    const bAp = p.bA && p.bA < Hb ? p.bA : Hb * 0.75;   // corpo pompa del catalogo (77.80)
    const pitch = wkR(Math.max(1.8, pL + 1.0, Dmo + 1.0, 4 * D), 2), mE = Math.max(1.2, pL / 2 + 0.9);
    let Wpo = wkR(Math.max(3.2, pL + 2.8), 1), yP = 0, Lf = Wpo - 0.2;   // pompe sull'asse della piattaforma: niente sbandamento
    const LpoP = wkR(Math.max(4, (n - 1) * pitch + 2 * mE), 1), Wmax = Math.max(8, LpoP); let Lpo = LpoP;   // la piattaforma si allarga (galleggianti più lunghi) prima di allungarsi
    const dn = p.dnD || 150, dnC = p.dnC || dn, odPE = WK_PEOD[dn] || dn, rho = 1000;
    // pesi (kg) con l'altezza del baricentro sopra il fondo dei galleggianti (z): la linea d'asse dipende dall'immersione, si itera
    const segA = (h) => { const r = rF, hh = Math.max(0, Math.min(2 * r, h)); return r * r * Math.acos((r - hh) / r) - (r - hh) * Math.sqrt(Math.max(0, 2 * r * hh - hh * hh)); };
    let nF = 3, h = rF, yDk = 0, nLs = 1, yt = -1, W = 0, items = [], deckTop = 0, kgWat = 0;
    const nerF = { De: fD, wall: wkFWall(p), mat: p.fMat || "pe100", fill: "air", liq: "fresh" }; let nerTube = 0;   // galleggianti col calcolo di Nereus (78.16)
    for (let it = 0, guard = 0; it < 8 && guard < 80; it++, guard++) {
      Lpo = Math.max(Lpo, wkR(nF * fD + (nF + 1) * 0.1, 1));   // i galleggianti stanno sotto la piattaforma
      nerTube = (nerRaft({ ...nerF, n: 1, L: Lf, load: 0 }).Ptube) || 0;
      deckTop = fD - h + 0.18;   // piano sopra i galleggianti: telaio 18 cm
      nLs = Math.max(1, Math.ceil((deckTop - (-Sreq + Hb)) / lsL - 1e-6)); yt = deckTop - nLs * lsL;
      const kgDeck = Math.round(Lpo * Wpo * 55), kgRail = Math.round((2 * (Lpo + Wpo) - 1.0) * 18), kgFl = Math.round(nF * nerTube), kgLive = Math.round(Lpo * Wpo * 25 + 300);
      const kgPipe = Math.round(n * ((Wpo / 2 - yP) * (wkPipeKg(dn) - wkPipeWater(dn)) + wkAccKg("check", dn) + wkAccKg("flex", dn) + 60));   // tubi e ritegno a bordo (a secco), attacco della linea PE
      // ACQUA A BORDO (78.15): linea d'asse dal pelo libero alla testa, testa di mandata, tubi, giunto e ritegno pieni; sotto il pelo libero l'acqua non pesa sul pontone
      kgWat = Math.round(n * (wkColWater(lsD, Math.max(0, deckTop)) + Math.PI / 4 * Math.pow(dn / 1000, 2) * Hh * 0.6 * 1000 + (Wpo / 2 - yP) * wkPipeWater(dn) + wkAccWet([{ k: "check", dn }, { k: "flex", dn }]) - wkAccKg("check", dn) - wkAccKg("flex", dn)));
      const z0 = h;   // fondo dei galleggianti → pelo libero
      items = [[n * (p.kgM || 0), deckTop + Hh + Hm / 2 + z0, "m"], [n * (p.kgH || 0), deckTop + Hh / 2 + z0, "h"], [n * nLs * (p.kgLs || 0), (deckTop + yt) / 2 + z0, "c"], [n * ((p.kgB || 0) + (p.kgA || 0) + (p.kgT || 0)), yt - Hb / 2 + z0, "b"],
        [kgDeck, fD + 0.09, "d"], [kgRail, fD + 0.18 + 0.55, "r"], [kgFl, rF, "f"], [kgLive, fD + 0.18 + 0.9, "l"], [kgPipe, deckTop + 0.4 + z0, "p"], [kgWat, deckTop * 0.6 + z0, "w"]];
      W = items.reduce((m, q) => m + q[0], 0);
      const vOne = Math.PI * rF * rF * Lf, nMinN = nerRaft({ ...nerF, n: 1, L: Lf, load: W - kgFl }).nMin, nNeed = Math.max(3, nMinN > 0 ? nMinN : Math.ceil(2 * W / (rho * vOne) - 1e-9));   // NEREUS: affondamento ≤ 50% del Ø (riserva di galleggiamento del 100%)
      if (nNeed * fD + (nNeed + 1) * 0.1 > LpoP + 1e-6 && Wpo < Wmax - 1e-6) { Wpo = wkR(Math.min(Wmax, Wpo + 0.4), 1); Lf = Wpo - 0.2; Lpo = LpoP; it--; if (Wpo >= Wmax - 1e-6) it = Math.min(it, 2); continue; }
      if (nNeed !== nF) { nF = nNeed; continue; }
      { const RR = nerRaft({ ...nerF, n: nF, L: Lf, load: W - kgFl }); h = RR.ok ? RR.a : fD; } }
    const nerR = nerRaft({ ...nerF, n: nF, L: Lf, load: W - Math.round(nF * nerTube) });
    { h = nerR.ok ? nerR.a : fD; deckTop = fD - h + 0.18; yt = deckTop - nLs * lsL; }   // immersione con il numero finale di galleggianti
    const gapF = 0.1;
    const fx = (k) => -Lpo / 2 + gapF + rF + k * (nF > 1 ? (Lpo - 2 * gapF - fD) / (nF - 1) : 0), px = (i) => -((n - 1) * pitch) / 2 + i * pitch;
    const vOne = Math.PI * rF * rF * Lf, use = W / (rho * nF * vOne), fb = deckTop, Sact = -(yt - Hb);
    // stabilità: GM = KB + BM − KG per rollio (sulla larghezza) e beccheggio (sulla lunghezza)
    const th = 2 * Math.acos((rF - h) / rF), ybar = th > 1e-6 ? 4 * rF * Math.pow(Math.sin(th / 2), 3) / (3 * (th - Math.sin(th))) : 0, KB = rF - ybar, bw = 2 * Math.sqrt(Math.max(0, 2 * rF * h - h * h)), Vd = W / rho;
    const Ix = nF * bw * Math.pow(Lf, 3) / 12, Iy = [...Array(nF)].reduce((m, _, k) => m + Lf * Math.pow(bw, 3) / 12 + bw * Lf * fx(k) * fx(k), 0), KG = items.reduce((m, q) => m + q[0] * q[1], 0) / W;
    const GMt = KB + Ix / Vd - KG, GMl = KB + Iy / Vd - KG;
    // PIANTA
    const plan = [R(-Lpo / 2, -Wpo / 2, Lpo, Wpo, "k"), Lg([[-Lpo / 2 + 0.08, -Wpo / 2 + 0.08], [Lpo / 2 - 0.08, -Wpo / 2 + 0.08], [Lpo / 2 - 0.08, Wpo / 2 - 0.08], [0.5, Wpo / 2 - 0.08]], "h"), Lg([[-0.5, Wpo / 2 - 0.08], [-Lpo / 2 + 0.08, Wpo / 2 - 0.08], [-Lpo / 2 + 0.08, -Wpo / 2 + 0.08]], "h")];   // parapetto con il varco d'accesso verso riva
    for (let k = 0; k < nF; k++) plan.push(R(fx(k) - rF, -Lf / 2, fD, Lf, "h"));
    const yS = Wpo / 2 + shore, padY0 = yS + 0.4, padY1 = yS + 2.2, xs = [...Array(n)].map((_, i) => px(i));
    for (let i = 0; i < n; i++) { const x = px(i);
      plan.push(R(x - pL / 2, yP - pL / 2, pL, pL, "eq"), { ...C(x, yP, Dmo / 2, "k"), fg: 255 }, C(x, yP, Dmo * 0.18, "t"), Tx(x, yP - Dmo / 2 - 0.3, "P" + (i + 1), 2.4, "c"));
      const y1 = yP + pL / 2, Lc = wkAccL("check", dn), Lgx = wkAccL("flex", dn); plan.push(Pp([[x, y1], [x, Wpo / 2 + 0.3]], dn), ...wkAccDraw("flex", x, y1 + 0.12 + Lgx / 2, dn, 90), ...wkAccDraw("check", x, y1 + 0.27 + Lgx + Lc / 2, dn, 90));   // giunto antivibrante in uscita dalla pompa, poi il ritegno
      plan.push({ ...Pp([[x, Wpo / 2 + 0.3], [x, padY0 + 0.3]], dn), nf: 1 }, ...wkAccDraw("wafer", x, padY0 + 0.65, dn, 90), C(x, padY0 + 1.2, Math.max(0.05, dn / 1000 * 1.1) / 2, "k"), Lg([[x, padY0 + 0.3], [x, padY0 + 1.2]], "t")); }
    if (!xs.length) xs.push(0);
    const xa = Math.min(...xs) - 0.8, xb = Math.max(...xs) + 0.8;
    plan.push(R(xa, padY0, xb - xa, padY1 - padY0, "k"), Pp([[Math.min(...xs), padY0 + 1.6], [Math.max(...xs) + 1.6, padY0 + 1.6]], dnC), Tx(Math.max(...xs) + 1.7, padY0 + 1.75, t("wk_toBuried") + " DN " + dnC, 2, "l"));
    xs.forEach(x => plan.push(Lg([[x, padY0 + 1.2], [x, padY0 + 1.6]], "t")));
    plan.push(Lg([[-Lpo / 2 - 3, yS], [Lpo / 2 + 4, yS]], "k"), Tx(-Lpo / 2 - 2.9, yS + 0.3, t("wk_shore"), 2.4, "l"), Tx(-Lpo / 2 - 2.9, yS - 0.6, t("wk_canal"), 2.4, "l"), Tx(xa - 0.1, padY0 + 0.9, t("wk_shorePad"), 2, "r"));
    plan.push(Tx(xs[0] + 0.25, Wpo / 2 + shore * 0.5, t("wk_peLine").replace("{d}", odPE), 2, "l"));
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => { const a = [sx * Lpo / 2, sy * Wpo / 2], b = sy > 0 ? [sx * (Lpo / 2 + 3), yS + 0.6] : [sx * (Lpo / 2 + 3), -Wpo / 2 - 3.5]; plan.push(Lg([a, b], "h"), R(b[0] - 0.15, b[1] - 0.15, 0.3, 0.3, "k")); });
    plan.push(Tx(Lpo / 2 + 3.3, -Wpo / 2 - 3.7, t("wk_anchor"), 2.1, "l"), Dm([-Lpo / 2, -Wpo / 2], [Lpo / 2, -Wpo / 2], -0.5), Dm([-Lpo / 2, -Wpo / 2], [-Lpo / 2, Wpo / 2], 0.5), Dm([-Lpo / 2 - 1.0, Wpo / 2], [-Lpo / 2 - 1.0, yS], 0.3, fmtM(shore)));
    if (n > 1) plan.push(Dm([px(0), yP - Dmo / 2 - 1.1], [px(1), yP - Dmo / 2 - 1.1], 0));
    view(t("wk_vPlan"), plan);
    // PROSPETTO LONGITUDINALE (dalla riva): galleggianti in testa, piattaforma, parapetto, pompe con motore, testa, linea d'asse, corpo pompa e succheruola in acqua
    const yW = 0, el = [{ t: "w", x0: -Lpo / 2 - 1.5, x1: Lpo / 2 + 1.5, y: yW }];
    for (let k = 0; k < nF; k++) el.push({ ...C(fx(k), rF - h, rF, "a"), fg: 236 });
    el.push(R(-Lpo / 2, fD - h, Lpo, 0.18, "k"), Lg([[-Lpo / 2, fD - h + 0.09], [Lpo / 2, fD - h + 0.09]], "t"));
    const yR = deckTop + 1.1, nPost = Math.max(2, Math.round(Lpo / 1.5) + 1);
    for (let k = 0; k < nPost; k++) { const x = -Lpo / 2 + 0.05 + k * (Lpo - 0.1) / (nPost - 1); el.push(R(x - 0.025, deckTop, 0.05, 1.1, "k")); }
    el.push(Lg([[-Lpo / 2 + 0.05, yR], [Lpo / 2 - 0.05, yR]], "k"), Lg([[-Lpo / 2 + 0.05, deckTop + 0.55], [Lpo / 2 - 0.05, deckTop + 0.55]], "t"));
    el.push(Lg([[-Lpo / 2 + 0.05, deckTop + 0.15], [Lpo / 2 - 0.05, deckTop + 0.15]], "a"));   // battipiede; i pannelli in rete si leggono dai montanti
    for (let i = 0; i < n; i++) { const x = px(i);
      el.push(...wkSym.column(x, deckTop, yt, lsD, lsD * 1.5, lsL), ...wkSym.bowl(x, yt, bAp, p.bSt || Math.max(1, Math.round(bAp / 0.4)), 0.2, D * 0.9, lsD), ...wkSym.strainer(x, yt - bAp, Hb - bAp, D, 0));
      el.push(...wkSym.head(x, deckTop, { kind: "el", pL, A: Hh, B: Hh * 0.3, C: pL * 0.6, D: pL * 0.6, E: Dmo * 0.9, dn }), ...wkSym.motor(x, deckTop + Hh, Dmo, Hm), Tx(x, deckTop + Hh + Hm + 0.25, "P" + (i + 1), 2.2, "c")); }
    const x0d = Lpo / 2 + 0.6;
    const yTop = Math.max(yR, deckTop + Hh + Hm + 0.5) + 0.5;
    el.push(Dm([x0d + 0.6, yW], [x0d + 0.6, Sact > 0 ? -Sact : -1], -0.3, "S " + fmtM(Sact)), Dm([-Lpo / 2 - 0.4, -h], [-Lpo / 2 - 0.4, yW], 0.3, fmtM(h)), Dm([-Lpo / 2 - 1.3, yW], [-Lpo / 2 - 1.3, deckTop], 0.3, fmtM(deckTop)), Dm([-Lpo / 2, yTop], [Lpo / 2, yTop], 0.2));
    el.push(Ld([fx(nF - 1), rF - h], [Lpo / 2 + 1.0, -h - 1.2], t("wk_qFloats").replace("{d}", fmtM(fD)) + " · " + nF + " × " + fmtM(Lf)), Tx(px(0), -Sact - 0.45, p.model || t("wk_k_vert"), 2.1, "c"));
    subG(el, -Lpo / 2 - 2.2, -Sact, cS, -Lpo / 2 - 2.0, Lpo / 2, null, 1);   // livello minimo dell'acqua sotto i galleggianti: la bocca segue il pontone, conta la sommergenza della bocca
    view(t("wk_vSecT"), el);   // i galleggianti si vedono di testa: è la sezione trasversale (78.29)
    // PROSPETTO LONGITUDINALE sulla prima pompa: linea galleggiante in PE fino alla platea a riva, valvola a farfalla, curva verso la condotta interrata
    const xsh = Wpo / 2 + shore, gz = 0.8, sec = [{ t: "w", x0: -Wpo / 2 - 1.5, x1: xsh - gz * 1.5, y: yW }];
    sec.push(R(-Lf / 2, -h, Lf, fD, "eq"), R(-Wpo / 2, fD - h, Wpo, 0.18, "k"), R(-Wpo / 2 + 0.02, deckTop, 0.05, 1.1, "k"), R(Wpo / 2 - 0.07, deckTop, 0.05, 1.1, "k"), Lg([[-Wpo / 2 + 0.05, yR], [Wpo / 2 - 0.05, yR]], "k"));
    sec.push(...wkSym.column(yP, deckTop, yt, lsD, lsD * 1.5, lsL), ...wkSym.bowl(yP, yt, bAp, p.bSt || Math.max(1, Math.round(bAp / 0.4)), 0.2, D * 0.9, lsD), ...wkSym.strainer(yP, yt - bAp, Hb - bAp, D, 0));
    const hv = wkSym.head(yP, deckTop, { kind: "el", pL, A: Hh, B: Hh * 0.3, C: pL * 0.6, D: pL * 0.6, E: Dmo * 0.9, dn }); sec.push(...hv, ...wkSym.motor(yP, deckTop + Hh, Dmo, Hm));
    const yo = hv.dis[1], xe = Wpo / 2 + 0.3, od = Math.max(0.05, dn / 1000 * 1.1), Lck = wkAccL("check", dn);
    const Lgx = wkAccL("flex", dn), xg = hv.dis[0] + 0.12 + Lgx / 2, xk = hv.dis[0] + 0.27 + Lgx + Lck / 2;
    sec.push(Pp([hv.dis, [xe, yo]], dn), ...wkAccDraw("flex", xg, yo, dn, 0), Tx(xg - 0.15, yo + od + 0.75, "GA", 1.9, "c"), ...wkAccDraw("check", xk, yo, dn, 0), Tx(xk, yo + od + 0.25, "VR", 1.9, "c"));
    const yBk = gz, xB0 = xsh - gz * 1.5;   // sponda in scarpa 1,5:1, platea a riva sul piano
    const pePts = [[xe, yo], [xe + 0.9, od / 2], [xB0 - 0.6, od / 2], [xsh - 0.2, yBk + 0.35], [xsh + 0.7, yBk + 0.35]], Lpe = Math.ceil(pePts.reduce((a, q, i) => i ? a + Math.hypot(q[0] - pePts[i - 1][0], q[1] - pePts[i - 1][1]) : 0, 0) * 2) / 2;   // lunghezza della linea in PE: la stessa nel disegno e nel computo (78.29)
    sec.push({ t: "p", pts: pePts, dn, nf: 1 });
    sec.push(Lg([[xB0 - 1.2, -1.2], [xB0, 0], [xsh, yBk], [xsh + 3.2, yBk]], "k"), R(xsh + 0.3, yBk - 0.25, 2.4, 0.25, "conc"), ...wkAccDraw("wafer", xsh + 0.95, yBk + 0.35, dn, 0), Tx(xsh + 0.95, yBk + 0.35 + WK_FLD[wkDnI(dn)] / 1000 * 1.05 + 0.15, "VF", 1.9, "c"));
    sec.push(Pp([[xsh + 1.2, yBk + 0.35], [xsh + 1.8, yBk + 0.35], [xsh + 1.8, yBk - 1.1]], dn), Tx(xsh + 2.0, yBk - 0.8, t("wk_toBuried"), 2, "l"), Tx(xsh + 2.0, yBk + 0.55, t("wk_shorePad"), 1.9, "l"));
    sec.push(Tx((xe + xB0) / 2, od + 0.35, t("wk_peLine").replace("{d}", odPE) + " · L " + fmtM(Lpe), 2, "c"), Dm([Wpo / 2, -1.6], [xsh, -1.6], 0, fmtM(shore)), Dm([-Wpo / 2, Math.max(yR, deckTop + Hh + Hm + 0.5) + 0.5], [Wpo / 2, Math.max(yR, deckTop + Hh + Hm + 0.5) + 0.5], 0.15));
    view(t("wk_vElevL"), sec);
    // quantità, note e computo
    const kgPumpU = Math.round((p.kgM || 0) + (p.kgH || 0) + nLs * (p.kgLs || 0) + (p.kgB || 0) + (p.kgA || 0) + (p.kgT || 0)), kgDeckT = items.filter(q => q[2] === "d" || q[2] === "r").reduce((m, q) => m + q[0], 0);
    qty.push([t("wk_qPumps"), String(n), ""], [t("wk_qPontoon"), fmtM(Lpo).replace(" m", "") + " × " + fmtM(Wpo).replace(" m", ""), "m"], [t("wk_qFloats").replace("{d}", fmtM(fD)), nF + " × " + fmtM(Lf).replace(" m", ""), "m"],
      [t("wk_qKgUnit"), kgPumpU, "kg"], [t("wk_qKgDeck"), kgDeckT, "kg"], [t("wk_qWater"), kgWat, "kg"], [t("wk_qKgFloat"), Math.round(W), "kg"], [t("wk_qBuoy"), Math.round(use * 100), "%"], [t("wk_qDraft"), fmtM(h).replace(" m", ""), "m"], [t("wk_qFb"), fmtM(fb).replace(" m", ""), "m"], [t("wk_qGM"), fmtM(GMt).replace(" m", "") + " / " + fmtM(GMl).replace(" m", ""), "m"]);
    notes.push(t("wk_nPont").replace("{w}", Math.round(W)).replace("{v}", String(wkR(W / rho, 2)).replace(".", WK_DEC)).replace("{n}", nF).replace("{d}", fmtM(fD)).replace("{l}", fmtM(Lf)).replace("{s}", Math.round(use * 100)).replace("{h}", fmtM(h)).replace("{fb}", fmtM(fb)).replace("{gt}", fmtM(GMt)).replace("{gl}", fmtM(GMl)));
    notes.push(t("wk_nPontW").replace("{w}", kgWat).replace("{p}", Math.round(n * kgPumpU)));
    if (nerR.ok) notes.push(t("wk_nNer").replace("{n}", nF).replace("{m}", t("ner_m_" + nerF.mat)).replace("{d}", Math.round(fD * 1000)).replace("{s}", String(Math.round(nerF.wall * 1000 * 10) / 10).replace(".", WK_DEC)).replace("{l}", fmtM(Lf)).replace("{t}", Math.round(nerTube)).replace("{c}", Math.round(nerR.capacity)).replace("{p}", Math.round(nerR.pct)));
    if (Math.min(GMt, GMl) < 0.5) notes.push(t("wk_nPontGM"));
    subN(t("wk_k_vert"), cS, Sact);
    notes.push(t("wk_nPontSub").replace("{s}", fmtM(Sact)).replace("{d}", fmtM(Sact + 0.5 * D + 0.5)), t("wk_nFloatAnchor"), t(p.cat ? "wk_nCat" : "wk_nNoCat").replace("{m}", p.model || "—"));
    BM.add("mach", "wk_pont_" + Math.round(Lpo * 10) + "x" + Math.round(Wpo * 10), t("wk_bmPont").replace("{l}", fmtM(Lpo)).replace("{w}", fmtM(Wpo)), 1, "n°");
    BM.add("mach", "wk_float_" + nerF.mat + "_" + Math.round(fD * 100) + "_" + Math.round(Lf * 10), t("wk_bmFloatM").replace("{m}", t("ner_m_" + nerF.mat)).replace("{d}", fmtM(fD)).replace("{l}", fmtM(Lf)).replace("{s}", String(Math.round(nerF.wall * 1000 * 10) / 10).replace(".", WK_DEC)), nF, "n°");   // materiale del calcolo di Nereus (78.29)
    BM.add("mach", "wk_rail", t("wk_bmRail"), Math.round((2 * (Lpo + Wpo) - 1.0) * 10) / 10, "m");
    BM.add("mach", "wk_anchor4", t("wk_bmAnchor"), 4, "n°");
    const ad = { k: "piece", sig: "wk_hy_ad_pe_" + dn, desc: t("wk_bmAdPE").replace("{dn}", dn).replace("{d}", odPE), dn };
    for (let i = 0; i < n; i++) { wkBomChain(BM, [{ k: "end", dn }, { k: "acc", a: "flex", dn }, { k: "pipe", dn, L: 0.3 }, { k: "acc", a: "check", dn }, { k: "pipe", dn, L: Math.max(0.3, Wpo / 2 + 0.3 - yP - pL / 2 - 0.3 - Lck - wkAccL("flex", dn)) }, ad], 1, t);
      BM.add("pipe", "wk_pe_" + odPE, t("wk_bmPE").replace("{d}", odPE), Lpe, "m");
      wkBomChain(BM, [ad, { k: "acc", a: "wafer", dn }, { k: "pipe", dn, L: 0.4 }, { k: "elb", dn }, { k: "end", dn }], 1, t); }
    if (n > 1) { wkBomChain(BM, [{ k: "end", dn: dnC }, { k: "pipe", dn: dnC, L: (n - 1) * pitch + 1.6 }, { k: "end", dn: dnC }], 1, t); BM.add("pipe", "wk_tee_" + dnC, t("wk_bmTee").replace("{dn}", dnC), n - 1, "n°"); }
    qty.push([t("wk_qConc"), m3((xb - xa) * (padY1 - padY0) * 0.25), "m³"]);
  }
  if (type === "station" && p.inst === "float" && p.kind !== "vert") {
    // POMPE SU GALLEGGIANTI: piattaforma su galleggianti cilindrici, pompe a bordo (di superficie o motopompe) o appese sotto (sommerse e verticali),
    // manichetta flessibile sostenuta da galleggianti fino alla sponda, quattro cavi d'ancoraggio; galleggiamento verificato dal peso
    const n = Math.max(1, Math.round(p.n || 1)), hang = p.kind === "subm" || p.kind === "vert", onDeck = !hang;
    const uL = onDeck ? p.Lu : Math.max(0.5, p.D * 2.5), uW = onDeck ? p.Wu : Math.max(0.5, p.D * 2.5), gapF = onDeck ? Math.max(0.6, p.gap || 0.8) : 0.8;
    const Lpo = wkR(Math.max(3, n * uL + (n - 1) * gapF + 1.6), 1), Wpo = wkR(Math.max(2.2, (onDeck ? p.Wu : uW) + 1.6), 1), rf = p.fD / 2;
    const kgPump = onDeck ? p.kgU : p.kind === "subm" ? p.kgP + Math.round(3 * (wkPipeKg(p.dnD) - wkPipeWater(p.dnD))) : p.kgM + p.kgH + p.kgB + p.kgA + p.kgLs;
    const kgDeck0 = Math.round(Lpo * Wpo * 45);   // struttura: piano grigliato e telaio ~45 kg/m², + persone e accessori; i galleggianti col calcolo di Nereus (78.16)
    const nerF = { L: Lpo - 0.2, De: p.fD, wall: wkFWall(p), mat: p.fMat || "pe100", fill: "air", liq: "fresh" };
    // ACQUA A BORDO (78.15) sopra il pelo libero: pescante, corpo pompa e mandata sul piano (di superficie e motopompe); tubo di mandata (sommerse); linea d'asse e testa (verticali)
    const hLp = p.hLp || 0.4, kgWatOf = (yd) => Math.round(n * (onDeck ? wkPipeWater(p.dnS) * (yd + hLp + 0.3) + Math.PI / 4 * Math.pow(2 * p.dnS / 1000, 2) * hLp * 0.5 * 1000 + wkPipeWater(p.dnD) * (uW / 2 + Wpo / 2 + 0.6)
      : p.kind === "subm" ? wkPipeWater(p.dnD) * (yd + 0.4 + Wpo / 2) : wkColWater(p.lsD || p.D * 0.6, yd) + Math.PI / 4 * Math.pow(p.dnD / 1000, 2) * (p.Hh || 0.45) * 0.6 * 1000 + wkPipeWater(p.dnD) * (Wpo / 2 + 0.4)));
    const vF = Math.PI * rf * rf * Lpo; let kgWat = kgWatOf(rf + 0.08), Wtot = 0, nF = 2, sub = 0.5, nerR = { ok: false, a: rf };
    for (let k = 0; k < 4; k++) { const load = n * kgPump + kgDeck0 + 150 + kgWat, nM = nerRaft({ ...nerF, n: 1, load }).nMin; nF = Math.max(2, nM > 0 ? nM : Math.ceil(load * 2 / (vF * 1000) - 1e-9));
      nerR = nerRaft({ ...nerF, n: nF, load }); sub = nerR.ok ? Math.min(0.95, nerR.vFrac) : 0.95; kgWat = kgWatOf(2 * rf - (nerR.ok ? nerR.a : 2 * rf * sub) + 0.08); }   // NEREUS: affondamento ≤ 50% del Ø
    { const load = n * kgPump + kgDeck0 + 150 + kgWat; nerR = nerRaft({ ...nerF, n: nF, load }); sub = nerR.ok ? Math.min(0.95, nerR.vFrac) : sub; }
    const kgDeck = Math.round(kgDeck0 + (nerR.ok ? nerR.Pself : 0)); Wtot = n * kgPump + kgDeck + 150 + kgWat;
    const hSub = nerR.ok ? nerR.a : 2 * rf * sub, yDeck = 2 * rf - hSub + 0.08, shore = Math.max(4, p.shore || 8);
    const plan = [R(-Lpo / 2, -Wpo / 2, Lpo, Wpo, "k")];
    const fy = (k) => -Wpo / 2 + rf + 0.1 + k * (nF > 1 ? (Wpo - 2 * rf - 0.2) / (nF - 1) : 0);
    for (let k = 0; k < nF; k++) plan.push(R(-Lpo / 2 + 0.1, fy(k) - rf, Lpo - 0.2, 2 * rf, "h"));
    for (let i = 0; i < n; i++) { const x = -Lpo / 2 + 0.8 + i * (uL + gapF) + uL / 2;
      if (onDeck) plan.push(R(x - uL / 2, -uW / 2, uL, uW, "eq"), Tx(x, -0.05, (p.kind === "moto" ? "MP" : "P") + (i + 1), 2.8, "c"), Pp([[x - uL / 2, 0], [x - uL / 2 - 0.35, 0]], p.dnS));
      else plan.push(C(x, 0, uW * 0.3, "eq"), C(x, 0, (p.D || 0.15) / 2, "k"), Tx(x, uW * 0.3 + 0.2, "P" + (i + 1), 2.6, "c"));
      plan.push(Pp([[x, onDeck ? uW / 2 : 0], [x, Wpo / 2 - 0.2], [Lpo / 2 - 0.25, Wpo / 2 - 0.2]], p.dnD)); }
    // manichetta alla sponda (sostenuta da galleggianti) e ancoraggi
    const yS = Wpo / 2 + shore, hose = [[Lpo / 2 - 0.25, Wpo / 2 - 0.2], [Lpo / 2 + 0.8, Wpo / 2 + shore * 0.35], [Lpo / 2 + 1.2, Wpo / 2 + shore * 0.7], [Lpo / 2 + 1.0, yS + 1.0]];
    plan.push(Pp(hose, p.dnC || p.dnD), Lg([[-Lpo / 2 - 3, yS], [Lpo / 2 + 4, yS]], "k"), Tx(-Lpo / 2 - 2.9, yS + 0.3, t("wk_shore"), 2.4, "l"), Tx(-Lpo / 2 - 2.9, yS - 0.5, t("wk_canal"), 2.4, "l"));
    [0.3, 0.6].forEach(f => { const q = hose[1].map((v, k) => v + (hose[2][k] - v) * f); plan.push(C(q[0], q[1], 0.18, "t")); });
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => { const a = [sx * Lpo / 2, sy * Wpo / 2], b = sy > 0 ? [sx * (Lpo / 2 + 2.5), yS + 0.6] : [sx * (Lpo / 2 + 2.5), -Wpo / 2 - 3]; plan.push(Lg([a, b], "h"), R(b[0] - 0.15, b[1] - 0.15, 0.3, 0.3, "k")); });
    plan.push(Tx(Lpo / 2 + 2.7, -Wpo / 2 - 3.2, t("wk_anchor"), 2.1, "l"), Dm([-Lpo / 2, -Wpo / 2], [Lpo / 2, -Wpo / 2], -0.45), Dm([-Lpo / 2, -Wpo / 2], [-Lpo / 2, Wpo / 2], 0.45), Dm([-Lpo / 2 - 0.8, Wpo / 2], [-Lpo / 2 - 0.8, yS], 0.3, fmtM(shore)));
    view(t("wk_vPlan"), plan);
    // sezione trasversale: galleggianti nell'acqua, piano, pompa a bordo con il pescante o appesa sotto, manichetta alla sponda
    const sec = [{ t: "w", x0: -Wpo / 2 - 1.5, x1: Wpo / 2 + shore - 1.5, y: 0 }];
    for (let k = 0; k < nF; k++) sec.push(C(fy(k), 2 * rf - hSub - rf + 0, rf, "eq"));
    sec.push(R(-Wpo / 2, yDeck - 0.08, Wpo, 0.08, "k"), Lg([[-Wpo / 2, yDeck - 0.08], [-Wpo / 2, 2 * rf - hSub - rf]], "t"), Lg([[Wpo / 2, yDeck - 0.08], [Wpo / 2, 2 * rf - hSub - rf]], "t"));
    const imm = Math.max(0.6, +p.imm || 1.0); let yDm = yDeck + 1.0;
    if (onDeck) { const hu = p.Hu || 0.8, lc = p.moto ? 0.08 : 0.12, lp = p.hLp || uW * 0.4, lm = p.mL || uW * 0.5, x0 = -(lp + lc + lm) / 2, ha = wkSym.horiz(x0, yDeck + 0.06, { can: p.kind === "moto" && p.motoT !== "open" ? "skid" : null, dS: p.dnS, dD: p.dnD, Lp: lp, hs: p.hHs || hu * 0.42, Lc: lc, Lm: lm, diesel: p.kind === "moto", Hd: hu * 0.95 });
      sec.push(wkPg([[x0, yDeck], [x0 + lp + lc + lm, yDeck], [x0 + lp + lc + lm, yDeck + 0.06], [x0, yDeck + 0.06]], 244, "a"), ...ha, Pp([ha.suc, [x0 - 0.3, ha.suc[1]], [x0 - 0.3, -imm]], p.dnS), ...wkSym.strainer(x0 - 0.3, -imm, 0.3, Math.max(0.15, p.dnS / 1000 * 1.6), 0));
      sec.push(Pp([ha.del, [ha.del[0], ha.top + 0.25], [Wpo / 2 - 0.2, ha.top + 0.25], [Wpo / 2 - 0.2, yDeck + 0.4]], p.dnD)); yDm = Math.max(yDm, ha.top + 1.1);   // mandata dalla bocca della pompa fino all'attacco della linea galleggiante (77.83)
      sec.push(Dm([x0 - 0.75, 0], [x0 - 0.75, -imm], 0.2, fmtM(imm)), Tx(0, Math.max(ha.top, yDeck + hu * 0.8) + 0.55, p.model || t("wk_k_" + p.kind), 2.2, "c"));
      const dS = Math.max(0.15, p.dnS / 1000 * 1.6), cS = subQ(dS, (+p.Q || 0) / 3600 / n, 0, 0, 0.5); subG(sec, x0 - 1.25, -imm - 0.3, cS, x0 - 0.9, x0 + 0.3); subN(t("wk_suction"), cS, imm + 0.3); }   // pescante: bocca della succheruola
    else { const L = p.kind === "subm" ? (p.L || 1.2) : (p.Hb || 0.8), Dp = p.D || 0.15, yt = -imm;
      sec.push(Pp([[0, yt], [0, yDeck + 0.4], [Wpo / 2 - 0.2, yDeck + 0.4]], p.dnD), R(-0.35, yDeck, 0.7, 0.05, "k"));
      if (p.kind === "subm") { const Lm = p.Lm || L * 0.45; sec.push(...wkSym.subm(0, yt, Dp, L - Lm, Lm, wkStages(p.model))); } else sec.push(...wkSym.bowl(0, yt, L * 0.75, 3, 0.16, Dp * 0.9, Dp * 0.5), ...wkSym.strainer(0, yt - L * 0.75, L * 0.25, Dp, 0));
      sec.push(Dm([Dp / 2 + 0.25, 0], [Dp / 2 + 0.25, yt], -0.2, fmtM(imm)), Dm([Dp / 2 + 0.25, yt], [Dp / 2 + 0.25, yt - L], -0.2, fmtM(L)), Tx(Dp / 2 + 0.5, yt - L / 2, p.model || t("wk_k_" + p.kind), 2.2, "l"));
      const hyd = p.kind === "subm" ? L - (p.Lm || L * 0.45) : L * 0.75, cS = subQ(Dp, (+p.Q || 0) / 3600 / n, hyd, p.kind === "subm" ? 1.0 : 0.3, 0.5); subG(sec, -Dp / 2 - 0.45, yt - hyd, cS, -Dp / 2 - 0.2, Dp / 2 + 0.2); subN(t("wk_k_" + p.kind), cS, imm + hyd); }   // sommersa: la griglia d'aspirazione fra la parte idraulica e il motore
    const xs = Wpo / 2 + shore;
    sec.push(Pp([[Wpo / 2 - 0.2, yDeck + 0.4], [Wpo / 2 + 1, 0.1], [xs - 2, 0.1], [xs, 0.9], [xs + 1.2, 0.9]], p.dnC || p.dnD), Lg([[xs - 3, -1.2], [xs, 0.8], [xs + 1.5, 0.8]], "k"), Tx(xs + 0.4, 1.1, t("wk_shore"), 2.2, "l"));
    sec.push(Dm([-Wpo / 2, yDm], [Wpo / 2, yDm], 0.15), Dm([-Wpo / 2 - 0.3, 0], [-Wpo / 2 - 0.3, yDeck], 0.25, fmtM(yDeck)));
    view(t("wk_vSecT"), sec);
    qty.push([t("wk_qPumps"), String(n), ""], [t("wk_qPontoon"), fmtM(Lpo).replace(" m", "") + " × " + fmtM(Wpo).replace(" m", ""), "m"], [t("wk_qFloats").replace("{d}", fmtM(p.fD)), nF + " × " + fmtM(Lpo - 0.2).replace(" m", ""), "m"],
      [t("wk_qHose"), Math.round(shore * 1.35 + 3), "m"], [t("wk_qKgUnit"), Math.round(kgPump), "kg"], [t("wk_qKgDeck"), kgDeck, "kg"], [t("wk_qWater"), kgWat, "kg"], [t("wk_qKgFloat"), Math.round(Wtot), "kg"], [t("wk_qBuoy"), Math.round(sub * 100), "%"]);
    notes.push(t("wk_nFloat").replace("{n}", nF).replace("{d}", fmtM(p.fD)).replace("{s}", Math.round(sub * 100)), t("wk_nPontW").replace("{w}", kgWat).replace("{p}", Math.round(n * kgPump)), ...(nerR.ok ? [t("wk_nNer").replace("{n}", nF).replace("{m}", t("ner_m_" + nerF.mat)).replace("{d}", Math.round(p.fD * 1000)).replace("{s}", String(Math.round(nerF.wall * 1000 * 10) / 10).replace(".", WK_DEC)).replace("{l}", fmtM(nerF.L)).replace("{t}", Math.round(nerR.Ptube)).replace("{c}", Math.round(nerR.capacity)).replace("{p}", Math.round(nerR.pct))] : []), t(onDeck ? "wk_nFloatDeck" : "wk_nFloatHang").replace("{i}", fmtM(imm)), t("wk_nFloatAnchor"), t(p.cat ? "wk_nCat" : "wk_nNoCat").replace("{m}", p.model || "—"));
  }
  if (type === "station" && p.kind === "vert" && p.inst !== "float") {
    // POMPE VERTICALI AD ASSE LUNGO in vasca (schema d'installazione del costruttore: sommergenza S ≥ 2,5 D, fondo a 0,5 D, parete di fondo a 1,5 D,
    // 4 D tra le pompe e 2 D dalle pareti, 6 D di vasca davanti, velocità d'arrivo ≤ 0,3 m/s, fondo in pendenza ≤ 7°) oppure in pozzo
    const { n, D, H0, lift, well, canal, pitch, side, W, back, Lf, qP, vB, sHI, sBody, s25, Sreq, LcE, kgDry, kgWet, kgE, spT, spL, trans, bmL, bmC, bmF, bm, H, aB, cl, need, sF, dnI, nI, sW, bedC, sFl, dFl, Lc, yFfix, flForced, nF, rem, nLs, nEq, yt, yI, S, yF, kgU, wd } = wkVertGeo(p);
    const corr = (pts, dn) => { const od = dn * 1.15 / 1000, o = []; for (let k = 1; k < pts.length; k++) { const a = pts[k - 1], b = pts[k], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], v = [-u[1] * od / 2, u[0] * od / 2];   // tubo corrugato a doppia parete: niente flange, nervature
        o.push(Lg([[a[0] + v[0], a[1] + v[1]], [b[0] + v[0], b[1] + v[1]]], "k"), Lg([[a[0] - v[0], a[1] - v[1]], [b[0] - v[0], b[1] - v[1]]], "k"));
        for (let d = 0.12; d < L - 0.05; d += 0.16) { const c = [a[0] + u[0] * d, a[1] + u[1] * d]; o.push(Lg([[c[0] + v[0] * 1.12, c[1] + v[1] * 1.12], [c[0] + v[0] * 0.88, c[1] + v[1] * 0.88]], "a"), Lg([[c[0] - v[0] * 1.12, c[1] - v[1] * 1.12], [c[0] - v[0] * 0.88, c[1] - v[1] * 0.88]], "a")); } } return o; };
    // linea d'asse: elementi interi più, se serve, un elemento di testa accorciato a misura (passo 0,5 m), così la vasca non si approfondisce di un elemento intero
    // FONDO DEL POZZETTO rispetto al fondo del canale (77.87): più basso (la pompa decide la profondità, almeno dFl sotto il canale), uguale, o più alto di dFl
    const plan = [];
    if (!well) {
      plan.push(Lg([[-W / 2 - 0.3, -Lf - 0.6], [-W / 2 - 0.3, back + 0.3], [W / 2 + 0.3, back + 0.3], [W / 2 + 0.3, -Lf - 0.6]], "k"), Lg([[-W / 2, -Lf - 0.6], [-W / 2, back], [W / 2, back], [W / 2, -Lf - 0.6]], "k"), Lg([[-W / 2, -Lf], [W / 2, -Lf]], "h"));
      { const y0 = -Lf - 0.6, bb = bm.b / 1000; plan.push(...(sW === "rack" ? [] : [Lg([[-W / 2 - 0.3, y0], [W / 2 + 0.3, y0]], "k"), Lg([[-W / 2, y0 + 0.3], [W / 2, y0 + 0.3]], "k")]), Lg([[-W / 2 - 0.15, y0 + 0.15], [-W / 2 - 0.15, back + 0.15], [W / 2 + 0.15, back + 0.15], [W / 2 + 0.15, y0 + 0.15], [-W / 2 - 0.15, y0 + 0.15]], "t"));   // parete di presa e parapetto sui muri (77.78)
        if (trans) [-aB, aB].forEach(a => plan.push(R(-W / 2 - 0.3, a - bb / 2, W + 0.6, bb, "k")));   // travi HEB sotto le piastre delle pompe, appoggiate sui muri
        else for (let i = 0; i < n; i++) { const x = -W / 2 + side + i * pitch; [-aB, aB].forEach(a => plan.push(R(x + a - bb / 2, y0, bb, back + 0.3 - y0, "k"))); }
        plan.push(Ld(trans ? [-W / 2 - 0.15, -aB] : [-W / 2 + side - aB, y0 + 0.8], [-W / 2 - 1.1, trans ? -aB - 1.0 : y0 + 0.2], t("wk_beams").replace("{p}", bm.name).replace("{l}", fmtM(bmL)))); }
      for (let i = 0; i < n; i++) { const x = -W / 2 + side + i * pitch; plan.push(R(x - p.pL / 2, -p.pL / 2, p.pL, p.pL, "eq"), C(x, 0, D / 2, "h"), C(x, 0, p.Dm / 2, "k"), Tx(x, -0.04, "P" + (i + 1), 2.6, "c"), Pp([[x, p.pL / 2], [x, back + 0.75]], p.dnD), Vv(x, back + 0.5, 90, "check")); }
      plan.push(Pp([[-W / 2 + side, back + 0.75], [W / 2 + 0.9, back + 0.75]], n > 1 ? p.dnC : p.dnD), Tx(W / 2 + 0.95, back + 0.95, t("wk_collector") + " DN " + (n > 1 ? p.dnC : p.dnD), 2.2, "l"));
      plan.push(Lg([[-0.5, -Lf - 0.3], [0.5, -Lf - 0.3]], "k"), Lg([[0.5, -Lf - 0.3], [0.38, -Lf - 0.24]], "k"), Lg([[0.5, -Lf - 0.3], [0.38, -Lf - 0.36]], "k"));
      if (canal) {   // presa dal canale o dal lago (77.77): tubo corrugato SN8 a gravità con la griglia, oppure pozzetto a fianco o in testa al canale con la finestra di presa
        const y0 = -Lf - 0.6, wv = (yy, x0, x1) => { for (let xw = x0; xw < x1; xw += 0.9) plan.push(Lg([[xw, yy - 0.15], [xw + 0.25, yy - 0.05], [xw + 0.5, yy - 0.15]], "t")); };
        if (sF === "pipe") { const intD = Math.min(p.intL, 2.4), yB = y0 - intD, yW = yB - p.canW, di = dnI / 1000;   // presa lunga: disegnata interrotta, la quota porta la misura vera (78.29)
          if (intD < p.intL - 0.05) { const ym = (yB + y0) / 2; [-0.06, 0.06].forEach(dy => plan.push(Lg([[-W / 2 - 0.5, ym + dy], [-0.15, ym + dy + 0.12], [0.15, ym + dy - 0.12], [W / 2 + 0.5, ym + dy]], "t"))); }
          plan.push(Lg([[-W / 2 - 3, yB], [W / 2 + 3, yB]], "k"), Lg([[-W / 2 - 3, yW], [W / 2 + 3, yW]], "k"), Tx(-W / 2 - 2.9, (yB + yW) / 2, t("wk_canal"), 2.6, "l")); wv((yB + yW) / 2, -W / 2 - 1.2, W / 2 + 2.5);
          for (let i = 0; i < nI; i++) { const xi = nI > 1 ? -W / 4 + i * (W / 2) / (nI - 1) : 0; plan.push(...corr([[xi, yB - 0.4], [xi, y0]], dnI), R(xi - di * 0.9, yB - 0.55, di * 1.8, 0.15, "k")); if (i === nI - 1) plan.push(Tx(xi + di + 0.1, yB - 0.75, t("wk_grate"), 2, "l")); }
          plan.push(Dm([W / 2 + 0.6, yB], [W / 2 + 0.6, y0], -0.3, fmtM(p.intL)), Tx(W / 2 + 0.9, (yB + y0) / 2, t("wk_corrLab").replace("{n}", nI).replace("{dn}", dnI), 2.2, "l")); }
        else {   // finestra di presa nella parete verso il canale: griglia a barre e gargami per i panconi
          const gr = [R(-W / 2 - 0.12, y0 + 0.05, 0.12, 0.2, "k"), R(W / 2, y0 + 0.05, 0.12, 0.2, "k")];   // gargami nelle pareti laterali
          if (sW === "gate") plan.push(Lg([[-W / 2, y0 + 0.08], [W / 2, y0 + 0.08]], "h"), R(-W / 2, y0 + 0.16, W, 0.06, "k"), ...gr, R(-0.18, y0 + 0.36, 0.36, 0.2, "eq"), Tx(W / 2 + 0.45, y0 - 0.55, t("wk_wGateL"), 2, "l"));   // paratoia con il volantino sopra
          else if (sW === "rack") { plan.push(Lg([[-W / 2, y0 + 0.15], [W / 2, y0 + 0.15]], "k"), ...gr, Tx(W / 2 + 0.45, y0 - 0.55, t("wk_wRackL"), 2, "l")); for (let xg = -W / 2 + 0.1; xg < W / 2 - 0.05; xg += 0.12) plan.push(Lg([[xg, y0 + 0.1], [xg, y0 + 0.2]], "t")); }   // griglia a tutta altezza fra le pareti laterali, senza muro
          else if (sW === "pipes") { const di = dnI / 1000; for (let i = 0; i < nI; i++) { const xi = nI > 1 ? -W / 4 + i * (W / 2) / (nI - 1) : 0; plan.push(...corr([[xi, y0 - 0.45], [xi, y0 + 0.45]], dnI), R(xi - di * 0.9, y0 - 0.6, di * 1.8, 0.15, "k")); }
            plan.push(Tx(W / 2 + 0.45, y0 - 0.55, t("wk_wPipesL").replace("{n}", nI).replace("{dn}", dnI), 2, "l")); }   // tubi corrugati passanti nella parete piena, con la griglia
          else plan.push(Lg([[-W / 2, y0 + 0.15], [W / 2, y0 + 0.15]], "h"), ...gr, Tx(W / 2 + 0.45, y0 - 0.55, t("wk_window"), 2, "l"));
          plan.push({ ...Lg([[-W / 2 - 0.3, y0 + 0.15], [W / 2 + 0.3, y0 + 0.15]], "t"), inv: 1, we: { k: "sWall", v: sW } });   // clic sulla parete: si sceglie il tipo
          if (sF === "side") { const yW = y0 - p.canW; plan.push(Lg([[-W / 2 - 4, y0], [-W / 2 - 0.3, y0]], "k"), Lg([[W / 2 + 0.3, y0], [W / 2 + 4, y0]], "k"), Lg([[-W / 2 - 4, yW], [W / 2 + 4, yW]], "k"), Tx(-W / 2 - 3.9, (y0 + yW) / 2 + 0.25, t("wk_canal"), 2.6, "l")); wv((y0 + yW) / 2, -W / 2 - 1.5, W / 2 + 3); }
          else { const hc = Math.max(W / 2 + 0.3, p.canW / 2), yE = y0 - 6; plan.push(Lg([[-hc, y0], [-hc, yE]], "k"), Lg([[hc, y0], [hc, yE]], "k"), Tx(hc + 0.3, y0 - 3, t("wk_canal"), 2.6, "l")); for (let yy = y0 - 0.8; yy > yE + 0.5; yy -= 1.2) wv(yy, -hc + 0.4, hc - 0.6); } }
      }
      plan.push(Tx(0, -Lf - 0.48, t("wk_vIn"), 2.2, "c"), Dm([-W / 2, -Lf - 0.6], [W / 2, -Lf - 0.6], -0.5), Dm([W / 2, 0], [W / 2, back], -0.55, fmtM(back)), Dm([W / 2, -Lf], [W / 2, 0], -0.55, fmtM(Lf)));
      if (n > 1) plan.push(Dm([-W / 2 + side, back + 0.05], [-W / 2 + side + pitch, back + 0.05], 0.35));
      plan.push(Dm([-W / 2, back + 0.05], [-W / 2 + side, back + 0.05], 0.35));
    } else {
      plan.push(C(0, 0, wd / 2000 + 0.05, "k"), C(0, 0, wd / 2000, "t"), R(-p.pL / 2, -p.pL / 2, p.pL, p.pL, "eq"), C(0, 0, p.Dm / 2, "k"), Tx(0, -0.04, "P1", 2.6, "c"), Pp([[p.pL / 2, 0], [p.pL / 2 + 1.0, 0]], p.dnD), R(-0.9, -0.9, 1.8, 1.8, "h"));
      plan.push(Ld([wd / 2000 * 0.7, -wd / 2000 * 0.7], [0.9, -1.25], t("wk_casing").replace("{d}", wd)));
    }
    plan.push(Lg([[-0.25, 0], [0.25, 0]], "cl"));
    if (!well) { const xP1 = -W / 2 + side, yLo = canal && sF === "pipe" ? -Lf - 0.6 - Math.min(p.intL, 2.4) - p.canW - 0.6 : canal && sF === "end" ? -Lf - 7.2 : canal && sF === "side" ? -Lf - 0.6 - p.canW - 0.6 : -Lf - 1.4;
      plan.push(...cutT([[xP1, yLo], [xP1, back + 1.3]], "B", 1)); if (trans) plan.push(...cutT([[-W / 2 - 1.3, 0], [W / 2 + 1.3, 0]], "A", 1)); }   // tracce della sezione B-B e del dettaglio A-A (78.29)
    else plan.push(...cutT([[-1.5, 0], [1.9, 0]], "B", 1));
    view(t("wk_vPlan"), plan);
    // sezione sulla pompa: motore, gruppo di comando sulla soletta, linea d'asse, corpo pompa e succheruola sotto il pelo libero; pozzi profondi interrotti
    const Y = wkBreakY(-H - 1.0, Math.min(-lift + 0.8, yt + 0.6), 0.8), hw = wd / 2000, ld = p.lsD, Rr = (x, y0, w, h, st) => R(x, Y(y0), w, Y(y0 + h) - Y(y0), st);
    const sec = [well ? ground(-1.4, 1.6, 0) : ground(back + 0.3, back + 1.4, 0), { t: "w", x0: well ? -hw : -Lf, x1: well ? hw : back, y: Y(-lift) }];
    if (!well) {
      const x0w = -Lf - 0.6, bed = -lift - p.canD, open = canal && sF !== "pipe", sill = sFl === "low" ? Math.max(yF + 0.3, bed) : Math.max(yF, bed), wTop = -lift + 0.3;
      if (canal && Math.abs(yF - bed) > 0.02) sec.push(Dm([x0w + 0.45, Y(bed)], [x0w + 0.45, Y(yF)], 0, "Δ " + fmtM(Math.abs(yF - bed))));   // dislivello fra il fondo del canale e il fondo del pozzetto
      sec.push(Rr(back, yF - 0.3, 0.3, -yF + 0.3, "conc"), Rr(-Lf, yF - 0.3, Lf + back + 0.3, 0.3, "conc"));   // pozzetto aperto (77.78): pareti fino al piano campagna, nessuna soletta
      if (open && sW === "rack") sec.push(Rr(x0w, yF - 0.3, 0.3, sill - yF + 0.3, "conc"), Rr(x0w, -0.3, 0.3, 0.3, "conc"));   // griglia a tutta altezza: soglia in basso e trave di coronamento
      else if (open && sW !== "pipes") sec.push(Rr(x0w, yF - 0.3, 0.3, sill - yF + 0.3, "conc"), Rr(x0w, wTop, 0.3, -wTop, "conc")); else sec.push(Rr(x0w, yF - 0.3, 0.3, -yF + 0.3, "conc"));   // parete di presa: dentro c'è la finestra con i gargami
      if (!canal) sec.push(ground(x0w - 1.4, x0w, 0));
      [x0w + 0.15, back + 0.15].forEach(xr => sec.push(Lg([[xr, 0], [xr, 1.1]], "k")));   // parapetto h 1,10 m sui muri
      sec.push(Lg([[x0w + 0.15, 1.1], [back + 0.15, 1.1]], "t"), Lg([[x0w + 0.15, 0.55], [back + 0.15, 0.55]], "t"), Lg([[x0w + 0.15, 0.1], [back + 0.15, 0.1]], "t"));
      const hb = bm.h / 1000, bb = bm.b / 1000, tfl = Math.max(0.012, hb * 0.08), tw = Math.max(0.01, hb * 0.05), Ib = (xc) => [wkPg([[xc - bb / 2, 0], [xc + bb / 2, 0], [xc + bb / 2, tfl], [xc + tw / 2, tfl], [xc + tw / 2, hb - tfl], [xc + bb / 2, hb - tfl], [xc + bb / 2, hb], [xc - bb / 2, hb], [xc - bb / 2, hb - tfl], [xc - tw / 2, hb - tfl], [xc - tw / 2, tfl], [xc - bb / 2, tfl]], 25, "k")];   // trave HEB in sezione, piena   // trave HEB in sezione
      if (trans) sec.push(Lg([[x0w + 0.3, 0], [back, 0]], "k"), ...Ib(-aB), ...Ib(aB));   // la parete laterale oltre il piano di sezione, con le travi appoggiate sopra   // travi fra le pareti laterali: in sezione le due travi sotto la piastra
      else sec.push(R(x0w, 0, back + 0.3 - x0w, hb, "k"), Lg([[x0w, tfl], [back + 0.3, tfl]], "t"), Lg([[x0w, hb - tfl], [back + 0.3, hb - tfl]], "t"));   // travi lungo il pozzetto, appoggiate sulle pareti di presa e di fondo
      sec.push(Ld([trans ? aB + bb / 2 : back - 0.4, hb * 0.5], [back + 0.9, -0.55], t("wk_beams").replace("{p}", bm.name).replace("{l}", fmtM(bmL))), Tx(x0w + 0.1, 1.3, t("wk_railing"), 1.9, "l"));
      sec.push(Lg([[-Lf, Y(yF)], [x0w, Y(yF) + 0.6 * Math.tan(7 * Math.PI / 180)]], "k"));
      if (open && sW === "gate") sec.push(Lg([[x0w + 0.08, Y(sill)], [x0w + 0.08, Y(wTop)]], "h"), R(x0w + 0.17, Y(wTop), 0.06, Y(sill) - Y(wTop), "k"), Lg([[x0w + 0.2, Y(wTop)], [x0w + 0.2, 1.0]], "k"), R(x0w + 0.05, 0.0, 0.3, 0.12, "k"), R(x0w + 0.08, 1.0, 0.24, 0.04, "k"), Ld([x0w + 0.2, Y((sill + wTop) / 2)], [x0w - 1.2, 0.9], t("wk_wGateL")));   // paratoia a ghigliottina: tavola, asta, castelletto e volantino
      else if (open && sW === "rack") { sec.push(Lg([[x0w + 0.15, Y(sill)], [x0w + 0.15, -0.3]], "k"), R(x0w + 0.25, -0.3, 0.06, Y(sill) + 0.3, "t"), Ld([x0w + 0.15, Y((sill + wTop) / 2)], [x0w - 1.2, 0.9], t("wk_wRackL"))); for (let yy = sill + 0.2; yy < -0.35; yy += 0.25) sec.push(Lg([[x0w + 0.1, Y(yy)], [x0w + 0.2, Y(yy)]], "t")); }   // griglia fino alla trave di coronamento
      else if (open && sW === "pipes") { const yP = Math.max(sill + dnI / 2000 + 0.1, Math.min((sill + wTop) / 2, -lift - 0.3 - dnI / 2000)); sec.push(...corr([[x0w - 0.45, Y(yP)], [x0w + 0.45, Y(yP)]], dnI), Lg([[x0w - 0.45, Y(yP) - dnI / 1000 * 0.75], [x0w - 0.45, Y(yP) + dnI / 1000 * 0.75]], "k"), Ld([x0w + 0.15, Y(yP)], [x0w - 1.2, 0.9], t("wk_wPipesL").replace("{n}", nI).replace("{dn}", dnI))); }   // tubi passanti sotto il livello minimo, griglia all'imbocco
      else if (open) sec.push(Lg([[x0w, Y(yF - 0.3)], [x0w, Y(sill)]], "k"), Lg([[x0w, Y(wTop)], [x0w, -H]], "k"), Lg([[x0w + 0.15, Y(sill)], [x0w + 0.15, Y(wTop)]], "h"), R(x0w + 0.25, Y(wTop), 0.08, Y(sill) - Y(wTop), "t"), Ld([x0w + 0.15, Y((sill + wTop) / 2)], [x0w - 1.2, 0.9], t("wk_window")));
      else sec.push(canal ? Lg([[x0w, Y(yF - 0.3)], [x0w, -H]], "k") : Lg([[x0w, Y(yF - 0.3)], [x0w, -H]], "h"));
      if (canal && sF === "pipe") {   // canale o lago, sponda in scarpa, tubo corrugato SN8 a gravità con la griglia in testa (77.77)
        const intD = Math.min(p.intL, 2.4), xS = x0w - intD, xB = xS - p.slope * (-bed), yIt = Math.max(bed + 0.35, -lift - 0.6 - dnI / 2000), xG = xS - p.slope * (-yIt) + 0.3;
        sec.push(Lg([[x0w, 0], [xS, 0], [xB, Y(bed)], [xB - p.canW * 0.6, Y(bed)]], "k"), { t: "w", x0: xB - p.canW * 0.6, x1: xS - p.slope * lift, y: Y(-lift) });
        sec.push(...corr([[xG, Y(yIt)], [x0w, Y(yIt)]], dnI), Lg([[xG, Y(yIt) - dnI / 1000 * 0.75], [xG, Y(yIt) + dnI / 1000 * 0.75]], "k"));
        if (intD < p.intL - 0.05) { const xm = (xS + x0w) / 2; [-0.06, 0.06].forEach(dx => sec.push(Lg([[xm + dx, Y(yIt) - dnI / 1000 - 0.3], [xm + dx + 0.1, Y(yIt) - 0.1], [xm + dx - 0.1, Y(yIt) + 0.1], [xm + dx, Y(yIt) + dnI / 1000 + 0.3]], "t"))); sec.push(Dm([xS, 0], [x0w, 0], 0.35, fmtM(p.intL))); }   // tubo interrotto: la quota dice la lunghezza vera
        sec.push(Tx(xG - 0.1, Y(yIt) + 0.45, t("wk_grate"), 2, "r"), Dm([xB - 0.2, Y(-lift)], [xB - 0.2, Y(bed)], 0.25, fmtM(p.canD)), Tx(xB - p.canW * 0.3, Y(-lift) + 0.25, t("wk_canal"), 2.4, "c"), Tx((xG + x0w) / 2, Y(yIt) - dnI / 1000 * 0.6 - 0.35, t("wk_corrLab").replace("{n}", nI).replace("{dn}", dnI), 2, "c"));
      } else if (open) {   // pozzetto a fianco del canale (sezione trasversale del canale) o in testa (sezione lungo il canale): l'acqua entra dalla finestra
        const xC = x0w - p.canW;
        if (sF === "side") sec.push(Lg([[x0w, Y(bed)], [xC, Y(bed)], [xC - p.slope * (-bed), 0], [xC - p.slope * (-bed) - 1.5, 0]], "k"), { t: "w", x0: xC - p.slope * lift, x1: -Lf, y: Y(-lift) });
        else sec.push(Lg([[x0w, Y(bed)], [x0w - 6, Y(bed)]], "k"), Lg([[x0w - 6, 0], [x0w, 0]], "h"), { t: "w", x0: x0w - 6, x1: -Lf, y: Y(-lift) });
        sec.push(Dm([x0w - 0.4, Y(-lift)], [x0w - 0.4, Y(bed)], 0.25, fmtM(p.canD)), Tx(x0w - Math.max(2.8, p.canW * 0.6), Y(-lift) - 0.45, t("wk_canal"), 2.4, "c"));
      }
    } else { sec.push(Lg([[-hw, 0], [-hw, Y(yF - 0.6)]], "k"), Lg([[hw, 0], [hw, Y(yF - 0.6)]], "k"), R(-0.9, -H, 1.8, H, "conc")); }
    const bA = p.bA && p.bA < p.Hb ? p.bA : p.Hb * 0.75, hsu = p.Hb - bA, yB0 = well ? 0.04 : -H;   // corpo pompa con gli stadi del catalogo, sotto la succheruola
    sec.push(...wkSym.column(0, -H, yt, ld, ld * 1.5, p.lsL, Y), ...wkSym.bowl(0, yt, bA, p.bSt || Math.max(1, Math.round(bA / 0.4)), 0.2, D * 0.9, ld, Y), ...wkSym.strainer(0, yI + hsu, hsu, D, 0, Y));
    { const yM = yI + Sreq, xm = (well ? -(hw + 0.35) : -(D / 2 + 0.55)) - 0.8, xl = well ? -hw : -Lf, xr = well ? hw : back;   // livello minimo ammesso e la sua sommergenza, lontano dalle altre quote
      sec.push(Lg([[xl, Y(yM)], [xr + 0.6, Y(yM)]], "h"), Dm([xm, Y(yI)], [xm, Y(yM)], 0, "S min " + fmtM(Sreq)), Tx(xr + 0.7, Y(yM) - 0.07, t("wk_minLev"), 1.9, "l")); }   // la scritta fuori dalla vasca, sul prolungamento della linea
    if (Math.min(-lift + 0.8, yt + 0.6) < -H - 4.0) { const yb0 = -H - 1.0 - 0.4; [-1, 1].forEach(sg => { const xw = well ? hw + 0.12 : ld / 2 + 0.25; sec.push(Lg([[-xw, Y(yb0) + 0.05 * sg], [-xw * 0.3, Y(yb0) + 0.05 * sg + 0.08], [xw * 0.3, Y(yb0) + 0.05 * sg - 0.08], [xw, Y(yb0) + 0.05 * sg]], "t")); }); }
    const dnHd = p.dnH > 0 && p.dnH < p.dnD ? p.dnH : 0;   // bocca della testata più piccola degli accessori (78.29): riduzione concentrica flangiata subito dopo la bocca
    const hvS = wkSym.head(0, yB0, { kind: p.gear ? "gear" : "el", pL: p.pL, A: p.Hh, B: p.Hh * 0.3, C: p.pL * 0.6, D: p.pL * 0.6, E: p.Dm * 0.9, dn: dnHd || p.dnD }); sec.push(...hvS);
    if (!p.gear) sec.push(...wkSym.motor(0, yB0 + p.Hh, p.Dm, p.Hm));
    const LrH = dnHd ? Math.max(0.3, wkAccL("red", p.dnD)) : 0, d0V = [hvS.dis[0] + LrH, hvS.dis[1]];
    if (dnHd) sec.push({ t: "p", pts: [hvS.dis, d0V], dn: dnHd, cone: p.dnD }, Ld([hvS.dis[0] + LrH / 2, hvS.dis[1] - p.dnD / 2000], [hvS.dis[0] + LrH / 2 + 0.4, hvS.dis[1] - p.dnD / 1000 - 0.45], "DN " + dnHd + " → DN " + p.dnD));
    const pthV = [d0V, [hvS.dis[0] + 2.7 + LrH, hvS.dis[1]]]; sec.push(Pp(pthV, p.dnD)); accL = p.acc || wkAccAlong(pthV, wkAccRec("vert"), p.dnD, 0.05); wkAccPut(sec, pos, accL, t); bomL(pthV, p.dnD, p.n, dnHd);
    // quote in catena a sinistra della pompa (77.86): fondo → bocca, bocca → livello (S), livello → piano; poi S min e la profondità, ognuna sulla sua linea
    const xq0 = well ? -(hw + 0.35) : -(D / 2 + 0.55), xq1 = xq0 - 0.8, xq2 = xq1 - 0.8;
    sec.push(Dm([xq0, Y(yI)], [xq0, Y(-lift)], 0, "S " + fmtM(S)), Dm([xq0, Y(-lift)], [xq0, 0], 0, t("wk_level") + " " + fmtM(lift)));
    sec.push(Dm([xq2, Y(yF)], [xq2, 0], 0, fmtM(-yF)), Dm([p.Dm / 2 + 0.1, yB0], [p.Dm / 2 + 0.1, yB0 + p.Hh + p.Hm], -0.35));
    if (!well) sec.push(Dm([0, Y(yF - 0.3)], [back, Y(yF - 0.3)], -0.35, fmtM(back)));
    sec.push(Ld([p.Dm / 2, yB0 + p.Hh + p.Hm * 0.6], [p.Dm / 2 + 0.7, yB0 + p.Hh + p.Hm + 0.35], (p.gear ? t("wk_gearHead") + " · " + p.kgH : t("wk_motorV1") + " · " + p.kgM) + " kg"));
    sec.push(Ld([ld / 2, Y(-H - 0.5)], [D / 2 + 0.75, Y(-H - 0.5) - 0.3], t("wk_lineShaft").replace("{n}", rem > 0.01 ? (nF ? nF + " × " + fmtM(p.lsL) + " + 1" : "1") : String(nF)).replace("{l}", rem > 0.01 ? fmtM(rem) : fmtM(p.lsL)).replace("{kg}", Math.round(p.kgLs))));   // elementi interi + quello di testa accorciato (78.29)
    sec.push(Ld([D * 0.42, Y(yt - p.Hb * 0.55)], [D / 2 + 0.75, Y(yt - p.Hb * 0.55) - 0.25], t("wk_bowl") + " · " + p.kgB + " kg · " + t("wk_offFloor").replace("{d}", fmtM(cl))));   // la distanza dal fondo nel richiamo: in fondo alla vasca la quota non ci sta
    view(t("wk_vSec") + " B-B", sec);
    if (!well && trans) {   // DETTAGLIO A-A (77.86), di traverso al pozzetto: le due travi HEB per tutta la lunghezza, appoggiate sulle pareti laterali con le piastre, e le pompe sopra
      const hbB = bm.h / 1000, tfB = Math.max(0.012, hbB * 0.08), yC = -0.6, brk = (x0, x1) => [-1, 1].forEach(sg => sa.push(Lg([[x0, yC + 0.03 * sg], [x0 + (x1 - x0) * 0.4, yC + 0.03 * sg + 0.05], [x0 + (x1 - x0) * 0.6, yC + 0.03 * sg - 0.05], [x1, yC + 0.03 * sg]], "t")));
      const sa = [ground(-W / 2 - 1.0, -W / 2 - 0.3, 0), ground(W / 2 + 0.3, W / 2 + 1.0, 0)];
      sa.push(R(-W / 2 - 0.3, yC, 0.3, -yC, "conc"), R(W / 2, yC, 0.3, -yC, "conc")); brk(-W / 2 - 0.4, -W / 2 + 0.1); brk(W / 2 - 0.1, W / 2 + 0.4);   // teste delle pareti laterali, interrotte
      sa.push(wkPg([[-W / 2 - 0.28, 0], [W / 2 + 0.28, 0], [W / 2 + 0.28, hbB], [-W / 2 - 0.28, hbB]], 215, "k"), Lg([[-W / 2 - 0.28, tfB], [W / 2 + 0.28, tfB]], "t"), Lg([[-W / 2 - 0.28, hbB - tfB], [W / 2 + 0.28, hbB - tfB]], "t"));   // trave HEB vista di fianco
      [-1, 1].forEach(sg => sa.push(R(sg > 0 ? W / 2 + 0.02 : -W / 2 - 0.28, -0.025, 0.26, 0.025, "k"), Lg([[sg * (W / 2 + 0.15), -0.025], [sg * (W / 2 + 0.15), -0.35]], "h")));   // piastre d'appoggio con i tirafondi
      for (let i = 0; i < n; i++) { const xi = -W / 2 + side + i * pitch, hvA = wkSym.head(xi, yB0, { kind: p.gear ? "gear" : "el", pL: p.pL, A: p.Hh, B: p.Hh * 0.3, C: p.pL * 0.6, D: p.pL * 0.6, E: p.Dm * 0.9, dn: p.dnD });
        sa.push(...wkSym.column(xi, -H, yC, ld, ld * 1.5, p.lsL), ...hvA, Tx(xi, yB0 + p.Hh + 0.25, "P" + (i + 1), 2.4, "c")); }   // solo la testata (il motore è nella sezione B-B)
      [-W / 2 - 0.15, W / 2 + 0.15].forEach(xr => sa.push(Lg([[xr, 0], [xr, 0.6]], "t")));   // montanti del parapetto (interrotti)
      sa.push(Ld([W / 2 - 0.2, hbB * 0.5], [W / 2 + 0.6, -0.5], t("wk_beams").replace("{p}", bm.name).replace("{l}", fmtM(bmL))), Dm([-W / 2, yC - 0.2], [W / 2, yC - 0.2], 0, fmtM(W)), Dm([-W / 2 - 0.28, yC - 0.45], [W / 2 + 0.28, yC - 0.45], 0, fmtM(bmL)), Dm([W / 2 + 0.45, 0], [W / 2 + 0.45, hbB], 0, fmtM(hbB)));
      view(t("wk_vBeamDet"), sa, { inset: 1 }); }
    const vIn = !well ? (+p.Q || 0) / 3600 / Math.max(0.01, W * (-lift - yF)) : 0, wkWs = Math.round(wkColWater(ld, Lc) + Math.PI / 4 * Math.pow(D * 0.9, 2) * p.Hb * 0.45 * 1000 + Math.PI / 4 * Math.pow(p.dnD / 1000, 2) * p.Hh * 0.6 * 1000);
    const kgAccW = Math.round(wkAccWet(accL)), kgRunU = kgU + wkWs + kgAccW;   // PESO IN ESERCIZIO (78.29): uno solo per tabella, note e verifica delle travi (macchina con la linea d'asse posata, acqua, accessori pieni)
    notes.push(t("wk_nRun").replace("{w}", wkWs).replace("{a}", kgAccW));
    const vc = well ? 1.8 * 1.8 * H : (Lf + back + 0.3) * (W + 0.6) * 0.3 + 2 * (Lf + back + 0.9) * 0.3 * (0.3 - yF) + 2 * (W + 0.6) * 0.3 * (0.3 - yF);   // platea e pareti fino al piano campagna (pozzetto aperto)
    if (!well) { const nB = trans ? 2 : 2 * n, pr = Math.round((2 * (W + 0.6) + 2 * (Lf + back + 0.9)) * 10) / 10; qty.push([t("wk_qBeams").replace("{p}", bm.name), nB + " × " + fmtM(bmL).replace(" m", ""), "m"]);
      BM.add("civ", "wk_beam_heb" + bm.h + "_" + Math.round(bmL * 100), t("wk_bmBeam").replace("{p}", bm.name).replace("{l}", fmtM(bmL)).replace("{kg}", Math.round(bm.kg * bmL)), nB, "n°"); BM.add("civ", "wk_rail_pit", t("wk_bmRailPit"), pr, "m");
      const bmV = wkBeam(trans ? spT : spL, kgRunU, trans ? n : 1, bm.h - 1) || bm;   // verifica del profilo posato col peso in esercizio definitivo
      notes.push(t("wk_nBeams").replace("{p}", bm.name).replace("{n}", nB).replace("{l}", fmtM(bmL)).replace("{w}", trans ? t("wk_bmTr") : t("wk_bmLo")).replace("{kg}", kgRunU));
      const f1 = (v, d) => (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).replace(".", WK_DEC);
      if (bm !== bmC && bm.h !== bmC.h) notes.push(t("wk_nBeamF").replace("{f}", String(Math.round(bmF * 10) / 10).replace(".", WK_DEC)).replace("{c}", bmC.name).replace("{p}", bm.name));
      notes.push(t("wk_bmKgSplit").replace("{m}", kgU).replace("{w}", wkWs + kgAccW));
      notes.push(t("wk_nBeamCalc").replace("{p}", bmV.name).replace("{l}", fmtM(bmV.L)).replace("{q}", bmV.nP).replace("{kg}", kgRunU).replace("{P}", f1(bmV.P, 1)).replace("{M}", f1(bmV.M, 1)).replace("{s}", Math.round(bmV.s)).replace("{f}", f1(bmV.f, 1)).replace("{fl}", f1(bmV.fl, 1))); }
    qty.push([t("wk_qConc"), m3(vc), "m³"], [t("wk_qLean"), m3(well ? 1.8 * 1.8 * 0.1 : (Lf + back + 0.9) * (W + 0.6) * 0.1), "m³"], [t("wk_qSteel"), Math.round(vc * 80), "kg"], [t("wk_qPumps"), String(n), ""], [t("wk_qKgUnit"), kgU, "kg"], [t("wk_qWater"), wkWs + kgAccW, "kg"], [t("wk_qKgRun"), kgRunU, "kg"], [t("wk_qKgAll"), kgU * n, "kg"], [t("wk_qHeavy"), Math.max(p.kgM, p.kgH, p.kgB + p.kgA, p.kgLs), "kg"]);
    notes.push(t("wk_nSubMin").replace("{s}", fmtM(Sreq)).replace("{c}", fmtM(sBody)).replace("{d}", fmtM(s25)).replace("{h}", fmtM(sHI)).replace("{v}", (Math.round(vB * 100) / 100).toFixed(2).replace(".", WK_DEC)).replace("{l}", fmtM(-(yI + Sreq))).replace("{w}", fmtM(lift)).replace("{a}", fmtM(S)));
    notes.push(t(well ? "wk_nVertWell" : "wk_nVert").replace("{s}", fmtM(S)).replace("{d}", fmtM(D)).replace("{w}", wd));
    if (canal && sF === "pipe") { notes.push(t("wk_nCanalCorr").replace("{n}", nI).replace("{dn}", dnI).replace("{l}", fmtM(p.intL)));
      BM.add("pipe", "wk_corr_sn8_" + dnI, t("wk_bmCorr").replace("{dn}", dnI), Math.ceil(nI * (p.intL + 0.6)), "m"); BM.add("valv", "wk_grate_" + dnI, t("wk_bmGrate").replace("{dn}", dnI), nI, "n°"); BM.add("pipe", "wk_sleeve_" + dnI, t("wk_bmSleeve").replace("{dn}", dnI), nI, "n°"); }
    if (canal) notes.push(t("wk_nFloor").replace("{m}", wkLc(t, t("wk_sFl_" + sFl))).replace("{d}", fmtM(Math.abs(yF - bedC))).replace("{s}", fmtM(S)).replace("{r}", fmtM(Sreq)) + (S < Sreq - 0.005 ? " " + t("wk_subKo") : "") + (flForced ? " " + t("wk_nFloorForced") : ""));
    if (canal && sF !== "pipe") { const hWin = Math.max(0.3, -lift + 0.3 - Math.max(yF + (sFl === "low" ? 0.3 : 0), -lift - p.canD)); notes.push(t(sF === "side" ? "wk_nCanalSide" : "wk_nCanalEnd").replace("{w}", fmtM(W)).replace("{h}", fmtM(hWin)));
      const hR = sW === "rack" ? Math.max(0.3, -0.3 - Math.max(yF + 0.3, -lift - p.canD)) : hWin;   // griglia fino al coronamento
      if (sW === "pipes") { notes.push(t("wk_nWallPipes").replace("{n}", nI).replace("{dn}", dnI)); BM.add("pipe", "wk_corr_sn8_" + dnI, t("wk_bmCorr").replace("{dn}", dnI), Math.ceil(nI * 1.2), "m"); BM.add("valv", "wk_grate_" + dnI, t("wk_bmGrate").replace("{dn}", dnI), nI, "n°"); BM.add("pipe", "wk_sleeve_" + dnI, t("wk_bmSleeve").replace("{dn}", dnI), nI, "n°"); }
      else { BM.add("valv", "wk_rack_" + Math.round(W * 10) + "_" + Math.round(hR * 10), t("wk_bmRack").replace("{w}", fmtM(W)).replace("{h}", fmtM(hR)), 1, "n°");
        if (sW === "gate") { notes.push(t("wk_nWallGate").replace("{w}", fmtM(W)).replace("{h}", fmtM(hWin))); BM.add("valv", "wk_sgate_" + Math.round(W * 10) + "_" + Math.round(hWin * 10), t("wk_bmSGate").replace("{w}", fmtM(W)).replace("{h}", fmtM(hWin)), 1, "n°"); }
        else { if (sW === "rack") notes.push(t("wk_nWallRack").replace("{w}", fmtM(W)).replace("{h}", fmtM(hR))); BM.add("valv", "wk_stop_" + Math.round(W * 10), t("wk_bmStop").replace("{w}", fmtM(W)), 1, "n°"); } } }
    if (!well) notes.push(t("wk_nSump").replace("{v}", (Math.round(vIn * 100) / 100).toFixed(2).replace(".", WK_DEC)) + (vIn > 0.3 ? " " + t("wk_nSumpWide") : ""));
    notes.push(t("wk_nVertKg").replace("{m}", p.kgM).replace("{h}", p.kgH).replace("{n}", rem > 0.01 ? (nF ? nF + " + " : "") + String(wkR(rem / p.lsL, 2)).replace(".", WK_DEC) : String(nF)).replace("{ls}", Math.round(p.kgLs)).replace("{b}", p.kgB).replace("{a}", p.kgA + p.kgT));
    notes.push(t(p.cat ? "wk_nCat" : "wk_nNoCat").replace("{m}", p.model || "—"), t("wk_nConc"));
  }
  if (type === "station" && p.kind === "subm" && p.inst !== "float") {
    // ELETTROPOMPA SOMMERSA in pozzo: testa pozzo su plinto, tubo di mandata, pompa con il motore sotto, sotto il livello dinamico
    const n = Math.max(1, Math.round(p.n || 1)), lift = Math.max(0.5, +p.lift || 10), hw = p.wellD / 2000, H = p.H, top = -(lift + p.imm), bot = top - p.L, dn = p.dnD / 1000;
    const plan = [R(-0.6, -0.6, 1.2, 1.2, "k"), C(0, 0, hw + 0.03, "k"), C(0, 0, hw, "t"), C(0, 0, p.D / 2, "eq"), C(0, 0, dn / 2, "k"), Pp([[0, 0], [1.4, 0]], p.dnD), Vv(0.85, 0, 0, "check"), Vv(1.15, 0, 0, "gate")];
    plan.push(...cutT([[-1.1, 0], [1.9, 0]], "B", 1));   // traccia della sezione B-B (78.29)
    plan.push(Dm([-0.6, -0.6], [0.6, -0.6], -0.35), Ld([hw * 0.7, hw * 0.7], [0.8, 0.95], t("wk_casing").replace("{d}", p.wellD)), Tx(0, -hw - 0.2, n > 1 ? t("wk_nWells").replace("{n}", n) : "", 2.2, "c"));
    view(t("wk_vPlan"), plan);
    const Y = wkBreakY(-H - 1.2, Math.min(-lift + 0.8, top + 0.5), 0.8), Rr = (x, y0, w, h, st) => R(x, Y(y0), w, Y(y0 + h) - Y(y0), st);
    const sec = [ground(-1.6, 2.0, 0), R(-0.6, -H, 1.2, H + 0.1, "conc"), Lg([[-hw, -H], [-hw, Y(bot - 1.2)]], "k"), Lg([[hw, -H], [hw, Y(bot - 1.2)]], "k"), { t: "w", x0: -hw, x1: hw, y: Y(-lift) }];
    if (Math.min(-lift + 0.8, top + 0.5) < -H - 4.2) { const yb0 = -H - 1.6; [-1, 1].forEach(sg => sec.push(Lg([[-hw - 0.12, Y(yb0) + 0.05 * sg], [-0.05, Y(yb0) + 0.05 * sg + 0.08], [0.05, Y(yb0) + 0.05 * sg - 0.08], [hw + 0.12, Y(yb0) + 0.05 * sg]], "t"))); }
    sec.push(Pp([[0, Y(top)], [0, 0.45], [2.6, 0.45]], p.dnD), R(-0.25, 0.1, 0.5, 0.05, "k")); accL = p.acc || wkAccAlong([[0, 0.45], [2.6, 0.45]], wkAccRec("subm"), p.dnD, 0.3); wkAccPut(sec, pos, accL, t); bomL([[0, 0.45], [2.6, 0.45]], p.dnD, n);
    { const Lr = -top + 0.45, lp = 3, nR = Math.ceil(Lr / lp - 1e-6);   // COLONNA DI MANDATA (78.29): dalla pompa alla testa pozzo, lunga quanto la profondità d'installazione, in tubi flangiati da 3 m (l'ultimo a misura)
      BM.add("pipe", "wk_riser_" + p.dnD, t("wk_bmRiser").replace("{dn}", p.dnD).replace("{l}", fmtM(lp)).replace("{n}", nR), Math.ceil(Lr * 10) / 10 * n, "m"); BM.add("pipe", "wk_elb_" + p.dnD, t("wk_bmElb").replace("{dn}", p.dnD), n, "n°"); }
    sec.push(...wkSym.subm(0, top, p.D, p.L - p.Lm, p.Lm, wkStages(p.model), Y)); void Rr;
    sec.push(Dm([-hw - 0.15, 0], [-hw - 0.15, Y(-lift)], -0.45, t("wk_level") + " " + fmtM(lift)), Dm([-hw - 0.15, Y(-lift)], [-hw - 0.15, Y(top)], -0.45, fmtM(p.imm)), Dm([hw + 0.15, Y(top)], [hw + 0.15, Y(bot)], 0.45, fmtM(p.L)), Dm([hw + 0.15, 0], [hw + 0.15, Y(bot)], 1.0, fmtM(-bot)));   // quote fuori dal pozzo (78.29)
    sec.push(Ld([p.D / 2, Y(top - (p.L - p.Lm) / 2)], [hw + 0.9, Y(top) - 0.1], t("wk_pumpE") + " · " + p.kgP + " kg"), Ld([p.D / 2, Y(bot + p.Lm / 2)], [hw + 0.9, Y(bot) + 0.1], t("wk_motorS")), Ld([dn / 2, Y(-H - 0.6)], [hw + 0.9, Y(-H - 0.6)], t("wk_riserP").replace("{dn}", p.dnD)));
    { const hyd = p.L - p.Lm, cS = subQ(p.D, (+p.Q || 0) / 3600 / n, hyd, 1.0, 0); subG(sec, -hw - 1.3, top - hyd, cS, -hw, hw, Y); subN(t("wk_k_subm"), cS, p.imm + hyd); }   // sommergenza della griglia d'aspirazione: almeno 1 m d'acqua sopra la pompa
    view(t("wk_vSec") + " B-B", sec);
    const kgR = Math.round(-top * p.riserKg * 1.08), kgU = Math.round(p.kgP + kgR), kgWs = Math.round(-top * wkPipeWater(p.dnD) + Math.PI / 4 * Math.pow(p.D * 0.85, 2) * (p.L - p.Lm) * 0.4 * 1000);
    qty.push([t("wk_qConc"), m3(1.2 * 1.2 * (H + 0.1) * n), "m³"], [t("wk_qPumps"), String(n), ""], [t("wk_qKgPump"), p.kgP, "kg"], [t("wk_qKgRiser"), kgR, "kg"], [t("wk_qKgUnit"), kgU, "kg"], [t("wk_qWaterIn"), kgWs, "kg"], [t("wk_qKgAll"), kgU * n, "kg"]);
    notes.push(t("wk_nSubm").replace("{i}", fmtM(p.imm)).replace("{d}", p.wellD), t("wk_nSubmLift").replace("{kg}", kgU), t(p.cat ? "wk_nCat" : "wk_nNoCat").replace("{m}", p.model || "—"), t("wk_nConc"));
  }
  if (type === "station" && p.kind !== "vert" && p.kind !== "subm" && p.inst !== "float") {
    const n = Math.max(1, Math.round(p.n || 1)), lu = p.Lu, wu = p.Wu, hu = p.Hu, gap = p.gap, mg = 0.8;
    const Wp = n * wu + (n - 1) * gap + 2 * mg, Lp = lu + 2 * mg + 1.6, H = p.H, xc = mg + lu + 1.1;   // la platea lascia 1,6 m per valvole e collettore di mandata
    const plan = [R(0, 0, Lp, Wp, "k"), R(0.1, 0.1, Lp - 0.2, Wp - 0.2, "h")];
    for (let i = 0; i < n; i++) {
      const y0 = mg + i * (wu + gap), yc = y0 + wu / 2, px = mg + lu * (p.moto ? 0.22 : 0.3);
      plan.push(R(mg, y0, lu, wu, "eq"), C(px, yc, Math.min(wu * 0.33, 0.32), "k"), R(mg + lu * (p.moto ? 0.42 : 0.5), y0 + 0.08, lu * (p.moto ? 0.46 : 0.42), wu - 0.16, "t"));
      plan.push(Tx(mg + lu * 0.7, yc - 0.06, (p.moto ? "MP" : "P") + (i + 1), 2.8, "c"), Tx(mg + lu * 0.7, yc - 0.3, p.kgU + " kg", 2, "c"));
      plan.push(Pp([[px, yc], [-1.0, yc]], p.dnS), Pp([[px, yc], [px, y0 + wu + 0.15], [xc - 0.55, y0 + wu + 0.15], [xc, y0 + wu + 0.15]], p.dnD));
      plan.push(Vv(mg + lu + 0.35, y0 + wu + 0.15, 0, "check"), Vv(mg + lu + 0.75, y0 + wu + 0.15, 0, "gate"));
    }
    plan.push(Pp([[xc, mg + 0.15], [xc, Wp - 0.35], [xc, Wp + 1.3]], p.dnC), Vv(xc, Wp + 0.4, 90, "gate"), R(xc - 0.22, Wp + 0.75, 0.44, 0.3, "t"), Tx(xc + 0.35, Wp + 0.9, t("wk_meter"), 2.2, "l"));
    plan.push(Tx(-1.05, mg + wu / 2 + 0.25, t("wk_suction") + " DN " + p.dnS, 2.2, "r"), Tx(xc + 0.35, Wp + 1.35, t("wk_collector") + " DN " + p.dnC, 2.2, "l"));
    const bank = p.inst === "bank", fld = p.inst === "flooded", inl = p.inst === "inline", lift0 = Math.max(0.5, +p.lift || 3), xTop = -1.2, xWat = xTop - p.slope * lift0;
    const rvE = fld && p.rvT === "earth";   // reservoir in terra (78.29): niente muro, la presa attraversa la scarpata
    if (fld && rvE) { for (let i = 0; i < n; i++) plan.push(Vv(-0.55, mg + i * (wu + gap) + wu / 2, 0, "gate")); }   // l'argine e le prese si aggiungono in pianta con le misure della sezione
    else if (fld) {   // SOTTO BATTENTE (78.18): parete del reservoir a sinistra, uscita con griglia e saracinesca, niente valvola di fondo
      plan.push(Lg([[-1.2, -1.0], [-1.2, Wp + 1.0]], "k"), Lg([[-1.45, -1.0], [-1.45, Wp + 1.0]], "k"), Tx(-1.7, Wp + 0.7, t("wk_reservoir"), 2.6, "r"));
      for (let yw = -0.6; yw < Wp + 0.8; yw += 0.9) plan.push(Lg([[-2.4, yw], [-2.25, yw + 0.12], [-2.1, yw]], "t"));
      for (let i = 0; i < n; i++) { const yc = mg + i * (wu + gap) + wu / 2; plan.push(Pp([[-1.0, yc], [-1.85, yc]], p.dnS), R(-2.0, yc - p.dnS / 1000 * 0.9, 0.15, p.dnS / 1000 * 1.8, "t"), Vv(-0.55, yc, 0, "gate")); }
    }
    if (inl) {   // BOOSTER IN LINEA (78.18): condotta a monte → collettore d'aspirazione → pompe → collettore di mandata; by-pass con ritegno
      const yU = -0.9, ys = [...Array(n)].map((_, i) => mg + i * (wu + gap) + wu / 2);
      plan.push(Pp([[-3.6, yU], [-1.0, yU], [-1.0, ys[ys.length - 1]]], p.dnC), Vv(-2.0, yU, 0, "gate"), Tx(-3.6, yU + 0.35, t("wk_upLine").replace("{d}", wkPeOd(p, "C")).replace("{p}", String(wkR(+p.pIn || 0, 2)).replace(".", WK_DEC)), 2.2, "l"));
      ys.forEach(yc => plan.push(Vv(-0.55, yc, 0, "gate")));
      plan.push(Pp([[-2.8, yU], [-2.8, -1.9], [xc, -1.9], [xc, mg + 0.15]], p.dnC), Vv((xc - 2.8) / 2, -1.9, 0, "check"), Vv(xc - 0.6, -1.9, 0, "gate"), Tx((xc - 2.8) / 2, -2.25, t("wk_bypass"), 2.2, "c"));
      plan.push(C(xc + 0.75, Wp - 0.6, 0.3, "eq"), Tx(xc + 1.15, Wp - 0.6, t("wk_vessel"), 2, "l"), Lg([[xc, Wp - 0.6], [xc + 0.45, Wp - 0.6]], "k"));
    }
    if (bank) {   // sponda del canale o del lago: ciglio, scarpata, specchio d'acqua; i pescanti scendono lungo la scarpata
      plan.push(Lg([[xTop, -1.0], [xTop, Wp + 1.0]], "k"), Lg([[xWat, -1.0], [xWat, Wp + 1.0]], "m"), Tx(xWat - 0.3, Wp + 0.7, t("wk_canal"), 2.6, "r"), Tx((xTop + xWat) / 2, -0.75, t("wk_bankSlope").replace("{s}", String(p.slope).replace(".", WK_DEC)), 2, "c"));
      for (let yw = -0.6; yw < Wp + 0.8; yw += 0.9) plan.push(Lg([[xWat - 0.6, yw], [xWat - 0.45, yw + 0.12], [xWat - 0.3, yw]], "t"));
      for (let i = 0; i < n; i++) { const yc = mg + i * (wu + gap) + wu / 2; const Lf = wkAccL("foot", p.dnS); plan.push(Pp([[-1.0, yc], [xWat - 0.8, yc]], p.dnS), ...wkAccDraw("foot", xWat - 0.8 - Lf / 2, yc, p.dnS, 180)); if (!i) plan.push(Tx(xWat - 0.9 - Lf, yc + (p.dnS / 1000) * 0.7 + 0.18, t("wk_footValve"), 2, "r")); }   // valvola di fondo vista dall'alto (77.75)
    }
    if (p.panel) plan.push(R(Lp - 0.75, -0.05 + 0.15, 0.6, 0.35, "eq"), Ld([Lp - 0.3, 0.3], [Lp + 0.7, 0.75], t("wk_panel")));   // richiamo fuori dalla platea: la scritta non attraversa il collettore (78.29)
    plan.push(...cutT([[bank ? xWat - 1.4 : fld ? -2.7 : inl ? -4.0 : -1.8, mg + wu / 2], [Lp + 1.0, mg + wu / 2]], "B", 1));   // traccia della sezione B-B sulla prima pompa (78.29)
    plan.push(Dm([0, 0], [Lp, 0], -0.5), Dm([0, 0], [0, Wp], 0.5));
    if (n > 1) plan.push(Dm([Lp, mg + wu / 2], [Lp, mg + wu / 2 + wu + gap], -0.45, t("wk_pitch") + " " + fmtM(wu + gap)));   // fuori dalla platea, non sul collettore (78.29)
    view(t("wk_vPlan"), plan);
    // sezione su una pompa: platea, pompa, pescante in vasca con valvola di fondo, mandata con ritegno e saracinesca
    const lift = Math.max(0.5, +p.lift || 3), bed = -lift - p.canD, sec = [R(0, -H, Lp, H, "conc")];
    if (bank) sec.push(ground(xTop, Lp + 0.8, 0), Lg([[xTop, 0], [xTop - p.slope * (-bed), bed], [xTop - p.slope * (-bed) - 2.5, bed]], "k"), { t: "w", x0: xTop - p.slope * (-bed) - 2.5, x1: xWat, y: -lift }, Tx(xWat - 1.6, -lift + 0.25, t("wk_canal"), 2.4, "c"));
    else if (fld || inl) sec.push(ground(fld ? -1.2 : -3.4, Lp + 0.8, 0));
    else sec.push(ground(-2.6, Lp + 0.8, 0), { t: "w", x0: -2.6, x1: -0.3, y: -lift });
    const ha = wkSym.horiz(mg, 0.15, { can: p.moto ? wkCan(p) : null, dS: p.dnS, dD: p.dnD, Lp: p.hLp || lu * 0.4, hs: p.hHs || hu * 0.4, Lc: p.moto ? 0.08 : 0.12, Lm: p.mL || lu * 0.48, diesel: p.moto, Hd: Math.max(0.5, hu - 0.15) }), pcx = ha.del[0], pcy = ha.suc[1], hD = Math.max(hu, ha.top + 0.1);
    sec.push(wkPg([[mg, 0], [mg + Math.max(lu, ha.end - mg), 0], [mg + Math.max(lu, ha.end - mg), 0.15], [mg, 0.15]], 244, "a"), ...ha);   // pompa e motore come nella tavola del catalogo
    const dS = Math.max(0.15, p.dnS / 1000 * 1.6), cS = subQ(dS, (+p.Q || 0) / 3600 / Math.max(1, p.n || 1), 0, 0, 0.5);   // sommergenza della valvola di fondo (77.80)
    const hF = flQ(dS); let sucB = null;   // computo dell'aspirazione di una pompa (78.29): dalla presa alla bocca della pompa
    const dnI = p.dnI && p.dnI < p.dnS ? p.dnI : p.dnS, redI = dnI < p.dnS ? [{ k: "red", a: p.dnS, b: dnI, ecc: 1 }] : [];
    if (fld) { const batt = Math.max(0.3, +p.batt || 0.5), yW = pcy + batt, top = yW + 1.2;   // parete del reservoir, livello minimo sopra l'asse, griglia all'uscita
      sucB = [{ k: "piece", cat: "valv", sig: "wk_grid_" + p.dnS, desc: t("wk_bmGrid").replace("{dn}", p.dnS) }, ...wkBomPath([[-1.95, pcy], ha.suc], [{ k: "gate", x: -0.75, y: pcy }, { k: "flex", x: -0.35, y: pcy }], p.dnS), ...redI, { k: "end", dn: dnI }];
      if (rvE) { const yBot = Math.min(pcy - 0.6, -0.5), H0 = Math.max(top, 0.3), xToe = -1.2, xCo = xToe - 1.5 * H0, xCi = xCo - 1.0, xBt = xCi - 2 * (H0 - yBot), xWs = xCi - 2 * (H0 - yW), xG = Math.min(xWs - 0.6, xBt + 2 * (pcy - yBot) - 0.6);   // argine del bacino in terra: scarpa esterna 1,5:1, cresta 1 m, scarpa interna 2:1; la presa lo attraversa con la griglia in acqua
        sec.push(Lg([[xToe, 0], [xCo, H0], [xCi, H0], [xBt, yBot], [xBt - 1.5, yBot]], "k"), Pp([[xG, pcy], ha.suc], p.dnS), R(xG - 0.15, pcy - p.dnS / 1000 * 0.9, 0.15, p.dnS / 1000 * 1.8, "t"), Vv(-0.75, pcy, 0, "gate"),
          Ld([xG - 0.1, pcy + p.dnS / 1000], [xG - 0.9, pcy + 0.9], t("wk_grid")), Dm([xG - 0.6, pcy], [xG - 0.6, yW], 0, t("wk_batt") + " " + fmtM(batt)), Tx(xBt - 0.2, yW + 0.25, t("wk_reservoir") + " · " + t("wk_minLvl"), 2.2, "r"), { t: "w", x0: xBt - 1.5, x1: xWs, y: yW });
        sucB = [sucB[0], ...wkBomPath([[xG, pcy], ha.suc], [{ k: "gate", x: -0.75, y: pcy }, { k: "flex", x: -0.35, y: pcy }], p.dnS), ...redI, { k: "end", dn: dnI }];   // presa lunga quanto attraversa l'argine
        [xToe, xCo, xCi].forEach(xl => plan.push(Lg([[xl, -1.0], [xl, Wp + 1.0]], "k"))); plan.push(Lg([[xWs, -1.0], [xWs, Wp + 1.0]], "m"), Tx(xWs - 0.3, Wp + 0.7, t("wk_reservoir"), 2.6, "r"));   // in pianta: piede, cigli della cresta, specchio d'acqua
        for (let yw = -0.6; yw < Wp + 0.8; yw += 0.6) plan.push(Lg([[xToe, yw], [xToe - (Math.round(yw / 0.6) % 2 ? 0.9 : 0.5) * (xToe - xCo), yw]], "t"), Lg([[xCi, yw], [xCi - (Math.round(yw / 0.6) % 2 ? 0.9 : 0.5) * (xCi - xWs), yw]], "t"));   // tratteggio delle scarpate
        for (let i = 0; i < n; i++) { const yc = mg + i * (wu + gap) + wu / 2; plan.push(Pp([[-1.0, yc], [xG, yc]], p.dnS), R(xG - 0.15, yc - p.dnS / 1000 * 0.9, 0.15, p.dnS / 1000 * 1.8, "t")); } }
      else sec.push(R(-1.45, -0.3, 0.25, top + 0.3, "conc"), Lg([[-4.2, -0.3], [-1.45, -0.3]], "k"), Pp([[-1.95, pcy], ha.suc], p.dnS), R(-2.1, pcy - p.dnS / 1000 * 0.9, 0.15, p.dnS / 1000 * 1.8, "t"), Vv(-0.75, pcy, 0, "gate"),
        Ld([-2.05, pcy + p.dnS / 1000], [-3.0, pcy + 0.55], t("wk_grid")), Dm([-3.4, pcy], [-3.4, yW], 0, t("wk_batt") + " " + fmtM(batt)), Tx(-2.6, yW + 0.25, t("wk_reservoir") + " · " + t("wk_minLvl"), 2.2, "c"), { t: "w", x0: -4.2, x1: -1.45, y: yW });   // battente quotato nell'acqua, fuori dal muro (78.29)
      notes.push(t("wk_nFlooded").replace("{b}", fmtM(batt)));
    } else if (inl) { const yM = Math.max(0.35, pcy);   // collettore d'aspirazione dalla condotta a monte, manometro e pressostato di minima
      sucB = [{ k: "end", dn: p.dnS }, ...wkBomPath([[-1.6, yM], ha.suc], [{ k: "gate", x: -0.9, y: pcy }], p.dnS), ...redI, { k: "end", dn: dnI }];
      sec.push(Pp([[-3.4, yM], [-1.6, yM], ha.suc], p.dnS), Vv(-0.9, pcy, 0, "gate"), Vv(-2.6, yM, 0, "gate"), C(-1.6, yM + 0.45, 0.09, "k"), Lg([[-1.6, yM], [-1.6, yM + 0.36]], "k"), Ld([-1.55, yM + 0.5], [-2.3, yM + 1.25], t("wk_gaugeSw")),
        Tx(-3.4, yM + 0.3, t("wk_upLine").replace("{d}", wkPeOd(p, "C")).replace("{p}", String(wkR(+p.pIn || 0, 2)).replace(".", WK_DEC)), 2.1, "l"));
      notes.push(t("wk_nInline").replace("{p}", String(wkR(+p.pIn || 0, 2)).replace(".", WK_DEC)));
    } else if (bank) { const sl = Math.max(0.1, +p.slope || 1.5), yv = Math.max(bed + Math.max(0.5, hF) + 0.15, Math.min(-lift - 0.8, -lift - cS.S + 0.15)), dxv = Math.max(0.6, sl * (hF + 0.15) + 0.05), xv = xTop - sl * (-yv) - dxv, yM = yv - 0.15, gU = Math.max(bed, yv - dxv / sl);   // pescante lungo la scarpata: valvola di fondo almeno 0,8 m sotto il livello; staccata dalla scarpata quanto basta per l'altezza minima dal terreno sotto la bocca (77.89)
      const Lfv = wkAccL("foot", p.dnS), yTv = yM + Lfv, yK = yTv + 0.6, ex = xTop + 0.3 - xv, ey = 0.12 - yK, eL = Math.hypot(ex, ey) || 1;   // valvola di fondo disegnata con la succheruola, bocca a yM; il pescante scende lungo la scarpata e piega in verticale sulla valvola (77.90)
      const vit = [{ ...Pp([[xv + ex / eL * 0.55, yK + ey / eL * 0.55], [xv, yK], [xv, yTv]], p.dnS), noBeg: 1 }, ...wkAccDraw("foot", xv, yM + Lfv / 2, p.dnS, -90)];
      sucB = [{ k: "acc", a: "foot", dn: p.dnS }, ...wkBomPath([[xv, yTv], [xv, yK], [xTop + 0.3, 0.12], [xTop + 0.3, pcy], ha.suc], [], p.dnS), ...redI, { k: "end", dn: dnI }];   // pescante lungo la scarpata, uno per pompa
      sec.push(Pp([ha.suc, [xTop + 0.3, pcy], [xTop + 0.3, 0.12], [xv, yK], [xv, yTv]], p.dnS), ...vit.slice(1), Tx(xv - 0.35, yv - 0.1, "C", 3.4, "r"), R(xTop + 0.2, -0.3, 0.25, 0.3, "conc"));   // la presa quotata nel dettaglio C
      subN(t("wk_suction"), cS, -lift - yM); flN(t("wk_suction"), yM - gU, hF, dS);
      footDet({ xm: xv, yM, lvl: -lift, g: gU, gnd: [[[xTop, 0], [xTop - sl * (-bed), bed], [xTop - sl * (-bed) - 2.5, bed]]], wx1: xTop - sl * lift, vit, cS, hF, dS });
    } else { const yI = -lift - Math.max(1.0, cS.S), yFv = Math.min(bed, yI - hF), Lfv = wkAccL("foot", p.dnS);
      sucB = [{ k: "acc", a: "foot", dn: p.dnS }, ...wkBomPath([[-1.4, yI + Lfv], [-1.4, pcy], ha.suc], [], p.dnS), ...redI, { k: "end", dn: dnI }]; const vit = [{ ...Pp([[-1.4, -lift + 0.5], [-1.4, yI + Lfv]], p.dnS), noBeg: 1 }, ...wkAccDraw("foot", -1.4, yI + Lfv / 2, p.dnS, -90)];
      sec.push(Pp([ha.suc, [-1.4, pcy], [-1.4, yI + Lfv]], p.dnS), ...wkAccDraw("foot", -1.4, yI + Lfv / 2, p.dnS, -90), Tx(-1.75, yI + 0.1, "C", 3.4, "r"), Lg([[-2.6, yFv], [-0.3, yFv]], "k"));   // fondo della vasca sotto la valvola (77.89)
      subN(t("wk_suction"), cS, -lift - yI); flN(t("wk_suction"), yI - yFv, hF, dS);
      footDet({ xm: -1.4, yM: yI, lvl: -lift, g: yFv, gnd: [[[-3.1, yFv], [-0.3, yFv], [-0.3, -lift + 0.4]]], wx1: -0.3, vit, cS, hF, dS }); }
    const pthD = [ha.del, [pcx, hD + 0.35], [xc, hD + 0.35], [xc, -0.2]]; sec.push(Pp(pthD, p.dnD)); accL = p.acc || wkAccAlong(pthD, wkAccRec(p.kind), p.dnD, 0.05); wkAccPut(sec, pos, accL, t); bomL(pthD, p.dnD, p.n, p.dnO && p.dnO < p.dnD ? p.dnO : 0);   // accessori della mandata
    if (sucB) wkBomChain(BM, sucB, Math.max(1, Math.round(+p.n || 1)), t);
    // collettore di mandata (78.29): dal primo stacco al misuratore di portata, saracinesca, sfiato; poi scende e prosegue interrato
    wkBomChain(BM, [{ k: "end", dn: p.dnC }, { k: "pipe", dn: p.dnC, L: Math.max(0.5, Wp - 0.35 - mg - 0.15 + 0.6) }, { k: "acc", a: "gate", dn: p.dnC }, { k: "acc", a: "meter", dn: p.dnC }, { k: "tap", a: "air" }, { k: "pipe", dn: p.dnC, L: 0.5 }, { k: "elb", dn: p.dnC }, { k: "pipe", dn: p.dnC, L: 0.7 }, { k: "elb", dn: p.dnC }, { k: "pipe", dn: p.dnC, L: 1.0 }, { k: "end", dn: p.dnC }], 1, t);
    sec.push(Pp([[xc, -0.2], [xc, -0.9], [Lp + 0.8, -0.9]], p.dnC));
    if (!fld && !inl) sec.push(Dm([-0.2, 0], [-0.2, -lift], 0.3, t("wk_lift") + " " + fmtM(lift)));
    sec.push(Dm([0, -H], [Lp, -H], -0.35), Dm([Lp, -H], [Lp, 0], -0.3));
    view(t("wk_vSec") + " B-B", sec);
    const vc = Lp * Wp * H, lD = pthD.slice(0, 3).reduce((a, q, i, A) => i ? a + Math.hypot(q[0] - A[i - 1][0], q[1] - A[i - 1][1]) : 0, 0);
    const kgWh = Math.round(lD * wkPipeWater(p.dnD) + Math.PI / 4 * Math.pow(2 * p.dnS / 1000, 2) * (p.hLp || 0.4) * 0.5 * 1000), kgAh = Math.round(wkAccWet(accL));
    qty.push([t("wk_qConc"), m3(vc), "m³"], [t("wk_qLean"), m3((Lp + 0.2) * (Wp + 0.2) * 0.1), "m³"], [t("wk_qDig"), m3((Lp + 0.6) * (Wp + 0.6) * (H + 0.15)), "m³"], [t("wk_qSteel"), Math.round(vc * 70), "kg"], [t("wk_qPumps"), String(n), ""], [t("wk_qKgUnit"), p.kgU, "kg"], [t("wk_qWater"), kgWh, "kg"], [t("wk_qKgRun"), p.kgU + kgWh + kgAh, "kg"], [t("wk_qKgAll"), p.kgU * n, "kg"]);
    notes.push(t("wk_nRun").replace("{w}", kgWh).replace("{a}", kgAh));
    const nSt = t("wk_nStation"), nStC = nSt.split(/[;；]/);   // sotto battente e booster: niente pescante con valvola di fondo (78.29)
    notes.push(t("wk_nConc"), t("wk_nRebarSlab").replace("{s}", Math.round(H * 100)), fld || inl ? nStC.slice(0, -1).join(nSt.includes("；") ? "；" : ";") + (nSt.includes("；") ? "。" : ".") : nSt, t("wk_nAnchor"), t(p.moto ? "wk_nKerbM" : "wk_nPanel"));
    if (bank) notes.push(t("wk_nBank").replace("{h}", fmtM(lift + 0.2 + Math.min(0.34, hu * 0.25))).replace("{s}", fmtM(cS.S)).replace("{f}", fmtM(hF)));
    if (inl) { const dvB = WK_DN.find(d => d >= (p.dnC || 100)) || 500; BM.add("mach", "wk_bypass_" + dvB, t("wk_bmBypass").replace("{dn}", dvB), 1, "n°"); BM.add("mach", "wk_vessel", t("wk_vessel"), 1, "n°"); }
    if (p.kind === "horiz") notes.push(t(p.cat ? "wk_nCatH" : "wk_nNoCat").replace("{m}", p.model || "—"));
  }
  if (type === "reservoir") {   // RESERVOIR (78.18): pianta e sezione; bacino in terra col motore di Nereus (prismatoide, scavo e argine a bilancio di terra)
    const V = Math.max(10, +p.V || 0), Hw = Math.max(1, +p.H || 4), dI = p.dnIn || 150, dO = p.dnOut || 150, oI = wkPeOd({ ...p, dnIn: dI }, "In"), oO = wkPeOd({ ...p, dnOut: dO }, "Out"), rT = ["earth", "steel", "conc"].includes(p.rType) ? p.rType : "earth";
    if (rT === "earth") {
      const soil = NER_SOILS.find(x => x.key === p.soil) || NER_SOILS[1], K = nerK0({ V, H: Hw, r: 1.35, mi: soil.miMin, me: 2, c: 3, fb: 0.5, K: soil.K / 100 });
      if (K.ok) { const eff = p.mode !== "cut" && K.balanced, j = eff ? K.eff : K.cut, mi = K.mi, fb = K.fb, hs = j.hs, Hb = eff ? j.Hb : 0, yB = -hs, yW = Hw - hs, yC = eff ? Hb : 0;
        const inW = K.b1 + 2 * mi * (hs + yC), inL = K.b2 + 2 * mi * (hs + yC), outW = eff ? inW + 2 * K.c : inW, outL = eff ? inL + 2 * K.c : inL, toeW = eff ? outW + 2 * K.me * Hb : outW, toeL = eff ? outL + 2 * K.me * Hb : outL;
        const Rc = (w, l, s) => R(-w / 2, -l / 2, w, l, s);
        const plan = [Rc(toeW, toeL, "t"), Rc(outW, outL, "k"), Rc(inW, inL, "k"), Rc(K.wWat, K.lWat, "m"), Rc(K.b1, K.b2, "h")];
        plan.push(Pp([[-toeW / 2 - 3, inL / 4], [-inW / 2 + 1.2, inL / 4]], dI), Tx(-toeW / 2 - 3, inL / 4 + 0.9, t("wk_resIn").replace("{d}", oI), 2.6, "l"));
        plan.push(Pp([[K.b1 / 2 - 0.6, 0], [toeW / 2 + 3, 0]], dO), Vv(toeW / 2 + 1.5, 0, 0, "gate"), Tx(toeW / 2 + 3, 0.9, t("wk_resOut").replace("{d}", oO), 2.6, "r"));
        plan.push(Pp([[0, inL / 2 - 0.4], [0, toeL / 2 + 2.5]], Math.max(dI, 150)), Tx(0.6, toeL / 2 + 2, t("wk_overflow"), 2.4, "l"), Tx(0, 0, fmtM(K.b1) + " × " + fmtM(K.b2), 3, "c"), Tx(0, K.lWat / 2 - 1.2, t("wk_wLvl") + " " + fmtM(K.wWat) + " × " + fmtM(K.lWat), 2.4, "c"));
        plan.push(Dm([-toeW / 2, -toeL / 2], [toeW / 2, -toeL / 2], -2), Dm([-toeW / 2, -toeL / 2], [-toeW / 2, toeL / 2], 2), ...cutT([[-toeW / 2 - 4.6, -inL / 8], [toeW / 2 + 4.6, -inL / 8]], "A", 1, Math.max(1, toeW / 12)));   // traccia della sezione (78.29)
        view(t("wk_vPlan"), plan);
        const ex = Math.max(1, Math.min(5, Math.round(toeW / (4 * (hs + yC + 1))))), Y = (v) => v * ex, P = (pts) => pts.map(q => [q[0], Y(q[1])]), xs = (w) => w / 2, sec = [ground(-toeW / 2 - 4, toeW / 2 + 4, 0)];   // scala verticale esagerata come in Nereus
        const prof = eff ? [[-toeW / 2 - 4, 0], [-toeW / 2, 0], [-outW / 2, yC], [-inW / 2, yC], [-K.b1 / 2, yB], [K.b1 / 2, yB], [inW / 2, yC], [outW / 2, yC], [toeW / 2, 0], [toeW / 2 + 4, 0]]
          : [[-inW / 2 - 4, 0], [-inW / 2, 0], [-K.b1 / 2, yB], [K.b1 / 2, yB], [inW / 2, 0], [inW / 2 + 4, 0]];
        sec.push({ t: "w", x0: -K.wWat / 2, x1: K.wWat / 2, y: Y(yW) }, Lg(P(prof), "k"), Lg(P([[-inW / 2 - 1.5, yC - 0.5], [-inW / 2 - 1.5, yC], [-inW / 2, yC], [-K.b1 / 2, yB], [K.b1 / 2, yB], [inW / 2, yC], [inW / 2 + 1.5, yC], [inW / 2 + 1.5, yC - 0.5]]), "h"));
        // franco sulla cresta (non sulla scarpata); cresta quotata fra i suoi due cigli; argine fuori dal piede (78.29)
        sec.push(Dm([-K.b1 / 4, Y(yB)], [-K.b1 / 4, Y(yW)], 0, t("res_depth") + " " + fmtM(Hw)), Lg(P([[xs(K.wWat), yW], [inW / 2 + (eff ? K.c / 2 : 1.0), yW]]), "h"), Dm([inW / 2 + (eff ? K.c / 2 : 1.0), Y(yW)], [inW / 2 + (eff ? K.c / 2 : 1.0), Y(yC)], -0.3, t("wk_fb") + " " + fmtM(fb)), Dm([-K.b1 / 2, Y(yB)], [K.b1 / 2, Y(yB)], -0.6));
        if (eff) sec.push(Dm([inW / 2, Y(yC)], [outW / 2, Y(yC)], 0.6, t("wk_crest") + " " + fmtM(K.c)), Dm([toeW / 2 + 1.5, 0], [toeW / 2 + 1.5, Y(yC)], -0.4, t("res_bankH") + " " + fmtM(Hb)), Dm([-toeW / 2 - 1, 0], [-toeW / 2 - 1, Y(yB)], -0.4, t("res_digDepth") + " " + fmtM(hs)), Tx((outW / 2 + toeW / 2) / 2 + 0.6, Y(yC / 2) + 0.6, String(K.me).replace(".", WK_DEC) + ":1", 2.4, "l"));
        else sec.push(Dm([-inW / 2 - 1, 0], [-inW / 2 - 1, Y(yB)], -0.4, t("res_digDepth") + " " + fmtM(hs)));
        sec.push(Tx(-(K.b1 / 2 + inW / 2) / 2 - 1.5, Y((yB + yC) / 2), String(mi).replace(".", WK_DEC) + ":1", 2.4, "r"), Pp(P([[K.b1 / 2 - 0.6, yB + 0.3], [toeW / 2 + 4, yB + 0.3]]), dO));   // scarpa scritta come nelle note: orizzontale : verticale (78.29)
        view(t("wk_vSec") + " A-A" + (ex > 1 ? " · " + t("wk_vex").replace("{x}", ex) : ""), sec);
        const sl = Math.sqrt(1 + mi * mi), liner = Math.round(K.b1 * K.b2 + (K.b1 + K.b2 + inW + inL) * (hs + yC) * sl + 2 * (inW + inL) * 1.5);   // fondo + quattro scarpate trapezie fino alla cresta (base al fondo, lato in cima) + ancoraggio 1,5 m sul perimetro in cresta (78.29)
        qty.push([t("res_vol"), String(Math.round(V)), "m³"], [t("res_vDay"), String(p.Vday || "—"), "m³"], [t("res_dig"), String(Math.round(j.dig)), "m³"], [t("res_bankV"), String(Math.round(j.bank || 0)), "m³"], [t("wk_qAway"), String(Math.round(j.away || 0)), "m³"], [t("res_liner"), String(liner), "m²"], [t("res_area"), String(wkR(j.area / 1e4, 2)), "ha"]);
        notes.push(t("wk_nResEarth").replace("{m}", t(eff ? "res_eff" : "res_cut")).replace("{s}", t("res_soil_" + soil.key)), t("wk_nResInOut").replace("{q}", String(p.fillQ || "—").replace(".", WK_DEC)), t("wk_nResLiner"));
        if (p.mode !== "cut" && !K.balanced) notes.push(t("res_noBal"));
        BM.add("civ", "wk_res_dig", t("res_dig"), Math.round(j.dig), "m³"); if (j.bank > 0) BM.add("civ", "wk_res_bank", t("wk_bmResBank"), Math.round(j.bank), "m³"); BM.add("civ", "wk_res_liner", t("res_liner"), liner, "m²");
        BM.add("civ", "wk_res_geotex", t("wk_bmGeotex"), liner, "m²"); { const dv = WK_DN.find(d => d >= Math.max(dI, 150)) || 500; BM.add("valv", "wk_res_overflow_" + dv, t("wk_overflow") + " DN " + dv, 1, "n°"); }   // lo sfioro è un accessorio, non una macchina (78.29)
        wkBomChain(BM, [{ k: "end", dn: dO }, { k: "acc", a: "gate", dn: dO }, { k: "end", dn: dO }], 1, t);   // saracinesca d'uscita
      }
    } else if (rT === "steel") {
      const D = Math.ceil(Math.sqrt(4 * V / (Math.PI * Hw)) * 10) / 10, Ht = Hw + 0.3;
      view(t("wk_vPlan"), [...cutT([[-D / 2 - 3.6, -D / 8], [D / 2 + 3.6, -D / 8]], "A", 1, Math.max(1, D / 8)), C(0, 0, D / 2 + 0.5, "conc"), C(0, 0, D / 2, "k"), Pp([[-D / 2 - 3, D / 4], [-D / 2 + 0.6, D / 4]], dI), Tx(-D / 2 - 3, D / 4 + 0.6, t("wk_resIn").replace("{d}", oI), 2.4, "l"), Pp([[D / 2 - 0.3, 0], [D / 2 + 3, 0]], dO), Vv(D / 2 + 1.4, 0, 0, "gate"), Tx(D / 2 + 3, 0.6, t("wk_resOut").replace("{d}", oO), 2.4, "r"), Tx(0, 0, "Ø " + fmtM(D), 3, "c"), Dm([-D / 2, -D / 2 - 1], [D / 2, -D / 2 - 1], 0)]);
      view(t("wk_vSec") + " A-A", [ground(-D / 2 - 3, D / 2 + 3, 0), R(-D / 2 - 0.5, -0.25, D + 1, 0.25, "conc"), Lg([[-D / 2, 0], [-D / 2, Ht]], "k"), Lg([[D / 2, 0], [D / 2, Ht]], "k"), { t: "w", x0: -D / 2, x1: D / 2, y: Hw },
        Lg([[-D / 2 + 0.05, Ht], [-D / 2 + 0.05, 0.02], [D / 2 - 0.05, 0.02], [D / 2 - 0.05, Ht]], "h"), Pp([[-D / 2 - 2.5, Ht + 0.3], [-D / 2 + 0.6, Ht + 0.3], [-D / 2 + 0.6, Ht - 0.1]], dI), Pp([[D / 2 - 0.4, 0.35], [D / 2 + 2.5, 0.35]], dO),
        Dm([D / 2 + 0.6, 0], [D / 2 + 0.6, Hw], -0.4, t("res_depth") + " " + fmtM(Hw)), Dm([-D / 2, -0.6], [D / 2, -0.6], 0)]);
      const liner = Math.round(Math.PI * D * D / 4 + Math.PI * D * Ht), vSl = Math.PI * Math.pow(D / 2 + 0.5, 2) * 0.25;   // telo: fondo + parete (78.29)
      qty.push([t("res_vol"), String(Math.round(V)), "m³"], [t("res_vDay"), String(p.Vday || "—"), "m³"], [t("wk_qConc"), m3(vSl), "m³"], [t("wk_qSteel"), Math.round(vSl * 80), "kg"], [t("res_liner"), String(liner), "m²"]);
      notes.push(t("wk_nResSteel").replace("{d}", fmtM(D)).replace("{h}", fmtM(Ht)), t("wk_nResInOut").replace("{q}", String(p.fillQ || "—").replace(".", WK_DEC)), t("wk_nResLinerS"));   // serbatoio: niente scarpate
      BM.add("civ", "wk_res_liner", t("res_liner"), liner, "m²"); BM.add("civ", "wk_res_geotex", t("wk_bmGeotex"), liner, "m²"); BM.add("mach", "wk_res_tank_steel", t("wk_bmTankN").replace("{t}", t("res_steel")).replace("{d}", fmtM(D)).replace("{h}", fmtM(Ht)).replace("{v}", Math.round(V)), 1, "n°");   // il serbatoio è un pezzo, col suo volume nella descrizione
      BM.add("civ", "wk_res_slab", t("wk_qConc") + " · " + t("wk_bmResSlab"), m3(vSl), "m³"); BM.add("civ", "wk_res_steelbar", t("wk_qSteel") + " · " + t("wk_bmResSlab"), Math.round(vSl * 80), "kg"); wkBomChain(BM, [{ k: "end", dn: dO }, { k: "acc", a: "gate", dn: dO }, { k: "end", dn: dO }], 1, t);
    } else {
      const Wd = Math.ceil(Math.sqrt(V / (2 * Hw)) * 10) / 10, Ld = Math.ceil(V / (Hw * Wd) * 10) / 10, s = 0.3, Ht = Hw + 0.3;
      view(t("wk_vPlan"), [...cutT([[-Ld / 2 - s - 3.6, -Wd / 8], [Ld / 2 + s + 3.6, -Wd / 8]], "A", 1, Math.max(1, Ld / 10)), R(-Ld / 2 - s, -Wd / 2 - s, Ld + 2 * s, s, "conc"), R(-Ld / 2 - s, Wd / 2, Ld + 2 * s, s, "conc"), R(-Ld / 2 - s, -Wd / 2, s, Wd, "conc"), R(Ld / 2, -Wd / 2, s, Wd, "conc"), R(-Ld / 2, -Wd / 2, Ld, Wd, "k"), Pp([[-Ld / 2 - 3, Wd / 4], [-Ld / 2 + 0.6, Wd / 4]], dI), Tx(-Ld / 2 - 3, Wd / 4 + 0.6, t("wk_resIn").replace("{d}", oI), 2.4, "l"), Pp([[Ld / 2 - 0.3, 0], [Ld / 2 + 3, 0]], dO), Vv(Ld / 2 + 1.4, 0, 0, "gate"), Tx(Ld / 2 + 3, 0.6, t("wk_resOut").replace("{d}", oO), 2.4, "r"),
        Dm([-Ld / 2, -Wd / 2 - s - 0.8], [Ld / 2, -Wd / 2 - s - 0.8], 0), Dm([-Ld / 2 - s - 0.8, -Wd / 2], [-Ld / 2 - s - 0.8, Wd / 2], 0)]);
      view(t("wk_vSec") + " A-A", [ground(-Ld / 2 - 3, Ld / 2 + 3, 0), R(-Ld / 2 - s, -s, Ld + 2 * s, s, "conc"), R(-Ld / 2 - s, 0, s, Ht, "conc"), R(Ld / 2, 0, s, Ht, "conc"), { t: "w", x0: -Ld / 2, x1: Ld / 2, y: Hw },
        Pp([[-Ld / 2 - 2.5, Ht + 0.3], [-Ld / 2 + 0.6, Ht + 0.3], [-Ld / 2 + 0.6, Ht - 0.1]], dI), Pp([[Ld / 2 - 0.4, 0.35], [Ld / 2 + 2.5, 0.35]], dO), Dm([Ld / 2 + s + 0.6, 0], [Ld / 2 + s + 0.6, Hw], -0.4, t("res_depth") + " " + fmtM(Hw)), Dm([-Ld / 2, -0.8], [Ld / 2, -0.8], 0)]);
      const vc = (Ld + 2 * s) * (Wd + 2 * s) * s + 2 * (Ld + Wd + 2 * s) * Ht * s;
      qty.push([t("res_vol"), String(Math.round(V)), "m³"], [t("res_vDay"), String(p.Vday || "—"), "m³"], [t("wk_qConc"), m3(vc), "m³"], [t("wk_qSteel"), Math.round(vc * 90), "kg"]);
      notes.push(t("wk_nResConc").replace("{h}", fmtM(Ht)), t("wk_nResInOut").replace("{q}", String(p.fillQ || "—").replace(".", WK_DEC)), t("wk_nConc"));
      BM.add("civ", "wk_res_conc", t("wk_qConc"), m3(vc), "m³"); BM.add("civ", "wk_res_steelbar", t("wk_qSteel"), Math.round(vc * 90), "kg"); wkBomChain(BM, [{ k: "end", dn: dO }, { k: "acc", a: "gate", dn: dO }, { k: "end", dn: dO }], 1, t);
    }
  }
  if (type === "filter") {
    // BATTERIA DI FILTRI (da sola o nel gruppo completo con pompa e gruppo elettrogeno sulla stessa platea)
    const S = type === "set", fK = S ? p.fK : p.fK, n = Math.max(1, Math.round(S ? p.fn : p.n)), D = S ? p.fD : p.D, Hf = S ? p.fH : p.Hf, dn = S ? p.fdn : p.dn, dnC = p.dnC || wkDnOf((p.Q || 60) / 3.6), mg = p.marg || 0.6, H = p.H || 0.25;
    const hasF = S ? !!(+p.hasF) : true, hasG = S && !!(+p.hasG), hasP = S && p.hasP !== 0 && p.hasP !== "0";
    const pitch = fK === "screen" ? Math.max(0.9, D + 0.6) : D + Math.max(0.35, D * 0.4), Lf = fK === "screen" ? Hf + 0.8 : n * pitch + 0.6, Wf = fK === "screen" ? n * pitch + 0.4 : Math.max(D + 1.0, 1.4);
    const lu = hasP ? p.Lu : 0, wu = hasP ? p.Wu : 0, hu = hasP ? p.Hu : 0, gL = hasG ? p.Lg : 0, gW = hasG ? p.Wg : 0;
    const xG = mg, xP = mg + (hasG ? gL + 1.0 : 0), xF = xP + (hasP ? lu + 1.4 : 0), Lp = xF + (hasF ? Lf : 0) + mg, Wp = Math.max(hasF ? Wf : 0, wu, gW) + 2 * mg;
    // pianta
    const plan = [R(0, 0, Lp, Wp, "k"), R(0.1, 0.1, Lp - 0.2, Wp - 0.2, "h")], yc = Wp / 2;
    if (hasG) plan.push(R(xG, yc - gW / 2, gL, gW, "eq"), Tx(xG + gL / 2, yc - 0.05, "G", 3, "c"), Lg([[xG + gL, yc + gW * 0.3], [xP, yc + gW * 0.3]], "el"), Tx((xG + gL + xP) / 2, yc + gW * 0.3 + 0.15, t("wk_ducts"), 1.9, "c"));
    if (hasP) { plan.push(R(xP, yc - wu / 2, lu, wu, "eq"), C(xP + lu * 0.22, yc, Math.min(wu * 0.3, 0.3), "k"), Tx(xP + lu * 0.62, yc - 0.05, p.moto ? "MP" : "P", 3, "c"));
      plan.push(Pp([[xP + lu * 0.22, yc], [xP - (hasG ? 0.4 : 1.0), yc], [xP - (hasG ? 0.4 : 1.0), -0.9]], p.dnS), Pp([[xP + lu * 0.22, yc], [xP + lu * 0.22, yc + wu / 2 + 0.3], [hasF ? xF + 0.1 : Lp + 0.8, yc + wu / 2 + 0.3]], p.dnD), Tx(xP - 0.3, -0.75, t("wk_suction") + " DN " + p.dnS, 2, "l"));
      if (!hasF) plan.push(Tx(Lp + 0.85, yc + wu / 2 + 0.5, t("wk_delivery") + " DN " + p.dnD, 2, "l")); }
    if (hasF) {
      const yI = yc + Wf / 2 - 0.25, yO = yc - Wf / 2 + 0.25;
      if (fK === "screen") { for (let i = 0; i < n; i++) { const yy = yc - (n - 1) * pitch / 2 + i * pitch; plan.push(R(xF + 0.4, yy - D / 2, Hf, D, "eq"), Pp([[xF + 0.1, yy], [xF + 0.4, yy]], dn), Pp([[xF + 0.4 + Hf, yy], [xF + Lf - 0.1, yy]], dn)); }
        if (!hasP) plan.push(Pp([[-0.8, yc + (n - 1) * pitch / 2], [xF + 0.1, yc + (n - 1) * pitch / 2]], dnC), Tx(-0.75, yc + (n - 1) * pitch / 2 + 0.2, t("wk_fIn") + " DN " + dnC, 2, "l"));
        plan.push(Pp([[xF + 0.1, yc - (n - 1) * pitch / 2], [xF + 0.1, Math.max(yc + (n - 1) * pitch / 2, hasP ? yc + wu / 2 + 0.3 : 0)]], dnC), Pp([[xF + Lf - 0.1, yc + (n - 1) * pitch / 2], [xF + Lf - 0.1, yc - (n - 1) * pitch / 2], [Lp + 0.8, yc - (n - 1) * pitch / 2]], dnC)); }   // uscita verso est come nel prospetto (78.29)
      else { plan.push(Pp([[xF + 0.1, yI], [xF + Lf - 0.3, yI]], dnC), Pp([[xF + 0.3, yO], [xF + Lf + 0.2, yO], [Lp + 0.8, yO]], dnC));
        if (!hasP) plan.push(Pp([[-0.8, yI], [xF + 0.1, yI]], dnC), Tx(-0.75, yI + 0.2, t("wk_fIn") + " DN " + dnC, 2, "l"));
        for (let i = 0; i < n; i++) { const xx = xF + 0.3 + pitch / 2 + i * pitch; plan.push(C(xx, yc, D / 2, "eq"), Pp([[xx, yc + D / 2], [xx, yI]], dn), Pp([[xx, yc - D / 2], [xx, yO]], dn), Tx(xx, yc - 0.05, "F" + (i + 1), 2.4, "c")); }
        if (fK === "sand" || fK === "disc") plan.push(Lg([[xF + 0.3, yc + Wf / 2 - 0.05], [xF + Lf, yc + Wf / 2 - 0.05], [xF + Lf, Wp + 0.6]], "h"), Tx(xF + Lf + 0.1, Wp + 0.7, t("wk_backwash"), 2, "l")); }
      { const yX = fK === "screen" ? yc - (n - 1) * pitch / 2 : yO; plan.push(Ld([Lp + 0.55, yX], [Lp + 1.0, yX - 0.7], t("wk_fOut") + " DN " + dnC)); }   // richiamo sul tubo d'uscita (78.29)
    }
    plan.push(Dm([0, 0], [Lp, 0], -0.5), Dm([0, 0], [0, Wp], 0.5));
    view(t("wk_vPlan"), plan);
    // prospetto
    const el = [R(0, -H, Lp, H, "conc"), R(-0.1, -H - 0.1, Lp + 0.2, 0.1, "lean"), ground(-1.2, Lp + 1.2, 0)];
    let yOut = 0.5, xOutL = xF;
    if (hasG) { el.push(...wkSym.genset(xG, 0, gL, p.Hg, p.genK || "s")); el.push(Ld([xG + gL * 0.5, p.Hg * 0.6], [xG + gL * 0.3, p.Hg + 0.5], t("wk_t_gen").replace(/^[^ ]+ /, ""))); }
    if (hasP) { const ha = wkSym.horiz(xP, 0.12, { can: p.moto ? wkCan(p) : null, dS: p.dnS, dD: p.dnD, Lp: p.hLp || lu * 0.4, hs: p.hHs || hu * 0.4, Lc: p.moto ? 0.08 : 0.12, Lm: p.mL || lu * 0.48, diesel: p.moto, Hd: Math.max(0.5, hu - 0.12) });
      el.push(R(xP, 0, Math.max(lu, ha.end - xP), 0.12, "eq"), ...ha); const hD = Math.max(hu, ha.top + 0.1) + 0.35;
      const pth = [ha.del, [ha.del[0], hD], [hasF ? xF + 0.15 : Lp + 0.8, hD]]; el.push(Pp([ha.suc, [xP - 0.5, ha.suc[1]], [xP - 0.5, -H - 0.8]], p.dnS), Pp(pth, p.dnD));
      accL = p.acc || wkAccAlong(pth, ["flex", "check", "wafer", "gauge"], p.dnD, 0.04); wkAccPut(el, pos, accL, t); bomL(pth, p.dnD, 1); yOut = hD; }
    if (hasF) {
      const yb = 0.05, top = fK === "screen" ? 0.6 : Hf + 0.25, yIn = fK === "sand" || fK === "hydro" ? Hf + 0.3 : fK === "disc" ? 0.25 : 0.6, yO = fK === "sand" ? 0.3 : fK === "disc" ? 0.25 : fK === "hydro" ? Hf * 0.86 : 0.6;
      if (fK === "screen") { el.push(...wkSym.screenFilter(xF + 0.4, 0.6, Hf, D), R(xF + 0.4 + Hf * 0.3, 0, 0.08, 0.6 - D / 2, "k"), R(xF + 0.4 + Hf * 0.75, 0, 0.08, 0.6 - D / 2, "k")); el.push(Pp([[xF + 0.1, 0.6], [xF + 0.4, 0.6]], dn), Pp([[xF + 0.4 + Hf, 0.6], [xF + Lf + 0.3, 0.6], [Lp + 0.8, 0.6]], dnC)); }
      else {
        for (let i = 0; i < n; i++) { const xx = xF + 0.3 + pitch / 2 + i * pitch;
          if (fK === "sand") el.push(...wkSym.sandFilter(xx, yb, D, Hf), Pp([[xx, yb + Hf + 0.14], [xx, yIn]], dn), Vv(xx, yb + Hf + 0.2, 90, "gate"));
          else if (fK === "disc") el.push(Pp([[xx, yO], [xx, yO + 0.12]], dn), ...wkSym.discFilter(xx, yO + 0.12, D, Hf));
          else el.push(...wkSym.hydroFilter(xx, yb, D, Hf), Pp([[xx - D / 2 - 0.12, Hf * 0.86], [xx - D / 2 - 0.12, yIn]], dn));
          el.push(Tx(xx, (fK === "disc" ? yO + 0.12 + Hf : yb + Hf + 0.1) + (fK === "sand" ? 0.45 : 0.2), "F" + (i + 1), 2.2, "c")); }   // sigla appena sopra il suo filtro
        if (fK === "sand") el.push(Pp([[xF + 0.3, yO], [Lp + 0.8, yO]], dnC));
        else if (fK === "hydro") el.push(Pp([[xF + 0.3, yb + Hf + 0.1], [xF + Lf, yb + Hf + 0.1], [Lp + 0.8, yb + Hf + 0.1]], dnC));
        else el.push(Pp([[xF + 0.3, yO], [Lp + 0.8, yO]], dnC));
        if (fK !== "disc") el.push(Pp([[xF + 0.15, yIn], [xF + Lf - 0.15, yIn]], dnC)); }
      if (hasP) el.push(Pp([[xF + 0.15, yOut], [xF + 0.15, fK === "disc" ? 0.25 : yIn]], p.dnD));
      else if (fK !== "screen") el.push(Pp([[-0.8, fK === "disc" ? 0.25 : yIn], [xF + (fK === "disc" ? 0.3 : 0.15), fK === "disc" ? 0.25 : yIn]], dnC));
      else el.push(Pp([[-0.8, 0.6], [xF + 0.1, 0.6]], dnC));
      void top; void xOutL;
      const fTop = fK === "screen" ? 0.6 + D / 2 : fK === "disc" ? yO + 0.12 + Hf : yb + Hf, xLast = fK === "screen" ? xF + 0.4 + Hf : xF + 0.3 + pitch / 2 + (n - 1) * pitch;
      el.push(Ld([fK === "screen" ? xLast - 0.1 : xLast + D * 0.35, fK === "screen" ? 0.6 : fTop * 0.55], [xF + Lf + 0.5, Math.max(fTop, yOut) + 0.7], t("wk_filt_" + fK) + " · " + n + " × " + (S ? p.fsz : p.sz)));   // richiamo dall'ultimo filtro, fuori dalle sigle (78.29)
      el.push(Lg([[xLast, fTop], [xF + Lf + 0.35, fTop]], "t"), Dm([xF + Lf + 0.3, 0], [xF + Lf + 0.3, fTop], -0.3));   // altezza dei filtri dal piano della platea alla loro cima (78.29)
    }
    el.push(Dm([0, -H], [Lp, -H], -0.35), Dm([Lp, -H], [Lp, 0], -0.3));
    view(t("wk_vElev"), el);
    // quantità e pesi
    const vc = Lp * Wp * H, qU = S ? p.fq : p.qU, kgF = n * (S ? p.fkg : p.kgU), kgMed = n * (S ? p.fkgM : p.kgM);
    const vol1 = fK === "sand" ? Math.PI / 4 * D * D * Hf * 0.55 : fK === "screen" ? Math.PI / 4 * D * D * Hf * 0.6 : Math.PI / 4 * D * D * Hf * 0.45, kgWf = Math.round(n * vol1 * 1000 * (fK === "sand" ? 0.6 : 1));
    qty.push([t("wk_qConc"), m3(vc), "m³"], [t("wk_qLean"), m3((Lp + 0.2) * (Wp + 0.2) * 0.1), "m³"], [t("wk_qDig"), m3((Lp + 0.6) * (Wp + 0.6) * (H + 0.15)), "m³"], [t("wk_qSteel"), Math.round(vc * 70), "kg"]);   // scavo come nelle altre opere (78.29)
    if (hasF) qty.push([t("wk_filt_" + fK), n + " × " + (S ? p.fsz : p.sz), ""], [t("wk_qFq"), wkR(n * qU, 1) + " / " + wkR(p.Q, 1), "m³/h"], [kgMed ? t("wk_qKgFilt") : t("wk_qKgFilt").replace(/\s*[(（][^)）]*[)）]/, ""), kgF + (kgMed ? " + " + kgMed : ""), "kg"], [t("wk_qWater"), kgWf, "kg"]);
    if (hasP) qty.push([t(p.moto ? "wk_qMoto" : "wk_qKgUnit"), p.kgU, "kg"]);
    if (hasG) qty.push([t("wk_qKgGen"), p.kgG, "kg"]);
    const kgRun = (hasF ? kgF + kgMed + kgWf : 0) + (hasP ? p.kgU + Math.round(wkAccWet(accL)) : 0) + (hasG ? p.kgG : 0);
    qty.push([t("wk_qKgRunAll"), Math.round(kgRun), "kg"]);
    notes.push(t("wk_nConc"), t("wk_nRebarSlab").replace("{s}", Math.round(H * 100)));
    if (hasF) notes.push(t("wk_nFilt_" + fK).replace("{q}", qU).replace("{n}", n).replace("{s}", S ? p.fsz : p.sz), t("wk_nFiltCat"));
    if (S) notes.push(t("wk_nSet"));
  }
  if (type === "set" && p.pvX != null) {   // piazzola del pivot dal tipo e dal modello scelti (77.62): lato, interasse dei tirafondi, platea, plinti
    const pd = wkPadDefaults({ mk: p.pvMk, pp: p.pvPp, prof: p.pvProf, tube: p.pvT }), cart = pd.shape === "plinths";
    p = { ...p, pvL: cart ? pd.Bx + pd.F : pd.L, pvB: cart ? pd.By : pd.B, pvT: pd.tube, pvProf: pd.ultra && pd.pp === "fix" ? "ultra" : pd.prof, pvUltra: pd.ultra && pd.pp === "fix" ? 1 : 0, pvF: pd.F, pvHs: cart ? 0 : pd.Hs, pvPd: pd.Ht, pvCart: cart ? 1 : 0, pvBx: pd.Bx, pvBy: pd.By,
      pvHt: +p.pvHt || (pd.pp === "skid" ? 2.7 : cart ? 3.0 : pd.ultra ? 4.7 : pd.prof === "high" ? 4.2 : 3.7) };   // altezza della piramide: 3,7 m standard, 4,2 m alto, 4,7 m ultra alto (stima: +0,5 m come la luce libera), 2,7 m su slitte
  }
  if (type === "set") {
    // GRUPPO COMPLETO COMPOSTO A MANO (77.49–77.51): componenti (pompa elettrica, motopompa, batteria di filtri, gruppo elettrogeno, quadro) messi, trascinati e ruotati
    // sulla pianta, ognuno sul suo basamento; la piramide del pivot vicino sta ferma (si trascina anch'essa) e i componenti le si mettono attorno, anche attaccati;
    // le tubazioni sono sempre tratti dritti: filtri in fila uscita → ingresso, pompe sulla linea d'ingresso, la linea d'uscita passa per il centro della piramide
    const src = WK_SRC.includes(p.src) ? p.src : "canal", sucL = Math.max(0.3, +p.sucL || 3), dir = p.sIn === "direct" && ["canal", "river", "lake"].includes(src);
    const cSs = subQ(Math.max(0.15, (p.dnS || 100) / 1000 * 1.6), (+p.Q || 0) / 3600, 0, 0, 0.5);   // sommergenza della valvola di fondo (77.80): ANSI/HI 9.8 sulla bocca della succheruola, almeno 0,5 m   // 77.78: pescanti dritti nell'acqua, senza pozzetto
    let nSump = 0;
    const mb = 0.3, H = p.H || 0.3, comps = wkSetComps(p).map(c => ({ ...c, _ru: c.r == null, r: (((+(c.r != null ? c.r : (c.k === "pump" || c.k === "moto" || c.k === "vpump") ? 270 : 0) || 0) % 360) + 360) % 360 })) /* pompe (77.71): girate di 90° in senso orario, l'aspirazione assiale verso la fonte */, dnC = p.dnC || wkDnOf((p.Q || 60) / 3.6);
    const fp = comps.map(c => wkSetFoot(c.k, p));
    const nOf = (i) => comps.slice(0, i + 1).filter(c => c.k === comps[i].k).length;   // numerazione per tipo: G1, P1, F1… senza buchi (78.29)
    // POMPA VERTICALE NEL GRUPPO (77.91): ad asse lungo con motore elettrico esterno, sul pozzetto aperto (travi d'appoggio sul cordolo) o sul pozzo; corpo pompa alla sommergenza minima
    const pv = p.pv || wkDefaults("vpump", { stQ: (+p.Q || 60) / 3.6, lift: p.lift, stN: 1 }), vI = comps.map((c, i) => i).filter(i => comps[i].k === "vpump");
    const vpC = !vI.length ? null : (() => { const lift = Math.max(0.5, +p.lift || 2), D = pv.D || pv.bD || 0.3, asp = pv.vfA > 0 ? pv.vfA : (pv.suA || 0.25), aspD = pv.vfA > 0 ? pv.vfD : pv.suD, lsL = pv.lsL || 3;
      const cS = subQ(aspD || D, (+p.Q || 0) / 3600 / vI.length, pv.bA + asp, 0.3, Math.max(+pv.sub || 0, 2.5 * D)), Sreq = cS.S, Z = wkVpSump(p), wl = src === "well";
      const LcE = Math.max(1, H + lift + Sreq - pv.bA), kgDry = (pv.kgM || 0) + (pv.kgH || 0) + LcE / lsL * (pv.kgLs || 0) + (pv.kgB || 0) + (pv.kgA || 0) + (pv.kgT || 0) + (pv.vfA > 0 ? pv.kgVf || 0 : pv.kgSu || 0);
      const kgWet = wkColWater(pv.lsD || 0.15, LcE) + Math.PI / 4 * Math.pow(D * 0.9, 2) * pv.bA * 0.45 * 1000;
      const bmC = wl ? null : wkBeam(Z.Win, kgDry + kgWet, 1), bmF = Math.max(1, +p.bmF || 2), bm = bmC && bmF > 1 ? wkBeam(Z.Win, kgDry + kgWet, 1, Math.round(bmC.h * bmF - 1)) : bmC, hb = bm ? bm.h / 1000 : 0;   // travi alte bmF volte il calcolo
      const Lc = Math.max(1, Math.ceil((H + hb + lift + Sreq - pv.bA - asp) / 0.5 - 1e-6) * 0.5), nLs = Math.max(1, Math.ceil(Lc / lsL - 1e-6)), yt = H + hb - Lc, yb = yt - pv.bA, yI = yb - asp, S = -lift - yI;   // quote assolute: piastra di base a H + hb (travi sul cordolo a quota platea)
      const hFv = pv.vfA > 0 ? flQ(aspD || D) : 0, yF = yI - Math.max(+pv.floor || 0.5 * D, 0.3 * D, hFv);
      const bw = bm ? bm.b / 1000 : 0.12, yb0 = Math.max((pv.pL || 0.6) / 2 - bw / 2 - 0.02, D / 2 + 0.06 + bw / 2), vIn = (+p.Q || 0) / 3600 / vI.length / Math.max(0.05, Z.Win * (-lift - yF));   // travi a ± yb0 dall'asse, sotto i lati della piastra
      return { lift, D, asp, aspD, cS, Sreq, Z, wl, kgDry, kgWet, bm, bmC, bmF, hb, bw, yb0, vIn, nLs, Lc, yt, yb, yI, S, hFv, yF }; })();   // linea d'asse a passi di 0,5 m, come nella stazione (77.80)
    const ro = (r, v) => r === 90 ? [-v[1], v[0]] : r === 180 ? [-v[0], -v[1]] : r === 270 ? [v[1], -v[0]] : [v[0], v[1]];
    const W_ = (i, v) => { const q = ro(comps[i].r, v); return [comps[i].x + q[0], comps[i].y + q[1]]; };   // punto locale del componente → pianta
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1], sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
    // TESTA DELLA VERTICALE (77.98): la mandata parte nella direzione u della testa (hr, gradi in pianta: 0 est, 90 nord; senza hr verso la meta) e arriva alla meta a L
    const vpU = (c, B, T) => { if (c.hr != null && isFinite(+c.hr)) return [[1, 0], [0, 1], [-1, 0], [0, -1]][Math.round((((+c.hr % 360) + 360) % 360) / 90) % 4]; const v = [T[0] - B[0], T[1] - B[1]]; return Math.abs(v[0]) >= Math.abs(v[1]) ? [Math.sign(v[0]) || 1, 0] : [0, Math.sign(v[1]) || 1]; };
    const vpRoute = (B, T, u, c) => { const n = [-u[1], u[0]], v = [T[0] - B[0], T[1] - B[1]], dp = v[0] * u[0] + v[1] * u[1], dn = v[0] * n[0] + v[1] * n[1], add = (a, s, w) => [a[0] + w[0] * s, a[1] + w[1] * s];
      const wv = c && src !== "well" ? ro(c.r, [1, 0]) : null;   // dall'asse della pompa verso l'acqua (il pozzetto si allunga da quella parte)
      if (wv && u[0] * wv[0] + u[1] * wv[1] > 0.7) { const z = wkVpSump(p), sg = Math.sign(dn) || (landV && (landV[0] * n[0] + landV[1] * n[1]) < 0 ? -1 : 1), P1 = add(B, 0.5, u), P2 = add(P1, sg * Math.max(z.Win / 2 + 0.8, 2.2), n), P3 = add(P2, (T[0] - P2[0]) * u[0] + (T[1] - P2[1]) * u[1], u);
        return [B, P1, P2, P3, T].filter((q, k, A) => !k || Math.hypot(q[0] - A[k - 1][0], q[1] - A[k - 1][1]) > 0.05); }   // testa verso l'acqua (78.07): niente tubo sopra pozzetto e canale
      if (Math.abs(dn) < 0.05 && dp > 0) return [B, T]; if (dp > 0.6) return [B, add(B, dp, u), T]; const P1 = add(B, 2.2, u); return [B, P1, add(P1, dn, n), T]; };   // dritta, a L, o a U se la meta sta dietro la testa
    const Bp = (i) => comps[i].k === "vpump" ? W_(i, [src === "well" ? 0 : wkVpSump(p).xa, 0]) : W_(i, [(comps[i]._sd || 1) * fp[i].L * 0.28, 0]);   // da dove parte la mandata in pianta: risalita dal corpo pompa, o asse della verticale
    const fI = comps.map((c, i) => i).filter(i => comps[i].k === "filter").sort((a, b) => comps[a].x - comps[b].x), pI = comps.map((c, i) => i).filter(i => comps[i].k === "pump" || comps[i].k === "moto" || comps[i].k === "vpump");
    const fInL = (i) => [-fp[i].L / 2, fp[i].W / 2 - 0.25], fInR = (i) => [fp[i].L / 2 - 0.15, fp[i].W / 2 - 0.25], fOut = (i) => [fp[i].L / 2, -fp[i].W / 2 + 0.25];
    // piramide del pivot vicino: posizione vera rispetto al punto sulla mappa (centro della disposizione proposta), o dove è stata trascinata (ppX/ppY)
    const Lv = p.pvL || 4.25; let PV = null;
    if (p.pvX != null && isFinite(+p.pvX)) { if (p.ppX != null && isFinite(+p.ppX)) PV = [+p.ppX, +p.ppY];
      else { const d0 = wkSetComps({ ...p, lay: null }); let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        d0.forEach(c => { const f = wkSetFoot(c.k, p); a0 = Math.min(a0, c.x - f.L / 2); a1 = Math.max(a1, c.x + f.L / 2); b0 = Math.min(b0, c.y - f.W / 2); b1 = Math.max(b1, c.y + f.W / 2); });
        if (!d0.length) { a0 = 0; a1 = 2; b0 = 0; b1 = 1.5; }
        PV = [wkR((a0 + a1) / 2 + +p.pvX, 2), wkR((b0 + b1) / 2 + +p.pvY, 2)]; } }
    // l'ultima batteria (o la pompa, senza filtri) si gira da sola verso la piramide finché non la si ruota a mano: si mettono sopra, sotto, a destra o a sinistra
    { const lf = fI.length ? fI[fI.length - 1] : pI.length ? pI[0] : null;
      if (PV && lf != null && comps[lf]._ru) { const v = sub(PV, [comps[lf].x, comps[lf].y]);
        if (comps[lf].k === "filter") comps[lf].r = [0, 90, 180, 270].reduce((b, r) => dot(ro(r, [1, 0]), v) > dot(ro(b, [1, 0]), v) ? r : b, 0);
        } }   // la pompa resta con l'aspirazione verso la fonte
    const fr = comps.map((c, i) => c.r % 180 ? { L: fp[i].W, W: fp[i].L } : fp[i]);
    // filtri in fila: l'ingresso della batteria successiva sull'asse dell'uscita della precedente
    for (let j = 1; j < fI.length; j++) { const a = fI[j - 1], b = fI[j], Po = W_(a, fOut(a)), dO = ro(comps[a].r, [1, 0]), o = ro(comps[b].r, fInL(b));
      if (Math.abs(dO[0]) > 0.5) comps[b].y = wkR(Po[1] - o[1], 3); else comps[b].x = wkR(Po[0] - o[0], 3); }
    // pompe: il corpo sulla linea del collettore d'ingresso (dalla parte in cui stanno), mandata dritta fino al collettore
    pI.forEach(i => { const c = comps[i], f = fp[i];
      let tg = null, ax = null;
      if (fI.length) { const f0 = fI[0]; ax = ro(comps[f0].r, [1, 0]); const s = dot(sub([c.x, c.y], [comps[f0].x, comps[f0].y]), ax); c._fs = s > fp[f0].L / 2 ? 1 : -1;   // ingresso dal capo d'inizio, dall'altro capo solo se la pompa sta oltre la batteria
        tg = W_(f0, c._fs > 0 ? fInR(f0) : fInL(f0));
        // fuori dall'ingombro della batteria, lungo la linea
        const cr = c.r % 180 ? { L: f.W, W: f.L } : f, ha = Math.abs(ax[0]) * cr.L / 2 + Math.abs(ax[1]) * cr.W / 2, need = fp[f0].L / 2 + ha + (c.k === "vpump" ? 2.2 : 0.4);   // la verticale lascia il posto agli accessori della mandata
        if (c._fs * s < need) { const mv = c._fs * need - s; c.x += ax[0] * mv; c.y += ax[1] * mv; } }
      c._sd = 1;   // corpo pompa dalla parte del naso (aspirazione assiale); la mandata parte dal corpo verso il collettore
      if (tg) { const nrm = [-ax[1], ax[0]], b0 = Bp(i), d = dot(sub(b0, tg), nrm); c.x -= nrm[0] * d; c.y -= nrm[1] * d; }
      c.x = wkR(c.x, 3); c.y = wkR(c.y, 3); c._tg = tg; });
    // la linea d'uscita passa per il centro delle gambe: filtri e pompe si spostano insieme di traverso
    const lastF = fI.length ? fI[fI.length - 1] : null, p0 = pI.length ? pI[0] : null;
    const outP = () => lastF != null ? W_(lastF, fOut(lastF)) : p0 != null ? Bp(p0) : null;
    const dOut = lastF != null ? ro(comps[lastF].r, [1, 0]) : p0 != null ? (() => { const v = PV ? sub(PV, Bp(p0)) : [1, 0]; return Math.abs(v[0]) >= Math.abs(v[1]) ? [Math.sign(v[0]) || 1, 0] : [0, Math.sign(v[1]) || 1]; })() : [1, 0];
    if (PV && outP() && !(lastF == null && p0 != null && comps[p0].k === "vpump")) { const n = [-dOut[1], dOut[0]], d = dot(sub(PV, outP()), n); fI.concat(pI).forEach(i => { comps[i].x = wkR(comps[i].x + n[0] * d, 3); comps[i].y = wkR(comps[i].y + n[1] * d, 3); if (comps[i]._tg) comps[i]._tg = [comps[i]._tg[0] + n[0] * d, comps[i]._tg[1] + n[1] * d]; }); }
    // ASPIRAZIONE LIBERA (77.73): il tubo dritto d'aspirazione e il pozzetto non passano sopra un altro basamento o sulla piazzola del pivot; altrimenti la pompa si gira sul primo lato libero
    if (src !== "net") comps.forEach((c, i) => { if (c.k !== "pump" && c.k !== "moto") return;
      const free = (r) => { const d = ro(r, [1, 0]), nv = [-d[1], d[0]], L0 = fp[i].L / 2 + mb, L1 = L0 + sucL + 1.6;
        const cs = [[L0, -0.8], [L1, -0.8], [L1, 0.8], [L0, 0.8]].map(([u, v]) => [c.x + d[0] * u + nv[0] * v, c.y + d[1] * u + nv[1] * v]), X0 = Math.min(...cs.map(q => q[0])), X1 = Math.max(...cs.map(q => q[0])), Y0 = Math.min(...cs.map(q => q[1])), Y1 = Math.max(...cs.map(q => q[1]));
        const hit = (cx, cy, hx, hy) => X0 < cx + hx && X1 > cx - hx && Y0 < cy + hy && Y1 > cy - hy;
        return !comps.some((q, j) => j !== i && hit(q.x, q.y, fr[j].L / 2 + mb, fr[j].W / 2 + mb)) && !(PV && hit(PV[0], PV[1], Lv / 2, Lv / 2)); };
      if (free(c.r)) return; const r2 = [270, 90, 180, 0].filter(a => a !== c.r).find(free); if (r2 != null) { c.r = r2; fr[i] = c.r % 180 ? { L: fp[i].W, W: fp[i].L } : fp[i]; } });
    // FUORI DAL CANALE (77.93): i basamenti che cadono sul canale (o sul fiume) si spostano dalla parte della terra; la pompa e il pozzetto restano dove sono
    let landV = null;   // dalla riva verso la terra: chi si sposta va da questa parte
    if (pI.length && (src === "canal" || src === "river")) { const i0 = pI[0], c0 = comps[i0], s0 = ro(c0.r, [1, 0]), nn = [-s0[1], s0[0]], w = src === "river" ? 4 : 2;
      const E0 = W_(i0, c0.k === "vpump" ? [fp[i0].L / 2, 0] : [fp[i0].L / 2 + mb + sucL, 0]), cA = ((+(p.cnA != null ? p.cnA : (+p.srcTip ? 90 : 0)) % 180) + 180) % 180, an = cA * Math.PI / 180;
      const ax = [nn[0] * Math.cos(an) + s0[0] * Math.sin(an), nn[1] * Math.cos(an) + s0[1] * Math.sin(an)], tip = Math.abs(dot(ax, s0)) > 0.99, nA = [-ax[1], ax[0]];
      let C0 = p.cnX != null && isFinite(+p.cnX) ? [+p.cnX, +p.cnY] : [E0[0] + s0[0] * (w / 2), E0[1] + s0[1] * (w / 2)];
      if (tip) { const u = dot(sub(C0, E0), nn); C0 = [C0[0] - nn[0] * u, C0[1] - nn[1] * u]; }
      const land = Math.sign(dot(sub([c0.x, c0.y], C0), nA)) || 1, sg = dot(ax, s0) > 0 ? 1 : -1; landV = tip ? [-s0[0], -s0[1]] : [nA[0] * land, nA[1] * land];
      comps.forEach((c, i) => { if (pI.includes(i)) return; const hx = fr[i].L / 2 + mb, hy = fr[i].W / 2 + mb, ext = Math.abs(nA[0]) * hx + Math.abs(nA[1]) * hy, extA = Math.abs(ax[0]) * hx + Math.abs(ax[1]) * hy, q = sub([c.x, c.y], C0), v = dot(q, nA), u = dot(q, ax);
        if (tip && sg * u + extA < 0.1) return; const need = w / 2 + 0.4 + ext; if (Math.abs(v) >= need) return;
        const tgt = (tip ? (Math.sign(v) || land) : land) * need, mv = tgt - v; c.x = wkR(c.x + nA[0] * mv, 3); c.y = wkR(c.y + nA[1] * mv, 3); c.mv = c.mv || 1; }); }
    // MANDATA LIBERA (77.93): gruppo elettrogeno e quadro non stanno sul tubo di mandata (dritto per le pompe, a L per la verticale); si spostano di lato, verso la terra
    pI.forEach(i => { const c = comps[i]; if (c.k !== "vpump") return; const T = c._tg || (PV && i === pI[0] ? PV : null); if (!T) return; const B = Bp(i), u = vpU(c, B, T), n = [-u[1], u[0]], dn = (T[0] - B[0]) * n[0] + (T[1] - B[1]) * n[1];   // verticale quasi in linea con la meta (77.97): si mette in linea, così la mandata è dritta
      if (Math.abs(dn) < 0.5 && Math.abs(dn) > 1e-3) { c.x = wkR(c.x + n[0] * dn, 3); c.y = wkR(c.y + n[1] * dn, 3); } });
    pI.forEach(i => { const c = comps[i], B = Bp(i), T = c._tg || (PV && i === pI[0] ? PV : null); if (!T) return; const segs = [];
      if (c.k === "vpump") { const q = vpRoute(B, T, vpU(c, B, T), c); for (let k = 1; k < q.length; k++) segs.push([q[k - 1], q[k]]); } else segs.push([B, T]);
      const r = Math.max(0.05, (p.dnD || 100) / 1000 * 1.1) / 2 + 0.25;
      segs.forEach(([a, b]) => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.05) return; const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [-u[1], u[0]];
        comps.forEach((q, k) => { if (q.k !== "gen" && q.k !== "panel") return; const hx = fr[k].L / 2 + mb, hy = fr[k].W / 2 + mb, eU = Math.abs(u[0]) * hx + Math.abs(u[1]) * hy, eN = Math.abs(n[0]) * hx + Math.abs(n[1]) * hy, v = sub([q.x, q.y], a), tt = dot(v, u), dd = dot(v, n);
          if (tt < -eU || tt > L + eU) return; const need = eN + r; if (Math.abs(dd) >= need) return;
          let sgn = Math.sign(dd) || 1; if (landV && dot(n, landV) * sgn < -1e-6) sgn = -sgn;   // mai verso il canale
          const mv = sgn * need - dd; q.x = wkR(q.x + n[0] * mv, 3); q.y = wkR(q.y + n[1] * mv, 3); q.mv = q.mv || 1; }); }); });
    // NIENTE SOVRAPPOSIZIONI (77.72): basamenti (macchina + margine) staccati di 30 cm fra loro e di 20 cm dalla piazzola del pivot; si sposta l'ultimo trascinato (mv), altrimenti quello che viene dopo
    { const sep = 0.3, bx = (i) => ({ x: comps[i].x, y: comps[i].y, hx: fr[i].L / 2 + mb, hy: fr[i].W / 2 + mb });
      for (let it = 0; it < 80; it++) { let moved = false;
        for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) { const a = bx(i), b = bx(j), ox = a.hx + b.hx + sep - Math.abs(a.x - b.x), oy = a.hy + b.hy + sep - Math.abs(a.y - b.y); if (ox <= 1e-3 || oy <= 1e-3) continue;
          const m = (+comps[i].mv || 0) > (+comps[j].mv || 0) ? i : j, q = comps[m === j ? i : j], c = comps[m];
          if (ox < oy) c.x = wkR(c.x + (c.x > q.x || (c.x === q.x && m === j) ? ox : -ox), 3); else c.y = wkR(c.y + (c.y > q.y || (c.y === q.y && m === j) ? oy : -oy), 3); moved = true; }
        if (PV) comps.forEach((c, i) => { const b = bx(i), h = Lv / 2, ox = h + b.hx + 0.2 - Math.abs(b.x - PV[0]), oy = h + b.hy + 0.2 - Math.abs(b.y - PV[1]); if (ox <= 1e-3 || oy <= 1e-3) return;
          if (ox < oy) c.x = wkR(c.x + (c.x >= PV[0] ? ox : -ox), 3); else c.y = wkR(c.y + (c.y >= PV[1] ? oy : -oy), 3); moved = true; });
        if (!moved) break; } }
    layL = comps.map(c => ({ k: c.k, x: c.x, y: c.y, ...(c.hr != null ? { hr: c.hr } : {}), ...(c.mv ? { mv: c.mv } : {}), ...(!c._ru ? { r: c.r } : c.r ? { ra: c.r } : {}) }));   // r: ruotato a mano · ra: girato da solo verso la piramide
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    comps.forEach((c, i) => { const f = fr[i]; x0 = Math.min(x0, c.x - f.L / 2 - mb); x1 = Math.max(x1, c.x + f.L / 2 + mb); y0 = Math.min(y0, c.y - f.W / 2 - mb); y1 = Math.max(y1, c.y + f.W / 2 + mb); });
    if (!comps.length) { x0 = 0; x1 = 2; y0 = 0; y1 = 1.5; }
    const sx0 = x0, sx1 = x1, sy0 = y0, sy1 = y1;
    let q0 = Infinity, q1 = -Infinity, w0 = Infinity, w1 = -Infinity; comps.forEach((c, i) => { if (c.k === "vpump") return; const f = fr[i]; q0 = Math.min(q0, c.x - f.L / 2 - mb); q1 = Math.max(q1, c.x + f.L / 2 + mb); w0 = Math.min(w0, c.y - f.W / 2 - mb); w1 = Math.max(w1, c.y + f.W / 2 + mb); });
    if (!isFinite(q0)) { q0 = x0; q1 = x1; w0 = y0; w1 = y1; }   // la platea unica non copre il pozzetto della pompa verticale
    const plan = [];
    const Pout = outP(); let outPL = 0;
    const clear = Pout ? Math.max(...[[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(q => dot(sub(q, Pout), dOut))) : 0;
    let piv = null;
    if (PV) { const [px, py] = PV, dd = Math.hypot(Math.max(x0 - px + Lv / 2, 0, px - Lv / 2 - x1), Math.max(y0 - py + Lv / 2, 0, py - Lv / 2 - y1));
      piv = [px, py, Lv]; pos.pp = [px, py];
      const pyr = pyrTop(px, py, Lv, p.pvCart ? p.pvBx : p.pvB || Lv * 0.8, p.pvT, t("wk_pivPt").replace("{p}", p.pvLab || "") + " · " + t("wk_pivAt").replace("{d}", fmtM(dd)), p.pvF, p.pvCart ? p.pvBy : null);
      // quadro elettrico del pivot: su uno dei quattro lati della piramide o a bordo campo (cavo interrato dal centro)
      const pk = ["n", "e", "s", "w", "edge"].includes(p.pvPan) ? p.pvPan : "s", h = Lv / 2;
      if (pk === "s" && pyr.length && pyr[pyr.length - 1].t === "x") pyr[pyr.length - 1] = { ...pyr[pyr.length - 1], y: pyr[pyr.length - 1].y - 1.0 };   // scritta del perno sotto il quadro
      if (pk === "edge") { const gc = comps.length ? [comps.reduce((m, c) => m + c.x, 0) / comps.length, comps.reduce((m, c) => m + c.y, 0) / comps.length] : [px - 1, py];
        let dv = sub([px, py], gc); const dl = Math.hypot(dv[0], dv[1]) || 1; dv = [dv[0] / dl, dv[1] / dl]; const e = [px + dv[0] * (h + 1.6), py + dv[1] * (h + 1.6)], q = [-dv[1] * 0.25, dv[0] * 0.25];
        pyr.push(Lg([[px, py], e], "el"), Lg([[e[0] - q[0] - dv[0] * 0.15, e[1] - q[1] - dv[1] * 0.15], [e[0] + q[0] + dv[0] * 0.15, e[1] + q[1] + dv[1] * 0.15]], "k"), ...String(t("wk_pvPanEdge")).split(" · ").map((ln, li) => Tx(e[0] + dv[0] * 0.4, e[1] + dv[1] * 0.4 - 0.1 - li * 0.45, ln, 2.2, dv[0] >= 0 ? "l" : "r"))); piv[3] = e; }   // su due righe: la pianta resta compatta
      else { const d = { n: [0, 1], s: [0, -1], e: [1, 0], w: [-1, 0] }[pk], cx = px + d[0] * (h + 0.35), cy = py + d[1] * (h + 0.35), L2 = d[0] ? 0.4 : 0.8, W2 = d[0] ? 0.8 : 0.4;
        pyr.push(R(cx - L2 / 2, cy - W2 / 2, L2, W2, "eq"), Tx(cx + (d[0] ? d[0] * 0.5 : 0), cy + (d[1] ? d[1] * 0.45 : 0) - 0.1, "QP", 2.2, d[0] > 0 ? "l" : d[0] < 0 ? "r" : "c"), Lg([[px, py], [cx - d[0] * L2 / 2, cy - d[1] * W2 / 2]], "el")); piv[3] = [cx, cy]; }
      plan.push(...pyr.map(it => ({ ...it, g: "pp" }))); }
    const filters = fI.map(i => ({ c: comps[i], i })), pumps = pI.map(i => ({ c: comps[i], i }));
    // basamento (77.50): separati per componente, unico per il gruppo, o unico insieme alla piazzola della piramide
    const slabK = p.slab === "one" || (p.slab === "piv" && !piv) ? "one" : p.slab === "piv" ? "piv" : "sep";
    let SL = null;
    if (slabK !== "sep") { SL = [q0 - 0.3, w0 - 0.3, q1 + 0.3, w1 + 0.3];
      if (slabK === "piv") { const h = piv[2] / 2 + 0.3; SL = [Math.min(SL[0], piv[0] - h), Math.min(SL[1], piv[1] - h), Math.max(SL[2], piv[0] + h), Math.max(SL[3], piv[1] + h)]; }
      plan.unshift({ ...R(SL[0], SL[1], SL[2] - SL[0], SL[3] - SL[1], "k"), sl: 1 }, { ...R(SL[0] + 0.1, SL[1] + 0.1, SL[2] - SL[0] - 0.2, SL[3] - SL[1] - 0.2, "h"), sl: 1 }); }
    const G = (g, arr) => arr.map(it => ({ ...it, g }));
    const TR = (i, it) => { const P = (q) => W_(i, q);   // elemento disegnato in coordinate del componente → pianta (rotazioni di 90°)
      if (it.t === "r") { const a = P([it.x, it.y]), b = P([it.x + it.w, it.y + it.h]); return { ...it, x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) }; }
      if (it.t === "c" || it.t === "x") { const a = P([it.x, it.y]); return { ...it, x: a[0], y: a[1] }; }
      if (it.pts) return { ...it, pts: it.pts.map(P) }; return it; };
    comps.forEach((c, i) => { const f = fp[i], g = "c" + i, hl = f.L / 2, hw = f.W / 2; pos[g] = [c.x, c.y]; const it = [];
      if (slabK === "sep" && c.k !== "vpump") it.push({ ...R(-hl - mb, -hw - mb, f.L + 2 * mb, f.W + 2 * mb, "k"), sl: 1 });   // basamento del componente (non nella pianta per disporre)
      // PIANTA CON IL DETTAGLIO DEL PROSPETTO (77.70): le macchine viste dall'alto con le misure dei cataloghi
      if (c.k === "gen") { const gr = Math.min(0.28, f.L * 0.14), ex = -hl + gr + 0.3;   // cofanatura: griglia del radiatore in testa, scarico e golfare sul tetto, porte, tappo del serbatoio
        it.push(wkPg([[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]], 244, "a"), R(-hl + 0.04, -hw + 0.04, f.L - 0.08, f.W - 0.08, "a"));
        for (let x = hl - gr; x < hl - 0.03; x += 0.045) it.push(Lg([[x, -hw + 0.08], [x, hw - 0.08]], "a"));   // griglia del radiatore
        [-0.35, 0.05].forEach(fx => it.push(Lg([[-hl + f.L * (0.5 + fx), -hw + 0.04], [-hl + f.L * (0.5 + fx), hw - 0.04]], "a")));   // porte d'ispezione
        it.push(C(ex, hw * 0.45, 0.07, "a"), C(ex, hw * 0.45, 0.04, "a"), R(-0.08, -0.05, 0.16, 0.1, "a"), C(-hl + 0.18, -hw + 0.14, 0.035, "a"), Tx(-hl * 0.45, -hw - 0.2, "G" + nOf(i), 2.2, "c")); }
      else if (c.k === "panel") it.push(wkPg([[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]], 244, "a"), R(-hl + 0.05, -hw + 0.05, f.L - 0.1, f.W - 0.1, "a"), Lg([[0, -hw + 0.05], [0, hw - 0.05]], "a"), Tx(0, -0.05, "QE", 2.2, "c"));
      else if (c.k === "filter") { const n = Math.max(1, Math.round(p.fn)), pt = f.L / n, rF = Math.min(p.fD / 2, pt * 0.42), yI = hw - 0.25, yO = -hw + 0.25, odF = Math.max(0.05, (p.fdn || 100) / 1000 * 1.1);
        it.push(R(-hl, -hw, f.L, f.W, "h"));   // telaio della batteria
        for (let j = 0; j < n; j++) { const xx = -hl + pt * (j + 0.5);   // serbatoio dall'alto: fasciame, testa con il passo d'uomo, sfiato; attacchi al collettore d'ingresso (con la valvola a tre vie) e d'uscita
          it.push(Pp([[xx, rF * 0.7], [xx, yI]], p.fdn || 100), Pp([[xx, -rF * 0.7], [xx, yO]], p.fdn || 100));
          it.push(wkPg([[xx - odF * 0.9, (rF + yI) / 2 - odF * 0.7], [xx + odF * 0.9, (rF + yI) / 2 - odF * 0.7], [xx + odF * 0.9, (rF + yI) / 2 + odF * 0.7], [xx - odF * 0.9, (rF + yI) / 2 + odF * 0.7]], 255, "a"), Lg([[xx - odF * 0.9, (rF + yI) / 2 - odF * 0.7], [xx + odF * 0.9, (rF + yI) / 2 + odF * 0.7]], "a"));
          it.push(C(xx, 0, rF, "eq"), C(xx, 0, rF * 0.82, "a"), C(xx, 0, rF * 0.42, "a"), C(xx, 0, rF * 0.32, "a"), C(xx + rF * 0.6, rF * 0.35, 0.03, "a")); }
        it.push(Pp([fInL(i), fInR(i)], dnC, "dnC"), Pp([[-hl + 0.15, -hw + 0.25], fOut(i)], dnC, "dnC"), Tx(0, -hw - 0.25 - mb, "F" + nOf(i) + " · " + n + " × " + p.fsz, 2.2, "c")); }
      else if (c.k === "vpump") { const Z = wkVpSump(p), wl = src === "well", xa = wl ? 0 : Z.xa, pl = pv.pL || 0.6, ph = pv.pH || pl, bw = vpC ? vpC.bw : 0.12, yb0 = vpC ? vpC.yb0 : pl / 2;
        if (!wl) { it.push(R(-hl, -hw, f.L, f.W, "k"), R(-Z.Lin / 2, -Z.Win / 2, Z.Lin, Z.Win, "k"), Lg([[hl - 0.15, -Z.Win * 0.4], [hl - 0.15, Z.Win * 0.4]], "t"));   // pozzetto aperto dall'alto: pareti, griglia nella parete verso l'acqua
          [-1, 1].forEach(sg => it.push(R(xa + sg * yb0 - bw / 2, -hw, bw, f.W, "h"))); }   // coppia di travi da parete a parete, di traverso, sotto i lati della piastra
        else it.push(R(-hl, -hw, f.L, f.W, "k"));   // basamento sul pozzo
        it.push(wkPg([[xa - pl / 2, -ph / 2], [xa + pl / 2, -ph / 2], [xa + pl / 2, ph / 2], [xa - pl / 2, ph / 2]], 244, "a"), C(xa, 0, (pv.hD || 0.4) / 2, "a"));   // piastra di base e testa di scarico
        if ((pv.headK || "el") === "el") it.push(C(xa, 0, (pv.Dm || 0.5) / 2, "a"), C(xa, 0, (pv.Dm || 0.5) * 0.18, "a"));   // motore elettrico V1 sopra la testa
        it.push(Tx(xa, -ph / 2 - 0.35, "PV" + nOf(i), 2.2, "c")); }
      else { const bx = c._sd * f.L * 0.28, sd = c._sd, pc = c.k === "moto" ? p.pm : p.pe, Lp = Math.min(f.L * 0.42, (pc && pc.hLp) || f.L * 0.35), Lm = Math.min(f.L * 0.5, (pc && pc.mL) || f.L * 0.45), wB = Math.min(f.W * 0.62, 0.6);
        const xP0 = bx + sd * Lp * 0.55, xP1 = bx - sd * Lp * 0.45, xG1 = xP1 - sd * 0.16, xM1 = xG1 - sd * Lm, odD = Math.max(0.05, ((pc && pc.dnO) || p.dnD || 100) / 1000 * 1.1), odS = Math.max(0.05, (p.dnS || 100) / 1000 * 1.1);
        it.push(R(-hl, -hw, f.L, f.W, "a"));   // basamento della pompa
        it.push(wkPg([[xP0, -wB * 0.45], [xP1, -wB * 0.5], [xP1, wB * 0.5], [xP0, wB * 0.4], [xP0 + sd * 0.05, 0]], 255, "a"));   // corpo pompa (chiocciola) dall'alto
        it.push(wkPg([[xP1, -0.11], [xG1, -0.11], [xG1, 0.11], [xP1, 0.11]], 244, "a"));   // carter del giunto
        if (c.k === "moto") {   // MOTOPOMPA (78.29): motore diesel dall'alto (blocco, radiatore in testa, marmitta), cofanatura tratteggiata se c'è; niente motore elettrico
          const xR = xM1 + sd * 0.14; it.push(wkPg([[xG1, -wB * 0.48], [xM1, -wB * 0.48], [xM1, wB * 0.48], [xG1, wB * 0.48]], 255, "a"), Lg([[xR, -wB * 0.48], [xR, wB * 0.48]], "a"));
          for (let k2 = 1; k2 < 7; k2++) { const yy = -wB * 0.48 + wB * 0.96 * k2 / 7; it.push(Lg([[xM1, yy], [xR, yy]], "a")); }   // radiatore
          it.push(C((xG1 + xR) / 2, -wB * 0.3, 0.06, "a"), R(Math.min(xG1, xR) + Math.abs(xR - xG1) * 0.2, -0.05, Math.abs(xR - xG1) * 0.6, 0.1, "a"));   // marmitta e coperchio delle punterie
          if (wkCan(p)) it.push(R(-hl + 0.06, -hw + 0.06, f.L - 0.12, f.W - 0.12, "h")); }
        else { it.push(wkPg([[xG1, -wB * 0.42], [xM1 + sd * 0.12, -wB * 0.42], [xM1, -wB * 0.3], [xM1, wB * 0.3], [xM1 + sd * 0.12, wB * 0.42], [xG1, wB * 0.42]], 255, "a"));   // motore con il copriventola
          for (let k2 = 1; k2 < 6; k2++) { const yy = -wB * 0.42 + wB * 0.84 * k2 / 6; it.push(Lg([[xG1 - sd * 0.04, yy], [xM1 + sd * 0.16, yy]], "a")); }   // alette di raffreddamento
          it.push(R(Math.min(xG1, xG1 - sd * 0.28) + (sd > 0 ? -0.0 : 0), -0.1, 0.24, 0.2, "a")); }   // morsettiera
        it.push(C(bx, 0, odD * 0.75, "a"), C(bx, 0, odD / 2, "a"));   // bocca di mandata con la flangia (verso l'alto)
        const odI = Math.max(0.05, ((pc && pc.dnI) || p.dnS || 100) / 1000 * 1.1); void odS;
        it.push(Pp([[xP0 + sd * 0.05, 0], [hl, 0]], (pc && pc.dnI) || p.dnS), R(Math.min(xP0, xP0 + sd * 0.05), -odI * 0.75, 0.05, odI * 1.5, "a"));   // bocca d'aspirazione assiale sul naso, con la flangia
        if (c.k === "moto") it.push(C(xM1 + sd * Lm * 0.3, wB * 0.25, 0.05, "a"));   // tappo del serbatoio del motore diesel
        it.push(Tx((xG1 + xM1) / 2, wB * 0.5 + 0.22, (c.k === "moto" ? "MP" : "P") + nOf(i), 2.2, "c")); }
      plan.push(...G(g, it.map(q => TR(i, q)))); });
    // tubazioni in pianta, tutte dritte: aspirazione dal corpo pompa fuori dal basamento, mandata al collettore dei filtri, filtri in fila, uscita al perno o alla rete
    // complesso d'aspirazione (77.71), dal naso della pompa verso la fonte: flangia della bocca, riduzione eccentrica (piatta sopra), giunto antivibrante, vuotometro sulla riduzione
    const sucDn = (i) => { const pc = comps[i].k === "moto" ? p.pm : p.pe; return Math.min((pc && pc.dnI) || p.dnS, p.dnS); };
    const sucLen = (i) => { const re = sucDn(i) < p.dnS ? Math.max(0.3, 2.5 * (p.dnS - sucDn(i)) / 1000 + 0.15) : 0; return { re, ga: wkAccL("flex", p.dnS) + 0.06 }; };
    const sucS = (i) => { const q = sucLen(i); return W_(i, [fp[i].L / 2 + q.re + q.ga + 0.04, 0]); };
    const sucAsm = (i) => { const q = sucLen(i), x0s = fp[i].L / 2, o = [], ang = ({ 0: 0, 90: 90, 180: 180, 270: -90 })[comps[i].r] || 0;
      if (q.re) { o.push({ t: "p", pts: [W_(i, [x0s, 0]), W_(i, [x0s + q.re, 0])], dn: sucDn(i), cone: p.dnS }); }
      const g = W_(i, [x0s + q.re + q.ga / 2 + 0.02, 0]); o.push(...wkAccDraw("flex", g[0], g[1], p.dnS, ang));
      const vm = W_(i, [x0s + q.re * 0.5, -Math.max(0.05, p.dnS / 1000 * 1.1) * 0.55 - 0.06]); o.push(...wkAccDraw("gauge", vm[0], vm[1], 50, ang - 90));
      if (i === pI[0]) { const od = Math.max(0.05, p.dnS / 1000 * 1.1), lab = (u, s2) => { const q2 = W_(i, [u, od + 0.25]); o.push(Tx(q2[0], q2[1] - 0.06, s2, 1.8, "c")); };   // sigle brevi, spiegate in legenda
        if (q.re) lab(x0s + q.re * 0.5, "RE"); lab(x0s + q.re + q.ga / 2, "GA"); const q3 = W_(i, [x0s + q.re * 0.5, -od - 0.28]); o.push(Tx(q3[0], q3[1] - 0.06, "VM", 1.8, "c")); }
      return o; };
    pumps.forEach(({ c, i }, j) => { const vp = c.k === "vpump", f = fp[i], r0 = vp ? (pv.hD || 0.4) / 2 + 0.15 : Math.min(f.W * 0.3, 0.3), B = Bp(i);
      // aspirazione dritta fino alla fonte (canale, fiume, lago o vasca, pozzo) o dalla rete in pressione, lunga sucL oltre il basamento
      const sE = vp ? W_(i, src === "well" ? [0, 0] : [f.L / 2, 0]) : W_(i, [f.L / 2 + mb + sucL, 0]); c._sE = sE; c._sDir = ro(c.r, [1, 0]);   // aspirazione assiale dal naso della pompa; la verticale pesca nel suo pozzetto
      if (!vp) { plan.push(...sucAsm(i)); plan.push(Pp([sucS(i), sE], p.dnS, "dnS")); }
      const T = c._tg || (piv && j === 0 ? [piv[0], piv[1]] : null), dl = T ? Math.hypot(T[0] - B[0], T[1] - B[1]) || 1 : 0;
      let dP = null;
      if (vp) { const tg = T || [x1 + 0.8, B[1]], u = vpU(c, B, tg), pts = vpRoute(B, tg, u, c);   // la mandata esce dalla testa nella sua direzione (77.98)
        dP = [[B[0] + u[0] * r0, B[1] + u[1] * r0], ...pts.slice(1)].filter((q, k, A) => !k || Math.hypot(q[0] - A[k - 1][0], q[1] - A[k - 1][1]) > 0.02); c._vpPts = pts; c._vpY = u[0] === 0 ? 1 : 0; c._vpN = u[1];
        c._vpd = u[0] !== 0 ? u[0] : (Math.sign(pts[pts.length - 1][0] - B[0]) || 1); if (layL && layL[i]) layL[i].hra = u[0] > 0 ? 0 : u[1] > 0 ? 90 : u[0] < 0 ? 180 : 270;
        plan.push(Pp(dP, p.dnD, "dnD")); }
      else if (T) { dP = [[B[0] + (T[0] - B[0]) / dl * r0, B[1] + (T[1] - B[1]) / dl * r0], T]; plan.push(Pp(dP, p.dnD, "dnD")); }
      else { const d = ro(c.r, [c._sd, 0]), cl = Math.max(...[[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(q => dot(sub(q, B), d))) + 0.8; dP = [[B[0] + d[0] * r0, B[1] + d[1] * r0], [B[0] + d[0] * cl, B[1] + d[1] * cl]]; plan.push(Pp(dP, p.dnD, "dnD")); }
      c._dPL = dP ? dP.reduce((m, q, k, A) => k ? m + Math.hypot(q[0] - A[k - 1][0], q[1] - A[k - 1][1]) : 0, 0) : 0;
      if (j === 0 && dP) {   // accessori della mandata anche in pianta (77.70), con le sigle del prospetto: il giunto antivibrante sta sulla salita (dall'alto un anello), gli altri sul tratto orizzontale
        const odD = Math.max(0.05, (p.dnD || 100) / 1000 * 1.1); if (!vp) plan.push(C(B[0], B[1], odD * 0.62, "a"), C(B[0], B[1], odD * 0.5, "a"), Tx(B[0] - odD - 0.12, B[1] - 0.06, "GA1", 1.9, "r"));
        const sL = (k) => Math.hypot(dP[k + 1][0] - dP[k][0], dP[k + 1][1] - dP[k][1]), gk = (() => { for (let k = 0; k < dP.length - 1; k++) if (sL(k) >= 1.4) return k; return 0; })();   // il primo tratto abbastanza lungo (78.07: con la testa verso l'acqua il primo è un moncone)
        const keys = ["check", "wafer", "gauge"], A0 = dP[gk], L0 = sL(gk), u = [(dP[gk + 1][0] - A0[0]) / (L0 || 1), (dP[gk + 1][1] - A0[1]) / (L0 || 1)], ang = Math.atan2(u[1], u[0]) * 180 / Math.PI;
        let sA = gk ? 0.3 : 0.45; keys.forEach((k, ki) => { const l = Math.max(0.16, wkAccL(k, p.dnD) + 0.1); if (sA + l > L0 - 0.3) return; const x = A0[0] + u[0] * (sA + l / 2), y = A0[1] + u[1] * (sA + l / 2);
          plan.push(...wkAccDraw(k, x, y, p.dnD, Math.round(ang)), Tx(x - u[1] * (odD + 0.22 + (ki % 2) * 0.3), y + u[0] * (odD + 0.22 + (ki % 2) * 0.3) - 0.08, (WK_ACC[k] ? WK_ACC[k][0] : "?") + (ki + 2), 1.9, "c")); sA += l + 0.14; }); } });
    for (let j = 1; j < fI.length; j++) plan.push(Pp([W_(fI[j - 1], fOut(fI[j - 1])), W_(fI[j], fInL(fI[j]))], dnC, "dnC"));
    const labAt = (q, d, s) => plan.push(Tx(q[0] + (Math.abs(d[0]) > 0.5 ? d[0] * 0.4 : 0.2), q[1] + (Math.abs(d[0]) > 0.5 ? 0.25 : d[1] * 0.6), s, 2, Math.abs(d[0]) > 0.5 ? (d[0] > 0 ? "l" : "r") : "l"));
    if (lastF != null) { const edge = [Pout[0] + dOut[0] * (clear + 0.8), Pout[1] + dOut[1] * (clear + 0.8)], end = piv ? [piv[0], piv[1]] : edge;
      plan.push(Pp([Pout, end], dnC, "dnC")); outPL = Math.hypot(end[0] - Pout[0], end[1] - Pout[1]); labAt([Pout[0] + dOut[0] * clear, Pout[1] + dOut[1] * clear], dOut, (piv ? t("wk_toPiv") : t("wk_fOut")) + " DN " + dnC); }
    else if (p0 != null) labAt([Pout[0] + dOut[0] * clear, Pout[1] + dOut[1] * clear], dOut, (piv ? t("wk_toPiv") : t("wk_delivery")) + " DN " + p.dnD);
    const gens = comps.map((c, i) => ({ c, i })).filter(o => o.c.k === "gen"), pan = comps.find(c => c.k === "panel");
    // cavi: il gruppo elettrogeno alimenta il quadro del gruppo (QE) e il quadro del pivot (QP), non il pivot; le pompe prendono dal QE, o senza QE dal QP
    const qp = piv && piv[3] ? piv[3] : null;
    gens.forEach(({ c }) => { if (pan) plan.push(Lg([[c.x, c.y], [c.x, pan.y], [pan.x, pan.y]], "el")); if (qp) plan.push(Lg([[c.x, c.y], [c.x, qp[1]], qp], "el")); else { const pE = pumps.find(o => o.c.k !== "moto"); if (!pan && pE) plan.push(Lg([[c.x, c.y], [c.x, pE.c.y], [pE.c.x, pE.c.y]], "el")); } });
    if (pan) pumps.forEach(({ c }) => { if (c.k !== "moto") plan.push(Lg([[pan.x, pan.y], [c.x, pan.y], [c.x, c.y]], "el")); });   // la motopompa ha il suo motore: nessun cavo dal quadro (78.29)
    else if (qp) pumps.forEach(({ c }) => { if (c.k !== "moto") plan.push(Lg([qp, [c.x, qp[1]], [c.x, c.y]], "el")); });
    if (pumps.length) { const pS0 = pumps.find(o => o.c.k !== "vpump"); if (pS0) { const q = W_(pS0.i, [fp[pS0.i].L / 2 + mb + Math.min(0.9, sucL * 0.55), 0]); plan.push(Tx(q[0] - 0.18, q[1], t("wk_suction") + " DN " + p.dnS, 2, "r")); }
      // la fonte in pianta: canale e fiume (sponde lungo tutte le aspirazioni), lago o vasca, pozzo per ogni pompa, rete in pressione con l'idrante
      const footDown = (c, dn, lab) => { const od = Math.max(0.05, (dn || 100) / 1000 * 1.1); return [C(c[0], c[1], Math.max(0.075, (dn || 100) / 1000 * 0.8), "h"), C(c[0], c[1], od / 2, "a")].concat(lab ? [Tx(c[0] + 0.9, c[1] - 0.1, t("wk_footValve"), 1.9, "l")] : []); };   // il tubo scende nel pozzetto: dall'alto la sezione del tubo e, sotto, la valvola di fondo (tratteggiata)
      const sumpAt = (c, lab, a, g) => { nSump++; const u = a || [1, 0], v = [-u[1], u[0]], gv = g || [0, 1], Q = (x, y) => [c[0] + u[0] * x + v[0] * y, c[1] + u[1] * x + v[1] * y], sq = (h) => [Q(-h, -h), Q(h, -h), Q(h, h), Q(-h, h), Q(-h, -h)];
        const gs = dot(gv, v) >= 0 ? 1 : -1, gl = [Q(-0.6, gs * 0.35), Q(0.6, gs * 0.35)];   // griglia sul lato dell'acqua
        return [Lg(sq(0.75), "k"), Lg(sq(0.6), "t"), Lg(gl, "t")].concat(lab ? [Tx(c[0] - 0.9, c[1] - 0.1, t("wk_sump"), 2.2, "r")] : []); };   // pozzetto di prelievo in c.a. 1,5 × 1,5 m (interno 1,2) con griglia, parallelo alla sponda
      const footAll = () => pumps.forEach((o, k) => { if (o.c.k === "vpump") return; const idx = plan.findIndex(it => it.t === "p" && it.pts.length === 2 && Math.abs(it.pts[1][0] - o.c._sE[0]) < 1e-6 && Math.abs(it.pts[1][1] - o.c._sE[1]) < 1e-6);   // la valvola di fondo vista dall'alto in ogni fonte con l'acqua libera (77.75)
        if (idx >= 0) plan[idx] = { ...plan[idx], noEnd: 1 }; plan.push(...footDown(o.c._sE, p.dnS, !k)); });
      const s0 = pumps[0].c._sDir, nn = [-s0[1], s0[0]], E = pumps.map(o => o.c._sE), w = src === "river" ? 4 : src === "canal" ? 2 : 0;
      if (w) {   // canale o fiume: trascinabile (cnX/cnY) e ruotabile (cnA: 0 sul fianco, 90 in punta, 45/135 di sbieco); l'aspirazione dritta arriva all'asse
        const B0 = E[0], cA = ((+(p.cnA != null ? p.cnA : (+p.srcTip ? 90 : 0)) % 180) + 180) % 180, an = cA * Math.PI / 180, ax = [nn[0] * Math.cos(an) + s0[0] * Math.sin(an), nn[1] * Math.cos(an) + s0[1] * Math.sin(an)];
        let C0 = p.cnX != null && isFinite(+p.cnX) ? [+p.cnX, +p.cnY] : [B0[0] + s0[0] * (w / 2), B0[1] + s0[1] * (w / 2)];
        const tip = Math.abs(dot(ax, s0)) > 0.99;
        if (tip) { const u = dot(sub(C0, B0), nn); C0 = [C0[0] - nn[0] * u, C0[1] - nn[1] * u]; }   // in punta: l'asse del canale sulla linea dell'aspirazione
        const nA0 = [-ax[1], ax[0]], bo = dot(nA0, s0) > 0 ? -w / 2 : w / 2, sumps = [], obl = !tip && Math.abs(ax[0]) > 0.1 && Math.abs(ax[1]) > 0.1; void bo;
        { const o0 = pumps.find(o => o.c.k !== "vpump");   // POZZETTO TRASCINATO (77.91): resta sulla linea dell'aspirazione, almeno 0,95 m oltre il basamento; il canale gli si accosta
          if (o0 && !dir && p.spX != null && isFinite(+p.spX)) { const e0 = W_(o0.i, [fp[o0.i].L / 2 + mb, 0]), Pc = [e0[0] + s0[0] * Math.max(0.95, dot(sub([+p.spX, +p.spY], e0), s0)), e0[1] + s0[1] * Math.max(0.95, dot(sub([+p.spX, +p.spY], e0), s0))];
            if (tip) C0 = [Pc[0] + s0[0] * 0.75, Pc[1] + s0[1] * 0.75]; else { const sd = Math.sign(dot(sub(e0, C0), nA0)) || 1, d = dot(sub(Pc, C0), nA0) - sd * (w / 2 + 0.75); C0 = [C0[0] + nA0[0] * d, C0[1] + nA0[1] * d]; } } }   // pozzetto di prelievo prima della sponda, tubo di presa fino all'asse del canale
        const ends = pumps.map(o => { if (o.c.k === "vpump") return o.c._sE; const e0 = W_(o.i, [fp[o.i].L / 2 + mb, 0]);
          if (tip && dir) return [C0[0] + s0[0] * 1.0, C0[1] + s0[1] * 1.0];   // pescante dentro la testata del canale
          if (tip) { const Pc = [C0[0] - s0[0] * 0.75, C0[1] - s0[1] * 0.75]; sumps.push({ c: Pc, a: nn, g: s0 }); return Pc; }   // pozzetto accostato alla testata del canale (77.69)
          // pozzetto parallelo alla sponda (77.73): il lato verso l'acqua sulla sponda, il centro sulla linea dell'aspirazione
          const sd = Math.sign(dot(sub(e0, C0), nA0)) || 1, dn = dot(s0, nA0), tp = Math.abs(dn) > 1e-6 ? Math.max(0.95, (sd * (dir ? w / 2 - Math.min(0.8, w * 0.3) : w / 2 + 0.75) - dot(sub(e0, C0), nA0)) / dn) : 0.95;
          if (dir) return [e0[0] + s0[0] * tp, e0[1] + s0[1] * tp];   // pescante che scavalca la sponda e pesca nel canale, a un terzo della larghezza
          const Pc = [e0[0] + s0[0] * tp, e0[1] + s0[1] * tp]; sumps.push({ c: Pc, a: ax, g: [-nA0[0] * sd, -nA0[1] * sd] }); return Pc; });   // pozzetto accostato alla sponda: l'acqua entra dalla griglia nella parete, nessun tubo di collegamento (77.69)
        // aspirazioni ridisegnate fino al canale (sostituiscono quelle a lunghezza fissa)
        pumps.forEach((o, k) => { if (o.c.k === "vpump") return; const f = fp[o.i], r0 = Math.min(f.W * 0.3, 0.3), st = sucS(o.i), idx = plan.findIndex(it => it.t === "p" && it.pts.length === 2 && Math.abs(it.pts[1][0] - o.c._sE[0]) < 1e-6 && Math.abs(it.pts[1][1] - o.c._sE[1]) < 1e-6);
          const en = ends[k]; o.c._sE2 = en; if (idx >= 0) plan[idx] = { ...Pp([st, en], p.dnS, "dnS"), noEnd: 1 }; plan.push(...footDown(en, p.dnS, !k && (!obl || dir))); });
        { const k0 = pumps.findIndex(o => o.c.k !== "vpump"), li = plan.findIndex(it => it.t === "x" && it.s === t("wk_suction") + " DN " + p.dnS);   // scritta dell'aspirazione a metà del tubo vero, anche col pozzetto avvicinato (77.91)
          if (k0 >= 0 && li >= 0 && !dir) { const o = pumps[k0], e0 = W_(o.i, [fp[o.i].L / 2 + mb, 0]), en = ends[k0], L = dot(sub(en, e0), s0) - 0.75; if (L < sucL * 0.55 + 0.3) { const m = [e0[0] + s0[0] * L / 2, e0[1] + s0[1] * L / 2]; plan[li] = { ...plan[li], x: m[0] - 0.18 - Math.abs(s0[1]) * 0.1, y: m[1] }; } } }
        if (obl && dot(ax, [1, 0]) * dot(ax, [0, 1]) < 0) { const li = plan.findIndex(it => it.t === "x" && it.s === t("wk_suction") + " DN " + p.dnS); if (li >= 0) plan[li] = { ...plan[li], x: plan[li].x + 0.36, al: "l" }; }   // la sponda sale verso sinistra: la scritta dell'aspirazione dall'altra parte
        if (sumps.length) pos.sp = sumps[0].c;
        sumps.forEach((q, k) => { plan.push(...sumpAt(q.c, !k && !obl, q.a, q.g).map(it => k ? it : { ...it, g: "sp" }));   // il primo pozzetto si trascina (77.91)
          if (!k && obl) { const L = [-q.g[0], -q.g[1]], d = L[0] >= 0 ? 1 : -1, sv = ax[0] * d > 0 ? ax : [-ax[0], -ax[1]], a = [q.c[0] + sv[0] * 0.75 + L[0] * 0.3, q.c[1] + sv[1] * 0.75 + L[1] * 0.3];   // canale di sbieco: le scritte con il richiamo, dalla parte della terra
            plan.push(Ld(a, [q.c[0] + sv[0] * 1.5 + L[0] * 0.9, q.c[1] + sv[1] * 1.5 + L[1] * 0.9], t("wk_sump") + " · " + wkLc(t, t("wk_footValve")))); } });
        const nA = [-ax[1], ax[0]], hw = w / 2, Lc = 5, tts = tip ? [0] : ends.map(e => dot(sub(e, C0), ax)), ta = tip ? 0 : Math.min(-Lc / 2, Math.min(...tts) - 2), tb = tip ? Lc : Math.max(Lc / 2, Math.max(...tts) + 2);
        const Q_ = (u, v) => [C0[0] + ax[0] * u + nA[0] * v, C0[1] + ax[1] * u + nA[1] * v], it = [];
        if (tip) { const sg = dot(ax, s0) > 0 ? 1 : -1, A_ = (u, v) => Q_(sg * u, v); it.push(Lg([A_(tb, -hw), A_(0, -hw), A_(0, hw), A_(tb, hw)], "k"), Lg([A_(tb, -hw + 0.3), A_(0.3, -hw + 0.3), A_(0.3, hw - 0.3), A_(tb, hw - 0.3)], "t")); const m = A_(tb * 0.55, hw + 0.4); it.push(Tx(m[0], m[1], t("wk_src_" + src), 2.4, "l")); }
        else { it.push(Lg([Q_(ta, -hw), Q_(tb, -hw)], "k"), Lg([Q_(ta, hw), Q_(tb, hw)], "k"), Lg([Q_(ta, -hw + 0.3), Q_(tb, -hw + 0.3)], "t"), Lg([Q_(ta, hw - 0.3), Q_(tb, hw - 0.3)], "t")); const m = Q_((ta + tb) / 2, 0); it.push(Tx(m[0], m[1] - 0.1, t("wk_src_" + src), 2.4, "c")); }
        pos.cn = C0; plan.push(...it.map(q => ({ ...q, g: "cn" }))); }
      else if (src === "lake") { const tt = E.map(e => dot(e, nn)), t0 = Math.min(...tt) - 2.5, t1 = Math.max(...tt) + 2.5, dd = Math.max(...E.map(e => dot(e, s0))) + 0.75, P_ = (u, v) => [nn[0] * u + s0[0] * v, nn[1] * u + s0[1] * v];
        if (dir) pumps.forEach((o, k) => { if (o.c.k === "vpump") return; const e = o.c._sE, en = [e[0] + s0[0] * (dd - dot(e, s0) + 1.5), e[1] + s0[1] * (dd - dot(e, s0) + 1.5)], idx = plan.findIndex(it => it.t === "p" && it.pts.length === 2 && Math.abs(it.pts[1][0] - e[0]) < 1e-6 && Math.abs(it.pts[1][1] - e[1]) < 1e-6);
          o.c._sE2 = en; if (idx >= 0) plan[idx] = { ...Pp([sucS(o.i), en], p.dnS, "dnS"), noEnd: 1 }; plan.push(...footDown(en, p.dnS, !k)); });   // pescante oltre la riva, nel lago (77.78)
        else { pumps.forEach((o, k) => { if (o.c.k !== "vpump") plan.push(...sumpAt(o.c._sE, !k)); }); footAll(); }   // pozzetto accostato alla riva (77.69), con la valvola di fondo (77.75)
        plan.push(Lg([P_(t0, dd + 4), P_(t0, dd + 0.6), P_(t0 + 0.6, dd), P_(t1 - 0.6, dd), P_(t1, dd + 0.6), P_(t1, dd + 4)], "k"), Lg([P_(t0 + 0.4, dd + 0.6), P_(t1 - 0.4, dd + 0.6)], "t"));
        const m = P_((t0 + t1) / 2, dd + (dir ? 3.4 : 2)); plan.push(Tx(m[0], m[1], t("wk_src_lake"), 2.4, "c")); }
      else if (src === "well") { E.forEach((e, k) => { plan.push(C(e[0], e[1], 0.45, "k"), C(e[0], e[1], 0.33, "t")); if (!k) plan.push(Tx(e[0] + 0.6, e[1] - 0.6, t("wk_src_well"), 2.4, "l")); }); footAll(); }
      else E.forEach((e, k) => { plan.push(R(e[0] - 0.18, e[1] - 0.18, 0.36, 0.36, "k"), Lg([[e[0] - 0.18, e[1] - 0.18], [e[0] + 0.18, e[1] + 0.18]], "k"), Lg([[e[0] - 0.18, e[1] + 0.18], [e[0] + 0.18, e[1] - 0.18]], "k")); if (!k) plan.push(Tx(e[0] + 0.35, e[1] - 0.1, t("wk_src_net"), 2.4, "l")); }); }
    // quote fra gli elementi vicini (albero delle distanze minime): componenti e piazzola della piramide
    { const B_ = comps.map((c, i) => ({ x: c.x, y: c.y, L: fr[i].L, W: fr[i].W })); if (piv) B_.push({ x: piv[0], y: piv[1], L: Lv, W: Lv });
      const gap = (a, b) => [Math.max(0, Math.abs(a.x - b.x) - (a.L + b.L) / 2), Math.max(0, Math.abs(a.y - b.y) - (a.W + b.W) / 2)];
      const inT = [0], E2 = [];
      while (inT.length < B_.length) { let best = null; inT.forEach(a => B_.forEach((q, b) => { if (inT.includes(b)) return; const g = gap(B_[a], q), d = Math.hypot(g[0], g[1]); if (!best || d < best.d) best = { a, b, d, g }; })); inT.push(best.b); E2.push(best); }
      E2.forEach(({ a, b, g }) => { const A = B_[a], Bq = B_[b]; if (g[0] < 0.02 && g[1] < 0.02) return;
        const sx = Bq.x > A.x ? 1 : -1, sy = Bq.y > A.y ? 1 : -1, ax = A.x + sx * A.L / 2, bx = Bq.x - sx * Bq.L / 2, ay = A.y + sy * A.W / 2, by = Bq.y - sy * Bq.W / 2;
        const kB = b === comps.length ? "pp" : "c" + b, E3 = (pa, pb) => { const L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) || 1; return { ...Dm(pa, pb, 0), ed: { k: kB, u: [wkR((pb[0] - pa[0]) / L, 4), wkR((pb[1] - pa[1]) / L, 4)], g: wkR(L, 3) } }; };
        if (g[1] < 0.02) { const y = Math.min(A.y + A.W / 2, Bq.y + Bq.W / 2) - Math.min(0.25, Math.min(A.W, Bq.W) * 0.2); plan.push(E3([ax, y], [bx, y])); }   // fra i fianchi delle due macchine, vicino al bordo più basso (78.29): la quota si legge fra due spigoli riconoscibili, lontano dai tubi e dal titolo
        else if (g[0] < 0.02) { const x = Math.min(A.x + A.L / 2, Bq.x + Bq.L / 2) - Math.min(0.25, Math.min(A.L, Bq.L) * 0.2); plan.push(E3([x, ay], [x, by])); }
        else plan.push(E3([ax, ay], [bx, by])); }); }
    if (SL) plan.push({ ...Dm([SL[0], SL[1]], [SL[2], SL[1]], -0.5), sl: 1 }, { ...Dm([SL[0], SL[1]], [SL[0], SL[3]], 0.5), sl: 1 });
    { const pp = plan.filter(it => it.g === "pp"); if (pp.length) { const rest = plan.filter(it => it.g !== "pp"), k = rest.findIndex(it => it.t === "d"); rest.splice(k < 0 ? rest.length : k, 0, ...pp); plan.length = 0; plan.push(...rest); } }   // piramide sopra i tubi (77.96): la linea al pivot passa sotto la croce e si collega con la curva da sotto
    view(t("wk_vPlan"), plan, { drag: 1 });
    // prospetto: i componenti nella stessa posizione lungo x, ognuno sul suo basamento
    const pvE = piv ? [piv[0] - Lv / 2, piv[0] + Lv / 2] : null;
    const ex0 = Math.min(SL ? Math.min(sx0, SL[0]) : sx0, pvE ? pvE[0] : Infinity), ex1 = Math.max(SL ? Math.max(sx1, SL[2]) : sx1, pvE ? pvE[1] : -Infinity), el = [ground(ex0 - 1.2, ex1 + 1.2, 0)];
    // piramide del pivot di lato (come nelle schede del costruttore): piazzola, gambe, controventi, tubo di risalita con la curva in cima, collettore
    let pvIn = null; const qpFront = [];   // quadro del pivot davanti alla piramide: si disegna per ultimo, sopra la curva d'ingresso (77.81)
    if (piv) { const px = piv[0], B = p.pvB || Lv * 0.8, Hp = p.pvHt || (p.pvProf === "high" ? 4.3 : 3.3), dir = px >= (sx0 + sx1) / 2 ? 1 : -1, rt = Math.max(0.09, (p.pvT || 203) / 2000);
      // piazzola come nei piani di fondazione del costruttore (77.62): platea Hs con il piano alla quota delle altre, magrone fino al terreno, plinti F × F fino a Pd sotto il piano;
      // pivot trainabile su carrello: solo i quattro plinti
      const F = p.pvF || WK_PLINTO, Pd = p.pvPd || WK_PLINTO_D, Hs = p.pvCart ? 0 : Math.min(H, p.pvHs || H);
      if (!p.pvCart && slabK !== "piv") el.push(R(px - Lv / 2, -Hs, Lv, Hs, "conc"), R(px - Lv / 2 - 0.1, -H - 0.1, Lv + 0.2, H - Hs + 0.1, "lean"));
      [-1, 1].forEach(sg => { const xb = px + sg * (p.pvCart ? B / 2 : Math.min(B / 2, Lv / 2 - F / 2)); el.push(R(xb - F / 2 - 0.1, -Pd - 0.1, F + 0.2, 0.1, "lean"), R(xb - F / 2, -Pd, F, Pd - Hs + 0.002, "conc")); });
      el.push(Dm([px - Lv / 2 - 0.35, 0], [px - Lv / 2 - 0.35, -Pd], 0));
      [-1, 1].forEach(sg => { const xb = px + sg * B / 2, xt = px + sg * (rt * 1.15 + 0.03); el.push(Lg([[xb, 0], [xt, Hp]], "k"), Lg([[xb - sg * 0.1, 0], [xt - sg * 0.06, Hp]], "t"), R(xb - 0.15, 0, 0.3, 0.08, "k")); });
      [0.33, 0.62, 0.85].forEach(f => { const hh = Hp * f, ww = B / 2 - (B / 2 - 0.18) * f; el.push(Lg([[px - ww, hh], [px + ww, hh]], "k")); });
      el.push(Lg([[px - B / 2, 0], [px + B / 2 * 0.3, Hp * 0.33]], "t"), Lg([[px + B / 2, 0], [px - B / 2 * 0.3, Hp * 0.33]], "t"));
      { // TESTA DEL PIVOT come nelle schede dei costruttori (77.67): anelli e collare girevole, flangia larga, gambe imbullonate ai fianchi del collare con le piastre,
        // curva a 90° dello stesso diametro verso l'esterno, flangia ottagonale d'uscita con i bulloni, sfiato con piattello sul dorso della curva
        const D = Math.max(0.12, (p.pvT || 203) / 1000 * 1.1), rc = D * 0.575, yC0 = Hp - 0.42, yC1 = Hp + 0.1, yF = yC1 + 0.06, Rc = D * 1.05, ro = Rc + D / 2, ri = Rc - D / 2, C0 = [px + dir * Rc, yF + 0.05];
        el.push({ ...Pp([[px, 0.9], [px, yC0 - 0.16]], p.pvT || 203), nf: 1 });   // colonna fino agli anelli
        el.push(wkPg([[px - D * 0.52, yC0 - 0.16], [px + D * 0.52, yC0 - 0.16], [px + D * 0.52, yC0 - 0.04], [px - D * 0.52, yC0 - 0.04]], 255, "a"),   // anelli di tenuta del giunto girevole
          R(px - D * 0.56, yC0 - 0.11, D * 1.12, 0.025, "a"), R(px - D * 0.58, yC0 - 0.04, D * 1.16, 0.04, "a"),
          wkPg([[px - rc, yC0], [px + rc, yC0], [px + rc, yC1], [px - rc, yC1]], 255, "a"),   // collare
          R(px - D * 0.78, yC1, D * 1.56, 0.03, "a"), R(px - D * 0.55, yC1 + 0.03, D * 1.1, 0.03, "a"),   // flangia di testa
          R(px - D * 0.12, yC1 - 0.12, D * 0.24, 0.015, "a"), Lg([[px - 0.012, yC0 + 0.12], [px - 0.012, yC0 + 0.2]], "a"), Lg([[px + 0.012, yC0 + 0.12], [px + 0.012, yC0 + 0.2]], "a"));
        [-1, 1].forEach(sg => {   // piastre di attacco delle gambe, con i bulloni
          const xt = px + sg * (rc + 0.03), xb0 = px + sg * B / 2, l = Math.hypot(xt - xb0, Hp), u = [(xb0 - xt) / l, -Hp / l], nn = [-u[1] * sg, u[0] * sg], L = 0.6, w = 0.1;
          const q = (a0, b0) => [xt + u[0] * a0 + nn[0] * b0, Hp + u[1] * a0 + nn[1] * b0];
          el.push(wkPg([q(-0.02, -w * 0.4), q(-0.02, w * 0.6), q(L, w * 0.6), q(L, -w * 0.4)], 255, "a"), C(q(0.18, w * 0.15)[0], q(0.18, w * 0.15)[1], 0.007, "a"), C(q(0.34, w * 0.15)[0], q(0.34, w * 0.15)[1], 0.007, "a"), C(q(0.5, w * 0.15)[0], q(0.5, w * 0.15)[1], 0.007, "a")); });
        // curva a 90°: tratto dritto corto sopra la flangia, poi l'arco fino all'uscita orizzontale verso l'esterno
        const arc = (r, n) => { const o = []; for (let i = 0; i <= n; i++) { const t = Math.PI * i / (2 * n); o.push([C0[0] - dir * Math.cos(t) * r, C0[1] + Math.sin(t) * r]); } return o; };
        const outA = arc(ro, 18), inA = arc(Math.max(0.01, ri), 18), yE = C0[1] + Rc, xE = C0[0] + dir * 0.04;
        el.push(wkPg([[px - dir * D / 2, yF], ...outA, [xE, yE + D / 2], [xE, yE - D / 2], ...inA.slice().reverse(), [px + dir * D / 2, yF]], 255, "a"));
        { const fx = xE, b = 0.045, h = D * 0.85, ch = D * 0.25, X = (d) => fx + dir * d;   // flangia ottagonale d'uscita (di lato) con i bulloni
          el.push(wkPg([[X(0), yE - h + ch], [X(0), yE + h - ch], [X(b * 0.4), yE + h], [X(b), yE + h], [X(b), yE - h], [X(b * 0.4), yE - h]], 255, "a"));
          [-0.7, -0.35, 0, 0.35, 0.7].forEach(k => el.push(C(X(b * 0.55), yE + h * k, 0.007, "a"))); }
        { const t = 32 * Math.PI / 180, P0 = [C0[0] - dir * Math.cos(t) * ro, C0[1] + Math.sin(t) * ro], w = D * 0.36;   // sfiato sul dorso della curva, con il piattello
          el.push(wkPg([[P0[0] - w / 2, P0[1] - 0.05], [P0[0] + w / 2, P0[1] - 0.05], [P0[0] + w / 2, P0[1] + 0.09], [P0[0] - w / 2, P0[1] + 0.09]], 255, "a"), R(P0[0] - w * 1.1, P0[1] + 0.09, w * 2.2, 0.022, "a")); } }
      { const pk = ["n", "e", "s", "w", "edge"].includes(p.pvPan) ? p.pvPan : "s";   // quadro del pivot (77.64): sul lato scelto, come in pianta; davanti (sud) pieno, dietro (nord) tratteggiato, est e ovest di fianco
        if (pk !== "edge") { const ew = pk === "e" || pk === "w", cx = ew ? px + (pk === "e" ? 1 : -1) * (Lv / 2 + 0.35) : px, w = ew ? 0.4 : 0.8, y0 = -H + 1.0, hh = 0.8, st = pk === "n" ? "h" : "eq";
          (pk === "n" ? el : qpFront).push(R(cx - 0.04, -H, 0.08, 1.0, pk === "n" ? "h" : "k"), R(cx - w / 2, y0, w, hh, st), R(cx - w / 2 + 0.06, y0 + 0.08, w - 0.12, hh - 0.16, pk === "n" ? "h" : "t"), Tx(ew ? cx + (pk === "e" ? 1 : -1) * (w / 2 + 0.12) : cx, y0 + hh / 2 - 0.08, "QP", 2.2, ew ? (pk === "e" ? "l" : "r") : "c")); } }
      el.push(Tx(px, Hp + 1.05, t("wk_pivPt").replace("{p}", p.pvLab || ""), 2.2, "c"), Dm([px + (p.pvPan === "e" ? Lv / 2 + 1.3 : B / 2 + 0.4), 0], [px + (p.pvPan === "e" ? Lv / 2 + 1.3 : B / 2 + 0.4), Hp], -0.3));   // con il quadro a est la quota passa oltre
      pvIn = [px, 0.9]; }
    let fInE = null; const fElev = [];
    // POMPA VERTICALE IN PROSPETTO (77.91): pozzetto aperto o pozzo, cordolo, travi, piastra, testa con il motore, linea d'asse, corpo pompa e succheruola; la mandata verso dsg
    const vpParts = (xc, dsg, sh, i, lab, g) => { const v = vpC, pre = (y) => y - H, el = [];   // quote assolute → prima del rialzo delle platee; g: pareti interne in x e travi come si vedono nel prospetto
        if (!v.wl) { const xw0 = g.x0 - 0.3, xw1 = g.x1, wi = g.x1 - g.x0;   // pozzetto aperto: pareti e fondo sotto il terreno, cordolo fino al piano delle platee, travi d'appoggio
          el.push({ ...R(xw0, v.yF - 0.3, 0.3, -v.yF + 0.3, "conc"), ug: 1 }, { ...R(xw1, v.yF - 0.3, 0.3, -v.yF + 0.3, "conc"), ug: 1 }, { ...R(xw0, v.yF - 0.3, wi + 0.6, 0.3, "conc"), ug: 1 }, { t: "w", x0: g.x0, x1: g.x1, y: -v.lift, ug: 1 });
          el.push(R(xw0, -H, 0.3, H, "conc"), R(xw1, -H, 0.3, H, "conc"));
          if (g.along) el.push(R(xw0, 0, wi + 0.6, v.hb, "k"), Lg([[xw0, v.hb * 0.92], [xw1 + 0.3, v.hb * 0.92]], "t"), Lg([[xw0, v.hb * 0.08], [xw1 + 0.3, v.hb * 0.08]], "t"));   // trave HEB vista per lungo, con le ali
          else g.bx.forEach(bx => { const b2 = v.bw / 2, tf = v.hb * 0.1, tw = Math.max(0.008, v.bw * 0.09);   // trave HEB in sezione: profilo a doppio T
            el.push(wkPg([[bx - b2, 0], [bx + b2, 0], [bx + b2, tf], [bx + tw / 2, tf], [bx + tw / 2, v.hb - tf], [bx + b2, v.hb - tf], [bx + b2, v.hb], [bx - b2, v.hb], [bx - b2, v.hb - tf], [bx - tw / 2, v.hb - tf], [bx - tw / 2, tf], [bx - b2, tf]], 120, "a")); }); }
        else { const hw = Math.max(0.2, (pv.D || 0.3) / 2 + 0.08); el.push({ ...Lg([[xc - hw, 0], [xc - hw, v.yF]], "k"), ug: 1 }, { ...Lg([[xc + hw, 0], [xc + hw, v.yF]], "k"), ug: 1 }, { t: "w", x0: xc - hw, x1: xc + hw, y: -v.lift, ug: 1 }, R(xc - (pv.pL || 0.6) / 2 - 0.2, -H, (pv.pL || 0.6) + 0.4, H, "conc")); }   // pozzo con la camicia, basamento in calcestruzzo
        const hv = wkSym.head(xc, v.hb, { kind: pv.headK || "el", pL: pv.pL, A: pv.Hh, B: pv.hB, C: pv.hC, D: pv.hD, E: (pv.Dm || 0.5) * 0.9, dn: pv.dnH, noOut: g.yv ? 1 : 0 }), ytp = pre(v.yt);
        let parts = [...hv]; if ((pv.headK || "el") === "el") parts.push(...wkSym.motor(xc, v.hb + pv.Hh, pv.Dm, pv.Hm));
        parts.push(...wkSym.column(xc, v.hb, ytp, pv.lsD, pv.lsF, pv.lsL), ...wkSym.bowl(xc, ytp, pv.bA, pv.bSt, pv.bF, pv.bD, pv.lsD), ...wkSym.strainer(xc, pre(v.yb), v.asp, v.aspD || v.D, pv.vfA > 0 ? pv.vfA : 0));
        let dis = hv.dis; if (g.yv) { dis = [xc, dis[1]]; if (g.yv < 0) { const rf = Math.max(0.08, (pv.dnH || p.dnD || 150) / 1000 * 0.85), rp = rf * 0.78;   // bocca verso chi guarda: la flangia si vede di faccia, con i bulloni
            parts.push(wkPg([...Array(24)].map((_, k) => [xc + rf * Math.cos(k * Math.PI / 12), dis[1] + rf * Math.sin(k * Math.PI / 12)]), 255, "-"), C(xc, dis[1], rf, "a"), C(xc, dis[1], rf * 0.62, "a"), ...[0, 1, 2, 3, 4, 5, 6, 7].map(k => C(xc + rp * Math.cos(k * Math.PI / 4 + Math.PI / 8), dis[1] + rp * Math.sin(k * Math.PI / 4 + Math.PI / 8), rf * 0.07, "a"))); } }
        if (dsg < 0) { const f = (x) => 2 * xc - x; parts = parts.map(o0 => { const o = { ...o0 }; if (o.pts) o.pts = o.pts.map(q => [f(q[0]), q[1]]); if (o.t === "r") o.x = f(o.x + o.w); else if (o.x != null) o.x = f(o.x);   // testa girata verso i filtri o il pivot
          if (o.x0 != null) { const a = f(o.x0), b = f(o.x1); o.x0 = Math.min(a, b); o.x1 = Math.max(a, b); } if (o.a) o.a = [f(o.a[0]), o.a[1]]; if (o.b) o.b = [f(o.b[0]), o.b[1]]; return o; }); dis = [f(dis[0]), dis[1]]; }
        el.push(...parts, ...(lab ? [Tx(xc - dsg * ((pv.Dm || 0.5) / 2 + 0.25), v.hb + pv.Hh + ((pv.headK || "el") === "el" ? pv.Hm : 0) * 0.6, "PV" + nOf(i), 2.2, dsg > 0 ? "r" : "l")] : []));

      if (sh) el.forEach(it => { if (it.ug) return; if (it.pts) it.pts = it.pts.map(q => [q[0], q[1] + sh]); if (it.a) it.a = [it.a[0], it.a[1] + sh]; if (it.b) it.b = [it.b[0], it.b[1] + sh]; if (it.y != null) it.y += sh; });
      return { items: el, dis: sh ? [dis[0], dis[1] + sh] : dis }; };
    if (SL) el.push(R(SL[0], -H, SL[2] - SL[0], H, "conc"), R(SL[0] - 0.1, -H - 0.1, SL[2] - SL[0] + 0.2, 0.1, "lean"));
    else comps.forEach((c, i) => { if (c.k === "vpump") return; const f = fr[i], xl = c.x - f.L / 2; el.push(R(xl - mb, -H, f.L + 2 * mb, H, "conc"), R(xl - mb - 0.1, -H - 0.1, f.L + 2 * mb + 0.2, 0.1, "lean")); });
    const zI = []; comps.forEach((c, i) => { zI.push([el.length, c.y]); const f = fr[i], xl = c.x - f.L / 2;
      if (c.k === "gen") { el.push(...wkSym.genset(xl, 0, f.L, p.Hg, p.genK || "s"), Tx(c.x, p.Hg + 0.25, "G" + nOf(i), 2.2, "c")); }
      else if (c.k === "vpump" && vpC) { const A = Bp(i), dsg = c._vpd || 1, Z = vpC.Z, rx = c.r % 180 === 0, hx = vpC.wl ? Math.max(0.2, (pv.D || 0.3) / 2 + 0.08) : (rx ? Z.Lin : Z.Win) / 2;   // nel prospetto: pareti interne dalla pianta, travi di traverso (in sezione) o per lungo
        const g = { x0: c.x - hx, x1: c.x + hx, along: !rx, bx: [W_(i, [Z.xa - vpC.yb0, 0])[0], W_(i, [Z.xa + vpC.yb0, 0])[0]], yv: c._vpY ? (c._vpN > 0 ? 1 : -1) : 0 }, o = vpParts(A[0], dsg, 0, i, 1, g);
        el.push(...o.items.map(it => ({ ...it, _vpF: i + 1 }))); if (c === comps[vI[0]]) el.push({ ...Tx(dsg > 0 ? g.x0 - 0.75 : g.x1 + 0.75, -vpC.lift - 0.6, "D", 3.4, dsg > 0 ? "r" : "l"), ug: 1 });   // quote della pompa nel dettaglio D
        c._vdis = o.dis; c._vd = dsg; c._vi = i; c._vg = g; c._vA = A; }
      else if (c.k === "panel") { el.push(wkPg([[xl + 0.08, 0], [xl + 0.12, 0], [xl + 0.12, 0.1], [xl + 0.08, 0.1]], 120, "a"), wkPg([[xl + f.L - 0.12, 0], [xl + f.L - 0.08, 0], [xl + f.L - 0.08, 0.1], [xl + f.L - 0.12, 0.1]], 120, "a"), wkPg([[xl, 0.1], [xl + f.L, 0.1], [xl + f.L, 1.9], [xl, 1.9]], 244, "a"), Lgs([[c.x, 0.15], [c.x, 1.85]], "a"), wkPg([[xl + f.L * 0.15, 1.3], [xl + f.L * 0.4, 1.3], [xl + f.L * 0.4, 1.6], [xl + f.L * 0.15, 1.6]], 210, "a"), wkPg([[xl - 0.03, 1.9], [xl + f.L + 0.03, 1.9], [xl + f.L + 0.03, 1.95], [xl - 0.03, 1.95]], 225, "a"), Tx(c.x, 2.15, "QE", 2.2, "c")); }
      else if (c.k === "filter") { const n = Math.max(1, Math.round(p.fn)), pt = f.L / n, Hf = p.fH, fK = p.fK;
        for (let j = 0; j < n; j++) { const xx = xl + pt * (j + 0.5);
          if (fK === "sand") el.push(...wkSym.sandFilter(xx, 0.05, p.fD, Hf), Pp([[xx, Hf + 0.19], [xx, Hf + 0.35]], p.fdn, "fdn"));
          else if (fK === "disc") el.push(Pp([[xx, 0.25], [xx, 0.37]], p.fdn, "fdn"), ...wkSym.discFilter(xx, 0.37, p.fD, Hf));
          else if (fK === "hydro") el.push(...wkSym.hydroFilter(xx, 0.05, p.fD, Hf));
          else el.push(...wkSym.screenFilter(xx - Math.min(Hf, pt * 0.8) / 2, 0.6, Math.min(Hf, pt * 0.8), p.fD)); }
        const yIn = fK === "sand" || fK === "hydro" ? Hf + 0.35 : fK === "disc" ? 0.25 : 0.6, yO = fK === "sand" ? 0.3 : fK === "hydro" ? Hf + 0.1 : fK === "disc" ? 0.25 : 0.6;
        if (fK !== "disc" && fK !== "screen") el.push(Pp([[xl, yIn], [xl + f.L, yIn]], dnC, "dnC"));
        el.push(Pp([[xl + 0.1, yO], [xl + f.L, yO]], dnC, "dnC"), Tx(c.x, Math.max(Hf, 0.8) + 0.65, "F" + nOf(i), 2.2, "c"));
        fElev.push({ xl, xr: xl + f.L, yIn, yO, zy: c.y }); if (!fInE) fInE = [xl, yIn]; }
      else { const pc = c.k === "moto" ? p.pm : p.pe, front = c.r % 180 !== 0;   // albero perpendicolare al prospetto (pompa girata verso la fonte): la pompa si vede di fronte, con l'aspirazione verso chi guarda (77.71)
        const ha = front && c.k === "moto" && wkCan(p) ? (() => { const o = wkSym.motoCanEnd(c.x, 0.12, f.L * 0.95, Math.max(0.9, (pc.Hu - 0.12) * 1.12) + (wkCan(p) === "skid" ? 0.06 : 0.42), wkCan(p), p.dnS, (pc && pc.dnO) || p.dnD); o.end = xl + f.L; return o; })()   // motopompa cofanata vista dalla testata (77.83)
          : front ? (() => { const xc = c.x, hs = pc.hHs || pc.Hu * 0.4, ya = 0.12 + hs, rv = Math.min(f.L * 0.38, hs * 0.78), rm = Math.min(f.L * 0.46, hs * 0.98), odO = Math.max(0.05, (pc.dnO || p.dnD) / 1000 * 1.1), odI = Math.max(0.05, (pc.dnI || p.dnS) / 1000 * 1.1), o = [];
          if (c.k === "moto") { const Hd = Math.max(0.5, pc.Hu - 0.12); o.push(wkPg([[xc - f.L * 0.45, 0.12], [xc + f.L * 0.45, 0.12], [xc + f.L * 0.45, 0.12 + Hd], [xc - f.L * 0.45, 0.12 + Hd]], 244, "a")); }   // motore diesel dietro
          else o.push({ ...C(xc, ya, rm, "a"), fg: 244 }, wkPg([[xc - rm * 0.8, 0.12], [xc + rm * 0.8, 0.12], [xc + rm * 0.6, ya - rm * 0.7], [xc - rm * 0.6, ya - rm * 0.7]], 244, "a"));   // motore dietro, con i piedi
          o.push(wkPg([[xc - rv * 0.55, 0.12], [xc + rv * 0.55, 0.12], [xc + rv * 0.4, ya - rv * 0.8], [xc - rv * 0.4, ya - rv * 0.8]], 255, "a"), { ...C(xc, ya, rv, "a"), fg: 255 });   // corpo pompa (chiocciola) di fronte
          const yN = ya + rv * 0.82, yD = ya + rv + 0.1; o.push(wkPg([[xc - odO / 2, yN], [xc + odO / 2, yN], [xc + odO / 2, yD], [xc - odO / 2, yD]], 255, "a"), R(xc - odO * 0.78, yD, odO * 1.56, 0.03, "a"));   // bocca di mandata con la flangia
          o.push({ ...C(xc, ya, odI * 0.78, "a"), fg: 255 }, C(xc, ya, odI / 2, "a"));   // bocca d'aspirazione verso chi guarda
          o.suc = [xc, ya]; o.del = [xc, yD + 0.03]; o.top = yD + 0.03; o.end = xl + f.L; o.front = 1; return o; })()
          : wkSym.horiz(xl, 0.12, { can: c.k === "moto" ? wkCan(p) : null, dS: p.dnS, dD: (pc && pc.dnO) || p.dnD, Lp: pc.hLp || f.L * 0.4, hs: pc.hHs || pc.Hu * 0.4, Lc: c.k === "moto" ? 0.08 : 0.12, Lm: pc.mL || f.L * 0.48, diesel: c.k === "moto", Hd: Math.max(0.5, pc.Hu - 0.12) });
        el.push(wkPg([[xl, 0], [Math.max(xl + f.L, ha.end), 0], [Math.max(xl + f.L, ha.end), 0.12], [xl, 0.12]], 244, "a"), ...ha, Tx(Math.max(xl + f.L, ha.end || 0) + 0.12, Math.max(0.35, ha.top * 0.55), (c.k === "moto" ? "MP" : "P") + nOf(i), 2.2, "l"));
        c._ha = ha; { const dO = pc.dnO || p.dnD, Ld0 = dO < p.dnD ? Math.max(0.25, 2.5 * (p.dnD - dO) / 1000 + 0.15) : 0; c._hD = Math.max(Math.max(pc.Hu, ha.top + 0.1) + 0.35, ha.del[1] + Ld0 + wkAccL("flex", p.dnD) + 0.35 + 1.65 * Math.max(0.05, (p.dnD || 100) / 1000 * 1.1)); } } });
    zI.forEach(([a, y], k) => { const b = k + 1 < zI.length ? zI[k + 1][0] : el.length; for (let q = a; q < b; q++) el[q]._z = y; });
    fElev.sort((a, b) => a.xl - b.xl); fElev.forEach((q, j) => { const nx = fElev[j + 1]; el.push({ ...Pp(nx ? [[q.xr, q.yO], [nx.xl, q.yO], [nx.xl, nx.yIn]] : pvIn ? [[q.xr, q.yO], [pvIn[0], q.yO], pvIn] : [[q.xr, q.yO], [sx1 + 0.8, q.yO]], dnC, "dnC"), _z: nx ? (q.zy + nx.zy) / 2 : piv ? (q.zy + piv[1]) / 2 : q.zy }); });
    // PROSPETTO IN PROFONDITÀ (77.73): si guarda da sud; ciò che in pianta sta più a nord è dietro e resta coperto dalle macchine davanti (la linea al pivot passa dietro la pompa)
    if (zI.length) { const a = zI[0][0], blk = el.slice(a).map((it, q) => ({ it, q })); blk.sort((u, v) => ((v.it._z != null ? v.it._z : -1e9) - (u.it._z != null ? u.it._z : -1e9)) || u.q - v.q); el.splice(a, blk.length, ...blk.map(o => o.it)); }   // al pivot fuori terra: dritto fino all'asse, curva esterna, risalita
    el.push(...qpFront);   // il quadro copre la curva e il tubo che entrano nella piramide dietro di lui
    const diffs = []; let vpDet = null;
    const vpDel = (c, j) => { if (!c._vdis) return; const dis = c._vdis, d = c._vd, odD = Math.max(0.05, (p.dnD || 100) / 1000 * 1.1), dx = Math.max(0.6, 3.2 * odD), v = vpC;   // mandata della verticale: dalla flangia della testa, in orizzontale verso i filtri o il pivot
      const ax = c._vA ? c._vA[0] : dis[0], xs = (c._vpPts || [[ax, 0], [ax + d * 2.2, 0]]).slice(1).map(q => q[0]).filter(x => Math.abs(x - ax) > 0.05), Xl = xs.length ? xs[xs.length - 1] : dis[0], s2 = fInE ? Math.sign(fInE[0] - Xl) || d : 0;   // il percorso della pianta visto da sud: i tratti lungo y si vedono di testa
      const hd = [dis, ...xs.map(x => [x, dis[1]])], raw = fInE ? (Math.abs(fInE[1] - dis[1]) < 0.05 ? [...hd, fInE] : [...hd, [fInE[0] - s2 * dx, dis[1]], [fInE[0] - s2 * dx, fInE[1]], fInE]) : pvIn && j === 0 ? [...hd, [pvIn[0], dis[1]], pvIn] : hd.length > 1 ? hd : [dis, [dis[0] + d * 0.6, dis[1]]];
      const pth = raw.filter((q, k, A) => !k || Math.hypot(q[0] - A[k - 1][0], q[1] - A[k - 1][1]) > 0.02).filter((q, k, A) => k === 0 || k === A.length - 1 || Math.abs((A[k][0] - A[k - 1][0]) * (A[k + 1][1] - A[k][1]) - (A[k][1] - A[k - 1][1]) * (A[k + 1][0] - A[k][0])) > 1e-6 || (A[k][0] - A[k - 1][0]) * (A[k + 1][0] - A[k][0]) + (A[k][1] - A[k - 1][1]) * (A[k + 1][1] - A[k][1]) < 0);   // niente punti doppi o allineati
      el.push(Pp(pth, p.dnD, "dnD")); c._pth = pth;
      if (j === 0) { accL = p.acc || wkAccAlong(pth, ["flex", "check", "wafer", "gauge"], p.dnD, 0.04).map(a => ({ ...a, up: 1 }));   // sigle sopra il tubo: la mandata della verticale è bassa
        if (!p.acc && fInE && !accL.some(a => a.k === "gauge")) accL.push({ k: "gauge", dn: p.dnD, x: wkR(fInE[0] + 0.45, 3), y: wkR(fInE[1], 3), r: 0 });
        wkAccPut(c._vpY ? [] : el, pos, accL, t); }   // mandata dritta verso chi guarda o dietro: nel prospetto gli accessori si vedono di testa, restano in pianta e nel computo
      if (c === comps[vI[0]]) { const g0 = c._vg, xl0 = g0.x0 - 0.3;   // livello sotto il piano nel prospetto (si scrive col clic), il resto nel dettaglio D
        el.push({ ...Dm([xl0 - 0.5, 0], [xl0 - 0.5, -v.lift], 0), ed: { k: "lift", u: [0, -1], g: wkR(v.lift, 3), ug: 1 }, ug: 1 });
        const ax0 = c._vA[0], g = { ...g0, yv: 0, x0: g0.x0 - ax0, x1: g0.x1 - ax0, bx: g0.bx.map(x => x - ax0) }, o = vpParts(0, d, H, c._vi, 0, g), it = o.items, xa = g.x0 - (v.wl ? 0 : 0.3), xb = g.x1 + (v.wl ? 0 : 0.3), xr = xb + 0.35;   // DETTAGLIO D (77.91): pozzetto e pompa in quote assolute, a scala grande
        it.push(ground(xa - 1.6, xb + 1.6, 0), { ...Pp([o.dis, [o.dis[0] + d * 0.9, o.dis[1]]], p.dnD, "dnD"), noEnd: 1 }, Dm([xa - 0.45, 0], [xa - 0.45, -v.lift], 0, fmtM(v.lift)), Dm([xr, -v.lift], [xr, v.yI], 0, "S " + fmtM(v.S)), ...(v.wl ? [] : [Dm([xr, v.yI], [xr, v.yF], 0, fmtM(v.yI - v.yF))]), Dm([xb + 1.0, H + v.hb], [xb + 1.0, v.yI], 0, fmtM(H + v.hb - v.yI)));
        if (v.bm) it.push(Ld([xa + 0.15, H + v.hb * 0.5], [xa - 0.9, H + v.hb + 0.6], v.bm.name));
        subG(it, xa - 1.05, v.yI, v.cS, g.x0, g.x1, null, 1); subN(t("wk_sk_vpump"), v.cS, v.S); if (v.hFv) flN(t("wk_sk_vpump"), v.yI - v.yF, v.hFv, v.aspD || v.D);
        vpDet = it; } };
    pumps.forEach(({ c }, j) => { if (c.k === "vpump") { vpDel(c, j); return; } const ha0 = c._ha; if (!ha0) return; const pcU = c.k === "moto" ? p.pm : p.pe, dnO = (pcU && pcU.dnO) || p.dnD, Ld = dnO < p.dnD ? Math.max(0.25, 2.5 * (p.dnD - dnO) / 1000 + 0.15) : 0;
      if (Ld) { el.push({ t: "p", pts: [ha0.del, [ha0.del[0], ha0.del[1] + Ld]], dn: dnO, cone: p.dnD }); diffs.push(dnO); }   // diffusore sulla bocca di mandata
      const ha = { ...ha0, del: [ha0.del[0], ha0.del[1] + Ld] }, end = fInE ? fInE : [sx1 + 0.8, c._hD], pth = !fInE && pvIn && j === 0 ? [ha.del, [ha.del[0], c._hD], [pvIn[0], c._hD], pvIn]
        : (fInE && (end[1] >= ha.del[1] + wkAccL("flex", p.dnD) + 0.3 + 1.65 * Math.max(0.05, (p.dnD || 100) / 1000 * 1.1) && end[1] > c._hD - 0.6)) ? [ha.del, [ha.del[0], end[1]], end]   // poco sotto la quota della mandata: in linea, senza scalino   // collettore dei filtri più in alto: si sale dritti alla sua quota e si entra in linea
        : fInE ? (() => { const dx = Math.max(0.6, 3.2 * Math.max(0.05, (p.dnD || 100) / 1000 * 1.1)); /* discesa vicino ai filtri: accessori sul tratto alto */ return [ha.del, [ha.del[0], c._hD], [end[0] - dx, c._hD], [end[0] - dx, end[1]], end]; })()
        : [ha.del, [ha.del[0], c._hD], [end[0] - 0.1, c._hD]];
      { const i0 = el.length, xs = ha.front ? ha.suc[0] : ha.suc[0] - 0.4, sH = (pts) => ha.front ? [ha.suc].concat(pts.slice(2)) : pts, lvl = -Math.max(0.5, +p.lift || 2);   // aspirazione fino alla fonte scelta
        if (j === 0 && src !== "net") el.push({ ...Dm([xs - 1.3, 0], [xs - 1.3, lvl], 0), ed: { k: "lift", u: [0, -1], g: wkR(-lvl, 3) } });   // quota dell'acqua sotto il piano: clic sul numero per scriverla
        if (src === "net") el.push(Pp(sH([ha.suc, [xs, ha.suc[1]], [xs, -H - 0.8], [xs - 1.6, -H - 0.8]]), p.dnS, "dnS"), Tx(xs - 1.7, -H - 0.65, t("wk_src_net"), 2, "r"));
        else if (dir) {   // pescante diretto (77.78): il tubo scavalca il ciglio della sponda e scende lungo la scarpa; la bocca della valvola di fondo alla sommergenza minima (77.80)
          const sl = 1.5, Lf = wkAccL("foot", p.dnS), an = Math.atan2(-1, -sl), cq = Math.cos(an), sq = Math.sin(an), yI = lvl - cSs.S, yv = yI - sq * Lf, xb = xs - 0.5, hF = flQ(Math.max(0.15, (p.dnS || 100) / 1000 * 1.6)), yb = Math.min(lvl - 1.4, yI - Math.max(0.5, hF)), x1 = xb - Math.max(0.35, (hF + 0.1 - 0.3) * sl), xi = x1 - (0.3 - yv) * sl;
          el.push(Lg([[xs + 0.9, 0], [xb, 0], [xb + yb * sl, yb], [xb + yb * sl - 2.2, yb]], "k"), { t: "w", x0: xb + yb * sl - 2.2, x1: xb + lvl * sl, y: lvl });   // sponda in scarpa 1,5:1
          el.push(Pp(sH([ha.suc, [xs, ha.suc[1]], [xs, 0.3], [x1, 0.3], [xi, yv]]), p.dnS, "dnS"), ...wkAccDraw("foot", xi + cq * Lf / 2, yv + sq * Lf / 2, p.dnS, an * 180 / Math.PI), R(xb + 0.05, -0.05, 0.3, 0.3, "conc"));   // sella d'appoggio sul ciglio
          el.push(Tx(xb + yb * sl - 1.2, lvl + 0.25, t("wk_src_" + src), 2, "c"), Tx(xi - 0.25, yI - 0.35, t("wk_sInPipe") + " · " + wkLc(t, t("wk_footValve")), 2, "r"));
          if (j === 0) { const xq = xi + cq * Lf, gU = Math.max(yb, (xq - xb) / sl), dSf = Math.max(0.15, (p.dnS || 100) / 1000 * 1.6); subN(t("wk_suction"), cSs, lvl - yI); flN(t("wk_suction"), yI - gU, hF, dSf); el.push(Tx(xq - 0.3, yI - 0.35, "C", 3.4, "r"));   // presa quotata nel dettaglio C (77.89)
            footDet({ xm: xq, yM: yI, lvl, g: gU, gnd: [[[xs + 0.9, 0], [xb, 0], [xb + yb * sl, yb], [xb + yb * sl - 2.2, yb]]], wx0: xb + yb * sl - 2.2, wx1: xb + lvl * sl, vit: [{ ...Pp([[xi - cq * 0.9, yv - sq * 0.9], [xi, yv]], p.dnS), noBeg: 1 }, ...wkAccDraw("foot", xi + cq * Lf / 2, yv + sq * Lf / 2, p.dnS, an * 180 / Math.PI)], cS: cSs, hF, dS: dSf }); } }
        else { const yI = lvl - cSs.S, dSf = Math.max(0.15, (p.dnS || 100) / 1000 * 1.6), hF = flQ(dSf), Lfv = wkAccL("foot", p.dnS); el.push(Pp(sH([ha.suc, [xs, ha.suc[1]], [xs, yI + Lfv]]), p.dnS, "dnS"), ...wkAccDraw("foot", xs, yI + Lfv / 2, p.dnS, -90), { t: "w", x0: xs - 0.55, x1: xs + 0.55, y: lvl }, Tx(xs - 0.8, lvl - 0.25, t("wk_src_" + src), 2, "r"));
          if (src !== "well") { const yb = Math.min(lvl - 1.1, yI - hF); el.push(Lg([[xs - 0.75, 0], [xs - 0.75, yb - 0.15], [xs + 0.75, yb - 0.15], [xs + 0.75, 0]], "k"), Lg([[xs - 0.6, 0], [xs - 0.6, yb], [xs + 0.6, yb], [xs + 0.6, -0.0]], "t"), Tx(xs, yb - 0.6, t("wk_sump"), 2, "c")); if (j === 0) { flN(t("wk_suction"), yI - yb, hF, dSf); el.push(Tx(xs + 0.75, yI - 0.2, "C", 3.4, "l"));   // presa quotata nel dettaglio C (77.89)
            footDet({ xm: xs, yM: yI, lvl, g: yb, gnd: [[[xs - 0.6, lvl + 0.5], [xs - 0.6, yb], [xs + 0.6, yb], [xs + 0.6, lvl + 0.5]]], wx0: xs - 0.6, wx1: xs + 0.6, vit: [{ ...Pp([[xs, lvl + 0.5], [xs, yI + Lfv]], p.dnS), noBeg: 1 }, ...wkAccDraw("foot", xs, yI + Lfv / 2, p.dnS, -90)], cS: cSs, hF, dS: dSf, dx: 0.35 }); } }
          if (src === "well") { const yw = Math.min(lvl - 1.6, yI - 0.6); el.push(Lg([[xs - 0.3, -H], [xs - 0.3, yw]], "k"), Lg([[xs + 0.3, -H], [xs + 0.3, yw]], "k")); }
          if (j === 0) { if (src === "well") subG(el, xs + 1.05, yI, cSs, xs - 0.6, xs + 0.6, null, 0, 1); subN(t("wk_suction"), cSs, lvl - yI); } }
        for (let q = i0; q < el.length; q++) el[q].ug = 1; }   // pozzetto, acqua e quote della fonte: riferiti al piano campagna
      el.push(Pp(pth, p.dnD, "dnD")); c._pth = pth;
      if (j === 0) { accL = p.acc || wkAccAlong(pth, ["flex", "check", "wafer", "gauge"], p.dnD, 0.04);
        if (!p.acc && accL.length && accL[0].k === "flex" && Math.abs(accL[0].r) !== 90) { const fl = wkAccL("flex", p.dnD) + 0.1; accL[0] = { ...accL[0], x: wkR(pth[0][0], 3), y: wkR(pth[0][1] + 0.04 + fl / 2, 3), r: 90 }; }   // giunto antivibrante subito dopo la pompa, sul tratto verticale
        if (!p.acc && fInE && !accL.some(a => a.k === "gauge")) accL.push({ k: "gauge", dn: p.dnD, x: wkR(fInE[0] + 0.45, 3), y: wkR(fInE[1], 3), r: 0 });   // senza posto sulla mandata: il manometro all'ingresso dei filtri
        wkAccPut(el, pos, accL, t); } });
    if (piv) comps.forEach((c, i) => { if (c.k !== "vpump" || c.y > piv[1] + 0.05) return;   // pompa verticale davanti al pivot (78.00): quadro, curva e tubo al pivot restano dietro di lei
      const mine = el.filter(it => it._vpF === i + 1); if (!mine.length) return; const fr = el.filter(it => !it._vpF && it._z != null && it._z < c.y - 0.05), rest = el.filter(it => it._vpF !== i + 1 && !fr.includes(it)); el.length = 0; el.push(...rest, ...mine, ...fr); });
    { const yq = piv ? Math.min(-H - 0.1, -(p.pvPd || WK_PLINTO_D) - 0.25) : -H - 0.1; el.push(Dm([ex0, yq], [ex1, yq], -0.35), Dm([ex1, -H], [ex1, 0], -0.3)); }   // la quota totale passa sotto i plinti
    // platee 30 cm sopra il piano campagna come la piazzola del pivot (77.61): tutto quello che sta sulle platee sale; il terreno,
    // il pozzetto e l'acqua restano dove sono; l'aspirazione sale solo nel tratto fuori terra
    { const Z = H; el[0].ug = 1; const up = (q) => [q[0], q[1] + Z];
      el.forEach(it => { if (it.ug && it.t !== "p") return;
        if (it.t === "p") { it.pts = it.ug ? it.pts.map(q => q[1] >= -0.01 ? up(q) : q) : it.pts.map(up); return; }
        if (it.pts) it.pts = it.pts.map(up); if (it.a) it.a = up(it.a); if (it.b) it.b = up(it.b); if (it.y != null) it.y += Z; }); }   // le posizioni salvate degli accessori restano nel riferimento della platea
    view(t("wk_vElev"), el);
    if (vpDet) view(t(vpC.wl ? "wk_vVpDetW" : "wk_vVpDet"), vpDet, { inset: 1 });
    const vc = (SL ? (SL[2] - SL[0]) * (SL[3] - SL[1]) * H : comps.reduce((m, c, i) => m + (c.k === "vpump" ? 0 : (fr[i].L + 2 * mb) * (fr[i].W + 2 * mb) * H), 0)) + (vpC && !vpC.wl ? vI.length * (((vpC.Z.Lin + 0.6) * (vpC.Z.Win + 0.6) - vpC.Z.Lin * vpC.Z.Win) * (H - vpC.yF) + (vpC.Z.Lin + 0.6) * (vpC.Z.Win + 0.6) * 0.3) : 0), vl = SL ? (SL[2] - SL[0] + 0.2) * (SL[3] - SL[1] + 0.2) * 0.1 : comps.reduce((m, c, i) => m + (c.k === "vpump" ? 0 : (fr[i].L + 2 * mb + 0.2) * (fr[i].W + 2 * mb + 0.2) * 0.1), 0), n = Math.max(1, Math.round(p.fn)); let kgRun = 0;
    // pozzetti (78.29): quello di prelievo delle pompe di superficie col tubo di presa a ~1 m/s; quello aperto della verticale con le sue misure
    if (nSump) { const qS = (+p.Q || 60) / 3600 / nSump, dP = [200, 250, 315, 400, 500, 630, 710, 800, 1000, 1200].find(d => d >= Math.sqrt(4 * qS / Math.PI / 1.0) * 1000) || 1200; qty.push([t("wk_qSump").replace("{d}", dP), nSump, "n°"]); }
    if (vpC && !vpC.wl) qty.push([t("wk_qSumpV").replace("{l}", fmtM(vpC.Z.Lin).replace(" m", "")).replace("{w}", fmtM(vpC.Z.Win).replace(" m", "")), vI.length, "n°"]);
    if (dir) notes.push(t("wk_nDirect"));
    if (diffs.length) qty.push([t("wk_qDiff").replace("{a}", diffs[0]).replace("{b}", p.dnD), diffs.length, "n°"]);
    let vPv = 0;   // calcestruzzo della piazzola del pivot (platea + plinti), come nel piano di fondazione
    if (piv) { const F = p.pvF || WK_PLINTO, Pd = p.pvPd || WK_PLINTO_D, Hs = p.pvCart ? 0 : Math.min(H, p.pvHs || H); vPv = 4 * F * F * (Pd - Hs) + (!p.pvCart && slabK !== "piv" ? Lv * Lv * Hs : 0);
      qty.push([t("wk_qPlinth").split("{s}").join(fmtM(F).replace(" m", "")).split("{d}").join(fmtM(Pd).replace(" m", "")), 4, "n°"]); }
    qty.push([t("wk_qConc"), m3(vc), "m³"]); if (vPv > 0) qty.push([t("wk_qConcPad"), m3(vPv), "m³"]);   // piazzola del pivot (platea e plinti) su una riga sua, contata una volta sola (78.29)
    qty.push([t("wk_qLean"), m3(vl), "m³"], [t("wk_qSteel"), Math.round(vc * 70), "kg"]);
    const cnt = (k) => comps.filter(c => c.k === k).length;
    if (cnt("pump")) { qty.push([t("wk_qKgUnit") + " × " + cnt("pump"), p.pe.kgU, "kg"]); kgRun += cnt("pump") * p.pe.kgU; }
    if (cnt("vpump") && vpC) { qty.push([t("wk_sk_vpump") + " × " + cnt("vpump"), Math.round(vpC.kgDry), "kg"]); kgRun += cnt("vpump") * (vpC.kgDry + vpC.kgWet);
      if (vpC.bm) { const bm = vpC.bm, bmL = vpC.Z.Win + 0.6, nB = 2 * cnt("vpump"), f1 = (v, d) => (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).replace(".", WK_DEC);
        qty.push([t("wk_qBeams").replace("{p}", bm.name), nB + " × " + fmtM(bmL).replace(" m", ""), "m"]); BM.add("civ", "wk_beam_heb" + bm.h + "_" + Math.round(bmL * 100), t("wk_bmBeam").replace("{p}", bm.name).replace("{l}", fmtM(bmL)).replace("{kg}", Math.round(bm.kg * bmL)), nB, "n°");
        if (bm !== vpC.bmC && bm.h !== vpC.bmC.h) notes.push(t("wk_nBeamF").replace("{f}", String(Math.round(vpC.bmF * 10) / 10).replace(".", WK_DEC)).replace("{c}", vpC.bmC.name).replace("{p}", bm.name));
        notes.push(t("wk_bmKgSplit").replace("{m}", Math.round(vpC.kgDry)).replace("{w}", Math.round(vpC.kgWet)), t("wk_nBeamCalc").replace("{p}", bm.name).replace("{l}", fmtM(bm.L)).replace("{q}", bm.nP).replace("{kg}", Math.round(vpC.kgDry + vpC.kgWet)).replace("{P}", f1(bm.P, 1)).replace("{M}", f1(bm.M, 1)).replace("{s}", Math.round(bm.s)).replace("{f}", f1(bm.f, 1)).replace("{fl}", f1(bm.fl, 1))); }
      if (!vpC.wl) { const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2).replace(".", WK_DEC); notes.push(t("wk_nSetVpSump").replace("{l}", fmtM(vpC.Z.Lin)).replace("{w}", fmtM(vpC.Z.Win)).replace("{b}", fmtM(vpC.Z.back)).replace("{f}", fmtM(vpC.Z.front)).replace("{s}", fmtM(vpC.Z.side)).replace("{v}", f2(vpC.vIn)) + " " + t(vpC.vIn <= 0.305 ? "wk_subOk" : "wk_vInKo")); }
      notes.push(t(vpC.wl ? "wk_nSetVpW" : "wk_nSetVp").replace("{n}", vpC.nLs).replace("{l}", fmtM(vpC.Lc)).replace("{s}", fmtM(vpC.S)).replace("{f}", fmtM(vpC.yI - vpC.yF))); }
    if (cnt("moto")) { qty.push([t("wk_qMoto") + " × " + cnt("moto"), p.pm.kgU, "kg"]); kgRun += cnt("moto") * p.pm.kgU; }
    if (cnt("filter")) { const kgF = n * p.fkg + n * p.fkgM, kgW = Math.round(n * Math.PI / 4 * p.fD * p.fD * p.fH * 0.5 * 1000); qty.push([t("wk_filt_" + p.fK) + " × " + cnt("filter"), n + " × " + p.fsz, ""], [t("wk_qKgFilt"), cnt("filter") * kgF, "kg"]); kgRun += cnt("filter") * (kgF + kgW); }
    if (cnt("gen")) { qty.push([t("wk_qKgGen") + " × " + cnt("gen"), p.kgG, "kg"]); kgRun += cnt("gen") * p.kgG; }
    if (cnt("panel")) kgRun += cnt("panel") * 150;
    kgRun += Math.round(wkAccWet(accL));
    qty.push([t("wk_qKgRunAll"), Math.round(kgRun), "kg"]);
    // COMPUTO DEL GRUPPO (77.72): per ogni pompa l'aspirazione dalla fonte e la mandata con i suoi accessori, i collegamenti fra le batterie di filtri e la linea al pivot
    { const np = {};
      pumps.forEach(({ c, i }, j) => { const pc = c.k === "moto" ? p.pm : p.pe, dI = sucDn(i), dO = (pc && pc.dnO) || p.dnD, S = p.dnS;
        const eS = c._sE2 || c._sE, Lh = eS ? Math.hypot(eS[0] - sucS(i)[0], eS[1] - sucS(i)[1]) : sucL, ya = (c._ha && c._ha.suc ? c._ha.suc[1] : 0.4) + H, lift = Math.max(0.5, +p.lift || 2);
        const suc = src === "net" ? [{ k: "end", dn: S }, { k: "pipe", dn: S, L: 1.6 }, { k: "elb", dn: S }, { k: "pipe", dn: S, L: ya + 0.8 }, { k: "elb", dn: S }, { k: "pipe", dn: S, L: Lh }]
          : [{ k: "acc", a: "foot", dn: S }, { k: "pipe", dn: S, L: dir ? ya + 0.8 + (lift + cSs.S - 0.3) * 1.2 : lift + ya + cSs.S - 0.55 }, { k: "elb", dn: S }, { k: "pipe", dn: S, L: Lh }];
        if (c.k !== "vpump") wkBomChain(BM, suc.concat([{ k: "acc", a: "flex", dn: S }, dI < S ? { k: "red", a: S, b: dI, ecc: 1 } : null, { k: "tap", a: "vac" }, { k: "end", dn: dI }]), 1, t);   // aspirazione: dalla fonte alla bocca della pompa
        if (c._pth) { const p0 = pumps[0].c._pth || c._pth, sh = c._pth[0][0] - p0[0][0], acc = (accL || []).map(a => ({ ...a, x: a.x + sh }));
          wkBomChain(BM, [{ k: "end", dn: dO }, dO < p.dnD ? { k: "red", a: dO, b: p.dnD } : null, ...wkBomPath(c._pth, acc, p.dnD, c._dPL), { k: "end", dn: p.dnD }], 1, t); }   // mandata: diffusore, accessori, curve, tubi
        np[c.k] = (np[c.k] || 0) + 1; });
      fElev.forEach((q, j) => { const nx = fElev[j + 1];   // fra una batteria e l'altra, e dall'ultima al pivot (tratto orizzontale con la lunghezza della pianta)
        if (nx) wkBomChain(BM, [{ k: "end", dn: dnC }, ...wkBomPath([[q.xr, q.yO], [nx.xl, q.yO], [nx.xl, nx.yIn]], [], dnC), { k: "end", dn: dnC }], 1, t);
        else if (pvIn) { const dv = { 168: 150, 203: 200, 254: 250 }[p.pvT] || dnC; wkBomChain(BM, [{ k: "end", dn: dnC }, ...wkBomPath([[q.xr, q.yO], [pvIn[0], q.yO], pvIn], [], dnC, outPL), dv !== dnC ? { k: "red", a: dnC, b: dv } : null, { k: "end", dn: dv }], 1, t); }
        else wkBomChain(BM, [{ k: "end", dn: dnC }, { k: "pipe", dn: dnC, L: 0.8 }, { k: "end", dn: dnC }], 1, t); });
      const pm = (k, pc) => BM.add("mach", "wk_m_" + k + (pc && pc.model ? "_" + pc.model : ""), t("wk_sk_" + k) + (pc && pc.model ? " · " + pc.model : "") + (pc && pc.kw ? " · " + pc.kw + " kW" : ""), np[k], "n°");
      if (np.pump) pm("pump", { model: p.model, kw: p.kw }); if (np.vpump) pm("vpump", { model: pv.model, kw: pv.kw }); if (np.moto) pm("moto", { model: p.pm && p.pm.model, kw: p.pm && p.pm.kw });
      if (cnt("gen")) BM.add("mach", "wk_m_gen_" + (p.kvaC || p.kva), t("wk_sk_gen") + " · " + (p.kvaC || p.kva) + " kVA", cnt("gen"), "n°");
      if (cnt("filter")) BM.add("mach", "wk_m_filt_" + p.fK + "_" + String(p.fsz).replace(/[^0-9a-z]/gi, ""), t("wk_filt_" + p.fK) + " · " + n + " × " + p.fsz, cnt("filter"), "n°");
      if (cnt("panel")) BM.add("mach", "wk_m_panel", t("wk_sk_panel"), cnt("panel"), "n°");
      /* plinti del pivot: il loro calcestruzzo è nella riga della piazzola (78.29) */ }
    if (piv && p.pvUltra) notes.push(t("wk_nUltra"));
    { let vA = 0; const am = comps.map((c, i) => { const q = c.k === "pump" ? (p.pe && +p.pe.kwE ? p.pe : p) : c.k === "vpump" && pv ? pv : null, kw = q ? +q.kwE || 0 : 0; if (!(kw > 0)) return null;
        const po = +q.poE === 4 ? 4 : 2, ie = [1, 2, 3].includes(+q.ieE) ? +q.ieE : 3, V = +q.vE > 0 ? +q.vE : 400, a = wkAmps(kw, kw, V, false, po, ie, { hz: +q.hzE || 50 }); if (!vA) vA = V;
        const cb = wkCableSec(a, 15, V, "Cu", 3, 2.5); return (c.k === "vpump" ? "PV" : "P") + nOf(i) + " " + String(kw).replace(".", WK_DEC) + " kW " + po + "p IE" + ie + ": In " + String(Math.round(a * 10) / 10).replace(".", WK_DEC) + " A" + (cb ? ", " + t("wk_cabShort").replace("{s}", String(cb.S).replace(".", WK_DEC)) : ""); }).filter(Boolean);
      if (am.length) notes.push(t("wk_nAmps").replace("{v}", vA || 400).replace("{l}", am.join(" · "))); }   // assorbimento delle elettropompe con poli, classe e tensione della stazione (78.15)
    const pS = pI.filter(i => comps[i].k !== "vpump"); if (pS.length) { const pc = comps[pS[0]].k === "moto" ? p.pm : p.pe, a = Math.min((pc && pc.dnI) || p.dnS, p.dnS); let ns = t("wk_nSucAsm").replace("{a}", a).replace("{b}", p.dnS); if (dir) { const q = ns.split(" · "); q.pop(); ns = q.join(" · ") + "."; } else if (src === "well") { const q = ns.split(" · "); q.pop(); ns = q.join(" · ") + " · " + t("wk_sucFootWell"); } notes.push(ns); }   // fonte pozzo: la valvola di fondo è nel pozzo, non nel pozzetto (78.29)   // pescanti diretti: la valvola di fondo è nella nota sua, non nel pozzetto
    notes.push(t("wk_nLegend") + " " + comps.map((c, i) => (c.k === "gen" ? "G" : c.k === "moto" ? "MP" : c.k === "vpump" ? "PV" : c.k === "pump" ? "P" : c.k === "filter" ? "F" : "QE") + (c.k === "panel" ? "" : nOf(i)) + " " + wkLc(t, t("wk_sk_" + c.k))).join(" · ")
      + (piv ? " · " + t("wk_pivPt").replace("{p}", p.pvLab || "").trim() + (p.pvMk && WK_PAD_MK.includes(p.pvMk) ? "" : "") : "") + " · " + t("wk_nLegPipes").replace("{s}", p.dnS).replace("{d}", p.dnD).replace("{c}", dnC) + ".");   // legenda delle sigle della tavola (77.63)
    notes.push(t("wk_nConc"), t("wk_nRebarSlab").replace("{s}", Math.round(H * 100)), t(slabK === "sep" ? "wk_nSetSep" : "wk_nSet")); if (slabK === "piv") notes.push(t("wk_nSetPiv"));
    if (cnt("filter")) notes.push(t("wk_nFilt_" + p.fK).replace("{q}", p.fq).replace("{n}", n).replace("{s}", p.fsz), t("wk_nFiltCat"));
  }
  if (accL) wkAccQty(qty, notes, accL, t);
  { const nn = Math.max(1, Math.round(+p.n || 1));   // macchine delle tavole singole (77.72)
    if (type === "filter") BM.add("mach", "wk_m_filt_" + p.fK + "_" + String(p.sz).replace(/[^0-9a-z]/gi, ""), t("wk_filt_" + p.fK) + " · " + nn + " × " + p.sz, 1, "n°");
    if (type === "station") BM.add("mach", "wk_m_st_" + (p.kind || "horiz") + (p.model ? "_" + p.model : ""), t("pst_k_" + (p.kind || "horiz")) + (p.model ? " · " + p.model : ""), nn, "n°");
    if (type === "moto") BM.add("mach", "wk_m_moto_" + (p.kw || 0), t("wk_sk_moto") + (p.kw ? " · " + p.kw + " kW" : ""), nn, "n°");
    if (type === "gen") BM.add("mach", "wk_m_gen_" + (p.kvaC || p.kva), t("wk_sk_gen") + " · " + (p.kvaC || p.kva) + " kVA", 1, "n°");
    if (type === "vpump") BM.add("mach", "wk_m_vp" + (p.model ? "_" + p.model : ""), t("pst_k_vert") + (p.model ? " · " + p.model : ""), 1, "n°"); }
  if (type === "station" && +p.kwE > 0) {   // SEZIONI DEI CAVI dal quadro a ogni pompa (78.20)
    const kw = +p.kwE, po = +p.poE === 4 ? 4 : 2, ie = [1, 2, 3].includes(+p.ieE) ? +p.ieE : 3, V = +p.vE > 0 ? +p.vE : 400, In = wkAmps(kw, kw, V, false, po, ie, { hz: +p.hzE || 50 });
    const L = Math.round(p.inst === "well" ? (+p.lift || 30) + (+p.imm || 3) + 12 : p.inst === "float" ? (+p.shore || 10) + 12 : 12), yd = p.stE === "yd", c = wkCableSec(yd ? In / Math.sqrt(3) : In, L, V, "Cu", 3, 2.5), cabT = p.inst === "float" ? "H07RN-F" : "FG16OR16", n = Math.max(1, Math.round(p.n || 1)) * (yd ? 2 : 1);   // stella-triangolo: 2 cavi per motore su In/√3 (78.23)
    if (p.stE) notes.push(t("wk_nStart").replace("{s}", t("pst_st_" + p.stE)).replace("{k}", { dol: "6–7", yd: "2–2" + WK_DEC + "5", soft: "3", vfd: "1" + WK_DEC + "1" }[p.stE]));
    if (c) notes.push((t("wk_nCable") + (yd ? t("wk_nCableYD") : "")).split("FG16OR16").join(cabT).replace("{n}", n).replace("{s}", String(c.S).replace(".", WK_DEC)).replace("{l}", L).replace("{i}", String(Math.round(In * 10) / 10).replace(".", WK_DEC)).replace("{v}", V).replace("{d}", String(Math.round(c.dPct * 10) / 10).replace(".", WK_DEC)).replace("{k}", String(kw).replace(".", WK_DEC)));
    if (c) BM.add("mach", (p.inst === "float" ? "wk_cab_h07rnf_" : "wk_cab_cu_") + String(c.S).replace(".", "_"), t("wk_bmCable").split("FG16OR16").join(cabT).replace("{s}", String(c.S).replace(".", WK_DEC)), n * L, "m");
  }
  return { views: V, notes, qty, pos, acc: accL, lay: layL, bom: wkBomOut(BM, qty, t), dec: WK_DEC, pcs: t("wk_uPcs") };
}
// numeri dei disegni: virgola decimale, metri con due decimali
let WK_DEC = ",";   // separatore decimale della lingua della tavola (78.29): virgola, punto in inglese; lo fissa wkBuild e lo riprende il disegno
const fmtM = (v) => (Math.round(v * 100) / 100).toFixed(2).replace(".", WK_DEC) + " m";

// ---- impaginazione A3 orizzontale (mm) e disegno: lo stesso per SVG e PDF ----
const WK_SCALES = [10, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000];   // le scale grandi servono al reservoir (78.18)
function wkLayout(sheet, mode) {
  const W = 420, H = 297, M = 10, top = 22, areaB = 205, mainV = sheet.views.filter(v => !v.inset || v._noIn), nV = mainV.length, gapV = 12;   // inset (77.86): dettaglio nello spazio libero sotto la vista che lo precede
  const boxH = areaB - top - 14, totW = W - 2 * M - (nV - 1) * gapV;
  // riquadro di ogni vista con i testi (che in carta hanno una misura fissa e in metri dipendono dalla scala)
  const fitsAll = sheet.views.map(v => {
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    const add = (x, y) => { mnx = Math.min(mnx, x); mny = Math.min(mny, y); mxx = Math.max(mxx, x); mxy = Math.max(mxy, y); };
    v.items.forEach(it => {
      if (it.t === "r") { add(it.x, it.y); add(it.x + it.w, it.y + it.h); }
      else if (it.t === "c") { add(it.x - it.r, it.y - it.r); add(it.x + it.r, it.y + it.r); }
      else if (it.t === "l" || it.t === "p" || it.t === "pg") it.pts.forEach(q => add(q[0], q[1]));
      else if (it.t === "g" || it.t === "w") { add(it.x0, it.y); add(it.x1, it.y - 0.3); }
      else if (it.t === "d") { add(it.a[0], it.a[1]); add(it.b[0], it.b[1]); const dx = it.b[0] - it.a[0], dy = it.b[1] - it.a[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L; add(it.a[0] + nx * it.o * 1.15, it.a[1] + ny * it.o * 1.15); }
      else if (it.t === "ld") { add(it.a[0], it.a[1]); add(it.b[0], it.b[1]); }
      else if (it.t === "x" || it.t === "v") add(it.x, it.y);
      else if (it.t === "cut") it.pts.forEach(q => add(q[0], q[1]));
    });
    const cuts = v.items.filter(it => it.t === "cut"), texts = v.items.filter(it => it.t === "x" || it.t === "ld");
    return (N) => { const k = 1000 / N; let a = mnx, b = mny, c = mxx, d = mxy;
      texts.forEach(it => { const w = (String(it.s).length * (it.h || 2.3) * 0.5 + (it.t === "ld" ? 8 : 0)) / k, hh2 = 4 / k;
        const P = it.t === "ld" ? it.b : [it.x, it.y], al = it.t === "ld" ? (it.b[0] >= it.a[0] ? "l" : "r") : it.al;
        const x0 = al === "l" ? P[0] : al === "r" ? P[0] - w : P[0] - w / 2; a = Math.min(a, x0); c = Math.max(c, x0 + w); b = Math.min(b, P[1] - hh2); d = Math.max(d, P[1] + hh2); });
      cuts.forEach(it => [it.pts[0], it.pts[it.pts.length - 1]].forEach(e => { const m = 10 / k; a = Math.min(a, e[0] - m); c = Math.max(c, e[0] + m); b = Math.min(b, e[1] - m); d = Math.max(d, e[1] + m); }));   // frecce e lettere dei tagli: 10 mm di carta oltre gli estremi
      return [a, b, c, d]; };
  });
  // larghezze dei riquadri (77.70): in proporzione a quanto serve a ogni vista, non metà foglio ciascuna (la pianta del gruppo completo sale di scala)
  const fits = mainV.map(v => fitsAll[sheet.views.indexOf(v)]);
  const need = fits.map(f => { const q = f(100); return Math.max(40, (q[2] - q[0]) * 10); }), sumN = need.reduce((a2, x) => a2 + x, 0);
  const bws = nV > 1 ? need.map(n => Math.max(totW * 0.3, Math.min(totW * 0.7, totW * n / sumN))) : [totW], bsc = totW / bws.reduce((a2, x) => a2 + x, 0), BW = bws.map(x => x * bsc), BX = BW.map((x, i) => M + BW.slice(0, i).reduce((a2, y) => a2 + y, 0) + i * gapV);
  const isIn = (q) => q.inset && !q._noIn; const host = []; mainV.forEach((v, i) => {
    const boxW = BW[i], fitAt = fits[i];
    let mnx, mny, mxx, mxy;
    let N = WK_SCALES[WK_SCALES.length - 1], bb = fitAt(N);
    for (const sc of WK_SCALES) { const q = fitAt(sc); if ((q[2] - q[0]) * 1000 / sc <= boxW * 0.94 && (q[3] - q[1]) * 1000 / sc <= boxH * 0.94) { N = sc; bb = q; break; } }
    mnx = bb[0]; mny = bb[1]; mxx = bb[2]; mxy = bb[3];
    const ww = (mxx - mnx) || 1, hh = (mxy - mny) || 1;
    const hasIn = sheet.views.some(isIn);   // con un dettaglio da sistemare: i disegni salgono in cima ai riquadri
    const k = 1000 / N, ox = BX[i] + (boxW - ww * k) / 2, oy = top + 10 + Math.max(0, (boxH - hh * k) * (hasIn ? 0 : 0.35));
    v.N = N; v.k = k; v.box = [BX[i], top, boxW, boxH + 8];
    v.X = (x) => ox + (x - mnx) * k; v.Y = (y) => oy + (mxy - y) * k; host.push({ v, x: BX[i], w: boxW, y1: oy + hh * k });
  });
  let redo = false;
  sheet.views.forEach((v, vi) => { if (!isIn(v) || redo) return;   // nel riquadro della vista principale che lo precede, sotto il suo disegno
    const fitAt = fitsAll[vi], fr = (q) => top + boxH + 2 - (q.y1 + 12);
    const nAt = (q) => { const bh0 = fr(q); if (bh0 < 48) return 1e9; for (const sc of WK_SCALES) { const r = fitAt(sc); if ((r[2] - r[0]) * 1000 / sc <= q.w * 0.9 && (r[3] - r[1]) * 1000 / sc <= bh0 - 9) return sc; } return 1e9; };   // sotto la vista dove il dettaglio viene più grande (78.29)
    const h = host.slice().sort((a2, b2) => nAt(a2) - nAt(b2) || fr(b2) * Math.min(1, b2.w / 120) - fr(a2) * Math.min(1, a2.w / 120))[0];
    const y0 = h.y1 + 12, bh = top + boxH + 2 - y0, bw = h.w; h.y1 = 1e9;   // solo lo spazio che c'è davvero: sotto inizia la fascia delle note
    if (bh < 48) { v._noIn = 1; redo = true; return; }   // troppo poco spazio: il dettaglio torna in una colonna sua
    let N = WK_SCALES[WK_SCALES.length - 1], bb = fitAt(N);
    for (const sc of WK_SCALES) { const q = fitAt(sc); if ((q[2] - q[0]) * 1000 / sc <= bw * 0.9 && (q[3] - q[1]) * 1000 / sc <= bh - 9) { N = sc; bb = q; break; } }
    const k = 1000 / N, ww = (bb[2] - bb[0]) || 1, hh = (bb[3] - bb[1]) || 1, ox = h.x + (bw - ww * k) / 2, oy = y0 + 8 + Math.max(0, (bh - 9 - hh * k) * 0.3);
    v.N = N; v.k = k; v.box = [h.x, y0, bw, bh]; v.X = (x) => ox + (x - bb[0]) * k; v.Y = (y) => oy + (bb[3] - y) * k; });
  if (redo) return wkLayout(sheet, mode);
  // DISPOSIZIONE A RIGHE (78.29): le viste larghe e basse (sezioni con la scarpata, pianta con la presa lunga) stanno meglio una sopra l'altra;
  // si provano tutte le divisioni in righe (nell'ordine delle viste) e si tiene quella con le scale più grandi, se batte quella a colonne
  const all = sheet.views, nA = all.length, lg0 = (N) => Math.log(1000 / N), wv = (v) => v && v.inset ? 0.5 : 1;   // i dettagli contano meno delle viste principali
  const vs = (N, v) => lg0(N) * wv(v) - (v && v.inset && N > 75 ? Math.log(N / 75) : 0);   // un dettaglio più piccolo di 1:75 non serve: penalità
  const dsp = (L2) => { const m = L2.filter(q => !(q[1] && q[1].inset)).map(q => q[0]); return m.length > 1 ? 0.3 * Math.log(Math.max(...m) / Math.min(...m)) : 0; };   // viste principali a scale diverse: piccola penalità
  const scoreCol = all.reduce((a2, v) => a2 + vs(v.N, v), 0) - dsp(all.map(v => [v.N, v])), lg = (N, i) => vs(N, all[i]);
  if (nA >= 2 && nA <= 5) {
    const W0 = W - 2 * M, H0 = boxH + 8, gx = 10, gy = 3, nat = all.map((v, i) => { const q = fitsAll[i](100); return [Math.max(0.5, q[2] - q[0]), Math.max(0.5, q[3] - q[1])]; });
    const fitIn = (i, bw, bh) => { for (const sc of WK_SCALES) { const q = fitsAll[i](sc); if ((q[2] - q[0]) * 1000 / sc <= bw * 0.94 && (q[3] - q[1]) * 1000 / sc <= bh - 10) return [sc, q]; } const sc = WK_SCALES[WK_SCALES.length - 1]; return [sc, fitsAll[i](sc)]; };
    const shares = (a2, lo, hi) => { if (a2.length === 2) { const o = []; for (let f = 0.2; f < 0.81; f += 0.05) o.push([f, 1 - f]); return o; }   // due parti: si prova ogni divisione a passi del 5%
      return [1, 0.5, 0].map(al => { const w = a2.map(x => Math.pow(x, al)), s = w.reduce((p, x) => p + x, 0); return w.map(x => Math.max(lo, Math.min(hi, x / s))); }).map(f => { const s = f.reduce((p, x) => p + x, 0); return f.map(x => x / s); }); };
    let best = null;
    for (let mask = 0; mask < (1 << (nA - 1)); mask++) {
      const rows = [[0]]; for (let i = 1; i < nA; i++) { if (mask & (1 << (i - 1))) rows.push([i]); else rows[rows.length - 1].push(i); }
      if (rows.length < 2 || rows.length > 3 || rows.some(r => r.length > 3)) continue;
      const hs = shares(rows.map(r => Math.max(...r.map(i => nat[i][1]))), 0.25, 0.75);
      hs.forEach(hf => { const cells = []; let y = top, sc0 = 0;
        rows.forEach((r, ri) => { const rh = (H0 - gy * (rows.length - 1)) * hf[ri], ws = r.length > 1 ? shares(r.map(i => nat[i][0]), 0.25, 0.75) : [[1]];
          let bestR = null; ws.forEach(wf => { let x = M, s = 0; const cc = r.map((i, j) => { const bw = (W0 - gx * (r.length - 1)) * wf[j], f = fitIn(i, bw, rh), c = { i, x, y, w: bw, h: rh, N: f[0], q: f[1] }; x += bw + gx; s += lg(f[0], i); return c; }); if (!bestR || s > bestR.s) bestR = { s, cc }; });
          cells.push(...bestR.cc); sc0 += bestR.s; y += rh + gy; });
        { const s3 = sc0 - dsp(cells.map(c => [c.N, all[c.i]])); if (!best || s3 > best.s + 1e-9) best = { s: s3, cells }; } });
    }
    // colonne con le viste una sopra l'altra (una vista alta a sinistra, sezione e dettaglio impilati a destra)
    for (let mask = 0; mask < (1 << (nA - 1)); mask++) {
      const cols = [[0]]; for (let i = 1; i < nA; i++) { if (mask & (1 << (i - 1))) cols.push([i]); else cols[cols.length - 1].push(i); }
      if (cols.length < 2 || cols.length > 3 || cols.every(r => r.length < 2) || cols.some(r => r.length > 3)) continue;
      const wsO = shares(cols.map(r => Math.max(...r.map(i => nat[i][0]))), 0.2, 0.8);
      wsO.forEach(wf => { const cells = []; let x = M, sc0 = 0;
        cols.forEach((r, ci) => { const cw = (W0 - gx * (cols.length - 1)) * wf[ci], hs2 = r.length > 1 ? shares(r.map(i => nat[i][1]), 0.25, 0.75) : [[1]];
          let bestC = null; hs2.forEach(hf => { let y = top, s = 0; const cc = r.map((i, j) => { const bh = (H0 - gy * (r.length - 1)) * hf[j], f = fitIn(i, cw, bh), c = { i, x, y, w: cw, h: bh, N: f[0], q: f[1] }; y += bh + gy; s += lg(f[0], i); return c; }); if (!bestC || s > bestC.s) bestC = { s, cc }; });
          cells.push(...bestC.cc); sc0 += bestC.s; x += cw + gx; });
        { const s3 = sc0 - dsp(cells.map(c => [c.N, all[c.i]])); if (!best || s3 > best.s + 1e-9) best = { s: s3, cells }; } });
    }
    if (best && best.s > scoreCol + 0.2) best.cells.forEach(c => { const v = all[c.i], k = 1000 / c.N, q = c.q, ww = (q[2] - q[0]) || 1, hh = (q[3] - q[1]) || 1, ox = c.x + (c.w - ww * k) / 2, oy = c.y + 9 + Math.max(0, (c.h - 10 - hh * k) * 0.35);
      v.N = c.N; v.k = k; v.box = [c.x, c.y, c.w, c.h]; v.X = (x) => ox + (x - q[0]) * k; v.Y = (y) => oy + (q[3] - y) * k; });
  }
  // dettagli in una colonna loro (78.29): se sotto le viste non c'è posto per un dettaglio leggibile, si prova a dargli una colonna e si tiene la disposizione migliore
  if (!mode && all.some(v => v.inset && !v._noIn)) {
    const sc1 = all.reduce((a2, v) => a2 + vs(v.N, v), 0) - dsp(all.map(v => [v.N, v])), keep = all.map(v => ({ N: v.N, k: v.k, box: v.box, X: v.X, Y: v.Y, _noIn: v._noIn }));
    all.forEach(v => { if (v.inset) v._noIn = 1; }); wkLayout(sheet, "noin");
    const sc2 = all.reduce((a2, v) => a2 + vs(v.N, v), 0) - dsp(all.map(v => [v.N, v]));
    if (!(sc2 > sc1 + 0.2)) all.forEach((v, i) => Object.assign(v, keep[i]));
  }
  return { W, H, M, areaB };
}
// disegno astratto: cb.{line(pts,w,dash,color), rect, circle, text(x,y,s,h,align,bold), fillRect(x,y,w,h,gray), fillPoly}
// SCRITTE CHE NON SI SOVRAPPONGONO (77.84): sulla carta (mm) i riquadri dei testi; le quote restano ferme, le sigle e i richiami si spostano
// a gradini (prima in verticale, poi di lato) finché non toccano più nessun altro testo; restituisce una copia degli elementi della vista
// TRACCIA DI UN TAGLIO (78.29) in carta: linea mista, tratti forti di 4 mm agli estremi, frecce di 6 mm nel verso di vista, lettera oltre l'estremo
function wkCutGeo(it, X, Y) {
  const P = it.pts.map(q => [X(q[0]), Y(q[1])]), un = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  const u0 = un(P[0], P[1]), nv = [u0[1] * it.sg, -u0[0] * it.sg];   // in carta l'asse y scende: la normale a sinistra del percorso
  const ends = [[P[0], P[1]], [P[P.length - 1], P[P.length - 2]]].map(([E, q]) => { const u = un(q, E), tip = [E[0] + nv[0] * 6, E[1] + nv[1] * 6];
    return { tick: [[E[0] - u[0] * 4, E[1] - u[1] * 4], E], arrow: [E, tip], head: [[tip[0] - nv[0] * 1.8 + u[0] * 0.9, tip[1] - nv[1] * 1.8 + u[1] * 0.9], tip, [tip[0] - nv[0] * 1.8 - u[0] * 0.9, tip[1] - nv[1] * 1.8 - u[1] * 0.9]], txt: [E[0] + u[0] * 3.2 + nv[0] * 3, E[1] + u[1] * 3.2 + nv[1] * 3 + 1.2] }; });
  return { P, ends };
}
function wkDeclutter(items, X, Y, k, box) {
  const out = items.slice(), fixed = [], placed = [], hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const tw = (s, h) => [...String(s)].reduce((a, ch) => a + h * (/[A-Z0-9MW×Ø]/.test(ch) ? 0.82 : /[ il.,:;'|]/.test(ch) ? 0.36 : 0.66), 0);   // larghezza stimata del testo (mm), maiuscole e cifre più larghe
  const tb = (x, y, s, h, al) => { const w = tw(s, h), x0 = al === "l" ? x : al === "r" ? x - w : x - w / 2; return [x0 - 0.7, y - h * 1.05, x0 + w + 0.7, y + h * 0.45]; };   // con un margine: le scritte non si toccano
  // OSTACOLI DEL DISEGNO (77.85): tratti (linee, tubi con il loro spessore, quote, pelo dell'acqua, terreno), riquadri pieni (macchine, calcestruzzo), contorni di cerchi
  const segs = [], areas = [], rings = [];
  let own = -1; const sg = (P, hw) => { for (let q = 1; q < P.length; q++) segs.push([P[q - 1][0], P[q - 1][1], P[q][0], P[q][1], hw || 0.25, own]); };
  items.forEach((it, ii) => { own = ii;
    if (it.inv) return;
    if (it.t === "l") sg(it.pts.map(q => [X(q[0]), Y(q[1])]), 0.3);
    else if (it.t === "p") sg(it.pts.map(q => [X(q[0]), Y(q[1])]), Math.max(0.5, Math.max(0.05, (it.dn || 100) / 1000 * 1.1) * k * 0.68));   // tubo con le flange
    else if (it.t === "w") sg([[X(it.x0), Y(it.y)], [X(it.x1), Y(it.y)]], 0.4);
    else if (it.t === "g") { const y = Y(it.y); areas.push([Math.min(X(it.x0), X(it.x1)), y - 0.4, Math.max(X(it.x0), X(it.x1)), y + 1.8]); }   // terreno con il tratteggio
    else if (it.t === "r") { const x0 = X(it.x), y0 = Y(it.y + it.h), w = it.w * k, h = it.h * k;
      if (it.s === "conc" || it.s === "eq" || it.s === "lean" || (w < 6 && h < 6)) areas.push([x0 - 0.3, y0 - 0.3, x0 + w + 0.3, y0 + h + 0.3]); else sg([[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]], 0.35); }
    else if (it.t === "pg") { const P = it.pts.map(q => [X(q[0]), Y(q[1])]); let a = 1e9, b = 1e9, c = -1e9, d = -1e9; P.forEach(q => { a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[0]); d = Math.max(d, q[1]); });
      if ((c - a) * (d - b) < 2500) areas.push([a - 0.3, b - 0.3, c + 0.3, d + 0.3]); else sg(P.concat([P[0]]), 0.3); }   // macchine: la loro sagoma; poligoni molto grandi solo il contorno
    else if (it.t === "c") rings.push([X(it.x), Y(it.y), it.r * k]);
    else if (it.t === "ld") { const a = [X(it.a[0]), Y(it.a[1])], b = [X(it.b[0]), Y(it.b[1])], r = b[0] >= a[0]; sg([a, b, [b[0] + (r ? 6 : -6), b[1]]], 0.25); }   // linee di richiamo
    else if (it.t === "v") areas.push([X(it.x) - 2, Y(it.y) - 2, X(it.x) + 2, Y(it.y) + 2]);
    else if (it.t === "cut") { const g = wkCutGeo(it, X, Y); sg(g.P, 0.2); g.ends.forEach(e => { sg(e.tick, 0.4); sg(e.arrow, 0.3); }); }
    else if (it.t === "d") { const ax = X(it.a[0]), ay = Y(it.a[1]), bx2 = X(it.b[0]), by2 = Y(it.b[1]), dx = bx2 - ax, dy = by2 - ay, Ln = Math.hypot(dx, dy) || 1, nx = dy / Ln, ny = -dx / Ln, o = it.o * k;
      sg([[ax + nx * o, ay + ny * o], [bx2 + nx * o, by2 + ny * o]], 0.6); sg([[ax, ay], [ax + nx * o, ay + ny * o]], 0.3); sg([[bx2, by2], [bx2 + nx * o, by2 + ny * o]], 0.3); } });
  const segHit = (b, s2) => { const e = s2[4], r = [b[0] - e, b[1] - e, b[2] + e, b[3] + e], [x1, y1, x2, y2] = s2;
    if (Math.max(x1, x2) < r[0] || Math.min(x1, x2) > r[2] || Math.max(y1, y2) < r[1] || Math.min(y1, y2) > r[3]) return false;
    const inR = (x, y) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]; if (inR(x1, y1) || inR(x2, y2)) return true;
    const dx = x2 - x1, dy = y2 - y1; let t0 = 0, t1 = 1; const cl = (pp, q) => { if (Math.abs(pp) < 1e-12) return q >= 0; const tt = q / pp; if (pp < 0) { if (tt > t1) return false; if (tt > t0) t0 = tt; } else { if (tt < t0) return false; if (tt < t1) t1 = tt; } return true; };
    return cl(-dx, x1 - r[0]) && cl(dx, r[2] - x1) && cl(-dy, y1 - r[1]) && cl(dy, r[3] - y1) && t0 <= t1; };
  const ringHit = (b, c) => { const nx = Math.max(b[0], Math.min(c[0], b[2])), ny = Math.max(b[1], Math.min(c[1], b[3])), dn = Math.hypot(nx - c[0], ny - c[1]), df = Math.max(Math.hypot(b[0] - c[0], b[1] - c[1]), Math.hypot(b[2] - c[0], b[1] - c[1]), Math.hypot(b[0] - c[0], b[3] - c[1]), Math.hypot(b[2] - c[0], b[3] - c[1])); return dn <= c[2] + 0.3 && df >= c[2] - 0.3; };   // tocca la circonferenza (dentro il cerchio va bene)
  const geoHit = (b, skip) => segs.some(s2 => s2[5] !== skip && segHit(b, s2)) || areas.some(a => hit(a, b)) || rings.some(c => ringHit(b, c));
  const inBox = (b) => !box || (b[0] >= box[0] - 2 && b[2] <= box[0] + box[2] + 2 && b[1] >= box[1] + 6 && b[3] <= box[1] + box[3] + 2);
  items.forEach((it, i) => { if (it.t !== "d") return;   // testo della quota, come lo scrive il disegno; se tocca un'altra quota scorre lungo la linea
    const ax = X(it.a[0]), ay = Y(it.a[1]), bx2 = X(it.b[0]), by2 = Y(it.b[1]), dx = bx2 - ax, dy = by2 - ay, Ln = Math.hypot(dx, dy) || 1, ux = dx / Ln, uy = dy / Ln, nx = uy, ny = -ux, o = it.o * k, sg2 = Math.sign(o) || 1;
    const vert = Math.abs(ux) < 0.5, txt = it.txt || (Math.round(Ln / k * 100) / 100).toFixed(2), w = tw(txt, 2.5); let tf = 0;
    const bx = (t2) => { const sd = tf ? -sg2 : sg2, cx = (ax + bx2) / 2 + nx * o + nx * sd * 2.2 + ux * t2, cy = (ay + by2) / 2 + ny * o + ny * sd * 2.2 + uy * t2; return vert ? [cx - 3.0, cy - w / 2 - 0.5, cx + 4.2, cy + w / 2 + 0.5] : [cx - w / 2 - 0.4, cy + 0.9 - 2.9, cx + w / 2 + 0.4, cy + 0.9 + 0.9]; };   // riquadro largo da tutti e due i lati della linea del testo
    const shr = (b) => vert ? [b[0] + 0.8, b[1], b[2] - 0.8, b[3]] : [b[0], b[1] + 0.8, b[2], b[3] - 0.8];   // per il disegno conta solo dove stanno le lettere
    const lim = Ln / 2 + w / 2 + 1.5;   // il numero resta accanto alla sua quota, al più appena oltre la fine
    const short = Ln < Math.max(8, w + 2), o1 = Ln / 2 + w / 2 + 1.6;   // QUOTE CORTE (78.29): il numero non ci sta fra i trattini, va fuori dalla linea, sul suo prolungamento
    const tl = short ? [o1, -o1, o1 + 2, -(o1 + 2), o1 + 4, -(o1 + 4), o1 + 7, -(o1 + 7)] : [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8, 9, -9, 10, -10, 12, -12].map(r => r * Math.max(1.5, w * 0.2));
    let ts = null, tsS = null, tfS = 0; for (const L2 of short ? [o1 + 7.5] : [lim, lim * 3]) { for (const side of [0, 1]) { tf = side; for (const t2 of tl) { if (Math.abs(t2) > L2) continue; const bb = bx(t2); if (fixed.some(f => hit(f, bb))) continue; if (box && !inBox(shr(bb))) continue; if (tsS == null) { tsS = t2; tfS = side; } if (!geoHit(shr(bb), i)) { ts = t2; break; } } if (ts != null) break; } if (ts != null || tsS != null) break; }   // prima dal suo lato, poi dall'altro lato della linea   // libera dalle altre quote e, se si può, dal disegno; tra quote fitte il numero va un po' più in là
    if (ts == null) { ts = tsS != null ? tsS : 0; tf = tfS; }
    fixed.push(bx(ts)); if (ts || tf) out[i] = { ...it, _ts: ts, _tf: tf }; });
  items.forEach(it => { if (it.t === "cut") wkCutGeo(it, X, Y).ends.forEach(e => fixed.push(tb(e.txt[0], e.txt[1], it.lab, 3.4, "c"))); });   // lettere dei tagli: ferme, le altre scritte le evitano (78.29)
  // posizioni candidate per distanza crescente, in otto direzioni (in orizzontale si va più lontano: le scritte sono larghe)
  const cand = [[0, 0]]; for (let r = 1; r <= 16; r++) for (let a = 0; a < 16; a++) { const an = a * Math.PI / 8; cand.push([Math.cos(an) * r * 1.6, Math.sin(an) * r]); }
  cand.sort((p1, p2) => Math.hypot(p1[0] / 1.6, p1[1]) - Math.hypot(p2[0] / 1.6, p2[1]));
  const order = items.map((it, i) => i).filter(i => (items[i].t === "x" || items[i].t === "ld") && items[i].s && !items[i].fix).sort((a, b) => String(items[b].s).length - String(items[a].s).length);   // prima le scritte lunghe, che hanno meno posti liberi
  order.forEach(i => { const it = items[i];
    let b0, h; if (it.t === "x") { h = it.h || 2.6; b0 = tb(X(it.x), Y(it.y), it.s, h, it.al); }
    else { h = 2.3; const a = [X(it.a[0]), Y(it.a[1])], bp = [X(it.b[0]), Y(it.b[1])], r = bp[0] >= a[0]; b0 = tb(bp[0] + (r ? 7 : -7), bp[1] + 0.9, it.s, h, r ? "l" : "r"); }
    const st = h * 1.1, txtHit = (bb) => fixed.some(f => hit(f, bb)) || placed.some(f => hit(f, bb)), anc = it.t === "x" ? [X(it.x), Y(it.y) - h * 0.35] : null;
    const thr = (bb) => { const q = [Math.max(bb[0], Math.min(bb[2], anc[0])), Math.max(bb[1], Math.min(bb[3], anc[1]))]; return [q[0], q[1], anc[0], anc[1], 0.15]; };   // filo dalla scritta al suo oggetto
    const thrBad = (bb, dx, dy) => { if (!anc || Math.hypot(dx, dy) <= h * 1.6) return false; const t2 = thr(bb); return fixed.concat(placed).some(f => segHit([f[0] + 0.4, f[1] + 0.4, f[2] - 0.4, f[3] - 0.4], t2)); };   // il filo non deve attraversare altre scritte
    let best = null, soft = null, soft2 = null;
    for (const [sx, sy] of cand) { const dx = sx * st, dy = sy * st, bb = [b0[0] + dx, b0[1] + dy, b0[2] + dx, b0[3] + dy];
      if ((sx || sy) && !inBox(bb)) continue; if (txtHit(bb)) continue; if (!soft2) soft2 = [dx, dy, bb]; if (thrBad(bb, dx, dy)) continue;
      if (!soft) soft = [dx, dy, bb]; if (!geoHit(bb)) { best = [dx, dy, bb]; break; } }   // libera da testi e disegno; se non c'è, almeno dai testi
    best = best || soft || soft2; if (!best) { placed.push(b0); return; }   // ultimo ripiego: almeno libera dalle altre scritte
    placed.push(best[2]); if (!best[0] && !best[1]) return;
    const mdx = best[0] / k, mdy = -best[1] / k;   // carta → metri (l'asse y della carta scende)
    const far = Math.hypot(best[0], best[1]) > h * 1.6, bb = best[2];   // spostata di molto: un filo sottile la riporta al suo oggetto
    if (far && anc) { const t2 = thr(bb); segs.push([t2[0], t2[1], t2[2], t2[3], 0.3, -2]); placed.push([Math.min(t2[0], t2[2]) - 0.2, Math.min(t2[1], t2[3]) - 0.2, Math.max(t2[0], t2[2]) + 0.2, Math.max(t2[1], t2[3]) + 0.2].map((v, q) => v)); placed.pop(); }   // il filo diventa un ostacolo per le scritte che seguono
    out[i] = it.t === "x" ? { ...it, x: it.x + mdx, y: it.y + mdy, ...(far ? { _lk: [X(it.x), Y(it.y) - h * 0.35], _bb: bb } : {}) } : { ...it, b: [it.b[0] + mdx, it.b[1] + mdy] }; });
  return out;
}
function wkDraw(sheet, cb, meta) {
  if (sheet.dec) WK_DEC = sheet.dec;
  const L = wkLayout(sheet), { W, H, M, areaB } = L;
  const STY = { a: [0.2, null, 0], wh: [0.45, null, 0, [255, 255, 255]], m: [0.35, null, 0], k: [0.5, null, 0], t: [0.25, null, 0], h: [0.25, [2, 1.2], 0], cl: [0.18, [6, 1.2, 1, 1.2], 0], eq: [0.35, null, 0], el: [0.3, [1.6, 1.1], 0, [225, 29, 72]] };   // el: cavo / cavidotto elettrico, rosso come le linee elettriche di Ceres
  // stessa grafica delle planimetrie di Ceres: verde scuro per i testi, etichette grigio-verdi, filetti verdi, cartiglio a celle con il logo
  const INK = [18, 53, 36], LAB = [90, 115, 101], LIN = [120, 150, 130], fY = H - M - 4 - 20;   // fY: cima del cartiglio
  cb.rect(M - 4, M - 4, W - 2 * M + 8, H - 2 * M + 2, 0.4, null, LIN);
  // intestazione
  cb.text(M, M + 4, meta.title, 5, "l", true, 0, INK);
  cb.text(M, M + 9.5, meta.sub, 3, "l", false, 0, LAB);
  sheet.views.forEach(v => {
    const [bx, by, bw, bh] = v.box, X = v.X, Y = v.Y, k = v.k;
    v._pp = v.items.filter(it => it.t === "p").map(it => ({ it, dn: it.dn || 100, P: it.pts.map(q => [X(q[0]), Y(q[1])]) }));   // tubi della vista: per le riduzioni agli innesti
    if (!v.noTitle) { const ttl = v.title.toUpperCase() + "  ·  1:" + v.N, tw2 = (cb.tw ? cb.tw(ttl, 3, true) : String(ttl).length * 3 * 0.62) / 2 + 2;   // sottolineatura larga quanto il titolo (78.29)
      cb.text(bx + bw / 2, by + 4, ttl, 3, "c", true); cb.line([[bx + bw / 2 - tw2, by + 5.6], [bx + bw / 2 + tw2, by + 5.6]], 0.25); }   // la pianta grande della finestra non ha il titolo (77.94)
    let curG = null;
    wkDeclutter(v.items, X, Y, k, v.box).forEach(it => {
      if ((it.g || null) !== curG) { if (curG && cb.gEnd) cb.gEnd(); curG = it.g || null; if (curG && cb.gStart) cb.gStart(curG, k, v.drag); }
      if (it.t === "pg") {   // poligono chiuso con riempimento (disegni delle macchine)
        const pts = it.pts.map(q => [X(q[0]), Y(q[1])]); if (it.f != null) cb.fillPoly(pts, Array.isArray(it.f) ? it.f : [it.f, it.f, it.f]);
        if (it.s === "-") return; const st = STY[it.s] || STY.k; cb.line(pts.concat([pts[0]]), it.s === "a" || it.wm ? Math.max(0.06, Math.min(0.16, k * 0.004)) : it.w || st[0], st[1]); return;   // macchine: un solo spessore per vista
      }
      if (it.t === "r") {
        const x = X(it.x), y = Y(it.y + it.h), w = it.w * k, h = it.h * k;
        if (it.s === "conc") { cb.fillRect(x, y, w, h, 232); cb.hatch(x, y, w, h, 1.8); cb.rect(x, y, w, h, 0.5); }
        else if (it.s === "lean") { cb.fillRect(x, y, w, h, 205); cb.rect(x, y, w, h, 0.25); }
        else if (it.s === "eq") { cb.fillRect(x, y, w, h, 244); cb.rect(x, y, w, h, STY.eq[0]); }
        else { const st = STY[it.s] || STY.k; cb.rect(x, y, w, h, st[0], st[1]); }
      } else if (it.t === "c") {
        const st = STY[it.s] || STY.k; if (it.s === "eq") cb.circle(X(it.x), Y(it.y), it.r * k, st[0], null, 244); else cb.circle(X(it.x), Y(it.y), it.r * k, it.s === "a" || it.wm ? Math.max(0.06, Math.min(0.16, k * 0.004)) : st[0], st[1], it.fg);
      } else if (it.t === "l") { const st = STY[it.s] || STY.k, P = it.pts.map(q => [X(q[0]), Y(q[1])]); if (!it.inv) cb.line(P, it.s === "a" || it.wm ? Math.max(0.06, Math.min(0.16, k * 0.004)) : st[0], st[1], st[3]); if (it.we && cb.wallEd) cb.wallEd(it.we, P, 3.2); }   // we: parete cliccabile (77.82)
      else if (it.t === "p" && it.cone) {   // DIFFUSORE / RIDUZIONE CONCENTRICA (77.63): cono flangiato dal Ø della bocca (dn) al Ø del tubo (cone)
        const odOf = (dn) => Math.max(0.05, (dn || 100) / 1000 * 1.1) * k, a = [X(it.pts[0][0]), Y(it.pts[0][1])], b = [X(it.pts[1][0]), Y(it.pts[1][1])], INK = [29, 42, 36], lw = Math.max(0.06, Math.min(0.16, k * 0.004));
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, u = [(b[0] - a[0]) / l, (b[1] - a[1]) / l], nn = [-u[1], u[0]], ra = odOf(it.dn) / 2, rb = odOf(it.cone) / 2;
        const Q = [[a[0] + nn[0] * ra, a[1] + nn[1] * ra], [b[0] + nn[0] * rb, b[1] + nn[1] * rb], [b[0] - nn[0] * rb, b[1] - nn[1] * rb], [a[0] - nn[0] * ra, a[1] - nn[1] * ra]];
        cb.fillPoly(Q, [255, 255, 255]); cb.line([Q[0], Q[1]], lw, null, INK); cb.line([Q[2], Q[3]], lw, null, INK);
        [[a, it.dn, 1], [b, it.cone, -1]].forEach(([c, dn, side]) => { const d = (dn || 100) / 1000, D = (1.35 * d + 0.085) * k, bb = Math.max(0.35, (0.018 + 0.03 * d) * k), e = Math.max(D / 2, odOf(dn) / 2 * 1.25), h0 = side < 0 ? -bb : 0, h1 = side < 0 ? 0 : bb;
          const P2 = (s2, w) => [c[0] + u[0] * s2 + nn[0] * w, c[1] + u[1] * s2 + nn[1] * w], box = [P2(h0, e), P2(h1, e), P2(h1, -e), P2(h0, -e)]; cb.fillPoly(box, [255, 255, 255]); cb.line(box.concat([box[0]]), lw, null, INK); }); }
      else if (it.t === "p") {   // TUBO FLANGIATO (77.54–77.60): gomiti a raggio lungo, contorni sottili come le macchine; flange EN 1092-1 PN 16 di lato (diametro esterno e spessore in scala, assi dei bulloni); riduzioni coniche agli innesti in tubi più grandi
        const odOf = (dn) => Math.max(0.05, (dn || 100) / 1000 * 1.1) * k, P = it.pts.map(q => [X(q[0]), Y(q[1])]), od = odOf(it.dn), INK = [29, 42, 36], ORG = INK, FILL = [255, 255, 255]; const FJ0 = [];   // al tratto nero come flange e macchine (77.61)
        const lw = Math.max(0.06, Math.min(0.16, k * 0.004));   // stesso spessore delle macchine
        if (cb.pipeMeta) cb.pipeMeta(P);
        if (it.ek && cb.pipeEd) FJ0.push(() => cb.pipeEd({ k: it.ek, dn: it.dn || 100 }, P, Math.max(2.4, od)));
        if (od < 0.9) cb.line(P, Math.max(0.7, Math.min(2.2, od * 0.9)), null, ORG);   // troppo piccolo in scala: linea piena
        else { const r = od / 2, step = 6 * k, U = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
          // flangia di lato: spessore b e diametro esterno D da EN 1092-1 PN 16 (approssimati sul DN), interasse dei bulloni K
          const fl = (dn) => { const d = (dn || 100) / 1000; return { D: (1.35 * d + 0.085) * k, b: Math.max(0.35, (0.018 + 0.03 * d) * k), K: (1.12 * d + 0.05) * k }; };
          const flange = (c, u, dn, side) => { const f = fl(dn), nn = [-u[1], u[0]], e = Math.max(f.D / 2, (odOf(dn) / 2) * 1.25), h0 = side < 0 ? -f.b : 0, h1 = side < 0 ? 0 : f.b;   // side: la flangia sta prima (−) o dopo (+) il punto
            const Q = (a, w) => [c[0] + u[0] * a + nn[0] * w, c[1] + u[1] * a + nn[1] * w], box = [Q(h0, e), Q(h1, e), Q(h1, -e), Q(h0, -e)];
            cb.fillPoly(box, [255, 255, 255]); cb.line(box.concat([box[0]]), lw, null, INK);
            [-1, 1].forEach(sg => { const kk = Math.min(f.K / 2, e * 0.86) * sg; cb.line([Q(h0 - f.b * 0.45, kk), Q(h1 + f.b * 0.45, kk)], lw * 0.8, [1.6, 0.5, 0.3, 0.5], INK); }); };   // assi dei bulloni
          const body = (a, b, ra, rb) => { const u = U(a, b), nn = [-u[1], u[0]]; cb.fillPoly([[a[0] + nn[0] * ra, a[1] + nn[1] * ra], [b[0] + nn[0] * rb, b[1] + nn[1] * rb], [b[0] - nn[0] * rb, b[1] - nn[1] * rb], [a[0] - nn[0] * ra, a[1] - nn[1] * ra]], FILL);
            cb.line([[a[0] + nn[0] * ra, a[1] + nn[1] * ra], [b[0] + nn[0] * rb, b[1] + nn[1] * rb]], lw, null, ORG); cb.line([[a[0] - nn[0] * ra, a[1] - nn[1] * ra], [b[0] - nn[0] * rb, b[1] - nn[1] * rb]], lw, null, ORG); };
          const FJ = [];   // flange da disegnare sopra al tubo
          // CURVE (77.60): gomito flangiato a raggio lungo (asse R = 1,5 × Ø esterno) disegnato come settore d'anello; i tratti dritti
          // si fermano ai punti di tangenza, dove il gomito si imbulona al tubo con una coppia di flange (staccate da quelle dell'altro lato)
          const cr = (p, q) => p[0] * q[1] - p[1] * q[0], BD = [];
          for (let j = 1; j < P.length - 1; j++) {
            const u1 = U(P[j - 1], P[j]), u2 = U(P[j], P[j + 1]), th = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]))), sg = Math.sign(cr(u1, u2));
            if (th < 0.02 || !sg) { BD[j] = null; continue; }
            const L1 = Math.hypot(P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]), L2 = Math.hypot(P[j + 1][0] - P[j][0], P[j + 1][1] - P[j][1]), tn = Math.tan(th / 2);
            const lim = Math.min((j === 1 ? 0.92 : 0.45) * L1, (j === P.length - 2 ? 0.92 : 0.45) * L2), R = Math.min(od * (it.rf || 1.5), lim / tn);   // rf: raggio della curva in diametri (collo d'oca del pivot: stretto)   // all'estremità il gomito può arrivare fino all'attacco
            if (R < r * 1.15) { BD[j] = { miter: true }; continue; }
            const T = R * tn, A = [P[j][0] - u1[0] * T, P[j][1] - u1[1] * T], B = [P[j][0] + u2[0] * T, P[j][1] + u2[1] * T], n1 = sg > 0 ? [-u1[1], u1[0]] : [u1[1], -u1[0]];
            const F0 = fl(it.dn), need = Math.max(F0.D / 2, r * 1.25) + F0.b * 1.5;   // le flange ai due capi del gomito non devono toccarsi
            const offA = j === 1 && L1 - T < need, offB = j === P.length - 2 && L2 - T < need;   // il gomito arriva quasi all'attacco: si imbulona lì
            BD[j] = { A, B, u1, u2, C: [A[0] + n1[0] * R, A[1] + n1[1] * R], R, sg, th, one: offA ? "A" : offB ? "B" : T < need ? (L1 - T < L2 - T ? "A" : "B") : null };
          }
          const elbow = (e) => { const a0 = Math.atan2(e.A[1] - e.C[1], e.A[0] - e.C[0]), n = Math.max(8, Math.ceil(e.th / 0.08)), arc = (rr) => { const o = []; for (let i = 0; i <= n; i++) { const t2 = a0 + e.sg * e.th * i / n; o.push([e.C[0] + Math.cos(t2) * rr, e.C[1] + Math.sin(t2) * rr]); } return o; };
            const out = arc(e.R + r), inn = arc(e.R - r); cb.fillPoly(out.concat(inn.slice().reverse()), FILL); cb.line(out, lw, null, ORG); cb.line(inn, lw, null, ORG); };
          for (let j = 0; j < P.length - 1; j++) {
            const e0 = BD[j], e1 = BD[j + 1], a = e0 && !e0.miter ? e0.B : P[j], b = e1 && !e1.miter ? e1.A : P[j + 1], Ls = Math.hypot(b[0] - a[0], b[1] - a[1]); if (Ls < 1e-6) continue; const u = U(a, b);
            const ex0 = e0 && e0.miter ? r : 0, ex1 = e1 && e1.miter ? r : 0;   // spigolo vivo (curva che non ci sta): i tubi si incontrano
            body([a[0] - u[0] * ex0, a[1] - u[1] * ex0], [b[0] + u[0] * ex1, b[1] + u[1] * ex1], r, r);
            const fe = fl(it.dn).b * 3;   // giunti intermedi lontani dalle flange del gomito
            for (let tt = step; tt < Ls - step * 0.3; tt += step) { if (tt < fe || tt > Ls - fe) continue; const c = [a[0] + u[0] * tt, a[1] + u[1] * tt]; if (!it.nf) FJ.push([c, u, it.dn, -1], [c, u, it.dn, 1]); } }
          for (let j = 1; j < P.length - 1; j++) { const e = BD[j]; if (!e || e.miter) continue; elbow(e); if (it.nf) continue;
            if (e.one !== "A") FJ.push([e.A, e.u1, it.dn, -1], [e.A, e.u1, it.dn, 1]);   // senza spazio per due giunzioni: una sola, verso il tratto più lungo
            if (e.one !== "B") FJ.push([e.B, e.u2, it.dn, -1], [e.B, e.u2, it.dn, 1]); }
          const onP = (E, Q, tol) => { for (let j = 0; j < Q.length - 1; j++) { const a = Q[j], b = Q[j + 1], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1, tt = Math.max(0, Math.min(1, ((E[0] - a[0]) * dx + (E[1] - a[1]) * dy) / l2)); if (Math.hypot(E[0] - a[0] - dx * tt, E[1] - a[1] - dy * tt) <= tol) return true; } return false; };
          [0, P.length - 1].forEach(ei => { if (it.noEnd && ei === P.length - 1) return; if (it.noBeg && ei === 0) return; const E = P[ei], u = ei === 0 ? U(P[0], P[1]) : U(P[P.length - 1], P[P.length - 2]);
            const big = (v._pp || []).filter(q => q.it !== it && q.dn > (it.dn || 100) && onP(E, q.P, odOf(q.dn) / 2 + 0.3)).sort((a, b) => b.dn - a.dn)[0];
            if (big) { const R2 = odOf(big.dn) / 2, Lr = Math.max(R2 * 2.2, 1.2), F = [E[0] + u[0] * Lr, E[1] + u[1] * Lr]; body(E, F, R2, r); FJ.push([E, u, big.dn, 1], [F, u, it.dn, 1]); }
            else FJ.push([E, u, it.dn, 1]); });   // attacco: flangia
          FJ.forEach(f => flange(f[0], f[1], f[2], f[3])); }
        FJ0.forEach(f => f()); }
      else if (it.t === "g") {   // terreno: la linea e il tratteggio si fermano al calcestruzzo che lo attraversa (78.29)
        let segs = [[Math.min(it.x0, it.x1), Math.max(it.x0, it.x1)]];
        v.items.forEach(c => { if (c.t !== "r" || (c.s !== "conc" && c.s !== "lean") || !(c.y < it.y + 0.005 && c.y + c.h > it.y - 0.005)) return; const a = c.x, b = c.x + c.w; segs = segs.flatMap(sg => b <= sg[0] || a >= sg[1] ? [sg] : [[sg[0], a], [b, sg[1]]].filter(q => q[1] - q[0] > 0.02)); });
        segs.forEach(sg => { cb.line([[X(sg[0]), Y(it.y)], [X(sg[1]), Y(it.y)]], 0.5); for (let x = X(sg[0]); x < X(sg[1]) - 1; x += 3) cb.line([[x, Y(it.y)], [Math.min(x + 1.6, X(sg[1])), Y(it.y) + Math.min(1.6, X(sg[1]) - x)]], 0.18); }); }
      else if (it.t === "w") { cb.line([[X(it.x0), Y(it.y)], [X(it.x1), Y(it.y)]], 0.35, null, [56, 150, 220]); const xm = (X(it.x0) + X(it.x1)) / 2; cb.fillPoly([[xm - 2, Y(it.y) - 2.6], [xm + 2, Y(it.y) - 2.6], [xm, Y(it.y)]], [56, 150, 220]); }
      else if (it.t === "v") {   // valvola: farfalla (saracinesca) o farfalla con barra (ritegno)
        const x = X(it.x), y = Y(it.y), s = 2.4, a = (it.ang || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
        const P = (u, w) => [x + u * ca - w * sa, y - (u * sa + w * ca)];
        cb.fillPoly([P(-s, -s * 0.8), P(-s, s * 0.8), P(s, -s * 0.8), P(s, s * 0.8)], [255, 255, 255], true);
        cb.line([P(-s, -s * 0.8), P(-s, s * 0.8), P(s, -s * 0.8), P(s, s * 0.8), P(-s, -s * 0.8)], 0.3);
        if (it.k === "check") cb.line([P(s * 0.15, -s), P(s * 0.15, s)], 0.45); else cb.line([P(0, 0), P(0, s * 1.4)], 0.3);
      } else if (it.t === "d") {   // quota: linee di richiamo, linea di quota con trattini obliqui, testo
        const ax = X(it.a[0]), ay = Y(it.a[1]), bx2 = X(it.b[0]), by2 = Y(it.b[1]);
        const dx = bx2 - ax, dy = by2 - ay, Ln = Math.hypot(dx, dy) || 1, ux = dx / Ln, uy = dy / Ln, nx = uy, ny = -ux, o = it.o * k;
        const A = [ax + nx * o, ay + ny * o], B = [bx2 + nx * o, by2 + ny * o], sg = Math.sign(o) || 1;
        cb.line([[ax + nx * sg * 1, ay + ny * sg * 1], [A[0] + nx * sg * 1.5, A[1] + ny * sg * 1.5]], 0.18);
        cb.line([[bx2 + nx * sg * 1, by2 + ny * sg * 1], [B[0] + nx * sg * 1.5, B[1] + ny * sg * 1.5]], 0.18);
        cb.line([A, B], 0.2);
        [A, B].forEach(q => cb.line([[q[0] - (ux + nx) * 1.1, q[1] - (uy + ny) * 1.1], [q[0] + (ux + nx) * 1.1, q[1] + (uy + ny) * 1.1]], 0.35));
        const len = Math.hypot(it.b[0] - it.a[0], it.b[1] - it.a[1]), txt = it.txt || fmtM(len).replace(" m", "");
        const sd = it._tf ? -sg : sg, vert = Math.abs(ux) < 0.5, mx = (A[0] + B[0]) / 2 + nx * sd * 2.2 + ux * (it._ts || 0), my = (A[1] + B[1]) / 2 + ny * sd * 2.2 + uy * (it._ts || 0);   // _tf: numero dall'altro lato della linea   // _ts: testo fatto scorrere lungo la quota (77.84)
        if (Math.abs(it._ts || 0) > Ln / 2) { const E = it._ts > 0 ? B : A, tw0 = String(txt).length * 1.3 + 1.5, fx = (A[0] + B[0]) / 2 + ux * (it._ts + Math.sign(it._ts) * tw0 * 0.5), fy = (A[1] + B[1]) / 2 + uy * (it._ts + Math.sign(it._ts) * tw0 * 0.5); cb.line([E, [fx, fy]], 0.18); }   // numero fuori: la linea di quota prosegue fino a sotto il numero (richiamo)
        if (it.ed && cb.dimStart) cb.dimStart(it.ed, mx, my + (vert ? 0 : 0.9));   // quota modificabile (clic sul numero)
        cb.text(mx, my + (vert ? 0 : 0.9), txt, 2.5, "c", false, vert ? -90 : 0);
        if (it.ed && cb.dimEnd) cb.dimEnd();
      } else if (it.t === "x") { cb.text(X(it.x), Y(it.y), it.s, it.h, it.al, false);
        if (it._lk && !(it._lk[0] > it._bb[0] && it._lk[0] < it._bb[2] && it._lk[1] > it._bb[1] && it._lk[1] < it._bb[3])) { const b = it._bb, q = [Math.max(b[0], Math.min(b[2], it._lk[0])), Math.max(b[1], Math.min(b[3], it._lk[1]))]; cb.line([q, it._lk], 0.12); cb.circle(it._lk[0], it._lk[1], 0.35, 0.12, null, 0); } }   // filo di richiamo (77.84)
      else if (it.t === "ld") { const a = [X(it.a[0]), Y(it.a[1])], b = [X(it.b[0]), Y(it.b[1])], r = b[0] >= a[0]; cb.line([a, b, [b[0] + (r ? 6 : -6), b[1]]], 0.2); cb.circle(a[0], a[1], 0.5, 0.2, null, 0); cb.text(b[0] + (r ? 7 : -7), b[1] + 0.9, it.s, 2.3, r ? "l" : "r", false); }
      else if (it.t === "cut") { const g = wkCutGeo(it, X, Y); cb.line(g.P, STY.cl[0], STY.cl[1]); g.ends.forEach(e => { cb.line(e.tick, 0.6); cb.line(e.arrow, 0.3); cb.fillPoly(e.head); cb.text(e.txt[0], e.txt[1], it.lab, 3.4, "c", true); }); }   // traccia del taglio (78.29)
    });
    if (curG && cb.gEnd) cb.gEnd();
  });
  // fascia in basso: note e quantità, poi il cartiglio a celle come nelle planimetrie, poi le righe di piè di pagina
  const y0 = areaB + 2;
  cb.line([[M - 4, y0], [W - M + 4, y0]], 0.3, null, LIN);
  const wN = 250, xQ = M + wN + 4, wQ = W - M - xQ;
  cb.text(M, y0 + 5, String(meta.notesT).toUpperCase(), 2.6, "l", true, 0, INK);
  let yy = y0 + 10;
  const ovf = [], spill = !!(sheet.bom && sheet.bom.rows.length && meta.bom !== false);   // le note che non ci stanno proseguono nella pagina del computo (77.80)
  sheet.notes.forEach((s, i) => { const tx = String(i + 1) + ". " + s, lines = cb.split(tx, wN - 4, 2.2);
    if (spill && (ovf.length || yy + (lines.length - 1) * 3.3 > fY - 2 - 3.3)) { ovf.push(tx); return; }
    lines.forEach(ln => { if (yy < fY - 2) cb.text(M, yy, ln, 2.2, "l", false, 0, [30, 40, 34]); yy += 3.3; }); });
  sheet._ovf = ovf; if (ovf.length) cb.text(M, yy, "→ " + sheet.bom.T.more, 2.2, "l", true, 0, INK);
  cb.line([[xQ - 3, y0], [xQ - 3, fY]], 0.25, null, LIN);
  cb.text(xQ, y0 + 5, String(meta.qtyT).toUpperCase(), 2.6, "l", true, 0, INK);
  const dq = Math.min(4.3, (fY - 2 - (y0 + 10)) / Math.max(1, sheet.qty.length - 1)), hq = dq < 3.6 ? 1.9 : 2.2;   // con molte righe la tabella si stringe
  sheet.qty.forEach((q, i) => { const y = y0 + 10 + i * dq; if (y > fY - 1.5) return; cb.text(xQ, y, q[0], hq, "l", false, 0, [30, 40, 34]); cb.text(xQ + wQ, y, String(q[1]).replace(".", WK_DEC) + (q[2] ? " " + (q[2] === "n°" && sheet.pcs ? sheet.pcs : q[2]) : ""), hq, "r", true, 0, INK); });
  wkFoot(cb, meta, W, H, M, fY, INK, LAB, LIN);
}
// cartiglio e piè di pagina (anche per le pagine del computo)
function wkFoot(cb, meta, W, H, M, fY, INK, LAB, LIN) {
  // cartiglio
  const cx0 = M - 4, cx1 = W - M + 4, ch = 20, cells = meta.cells || [], wLogo = 74, wTot = cx1 - cx0 - wLogo, fr = meta.cellW || cells.map(() => 1 / Math.max(1, cells.length));
  cb.rect(cx0, fY, wLogo, ch, 0.25, null, LIN);
  if (meta.logo && cb.image) cb.image(cx0 + 3, fY + 2.5, 15, 15, meta.logo);
  cb.text(cx0 + 21, fY + 8, meta.app || "Ceres", 4.6, "l", true, 0, INK);
  cb.text(cx0 + 21, fY + 12.2, meta.by || "", 2, "l", false, 0, LAB);
  cb.text(cx0 + 21, fY + 16.4, meta.ver || "", 1.9, "l", false, 0, LAB);
  let cxx = cx0 + wLogo;
  cells.forEach((c, i) => { const w = wTot * fr[i]; cb.rect(cxx, fY, w, ch, 0.25, null, LIN); cb.text(cxx + 2, fY + 4.2, String(c[0]).toUpperCase(), 1.9, "l", false, 0, LAB);
    const val = String(c[1] == null ? "" : c[1]); let hh = 3.4; while (hh > 2 && val.length * hh * 0.6 > w - 4) hh -= 0.2; cb.text(cxx + 2, fY + 12, val, hh, "l", true, 0, INK); cxx += w; });
  // piè di pagina: diritti e avvertenza, come nelle planimetrie
  cb.text(cx0, H - M + 0.6, meta.foot1 || "", 1.75, "l", false, 0, LAB);
  cb.text(cx0, H - M + 3.4, meta.disc || "", 1.75, "l", false, 0, [120, 140, 128]);
}
// PAGINE DEL COMPUTO (77.72): materiali della tavola per categoria, poi i kit flangia per DN con la bulloneria; due colonne per pagina, altre pagine se serve
function wkDrawBom(sheet, cb, meta, newPage) {
  if (sheet.dec) WK_DEC = sheet.dec;
  const B = sheet.bom, T = B.T, W = 420, H = 297, M = 14, INK = [18, 53, 36], LAB = [90, 115, 101], LIN = [120, 150, 130], fY = H - M - 4 - 20, top = M + 16, bot = fY - 4, rh = 4.4;
  const lines = [];   // ["h", titolo] · ["r", n, voce, q, u] · ["kh"] · ["k", kit] · ["n", testo]
  let pos = 0; ["mach", "pipe", "valv", "kit", "civ"].forEach(c => { const rr = B.rows.filter(r => r.cat === c); if (!rr.length) return; lines.push(["h", T.cats[c]]); rr.forEach(r => lines.push(["r", ++pos, r.desc, r.qty, r.u])); });
  if (B.kits.length) { lines.push(["h", T.cats.kit + " · EN 1092-1 PN 16"], ["kh"]); B.kits.forEach(k => lines.push(["k", k]));
    const tot = {}; B.kits.forEach(k => { const a = (k.rod ? "⌀" : "") + "M" + k.M + "×" + k.L; tot[a] = (tot[a] || 0) + k.bolts; });
    lines.push(["n", T.tot + ": " + Object.keys(tot).map(a => tot[a] + " × " + a.replace("⌀", "")).join(" · ")]); }
  if (sheet._ovf && sheet._ovf.length) { lines.push(["h", T.notesC]); sheet._ovf.forEach(x => lines.push(["n", x])); }
  lines.push(["n", T.note]);
  const colW = (W - 2 * M - 8) / 2, cols = [M, M + colW + 8];
  let page = 0, col = 0, y = top;
  const head = () => { cb.rect(M - 4, M - 4, W - 2 * M + 8, H - 2 * M + 2, 0.4, null, LIN); cb.text(M, M + 4, T.title + " · " + meta.title, 5, "l", true, 0, INK); cb.text(M, M + 9.5, meta.sub, 3, "l", false, 0, LAB);
    cb.line([[M + colW + 4, top - 3], [M + colW + 4, bot]], 0.25, null, LIN); wkFoot(cb, meta, W, H, M, fY, INK, LAB, LIN); };
  const need = (h) => { if (y + h <= bot) return; if (col === 0) { col = 1; y = top; return; } newPage(); page++; col = 0; y = top; head(); };
  head();
  lines.forEach(ln => { const x = cols[col];
    if (ln[0] === "h") { need(rh * 2.4); const x2 = cols[col]; y += 2; cb.text(x2, y + 3, String(ln[1]).toUpperCase(), 2.6, "l", true, 0, INK); cb.line([[x2, y + 4.4], [x2 + colW, y + 4.4]], 0.3, null, LIN); y += rh + 2; return; }
    if (ln[0] === "r") { const ds = cb.split(ln[2], colW - 44, 2.2); need(rh * ds.length); const x2 = cols[col];
      cb.text(x2, y + 3, String(ln[1]), 2.2, "l", false, 0, LAB); ds.forEach((d, i) => cb.text(x2 + 8, y + 3 + i * rh * 0.82, d, 2.2, "l", false, 0, [30, 40, 34]));
      cb.text(x2 + colW - 9, y + 3, String(ln[3]).replace(".", WK_DEC), 2.2, "r", true, 0, INK); cb.text(x2 + colW, y + 3, (ln[4] === "n°" && T.pcs ? T.pcs : ln[4]) || "", 2.2, "r", false, 0, LAB); y += rh * (ds.length > 1 ? 0.82 * ds.length + 0.18 : 1); return; }
    const kx = [0, 18, 64, 80, 118, 140, 162], kc = (x2) => kx.map(v => x2 + v * colW / 180);
    if (ln[0] === "kh") { need(rh * 1.5); const xs = kc(cols[col]); T.kc.forEach((c, i) => cb.text(xs[i] + (i >= 2 ? 0 : 0), y + 3, c, 1.9, "l", true, 0, LAB)); y += rh * 1.2; return; }
    if (ln[0] === "k") { need(rh); const k = ln[1], xs = kc(cols[col]);
      const v = ["DN " + k.dn, k.rod ? T.kw.replace("{f}", k.F) : T.kn, String(k.n), k.bolts + " × M" + k.M + "×" + k.L, String(k.nuts), String(k.wash), String(k.gask)];
      v.forEach((c, i) => cb.text(xs[i], y + 3, c, 2.1, "l", i === 0 || i === 2, 0, i === 0 ? INK : [30, 40, 34])); y += rh; return; }
    if (ln[0] === "n") { const ds = cb.split(ln[1], colW, 2); need(rh * ds.length + 2); const x2 = cols[col]; y += 2; ds.forEach(d => { cb.text(x2, y + 3, d, 2, "l", false, 0, LAB); y += rh * 0.8; }); } });
}
function wkSvg(sheet, meta, opt) {   // opt.view: solo quella vista, ingrandita (la finestra per disporre i componenti)
  const parts = [], esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const col = (c) => c ? "rgb(" + c.join(",") + ")" : "#1d2a24";
  const cb = {
    line: (pts, w, dash, c) => parts.push('<polyline fill="none" stroke="' + col(c) + '" stroke-width="' + w + '"' + (dash ? ' stroke-dasharray="' + dash.join(" ") + '"' : "") + ' stroke-linejoin="round" points="' + pts.map(p => p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ") + '"/>'),
    rect: (x, y, w, h, lw, dash, c) => parts.push('<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + w.toFixed(2) + '" height="' + h.toFixed(2) + '" fill="none" stroke="' + col(c) + '" stroke-width="' + lw + '"' + (dash ? ' stroke-dasharray="' + dash.join(" ") + '"' : "") + "/>"),
    image: (x, y, w, h, src) => parts.push('<image x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + w.toFixed(2) + '" height="' + h.toFixed(2) + '" href="' + src + '" preserveAspectRatio="xMidYMid meet"/>'),
    fillRect: (x, y, w, h, g) => parts.push('<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + w.toFixed(2) + '" height="' + h.toFixed(2) + '" fill="rgb(' + g + "," + g + "," + g + ')"/>'),
    hatch: (x, y, w, h, s) => { for (let d = s; d < w + h; d += s) { const x1 = x + Math.min(d, w), y1 = y + Math.max(0, d - w), x2 = x + Math.max(0, d - h), y2 = y + Math.min(d, h); parts.push('<line x1="' + x1.toFixed(2) + '" y1="' + y1.toFixed(2) + '" x2="' + x2.toFixed(2) + '" y2="' + y2.toFixed(2) + '" stroke="#8a948f" stroke-width="0.15"/>'); } },
    circle: (x, y, r, w, dash, fillG) => parts.push('<circle cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r="' + Math.max(0.2, r).toFixed(2) + '" fill="' + (fillG != null ? "rgb(" + fillG + "," + fillG + "," + fillG + ")" : "none") + '" stroke="#1d2a24" stroke-width="' + w + '"' + (dash ? ' stroke-dasharray="' + dash.join(" ") + '"' : "") + "/>"),
    fillPoly: (pts, c, stroke) => parts.push('<polygon points="' + pts.map(p => p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ") + '" fill="' + col(c) + '"' + (stroke ? ' stroke="none"' : "") + "/>"),
    text: (x, y, s, h, al, bold, rot, c) => parts.push('<text x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" font-family="Helvetica,Arial,sans-serif" font-size="' + (h * 1.25).toFixed(2) + '"' + (bold ? ' font-weight="700"' : "") + ' text-anchor="' + (al === "c" ? "middle" : al === "r" ? "end" : "start") + '"' + (rot ? ' transform="rotate(' + rot + " " + x.toFixed(2) + " " + y.toFixed(2) + ')"' : "") + ' fill="' + (c ? col(c) : "rgb(18,53,36)") + '">' + esc(s) + "</text>"),
    split: (s, w, h) => { const out = []; let cur = ""; String(s).split(/\s+/).forEach(wd => { const nx = cur ? cur + " " + wd : wd; if (nx.length * h * 0.62 > w && cur) { out.push(cur); cur = wd; } else cur = nx; }); if (cur) out.push(cur); return out; },
    gStart: (g, k, drag) => parts.push('<g data-drag="' + esc(g) + '" data-mpm="' + k.toFixed(4) + '"' + (drag ? ' style="cursor:move"' : "") + ">"),   // elementi trascinabili della tavola: data-mpm = mm di carta per metro
    gEnd: () => parts.push("</g>"),
    pipeMeta: (P) => parts.push('<polyline class="wkpipe" fill="none" stroke="none" points="' + P.map(q => q[0].toFixed(2) + "," + q[1].toFixed(2)).join(" ") + '"/>'),
    pipeEd: (ed, P, w) => parts.push('<polyline data-dn="' + esc(JSON.stringify(ed)).replace(/"/g, "&quot;") + '" fill="none" stroke="rgba(56,189,248,0.001)" stroke-width="' + w.toFixed(2) + '" pointer-events="stroke" style="cursor:pointer" points="' + P.map(q => q[0].toFixed(2) + "," + q[1].toFixed(2)).join(" ") + '"><title>DN ' + ed.dn + '</title></polyline>'),   // asse del tubo (per le prove: tratti dritti)
    dimStart: (ed, x, y) => parts.push('<g data-dim="' + esc(JSON.stringify(ed)).replace(/"/g, "&quot;") + '" style="cursor:pointer"><rect x="' + (x - 6).toFixed(2) + '" y="' + (y - 3.6).toFixed(2) + '" width="12" height="4.6" rx="1" fill="rgba(56,189,248,.14)"/>'),
    dimEnd: () => parts.push("</g>"),
  };
  // una vista sola: tavola con quella vista (scala più grande) ritagliata sul disegno
  const one = opt && opt.view != null && sheet.views[opt.view] ? { ...sheet, views: [{ ...sheet.views[opt.view], noTitle: 1, items: sheet.views[opt.view].items.filter(it => !it.sl) }] } : null;
  wkDraw(one || sheet, cb, meta);
  let vb = [0, 0, 420, 297], v = one ? one.views[0] : null;
  if (v && v.X) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; const ad = (x, y) => { const X = v.X(x), Y = v.Y(y); if (!isFinite(X) || !isFinite(Y)) return; x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y); };
    const tx = (P, s, h, al) => { const X = v.X(P[0]), Y = v.Y(P[1]); if (!isFinite(X) || !isFinite(Y)) return; const w = String(s || "").length * (h || 2.3) * 0.56, a = al === "l" ? X : al === "r" ? X - w : X - w / 2; x0 = Math.min(x0, a); x1 = Math.max(x1, a + w); y0 = Math.min(y0, Y - (h || 2.3)); y1 = Math.max(y1, Y + 1); };   // le scritte intere dentro il riquadro (77.96)
    let its = v.items; try { its = wkDeclutter(v.items, v.X, v.Y, v.k, v.box); } catch (e) { }   // le scritte dove le mette il disegno, dopo averle spostate
    its.forEach(it => { if (it.t === "r") { ad(it.x, it.y); ad(it.x + it.w, it.y + it.h); } else if (it.t === "c") { ad(it.x - it.r, it.y - it.r); ad(it.x + it.r, it.y + it.r); } else if (it.pts) it.pts.forEach(q => ad(q[0], q[1])); else if (it.t === "x") { ad(it.x, it.y); tx([it.x, it.y], it.s, it.h, it.al); } else if (it.a) { ad(it.a[0], it.a[1]); if (it.b) { ad(it.b[0], it.b[1]); if (it.t === "ld") tx(it.b, it.s, it.h || 2, it.b[0] >= it.a[0] ? "l" : "r"); } } });
    if (isFinite(x0)) { const m = 5, mx = 6; vb = [x0 - mx, y0 - m, x1 - x0 + 2 * mx, y1 - y0 + 2 * m]; } }   // ai lati più margine: le scritte spostate per non sovrapporsi restano dentro   // margini stretti (77.95): disegno più grande nella finestra
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb.map(x => x.toFixed(2)).join(" ") + '" style="width:100%;height:auto;max-height:' + (v ? "62vh" : "none") + ';background:#fff;display:block">' + (v ? (() => { const id = "wkvb" + Math.random().toString(36).slice(2, 8); return '<defs><clipPath id="' + id + '"><rect x="' + vb[0].toFixed(2) + '" y="' + vb[1].toFixed(2) + '" width="' + vb[2].toFixed(2) + '" height="' + vb[3].toFixed(2) + '"/></clipPath></defs><g clip-path="url(#' + id + ')">' + parts.join("") + "</g>"; })() : parts.join("")) + "</svg>";   // vista sola: tagliata al suo riquadro anche quando la finestra è più alta (77.95)
}
function wkPdf(sheet, meta) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a3" });
  // simboli (78.29): ³ ² − – “ ” ‘ ’ e le lettere accentate delle lingue latine restano, perché il font Inter incorporato li ha; si sostituiscono solo quelli che Inter non copre (≤ ≥ → ≈ φ pedici)
  const covI = (ch) => typeof pdfCovOk === "function" && typeof PDF_COV_I !== "undefined" ? pdfCovOk(PDF_COV_I, ch) : ch.charCodeAt(0) <= 0xFF;
  const S = (s) => String(s == null ? "" : s).replace(/φ/g, "fi").replace(/₃/g, "3").replace(/₂/g, "2").replace(/≈/g, "~").replace(/→/g, "->").replace(/≤/g, "<=").replace(/≥/g, ">=").replace(/[^\x00-\xFF]/gu, (ch) => covI(ch) ? ch : "");
  const setC = (c) => { const k = c || [29, 42, 36]; doc.setDrawColor(k[0], k[1], k[2]); };
  const cb = {
    line: (pts, w, dash, c) => { setC(c); doc.setLineWidth(w); if (dash) doc.setLineDashPattern(dash, 0); for (let i = 1; i < pts.length; i++) doc.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]); if (dash) doc.setLineDashPattern([], 0); },
    image: (x, y, w, h, src) => { try { doc.addImage(src, "PNG", x, y, w, h); } catch (e) { } },
    rect: (x, y, w, h, lw, dash, c) => { setC(c); doc.setLineWidth(lw); if (dash) doc.setLineDashPattern(dash, 0); doc.rect(x, y, w, h, "S"); if (dash) doc.setLineDashPattern([], 0); },
    fillRect: (x, y, w, h, g) => { doc.setFillColor(g, g, g); doc.rect(x, y, w, h, "F"); },
    hatch: (x, y, w, h, s) => { doc.setDrawColor(138, 148, 143); doc.setLineWidth(0.15); for (let d = s; d < w + h; d += s) doc.line(x + Math.min(d, w), y + Math.max(0, d - w), x + Math.max(0, d - h), y + Math.min(d, h)); },
    circle: (x, y, r, w, dash, fillG) => { setC(); doc.setLineWidth(w); if (dash) doc.setLineDashPattern(dash, 0); if (fillG != null) { doc.setFillColor(fillG, fillG, fillG); doc.circle(x, y, Math.max(0.2, r), "FD"); } else doc.circle(x, y, Math.max(0.2, r), "S"); if (dash) doc.setLineDashPattern([], 0); },
    fillPoly: (pts, c) => { const k = c || [29, 42, 36]; doc.setFillColor(k[0], k[1], k[2]); const rel = []; for (let i = 1; i < pts.length; i++) rel.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]); doc.lines(rel, pts[0][0], pts[0][1], [1, 1], "F", true); },
    text: (x, y, s, h, al, bold, rot, c) => { const k = c || [18, 53, 36]; doc.setTextColor(k[0], k[1], k[2]); doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(h * 2.83 * 1.25);
      if (rot) { const tw = doc.getTextWidth(S(s)), a = -rot * Math.PI / 180, ux = Math.cos(a), uy = -Math.sin(a), f = al === "c" ? 0.5 : al === "r" ? 1 : 0; doc.text(S(s), x - ux * tw * f, y - uy * tw * f, { angle: -rot }); return; }   // testo ruotato: jsPDF non lo allinea, si centra a mano lungo la sua direzione (77.84)
      doc.text(S(s), x, y, { align: al === "c" ? "center" : al === "r" ? "right" : "left" }); },
    split: (s, w, h) => { doc.setFont("helvetica", "normal"); doc.setFontSize(h * 2.83 * 1.25); return doc.splitTextToSize(S(s), w); },
    tw: (s, h, bold) => { doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(h * 2.83 * 1.25); return doc.getTextWidth(S(s)); },
  };
  wkDraw(sheet, cb, meta);
  if (sheet.bom && sheet.bom.rows.length && meta.bom !== false) { doc.addPage("a3", "landscape"); wkDrawBom(sheet, cb, meta, () => doc.addPage("a3", "landscape")); }   // computo della tavola (77.72)
  return doc;
}

export { WK_TYPES, wkDefaults, wkBuild, wkLayout, wkDraw, wkDrawBom, wkPdf };
