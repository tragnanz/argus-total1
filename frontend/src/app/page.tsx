"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import JSZip from "jszip";
import type { MapHandle, PivotItem, PivotSel, CircleInfo } from "@/components/MapCanvas";
import { useI18n, LANGS, type Lang, translateError, translatorFor } from "@/lib/i18n";
import { parseFieldsFromFile, parseLinesFromFile } from "@/lib/importGeo";
import * as api from "@/lib/api";
import { buildXlsx } from "@/lib/xlsx";
import { linearLayout, reelLayout, dripLayout, type LL as SysLL } from "@/lib/systems";
import type {
  Area, Client, Polygon, Project, Scene, ColorScale, SuitMeta, SuitWeights,
  LayoutMeta, LayoutConfig, Transport, PhaseOrder, LayoutParams, GeoJSONFC, MacroArea, Canal, GuidedResult, ProjectLayer, Watercourse, ElevationResult,
} from "@/lib/api";

// Revisione software: aggiornare a ogni versione consegnata.
const REV = "v0.6.192";

const MapCanvas = dynamic(() => import("@/components/MapCanvas"), { ssr: false });

const INDICES: { id: string; label: string }[] = [
  { id: "ndvi", label: "vegetazione" },
  { id: "ndmi", label: "umidità" },
  { id: "ndwi", label: "acqua" },
  { id: "ndre", label: "clorofilla" },
  { id: "msi", label: "stress idrico" },
  { id: "rgb", label: "Colore reale (RGB)" },
];

// Tabella agronomica UNICA: tipo di suolo → velocità di infiltrazione di base
// (mm/h) e intervallo tipico di letteratura. È la fonte da cui la piattaforma
// propone il valore; l'utente può comunque correggerlo.
// Prima esistevano due tabelle scollegate con chiavi diverse ("franco_sabbioso"
// e "franco-sabbioso"): cambiando suolo in una pagina l'altra non seguiva.
const SOILS: { key: string; label: string; inf: number; lo: number; hi: number }[] = [
  { key: "sabbioso", label: "Sabbioso", inf: 30, lo: 20, hi: 50 },
  { key: "franco_sabbioso", label: "Franco-sabbioso", inf: 20, lo: 15, hi: 25 },
  { key: "franco", label: "Franco", inf: 12, lo: 8, hi: 15 },
  { key: "franco_limoso", label: "Franco-limoso", inf: 8, lo: 6, hi: 12 },
  { key: "franco_argilloso", label: "Franco-argilloso", inf: 4, lo: 3, hi: 8 },
  { key: "argilloso", label: "Argilloso", inf: 2, lo: 1, hi: 5 },
];
const soilOf = (k: string) => SOILS.find((x) => x.key === k) ?? SOILS[2];

// Colture → Kc di punta. Anche qui una tabella sola: i due menu «Coltura»
// avevano elenchi diversi e la scelta fatta in una pagina non si ritrovava
// nell'altra.
const CROP_LIST: { key: string; label: string; kc: number }[] = [
  { key: "canna", label: "Canna da zucchero", kc: 1.25 },
  { key: "mais", label: "Mais", kc: 1.2 },
  { key: "medica", label: "Erba medica", kc: 1.15 },
  { key: "cereali", label: "Cereali", kc: 1.15 },
  { key: "ortive", label: "Ortive", kc: 1.05 },
  { key: "altro", label: "Altro", kc: 1.1 },
];
const cropOf = (k: string) => CROP_LIST.find((x) => x.key === k) ?? CROP_LIST[5];
const PIVOT_WET_W = 40;   // larghezza bagnata del pacchetto irriguo (m), assunzione

// Schede del pannello destro, in ordine progressivo del flusso di progetto.
// "Analisi" raggruppa satellite + idoneità + macro-aree in un'unica finestra.
const TABS: { key: string; label: string }[] = [
  { key: "analisi", label: "Analisi" },
  { key: "rilievo", label: "Rilievo" },
  { key: "impianti", label: "Impianti" },
  { key: "fonte", label: "Fonte d'acqua" },
  { key: "accessori", label: "Tubazioni" },
  { key: "pompaggio", label: "Pompaggio" },
  { key: "strade", label: "Strade" },
  { key: "irrigazione", label: "Irrigazione" },
  { key: "export", label: "Esporta" },
  { key: "informazioni", label: "Informazioni" },
];

// Impostazioni tecniche di un campo (idoneità + layout). Possono essere globali
// (stesse regole per tutti) oppure specifiche del singolo campo.
type Settings = {
  weights: SuitWeights; slopeIdeal: number; slopeMax: number;
  layoutCfg: LayoutConfig; radius: number; gap: number; transport: Transport;
  orientMode: "auto" | "manual"; azimuth: number; canalFlip: boolean;
  onlySuitable: boolean; minSuit: number; overhang: number;
  nPhases: number; phaseOrder: PhaseOrder; kc: number; eff: number; hours: number;
};
// Pendenza ideale/massima predefinita per tipo di trasporto, in ‰ (per mille).
const SLOPE_PM: Record<Transport, { ideal: number; max: number }> = {
  canal: { ideal: 2, max: 5 },
  buried: { ideal: 5, max: 70 },
};
const DEFAULTS: Settings = {
  weights: { slope: 0.45, vigor: 0.25, moisture: 0.15, climate: 0.15 },
  slopeIdeal: SLOPE_PM.buried.ideal, slopeMax: SLOPE_PM.buried.max,   // ‰
  layoutCfg: "staggered", radius: 400, gap: 0, transport: "buried",
  orientMode: "auto", azimuth: 0, canalFlip: false,
  onlySuitable: false, minSuit: 60, overhang: 0,
  nPhases: 1, phaseOrder: "canal_distance", kc: 1.15, eff: 0.85, hours: 20,
};

// Sotto-area (macro-area) inscritta in un campo.
type FieldMacro = { id: number; name: string; geom: Polygon; area_ha: number; mean_score: number; savedId?: number };
type PivotBrand = "starpivot" | "reinke" | "valley" | "rkd" | "zimmatic";
const PIVOT_BRANDS: Record<PivotBrand, string> = { starpivot: "Star Pivot", reinke: "Reinke", valley: "Valley", rkd: "RKD", zimmatic: "Zimmatic" };
type Field = {
  id: number; name: string; geom: Polygon;
  settings?: Settings;                 // override per-campo (usato se non "stesse regole")
  suit?: SuitMeta | null;
  lay?: LayoutMeta | null;
  layGeo?: GeoJSONFC | null;
  macros?: FieldMacro[];               // sotto-livelli (macro-aree) del campo
  hidden?: boolean;                    // campo spento sulla mappa
  savedId?: number;                    // id dell'area salvata nel progetto
  parentId?: number;                   // campo genitore (famiglia): poligono figlio sotto un altro
  style?: { color?: string; fillColor?: string; fillOpacity?: number };   // stile perimetro/riempimento
  level?: "area" | "campo";            // AREA = disegnata/importata dall'utente; CAMPO = generata dal sistema dopo l'analisi
  score?: number;                      // idoneità media (solo per i CAMPO generati dall'analisi)
};

// Wrapper front-end con visibilità per-oggetto e proprietario (campo) per il
// pannello Livelli stile Photoshop: owner = id del campo a cui l'oggetto appartiene.
type CanalL = Canal & { hidden?: boolean; uid?: number; owner?: number };
type WaterL = Watercourse & { hidden?: boolean; uid?: number; owner?: number };
// kind: assente/"existing" = strada preesistente tracciata o importata; "osm" = da
// OpenStreetMap (preesistente); "service" = viabilità di servizio generata per i
// pivot (NON è un ostacolo per il layout).
type RoadL = { id: string; coords: number[][]; width_m: number; hidden?: boolean; owner?: number; kind?: "existing" | "osm" | "service" };

// Larghezza indicativa (m) delle strade OSM per categoria «highway».
const OSM_ROAD_W: Record<string, number> = { motorway: 24, trunk: 20, primary: 12, secondary: 10, tertiary: 8,
  unclassified: 6, residential: 6, service: 5, track: 5 };

// Viabilità di servizio su reticolo QUADRATO di pivot, a lunghezza minima.
// Vincoli: le strade corrono nei corridoi liberi tra le file (o tra le colonne),
// ogni pivot è raggiunto da un raccordo ORTOGONALE fino al centro, i corridoi si
// collegano lungo gli spazi tra le colonne, più un accesso (bordo o strada esistente).
// Ottimizza: (1) quali corridoi aprire e quale serve ogni fila — programmazione
// dinamica esatta sulle file, poi rifinitura pivot per pivot; (2) collegamenti come
// albero di copertura minimo; (3) orientamento: corridoi lungo le file o le colonne.
// Coordinate [lng, lat]; calcolo in metri su proiezione locale.
function serviceRoadsGrid(ctrLL: number[][], ringLL: number[][], extRoads: number[][][]): { segs: number[][][]; err?: "triangular"; km?: number } {
  if (!ctrLL.length) return { segs: [] };
  const lat0 = ctrLL.reduce((a, p) => a + p[1], 0) / ctrLL.length, lon0 = ctrLL.reduce((a, p) => a + p[0], 0) / ctrLL.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  const xy = (p: number[]) => [(p[0] - lon0) * kx, (p[1] - lat0) * ky];
  const toLL = (q: number[]) => [lon0 + q[0] / kx, lat0 + q[1] / ky];
  const P = ctrLL.map(xy), ring = ringLL.map(xy);
  const n = P.length;
  // interasse e orientamento del reticolo dai vicini più prossimi (angoli modulo 90°)
  const nn: { d: number; a: number }[] = [];
  for (let i = 0; i < n; i++) {
    let bd = Infinity, ba = 0;
    for (let j = 0; j < n; j++) if (j !== i) { const d = Math.hypot(P[j][0] - P[i][0], P[j][1] - P[i][1]); if (d < bd) { bd = d; ba = Math.atan2(P[j][1] - P[i][1], P[j][0] - P[i][0]); } }
    if (isFinite(bd)) nn.push({ d: bd, a: ba });
  }
  const sp = nn.length ? nn.map((x) => x.d).sort((a, b) => a - b)[Math.floor(nn.length / 2)] : 1000;
  let th0 = 0;
  if (nn.length) {
    th0 = Math.atan2(nn.reduce((a, x) => a + Math.sin(4 * x.a), 0), nn.reduce((a, x) => a + Math.cos(4 * x.a), 0)) / 4;
    // reticolo triangolare: i vicini stanno a 60°, non a 90° → niente corridoi rettilinei
    const dev = nn.reduce((a, x) => { let r = ((x.a - th0) % (Math.PI / 2) + Math.PI / 2) % (Math.PI / 2); r = Math.min(r, Math.PI / 2 - r); return a + r; }, 0) / nn.length;
    if (dev > (12 * Math.PI) / 180) return { segs: [], err: "triangular" };
  }
  const insideXY = (q: number[]) => { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) ins = !ins; } return ins; };
  const cluster = (vals: number[]) => {                 // valori → centri dei gruppi (file o colonne)
    const srt = [...vals].sort((a, b) => a - b); const out: number[][] = [];
    for (const x of srt) { const last = out[out.length - 1]; if (last && x - last[last.length - 1] < sp * 0.4) last.push(x); else out.push([x]); }
    return out.map((g) => g.reduce((a, x) => a + x, 0) / g.length);
  };
  // lunghezza dei tratti continui di un corridoio dati gli u serviti (si spezza oltre 1,5 interassi)
  const runsOf = (us: number[]) => {
    const srt = [...us].sort((a, b) => a - b); const out: { lo: number; hi: number }[] = [];
    for (const u of srt) { const last = out[out.length - 1]; if (last && u - last.hi <= sp * 1.5) last.hi = u; else out.push({ lo: u, hi: u }); }
    return out;
  };
  const runLen = (us: number[]) => runsOf(us).reduce((a, r) => a + (r.hi - r.lo), 0);

  const build = (th: number) => {
    const c = Math.cos(th), s = Math.sin(th);
    const toUV = (p: number[]) => [p[0] * c + p[1] * s, -p[0] * s + p[1] * c];
    const fromUV = (u: number, v: number) => [u * c - v * s, u * s + v * c];
    const U = P.map(toUV);
    const rowV = cluster(U.map((p) => p[1])), colU = cluster(U.map((p) => p[0]));
    const nr = rowV.length;
    const rowOf = (v: number) => rowV.reduce((bi, rv, i) => (Math.abs(rv - v) < Math.abs(rowV[bi] - v) ? i : bi), 0);
    const rowsU: number[][] = rowV.map(() => []);
    const rowIdx = U.map((p) => rowOf(p[1]));
    U.forEach((p, i) => rowsU[rowIdx[i]].push(p[0]));
    // corridoi candidati: tra due file consecutive; per una fila estrema, anche il lato esterno se dentro il campo
    const gapV: number[] = [];                        // gap g sta tra fila g-1 e fila g (g = 0..nr): 0 e nr sono esterni
    for (let g = 0; g <= nr; g++) gapV.push(g === 0 ? rowV[0] - sp / 2 : g === nr ? rowV[nr - 1] + sp / 2 : (rowV[g - 1] + rowV[g]) / 2);
    const gapOk = gapV.map((v, g) => (g > 0 && g < nr) || rowsU[g === 0 ? 0 : nr - 1].every((u) => insideXY(fromUV(u, v))));
    // DP: ogni fila r è servita dal gap r (sopra) o r+1 (sotto); costo di un gap = lunghezza dei suoi tratti
    const cost = (g: number, upRow: boolean, dnRow: boolean) => {
      if (!gapOk[g]) return (upRow || dnRow) ? Infinity : 0;
      const us = [...(upRow && g > 0 ? rowsU[g - 1] : []), ...(dnRow && g < nr ? rowsU[g] : [])];
      return us.length ? runLen(us) : 0;
    };
    // dp[r][a]: a = 0 → fila r usa il gap r, a = 1 → usa il gap r+1
    const dp: number[][] = [], from: number[][] = [];
    for (let r = 0; r < nr; r++) {
      dp.push([Infinity, Infinity]); from.push([0, 0]);
      for (let a = 0; a < 2; a++) {
        if (r === 0) { dp[0][a] = a === 0 ? cost(0, false, true) : 0; continue; }
        for (let pa = 0; pa < 2; pa++) {
          // gap r è condiviso: fila r-1 lo usa se pa=1, fila r se a=0
          const v = dp[r - 1][pa] + cost(r, pa === 1, a === 0);
          if (v < dp[r][a]) { dp[r][a] = v; from[r][a] = pa; }
        }
      }
    }
    const last = [0, 1].map((a) => dp[nr - 1][a] + cost(nr, a === 1, false));
    const choice: number[] = new Array(nr);
    choice[nr - 1] = last[0] <= last[1] ? 0 : 1;
    for (let r = nr - 1; r > 0; r--) choice[r - 1] = from[r][choice[r]];
    // assegnazioni candidate (fila → gap): esito della DP e accoppiamento classico
    // delle file (0|1, 2|3… oppure 1|2, 3|4…); il confronto finale è sulla rete INTERA
    const pairing = (ph: number) => rowV.map((_, r) => {
      const g = ((r + ph) % 2 === 0) ? r + 1 : r;            // gap tra r e la fila accoppiata
      if (g > 0 && g < nr) return g;
      const alt = g === 0 ? 1 : nr - 1;                       // fila spaiata in testa/coda
      if (alt > 0 && alt < nr) return alt;
      return gapOk[g] ? g : (gapOk[0] ? 0 : nr);
    });
    const assigns: number[][] = [rowV.map((_, r) => r + choice[r]), pairing(0), pairing(1)]
      .filter((a) => a.every((g) => gapOk[g]));
    let bestRes: { segs: number[][][]; total: number } | null = null;
    for (const rowGap of assigns) for (const refine of [false, true]) {
      const res = finish(U.map((_, i) => rowGap[rowIdx[i]]), refine);
      if (!bestRes || res.total < bestRes.total) bestRes = res;
    }
    return bestRes ?? { segs: [], total: Infinity };

  function finish(gapOf0: number[], refine: boolean): { segs: number[][][]; total: number } {
    // rifinitura pivot per pivot (solo verso un gap già aperto e valido)
    const gapOf = [...gapOf0];
    const open = new Set(gapOf);
    const usOf = (g: number) => U.filter((_, i) => gapOf[i] === g).map((p) => p[0]);
    for (let pass = 0; refine && pass < 4; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        const r = rowIdx[i], g = gapOf[i], alt = g === r ? r + 1 : r;
        if (!open.has(alt) || !gapOk[alt]) continue;
        const before = runLen(usOf(g)) + runLen(usOf(alt));
        gapOf[i] = alt;
        const after = runLen(usOf(g)) + runLen(usOf(alt));
        if (after < before - 1e-6) moved = true; else gapOf[i] = g;
      }
      if (!moved) break;
    }
    const segsUV: number[][][] = [];
    let total = 0;
    U.forEach((p, i) => { segsUV.push([[p[0], p[1]], [p[0], gapV[gapOf[i]]]]); total += Math.abs(p[1] - gapV[gapOf[i]]); });
    // tratti di corridoio
    type Run = { v: number; lo: number; hi: number; id: number };
    const runs: Run[] = [];
    for (const g of [...open].sort((a, b) => a - b)) for (const r of runsOf(usOf(g))) runs.push({ v: gapV[g], lo: r.lo, hi: r.hi, id: runs.length });
    // collegamenti candidati: verticali negli spazi tra colonne (costo = Δv + allungamento dei tratti)
    const colGaps = colU.slice(1).map((u, i) => (u + colU[i]) / 2);
    const ext = (r: Run, u: number) => Math.max(0, r.lo - u, u - r.hi);
    type Edge = { a: number; b: number; w: number; seg: number[][] };
    const edges: Edge[] = [];
    for (const A of runs) for (const B of runs) {
      if (B.id <= A.id) continue;
      if (Math.abs(A.v - B.v) < 1) {                        // stesso corridoio: proseguo dritto
        const d = Math.max(0, Math.max(A.lo, B.lo) - Math.min(A.hi, B.hi));
        const ua = A.hi < B.lo ? A.hi : A.lo, ub = A.hi < B.lo ? B.lo : B.hi;
        edges.push({ a: A.id, b: B.id, w: d, seg: [[ua, A.v], [ub, A.v]] });
        continue;
      }
      let best: Edge | null = null;
      for (const u of colGaps) {
        const w = Math.abs(A.v - B.v) + ext(A, u) + ext(B, u);
        if (ext(A, u) > sp || ext(B, u) > sp) continue;
        if (!best || w < best.w) best = { a: A.id, b: B.id, w, seg: [[Math.min(Math.max(u, A.lo), A.hi), A.v], [u, A.v], [u, B.v], [Math.min(Math.max(u, B.lo), B.hi), B.v]] };
      }
      if (best) edges.push(best);
      // ripiego: collegamento a L tra gli estremi (può attraversare cerchi: costo maggiorato)
      for (const ua of [A.lo, A.hi]) for (const ub of [B.lo, B.hi]) edges.push({ a: A.id, b: B.id, w: (Math.abs(ua - ub) + Math.abs(A.v - B.v)) * 3, seg: [[ua, A.v], [ub, A.v], [ub, B.v]] });
    }
    edges.sort((x, y) => x.w - y.w);
    const par = runs.map((_, i) => i);
    const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i])));
    for (const e of edges) {
      if (find(e.a) === find(e.b)) continue;
      par[find(e.a)] = find(e.b);
      segsUV.push(e.seg);
      for (let k = 0; k + 1 < e.seg.length; k++) total += Math.hypot(e.seg[k + 1][0] - e.seg[k][0], e.seg[k + 1][1] - e.seg[k][1]);
    }
    for (const r of runs) if (r.hi > r.lo) { segsUV.push([[r.lo, r.v], [r.hi, r.v]]); total += r.hi - r.lo; }
    // accesso più corto: prolungamento lungo il corridoio fino al bordo, o strada esistente
    const ringUV = ring.map(toUV);
    const rayHit = (o: number[], dir: number): number => {
      let best = Infinity;
      for (let i = 0; i < ringUV.length - 1; i++) {
        const a = ringUV[i], b = ringUV[i + 1];
        if ((a[1] - o[1]) * (b[1] - o[1]) > 0 || a[1] === b[1]) continue;
        const t = (o[1] - a[1]) / (b[1] - a[1]); const u = a[0] + t * (b[0] - a[0]);
        const d = (u - o[0]) * dir; if (d > 0 && d < best) best = d;
      }
      return best;
    };
    let acc: { from: number[]; to: number[]; d: number } | null = null;
    for (const r of runs) for (const [u, dir] of [[r.lo, -1], [r.hi, 1]] as [number, number][]) {
      const d = rayHit([u, r.v], dir);
      if (isFinite(d) && (!acc || d < acc.d)) acc = { from: [u, r.v], to: [u + dir * d, r.v], d };
    }
    for (const line of extRoads) for (const r of runs) for (const u of [r.lo, r.hi]) {
      const q = nearestOnLine(toLL(fromUV(u, r.v)), line);
      if (q.dist < 5000 && q.dist < (acc ? acc.d : Infinity)) acc = { from: [u, r.v], to: toUV(xy(q.pt)), d: q.dist };
    }
    if (acc) { segsUV.push([acc.from, acc.to]); total += acc.d; }
    return { segs: segsUV.map((sg) => sg.map((q) => toLL(fromUV(q[0], q[1])))), total };
  }
  };
  // corridoi lungo le file o lungo le colonne: vince la rete più corta
  const A = build(th0), B = build(th0 + Math.PI / 2);
  const best = A.total <= B.total ? A : B;
  return { segs: best.segs, km: best.total / 1000 };
}
// Punto più vicino a p su una polilinea (in coordinate locali metriche).
function nearestOnLine(p: number[], line: number[][]): { pt: number[]; dist: number } {
  const kx = 111320 * Math.cos((p[1] * Math.PI) / 180), ky = 110540;
  let bestPt = line[0], bestD = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i][0] - p[0]) * kx, ay = (line[i][1] - p[1]) * ky;
    const bx = (line[i + 1][0] - p[0]) * kx, by = (line[i + 1][1] - p[1]) * ky;
    const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L2)) : 0;
    const qx = ax + t * vx, qy = ay + t * vy, dd = Math.hypot(qx, qy);
    if (dd < bestD) { bestD = dd; bestPt = [p[0] + qx / kx, p[1] + qy / ky]; }
  }
  return { pt: bestPt, dist: bestD };
}

// Snapshot completo per la cronologia Annulla/Ripristina (tutte le mosse).
type Snapshot = {
  f: Field[];
  a: number | null;
  pv: PivotItem[];
  pl: { kind: string; coords: number[][]; field?: number }[];
  rd: { id: string; coords: number[][]; width_m: number }[];
  g: GuidedResult | null;
};

// ---- KMZ (KML zippato) lato client per l'export delle geometrie ----
// Supporta poligoni (campi/sotto-aree) e linee (canali).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExportGeom = { type: "Polygon" | "LineString"; coordinates: any };
function kmlForGeoms(items: { name: string; geom: ExportGeom }[]): string {
  const esc = (s: string) => s.replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" }[c] || c));
  const pm = items.map((it) => {
    const g = it.geom;
    if (g.type === "LineString") {
      const line = ((g.coordinates || []) as number[][]).map(([lo, la]) => `${lo},${la},0`).join(" ");
      return `<Placemark><name>${esc(it.name)}</name><Style><LineStyle><color>ffc78402</color><width>3</width></LineStyle></Style>`
        + `<LineString><tessellate>1</tessellate><coordinates>${line}</coordinates></LineString></Placemark>`;
    }
    const ring = ((g.coordinates?.[0] || []) as number[][]).map(([lo, la]) => `${lo},${la},0`).join(" ");
    return `<Placemark><name>${esc(it.name)}</name><Style><LineStyle><color>ff2780f0</color><width>2</width></LineStyle>`
      + `<PolyStyle><color>3300a0f0</color></PolyStyle></Style>`
      + `<Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${pm}</Document></kml>`;
}

function ringAreaHa(coords: number[][][]): number {
  const R = 6378137;
  const ring = coords?.[0] ?? [];
  if (ring.length < 3) return 0;
  const rad = (d: number) => (d * Math.PI) / 180;
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lo1, la1] = ring[i];
    const [lo2, la2] = ring[(i + 1) % ring.length];
    a += (rad(lo2) - rad(lo1)) * (2 + Math.sin(rad(la1)) + Math.sin(rad(la2)));
  }
  return Math.abs((a * R * R) / 2) / 10000;
}
const safe = (s: string) => s.replace(/[^a-z0-9]+/gi, "_");

// Lunghezza di una polilinea (lon,lat) in km (haversine).
function lineLenKm(coords: number[][]): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  let km = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lo1, la1] = coords[i - 1], [lo2, la2] = coords[i];
    const dLa = rad(la2 - la1), dLo = rad(lo2 - lo1);
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLo / 2) ** 2;
    km += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return km;
}

// ---- Unione canali: helper geometrici (lon,lat) ----
function distM(a: number[], b: number[]): number {
  const R = 6371000, rad = (d: number) => (d * Math.PI) / 180;
  const dLa = rad(b[1] - a[1]), dLo = rad(b[0] - a[0]);
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
// Proiezione del punto p sul segmento a-b (approssimazione planare locale).
function projPointSeg(p: number[], a: number[], b: number[]): number[] {
  const latm = (a[1] + b[1]) / 2, kx = Math.cos((latm * Math.PI) / 180) || 1e-9;
  const ax = a[0] * kx, ay = a[1], bx = b[0] * kx, by = b[1], px = p[0] * kx, py = p[1];
  const dx = bx - ax, dy = by - ay; const len2 = dx * dx + dy * dy || 1e-12;
  let tt = ((px - ax) * dx + (py - ay) * dy) / len2; tt = Math.max(0, Math.min(1, tt));
  return [(ax + dx * tt) / kx, ay + dy * tt];
}
// Punto più vicino sulla polilinea a p, con distanza in metri.
function nearestOnPolyline(p: number[], coords: number[][]): { pt: number[]; distM: number } | null {
  let best: { pt: number[]; distM: number } | null = null;
  for (let i = 1; i < coords.length; i++) {
    const pt = projPointSeg(p, coords[i - 1], coords[i]);
    const d = distM(p, pt);
    if (!best || d < best.distM) best = { pt, distM: d };
  }
  return best;
}

// ---- Gerarchia pivot: conversione FeatureCollection ⇄ modello modificabile ----
// Anello circolare (lon,lat) per un pivot di raggio r (m) centrato in (lat,lng).
// Superficie irrigata da un pivot (m²): settore di (raggio + gittata dell'irrigatore finale).
const pvAreaM2 = (p: { r: number; deg?: number; gun?: number }) =>
  (Math.max(1, Math.min(360, p.deg ?? 360)) / 360) * Math.PI * Math.pow(p.r + Math.max(0, p.gun ?? 0), 2);
// Anello del settore [lng, lat] (cerchio intero se deg = 360); azimut da nord in senso orario.
function sectorRing(lat: number, lng: number, r: number, deg = 360, az = 0): number[][] {
  if (deg >= 359.5) return circleRing(lat, lng, r);
  const dLat = r / 111320, dLng = r / (111320 * Math.cos((lat * Math.PI) / 180) || 1e-9);
  const steps = Math.max(8, Math.round(deg / 4));
  const ring: number[][] = [[lng, lat]];
  for (let i = 0; i <= steps; i++) {
    const a = ((az + (deg * i) / steps) * Math.PI) / 180;
    ring.push([lng + dLng * Math.sin(a), lat + dLat * Math.cos(a)]);
  }
  ring.push([lng, lat]);
  return ring;
}
function circleRing(lat: number, lng: number, r: number, n = 32): number[][] {
  const dLat = r / 111320;
  const dLng = r / (111320 * Math.cos((lat * Math.PI) / 180) || 1e-9);
  const ring: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return ring;
}
// Estrae i pivot (centro + raggio) e le linee (canale/tubi) dal FeatureCollection.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// Una tubazione: tracciato + (dopo il calcolo idraulico) diametro e portata di
// ogni tratto.
type PipeLine = { kind: string; coords: number[][]; field?: number; dn?: number[]; qs?: number[] };
function pivotsFromFC(fc: any, defR: number): { pivots: PivotItem[]; lines: PipeLine[] } {
  const pivots: PivotItem[] = [];
  const lines: PipeLine[] = [];
  for (const f of fc?.features ?? []) {
    const k = f?.properties?.kind;
    const g = f?.geometry;
    if (g?.type === "Polygon" && k === "pivot") {
      const ring: number[][] = (g.coordinates?.[0] ?? []).slice(0, -1);
      if (ring.length < 3) continue;
      let sx = 0, sy = 0;
      for (const p of ring) { sx += p[0]; sy += p[1]; }
      const lng = sx / ring.length, lat = sy / ring.length;
      // raggio: distanza media centro→vertici in metri (robusto anche dopo modifiche)
      let sr = 0;
      for (const p of ring) {
        const dx = (p[0] - lng) * 111320 * Math.cos((lat * Math.PI) / 180);
        const dy = (p[1] - lat) * 111320;
        sr += Math.hypot(dx, dy);
      }
      const r = ring.length ? sr / ring.length : defR;
      const pr = f?.properties ?? {};
      const cen = Array.isArray(pr.center) && pr.center.length === 2 ? pr.center : null;
      pivots.push({ lat: cen ? Number(cen[1]) : lat, lng: cen ? Number(cen[0]) : lng, r: pr.r ? Number(pr.r) : Math.round(r),
        conn: pr.connection, field: pr.field, q: pr.q, p: pr.p,
        ...(pr.deg != null ? { deg: Number(pr.deg), az: Number(pr.az ?? 0) } : {}), ...(pr.gun ? { gun: Number(pr.gun) } : {}),
        ...(pr.fase ? { phase: Number(pr.fase) } : {}) });
    } else if (g?.type === "LineString") {
      lines.push({ kind: k, coords: g.coordinates, field: f?.properties?.field, dn: f?.properties?.dn, qs: f?.properties?.qs });
    }
  }
  return { pivots, lines };
}
// Ricostruisce il FeatureCollection dal modello (per salvataggio/esporto/statistiche).
function fcFromModel(pivots: PivotItem[], lines: { kind: string; coords: number[][]; field?: number; dn?: number[]; qs?: number[] }[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feats: any[] = pivots.map((pv) => ({
    type: "Feature",
    properties: { kind: "pivot", connection: pv.conn ?? "canal", phase: pv.conn === "pipe" ? 2 : 1, field: pv.field,
      ...(pv.q != null ? { q: pv.q } : {}), ...(pv.p != null ? { p: pv.p } : {}),
      // centro e raggio espliciti: col settore il poligono non è più un cerchio
      center: [pv.lng, pv.lat], r: pv.r,
      ...(pv.deg != null && pv.deg < 360 ? { deg: pv.deg, az: pv.az ?? 0 } : {}), ...(pv.gun ? { gun: pv.gun } : {}),
      ...(pv.phase && pv.phase > 1 ? { fase: pv.phase } : {}) },
    geometry: { type: "Polygon", coordinates: [sectorRing(pv.lat, pv.lng, pv.r, pv.deg ?? 360, pv.az ?? 0)] },
  }));
  for (const ln of lines) {
    feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: ln.coords },
      properties: { kind: ln.kind, field: ln.field, ...(ln.dn ? { dn: ln.dn } : {}), ...(ln.qs ? { qs: ln.qs } : {}) } });
  }
  return { type: "FeatureCollection" as const, features: feats };
}

// ---- Tubazioni di adduzione: LINEE DRITTE lungo le file di pivot. Rileva
// l'orientamento del reticolo, raggruppa i pivot in file collineari e traccia
// per ogni fila una linea retta che si dirama dal canale; l'utente sceglie
// quanti pivot al massimo per linea. Calcolo locale in metri. ----
function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function feederPipes(canal: number[][], pivs: { lat: number; lng: number; r?: number }[], maxPerLine: number, ring: number[][] | null): number[][][] {
  if (pivs.length < 1 || canal.length < 2) return [];
  const lat0 = pivs.reduce((s, p) => s + p.lat, 0) / pivs.length;
  const mLat = 111320, mLng = 111320 * Math.cos((lat0 * Math.PI) / 180) || 1e-9;
  const P: [number, number][] = pivs.map((p) => [p.lng * mLng, p.lat * mLat]);
  const C: [number, number][] = canal.map((c) => [c[0] * mLng, c[1] * mLat]);
  const R: [number, number][] | null = ring ? ring.map((c) => [c[0] * mLng, c[1] * mLat]) : null;
  const toLL = (x: number, y: number): number[] => [x / mLng, y / mLat];
  const cap = Math.max(1, Math.round(maxPerLine || 999));
  const REACH = 10;            // quanto si prolunga una fila all'indietro per cercare il canale (× passo)
  const LINK_TOL = 20;         // tolleranza angolare per considerare due pivot "in fila" (gradi)
  const NB_F = 1.55;           // raggio di vicinato (× passo)
  const TAP_ANG = 45;          // massima piega ammessa fra allaccio e fila (gradi)

  // --- geometria di base -------------------------------------------------
  const inside = (pt: [number, number]) => {
    if (!R) return true;
    let c = false;
    for (let i = 0, j = R.length - 1; i < R.length; j = i++) {
      const xi = R[i][0], yi = R[i][1], xj = R[j][0], yj = R[j][1];
      if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < ((xj - xi) * (pt[1] - yi)) / ((yj - yi) || 1e-12) + xi)) c = !c;
    }
    return c;
  };
  const segInside = (a: [number, number], b: [number, number]) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(2, Math.ceil(L / 60));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (!inside([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) return false;
    }
    return true;
  };
  // Primo punto in cui il segmento a→b incrocia il canale (null se non lo incrocia).
  const xCanal = (a: [number, number], b: [number, number]): [number, number] | null => {
    let best: [number, number] | null = null, bt = 2;
    for (let k = 0; k < C.length - 1; k++) {
      const c = C[k], d = C[k + 1];
      const rx = b[0] - a[0], ry = b[1] - a[1], sx2 = d[0] - c[0], sy2 = d[1] - c[1];
      const den = rx * sy2 - ry * sx2; if (Math.abs(den) < 1e-9) continue;
      const t = ((c[0] - a[0]) * sy2 - (c[1] - a[1]) * sx2) / den;
      const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < bt) { bt = t; best = [a[0] + rx * t, a[1] + ry * t]; }
    }
    return best;
  };
  const footOf = (pt: [number, number]) => {
    let bd = Infinity, bq: [number, number] = C[0];
    for (let k = 0; k < C.length - 1; k++) {
      const a = C[k], b = C[k + 1]; const abx = b[0] - a[0], aby = b[1] - a[1];
      const l2 = abx * abx + aby * aby || 1e-9;
      const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * abx + (pt[1] - a[1]) * aby) / l2));
      const qx = a[0] + abx * t, qy = a[1] + aby * t; const dd = (pt[0] - qx) ** 2 + (pt[1] - qy) ** 2;
      if (dd < bd) { bd = dd; bq = [qx, qy]; }
    }
    return { q: bq, dist: Math.sqrt(bd) };
  };
  const foot = P.map(footOf);

  const nnd: number[] = [];
  for (let i = 0; i < P.length; i++) {
    let b = Infinity;
    for (let j = 0; j < P.length; j++) { if (i === j) continue; const d = (P[j][0] - P[i][0]) ** 2 + (P[j][1] - P[i][1]) ** 2; if (d < b) b = d; }
    if (b < Infinity) nnd.push(Math.sqrt(b));
  }
  const pitch = median(nnd) || 800;

  // --- direzioni del reticolo (fino a 3, rilevate dai pivot) --------------
  const H = new Array(180).fill(0);
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    const vx = P[j][0] - P[i][0], vy = P[j][1] - P[i][1]; const L = Math.hypot(vx, vy);
    if (L > 1.35 * pitch) continue;
    let a = (Math.atan2(vy, vx) * 180) / Math.PI; a = ((a % 180) + 180) % 180;
    H[Math.round(a) % 180]++;
  }
  const sm = H.map((_, i) => H[(i + 178) % 180] + H[(i + 179) % 180] + H[i] + H[(i + 1) % 180] + H[(i + 2) % 180]);
  const dirsDeg: number[] = [];
  for (const [v, i] of sm.map((v, i) => [v, i] as [number, number]).sort((a, b) => b[0] - a[0])) {
    if (v < 6) break;
    if (dirsDeg.some((d) => { const dd = Math.abs(d - i); return Math.min(dd, 180 - dd) < 20; })) continue;
    dirsDeg.push(i); if (dirsDeg.length >= 3) break;
  }
  if (!dirsDeg.length) dirsDeg.push(90);
  const dv: [number, number][] = dirsDeg.map((a) => [Math.cos((a * Math.PI) / 180), Math.sin((a * Math.PI) / 180)]);

  // Il canale viene semplificato in pochi TRATTI lunghi con orientamento stabile
  // (Douglas-Peucker): ogni tratto detta la direzione delle tubazioni che gli
  // stanno davanti, così le linee restano perpendicolari al canale LOCALE anche
  // dove il canale gira, invece di seguire un'unica direzione media.
  const RDP_TOL = 1500;
  const rdp = (pts: [number, number][], tol: number): [number, number][] => {
    if (pts.length < 3) return pts.slice();
    const dOf = (p: [number, number], a: [number, number], b: [number, number]) => {
      const vx = b[0] - a[0], vy = b[1] - a[1]; const l2 = vx * vx + vy * vy || 1e-9;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2));
      return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
    };
    const rec = (a: number, b: number): [number, number][] => {
      let bi = -1, bd = 0;
      for (let i = a + 1; i < b; i++) { const d = dOf(pts[i], pts[a], pts[b]); if (d > bd) { bd = d; bi = i; } }
      if (bd > tol && bi > 0) return [...rec(a, bi), ...rec(bi, b).slice(1)];
      return [pts[a], pts[b]];
    };
    return rec(0, pts.length - 1);
  };
  const CS = rdp(C, RDP_TOL);
  // Per ogni tratto: la direzione del reticolo che sta entro ±20° dalla sua
  // PERPENDICOLARE. Se nessuna ci rientra si tiene comunque la più vicina (con
  // tre direzioni a 60° lo scarto massimo è 30°), altrimenti le tubazioni non
  // potrebbero più seguire le file di pivot.
  // Tolleranza di ortogonalità: entro questo scarto dalla perpendicolare del
  // tratto una direzione del reticolo è AMMESSA. Con ±45° su un tratto ce n'è
  // quasi sempre più d'una: fra quelle ammesse si sceglie poi la migliore, cioè
  // quella che forma le file più lunghe (meno tubazioni, rete più ordinata).
  const ORTHO_DEG = 45;
  const ORTHO_TOL = Math.cos((ORTHO_DEG * Math.PI) / 180);
  let offGrid = 0;
  const segCand: number[][] = [];   // direzioni ammesse per ogni tratto, dalla più ortogonale
  for (let k = 0; k < CS.length - 1; k++) {
    const vx = CS[k + 1][0] - CS[k][0], vy = CS[k + 1][1] - CS[k][1]; const L = Math.hypot(vx, vy) || 1;
    const nx = -vy / L, ny = vx / L;
    const scored = dv.map((d, q) => ({ q, c: Math.abs(d[0] * nx + d[1] * ny) })).sort((a, b) => b.c - a.c);
    const ok = scored.filter((x) => x.c >= ORTHO_TOL).map((x) => x.q);
    if (!ok.length) { offGrid++; ok.push(scored[0].q); }   // nessuna ammessa: la più vicina
    segCand.push(ok);
  }
  const nearSeg = (pt: [number, number]) => {
    let bi = 0, bd = Infinity;
    for (let k = 0; k < CS.length - 1; k++) {
      const a = CS[k], b = CS[k + 1]; const vx = b[0] - a[0], vy = b[1] - a[1]; const l2 = vx * vx + vy * vy || 1e-9;
      const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * vx + (pt[1] - a[1]) * vy) / l2));
      const d = Math.hypot(pt[0] - (a[0] + vx * t), pt[1] - (a[1] + vy * t));
      if (d < bd) { bd = d; bi = k; }
    }
    return bi;
  };

  // --- vicinato ----------------------------------------------------------
  type NB = { j: number; ux: number; uy: number; L: number };
  const nb: NB[][] = P.map(() => []);
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    const vx = P[j][0] - P[i][0], vy = P[j][1] - P[i][1]; const L = Math.hypot(vx, vy);
    if (L > NB_F * pitch || L < 1e-6) continue;
    nb[i].push({ j, ux: vx / L, uy: vy / L, L }); nb[j].push({ j: i, ux: -vx / L, uy: -vy / L, L });
  }
  const cosL = Math.cos((LINK_TOL * Math.PI) / 180);

  // --- prese sul canale --------------------------------------------------
  // presa "dritta": prolunga la fila all'indietro finché incontra il canale
  const straightTap = (p0: [number, number], dir: [number, number]): [number, number] | null => {
    const b: [number, number] = [p0[0] - dir[0] * REACH * pitch, p0[1] - dir[1] * REACH * pitch];
    const x = xCanal(p0, b);
    if (x && inside(x) && segInside(x, p0)) return x;
    return null;
  };
  const canalPts: [number, number][] = [];
  for (let k = 0; k < C.length - 1; k++) {
    const a = C[k], b = C[k + 1]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(L / 25));
    for (let i = 0; i < n; i++) canalPts.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  }
  canalPts.push(C[C.length - 1]);
  const tapMax = Math.cos((TAP_ANG * Math.PI) / 180);
  const nearTap = (pt: [number, number], dir: [number, number] | null, own?: Set<number>): [number, number] => {
    let best: [number, number] | null = null, bd = Infinity;
    let fb: [number, number] | null = null, fd = Infinity;
    for (const q of canalPts) {
      const d = Math.hypot(q[0] - pt[0], q[1] - pt[1]);
      if (d < 1 || (d >= bd && d >= fd)) continue;
      if (!inside(q)) continue;
      if (dir) { const ux = (pt[0] - q[0]) / d, uy = (pt[1] - q[1]) / d; if (ux * dir[0] + uy * dir[1] < tapMax) continue; }
      if (own && !clearOf(q, pt, own)) continue;
      if (d < fd) { fd = d; fb = q; }
      if (d < bd && segInside(q, pt)) { bd = d; best = q; }
    }
    if (best || fb) return (best ?? fb) as [number, number];
    if (own) return nearTap(pt, dir, undefined);
    return dir ? nearTap(pt, null) : footOf(pt).q;
  };

  // --- file di pivot: cammini semplici lungo la direzione scelta ----------
  const makeRows = (ids: number[], kOf: (i: number) => number): number[][] => {
    const on = new Set(ids);
    const pick = (i: number, s: number) => {
      const d = dv[kOf(i)]; let bj = -1, bs = -1;
      for (const n2 of nb[i]) {
        if (!on.has(n2.j) || kOf(n2.j) !== kOf(i)) continue;
        const c = (n2.ux * d[0] + n2.uy * d[1]) * s; if (c < cosL) continue;
        const sc = c - 0.0004 * n2.L; if (sc > bs) { bs = sc; bj = n2.j; }
      }
      return bj;
    };
    const nxt = new Map<number, number>(), prv = new Map<number, number>();
    for (const i of ids) { const j = pick(i, 1); if (j >= 0 && pick(j, -1) === i) { nxt.set(i, j); prv.set(j, i); } }
    const rows: number[][] = []; const seen = new Set<number>();
    const walk = (i: number) => { const ch: number[] = []; let u: number | undefined = i; while (u !== undefined && !seen.has(u)) { seen.add(u); ch.push(u); u = nxt.get(u); } return ch; };
    for (const i of ids) if (!seen.has(i) && !prv.has(i)) rows.push(walk(i));
    for (const i of ids) if (!seen.has(i)) rows.push(walk(i));   // anelli residui
    return rows.filter((r) => r.length);
  };

  // le file che attraversano il canale vengono tagliate: due tubazioni opposte
  const cutRows = (rows: number[][]) => {
    const out: { idx: number[]; tap: [number, number] | null }[] = [];
    for (const r of rows) {
      let cur: number[] = [r[0]];
      for (let k = 1; k < r.length; k++) {
        const x = xCanal(P[r[k - 1]], P[r[k]]);
        if (x) { out.push({ idx: cur, tap: x }); cur = [r[k]]; } else cur.push(r[k]);
      }
      out.push({ idx: cur, tap: null });
    }
    return out;
  };

  // Due tubazioni non possono partire dallo stesso identico punto del canale:
  // se la presa calcolata coincide con una già usata, scivola lungo il canale.
  const MIN_SEP = 0.12 * pitch;
  const OFF_LANE = 0.45 * pitch;   // distanza fra due tubi paralleli della stessa fila
  // REGOLA: un pivot può essere attraversato SOLO dalla sua tubazione. Il raggio
  // di rispetto è quello del pivot stesso (il suo cerchio); dove il raggio non è
  // noto si usa una frazione del passo.
  const RAD = pivs.map((p) => (p.r && p.r > 0 ? p.r : 0.30 * pitch));
  const CLEAR = 0.30 * pitch;
  const distSeg = (p: [number, number], a: [number, number], b: [number, number]) => {
    const vx = b[0] - a[0], vy = b[1] - a[1]; const l2 = vx * vx + vy * vy || 1e-9;
    let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2; t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
  };
  const clearOf = (a: [number, number], b: [number, number], own: Set<number>) => {
    for (let i = 0; i < P.length; i++) { if (own.has(i)) continue; if (distSeg(P[i], a, b) < RAD[i]) return false; }
    return true;
  };
  const usedTaps: [number, number][] = [];
  const tapFree = (q: [number, number]) => usedTaps.every((u) => Math.hypot(u[0] - q[0], u[1] - q[1]) >= MIN_SEP);
  const spread = (q: [number, number], p0: [number, number], dir: [number, number] | null): [number, number] => {
    if (tapFree(q)) return q;
    let best: [number, number] | null = null, bd = Infinity;
    for (const c of canalPts) {
      if (!tapFree(c) || !inside(c)) continue;
      const d = Math.hypot(c[0] - q[0], c[1] - q[1]); if (d >= bd) continue;
      const L = Math.hypot(p0[0] - c[0], p0[1] - c[1]) || 1;
      if (dir && ((p0[0] - c[0]) / L * dir[0] + (p0[1] - c[1]) / L * dir[1]) < tapMax) continue;
      if (!segInside(c, p0)) continue;
      bd = d; best = c;
    }
    return best ?? q;
  };

  // Un allaccio non può essere più lungo di questo: oltre, il pivot viene
  // attaccato alla fila vicina invece di ricevere una tubazione tutta sua che
  // attraversa mezzo campo.
  const maxTap = (i: number) => Math.max(2 * foot[i].dist, 1.5 * pitch);
  const toPipes = (cuts: { idx: number[]; tap: [number, number] | null }[], kOf: (i: number) => number, allowFallback: boolean) => {
    const pipes: { path: [number, number][]; ids: number[] }[] = []; const orphans: number[] = []; const far: number[] = [];
    for (const s of cuts) {
      if (!s.idx.length) continue;
      let ln = s.idx;
      if (s.tap) {
        const a = P[ln[0]], b = P[ln[ln.length - 1]];
        if (Math.hypot(b[0] - s.tap[0], b[1] - s.tap[1]) < Math.hypot(a[0] - s.tap[0], a[1] - s.tap[1])) ln = [...ln].reverse();
      } else if (foot[ln[ln.length - 1]].dist < foot[ln[0]].dist) ln = [...ln].reverse();
      for (let k = 0, ci = 0; k < ln.length; k += cap, ci++) {
        const ch = ln.slice(k, k + cap);
        let dir: [number, number];
        if (ch.length > 1) {
          const a = P[ch[0]], b = P[ch[1]]; const vx = b[0] - a[0], vy = b[1] - a[1]; const L = Math.hypot(vx, vy) || 1;
          dir = [vx / L, vy / L];
        } else if (ln.length > 1) {
          const a = P[ln[Math.max(0, k - 1)]], b = P[ch[0]]; const vx = b[0] - a[0], vy = b[1] - a[1]; const L = Math.hypot(vx, vy) || 1;
          dir = [vx / L, vy / L];
        } else {
          const d = dv[kOf(ch[0])]; const q = foot[ch[0]].q;
          const s1 = (P[ch[0]][0] - q[0]) * d[0] + (P[ch[0]][1] - q[1]) * d[1];
          dir = s1 >= 0 ? [d[0], d[1]] : [-d[0], -d[1]];
        }
        // Tratti successivi della STESSA fila: se ripartissero dal canale sulla
        // stessa retta ricalcherebbero il tubo precedente. Vengono quindi spostati
        // di lato (linea parallela) e rientrano sulla fila al loro primo pivot.
        const lat: [number, number] = [-dir[1], dir[0]];
        const A = P[ch[0]];
        // "Suoi" sono i pivot dell'INTERA fila: un tratto successivo corre
        // legittimamente accanto ai pivot già alimentati dal tratto precedente
        // (in corsia affiancata). Il vincolo vale verso le ALTRE file.
        const own = new Set(ln);
        // Corsie candidate: la fila stessa, poi spostamenti laterali crescenti.
        // Si sceglie la prima il cui allaccio non sfiora pivot di altre tubazioni.
        const lanes: number[] = ci > 0 ? [ci, ci + 1, -ci, ci + 2] : [0, 1, -1, 2, -2];
        let tp: [number, number] | null = null, via: [number, number] | null = null;
        if (k === 0 && s.tap && segInside(s.tap, A) && clearOf(s.tap, A, own)) tp = s.tap;
        if (!tp) {
          for (const ln2 of lanes) {
            const st: [number, number] = ln2 === 0 ? A : [A[0] + lat[0] * ln2 * OFF_LANE, A[1] + lat[1] * ln2 * OFF_LANE];
            const cand = straightTap(st, dir);
            if (!cand) continue;
            if (!clearOf(cand, st, own)) continue;
            if (ln2 !== 0 && !clearOf(st, A, own)) continue;
            // Se la presa trovata sulla corsia laterale si collega comunque in
            // linea retta al primo pivot senza sfiorare pivot altrui, si evita
            // il gomito e la tubazione resta una sola retta obliqua.
            tp = cand; via = ln2 === 0 || clearOf(cand, A, own) ? null : st; break;
          }
        }
        if (!tp) {
          if (!allowFallback) { orphans.push(...ch); continue; }
          // Ripiego: nessuna corsia arriva dritta al canale. Si prende comunque
          // l'allaccio più corto possibile — se quello "in linea" costringe a un
          // giro lungo, meglio una piega che chilometri di tubo in diagonale.
          const cands: [number, number][] = [nearTap(A, dir, own), nearTap(A, null, own), footOf(A).q];
          const pick2 = (arr: [number, number][]) =>
            arr.reduce((b, c) => (Math.hypot(c[0] - A[0], c[1] - A[1]) < Math.hypot(b[0] - A[0], b[1] - A[1]) ? c : b));
          const okC = cands.filter((c) => inside(c) && segInside(c, A));
          const freeC = okC.filter((c) => clearOf(c, A, own));       // niente pivot altrui sul percorso
          // REGOLA VINCOLANTE: se nessun allaccio evita i pivot altrui non si
          // traccia nulla — questi pivot vanno agganciati a una fila vicina.
          if (!freeC.length) { far.push(...ch); continue; }
          tp = pick2(freeC);
        }
        // Allaccio spropositato — vale per QUALSIASI presa, anche quella dritta:
        // non si traccia, e i pivot passano al recupero finale che li aggancia a
        // una fila vicina invece di far attraversare il campo a un tubo solo.
        const ref = via ?? A;
        if (Math.hypot(tp[0] - ref[0], tp[1] - ref[1]) > maxTap(ch[0])) { far.push(...ch); continue; }
        tp = spread(tp, ref, dir); usedTaps.push(tp);
        const path: [number, number][] = [tp];
        if (via) path.push(via);
        for (const i of ch) path.push(P[i]);
        pipes.push({ path, ids: ch });
      }
    }
    return { pipes, orphans, far };
  };

  // PASSO 1 — ogni pivot prende la direzione perpendicolare al TRATTO di canale
  // che ha davanti; il voto di maggioranza fra vicini rende netti i confini fra
  // zone con orientamento diverso, così le file non si spezzano al passaggio.
  const all = P.map((_, i) => i);
  // Per ogni tratto si prova ogni direzione ammessa sui SOLI pivot che gli stanno
  // davanti e si tiene quella che li mette in file più lunghe: con ±45° è questa
  // scelta, non la pura ortogonalità, a decidere la qualità del tracciato.
  const bySeg = new Map<number, number[]>();
  P.forEach((pt, i) => { const sg = nearSeg(pt); const arr = bySeg.get(sg); if (arr) arr.push(i); else bySeg.set(sg, [i]); });
  const segDir: number[] = [];
  for (let sg = 0; sg < segCand.length; sg++) {
    const ids = bySeg.get(sg) ?? [];
    const cands = segCand[sg];
    let bk = cands[0], bs = -Infinity;
    for (const k of cands) {
      const rws = makeRows(ids, () => k);
      const inChains = rws.reduce((a, r) => a + (r.length > 1 ? r.length : 0), 0);
      const score = inChains - 0.6 * rws.length;      // molti pivot in fila, poche file
      if (score > bs) { bs = score; bk = k; }
    }
    segDir.push(bk);
  }
  let kA = P.map((pt) => segDir[nearSeg(pt)] ?? 0);
  for (let it = 0; it < 8; it++) {
    let same = true;
    const nx = kA.map((_, i) => {
      const w = new Map<number, number>();
      w.set(kA[i], 1.3);
      for (const n2 of nb[i]) w.set(kA[n2.j], (w.get(kA[n2.j]) || 0) + 1);
      let bk = kA[i], bv = -1;
      for (const [k, v] of w) if (v > bv) { bv = v; bk = k; }
      return bk;
    });
    for (let i = 0; i < kA.length; i++) if (nx[i] !== kA[i]) same = false;
    kA = nx; if (same) break;
  }
  const kG = (i: number) => kA[i];
  const r1 = toPipes(cutRows(makeRows(all, kG)), kG, false);
  let pipes = r1.pipes;
  const leftovers: number[] = [];

  // PASSO 2 — i pivot che con quella direzione non arrivano dritti al canale
  // (tipico dei lembi dove il canale gira) usano la direzione del reticolo che
  // ci arriva, decisa in blocco per contiguità.
  if (r1.orphans.length) {
    const orph = r1.orphans;
    const costK = (i: number, k: number) => {
      const d = dv[k]; let best = Infinity;
      for (const sg of [1, -1]) {
        const x = straightTap(P[i], [d[0] * sg, d[1] * sg]);
        if (x) { const L = Math.hypot(x[0] - P[i][0], x[1] - P[i][1]); if (L < best) best = L; }
      }
      return best;
    };
    const k2 = new Map<number, number>();
    for (const i of orph) {
      let bk = kA[i], bc = Infinity;
      for (let k = 0; k < dv.length; k++) { const c = costK(i, k); if (c < bc) { bc = c; bk = k; } }
      k2.set(i, isFinite(bc) ? bk : kA[i]);
    }
    for (let it = 0; it < 6; it++) {
      const nx = new Map<number, number>(); let same = true;
      for (const i of orph) {
        const w = new Map<number, number>();
        w.set(k2.get(i) as number, 1.2);
        for (const n2 of nb[i]) { const kk = k2.get(n2.j); if (kk !== undefined) w.set(kk, (w.get(kk) || 0) + 1); }
        let bk = k2.get(i) as number, bv = -1;
        for (const [k, v] of w) if (v > bv) { bv = v; bk = k; }
        nx.set(i, bk); if (bk !== k2.get(i)) same = false;
      }
      for (const [a, b] of nx) k2.set(a, b);
      if (same) break;
    }
    const kOf2 = (i: number) => k2.get(i) ?? kA[i];
    const r2 = toPipes(cutRows(makeRows(orph, kOf2)), kOf2, true);
    pipes = pipes.concat(r2.pipes);
    leftovers.push(...r2.far);
  }
  leftovers.push(...r1.far);

  // PASSO 3 — pivot rimasti senza tubazione perché l'unico allaccio possibile
  // era spropositato: si agganciano in coda alla fila vicina (che ha ancora
  // posto entro il massimo per linea) invece di farsi una linea propria.
  if (leftovers.length) {
    let stillFar: number[] = [];
    // Dal più vicino al canale: agganciato il primo, il secondo può agganciarsi a
    // lui, e così via — è così che un lembo lontano diventa un'unica fila.
    let queue = [...new Set(leftovers)].sort((a, b) => foot[a].dist - foot[b].dist);
    for (let pass = 0; pass < 6 && queue.length; pass++) {
      stillFar = [];
      for (const i of queue) {
      let best = -1, bs = Infinity;
      for (let pi = 0; pi < pipes.length; pi++) {
        const pp = pipes[pi];
        if (pp.ids.length >= cap) continue;
        const last = P[pp.ids[pp.ids.length - 1]];
        const d = Math.hypot(P[i][0] - last[0], P[i][1] - last[1]);
        if (d > 1.9 * pitch) continue;
        if (!segInside(last, P[i])) continue;
        const own2 = new Set([...pp.ids, i]);
        if (!clearOf(last, P[i], own2)) continue;
        // piega all'innesto: si preferisce il prolungamento più dritto
        const prev = pp.path[pp.path.length - 2];
        const ax = last[0] - prev[0], ay = last[1] - prev[1];
        const bx = P[i][0] - last[0], by = P[i][1] - last[1];
        const cos = (ax * bx + ay * by) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1);
        const ang = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
        if (ang > 60) continue;
        const sc = d + 8 * ang;
        if (sc < bs) { bs = sc; best = pi; }
      }
        if (best >= 0) { pipes[best].path.push(P[i]); pipes[best].ids.push(i); }
        else stillFar.push(i);
      }
      if (stillFar.length === queue.length) break;   // nessun progresso
      queue = stillFar;
    }
    stillFar = queue;
    // Restano i lembi dove NON esiste ancora nessuna tubazione a cui agganciarsi:
    // vanno raggruppati e serviti da una capofila unica. I pivot dello stesso
    // gruppo finiscono sulla stessa linea, quindi attraversarli è legittimo.
    if (stillFar.length) {
      const idx = new Map(stillFar.map((v, k) => [v, k] as const));
      const par = stillFar.map((_, k) => k);
      const find = (a: number): number => (par[a] === a ? a : (par[a] = find(par[a])));
      for (const a of stillFar) for (const b of stillFar) {
        if (a >= b) continue;
        if (Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1]) <= 1.9 * pitch) {
          const ra = find(idx.get(a) as number), rb = find(idx.get(b) as number); if (ra !== rb) par[ra] = rb;
        }
      }
      const groups = new Map<number, number[]>();
      for (const v of stillFar) { const r = find(idx.get(v) as number); const g2 = groups.get(r); if (g2) g2.push(v); else groups.set(r, [v]); }
      for (const grp of groups.values()) {
        const ord = [...grp].sort((a, b) => foot[a].dist - foot[b].dist);
        const ownG = new Set(ord);                     // il gruppo starà tutto su questa linea
        const head = ord[0];
        const d = dv[kA[head]]; const q = foot[head].q;
        const s1 = (P[head][0] - q[0]) * d[0] + (P[head][1] - q[1]) * d[1];
        const dir: [number, number] = s1 >= 0 ? [d[0], d[1]] : [-d[0], -d[1]];
        const cands: [number, number][] = [straightTap(P[head], dir) ?? footOf(P[head]).q, nearTap(P[head], null, ownG), footOf(P[head]).q];
        const ok2 = cands.filter((c) => inside(c) && segInside(c, P[head]) && clearOf(c, P[head], ownG));
        const arr = ok2.length ? ok2 : cands.filter((c) => inside(c) && segInside(c, P[head]));
        const arr2 = arr.length ? arr : cands;
        const tp2 = arr2.reduce((b, c) => (Math.hypot(c[0] - P[head][0], c[1] - P[head][1]) < Math.hypot(b[0] - P[head][0], b[1] - P[head][1]) ? c : b));
        // La capofila raccoglie il gruppo in fila, fino al massimo per linea.
        const chainIds: number[] = [head]; const path: [number, number][] = [tp2, P[head]];
        let cur = head; const rest = new Set(ord.slice(1));
        while (rest.size && chainIds.length < cap) {
          let bj = -1, bd = Infinity;
          for (const j of rest) { const dd = Math.hypot(P[j][0] - P[cur][0], P[j][1] - P[cur][1]); if (dd < bd) { bd = dd; bj = j; } }
          if (bj < 0) break;
          rest.delete(bj); chainIds.push(bj); path.push(P[bj]); cur = bj;
        }
        pipes.push({ path, ids: chainIds });
        // eventuali avanzi del gruppo: una seconda linea affiancata
        if (rest.size) {
          const ord2 = [...rest].sort((a, b) => foot[a].dist - foot[b].dist);
          const h2 = ord2[0];
          const t2 = nearTap(P[h2], null, ownG);
          pipes.push({ path: [t2, ...ord2.map((i) => P[i])], ids: ord2 });
        }
      }
    }
  }

  if (offGrid) {
    // diagnostica non bloccante: quanti tratti di canale non hanno una direzione
    // del reticolo ortogonale entro 20°
    // eslint-disable-next-line no-console
    console.info(`[tubazioni] ${offGrid} tratti di canale senza direzione ortogonale entro ${ORTHO_DEG}°`);
  }
  return pipes.map((pp) => pp.path.map((q) => toLL(q[0], q[1])));
}

// Preimpostazioni grafiche di sistema, distinte per livello della piramide:
// AREE = toni caldi/neutri, riempimento tenue (contenitori); CAMPI = toni vividi,
// riempimento più marcato (poligoni operativi).
const AREA_PRESETS = [
  { name: "Ambra", color: "#e8973d", fillColor: "#e8973d", fillOpacity: 0.08 },
  { name: "Terracotta", color: "#c1553b", fillColor: "#c1553b", fillOpacity: 0.09 },
  { name: "Sabbia", color: "#a9863f", fillColor: "#caa661", fillOpacity: 0.10 },
  { name: "Ardesia", color: "#5b7089", fillColor: "#5b7089", fillOpacity: 0.08 },
  { name: "Prugna", color: "#7d3c73", fillColor: "#7d3c73", fillOpacity: 0.08 },
];
const CAMPO_PRESETS = [
  { name: "Verde", color: "#03a047", fillColor: "#038037", fillOpacity: 0.16 },
  { name: "Verde acqua", color: "#0f9d8f", fillColor: "#0f9d8f", fillOpacity: 0.18 },
  { name: "Lime", color: "#5ea223", fillColor: "#6fae2f", fillOpacity: 0.18 },
  { name: "Blu", color: "#2f6fd0", fillColor: "#2f6fd0", fillOpacity: 0.16 },
  { name: "Ciano", color: "#0aa5c2", fillColor: "#0aa5c2", fillOpacity: 0.16 },
];

// Icone (stile lineare, 16px) per la barra strumenti in alto.
const svgProps = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const IcoUndo = () => (<svg {...svgProps}><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-1" /></svg>);
const IcoRedo = () => (<svg {...svgProps}><path d="m15 14 5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h1" /></svg>);
const IcoLayers = () => (<svg {...svgProps}><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></svg>);
const IcoRuler = () => (<svg {...svgProps}><path d="M3 15 15 3l6 6L9 21z" /><path d="M7.5 10.5 9 12M10.5 7.5 12 9M13.5 4.5 15 6" /></svg>);
const IcoCircleRuler = () => (<svg {...svgProps}><circle cx="12" cy="12" r="8.5" /><path d="M12 12h8.5" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /></svg>);
const IcoElevation = () => (<svg {...svgProps}><path d="M3 20h18" /><path d="m3 17 5-7 3 3.5L16 5l5 12" /></svg>);
const IcoMinimize = () => (<svg {...svgProps}><path d="M5 12h14" /></svg>);
const IcoExpand = () => (<svg {...svgProps}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 12h6M12 9v6" /></svg>);
const IcoCross = () => (<svg {...svgProps}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>);
const IcoHome = () => (<svg {...svgProps}><path d="m3 11 9-7 9 7" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></svg>);
const IcoBell = () => (<svg {...svgProps}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>);
const IcoPipeNew = () => (<svg {...svgProps}><path d="M3 20h6l6-12h6" /><path d="M15 5h5v5" /></svg>);
const IcoPipeBranch = () => (<svg {...svgProps}><path d="M4 20h6a4 4 0 0 0 4-4V4" /><path d="M14 10h6" /><circle cx="14" cy="10" r="1.6" /></svg>);
const IcoPipePoint = () => (<svg {...svgProps}><path d="M3 12h18" /><circle cx="12" cy="12" r="3" /></svg>);
const IcoArrowLeft = () => (<svg {...svgProps}><path d="M20 12H4" /><path d="m10 6-6 6 6 6" /></svg>);
const IcoArrowRight = () => (<svg {...svgProps}><path d="M4 12h16" /><path d="m14 6 6 6-6 6" /></svg>);
const IcoTrash = () => (<svg {...svgProps}><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></svg>);
const IcoDash = () => (<svg {...svgProps}><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></svg>);

// Icone del menu verticale (20px): una per ogni pagina del flusso di progetto.
const navProps = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const IcoNavAnalisi = () => (<svg {...navProps}><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>);
const IcoNavRilievo = () => (<svg {...navProps}><path d="m3 20 6-9 4 5 3-4 5 8z" /></svg>);
const IcoNavImpianti = () => (<svg {...navProps}><circle cx="12" cy="12" r="8" /><path d="M12 12h8" /><circle cx="12" cy="12" r="1.6" /></svg>);
const IcoNavAccessori = () => (<svg {...navProps}><path d="M2 9h8" /><path d="M2 15h8" /><path d="M10 7v10" /><path d="M14 7v10" /><path d="M14 9h2a5 5 0 0 1 5 5v8" /><path d="M14 15h1a1 1 0 0 1 1 1v6" /></svg>);
const IcoNavStrade = () => (<svg {...navProps}><path d="M8 3 4 21" /><path d="m16 3 4 18" /><path d="M12 4v3M12 10.5v3M12 17v3" /></svg>);
const IcoNavFonte = () => (<svg {...navProps}><path d="M3 8c2 0 2-1.5 4.5-1.5S10 8 12 8s2-1.5 4.5-1.5S19 8 21 8" /><path d="M3 13c2 0 2-1.5 4.5-1.5S10 13 12 13s2-1.5 4.5-1.5S19 13 21 13" /><path d="M12 16v5" /><path d="m9.5 18.5 2.5 2.5 2.5-2.5" /></svg>);
const IcoNavPompaggio = () => (<svg {...navProps}><circle cx="10" cy="13" r="6" /><circle cx="10" cy="13" r="1.6" /><path d="M10 7V3h8v4" /><path d="M16 13h6" /><path d="M5 20h10" /></svg>);
const IcoNavExport = () => (<svg {...navProps}><path d="M12 3v11" /><path d="m7 10 5 5 5-5" /><path d="M4 20h16" /></svg>);
const IcoNavIrrigazione = () => (<svg {...navProps}><path d="M12 3s5 5.5 5 9a5 5 0 0 1-10 0c0-3.5 5-9 5-9Z" /><path d="M10 13a2 2 0 0 0 4 0" /></svg>);
const IcoNavInfo = () => (<svg {...navProps}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.6v.6" /></svg>);
const TAB_ICONS = {
  analisi: IcoNavAnalisi, rilievo: IcoNavRilievo, impianti: IcoNavImpianti,
  fonte: IcoNavFonte, accessori: IcoNavAccessori, pompaggio: IcoNavPompaggio, strade: IcoNavStrade, irrigazione: IcoNavIrrigazione, export: IcoNavExport,
  informazioni: IcoNavInfo,
};

// Intestazione di sezione con testo-guida apribile/chiudibile da "?"
// (compatta la vista: i suggerimenti restano nascosti finché non servono).
// «?» accanto all'etichetta di un singolo campo: stesso comportamento del "?"
// delle sezioni, ma inline e senza titolo proprio.
function FieldHelp({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  return (<>
    <button type="button" onClick={() => setOpen((v) => !v)} aria-label={t("Aiuto")} title={text}
      className={"inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold leading-none align-middle transition "
        + (open ? "bg-brand text-white" : "bg-sage/20 text-sage-dark hover:bg-brand hover:text-white")}>?</button>
    {open && <p className="hint mt-1">{text}</p>}
  </>);
}

function SectionHead({ title, help, mb = "mb-2" }: { title: string; help?: string; mb?: string }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  return (
    <div className={mb}>
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-semibold text-brand-darker">{title}</h3>
        {help && (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-label={t("Aiuto")}
            className={"inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold leading-none transition "
              + (open ? "bg-brand text-white" : "bg-sage/20 text-sage-dark hover:bg-brand hover:text-white")}>?</button>
        )}
      </div>
      {help && open && <p className="hint mt-1">{help}</p>}
    </div>
  );
}

// Colore del testo del chip crediti secondo la % usata: ≥80% rosso, ≥50% ruggine.
function creditClass(u: api.Usage): string {
  if (u.requests_limit == null || u.requests_limit === 0) return "text-sage-dark";
  const pct = u.pct_used ?? (100 * u.requests_used / u.requests_limit);
  return pct >= 80 ? "text-danger" : pct >= 50 ? "text-rust" : "text-sage-dark";
}

export default function Page() {
  const { t, lang, setLang, fmt, fmtDate } = useI18n();
  // Testi di fonte d'acqua e computo: di norma nella lingua dell'interfaccia,
  // per la stampa nella lingua scelta per il PDF (vedi inLang).
  let tx = t, fx = fmt;
  function inLang<T>(l: Lang, fn: () => T): T {
    const t0 = tx, f0 = fx, tr = translatorFor(l);
    tx = tr.t; fx = tr.fmt;
    try { return fn(); } finally { tx = t0; fx = f0; }
  }
  const router = useRouter();
  // Unità di misura: metrico (default) o imperiale. Converte i valori mostrati.
  const [units, setUnits] = useState<"metric" | "imperial">("metric");
  const imperial = units === "imperial";
  const uHa = (ha: number, dp = 0) => imperial
    ? `${fmt(ha * 2.47105, { maximumFractionDigits: dp })} ac`
    : `${fmt(ha, { maximumFractionDigits: dp })} ha`;
  const uM = (m: number, dp = 0) => imperial
    ? `${fmt(m * 3.28084, { maximumFractionDigits: dp })} ft`
    : `${fmt(m, { maximumFractionDigits: dp })} m`;
  const uKm = (km: number, dp = 2) => imperial
    ? `${fmt(km * 0.621371, { maximumFractionDigits: dp })} mi`
    : `${fmt(km, { maximumFractionDigits: dp })} km`;
  const mapApi = useRef<MapHandle | null>(null);

  const [providerMode, setProviderMode] = useState<string>("");
  // --- Autenticazione / crediti ---
  const [me, setMe] = useState<api.Me | null>(null);
  const [usage, setUsage] = useState<api.Usage | null>(null);
  const [showUsers, setShowUsers] = useState(false);
  const [adminUsers, setAdminUsers] = useState<api.AdminUser[]>([]);
  const [nuEmail, setNuEmail] = useState("");
  const [nuName, setNuName] = useState("");
  const [nuPass, setNuPass] = useState("");
  const [nuCredits, setNuCredits] = useState<number>(50);
  const [usersMsg, setUsersMsg] = useState("");
  const refreshUsage = () => { api.fetchUsage().then(setUsage).catch(() => {}); };
  function logout() { api.clearToken(); router.replace("/login"); }
  async function openUsers() {
    setShowUsers(true); setUsersMsg("");
    try { setAdminUsers(await api.adminListUsers()); } catch (e) { setUsersMsg(e instanceof Error ? e.message : String(e)); }
  }
  async function createMember() {
    setUsersMsg("");
    try {
      await api.adminCreateUser({ email: nuEmail.trim(), password: nuPass, full_name: nuName.trim() || undefined, credits: nuCredits });
      setNuEmail(""); setNuName(""); setNuPass("");
      setAdminUsers(await api.adminListUsers()); refreshUsage();
    } catch (e) { setUsersMsg(e instanceof Error ? e.message : String(e)); }
  }
  async function patchMember(id: number, body: Parameters<typeof api.adminUpdateUser>[1]) {
    try { await api.adminUpdateUser(id, body); setAdminUsers(await api.adminListUsers()); refreshUsage(); }
    catch (e) { setUsersMsg(e instanceof Error ? e.message : String(e)); }
  }
  async function removeMember(id: number) {
    try { await api.adminDeleteUser(id); setAdminUsers(await api.adminListUsers()); refreshUsage(); }
    catch (e) { setUsersMsg(e instanceof Error ? e.message : String(e)); }
  }
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [layers, setLayers] = useState<ProjectLayer[]>([]);
  const [clientId, setClientId] = useState<number | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);

  // ---- campi (multi-poligono) ----
  const [fields, setFields] = useState<Field[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [sameRules, setSameRules] = useState(true);
  const [gset, setGset] = useState<Settings>(DEFAULTS);
  const nextId = useRef(1);
  const pendingParentRef = useRef<number | null>(null);   // prossimo poligono disegnato → figlio di questo campo
  // Trascinamento generico nel pannello Livelli: campo O oggetto (canale/strada/invaso/pivot).
  const dragRef = useRef<{ kind: "field" | "canal" | "road" | "water" | "pivot" | "pipe"; id: number | string } | null>(null);
  // Salvataggio automatico: stato UI + riferimenti di serializzazione/serializzazione salvataggi.
  const savingRef = useRef(false);
  const pendingSaveRef = useRef<null | (() => Promise<void>)>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const lastSavedSigRef = useRef("");
  const latestSigRef = useRef("");
  const suppressAutosaveRef = useRef(false);
  const fieldToAreaRef = useRef<Map<number, number>>(new Map());   // ultimo salvataggio: id campo front-end → id area DB
  // visibilità dei livelli sulla mappa (accendi/spegni dal widget sinistro)
  const [layerVis, setLayerVis] = useState({ fields: true, macro: true, canal: true, layout: true, water: true, strade: true });
  const [watercourses, setWatercourses] = useState<WaterL[]>([]);
  const [waterSens, setWaterSens] = useState(3);       // sensibilità rilevamento (1..5)
  const [waterPreview, setWaterPreview] = useState(false);
  const [waterRemoveOn, setWaterRemoveOn] = useState(false);
  // barra strumenti in alto: annulla/ripristina, misura, menu livelli
  const [layersOpen, setLayersOpen] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [measureTxt, setMeasureTxt] = useState("");
  const [circling, setCircling] = useState(false);
  const [circleInfo, setCircleInfo] = useState<CircleInfo | null>(null);
  const [elevOn, setElevOn] = useState(false);
  const [elevData, setElevData] = useState<ElevationResult | null>(null);
  const [leftMin, setLeftMin] = useState(false);    // pannello Progetto ridotto a icona
  const [rightMin, setRightMin] = useState(false);  // pannello schede ridotto a icona
  const [propsOpen, setPropsOpen] = useState(true);   // widget Proprietà docked in basso a sinistra (toggle con «i»)
  const [canUndo, setCanUndo] = useState(false);
  const [undoN, setUndoN] = useState(0);
  const [redoN, setRedoN] = useState(0);
  const [canRedo, setCanRedo] = useState(false);
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;
  // NB: la cronologia Annulla/Ripristina è definita più sotto, dopo gli stati
  // pivot/strade che ora fanno parte dello snapshot.
  function stopCircles() { setCircling(false); setCircleInfo(null); mapApi.current?.stopCircles(); }
  function toggleMeasure() {
    if (measuring) { setMeasuring(false); setMeasureTxt(""); mapApi.current?.stopMeasure(); setMsg(""); return; }
    if (elevOn) { setElevOn(false); setElevData(null); mapApi.current?.stopElevation(); }
    if (circling) stopCircles();
    setMeasuring(true); setMsg(t("Misura: clicca i punti sulla mappa. 2 punti = distanza, 3+ = area."));
    mapApi.current?.startMeasure((txt) => setMeasureTxt(txt));
  }
  // Righello circolare: cerchi tracciati dal centro, per simulare pivot sulla mappa.
  function toggleCircles() {
    if (circling) { stopCircles(); setMsg(""); return; }
    if (measuring) { setMeasuring(false); setMeasureTxt(""); mapApi.current?.stopMeasure(); }
    if (elevOn) { setElevOn(false); setElevData(null); mapApi.current?.stopElevation(); }
    setCircling(true); setCircleInfo(null);
    setMsg(t("Cerchi: clicca il centro, poi un secondo clic fissa il raggio. Ripremi l'icona per chiudere."));
    mapApi.current?.startCircles((info) => setCircleInfo(info));
  }
  // Strumento profilo/dislivelli: polilinea le cui quote (DEM) vengono lette punto per punto.
  async function onElevPoints(coords: number[][]) {
    if (!coords.length) { setElevData(null); return; }
    try {
      const r = await api.fetchElevation(coords);
      setElevData(r);
      const labels = r.points.map((p, i) => `${i + 1}: ${p.elev_m != null ? uM(p.elev_m, 0) : "—"}`);
      mapApi.current?.setElevationLabels(labels);
    } catch (e) { showErr(e); }
  }
  function toggleElevation() {
    if (elevOn) { setElevOn(false); setElevData(null); mapApi.current?.stopElevation(); setMsg(""); return; }
    if (measuring) { setMeasuring(false); setMeasureTxt(""); mapApi.current?.stopMeasure(); }
    if (circling) stopCircles();
    setElevOn(true); setElevData(null);
    setMsg(t("Profilo: clicca i punti sulla mappa per leggere quote e dislivelli. Ripremi l'icona per chiudere."));
    mapApi.current?.startElevation(onElevPoints);
  }

  const active = useMemo(() => fields.find((f) => f.id === activeId) ?? null, [fields, activeId]);
  const activeGeom = active?.geom ?? null;
  // Somma solo i poligoni radice (i figli sono in genere sottoinsiemi: niente doppi conteggi).
  const totalHa = useMemo(() => fields.filter((f) => f.parentId == null).reduce((s, f) => s + ringAreaHa(f.geom.coordinates), 0), [fields]);
  // Impostazioni attualmente mostrate nei controlli.
  const cur: Settings = sameRules || !active ? gset : (active.settings ?? gset);
  const effSettings = (f: Field): Settings => (sameRules ? gset : (f.settings ?? gset));

  function patch(p: Partial<Settings>) {
    if (sameRules || activeId == null) { setGset((s) => ({ ...s, ...p })); return; }
    setFields((fs) => fs.map((f) => f.id === activeId ? { ...f, settings: { ...(f.settings ?? gset), ...p } } : f));
  }
  const setW = (k: keyof SuitWeights, v: number) => patch({ weights: { ...cur.weights, [k]: v } });

  // ---- viste satellitari (campo attivo) ----
  const [index, setIndex] = useState("ndvi");
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [date, setDate] = useState<string>("");
  const [normalized, setNormalized] = useState(false);
  const [scale, setScale] = useState<ColorScale | null>(null);
  const [demInfo, setDemInfo] = useState<{ min: number; max: number; scale: ColorScale } | null>(null);
  const [terrainInfo, setTerrainInfo] = useState<{ interval: number; min: number; max: number } | null>(null);
  const [isoInterval, setIsoInterval] = useState(0);   // 0 = automatico; oppure 0.5,1,2,5,10 m
  const suit = active?.suit ?? null;

  // macro-aree (M6, fase 1)
  const [macroAreas, setMacroAreas] = useState<MacroArea[]>([]);
  const [macroThr, setMacroThr] = useState(60);
  const [macroMinHa, setMacroMinHa] = useState(10);
  // canale principale (M6, fase 2) — più canali, presa/finale manuali
  const [canals, setCanals] = useState<CanalL[]>([]);
  const [canalPermille, setCanalPermille] = useState(1);
  const [canalStart, setCanalStart] = useState<number[] | null>(null);
  const [canalEnd, setCanalEnd] = useState<number[] | null>(null);
  const [pickMode, setPickMode] = useState<"start" | "end" | null>(null);
  const [editingCanal, setEditingCanal] = useState<number | null>(null);
  const [snapCanal, setSnapCanal] = useState(true);   // aggancia il tracciato a mano all'alveo (DEM)
  const [profileCanal, setProfileCanal] = useState<number | null>(null);   // canale di cui mostrare il profilo
  // pivot lungo il canale (M6, fase 3)
  const [guided, setGuided] = useState<GuidedResult | null>(null);
  const [perSide, setPerSide] = useState(2);
  const [fillEmpty, setFillEmpty] = useState(true);
  const [safetyM, setSafetyM] = useState(20);   // distanza di rispetto fra i bordi dei pivot (m)
  const [pivClearRoad, setPivClearRoad] = useState(0);   // franco pivot da strade/canali segnati (m)
  const [pivClearWater, setPivClearWater] = useState(0); // franco pivot da acqua/invasi (m)
  const [pivotR, setPivotR] = useState(400);    // raggio pivot (parametro proprio della scheda Pivot)
  const [minPivotPct, setMinPivotPct] = useState(100);   // dimensione minima pivot di riempimento bordi (% del raggio); 100 = disattivato
  const [fillFull, setFillFull] = useState(false);       // riempie i vuoti con pivot interi fuori griglia
  // fasi di realizzazione (vedi assignPhases)
  const [phaseN, setPhaseN] = useState(2);
  const [phaseOrderBy, setPhaseOrderBy] = useState<"fonte" | "ovest" | "sud">("fonte");
  const [phaseColors, setPhaseColors] = useState(true);
  const [demModel, setDemModel] = useState<"COPERNICUS_30" | "COPERNICUS_90">("COPERNICUS_30");   // modello del terreno
  const [demSmooth, setDemSmooth] = useState(100);       // base di levigatura della pendenza (m)
  const [designMode, setDesignMode] = useState<"standard" | "advanced">("standard"); // Systems: standard | avanzata (ottimizza raggio)
  const [advMinR, setAdvMinR] = useState(250);           // avanzata: raggio minimo del range (m)
  const [advMaxR, setAdvMaxR] = useState(450);           // avanzata: raggio massimo del range (m)
  const [pipeCanalIdx, setPipeCanalIdx] = useState(0);   // Accessori: canale da cui si diramano le tubazioni
  const [pipeMaxPerLine, setPipeMaxPerLine] = useState(8); // max pivot collegati sulla stessa tubazione
  // Gerarchia pivot: modello modificabile (gruppo → singolo) derivato dal risultato.
  const [pivots, setPivots] = useState<PivotItem[]>([]);
  const [pivotLines, setPivotLines] = useState<PipeLine[]>([]);
  // Parametri idraulici di progetto (il singolo pivot può avere i suoi).
  // ---- Irrigazione: il fabbisogno decide la portata di OGNI pivot ----
  const [cropKey, setCropKey] = useState("canna");   // coltura → coefficiente Kc
  // Pagina Impianti: sistema irriguo scelto. Per ora è implementato il pivot;
  // gli altri sono predisposti e restano vuoti finché non arrivano.
  const [irrigSys, setIrrigSys] = useState<"pivot" | "lineari" | "rotoloni" | "goccia">("pivot");
  const [mm24, setMm24] = useState(8);               // fabbisogno lordo (mm/24h)
  const [rainMm, setRainMm] = useState(0);           // piovosità utile (mm/24h)
  const [effPct, setEffPct] = useState(85);          // efficienza dell'impianto (%)
  // Etichette sulla mappa con superficie e portata di ogni pivot (spegnibili).
  const [pivotLabels, setPivotLabelsState] = useState<boolean>(() => {
    try { return typeof window === "undefined" ? true : window.localStorage.getItem("argus.pivotLabels") !== "0"; } catch { return true; }
  });
  const setPivotLabels = (v: boolean) => { setPivotLabelsState(v); try { window.localStorage.setItem("argus.pivotLabels", v ? "1" : "0"); } catch { /* */ } };
  // ---- Alimentazione dei pivot: rete/generatore oppure fotovoltaico ----
  const [powerMode, setPowerMode] = useState<"grid" | "solar">("grid");
  const [solarOpen, setSolarOpen] = useState(false);              // parametri del calcolo FV
  const [pvPsh, setPvPsh] = useState<number | null>(null);        // kWh/m²/g; null = dal sito (NASA POWER)
  const [pvSunH, setPvSunH] = useState(8);                        // ore di pompaggio col sole (senza batterie)
  const [pvHead, setPvHead] = useState(15);                       // sollevamento + perdite in rete (m)
  const [pvEta, setPvEta] = useState(60);                         // rendimento pompa·motore·inverter (%)
  const [pvPR, setPvPR] = useState(75);                           // performance ratio del campo FV (%)
  const [pvWm2, setPvWm2] = useState(210);                        // potenza dei moduli (Wp/m²)
  const [pvGcr, setPvGcr] = useState(45);                         // copertura del suolo (%)
  const [pvDod, setPvDod] = useState(80);                         // profondità di scarica batterie (%)
  const [pvBattEff, setPvBattEff] = useState(90);                 // rendimento di ciclo batterie (%)
  // ---- Produttore dei pivot (per progetto, nel browser) ----
  // Salvato sul server con il progetto (impostazioni di progetto), vedi più sotto.
  const [pivotBrand, setPivotBrand] = useState<PivotBrand>("starpivot");
  const [spanVmax, setSpanVmax] = useState(3);           // velocità massima nei tubi delle campate (m/s)
  // ---- Fonte d'acqua e schema d'impianto ----
  type SrcType = "fiume" | "canale" | "pozzo" | "invaso";
  const [srcPt, setSrcPt] = useState<number[] | null>(null);          // [lng, lat] del punto di presa
  const [srcType, setSrcType] = useState<SrcType>("fiume");
  const [srcQmax, setSrcQmax] = useState(0);                         // portata disponibile (l/s); 0 = non limitata
  const [srcHours, setSrcHours] = useState(24);                      // ore di prelievo consentite al giorno
  const [srcRange, setSrcRange] = useState(4);                       // escursione di livello (m) o livello dinamico del pozzo
  const [srcSediment, setSrcSediment] = useState(true);              // acqua con sedimenti
  const [srcEnergy, setSrcEnergy] = useState<"rete" | "fv-gen" | "fv-batt">("rete");
  type SrcElev = { zS: number | null; zR: number | null; zPmax: number | null; zPiv: (number | null)[];
    prof: { d: number[]; z: (number | null)[] }; key: string };
  const [srcElev, setSrcElev] = useState<SrcElev | null>(null);
  const [srcRoute, setSrcRoute] = useState<number[][] | null>(null);   // tracciato disegnato presa → vasca ([lng, lat])
  const [srcMonthly, setSrcMonthly] = useState<number[] | null>(null); // livello minimo mese per mese (m sotto il punto di presa)
  const [srcSectors, setSrcSectors] = useState(0);                   // settori di rilancio (0 = automatico)
  const [bankSlope, setBankSlope] = useState(2);                     // pendenza della sponda (orizzontale : verticale)
  const [settleMm, setSettleMm] = useState(0.1);                     // particella da sedimentare (mm)
  const [filterCap, setFilterCap] = useState(400);                   // portata di un filtro autopulente (m³/h)
  const [wellQ, setWellQ] = useState(30);                            // portata di un pozzo (l/s)
  const [srcPicking, setSrcPicking] = useState(false);
  const [srcShown, setSrcShown] = useState<string | null>(null);     // schema disegnato sulla mappa
  const [srcOpen, setSrcOpen] = useState(false);                     // parametri aperti
  const [srcDrawing, setSrcDrawing] = useState(false);               // tracciato in disegno
  const [computoOpen, setComputoOpen] = useState(false);
  const [resDepth, setResDepth] = useState(4);                       // profondità utile della vasca (m)
  const [resDays, setResDays] = useState(3);                         // giorni di scorta nella vasca
  const [resEvapK, setResEvapK] = useState(1.1);                     // evaporazione da specchio libero = k × ET₀
  const [wtwEta, setWtwEta] = useState(75);                          // rendimento complessivo pompa+motore (%)
  const [canalSlope, setCanalSlope] = useState(0.3);                 // pendenza del canale a gravità (‰)
  // ---- Stazione di pompaggio: parametri del confronto CAPEX/OPEX ----
  const [psLift, setPsLift] = useState(5);           // sollevamento dalla fonte (canale/pozzo) alla presa (m)
  const [psHeadExtra, setPsHeadExtra] = useState(10); // margine/perdite in rete se i diametri non sono calcolati (m)
  const [psSpares, setPsSpares] = useState(1);       // pompe di scorta
  const [psKcAvg, setPsKcAvg] = useState(85);        // Kc medio stagionale / Kc di punta (%)
  const [psRainEff, setPsRainEff] = useState(75);    // quota di pioggia efficace (%)
  const [psDaysFallback, setPsDaysFallback] = useState(180); // giorni di irrigazione/anno senza clima del sito
  const [psTolPct, setPsTolPct] = useState(3);       // tolleranza sul consumo di energia rispetto al minimo (%)
  const [psOpen, setPsOpen] = useState(false);       // parametri economici aperti
  const [hoursDay, setHoursDay] = useState(20);      // ore di esercizio al giorno
  const [wetW, setWetW] = useState(20);              // larghezza bagnata degli irrigatori (m)
  const [pattern, setPattern] = useState("ellittica");  // forma del profilo di bagnatura
  const [surfStore, setSurfStore] = useState(2);     // invaso superficiale del terreno (mm)
  const [turnsDay, setTurnsDay] = useState(1);       // giri del pivot al giorno
  const [sprinkBar, setSprinkBar] = useState(1.4);   // pressione richiesta agli irrigatori
  const [latDN, setLatDN] = useState(168);           // diametro della condotta del pivot (mm)
  const [pivotPointBar, setPivotPointBar] = useState(0.3);   // perdite al punto pivot (gomiti, valvola, giunto)
  const [pivP, setPivP] = useState(2.5);     // pressione richiesta al pivot (bar) — solo come ripiego
  const [vMax, setVMax] = useState(1.8);     // velocità massima in tubazione (m/s)
  const [hwC, setHwC] = useState(140);       // coefficiente di Hazen-Williams (PE/PVC ≈ 140)
  const [dragOverField, setDragOverField] = useState<number | "root" | null>(null);   // evidenzia il bersaglio del trascinamento
  const [hiddenPivotFields, setHiddenPivotFields] = useState<Set<number>>(new Set()); // gruppi pivot (per campo) nascosti
  const [hiddenPipeFields, setHiddenPipeFields] = useState<Set<number>>(new Set());   // gruppi tubazioni (per campo) nascosti
  const editPipeRef = useRef<number | null>(null);   // indice della tubazione in modifica
  // Selezione delle tubazioni a due tempi, come per i pivot: primo clic = gruppo,
  // secondo clic = la singola tubazione, che entra in modifica con i suoi vertici.
  const [pipeSel, setPipeSel] = useState<{ mode: "none" | "group" | "single"; idx: number }>({ mode: "none", idx: -1 });
  // gruppi di strade aperti (albero Livelli e pannello Strade): chiusi di default
  const [openRoadGroups, setOpenRoadGroups] = useState<Set<string>>(new Set());
  const toggleRoadGroup = (k: string) => setOpenRoadGroups((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const [openFolders, setOpenFolders] = useState({ campi: true, canali: true, strade: true, invasi: true, pivot: true }); // cartelle del pannello Livelli
  const [pivotSel, setPivotSel] = useState<PivotSel>({ mode: "none", idx: -1 });
  // Livello Strade (linee, con spessore) disegnabile/importabile: i pivot le rispettano.
  const [roads, setRoads] = useState<RoadL[]>([]);
  const [roadWidth, setRoadWidth] = useState(8);      // spessore strada di default (m)
  const [canalWidth, setCanalWidth] = useState(6);    // spessore canale/fiume di default (m)

  // ---- Cronologia Annulla/Ripristina UNIFICATA ----
  // Uno snapshot copre TUTTE le mosse (campi, pivot spostati/ridimensionati/
  // eliminati, strade) così «Annulla» torna indietro su ognuna, una alla volta.
  const hist = useRef<{ past: Snapshot[]; fut: Snapshot[] }>({ past: [], fut: [] });
  const prevSnap = useRef<Snapshot | null>(null);
  const applyingHist = useRef(false);
  const histMounted = useRef(false);
  useEffect(() => {
    const curr: Snapshot = { f: fields, a: activeIdRef.current, pv: pivots, pl: pivotLines, rd: roads, g: guided };
    if (!histMounted.current) { histMounted.current = true; prevSnap.current = curr; return; }
    if (applyingHist.current) { applyingHist.current = false; prevSnap.current = curr; return; }
    if (prevSnap.current) hist.current.past.push(prevSnap.current);
    if (hist.current.past.length > 80) hist.current.past.shift();
    hist.current.fut = [];
    prevSnap.current = curr;
    setCanUndo(true); setCanRedo(false);
    setUndoN(hist.current.past.length); setRedoN(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, pivots, pivotLines, roads, guided]);
  function applySnap(s: Snapshot) {
    applyingHist.current = true; prevSnap.current = s;
    setActiveId(s.a); setFields(s.f); renderFields(s.f, s.a);
    setPivots(s.pv); setPivotLines(s.pl); setGuided(s.g); setRoads(s.rd);
    setPivotSel({ mode: "none", idx: -1 });
  }
  function undo() {
    const h = hist.current; if (!h.past.length || !prevSnap.current) return;
    h.fut.push(prevSnap.current);
    applySnap(h.past.pop()!);
    setCanUndo(h.past.length > 0); setCanRedo(true);
    setUndoN(h.past.length); setRedoN(h.fut.length);
  }
  function redo() {
    const h = hist.current; if (!h.fut.length || !prevSnap.current) return;
    h.past.push(prevSnap.current);
    applySnap(h.fut.pop()!);
    setCanUndo(true); setCanRedo(h.fut.length > 0);
    setUndoN(h.past.length); setRedoN(h.fut.length);
  }

  const [excludeWater, setExcludeWater] = useState(true);  // niente pivot su acqua/paludi (NDWI)
  const [soilKey, setSoilKey] = useState("franco");
  // Infiltrazione di base del suolo (mm/h). Un solo valore per tutta l'app:
  // «infiltrazione» negli impianti e «assorbimento» in irrigazione sono la
  // stessa grandezza, tenerli separati li faceva divergere.
  const [infiltration, setInfiltration] = useState(SOILS[2].inf);
  const infTouched = useRef(false);      // true se l'utente lo ha corretto a mano
  const [et0Peak, setEt0Peak] = useState(7);               // mm/g
  // raggio consigliato: intensità di pioggia di punta al bordo ≤ infiltrazione del suolo.
  // I_picco = 2π·R·Dg /(H·w) ≤ infiltrazione → R ≤ infiltrazione·H·w /(2π·Dg).
  const recRadius = useMemo(() => {
    const dg = et0Peak * cur.kc / (cur.eff || 1);          // fabbisogno lordo (mm/g)
    if (dg <= 0) return cur.radius;
    const rr = infiltration * cur.hours * PIVOT_WET_W / (2 * Math.PI * dg);
    return Math.max(50, Math.min(800, Math.round(rr / 10) * 10));
  }, [et0Peak, infiltration, cur.kc, cur.eff, cur.hours, cur.radius]);

  const [tab, setTab] = useState("analisi");
  // Menu verticale: clic su una voce apre la sua finestra; ri-clic sulla voce
  // attiva la chiude (mappa libera). Usato anche dai salti automatici di pagina.
  function goTab(k: string) { setTab(k); setRightMin(false); }
  function toggleTab(k: string) {
    if (tab === k && !rightMin) { setRightMin(true); return; }
    goTab(k);
  }

  const [notes, setNotes] = useState("");
  const [shares, setShares] = useState<api.ShareView[]>([]);   // link di sola lettura del progetto
  // Commenti lasciati dai clienti sui link di sola lettura
  const [comments, setComments] = useState<api.ShareComment[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const notifiedCommentIds = useRef<Set<number>>(new Set());
  async function refreshComments(pid: number, notify = true) {
    try {
      const cs = await api.listProjectComments(pid);
      setComments(cs);
      const fresh = cs.filter((c) => !c.seen && !notifiedCommentIds.current.has(c.id));
      fresh.forEach((c) => notifiedCommentIds.current.add(c.id));
      if (notify && fresh.length) setMsg(t("Nuovi commenti dei clienti: {n} (pagina Esporta)", { n: fresh.length }));
    } catch { /* silenzioso: è un'aggiunta, non deve bloccare il progetto */ }
  }
  const [shareName, setShareName] = useState("");              // nome del prossimo link da creare
  // Stampa: cosa includere nel PDF e in che lingua (indipendente dall'interfaccia).
  const [pdfSheet, setPdfSheet] = useState(true);
  const [pdfPlan, setPdfPlan] = useState(true);
  const [pdfLang, setPdfLang] = useState<Lang>("it");
  const [pdfFormat, setPdfFormat] = useState<"a3" | "a4">("a3");   // formato della tavola
  const [revs, setRevs] = useState<api.ExportRevision[]>([]);      // storico delle revisioni
  // Si memorizzano i campi ESCLUSI, non quelli scelti: un poligono aggiunto
  // dopo entra automaticamente nell'esportazione invece di restare fuori.
  const [pdfSkip, setPdfSkip] = useState<Set<number>>(new Set());
  const [autosave, setAutosave] = useState<"" | "saving" | "saved" | "error">("");   // stato salvataggio automatico
  const [drawing, setDrawing] = useState(false);   // disegno/tracciatura in corso → pannellino di controllo
  const [elevStats, setElevStats] = useState<{ id: number; loading?: boolean; err?: boolean; s?: api.ElevationStats } | null>(null);  // quota del campo attivo
  const [elevNonce, setElevNonce] = useState(0);   // forza il ricalcolo quota quando la geometria del campo cambia
  const elevCache = useRef<Map<number, api.ElevationStats>>(new Map());
  const [busy, setBusy] = useState<string>("");
  const [msg, setMsg] = useState<string>("");

  // ---- Header: livelli mappa, avvisi, vista iniziale ----
  const [mapMenuOpen, setMapMenuOpen] = useState(false);
  const [basemap, setBasemap] = useState<"sat" | "street" | "topo">("sat");
  const [mapLabels, setMapLabels] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  // Gli avvisi sono i messaggi dell'app (esiti, errori, elaborazioni concluse):
  // restano consultabili invece di sparire con il messaggio successivo.
  const [alerts, setAlerts] = useState<{ id: number; text: string; at: number }[]>([]);
  const [alertsSeen, setAlertsSeen] = useState(0);
  const alertId = useRef(1);
  const lastAlert = useRef("");
  useEffect(() => {
    const txt = (msg || "").trim();
    if (!txt || txt === lastAlert.current) return;
    lastAlert.current = txt;
    setAlerts((n) => [{ id: alertId.current++, text: txt, at: Date.now() }, ...n].slice(0, 40));
  }, [msg]);
  const unseen = Math.max(0, alerts.length - alertsSeen);
  useEffect(() => { mapApi.current?.setBasemap(basemap); }, [basemap]);
  useEffect(() => { mapApi.current?.setMapLabels(mapLabels); }, [mapLabels]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (pipeSel.mode === "single") { e.preventDefault(); deleteSelectedPipe(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeSel, pivotLines, hiddenPipeFields, pivots]);
  // Esc chiude il righello o il righello circolare, come ripremere l'icona.
  useEffect(() => {
    if (!measuring && !circling) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (measuring) toggleMeasure();
      else if (circling) toggleCircles();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measuring, circling]);

  function goHome() { setMapMenuOpen(false); setBellOpen(false); mapApi.current?.fitAll(); }

  const fileRef = useRef<HTMLInputElement | null>(null);
  const roadFileRef = useRef<HTMLInputElement | null>(null);

  // ---- caricamenti iniziali ----
  useEffect(() => { mapApi.current?.setUnits(imperial); }, [imperial]);
  useEffect(() => { api.getHealth().then((h) => setProviderMode(h.provider_mode)).catch(() => {}); }, []);
  // Guardia di autenticazione: senza token → login; altrimenti carica profilo e
  // crediti. L'uso viene aggiornato periodicamente (riflette i consumi).
  useEffect(() => {
    if (!api.getToken()) { router.replace("/login"); return; }
    api.authMe().then(setMe).catch(() => {});   // 401 → redirect gestito in api.req
    refreshUsage();
    const iv = setInterval(refreshUsage, 15000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (api.getToken()) refreshClients(); }, []);
  useEffect(() => { refreshProjects(clientId); setProjectId(null); }, [clientId]);
  useEffect(() => {
    if (projectId) { openProject(projectId); refreshShares(projectId); notifiedCommentIds.current = new Set(); refreshComments(projectId); }
    else { setAreas([]); setLayers([]); setShares([]); }
  }, [projectId]);

  // Nuovi commenti: ricontrolla ogni 2 minuti mentre il progetto è aperto.
  useEffect(() => {
    if (!projectId) { setComments([]); return; }
    const iv = setInterval(() => refreshComments(projectId), 120000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  // Segnaposto dei commenti sulla mappa quando è aperta la pagina Esporta.
  useEffect(() => {
    const shown = tab === "export" && !rightMin
      ? comments.filter((c) => c.lat != null && c.lng != null && (showResolved || !c.resolved)) : [];
    const order = [...comments].reverse();
    mapApi.current?.setCommentPins?.(shown.map((c) => ({ lat: c.lat as number, lng: c.lng as number,
      n: order.indexOf(c) + 1, text: `${c.author ? c.author + ": " : ""}${c.body}`, done: c.resolved })));
  }, [comments, tab, rightMin, showResolved]);
  async function patchComment(id: number, patch: { seen?: boolean; resolved?: boolean }) {
    try { const c = await api.updateComment(id, patch); setComments((cs) => cs.map((x) => (x.id === id ? c : x))); } catch (e) { showErr(e); }
  }
  async function removeComment(id: number) {
    try { await api.deleteComment(id); setComments((cs) => cs.filter((x) => x.id !== id)); } catch (e) { showErr(e); }
  }
  async function markAllCommentsSeen() {
    if (!projectId) return;
    try { await api.markCommentsSeen(projectId); setComments((cs) => cs.map((x) => ({ ...x, seen: true }))); } catch (e) { showErr(e); }
  }
  async function refreshClients() { try { setClients(await api.listClients()); } catch (e) { showErr(e); } }
  async function refreshProjects(cid: number | null) { try { setProjects(await api.listProjects(cid)); } catch (e) { showErr(e); } }
  async function refreshAreas(pid: number) { try { setAreas(await api.listAreas(pid)); } catch (e) { showErr(e); } }
  async function refreshLayers(pid: number) { try { setLayers(await api.listLayers(pid)); } catch (e) { showErr(e); } }
  // Apertura progetto → LISTA UNICA: le aree salvate diventano subito «Campi»
  // sulla mappa; gli eventuali livelli salvati (canali/pivot) vengono ripristinati.
  async function openProject(pid: number) {
    suppressAutosaveRef.current = true;   // non salvare durante il caricamento (evita di sovrascrivere il progetto)
    clearAllFields();
    setCanals([]); setRoads([]); setWatercourses([]); setGuided(null); setPivots([]); setPivotLines([]); setHiddenPivotFields(new Set()); setHiddenPipeFields(new Set());
    try {
      const [areasList, layersList] = await Promise.all([api.listAreas(pid), api.listLayers(pid)]);
      setAreas(areasList); setLayers(layersList);
      // Ricostruisci l'albero: aree radice → campi; figlie «field-child» → poligoni
      // figli (famiglia, ricorsivo); figlie «macro» → sotto-aree del campo.
      const childrenOfArea = (aid: number) => areasList.filter((a) => a.parent_area_id === aid);
      const nf: Field[] = [];
      const areaToField = new Map<number, number>();   // id area DB → id campo front-end
      const build = (a: typeof areasList[number], parentFieldId?: number) => {
        const fid = nextId.current++;
        areaToField.set(a.id, fid);
        const macros = childrenOfArea(a.id).filter((c) => c.kind === "macro")
          .map((c) => ({ id: nextId.current++, name: c.name, geom: c.geojson, area_ha: c.area_ha ?? 0, mean_score: 0, savedId: c.id } as FieldMacro));
        nf.push({ id: fid, name: a.name, geom: a.geojson, savedId: a.id, parentId: parentFieldId, macros: macros.length ? macros : undefined });
        for (const c of childrenOfArea(a.id)) if (c.kind !== "macro") build(c, fid);
      };
      areasList.filter((a) => a.parent_area_id == null).forEach((a) => build(a));
      // Applica stili, livello (area/campo) e idoneità salvati prima di disegnare.
      // I campi senza livello memorizzato valgono «area» (progetti già esistenti).
      const styleLayer = layersList.filter((l) => l.kind === "styles").map((l) => l.data).pop();
      for (const f of nf) {
        if (f.savedId != null && styleLayer?.byArea?.[f.savedId]) f.style = styleLayer.byArea[f.savedId];
        f.level = (f.savedId != null && styleLayer?.levels?.[f.savedId]) || "area";
        if (f.savedId != null && styleLayer?.scores?.[f.savedId] != null) f.score = styleLayer.scores[f.savedId];
        if (f.savedId != null && styleLayer?.hiddenFields?.[f.savedId]) f.hidden = true;
      }
      // Ripristina i gruppi pivot nascosti (per id area → id campo front-end).
      if (styleLayer?.hiddenPivots) {
        const hp = new Set<number>();
        for (const aidStr of Object.keys(styleLayer.hiddenPivots)) { const fid = areaToField.get(Number(aidStr)); if (fid != null) hp.add(fid); }
        if (hp.size) setHiddenPivotFields(hp);
      }
      // Ripristina i gruppi tubazioni nascosti (progetti precedenti: nessuna
      // chiave salvata → tutte visibili, com'era prima).
      if (styleLayer?.hiddenPipes) {
        const hq = new Set<number>();
        for (const aidStr of Object.keys(styleLayer.hiddenPipes)) { const fid = areaToField.get(Number(aidStr)); if (fid != null) hq.add(fid); }
        if (hq.size) setHiddenPipeFields(hq);
      }
      if (nf.length) {
        const firstRoot = nf.find((f) => f.parentId == null) ?? nf[0];
        setFields(nf);
        setActiveId(firstRoot.id);
        renderFields(nf, firstRoot.id);
        setTimeout(() => mapApi.current?.fitAll(), 40);
      }
      const mapOwner = (areaId?: number | null) => (areaId != null && areaToField.has(areaId) ? areaToField.get(areaId) : undefined);

      // Canali: bulk «canals» (con owner) + eventuali legacy «canal» singoli.
      const canalItems: CanalL[] = [];
      for (const l of layersList.filter((x) => x.kind === "canals")) for (const it of (l.data?.items ?? [])) canalItems.push({ ...it, owner: mapOwner(it.ownerArea) } as CanalL);
      for (const l of layersList.filter((x) => x.kind === "canal")) canalItems.push(l.data as unknown as CanalL);
      if (canalItems.length) { setCanals(canalItems); renderCanals(canalItems); }

      const roadItems: RoadL[] = [];
      for (const l of layersList.filter((x) => x.kind === "roads")) for (const it of (l.data?.items ?? [])) roadItems.push({ ...it, owner: mapOwner(it.ownerArea) } as RoadL);
      if (roadItems.length) setRoads(roadItems);

      const waterItems: WaterL[] = [];
      for (const l of layersList.filter((x) => x.kind === "waters")) for (const it of (l.data?.items ?? [])) waterItems.push({ ...it, owner: mapOwner(it.ownerArea) } as WaterL);
      if (waterItems.length) { setWatercourses(waterItems); renderWater(waterItems); }

      const pv = layersList.filter((l) => l.kind === "pivots").map((l) => l.data as unknown as GuidedResult).pop();
      if (pv) {
        const { pivots: pp, lines: pl } = pivotsFromFC(pv.geojson, Number(pv.meta?.radius_m) || pivotR);
        const rp = pp.map((p) => ({ ...p, field: mapOwner(p.field) }));
        const rl = pl.map((l) => ({ ...l, field: mapOwner(l.field) }));
        setPivots(rp); setPivotLines(rl); setPivotSel({ mode: "none", idx: -1 });
        setGuided({ geojson: fcFromModel(rp, rl), meta: pv.meta });
      }
      // Caricamento COMPLETO: riallinea la firma e riattiva l'autosave (dopo il
      // flush di render).
      setTimeout(() => { lastSavedSigRef.current = latestSigRef.current; suppressAutosaveRef.current = false; setAutosave("saved"); }, 600);
    } catch (e) {
      // Caricamento FALLITO: lascia l'autosave inibito, così uno stato parziale
      // non sovrascrive (cancella) il progetto salvato.
      showErr(e); setAutosave("error");
    }
  }
  function showErr(e: unknown) { setMsg(translateError(t, e instanceof Error ? e.message : String(e))); refreshUsage(); }

  // ---- clienti / progetti ----
  async function newClient() {
    const name = prompt(t("Nome cliente")); if (!name) return;
    try { const c = await api.createClient(name); await refreshClients(); setClientId(c.id); }
    catch (e) { showErr(e); }
  }
  async function newProject() {
    const name = prompt(t("Nome progetto")); if (!name) return;
    const crop = prompt(t("Coltura (opzionale)")) || undefined;
    try {
      const p = await api.createProject({ name, client_id: clientId, crop });
      await refreshProjects(clientId); setProjectId(p.id);
    } catch (e) { showErr(e); }
  }

  // Svuota la mappa dopo l'eliminazione del progetto aperto, con l'autosave
  // fermo: non deve riscrivere su un progetto che non esiste più.
  function resetProjectView() {
    suppressAutosaveRef.current = true;
    clearAllFields();
    setCanals([]); setRoads([]); setWatercourses([]); setGuided(null); setPivots([]); setPivotLines([]); setHiddenPivotFields(new Set()); setHiddenPipeFields(new Set());
  }
  async function deleteCurrentClient() {
    const c = clients.find((x) => x.id === clientId); if (!c) return;
    if (!confirm(t("Eliminare il cliente «{name}» e tutti i suoi progetti ({n})? L'operazione non si può annullare.", { name: c.name, n: projects.length }))) return;
    try {
      await api.deleteClient(c.id);
      if (projectId) resetProjectView();
      setClientId(null); await refreshClients();
      setMsg(t("Cliente «{name}» eliminato.", { name: c.name }));
    } catch (e) { showErr(e); }
  }
  async function deleteCurrentProject() {
    const p = projects.find((x) => x.id === projectId); if (!p) return;
    if (!confirm(t("Eliminare il progetto «{name}» e tutti i suoi dati (campi, impianti, revisioni)? L'operazione non si può annullare.", { name: p.name }))) return;
    try {
      await api.deleteProject(p.id);
      resetProjectView();
      setProjectId(null); await refreshProjects(clientId);
      setMsg(t("Progetto «{name}» eliminato.", { name: p.name }));
    } catch (e) { showErr(e); }
  }

  // ---- gestione campi ----
  function clearViewOverlays() {
    mapApi.current?.clearOverlay("index"); mapApi.current?.clearOverlay("dem");
    mapApi.current?.clearOverlay("suitability");
    setScale(null); setDemInfo(null);
  }
  function renderFields(fs: Field[], aId: number | null) {
    const hidden = fs.filter((f) => f.hidden).map((f) => f.id);
    mapApi.current?.setFields(fs.map((f) => ({ id: f.id, name: f.name, geom: f.geom, style: f.style, level: f.level ?? "area" })), aId, hidden);
  }
  // Aggiorna lo stile (colore perimetro/riempimento, trasparenza) del campo attivo.
  function patchFieldStyle(patch: { color?: string; fillColor?: string; fillOpacity?: number }) {
    if (activeId == null) return;
    setFields((fs) => { const arr = fs.map((f) => f.id === activeId ? { ...f, style: { ...f.style, ...patch } } : f); renderFields(arr, activeId); return arr; });
  }
  function resetFieldStyle() {
    if (activeId == null) return;
    setFields((fs) => { const arr = fs.map((f) => f.id === activeId ? { ...f, style: undefined } : f); renderFields(arr, activeId); return arr; });
  }
  function setFieldLevel(level: "area" | "campo") {
    if (activeId == null) return;
    setFields((fs) => { const arr = fs.map((f) => f.id === activeId ? { ...f, level } : f); renderFields(arr, activeId); return arr; });
  }
  // Ridisegna sulla mappa tutte le macro-aree: candidate (da individuazione) +
  // sotto-aree già assegnate ai campi.
  function renderMacrosOnMap(fs: Field[], cands: MacroArea[]) {
    const committed = fs.flatMap((f) => (f.macros ?? []).map((mm) => ({ geom: mm.geom, label: mm.name })));
    const candItems = cands.map((m) => ({ geom: m.geojson, label: `${fmt(m.area_ha, { maximumFractionDigits: 0 })} ha` }));
    mapApi.current?.showMacroareas([...committed, ...candItems]);
  }
  // Rendering centralizzato con visibilità per-oggetto (pannello Livelli).
  function renderCanals(list: CanalL[] = canals) {
    mapApi.current?.showCanals(list.filter((c) => !c.hidden).map((c) => ({ coords: c.geojson.coordinates, start: c.start, end: c.end, width_m: canalWidth })), t("Presa"), t("Sbocco"));
  }
  function renderWater(list: WaterL[] = watercourses) {
    mapApi.current?.showWater(list.filter((w) => !w.hidden).map((w) => ({ geom: w.geojson, kind: w.kind })));
  }
  // Zoom su un oggetto a partire dai suoi vertici (lon,lat).
  function zoomToCoords(coords: number[][]) {
    if (!coords?.length) return;
    let mnx = 180, mny = 90, mxx = -180, mxy = -90;
    for (const p of coords) { if (p[0] < mnx) mnx = p[0]; if (p[1] < mny) mny = p[1]; if (p[0] > mxx) mxx = p[0]; if (p[1] > mxy) mxy = p[1]; }
    mapApi.current?.flyTo((mny + mxy) / 2, (mnx + mxx) / 2, 13);
  }
  // ---- Visibilità/eliminazione per-oggetto (pannello Livelli) ----
  function toggleCanalHidden(i: number) { setCanals((cs) => { const arr = cs.map((c, k) => k === i ? { ...c, hidden: !c.hidden } : c); renderCanals(arr); return arr; }); }
  function toggleWaterHidden(i: number) { setWatercourses((ws) => { const arr = ws.map((w, k) => k === i ? { ...w, hidden: !w.hidden } : w); renderWater(arr); return arr; }); }
  function removeWater(i: number) { setWatercourses((ws) => { const arr = ws.filter((_, k) => k !== i); renderWater(arr); return arr; }); }
  // Operazioni su un GRUPPO di strade (per id): visibilità, larghezza, rimozione.
  function setRoadsHiddenByIds(ids: Set<string>, h: boolean) { setRoads((rs) => rs.map((r) => (ids.has(r.id) ? { ...r, hidden: h } : r))); }
  function setRoadsWidthByIds(ids: Set<string>, w: number) { setRoads((rs) => rs.map((r) => (ids.has(r.id) ? { ...r, width_m: w } : r))); }
  function removeRoadsByIds(ids: Set<string>) { setRoads((rs) => rs.filter((r) => !ids.has(r.id))); }
  function toggleRoadHidden(i: number) { setRoads((rs) => rs.map((r, k) => k === i ? { ...r, hidden: !r.hidden } : r)); }
  function togglePivotFieldHidden(fid: number) { setHiddenPivotFields((s) => { const n = new Set(s); if (n.has(fid)) n.delete(fid); else n.add(fid); return n; }); }
  // ---- Tubazioni (oggetti): visibilità, rimozione e riassegnazione per campo ----
  function togglePipeFieldHidden(fid: number) { setHiddenPipeFields((s) => { const n = new Set(s); if (n.has(fid)) n.delete(fid); else n.add(fid); return n; }); }
  function removePipesOfField(fid: number) {
    const ml = pivotLines.filter((l) => !(l.kind === "pipe" && (l.field ?? -1) === fid));
    setPivotLines(ml);
    if (guided) setGuided({ ...guided, geojson: fcFromModel(pivots, ml) });
  }
  function zoomToPipesOfField(fid: number) {
    const first = pivotLines.find((l) => l.kind === "pipe" && (l.field ?? -1) === fid);
    if (first?.coords?.length) zoomToCoords(first.coords);
  }
  // Zone escluse per pendenza (tratteggio rosso) dei campi visibili con layout.
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fcs = fields.filter((f) => !f.hidden && f.layGeo).map((f) => ({ type: "FeatureCollection" as const,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      features: ((f.layGeo as any).features || []).filter((ft: any) => ft?.properties?.kind === "excluded") }))
      .filter((fc) => fc.features.length);
    mapApi.current?.setExcluded(fcs as GeoJSONFC[]);
  }, [fields]);
  function removePivotsOfField(fid: number) {
    const mp = pivots.filter((p) => p.field !== fid);
    const ml = pivotLines.filter((l) => l.field !== fid);
    setPivots(mp); setPivotLines(ml); setPivotSel({ mode: "none", idx: -1 });
    setGuided(mp.length ? { geojson: fcFromModel(mp, ml), meta: { n_pivots: mp.length, radius_m: pivotR, net_ha: Math.round(mp.reduce((s, x) => s + pvAreaM2(x) / 10000, 0) * 10) / 10, safety_m: safetyM } } : null);
    setFields((fs) => fs.map((f) => f.id === fid ? { ...f, lay: null, layGeo: null } : f));
  }
  // Mostra/Nascondi un intero tipo di livello (occhio sulla cartella).
  function setAllCanalsHidden(h: boolean) { setCanals((cs) => { const arr = cs.map((c) => ({ ...c, hidden: h })); renderCanals(arr); return arr; }); }
  function setAllWaterHidden(h: boolean) { setWatercourses((ws) => { const arr = ws.map((w) => ({ ...w, hidden: h })); renderWater(arr); return arr; }); }
  function setAllRoadsHidden(h: boolean) { setRoads((rs) => rs.map((r) => ({ ...r, hidden: h }))); }
  function setAllFieldsHidden(h: boolean) { setFields((fs) => { const arr = fs.map((f) => ({ ...f, hidden: h })); renderFields(arr, activeId); return arr; }); }
  function setAllPivotsHidden(h: boolean) { const ids = new Set<number>(); if (h) pivots.forEach((p) => { if (p.field != null) ids.add(p.field); }); setHiddenPivotFields(ids); }
  // Visibilità: campo singolo (occhio) e livelli interi.
  function toggleFieldHidden(id: number) {
    setFields((fs) => {
      const arr = fs.map((f) => f.id === id ? { ...f, hidden: !f.hidden } : f);
      renderFields(arr, activeId);
      return arr;
    });
  }
  function toggleLayer(key: "fields" | "macro" | "canal" | "layout" | "water" | "strade") {
    setLayerVis((v) => {
      const nv = { ...v, [key]: !v[key] };
      mapApi.current?.setLayerVisible(key, nv[key]);
      return nv;
    });
  }
  async function exportKmz(filename: string, items: { name: string; geom: ExportGeom }[]) {
    if (!items.length) return;
    const zip = new JSZip();
    zip.file("doc.kml", kmlForGeoms(items));
    const blob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.google-earth.kmz" });
    saveBlob(blob, filename.toLowerCase().endsWith(".kmz") ? filename : `${filename}.kmz`);
  }
  function draw() { setMsg(""); pendingParentRef.current = null; mapApi.current?.draw(); }
  function addField(geom: Polygon, name?: string, focus = true, savedId?: number, parentId?: number, level: "area" | "campo" = "area") {
    const id = nextId.current++;
    const def = level === "campo" ? `${t("Campo")} ${id}` : `${t("Area")} ${id}`;
    const f: Field = { id, name: name || def, geom, savedId, parentId, level };
    setFields((prev) => {
      const arr = [...prev, f];
      const aId = focus ? id : activeId;
      renderFields(arr, aId);
      if (focus) setActiveId(id);
      return arr;
    });
  }
  function addDrawnField(geom: Polygon) {
    setMsg("");
    const pid = pendingParentRef.current; pendingParentRef.current = null;
    // Un poligono figlio eredita un nome derivato dal genitore.
    const parent = pid != null ? fields.find((f) => f.id === pid) : null;
    const childName = parent ? `${parent.name} · ${((fields.filter((f) => f.parentId === pid).length) + 1)}` : undefined;
    addField(geom, childName, true, undefined, pid ?? undefined);
    setTimeout(() => mapApi.current?.fitAll(), 30);
  }
  // Disegna un poligono figlio sotto il campo indicato (crea una «famiglia»).
  function addChild(parentId: number) {
    pendingParentRef.current = parentId;
    setMsg(t("Disegna il poligono figlio sulla mappa…"));
    mapApi.current?.draw();
  }
  // Trascinamento: sposta un poligono sotto un altro (o a livello principale se
  // newParentId è null). Guardia anti-ciclo: non si può annidare un campo dentro
  // un proprio discendente.
  function reparent(childId: number | null, newParentId: number | null) {
    if (childId == null || childId === newParentId) return;
    if (newParentId != null) {
      let p: number | null = newParentId; const guard = new Set<number>();
      while (p != null && !guard.has(p)) { if (p === childId) return; guard.add(p); p = fields.find((x) => x.id === p)?.parentId ?? null; }
    }
    setFields((fs) => {
      const arr = fs.map((x) => x.id === childId ? { ...x, parentId: newParentId ?? undefined } : x);
      renderFields(arr, activeId);
      return arr;
    });
  }
  // Assegna l'oggetto trascinato a un campo (fid) o lo scollega (fid=null).
  // Per i pivot «appartenere» = essere etichettati con quel campo.
  function assignToField(p: { kind: "field" | "canal" | "road" | "water" | "pivot" | "pipe"; id: number | string } | null, fid: number | null) {
    if (!p) return;
    if (p.kind === "field") { reparent(Number(p.id), fid); return; }
    if (p.kind === "canal") setCanals((cs) => cs.map((c, k) => k === Number(p.id) ? { ...c, owner: fid ?? undefined } : c));
    else if (p.kind === "water") setWatercourses((ws) => ws.map((w, k) => k === Number(p.id) ? { ...w, owner: fid ?? undefined } : w));
    else if (p.kind === "road") setRoads((rs) => rs.map((r) => r.id === p.id ? { ...r, owner: fid ?? undefined } : r));
    else if (p.kind === "pivot") {
      const src = Number(p.id);
      setPivots((ps) => ps.map((pv) => (pv.field ?? -1) === src ? { ...pv, field: fid ?? undefined } : pv));
      setPivotLines((ls) => ls.map((l) => l.kind !== "pipe" && (l.field ?? -1) === src ? { ...l, field: fid ?? undefined } : l));
    } else if (p.kind === "pipe") {
      const src = Number(p.id);
      setPivotLines((ls) => ls.map((l) => l.kind === "pipe" && (l.field ?? -1) === src ? { ...l, field: fid ?? undefined } : l));
    }
    setMsg(fid != null ? t("Oggetto assegnato al campo ✓") : t("Oggetto scollegato dal campo ✓"));
  }
  function updateActiveGeom(geom: Polygon) {
    setFields((fs) => fs.map((f) => f.id === activeId ? { ...f, geom, lay: null, layGeo: null, suit: null } : f));
    if (activeId != null) elevCache.current.delete(activeId);   // geometria cambiata → ricalcola la quota
    setElevNonce((n) => n + 1);
  }
  function selectField(id: number) {
    setActiveId(id); clearViewOverlays(); setScenes([]); setDate("");
    setFields((fs) => { renderFields(fs, id); return fs; });
  }
  function renameField(f: Field) {
    const name = prompt(t("Nome campo"), f.name); if (!name || name === f.name) return;
    setFields((fs) => { const arr = fs.map((x) => x.id === f.id ? { ...x, name } : x); renderFields(arr, activeId); return arr; });
  }
  function removeField(f: Field) {
    // Elimina il campo e tutti i suoi poligoni figli (famiglia). Se provengono
    // da aree salvate, li rimuove anche dal progetto così non riappaiono.
    const kill = new Set<number>([f.id]);
    let grew = true;
    while (grew) { grew = false; for (const x of fields) { if (x.parentId != null && kill.has(x.parentId) && !kill.has(x.id)) { kill.add(x.id); grew = true; } } }
    const hasChildren = kill.size > 1;
    if (f.savedId != null || hasChildren) {
      const msg = hasChildren ? t("Eliminare \"{name}\" e i suoi poligoni figli?", { name: f.name }) : t("Eliminare \"{name}\" dal progetto?", { name: f.name });
      if (!confirm(msg)) return;
    }
    const savedToDelete = fields.filter((x) => kill.has(x.id) && x.savedId != null).map((x) => x.savedId as number);
    setFields((fs) => {
      const arr = fs.filter((x) => !kill.has(x.id));
      const aId = kill.has(activeId ?? -1) ? (arr[0]?.id ?? null) : activeId;
      renderFields(arr, aId);
      if (kill.has(activeId ?? -1)) { setActiveId(aId); clearViewOverlays(); }
      return arr;
    });
    // I pivot dei campi eliminati vanno tolti dal modello.
    setPivots((ps) => ps.filter((p) => p.field == null || !kill.has(p.field)));
    setPivotLines((ls) => ls.filter((l) => l.field == null || !kill.has(l.field)));
    // Canali/strade/invasi assegnati ai campi eliminati tornano «non assegnati» (non spariscono).
    setCanals((cs) => cs.map((c) => c.owner != null && kill.has(c.owner) ? { ...c, owner: undefined } : c));
    setRoads((rs) => rs.map((r) => r.owner != null && kill.has(r.owner) ? { ...r, owner: undefined } : r));
    setWatercourses((ws) => ws.map((w) => w.owner != null && kill.has(w.owner) ? { ...w, owner: undefined } : w));
    if (projectId && savedToDelete.length) {
      Promise.all(savedToDelete.map((id) => api.deleteArea(id))).then(() => { if (projectId) refreshAreas(projectId); }).catch(showErr);
    }
  }
  function clearAllFields() {
    setFields([]); setActiveId(null); clearViewOverlays();
    setScenes([]); setDate(""); mapApi.current?.clearAll(); mapApi.current?.clearLayout();
  }
  async function importFile(f?: File) {
    if (!f) return; setMsg("");
    try {
      const imported = await parseFieldsFromFile(f);
      if (!imported.length) { setMsg(t("Nessun poligono valido nel file (GeoJSON/KML/KMZ).")); return; }
      const start = nextId.current;
      const newOnes: Field[] = imported.map((im) => {
        const id = nextId.current++;
        return { id, name: im.name || `${t("Area")} ${id}`, geom: im.geom, level: "area" as const };
      });
      setFields((prev) => {
        const arr = [...prev, ...newOnes];
        const aId = start;
        renderFields(arr, aId);
        setActiveId(aId);
        setTimeout(() => mapApi.current?.fitAll(), 30);
        return arr;
      });
      setMsg(t("Importati {n} campi ✓", { n: newOnes.length }));
    } catch (e) { showErr(e); }
  }

  // ---- aree salvate (campo + sotto-aree, sul progetto) ----
  function loadArea(a: Area) { addField(a.geojson, a.name, true, a.id); setMsg(""); setTimeout(() => mapApi.current?.fitAll(), 30); }
  async function renameArea(a: Area) {
    const name = prompt(t("Nome area"), a.name); if (!name || name === a.name) return;
    try { await api.updateArea(a.id, { name }); if (projectId) refreshAreas(projectId); } catch (e) { showErr(e); }
  }
  async function delArea(a: Area) {
    if (!confirm(t("Eliminare \"{name}\"?", { name: a.name }))) return;
    try { await api.deleteArea(a.id); if (projectId) refreshAreas(projectId); } catch (e) { showErr(e); }
  }

  // ---- satellite (campo attivo) ----
  const needField = () => { setMsg(t("Seleziona o aggiungi un campo.")); };
  async function searchScenes() {
    if (!activeGeom) return needField();
    setBusy("scenes"); setMsg("");
    try {
      const s = await api.fetchScenes(activeGeom, 12, 95);
      setScenes(s); setDate(s[0]?.date ?? "");
      if (!s.length) setMsg(t("Nessuna scena disponibile."));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  async function showPreview() {
    if (!activeGeom) return needField();
    if (!date) { setMsg(t("Cerca prima le date e selezionane una.")); return; }
    setBusy("preview"); setMsg("");
    try {
      const p = await api.fetchPreview(activeGeom, index, date, normalized);
      mapApi.current?.showOverlay("index", p.image, p.bounds);
      setScale((p.meta.scale as ColorScale) ?? null);
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function clearPreview() { mapApi.current?.clearOverlay("index"); setScale(null); }
  async function showDem() {
    if (!activeGeom) return needField();
    setBusy("dem"); setMsg("");
    try {
      const d = await api.fetchDem(activeGeom);
      mapApi.current?.showOverlay("dem", d.image, d.bounds);
      setDemInfo({ min: Number(d.meta.elev_min), max: Number(d.meta.elev_max), scale: d.meta.scale as ColorScale });
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function clearDem() {
    mapApi.current?.clearOverlay("dem"); mapApi.current?.clearContours();
    setDemInfo(null); setTerrainInfo(null);
  }
  // Rilievo ombreggiato + isoipse: rende leggibili dislivelli, sensi e pendenze.
  async function showTerrain() {
    if (!activeGeom) return needField();
    setBusy("terrain"); setMsg("");
    try {
      const tr = await api.fetchTerrain(activeGeom, 2, isoInterval);
      mapApi.current?.showOverlay("dem", tr.image, tr.bounds);
      mapApi.current?.showContours(tr.contours);
      setDemInfo(null);
      setTerrainInfo({ interval: tr.interval_m, min: tr.elev_min, max: tr.elev_max });
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }

  // ---- idoneità (campo attivo) ----
  async function computeSuit() {
    if (!activeGeom || !active) return needField();
    if (!date) { setMsg(t("Cerca e scegli prima una data.")); return; }
    setBusy("suit"); setMsg("");
    try {
      const s = await api.fetchSuitability(activeGeom, date, {
        weights: cur.weights,
        slope_ideal_pct: cur.slopeIdeal / 10, slope_max_pct: cur.slopeMax / 10,  // ‰ → %
      });
      mapApi.current?.showOverlay("suitability", s.image, s.bounds);
      setFields((fs) => fs.map((f) => f.id === active.id ? { ...f, suit: s.meta } : f));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function clearSuit() {
    mapApi.current?.clearOverlay("suitability");
    if (active) setFields((fs) => fs.map((f) => f.id === active.id ? { ...f, suit: null } : f));
  }

  // ---- macro-aree (M6, fase 1) ----
  async function detectMacroareas() {
    if (!activeGeom) return needField();
    if (!date) { setMsg(t("Cerca e scegli prima una data.")); return; }
    setBusy("macro"); setMsg("");
    try {
      const rows = await api.fetchMacroareas(activeGeom, date, {
        weights: cur.weights, slope_ideal_pct: cur.slopeIdeal / 10, slope_max_pct: cur.slopeMax / 10,
        min_suitability: macroThr, min_area_ha: macroMinHa,
      });
      setMacroAreas(rows);
      renderMacrosOnMap(fields, rows);
      if (!rows.length) setMsg(t("Nessuna macro-area trovata con questi criteri."));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function clearMacro() { setMacroAreas([]); renderMacrosOnMap(fields, []); }

  // ---- corsi d'acqua esistenti (NDWI): rilevati e 'ricalcati' prima di
  // progettare canali e pivot; i pivot li evitano automaticamente. ----
  // sensibilità → soglie NDWI/area e area di bacino DEM (più alta = più corsi rilevati)
  function waterParams() {
    const s = waterSens;                          // 1..5
    return {
      ndwi_thr: 0.20 - (s - 1) * 0.075,
      min_area_ha: [0.6, 0.4, 0.25, 0.15, 0.08][s - 1],
      dem_channel_ha: [80, 50, 25, 12, 6][s - 1],  // impluvi DEM: soglia bacino
      dem_depth_m: [3.0, 2.0, 1.2, 0.7, 0.4][s - 1],  // alvei incisi: profondità min
    };
  }
  async function detectWater() {
    if (!activeGeom) return needField();
    if (!date) { setMsg(t("Cerca e scegli prima una data.")); return; }
    setBusy("water"); setMsg("");
    try {
      const p = waterParams();
      const w = await api.fetchWatercourses(activeGeom, date, p.min_area_ha, p.ndwi_thr, true, p.dem_channel_ha, p.dem_depth_m);
      if (!w.features.length) { setMsg(t("Nessun corso d'acqua rilevato: prova ad alzare la sensibilità.")); return; }
      // ANTEPRIMA modificabile a mano: conferma o annulla
      mapApi.current?.previewWater(w.features.map((f) => ({ geom: f.geojson, kind: f.kind })));
      setWaterPreview(true); setWaterRemoveOn(false);
      setMsg(t("Anteprima: {r} fiumi/canali, {d} impluvi (DEM), {b} bacini, {p} paludi. Modifica a mano, poi Conferma.",
        { r: w.n_river, d: w.n_drainage, b: w.n_basin, p: w.n_wetland }));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function confirmWaterUI() {
    const raw = mapApi.current?.confirmWater() || [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const feats: Watercourse[] = raw.map((c) => ({ geojson: c.geom as any, kind: c.kind, area_ha: 0 }));
    setWatercourses(feats);
    renderWater(feats);
    setWaterPreview(false); setWaterRemoveOn(false);
    setMsg(t("Corsi d'acqua confermati: {n}. I pivot li eviteranno.", { n: feats.length }));
  }
  function cancelWaterPreview() { mapApi.current?.cancelWater(); setWaterPreview(false); setWaterRemoveOn(false); setMsg(""); }
  function toggleWaterRemove() { const v = !waterRemoveOn; setWaterRemoveOn(v); mapApi.current?.waterRemoveMode(v); }
  function clearWater() { setWatercourses([]); setWaterPreview(false); mapApi.current?.clearWater(); mapApi.current?.cancelWater(); }

  // Aggiunge una macro-area come SOTTO-LIVELLO del campo attivo (il poligono in
  // cui è inscritta), non come nuovo campo di primo livello.
  // I poligoni individuati dall'analisi diventano CAMPI (livello «campo»): veri
  // poligoni selezionabili annidati sotto l'AREA attiva.
  function addMacroToField(m: MacroArea) {
    if (activeId == null) { needField(); return; }
    const pid = activeId;
    const cnt = fields.filter((f) => f.parentId === pid && f.level === "campo").length + 1;
    const nf: Field = { id: nextId.current++, name: `${t("Campo")} ${cnt}`, geom: m.geojson, parentId: pid, level: "campo", score: m.mean_score };
    const rest = macroAreas.filter((x) => x !== m);
    setMacroAreas(rest);
    setFields((fs) => { const arr = [...fs, nf]; renderFields(arr, activeId); renderMacrosOnMap(arr, rest); return arr; });
  }
  function addAllMacroToField() {
    if (activeId == null) { needField(); return; }
    const pid = activeId;
    let cnt = fields.filter((f) => f.parentId === pid && f.level === "campo").length;
    const add: Field[] = macroAreas.map((m) => { cnt += 1; return { id: nextId.current++, name: `${t("Campo")} ${cnt}`, geom: m.geojson, parentId: pid, level: "campo" as const, score: m.mean_score }; });
    setMacroAreas([]);
    setFields((fs) => { const arr = [...fs, ...add]; renderFields(arr, activeId); renderMacrosOnMap(arr, []); return arr; });
  }
  function removeFieldMacro(fieldId: number, macroId: number) {
    setFields((fs) => {
      const arr = fs.map((f) => f.id === fieldId ? { ...f, macros: (f.macros ?? []).filter((mm) => mm.id !== macroId) } : f);
      renderMacrosOnMap(arr, macroAreas);
      return arr;
    });
  }
  function renameFieldMacro(fieldId: number, mm: FieldMacro) {
    const name = prompt(t("Nome sotto-area"), mm.name); if (!name || name === mm.name) return;
    setFields((fs) => {
      const arr = fs.map((f) => f.id === fieldId ? { ...f, macros: (f.macros ?? []).map((x) => x.id === mm.id ? { ...x, name } : x) } : f);
      renderMacrosOnMap(arr, macroAreas);
      return arr;
    });
  }
  // Salva un campo, la sua FAMIGLIA (poligoni figli, a qualsiasi profondità) e le
  // sue sotto-aree (macro) nel progetto. Salva sempre partendo dalla radice.
  async function saveFieldTree(f: Field) {
    if (!projectId) { setMsg(t("Serve un progetto selezionato per salvare l'area.")); return; }
    const pid = projectId;
    setBusy("save");
    try {
      // Risali alla radice della famiglia.
      let root = f; const guard = new Set<number>();
      while (root.parentId != null && !guard.has(root.id)) { guard.add(root.id); const p = fields.find((x) => x.id === root.parentId); if (!p) break; root = p; }
      const savedMap = new Map<number, number>();
      let count = 0;
      const saveNode = async (nd: Field, parentAreaId: number | null) => {
        const fa = await api.createArea({
          project_id: pid, name: nd.name, geojson: nd.geom,
          area_ha: Math.round(ringAreaHa(nd.geom.coordinates)),
          parent_area_id: parentAreaId, kind: parentAreaId == null ? "field" : "field-child",
        });
        savedMap.set(nd.id, fa.id);
        for (const mm of nd.macros ?? []) {
          await api.createArea({ project_id: pid, name: mm.name, geojson: mm.geom, area_ha: Math.round(mm.area_ha), parent_area_id: fa.id, kind: "macro" });
          count++;
        }
        for (const kid of fields.filter((x) => x.parentId === nd.id)) { count++; await saveNode(kid, fa.id); }
      };
      await saveNode(root, null);
      setFields((fs) => fs.map((x) => savedMap.has(x.id) ? { ...x, savedId: savedMap.get(x.id) } : x));
      await refreshAreas(pid);
      setMsg(t("Famiglia salvata: {n} elementi ✓", { n: count + 1 }));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }

  // Salva TUTTO il progetto: campi + famiglie + sotto-aree (come aree, con
  // gerarchia) e canali/strade/invasi/pivot (come layer). Le assegnazioni
  // oggetto→campo sono memorizzate con l'ID area del DB (stabile), poi rimappate
  // alla riapertura. Rifà il salvataggio da zero (cancella il precedente).
  // Ogni salvataggio passa da questa catena: due saveAll non possono MAI girare
  // insieme. Senza questa serializzazione due salvataggi sovrapposti leggevano
  // entrambi la stessa lista di aree "vecchie", creavano ciascuno la propria
  // copia dei poligoni e cancellavano solo quella vecchia comune: risultato, i
  // poligoni raddoppiati che comparivano dopo un aggiornamento.
  function saveAll(silent = false): Promise<boolean> {
    const run = saveChainRef.current.then(() => saveAllInner(silent), () => saveAllInner(silent));
    saveChainRef.current = run.then(() => undefined, () => undefined);
    return run;
  }
  async function saveAllInner(silent = false): Promise<boolean> {
    if (!projectId) { if (!silent) setMsg(t("Serve un progetto selezionato per salvare.")); return false; }
    const pid = projectId;
    // GUARDIA anti-perdita: non salvare uno stato "vuoto" (nessun poligono), che
    // di solito è un caricamento incompleto: cancellerebbe un progetto valido.
    // (Un progetto nuovo davvero vuoto non ha nulla da salvare, quindi va bene.)
    if (!fields.length) { setAutosave("saved"); return true; }
    if (!silent) { setBusy("save"); setMsg(t("Salvo il progetto…")); }
    setAutosave("saving");
    // Strategia SICURA: prima CREA tutto il nuovo, poi cancella il vecchio; se
    // qualcosa fallisce, si annulla il nuovo parziale e il vecchio resta intatto.
    const newAreaIds: number[] = [];
    const newLayerIds: number[] = [];
    try {

      // 1) Crea le NUOVE aree (famiglie) e mappa idCampoFrontend → idAreaDB.
      const fieldToArea = new Map<number, number>();
      const saveNode = async (nd: Field, parentAreaId: number | null) => {
        const fa = await api.createArea({
          project_id: pid, name: nd.name, geojson: nd.geom,
          area_ha: Math.round(ringAreaHa(nd.geom.coordinates)),
          parent_area_id: parentAreaId, kind: parentAreaId == null ? "field" : "field-child",
        });
        newAreaIds.push(fa.id);
        fieldToArea.set(nd.id, fa.id);
        for (const mm of nd.macros ?? []) { const ma = await api.createArea({ project_id: pid, name: mm.name, geojson: mm.geom, area_ha: Math.round(mm.area_ha), parent_area_id: fa.id, kind: "macro" }); newAreaIds.push(ma.id); }
        for (const kid of fields.filter((x) => x.parentId === nd.id)) await saveNode(kid, fa.id);
      };
      for (const root of fields.filter((f) => f.parentId == null)) await saveNode(root, null);
      const ownerArea = (o?: number) => (o != null && fieldToArea.has(o) ? fieldToArea.get(o)! : null);

      // 2) Crea i NUOVI layer (solo i tipi con dati). Il pivot per ultimo perché è
      //    il più pesante: se fallisse, il vecchio è ancora tutto al suo posto.
      if (canals.length) newLayerIds.push((await api.createLayer({ project_id: pid, kind: "canals", name: t("Canali"), data: { items: canals.map((c) => ({ ...c, ownerArea: ownerArea(c.owner) })) } })).id);
      if (roads.length) newLayerIds.push((await api.createLayer({ project_id: pid, kind: "roads", name: t("Strade"), data: { items: roads.map((r) => ({ ...r, ownerArea: ownerArea(r.owner) })) } })).id);
      if (watercourses.length) newLayerIds.push((await api.createLayer({ project_id: pid, kind: "waters", name: t("Invasi/corsi d'acqua"), data: { items: watercourses.map((w) => ({ ...w, ownerArea: ownerArea(w.owner) })) } })).id);

      const styles: Record<number, { color?: string; fillColor?: string; fillOpacity?: number }> = {};
      const levels: Record<number, string> = {};
      const scores: Record<number, number> = {};
      const hiddenFields: Record<number, boolean> = {};
      const hiddenPivots: Record<number, boolean> = {};
      const hiddenPipes: Record<number, boolean> = {};
      for (const f of fields) {
        const aid = fieldToArea.get(f.id); if (aid == null) continue;
        if (f.style) styles[aid] = f.style;
        if (f.level) levels[aid] = f.level;
        if (f.score != null) scores[aid] = f.score;
        if (f.hidden) hiddenFields[aid] = true;
      }
      for (const fid of hiddenPivotFields) { const aid = fieldToArea.get(fid); if (aid != null) hiddenPivots[aid] = true; }
      for (const fid of hiddenPipeFields) { const aid = fieldToArea.get(fid); if (aid != null) hiddenPipes[aid] = true; }
      const hasStyle = !!(Object.keys(styles).length || Object.keys(levels).length || Object.keys(scores).length || Object.keys(hiddenFields).length || Object.keys(hiddenPivots).length || Object.keys(hiddenPipes).length);
      if (hasStyle) newLayerIds.push((await api.createLayer({ project_id: pid, kind: "styles", name: t("Stili"), data: { byArea: styles, levels, scores, hiddenFields, hiddenPivots, hiddenPipes } })).id);

      if (pivots.length) {
        const mp = pivots.map((p) => ({ ...p, field: ownerArea(p.field) ?? undefined }));
        const ml = pivotLines.map((l) => ({ ...l, field: ownerArea(l.field) ?? undefined }));
        const pfc = fcFromModel(mp, ml);
        // portata calcolata di ogni pivot (l/s): la mostra il link di sola lettura
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pfc.features.forEach((ft: any, i: number) => { if (i < mp.length && ft.properties?.kind === "pivot") ft.properties.q_ls = Math.round(pivotFlow(pivots[i]) * 10) / 10; });
        newLayerIds.push((await api.createLayer({ project_id: pid, kind: "pivots", name: t("Pivot"), data: { geojson: pfc, meta: guided?.meta ?? { n_pivots: pivots.length } } })).id);
      }

      // 3) Ora che TUTTO il nuovo è salvato, elimina il vecchio. I layer si
      //    rimpiazzano solo per i tipi effettivamente riscritti: così un tipo
      //    momentaneamente vuoto in memoria NON cancella quello salvato.
      const rewritten = new Set<string>();
      if (canals.length) { rewritten.add("canals"); rewritten.add("canal"); }
      if (roads.length) rewritten.add("roads");
      if (watercourses.length) rewritten.add("waters");
      if (hasStyle) rewritten.add("styles");
      if (pivots.length) rewritten.add("pivots");
      // Si rilegge lo stato ATTUALE del server invece di fidarsi della fotografia
      // iniziale: si tiene solo quello appena creato e si elimina tutto il resto.
      // Così un eventuale doppione rimasto da prima sparisce al primo salvataggio.
      const keepA = new Set(newAreaIds), keepL = new Set(newLayerIds);
      const [curAreas, curLayers] = await Promise.all([api.listAreas(pid), api.listLayers(pid)]);
      for (const l of curLayers) if (rewritten.has(l.kind) && !keepL.has(l.id)) { try { await api.deleteLayer(l.id); } catch { /* ignora */ } }
      const stale = curAreas.filter((a) => !keepA.has(a.id));
      const byId = new Map(curAreas.map((a) => [a.id, a] as const));
      const depth = (a: typeof curAreas[number]) => { let d = 0; let cur: typeof curAreas[number] | undefined = a; while (cur?.parent_area_id != null && d < 30) { d++; cur = byId.get(cur.parent_area_id); } return d; };
      for (const a of stale.sort((x, y) => depth(y) - depth(x))) { try { await api.deleteArea(a.id); } catch { /* ignora */ } }

      fieldToAreaRef.current = fieldToArea;   // per costruire la config dei link di condivisione
      setFields((fs) => fs.map((x) => fieldToArea.has(x.id) ? { ...x, savedId: fieldToArea.get(x.id) } : x));
      await Promise.all([refreshAreas(pid), refreshLayers(pid)]);
      setAutosave("saved");
      if (!silent) setMsg(t("Progetto salvato ✓ ({n} campi, {c} canali, {s} strade, {w} invasi, {p} pivot)", { n: fields.filter((f) => f.parentId == null).length, c: canals.length, s: roads.length, w: watercourses.length, p: pivots.length }));
      return true;
    } catch (e) {
      // Rollback del nuovo parziale: il salvataggio precedente resta intatto.
      for (const id of newLayerIds) { try { await api.deleteLayer(id); } catch { /* */ } }
      for (const id of [...newAreaIds].reverse()) { try { await api.deleteArea(id); } catch { /* */ } }
      setAutosave("error"); if (!silent) showErr(e); else console.error(e); return false;
    } finally { if (!silent) setBusy(""); }
  }

  // ---- canale principale (M6, fase 2) ----
  const arm = (kind: "start" | "end") => {
    setPickMode(kind);
    mapApi.current?.armPick((lon, lat) => {
      const pt = [lon, lat];
      if (kind === "start") { setCanalStart(pt); mapApi.current?.clearReachable(); }
      else setCanalEnd(pt);
      setPickMode(null); setMsg("");
      mapApi.current?.clearReachable();
      mapApi.current?.showPending(
        kind === "start" ? pt : canalStart,
        kind === "end" ? pt : canalEnd,
        t("Presa"), t("Finale"));
    });
  };
  async function armPick(kind: "start" | "end") {
    if (kind === "end" && canalStart && activeGeom) {
      // Mostra prima dove il finale è realisticamente collocabile: la zona a
      // valle della presa (raggiungibile a gravità, in discesa).
      setBusy("reach"); setMsg("");
      try {
        const r = await api.fetchReachable(activeGeom, canalStart);
        if (!r.polygons.length) {
          setMsg(t("Nessuna zona a valle della presa: spostala più in alto.")); setBusy(""); return;
        }
        mapApi.current?.showReachable(r.polygons, t("Finale collocabile qui (a valle della presa)"));
        setMsg(t("Zona a valle: {a} ha, fino a −{d} m. Clicca nell'area evidenziata.",
          { a: fmt(r.area_ha, { maximumFractionDigits: 0 }), d: fmt(r.elev_start_m - r.elev_min_m, { maximumFractionDigits: 1 }) }));
      } catch (e) { showErr(e); setBusy(""); return; }
      setBusy("");
    } else {
      setMsg(kind === "start" ? t("Clicca sulla mappa per posizionare la presa.")
                              : t("Clicca sulla mappa per posizionare il finale."));
    }
    arm(kind);
  }
  function cancelPick() { setPickMode(null); setMsg(""); mapApi.current?.disarmPick(); mapApi.current?.clearReachable(); }
  function resetPicks() {
    setCanalStart(null); setCanalEnd(null);
    mapApi.current?.showPending(null, null, t("Presa"), t("Finale"));
    mapApi.current?.clearReachable();
  }
  // Unisce un canale appena creato a uno esistente se lo tocca/entra:
  // - estremi vicini (testa-coda) → fonde i due in un unico canale;
  // - un estremo cade lungo un altro canale (giunzione a T) → aggancia l'estremo.
  const JOIN_M = 30;                                 // soglia di unione (m)
  async function joinCanals(nc: Canal, list: Canal[]): Promise<Canal[]> {
    const N = nc.geojson.coordinates.map((c) => [c[0], c[1]]);
    // 1) fusione testa-coda con un canale esistente
    for (let i = 0; i < list.length; i++) {
      const E = list[i].geojson.coordinates.map((c) => [c[0], c[1]]);
      const ns = N[0], ne = N[N.length - 1], es = E[0], ee = E[E.length - 1];
      let merged: number[][] | null = null;
      if (distM(ns, ee) <= JOIN_M) merged = [...E, ...N.slice(1)];
      else if (distM(ne, es) <= JOIN_M) merged = [...N, ...E.slice(1)];
      else if (distM(ns, es) <= JOIN_M) merged = [...[...E].reverse(), ...N.slice(1)];
      else if (distM(ne, ee) <= JOIN_M) merged = [...N, ...[...E].reverse().slice(1)];
      if (merged) {
        try {
          const mc = await api.fetchCanal(_bboxPoly(merged), canalPermille, null, null, null, merged, false);
          setMsg(t("Canali uniti: uno entrava nell'altro."));
          return [...list.filter((_, k) => k !== i), mc];
        } catch { /* se la fusione fallisce, prosegui senza unire */ }
      }
    }
    // 2) giunzione a T: aggancia gli estremi del nuovo canale su un canale esistente
    let snapped = false;
    for (const e of list) {
      const E = e.geojson.coordinates;
      const a = nearestOnPolyline(N[0], E);
      if (a && a.distM <= JOIN_M) { N[0] = a.pt; snapped = true; }
      const b = nearestOnPolyline(N[N.length - 1], E);
      if (b && b.distM <= JOIN_M) { N[N.length - 1] = b.pt; snapped = true; }
    }
    if (snapped) {
      try {
        const sc = await api.fetchCanal(_bboxPoly(N), canalPermille, null, null, null, N, false);
        setMsg(t("Canale agganciato a quello esistente."));
        return [...list, sc];
      } catch { /* se lo snap fallisce, aggiungi il canale così com'è */ }
    }
    return [...list, nc];
  }

  async function traceCanal() {
    if (!activeGeom) return needField();
    setBusy("canal"); setMsg("");
    try {
      const cc = await api.fetchCanal(activeGeom, canalPermille, canalStart, canalEnd);
      const next = await joinCanals(cc, canals);
      setCanals(next);
      setCanalStart(null); setCanalEnd(null);
      mapApi.current?.showPending(null, null, t("Presa"), t("Finale"));
      mapApi.current?.clearReachable();
      renderCanals(next);
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  // importa canali da KMZ/KML/GeoJSON: ogni polilinea diventa un canale
  // (quota campionata dal DEM sul bounding box della linea).
  const canalFileRef = useRef<HTMLInputElement | null>(null);
  function _bboxPoly(coords: number[][]): Polygon {
    let mnx = 180, mny = 90, mxx = -180, mxy = -90;
    for (const [lo, la] of coords) { mnx = Math.min(mnx, lo); mny = Math.min(mny, la); mxx = Math.max(mxx, lo); mxy = Math.max(mxy, la); }
    const m = 0.004;
    return { type: "Polygon", coordinates: [[[mnx - m, mny - m], [mxx + m, mny - m], [mxx + m, mxy + m], [mnx - m, mxy + m], [mnx - m, mny - m]]] };
  }
  async function importCanals(files?: FileList | null) {
    if (!files || !files.length) return;
    setBusy("canal"); setMsg("");
    try {
      let next = [...canals]; let added = 0;
      for (const f of Array.from(files)) {
        const lines = await parseLinesFromFile(f);
        for (const ln of lines) {
          if (ln.coords.length < 2) continue;
          setMsg(t("Importo canali… ({n})", { n: added + 1 }));
          const cc = await api.fetchCanal(_bboxPoly(ln.coords), canalPermille, null, null, null, ln.coords);
          next = await joinCanals(cc, next); added += 1;
        }
      }
      setCanals(next);
      renderCanals(next);
      setMsg(added ? t("Importati {n} canali da file.", { n: added }) : t("Nessuna linea trovata nei file (KMZ/KML/GeoJSON)."));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function traceCanalManual() {
    if (!activeGeom) return needField();
    setMsg(snapCanal
      ? t("Traccia grezza lungo il canale (doppio clic per finire): la aggancio all'alveo col DEM.")
      : t("Traccia a mano: clicca i punti del canale sulla mappa, doppio clic per finire."));
    mapApi.current?.drawCanalManual(async (coords) => {
      setBusy("canal"); setMsg(snapCanal ? t("Aggancio all'alveo (DEM)…") : "");
      try {
        // usa il riquadro della linea come area: DEM ad alta risoluzione sull'intorno
        const geomForDem = _bboxPoly(coords);
        const cc = await api.fetchCanal(geomForDem, canalPermille, null, null, null, coords, snapCanal);
        const next = await joinCanals(cc, canals);
        setCanals(next);
        renderCanals(next);
        setMsg("");
      } catch (e) { showErr(e); } finally { setBusy(""); }
    });
  }
  function removeCanal(i: number) {
    if (editingCanal === i) endEditCanal();
    const next = canals.filter((_, k) => k !== i);
    setCanals(next);
    renderCanals(next);
  }
  function clearCanalUI() {
    setCanals([]); setCanalStart(null); setCanalEnd(null); setPickMode(null); setEditingCanal(null);
    mapApi.current?.disarmPick(); mapApi.current?.clearCanal(); mapApi.current?.clearReachable();
    mapApi.current?.endCanalEdit();
  }
  // ---- percorso del canale trascinabile (mantiene la discesa a gravità) ----
  function installCanalEditor(i: number, c: Canal) {
    if (!activeGeom) return;
    mapApi.current?.editCanal(c.geojson.coordinates, c.start, c.end, c.waypoints || [],
      async (start, end, waypoints) => {
        try {
          const cc = await api.fetchCanal(activeGeom, c.target_permille, start, end, waypoints);
          setCanals((prev) => {
            const arr = [...prev]; arr[i] = cc;
            renderCanals(arr);
            return arr;
          });
          installCanalEditor(i, cc);   // reinstalla le maniglie sul percorso ricalcolato
          setMsg("");
        } catch (e) {
          showErr(e);                  // es. waypoint più in alto: percorso non in discesa
          installCanalEditor(i, c);    // ripristina le maniglie sull'ultimo percorso valido
        }
      });
  }
  function startEditCanal(i: number) {
    if (!activeGeom) return needField();
    setEditingCanal(i);
    setMsg(t("Trascina presa, finale o i punti del percorso. Clicca sulla linea per aggiungere un punto. Il canale resta sempre in discesa."));
    installCanalEditor(i, canals[i]);
  }
  function endEditCanal() { setEditingCanal(null); setMsg(""); mapApi.current?.endCanalEdit(); }
  function exportCanalKmz(i: number, c: Canal) {
    exportKmz(`canale_${i + 1}`, [{ name: `${t("Canale")} ${i + 1}`, geom: { type: "LineString", coordinates: c.geojson.coordinates } }]);
  }

  // ---- salvataggio / ricarica livelli (canali, pivot) — ri-editabili ----
  async function saveCanalLayer(i: number, c: Canal) {
    if (!projectId) { setMsg(t("Serve un progetto selezionato per salvare.")); return; }
    try {
      await api.createLayer({ project_id: projectId, kind: "canal", name: `${t("Canale")} ${i + 1}`, data: c });
      await refreshLayers(projectId); setMsg(t("Livello salvato ✓"));
    } catch (e) { showErr(e); }
  }
  async function savePivotsLayer() {
    if (!projectId) { setMsg(t("Serve un progetto selezionato per salvare.")); return; }
    if (!guided) return;
    try {
      await api.createLayer({ project_id: projectId, kind: "pivots", name: t("Pivot"), data: guided });
      await refreshLayers(projectId); setMsg(t("Livello salvato ✓"));
    } catch (e) { showErr(e); }
  }
  function loadLayer(l: ProjectLayer) {
    if (l.kind === "canal") {
      const c = l.data as unknown as Canal;
      setCanals((prev) => {
        const next = [...prev, c];
        renderCanals(next);
        return next;
      });
      goTab("rilievo");
    } else if (l.kind === "pivots") {
      const g = l.data as unknown as GuidedResult;
      setGuided(g);
      setModelFromGuided(g);
      goTab("impianti");
    }
    setMsg(t("Livello caricato ✓"));
  }
  async function delLayer(l: ProjectLayer) {
    if (!confirm(t("Eliminare \"{name}\"?", { name: l.name }))) return;
    try { await api.deleteLayer(l.id); if (projectId) refreshLayers(projectId); } catch (e) { showErr(e); }
  }
  function exportLayerKmz(l: ProjectLayer) {
    if (l.kind === "canal") {
      const c = l.data as unknown as Canal;
      exportKmz(safe(l.name), [{ name: l.name, geom: { type: "LineString", coordinates: c.geojson.coordinates } }]);
    } else if (l.kind === "pivots") {
      const g = l.data as unknown as GuidedResult;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = (g.geojson.features || []).filter((f: any) => f.geometry?.type === "Polygon")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((f: any, k: number) => ({ name: `${l.name} ${k + 1}`, geom: { type: "Polygon" as const, coordinates: f.geometry.coordinates } }));
      exportKmz(safe(l.name), items);
    }
  }

  // ---- pivot lungo il canale (M6, fase 3) + gerarchia gruppo/singolo ----
  // Carica il modello modificabile a partire dal risultato del solutore.
  function setModelFromGuided(g: GuidedResult) {
    const defR = Number(g.meta?.radius_m) || pivotR;
    const { pivots: pv, lines } = pivotsFromFC(g.geojson, defR);
    setPivots(pv); setPivotLines(lines); setPivotSel({ mode: "none", idx: -1 });
  }
  // Aggiorna i pivot modificati a mano: ricalcola meta e tiene `guided` in sincronia
  // (così statistiche, salvataggio ed esporto riflettono le modifiche).
  function commitPivots(next: PivotItem[]) {
    setPivots(next);
    setGuided((prev) => {
      if (!prev) return prev;
      const geojson = fcFromModel(next, pivotLines);
      const nCanal = next.filter((p) => p.conn !== "pipe").length;
      const nPipe = next.length - nCanal;
      const netHa = next.reduce((s, p) => s + pvAreaM2(p) / 10000, 0);
      return { ...prev, geojson, meta: { ...prev.meta, n_pivots: next.length, n_canal_conn: nCanal, n_pipe_conn: nPipe, net_ha: Math.round(netHa * 10) / 10 } };
    });
  }
  // Ridisegna i pivot sulla mappa a ogni cambio di modello/selezione.
  // Coefficienti colturali (Kc di punta) e assorbimento tipico per suolo.
  const CROPS: Record<string, number> = Object.fromEntries(CROP_LIST.map((c) => [c.key, c.kc]));
  // Fabbisogno consigliato: ET₀ di punta × Kc, meno la pioggia utile, diviso
  // l'efficienza dell'impianto.
  // Coltura più esigente fra quelle scelte (globale o per campo con pivot): il
  // dimensionamento di rete, stazioni e vasche si fa sulla sua ETc di punta.
  const kcMax = Math.max(CROPS[cropKey] ?? 1.1, ...fields.filter((f) => pivots.some((p) => p.field === f.id)).map((f) => effSettings(f).kc || 0));
  const cropMax = CROP_LIST.find((c) => Math.abs(c.kc - kcMax) < 1e-6 && c.key === cropKey) ?? CROP_LIST.find((c) => Math.abs(c.kc - kcMax) < 1e-6);
  const etcMax = et0Peak * kcMax;                                                    // mm/g
  const mm24Suggested = Math.max(0, etcMax - rainMm) / Math.max(0.3, effPct / 100);
  // Fabbisogno di progetto: mai sotto quello della coltura più esigente.
  const mmDes = Math.max(mm24, mm24Suggested);
  useEffect(() => {
    const api2 = mapApi.current; if (!api2) return;
    // Filtra i gruppi pivot nascosti (per campo) e rimappa gli indici visibili → reali.
    const visIdx = pivots.map((_, k) => k).filter((k) => !hiddenPivotFields.has(pivots[k].field ?? -1));
    const fed = fedPivotKeys(pivotLines);
    const visP = visIdx.map((k) => ({ ...pivots[k], unconn: pivotLines.some((l) => l.kind === "pipe") && !fed.has(pKey(pivots[k])),
      label: pivotLabels ? `${nPhases > 1 && phaseColors ? `F${pivots[k].phase ?? 1} · ` : ""}${uHa(pvAreaM2(pivots[k]) / 10000, 1)}<br>${fmt(Math.round(pivotFlow(pivots[k])))} l/s` : undefined,
      phaseColor: nPhases > 1 && phaseColors }));
    // Le tubazioni hanno una visibilità propria (oggetto a sé); le altre linee
    // seguono la visibilità del gruppo pivot del loro campo.
    const visL = pivotLines.filter((l) => l.kind === "pipe"
      ? !hiddenPipeFields.has(l.field ?? -1)
      : !hiddenPivotFields.has(l.field ?? -1));
    if (!visP.length && !visL.length) { api2.clearPivots?.(); return; }
    let selForShow = pivotSel;
    if (pivotSel.mode === "single") { const vpos = visIdx.indexOf(pivotSel.idx); selForShow = vpos >= 0 ? { mode: "single", idx: vpos } : { mode: "none", idx: -1 }; }
    const pipeSelForShow = pipeSel;
    api2.showPivots?.({ pivots: visP, lines: visL }, selForShow, {
      onClick: (i) => {
        const real = visIdx[i];
        // lavorare sui pivot chiude la modifica di una tubazione
        if (editPipeRef.current != null) { editPipeRef.current = null; api2.endPipeEdit?.(); }
        setPipeSel({ mode: "none", idx: -1 });
        setPivotSel((s) => (s.mode === "none" ? { mode: "group", idx: -1 } : { mode: "single", idx: real }));
      },
      onMove: (i, lat, lng) => { const real = visIdx[i]; commitPivots(pivots.map((p, k) => (k === real ? { ...p, lat, lng } : p))); },
      onBackground: () => {
        setPivotSel({ mode: "none", idx: -1 }); setPipeSel({ mode: "none", idx: -1 });
        if (editPipeRef.current != null) { editPipeRef.current = null; api2.endPipeEdit?.(); setMsg(""); }
      },
      // Clic su una tubazione: la rende modificabile (maniglie sui vertici).
      onLineClick: (li) => {
        const target = pivotLines.indexOf(visL[li]);   // indice reale nel modello
        if (target < 0) return;
        // PRIMO clic: seleziona il GRUPPO delle tubazioni, senza entrare in modifica.
        if (pipeSel.mode === "none") {
          setPivotSel({ mode: "none", idx: -1 });
          setPipeSel({ mode: "group", idx: -1 });
          if (editPipeRef.current != null) { editPipeRef.current = null; api2.endPipeEdit?.(); }
          setMsg(t("Gruppo tubazioni selezionato: clicca una tubazione per modificarla."));
          return;
        }
        // SECONDO clic (o clic su un'altra tubazione): modifica quella singola.
        setPipeSel({ mode: "single", idx: li });
        editPipeRef.current = target;
        setMsg(t("Trascina i punti: si agganciano ai centri dei pivot e al canale. Clic sulla linea per aggiungere un punto, doppio clic (o tasto destro) su un punto per eliminarlo."));
        const openEditor = (coords0: number[][]) => {
          api2.editPipe?.(coords0, (coords) => {
            // Se la modifica ha staccato la tubazione dall'acqua, viene riattaccata
            // subito e l'editor riaperto sul tracciato corretto, così le maniglie
            // mostrano la nuova presa invece di restare indietro.
            const fixed = reattachToWater(coords, target);
            setPivotLines((ls) => {
              const arr = ls.map((l, k) => (k === target ? { ...l, coords: fixed } : l));
              setGuided((gp) => (gp ? { ...gp, geojson: fcFromModel(pivots, arr) } : gp));
              return arr;
            });
            if (fixed.length !== coords.length) {
              setMsg(t("Tubazione ricollegata alla rete ✓"));
              setTimeout(() => openEditor(fixed), 0);
            }
          },
          pivots.map((pv) => [pv.lng, pv.lat]),                       // aggancio ai centri dei pivot
          waterLinesLL(),                                             // aggancio al canale / fiume
          { pivot: t("Agganciato al centro del pivot"), canal: t("Agganciato al canale"), free: t("Punto libero") });
        };
        openEditor(pivotLines[target].coords);
      },
    }, pipeSelForShow, waterLinesLL());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pivots, pivotLines, pivotSel, pipeSel, hiddenPivotFields, hiddenPipeFields, canals, watercourses, pivotLabels, mm24, mmDes, hoursDay, imperial, phaseColors]);

  // Operazioni sul singolo pivot selezionato.
  const selPivot = pivotSel.mode === "single" && pivotSel.idx >= 0 ? pivots[pivotSel.idx] : null;
  function updateSelPivot(patch: Partial<PivotItem>) {
    if (pivotSel.mode !== "single") return;
    commitPivots(pivots.map((p, k) => (k === pivotSel.idx ? { ...p, ...patch } : p)));
  }
  function deleteSelPivot() {
    if (pivotSel.mode !== "single") return;
    commitPivots(pivots.filter((_, k) => k !== pivotSel.idx));
    setPivotSel({ mode: "group", idx: -1 });
  }
  function applyRadiusToAll() { commitPivots(pivots.map((p) => ({ ...p, r: pivotR }))); }

  // ---- livello Strade (linee) ----
  const rid = () => `r${roads.length}_${roads.reduce((s, r) => s + r.coords.length, 0)}`;
  useEffect(() => {
    const vis = roads.filter((r) => !r.hidden);
    mapApi.current?.showRoads?.(vis.map((r) => ({ coords: r.coords, width_m: r.width_m, kind: r.kind })), (i) => { const id = vis[i]?.id; if (id != null) setRoads((rs) => rs.filter((r) => r.id !== id)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roads]);
  // Aggiorna la banda-spessore dei canali quando cambia lo spessore di default.
  useEffect(() => {
    if (canals.length) renderCanals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canalWidth]);
  function drawRoad() {
    mapApi.current?.drawRoadManual((coords) => {
      if (coords.length >= 2) setRoads((rs) => [...rs, { id: rid(), coords, width_m: roadWidth }]);
    });
    setMsg(t("Traccia la strada sulla mappa: clic per i vertici, doppio clic per finire."));
  }
  async function importRoads(files?: FileList | null) {
    if (!files || !files.length) return;
    try {
      const add: { id: string; coords: number[][]; width_m: number }[] = [];
      for (const f of Array.from(files)) {
        const lines = await parseLinesFromFile(f);
        for (const ln of lines) if (ln.coords.length >= 2) add.push({ id: `imp${add.length}`, coords: ln.coords, width_m: roadWidth });
      }
      if (add.length) setRoads((rs) => [...rs, ...add]);
      setMsg(add.length ? t("Importate {n} strade da file.", { n: add.length }) : t("Nessuna linea trovata nei file (KMZ/KML/GeoJSON)."));
    } catch (e) { showErr(e); }
  }
  // Viabilità di servizio per i pivot del campo attivo (rigenera quella precedente).
  function genServiceRoads() {
    if (!active) return needField();
    const fid = active.id;
    const ctr = pivots.filter((p) => p.field === fid).map((p) => [p.lng, p.lat]);
    if (!ctr.length) { setMsg(t("Posa prima i pivot sul campo attivo.")); return; }
    const ext = roads.filter((r) => r.kind !== "service" && !r.hidden && r.coords.length >= 2).map((r) => r.coords);
    const res = serviceRoadsGrid(ctr, active.geom.coordinates[0], ext);
    if (res.err === "triangular") { setMsg(t("Con la disposizione triangolare non ci sono corridoi rettilinei tra i pivot: usa la disposizione quadrata per le strade di servizio.")); return; }
    const stamp = Date.now();
    const add: RoadL[] = res.segs.map((sg, i) => ({ id: `svc${stamp}_${i}`, coords: sg, width_m: roadWidth, owner: fid, kind: "service" }));
    setRoads((rs) => [...rs.filter((r) => !(r.kind === "service" && r.owner === fid)), ...add]);
    const km = add.reduce((sum, r) => sum + lineLenKm(r.coords), 0);
    setMsg(t("Strade di servizio: {n} tratti, {km}.", { n: add.length, km: uKm(km) }));
  }
  // Strade esistenti da OpenStreetMap nell'intorno del campo attivo (via Overpass).
  async function detectOsmRoads() {
    if (!active) return needField();
    const ring = active.geom.coordinates[0];
    const lons = ring.map((p) => p[0]), lats = ring.map((p) => p[1]);
    const m = 0.005;                                    // margine ~500 m
    const s0 = Math.min(...lats) - m, w0 = Math.min(...lons) - m, n0 = Math.max(...lats) + m, e0 = Math.max(...lons) + m;
    setBusy("osm"); setMsg(t("Ricerca strade OpenStreetMap…"));
    try {
      const q = `[out:json][timeout:25];way["highway"](${s0},${w0},${n0},${e0});out geom;`;
      const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      if (!r.ok) throw new Error(`OpenStreetMap ${r.status}`);
      const js = await r.json();
      const inBox = (p: number[]) => p[0] >= w0 && p[0] <= e0 && p[1] >= s0 && p[1] <= n0;
      const have = new Set(roads.map((x) => x.id));
      const add: RoadL[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const el of (js.elements || []) as any[]) {
        if (el.type !== "way" || !Array.isArray(el.geometry)) continue;
        const coords: number[][] = el.geometry.map((g: { lon: number; lat: number }) => [g.lon, g.lat]);
        // tieni solo i tratti dentro il riquadro: le strade lunghe non escono dall'area
        let cur: number[][] = []; let part = 0;
        const flush = () => { if (cur.length >= 2) { const id = `osm${el.id}_${part++}`; if (!have.has(id)) add.push({ id, coords: cur, width_m: OSM_ROAD_W[el.tags?.highway] ?? roadWidth, kind: "osm" }); } cur = []; };
        for (const p of coords) { if (inBox(p)) cur.push(p); else flush(); }
        flush();
      }
      if (!add.length) { setMsg(t("Nessuna strada OpenStreetMap in quest'area.")); return; }
      setRoads((rs) => [...rs, ...add]);
      setMsg(t("Strade OpenStreetMap trovate: {n}.", { n: add.length }));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function removeRoad(i: number) { setRoads((rs) => rs.filter((_, k) => k !== i)); }
  function setRoadWidthAt(i: number, w: number) { setRoads((rs) => rs.map((r, k) => (k === i ? { ...r, width_m: w } : r))); }
  function clearRoads() { setRoads([]); }
  // Ostacoli lineari preesistenti passati ai solutori: ognuno porta il PROPRIO
  // franco (clear_m), così le strade usano «Da strade» e i canali «Da canali/invasi».
  // I pivot ne evitano il footprint reale (spessore) più il franco.
  function obstacleLines() {
    // Corsi d'acqua rilevati (fiumi/alvei da DEM, canali esistenti, invasi/paludi):
    // l'alveo si evita con la SUA larghezza reale (mean_width_m) più il franco «Da canali/invasi».
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const waterItems = watercourses.filter((w) => !w.hidden).map((w: any) => (
      w.geojson.type === "LineString"
        ? { geojson: { type: "LineString", coordinates: w.geojson.coordinates }, width_m: (w.mean_width_m && w.mean_width_m > 0 ? w.mean_width_m : canalWidth), clear_m: pivClearWater }
        : { geojson: { type: "Polygon", coordinates: w.geojson.coordinates }, width_m: 0, clear_m: pivClearWater }
    ));
    const items = [
      ...roads.filter((r) => r.kind !== "service" && !r.hidden).map((r) => ({ geojson: { type: "LineString", coordinates: r.coords }, width_m: r.width_m, clear_m: pivClearRoad })),
      ...canals.map((c) => ({ geojson: { type: "LineString", coordinates: c.geojson.coordinates }, width_m: canalWidth, clear_m: pivClearWater })),
      ...waterItems,
    ];
    return items.length ? items : null;
  }

  async function designGuided() {
    if (!activeGeom) return needField();
    setBusy("guided"); setMsg("");
    try {
      const g = await api.fetchGuided(activeGeom, {
        target_permille: canalPermille, radius_m: pivotR, gap_m: 0,
        safety_m: safetyM, clear_road_m: pivClearRoad, clear_water_m: pivClearWater,
        per_side: perSide, conn_max_permille: 5, fill: fillEmpty,
        date: date || null, exclude_water: excludeWater,
        avoid: watercourses.length ? watercourses.map((w) => ({ kind: w.kind, geojson: w.geojson })) : null,
        roads: obstacleLines(),
      });
      setGuided(g);
      setModelFromGuided(g);
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function clearGuided() {
    setGuided(null); setPivots([]); setPivotLines([]); setPivotSel({ mode: "none", idx: -1 });
    mapApi.current?.clearLayout();
  }

  // ---- layout pivot (tutti i campi) ----
  function paramsFrom(s: Settings): LayoutParams {
    return {
      config: s.layoutCfg, radius_m: s.radius, gap_m: s.gap, transport: s.transport,
      slope_ideal_pct: s.slopeIdeal / 10, slope_max_pct: s.slopeMax / 10,  // ‰ → %
      auto_orient: s.orientMode === "auto",
      canal_azimuth_deg: s.orientMode === "manual" ? s.azimuth : null,
      canal_flip: s.canalFlip,
      only_suitable: s.onlySuitable, min_suitability: s.minSuit, date: date || null,
      overhang_pct: s.overhang, n_phases: s.nPhases, phase_order: s.phaseOrder,
      kc_peak: s.kc, efficiency: s.eff, hours_per_day: s.hours,
      dem: demModel, dem_smooth_m: demSmooth,
    };
  }
  async function genLayout() {
    if (!fields.length) return needField();
    setBusy("layout"); setMsg("");
    try {
      const arr = [...fields];
      const shown: { id: number; fc: GeoJSONFC }[] = [];
      for (let i = 0; i < arr.length; i++) {
        setMsg(t("Genero campo {i}/{n}…", { i: i + 1, n: arr.length }));
        const r = await api.fetchLayout(arr[i].geom, paramsFrom(effSettings(arr[i])));
        arr[i] = { ...arr[i], lay: r.meta, layGeo: r.geojson };
        shown.push({ id: arr[i].id, fc: r.geojson });
      }
      setFields(arr);
      mapApi.current?.showLayouts(shown);
      setMsg("");
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function clearLayout() {
    mapApi.current?.clearLayout();
    setFields((fs) => fs.map((f) => ({ ...f, lay: null, layGeo: null })));
  }
  // Layout a maglia UNIFICATO: usa i parametri condivisi (raggio, distanza tra
  // pivot) e alimenta la stessa gerarchia pivot modificabile del «lungo il canale».
  async function genLayoutUnified() {
    if (!fields.length) return needField();
    setBusy("layout"); setMsg("");
    try {
      const arr = [...fields];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const feats: any[] = [];
      for (let i = 0; i < arr.length; i++) {
        setMsg(t("Genero campo {i}/{n}…", { i: i + 1, n: arr.length }));
        const p: LayoutParams = { ...paramsFrom(effSettings(arr[i])), radius_m: pivotR, gap_m: safetyM, roads: obstacleLines(), clear_road_m: pivClearRoad };
        const r = await api.fetchLayout(arr[i].geom, p);
        arr[i] = { ...arr[i], lay: r.meta, layGeo: r.geojson };
        for (const ft of (r.geojson.features || [])) feats.push(ft);
      }
      const fc = { type: "FeatureCollection" as const, features: feats };
      const nPiv = arr.reduce((s, f) => s + (f.lay?.n_pivots || 0), 0);
      const netHa = arr.reduce((s, f) => s + (f.lay?.net_ha || 0), 0);
      const g: GuidedResult = { geojson: fc, meta: { n_pivots: nPiv, radius_m: pivotR, net_ha: Math.round(netHa * 10) / 10, safety_m: safetyM } };
      setFields(arr);
      setGuided(g); setModelFromGuided(g);
      setMsg("");
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  // Inserisci impianti SOLO sul poligono selezionato, accumulando i pivot degli
  // altri campi (ognuno è etichettato con il proprio field id, così ri-eseguire
  // su un campo sostituisce solo i suoi pivot e lascia intatti gli altri).
  // Applica al campo `fid` il risultato di un layout, sostituendo solo i suoi
  // pivot (accumula quelli degli altri campi). Condiviso da standard e avanzata.
  function applyLayoutResult(fid: number, r: api.LayoutResult, radiusM: number) {
    const { pivots: np } = pivotsFromFC(r.geojson, radiusM);
    const taggedP = np.map((x) => ({ ...x, field: fid }));
    const mergedP = [...pivots.filter((x) => x.field !== fid), ...taggedP];
    const mergedL = pivotLines.filter((x) => x.field !== fid);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layGeoNoLines = { type: "FeatureCollection" as const, features: (r.geojson.features || []).filter((ft: any) => ft.geometry?.type !== "LineString") };
    setFields((fs) => fs.map((f) => f.id === fid ? { ...f, lay: r.meta, layGeo: layGeoNoLines } : f));
    setPivots(mergedP); setPivotLines(mergedL); setPivotSel({ mode: "none", idx: -1 });
    const netHa = mergedP.reduce((s, x) => s + pvAreaM2(x) / 10000, 0);
    setGuided({ geojson: fcFromModel(mergedP, mergedL), meta: { n_pivots: mergedP.length, radius_m: radiusM, net_ha: Math.round(netHa * 10) / 10, safety_m: safetyM } });
    refreshUsage();
  }
  // STANDARD: raggio scelto dall'utente (+ eventuale % di pivot marginali).
  async function insertImpiantiActive() {
    if (!active) return needField();
    const fid = active.id;
    setBusy("layout"); setMsg("");
    try {
      const p: LayoutParams = { ...paramsFrom(effSettings(active)), radius_m: pivotR, gap_m: safetyM, roads: obstacleLines(), clear_road_m: pivClearRoad, min_pivot_pct: minPivotPct, fill_full: fillFull };
      const r = await api.fetchLayout(active.geom, p);
      applyLayoutResult(fid, r, pivotR);
      setMsg(t("Impianti inseriti su «{name}» ✓", { name: active.name }));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  // AVANZATA: dato un range [min,max], prova più raggi (uguali per tutti i pivot)
  // e tiene quello che copre la MAGGIOR superficie, rispettando ostacoli e franchi.
  async function insertAdvancedActive() {
    if (!active) return needField();
    const fid = active.id;
    const lo = Math.max(30, Math.min(advMinR, advMaxR));
    const hi = Math.min(1000, Math.max(advMinR, advMaxR));
    const N = 9;                                   // numero di raggi campionati nel range
    const step = Math.max(10, Math.round((hi - lo) / (N - 1)) || 10);
    const radii: number[] = [];
    for (let r = lo; r <= hi + 0.1; r += step) radii.push(Math.round(r));
    if (radii[radii.length - 1] !== hi) radii.push(hi);
    setBusy("layout"); setMsg("");
    try {
      let best: api.LayoutResult | null = null; let bestArea = -1; let bestR = lo;
      for (let i = 0; i < radii.length; i++) {
        const rad = radii[i];
        setMsg(t("Ottimizzo: raggio {r} m ({i}/{n})…", { r: rad, i: i + 1, n: radii.length }));
        const p: LayoutParams = { ...paramsFrom(effSettings(active)), radius_m: rad, gap_m: safetyM, roads: obstacleLines(), clear_road_m: pivClearRoad, min_pivot_pct: 100 };
        const res = await api.fetchLayout(active.geom, p);
        const { pivots: np } = pivotsFromFC(res.geojson, rad);
        const area = np.reduce((s, x) => s + pvAreaM2(x) / 10000, 0);
        if (area > bestArea) { bestArea = area; best = res; bestR = rad; }
      }
      if (!best) { setMsg(t("Nessun layout trovato nel range indicato.")); return; }
      setPivotR(bestR);
      applyLayoutResult(fid, best, bestR);
      setMsg(t("Ottimo: raggio {r} m, {a} coperti ✓", { r: bestR, a: uHa(Math.round(bestArea)) }));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  // Comando unico: instrada alla modalità scelta.
  function insertImpianti() { return designMode === "advanced" ? insertAdvancedActive() : insertImpiantiActive(); }
  function clearImpianti() {
    clearGuided();
    setFields((fs) => fs.map((f) => ({ ...f, lay: null, layGeo: null })));
  }

  // ---- Accessori: tubazioni di adduzione dal canale ---------------------------
  // Traccia le tubazioni che si diramano dal canale e passano per i centri dei
  // pivot ESISTENTI del poligono, una per fila, tutte nella stessa direzione.
  function generatePipes() {
    if (!active) return needField();
    if (!canals.length) { setMsg(t("Traccia prima un canale nella pagina Rilievo.")); return; }
    const fid = active.id;
    const fieldPivs = pivots.filter((p) => p.field === fid);
    if (!fieldPivs.length) { setMsg(t("Nessun pivot su questo poligono: inserisci prima gli impianti.")); return; }
    const canal = canals[Math.min(pipeCanalIdx, canals.length - 1)];
    const ring = active.geom?.coordinates?.[0] ?? null;   // le tubazioni restano dentro il campo
    const pipesLL = feederPipes(canal.geojson.coordinates, fieldPivs.map((p) => ({ lat: p.lat, lng: p.lng, r: p.r })), pipeMaxPerLine, ring);
    if (!pipesLL.length) { setMsg(t("Nessuna tubazione tracciabile con questi pivot.")); return; }
    const newL = pipesLL.map((coords) => ({ kind: "pipe", coords, field: fid }));
    const mergedL = [...pivotLines.filter((l) => !(l.kind === "pipe" && l.field === fid)), ...newL];
    setPivotLines(mergedL);
    if (guided) setGuided({ ...guided, geojson: fcFromModel(pivots, mergedL) });
    // Lunghezza totale della rete tracciata (utile per confrontare le soluzioni).
    const km = pipesLL.reduce((s, path) => {
      let L = 0;
      for (let i = 0; i < path.length - 1; i++) {
        const la = ((path[i][1] + path[i + 1][1]) / 2) * Math.PI / 180;
        const dx = (path[i + 1][0] - path[i][0]) * 111320 * Math.cos(la);
        const dy = (path[i + 1][1] - path[i][1]) * 111320;
        L += Math.hypot(dx, dy);
      }
      return s + L;
    }, 0) / 1000;
    setMsg(t("Tubazioni tracciate: {n} rami dal canale · {km} km ✓", { n: pipesLL.length, km: fmt(km, { maximumFractionDigits: 1 }) }));
  }
  // Linee d'acqua visibili (canali + corsi d'acqua lineari): servono al simbolo
  // della presa e al riaggancio automatico.
  function waterLinesLL(): number[][][] {
    return [...canals.filter((c) => !c.hidden).map((c) => c.geojson.coordinates as number[][]),
      ...watercourses.filter((w) => !w.hidden && w.geojson?.type === "LineString")
        .map((w) => w.geojson.coordinates as unknown as number[][])];
  }
  // Tubazioni che hanno acqua: toccano il canale, o toccano una che ce l'ha.
  // (L'alimentazione si propaga lungo la rete, esattamente come sulla mappa.)
  function fedPipeLines(exclude?: number): number[][][] {
    const lines = pivotLines.map((l, i) => ({ l, i })).filter((x) => x.l.kind === "pipe" && x.i !== exclude);
    if (!lines.length) return [];
    const lat0 = lines[0].l.coords[0]?.[1] ?? 0;
    const mLat = 111320, mLng = 111320 * Math.cos((lat0 * Math.PI) / 180) || 1e-9;
    const M = (q: number[]): [number, number] => [q[0] * mLng, q[1] * mLat];
    const dSeg = (p: [number, number], a: [number, number], b: [number, number]) => {
      const vx = b[0] - a[0], vy = b[1] - a[1]; const l2 = vx * vx + vy * vy || 1e-9;
      let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2; t = Math.max(0, Math.min(1, t));
      return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
    };
    const touch = (A: [number, number][], B: [number, number][]) => {
      for (const p of A) for (let i = 0; i < B.length - 1; i++) if (dSeg(p, B[i], B[i + 1]) < 15) return true;
      return false;
    };
    const wm = waterLinesLL().map((ln) => ln.map(M));
    const pm = lines.map((x) => x.l.coords.map(M));
    const fed = new Set<number>();
    pm.forEach((p, k) => { if (wm.some((w) => touch(p, w))) fed.add(k); });
    for (let pass = 0; pass < 8; pass++) {
      let grew = false;
      pm.forEach((p, k) => {
        if (fed.has(k)) return;
        for (const j of fed) if (touch(p, pm[j]) || touch(pm[j], p)) { fed.add(k); grew = true; return; }
      });
      if (!grew) break;
    }
    return [...fed].map((k) => lines[k].l.coords);
  }
  // Dopo una modifica la tubazione deve restare attaccata all'acqua: se nessun
  // suo punto tocca più il canale, l'estremità più vicina viene PROLUNGATA in
  // linea retta fino a incontrarlo, e lì nasce la nuova presa.
  function reattachToWater(coords: number[][], selfIdx?: number): number[][] {
    // Bersagli validi: il canale E le altre tubazioni già alimentate — se la
    // linea tocca una di quelle, l'acqua le arriva lo stesso.
    const W = [...waterLinesLL(), ...fedPipeLines(selfIdx)];
    if (!W.length || coords.length < 2) return coords;
    const lat0 = coords[0][1], mLat = 111320, mLng = 111320 * Math.cos((lat0 * Math.PI) / 180) || 1e-9;
    const M = (q: number[]): [number, number] => [q[0] * mLng, q[1] * mLat];
    const Wm = W.map((ln) => ln.map(M));
    const dSeg = (p: [number, number], a: [number, number], b: [number, number]) => {
      const vx = b[0] - a[0], vy = b[1] - a[1]; const l2 = vx * vx + vy * vy || 1e-9;
      let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2; t = Math.max(0, Math.min(1, t));
      return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
    };
    const distW = (q: number[]) => {
      const m2 = M(q); let d = Infinity;
      for (const ln of Wm) for (let i = 0; i < ln.length - 1; i++) d = Math.min(d, dSeg(m2, ln[i], ln[i + 1]));
      return d;
    };
    if (coords.some((q) => distW(q) < 6)) return coords;      // tocca ancora l'acqua
    // prolunga l'estremità più vicina lungo la propria direzione
    const tryEnd = (endIdx: number, prevIdx: number) => {
      const A = M(coords[endIdx]), B = M(coords[prevIdx]);
      const vx = A[0] - B[0], vy = A[1] - B[1]; const L = Math.hypot(vx, vy) || 1;
      const far: [number, number] = [A[0] + (vx / L) * 20000, A[1] + (vy / L) * 20000];
      let best: [number, number] | null = null, bd = Infinity;
      for (const ln of Wm) for (let i = 0; i < ln.length - 1; i++) {
        const c = ln[i], d = ln[i + 1];
        const rx = far[0] - A[0], ry = far[1] - A[1], sx = d[0] - c[0], sy = d[1] - c[1];
        const den = rx * sy - ry * sx; if (Math.abs(den) < 1e-9) continue;
        const t = ((c[0] - A[0]) * sy - (c[1] - A[1]) * sx) / den;
        const u = ((c[0] - A[0]) * ry - (c[1] - A[1]) * rx) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        const P2: [number, number] = [A[0] + rx * t, A[1] + ry * t];
        const dd = Math.hypot(P2[0] - A[0], P2[1] - A[1]);
        if (dd < bd) { bd = dd; best = P2; }
      }
      return best ? { p: [best[0] / mLng, best[1] / mLat], d: bd } : null;
    };
    const a = tryEnd(0, 1), b = tryEnd(coords.length - 1, coords.length - 2);
    if (a && (!b || a.d <= b.d)) return [a.p, ...coords];
    if (b) return [...coords, b.p];
    return coords;
  }
  // Chiave di confronto fra centro pivot e vertice di tubazione (6 decimali ≈ 10 cm).
  const pKey = (p: { lat: number; lng: number }) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;
  function fedPivotKeys(lines: { kind: string; coords: number[][] }[]) {
    const s2 = new Set<string>();
    for (const l of lines) if (l.kind === "pipe") for (const q of l.coords) s2.add(`${q[0].toFixed(6)},${q[1].toFixed(6)}`);
    return s2;
  }
  // Collega il pivot selezionato alla tubazione più vicina a SINISTRA o a DESTRA
  // con un RAMO dedicato: un tratto nuovo dal centro del pivot fino alla
  // tubazione esistente, che resta com'è. Non si deforma la linea esistente
  // facendola passare per il pivot.
  // Portata di UN pivot: 1 mm su 1 m² = 1 litro, quindi basta l'area del cerchio.
  const pivotFlow = (pv: { r: number; q?: number }) => {
    if (pv.q && pv.q > 0) return pv.q;                       // valore imposto a mano
    const area = pvAreaM2(pv);                      // m²
    return (area * mmDes) / (Math.max(1, hoursDay) * 3600);  // l/s (fabbisogno lordo di progetto)
  };
  // ---- Intensità all'ESTREMITÀ del pivot -----------------------------------
  // È lì che si decide il ruscellamento: l'ultima torre percorre 2πR a ogni
  // giro, quindi la striscia bagnata passa velocissima e tutta l'acqua del giro
  // cade in pochi minuti. Non conta la media sulle 24 h ma l'INTENSITÀ
  // ISTANTANEA DI PICCO, che dipende dalla forma del profilo di bagnatura:
  // rettangolare 1,00 · ellittica 4/π ≈ 1,27 · triangolare 2,00.
  const PATTERN: Record<string, number> = { rettangolare: 1, ellittica: 4 / Math.PI, triangolare: 2 };
  const depthPass = (): number => mm24 / Math.max(1, turnsDay);                    // mm distribuiti in un giro
  const turnHours = (): number => Math.max(0.05, hoursDay / Math.max(1, turnsDay));  // durata di un giro (h)
  // Tempo di bagnatura di un punto al raggio r: la striscia larga wetW passa
  // mentre la torre percorre l'arco 2πr nel tempo di un giro.
  const wetHours = (r: number) => (Math.max(1, wetW) * turnHours()) / (2 * Math.PI * Math.max(1, r));
  const rimAvg = (r: number) => depthPass() / wetHours(r);                 // mm/h medi sulla striscia
  const rimPeak = (r: number) => rimAvg(r) * (PATTERN[pattern] ?? 1.27);   // mm/h di picco
  // Ruscellamento: durante il passaggio il terreno assorbe soak×t e la superficie
  // ne trattiene un po' (invaso superficiale). Se l'acqua del giro supera i due,
  // il resto scorre via.
  const runoffMm = (r: number) => Math.max(0, depthPass() - (infiltration * wetHours(r) + surfStore));
  // Giri/giorno minimi perché non ci sia ruscellamento al bordo esterno.
  const turnsNeeded = (r: number) => {
    for (let n = 1; n <= 24; n++) {
      const d = mm24 / n, th = Math.max(0.05, hoursDay / n);
      const tw = (Math.max(1, wetW) * th) / (2 * Math.PI * Math.max(1, r));
      if (d <= infiltration * tw + surfStore) return n;
    }
    return 0;
  };
  // Pressione richiesta al centro del pivot: irrigatori + perdita nella condotta
  // del pivot (Hazen-Williams con fattore 0,36 per le uscite multiple).
  // Listino campate per diametro (indice tubo Ceres: 0 = 10", 1 = 8"5/8, 2 = 6"5/8)
  // e sbracci per produttore. Zimmatic: nessun listino → si passa solo il raggio.
  const SPAN_LIST: Record<PivotBrand, { d10: number[]; d8: number[]; d6: number[]; oh: number[] } | null> = {
    starpivot: { d10: [42.3], d8: [54.0, 48.1, 42.3], d6: [59.8, 54.0, 48.1, 42.3], oh: [5.9, 11.7, 17.6, 23.4] },
    reinke: { d10: [41.8, 36.0], d8: [53.3, 47.5, 41.8, 36.0], d6: [62.2, 59.1, 53.3, 47.5, 41.8, 36.0], oh: [0] },
    valley: { d10: [42.7, 41.1, 35.1], d8: [54.9, 48.8, 42.7, 41.1, 35.1], d6: [68.6, 62.5, 57.0, 54.9, 48.8, 42.7, 41.1, 35.1], oh: [0] },
    rkd: { d10: [41.7, 35.8], d8: [53.5, 47.6, 41.7, 35.8], d6: [65.3, 59.4, 53.5, 47.6, 41.7, 35.8], oh: [0] },
    zimmatic: null,
  };
  // Diametri interni dei tubi delle campate (m) per il controllo della velocità.
  const SPAN_ID = [0.2474, 0.2135, 0.1628];
  type Span = { pipe: number; len: number };
  type Comp = { spans: Span[]; oh: number; total: number };
  // Campate da 6"5/8 per coprire esattamente S: minimo di scarto (m) + 2,5 per
  // campata + 0,5 per lunghezza diversa (al più 3 lunghezze diverse).
  function fillSpans(S: number, lens: number[]): { lens: number[]; tot: number; cost: number } | null {
    if (S <= 1) return { lens: [], tot: 0, cost: Math.abs(S) };
    const mx = Math.max(...lens), mn = Math.min(...lens);
    let best: { lens: number[]; tot: number; cost: number } | null = null;
    for (let n = Math.max(1, Math.floor(S / mx)); n <= Math.ceil(S / mn); n++)
      for (let i1 = 0; i1 < lens.length; i1++) for (let i2 = i1; i2 < lens.length; i2++) for (let i3 = i2; i3 < lens.length; i3++)
        for (let a = 0; a <= n; a++) for (let b = 0; a + b <= n; b++) {
          const c = n - a - b;
          if ((i2 === i1 && b) || (i3 === i2 && c)) continue;
          const tot = a * lens[i1] + b * lens[i2] + c * lens[i3];
          const kinds = (a ? 1 : 0) + (b ? 1 : 0) + (c ? 1 : 0);
          const cost = Math.abs(tot - S) + 2.5 * n + 0.5 * kinds;
          if (!best || cost < best.cost) best = { lens: [...Array(a).fill(lens[i1]), ...Array(b).fill(lens[i2]), ...Array(c).fill(lens[i3])].sort((x, y) => y - x), tot, cost };
        }
    return best;
  }
  // Composizione con i DIAMETRI: dal centro la portata che resta nel tubo è
  // Q·(1 − (x/Rb)²) (Rb = raggio bagnato, con l'irrigatore finale); ogni campata
  // prende il tubo più piccolo con velocità ≤ vMax all'ingresso. Prima i 10",
  // poi gli 8"5/8 (campate più lunghe del listino), il resto in 6"5/8.
  const spanMemo = useRef(new Map<string, Comp | null>());
  // linear = macchina lineare alimentata in testa: la portata cala linearmente, Q·(1 − x/L).
  function spanComposition(pv: { r: number; gun?: number; q?: number; deg?: number }, brand: PivotBrand, linear = false): Comp | null {
    const Q = pivotFlow(pv) / 1000, R = Math.round(pv.r);
    const mk = `${brand}|${R}|${Math.round((pv.gun ?? 0))}|${Q.toFixed(4)}|${spanVmax}|${linear ? 1 : 0}`;
    if (spanMemo.current.has(mk)) return spanMemo.current.get(mk)!;
    const L = SPAN_LIST[brand];
    let res: Comp | null = null;
    if (L) {
      const Rb = R + Math.max(0, pv.gun ?? 0);
      const cap = SPAN_ID.map((d) => spanVmax * Math.PI * d * d / 4);              // m³/s per diametro
      const xNeed = (c: number) => (Q > c ? (linear ? Rb * (1 - c / Q) : Rb * Math.sqrt(1 - c / Q)) : 0);   // fin dove serve il tubo più grande
      const x10 = xNeed(cap[1]), x8 = xNeed(cap[2]);
      let best: (Comp & { cost: number }) | null = null;
      for (const oh of L.oh) for (const l10 of L.d10) for (const l8 of L.d8) {
        const spans: Span[] = []; let pos = 0;
        while (pos < x10 && pos + oh < R - 1) { spans.push({ pipe: 0, len: l10 }); pos += l10; }
        while (pos < x8 && pos + oh < R - 1) { spans.push({ pipe: 1, len: l8 }); pos += l8; }
        const rest = fillSpans(R - oh - pos, L.d6); if (!rest) continue;
        const tot = pos + rest.tot + oh;
        const cost = Math.abs(tot - R) + 2.5 * (spans.length + rest.lens.length) + 0.5 * new Set(spans.map((x) => x.len)).size + (rest.cost - Math.abs(R - oh - pos - rest.tot) - 2.5 * rest.lens.length);
        if (!best || cost < best.cost) best = { spans: [...spans, ...rest.lens.map((len) => ({ pipe: 2, len }))], oh, total: tot, cost };
      }
      if (best) res = { spans: best.spans, oh: best.oh, total: best.total };
    }
    spanMemo.current.set(mk, res);
    return res;
  }
  // Pressione all'ingresso del pivot: irrigatori + perdite nelle campate (con i
  // diametri veri del listino e la portata che cala lungo la macchina) + punto
  // pivot (gomiti, valvola, giunto). Senza listino (Zimmatic): una condotta
  // unica di diametro latDN con il fattore 0,36 delle uscite distribuite.
  function pivotPressureParts(pv: { r: number; q?: number; p?: number; gun?: number; deg?: number }) {
    const Q = pivotFlow(pv) / 1000;                          // m³/s
    let hf = 0, how: "spans" | "single" = "single";
    const c = spanComposition(pv, pivotBrand);
    if (c && Q > 0) {
      const Rb = pv.r + Math.max(0, pv.gun ?? 0);
      let x = 0; how = "spans";
      for (const sp of c.spans) {
        const xm = x + sp.len / 2, q = Q * Math.max(0, 1 - (xm / Rb) ** 2);
        const D = SPAN_ID[sp.pipe];
        hf += (10.67 * sp.len * Math.pow(q, 1.852)) / (Math.pow(130, 1.852) * Math.pow(D, 4.87));
        x += sp.len;
      }
    } else if (Q > 0) {
      const D = latDN / 1000;
      hf = 0.36 * (10.67 * pv.r * Math.pow(Q, 1.852)) / (Math.pow(130, 1.852) * Math.pow(D, 4.87));
    }
    const spansBar = hf / 10.2;
    return { sprink: sprinkBar, spans: spansBar, point: Math.max(0, pivotPointBar), total: sprinkBar + spansBar + Math.max(0, pivotPointBar), how };
  }
  const pivotPressure = (pv: { r: number; q?: number; p?: number; gun?: number; deg?: number }) => {
    if (pv.p && pv.p > 0) return pv.p;
    return pivotPressureParts(pv).total;                     // bar
  };

  // ---- IDRAULICA: diametri delle tubazioni --------------------------------
  // Ogni pivot chiede una portata; la portata di un tratto è la somma di quelle
  // dei pivot che stanno a valle. Dal diametro minimo che rispetta la velocità
  // massima si sale al primo diametro commerciale disponibile.
  const DN_LIST = [110, 125, 140, 160, 180, 200, 225, 250, 280, 315, 355, 400, 450, 500, 560, 630, 710, 800, 900, 1000];
  function computeHydraulics(apply: boolean, elev?: Map<string, number> | null) {
    const pipes = pivotLines.map((l, i) => ({ l, i })).filter((x) => x.l.kind === "pipe");
    if (!pipes.length) { setMsg(t("Nessuna tubazione da dimensionare.")); return null; }
    const lat0 = pipes[0].l.coords[0]?.[1] ?? 0;
    const mLat = 111320, mLng = 111320 * Math.cos((lat0 * Math.PI) / 180) || 1e-9;
    const key = (q: number[]) => `${q[0].toFixed(5)},${q[1].toFixed(5)}`;
    // grafo: nodi = vertici delle tubazioni, archi = tratti
    type Edge = { a: string; b: string; pipe: number; seg: number; len: number };
    const edges: Edge[] = [];
    const adj = new Map<string, number[]>();
    const posOf = new Map<string, number[]>();
    for (const { l, i } of pipes) {
      for (let k = 0; k < l.coords.length - 1; k++) {
        const A = l.coords[k], B = l.coords[k + 1];
        const ka = key(A), kb = key(B);
        posOf.set(ka, A); posOf.set(kb, B);
        const len = Math.hypot((B[0] - A[0]) * mLng, (B[1] - A[1]) * mLat);
        const e = edges.length;
        edges.push({ a: ka, b: kb, pipe: i, seg: k, len });
        (adj.get(ka) ?? adj.set(ka, []).get(ka))!.push(e);
        (adj.get(kb) ?? adj.set(kb, []).get(kb))!.push(e);
      }
    }
    // domande: la portata di ogni pivot cade sul nodo del suo centro
    const demand = new Map<string, number>();
    let unserved = 0;
    for (const pv of pivots) {
      const k = key([pv.lng, pv.lat]);
      if (!posOf.has(k)) { unserved++; continue; }
      demand.set(k, (demand.get(k) || 0) + pivotFlow(pv));
    }
    // sorgenti: nodi che stanno sull'acqua
    const W = waterLinesLL().map((ln) => ln.map((q) => [q[0] * mLng, q[1] * mLat] as [number, number]));
    const dSeg = (p: [number, number], a: [number, number], b: [number, number]) => {
      const vx = b[0] - a[0], vy = b[1] - a[1]; const l2 = vx * vx + vy * vy || 1e-9;
      let tt = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2; tt = Math.max(0, Math.min(1, tt));
      return Math.hypot(p[0] - (a[0] + vx * tt), p[1] - (a[1] + vy * tt));
    };
    const sources: string[] = [];
    for (const [k, q] of posOf) {
      const m2: [number, number] = [q[0] * mLng, q[1] * mLat];
      let on = false;
      for (const w of W) { for (let i = 0; i < w.length - 1; i++) if (dSeg(m2, w[i], w[i + 1]) < 15) { on = true; break; } if (on) break; }
      if (on) sources.push(k);
    }
    if (!sources.length) { setMsg(t("Nessuna presa sul canale: collega almeno una tubazione all'acqua.")); return null; }
    // albero di percorrenza dalle sorgenti (BFS): ogni arco viene orientato
    const parentEdge = new Map<string, number>();
    const order: string[] = [];
    const seen = new Set<string>(sources);
    const queue = [...sources];
    while (queue.length) {
      const u = queue.shift() as string; order.push(u);
      for (const ei of adj.get(u) ?? []) {
        const e = edges[ei]; const v = e.a === u ? e.b : e.a;
        if (seen.has(v)) continue;
        seen.add(v); parentEdge.set(v, ei); queue.push(v);
      }
    }
    // portata di ogni arco = somma delle domande a valle (dalle foglie a monte)
    const flow = new Array(edges.length).fill(0);
    const acc = new Map<string, number>();
    for (let i = order.length - 1; i >= 0; i--) {
      const u = order[i];
      const own = (demand.get(u) || 0) + (acc.get(u) || 0);
      const pe = parentEdge.get(u);
      if (pe != null) {
        flow[pe] += own;
        const e = edges[pe]; const par = e.a === u ? e.b : e.a;
        acc.set(par, (acc.get(par) || 0) + own);
      }
    }
    // diametro commerciale + perdite di carico (Hazen-Williams)
    const dnOf = new Map<number, number[]>(), qsOf = new Map<number, number[]>();
    const byDn = new Map<number, number>();
    let hlMax = 0, isolated = 0;
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      const Q = flow[ei];                       // l/s
      if (Q <= 0) isolated++;
      const need = Math.sqrt((4 * (Q / 1000)) / (Math.PI * vMax)) * 1000;   // mm
      const dn = DN_LIST.find((d) => d >= need) ?? DN_LIST[DN_LIST.length - 1];
      const D = dn / 1000;
      const hf = Q > 0 ? (10.67 * e.len * Math.pow(Q / 1000, 1.852)) / (Math.pow(hwC, 1.852) * Math.pow(D, 4.87)) : 0;
      hlMax = Math.max(hlMax, hf);
      const da = dnOf.get(e.pipe) ?? []; da[e.seg] = dn; dnOf.set(e.pipe, da);
      const qa = qsOf.get(e.pipe) ?? []; qa[e.seg] = Math.round(Q * 10) / 10; qsOf.set(e.pipe, qa);
      byDn.set(dn, (byDn.get(dn) || 0) + e.len);
    }
    // Prevalenza richiesta a ogni presa: si risale dal pivot più esigente
    // sommando perdite di carico e dislivello fino alla sua presa.
    const headAt = new Map<string, number>();     // metri d'acqua richiesti a un nodo
    const lossOf = new Map<number, number>();     // perdita di ogni arco
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei]; const Q = flow[ei];
      const dn = (dnOf.get(e.pipe) ?? [])[e.seg] ?? DN_LIST[0];
      lossOf.set(ei, Q > 0 ? (10.67 * e.len * Math.pow(Q / 1000, 1.852)) / (Math.pow(hwC, 1.852) * Math.pow(dn / 1000, 4.87)) : 0);
    }
    const zOf = (k: string) => (elev ? (elev.get(k) ?? 0) : 0);
    const needAt = new Map<string, number>();
    for (const pv of pivots) {
      const k = key([pv.lng, pv.lat]);
      if (!posOf.has(k)) continue;
      needAt.set(k, Math.max(needAt.get(k) ?? 0, pivotPressure(pv) * 10.2 + zOf(k)));   // m d'acqua + quota
    }
    // dai nodi verso la sorgente: ogni arco aggiunge la sua perdita
    for (let i = order.length - 1; i >= 0; i--) {
      const u = order[i];
      const pe = parentEdge.get(u); if (pe == null) continue;
      const need = needAt.get(u); if (need == null) continue;
      const e = edges[pe]; const par = e.a === u ? e.b : e.a;
      const up = need + (lossOf.get(pe) ?? 0);
      needAt.set(par, Math.max(needAt.get(par) ?? 0, up));
    }
    for (const k of sources) headAt.set(k, Math.max(0, (needAt.get(k) ?? 0) - zOf(k)));
    const headMax = sources.reduce((m2, k) => Math.max(m2, headAt.get(k) ?? 0), 0);
    const totalQ = sources.reduce((s2, k) => {
      let q = 0;
      for (const ei of adj.get(k) ?? []) { const e = edges[ei]; if (parentEdge.get(e.a === k ? e.b : e.a) === ei) q += flow[ei]; }
      return s2 + q;
    }, 0);
    if (apply) {
      const next = pivotLines.map((l, i) => (l.kind === "pipe" ? { ...l, dn: dnOf.get(i), qs: qsOf.get(i) } : l));
      setPivotLines(next);
      setGuided((gp) => (gp ? { ...gp, geojson: fcFromModel(pivots, next) } : gp));
    }
    return { byDn: [...byDn.entries()].sort((a, b) => a[0] - b[0]), totalQ, hlMax, unserved, isolated, nSources: sources.length,
      headMax, withElev: !!elev };
  }
  const [hydra, setHydra] = useState<null | { byDn: [number, number][]; totalQ: number; hlMax: number; unserved: number; isolated: number; nSources: number; headMax: number; withElev: boolean }>(null);
  async function runHydraulics() {
    // Quote del terreno: servono per la prevalenza vera alla presa (un pivot in
    // quota costa metri d'acqua tanto quanto le perdite di carico).
    let elev: Map<string, number> | null = null;
    const pts: number[][] = pivots.map((p) => [p.lng, p.lat]);
    const taps: number[][] = [];
    for (const l of pivotLines) if (l.kind === "pipe" && l.coords.length) taps.push(l.coords[0]);
    try {
      setBusy("hydra");
      const res = await api.fetchElevation([...pts, ...taps]);
      elev = new Map();
      res.points.forEach((q, i) => {
        const src = i < pts.length ? pts[i] : taps[i - pts.length];
        if (q.elev_m != null) elev!.set(`${src[0].toFixed(5)},${src[1].toFixed(5)}`, q.elev_m);
      });
    } catch { elev = null; } finally { setBusy(""); }
    const r = computeHydraulics(true, elev);
    setHydra(r);
    if (r) setMsg(t("Diametri calcolati ✓ portata totale {q} l/s su {n} prese", { q: Math.round(r.totalQ), n: r.nSources }));
  }

  // Quale pivot collegare: quello selezionato se c'è, altrimenti il pivot NON
  // alimentato più vicino al centro della vista — così il comando è a portata di
  // mano anche mentre stai lavorando su una tubazione, senza cambiare selezione.
  function pivotToConnect(): { pv: PivotItem; idx: number } | null {
    if (pivotSel.mode === "single" && pivots[pivotSel.idx]) return { pv: pivots[pivotSel.idx], idx: pivotSel.idx };
    const c = mapApi.current?.getCenter?.(); if (!c) return null;
    const fed = fedPivotKeys(pivotLines);
    let best: { pv: PivotItem; idx: number } | null = null, bd = Infinity;
    pivots.forEach((p, i) => {
      if (fed.has(pKey(p))) return;
      if (hiddenPivotFields.has(p.field ?? -1)) return;
      const d = Math.hypot(p.lng - c[0], p.lat - c[1]);
      if (d < bd) { bd = d; best = { pv: p, idx: i }; }
    });
    return best;
  }
  function connectSelPivot(side: "left" | "right") {
    const target = pivotToConnect(); if (!target) return;
    const pv = target.pv;
    const mLat = 111320, mLng = 111320 * Math.cos((pv.lat * Math.PI) / 180) || 1e-9;
    const M = (q: number[]): [number, number] => [q[0] * mLng, q[1] * mLat];
    const A = M([pv.lng, pv.lat]);
    let best: { p: [number, number]; d: number } | null = null;
    pivotLines.forEach((l) => {
      if (l.kind !== "pipe") return;
      if (l.field != null && hiddenPipeFields.has(l.field)) return;
      const pm = l.coords.map(M);
      // da che parte sta la tubazione: si guarda il suo punto più vicino
      let nx = pm[0], nd = Infinity;
      for (const q of pm) { const d = Math.hypot(q[0] - A[0], q[1] - A[1]); if (d < nd) { nd = d; nx = q; } }
      if ((side === "left") !== (nx[0] < A[0])) return;
      // punto di innesto: il più vicino sulla linea, ma se c'è un VERTICE quasi
      // altrettanto vicino si preferisce quello — è un nodo reale della rete.
      let foot: [number, number] | null = null, fd = Infinity;
      for (let i = 0; i < pm.length - 1; i++) {
        const a = pm[i], b = pm[i + 1];
        const vx = b[0] - a[0], vy = b[1] - a[1]; const l2 = vx * vx + vy * vy || 1e-9;
        let t = ((A[0] - a[0]) * vx + (A[1] - a[1]) * vy) / l2; t = Math.max(0, Math.min(1, t));
        const q: [number, number] = [a[0] + vx * t, a[1] + vy * t];
        const d = Math.hypot(q[0] - A[0], q[1] - A[1]);
        if (d < fd) { fd = d; foot = q; }
      }
      const pick: [number, number] = (nd <= 1.15 * fd || !foot) ? nx : foot;
      const pd = Math.hypot(pick[0] - A[0], pick[1] - A[1]);
      if (!best || pd < best.d) best = { p: pick, d: pd };
    });
    if (!best) { setMsg(side === "left" ? t("Nessuna tubazione a sinistra di questo pivot.") : t("Nessuna tubazione a destra di questo pivot.")); return; }
    const b2 = best as { p: [number, number]; d: number };
    const branch = { kind: "pipe", coords: [[b2.p[0] / mLng, b2.p[1] / mLat], [pv.lng, pv.lat]], field: pv.field };
    const next = [...pivotLines, branch];
    setPivotLines(next);
    setGuided((gp) => (gp ? { ...gp, geojson: fcFromModel(pivots, next) } : gp));
    setMsg(t("Pivot collegato alla tubazione ✓ (+{m} m)", { m: Math.round(b2.d) }));
  }
  // Disegna a mano una NUOVA tubazione: i punti cliccati si agganciano ai centri
  // dei pivot e al canale, quindi nasce già collegata come quelle calcolate.
  function drawPipeManual(mode: "new" | "branch" = "new") {
    if (!active) return needField();
    const fid = active.id;
    setMsg(mode === "branch"
      ? t("Clicca il punto di stacco su una tubazione esistente, poi i punti del ramo. Doppio clic per chiudere.")
      : t("Clicca i punti della tubazione: si agganciano ai centri dei pivot e al canale. Doppio clic per chiudere."));
    mapApi.current?.drawPipeManual?.((coords) => {
      if (coords.length < 2) { setMsg(""); return; }
      const next = [...pivotLines, { kind: "pipe", coords, field: fid }];
      setPivotLines(next);
      setGuided((gp) => (gp ? { ...gp, geojson: fcFromModel(pivots, next) } : gp));
      setPipeSel({ mode: "group", idx: -1 });
      setMsg(t("Tubazione aggiunta ✓"));
    }, pivots.map((pv) => [pv.lng, pv.lat]),
    [...canals.filter((c) => !c.hidden).map((c) => c.geojson.coordinates as number[][]),
     ...watercourses.filter((w) => !w.hidden && w.geojson?.type === "LineString")
       .map((w) => w.geojson.coordinates as unknown as number[][]),
     // per un RAMO anche le tubazioni esistenti sono bersaglio di aggancio:
     // lo stacco cade esattamente sulla linea da cui deriva
     ...(mode === "branch" ? pivotLines.filter((l) => l.kind === "pipe").map((l) => l.coords) : [])]);
  }
  // Elimina la SINGOLA tubazione selezionata (le altre restano).
  function deleteSelectedPipe() {
    if (pipeSel.mode !== "single") return;
    const visL = pivotLines.filter((l) => !(l.kind === "pipe" && l.field != null && hiddenPipeFields.has(l.field)));
    const target = pivotLines.indexOf(visL[pipeSel.idx]);
    if (target < 0) return;
    const next = pivotLines.filter((_, k) => k !== target);
    setPivotLines(next);
    setGuided((gp) => (gp ? { ...gp, geojson: fcFromModel(pivots, next) } : gp));
    editPipeRef.current = null; mapApi.current?.endPipeEdit?.();
    setPipeSel({ mode: "group", idx: -1 });
    setMsg(t("Tubazione eliminata ✓"));
  }
  // Rimuove le tubazioni di adduzione del poligono attivo (i pivot restano).
  function removePipes() {
    const fid = active?.id;
    const keepL = pivotLines.filter((l) => !(l.kind === "pipe" && (fid == null || l.field === fid)));
    setPivotLines(keepL);
    if (guided) setGuided({ ...guided, geojson: fcFromModel(pivots, keepL) });
  }
  const nPipes = pivotLines.filter((l) => l.kind === "pipe" && (!active || l.field === active.id)).length;
  // Parametri specifici della disposizione «a maglia» (raggio e distanza tra pivot
  // restano quelli condivisi in alto).
  function renderMeshParams() {
    return (
      <div className="mt-1">
        <label className="text-xs text-sage-dark mt-1 block">{t("Trasporto acqua")}</label>
        <select className="field-input mt-1" value={cur.transport}
          onChange={(e) => { const tp = e.target.value as Transport; patch({ transport: tp, slopeIdeal: SLOPE_PM[tp].ideal, slopeMax: SLOPE_PM[tp].max }); }}>
          <option value="buried">{t("Tubazioni interrate (pressione)")}</option>
          <option value="canal">{t("Canali (gravità)")}</option>
        </select>
        <p className="text-[11px] text-sage-dark mt-1">
          {cur.transport === "canal"
            ? t("Con i canali il vincolo di pendenza è severo (max {p}‰): serve terreno pianeggiante.", { p: 5 })
            : t("Con tubazioni in pressione la pendenza tollerata è maggiore (max {p}‰).", { p: 70 })}
        </p>

        <div className="text-xs text-sage-dark mt-2 flex items-center gap-1.5">
          {t("Orientamento reticolo")}
          <FieldHelp text={t("Auto: il reticolo si allinea da solo al bordo più lungo del poligono, che di norma è la direzione in cui i pivot rendono di più. Manuale: imponi tu la direzione con l'azimut, utile quando il reticolo deve seguire un canale, una strada o un confine catastale invece della forma del campo.")} />
        </div>
        <div className="seg mt-1">
          <div className="seg-item" data-active={cur.orientMode === "auto"} onClick={() => patch({ orientMode: "auto" })}>{t("Auto (bordo più lungo)")}</div>
          <div className="seg-item" data-active={cur.orientMode === "manual"} onClick={() => patch({ orientMode: "manual" })}>{t("Manuale (azimut)")}</div>
        </div>
        {cur.orientMode === "manual" && (
          <label className="text-xs text-sage-dark mt-1 block">{t("Azimut canale (°)")}
            <input type="number" min={-360} max={360} step={1} value={cur.azimuth}
              onChange={(e) => patch({ azimuth: Number(e.target.value) })} className="field-input mt-1" /></label>
        )}
        <label className="flex items-center gap-2 text-xs text-sage-dark mt-2">
          <input type="checkbox" checked={cur.canalFlip} onChange={(e) => patch({ canalFlip: e.target.checked })} />
          {t("Canale sul bordo opposto")}
        </label>
        <label className="flex items-center gap-2 text-xs text-sage-dark mt-1">
          <input type="checkbox" checked={cur.onlySuitable} onChange={(e) => patch({ onlySuitable: e.target.checked })} />
          {t("Solo su aree idonee (M2)")}
        </label>
        {cur.onlySuitable && (
          <div className="text-[11px] text-sage-dark mt-1">
            {t("Soglia idoneità")}: {cur.minSuit}/100
            <input type="range" min={40} max={90} step={5} value={cur.minSuit}
              onChange={(e) => patch({ minSuit: Number(e.target.value) })} className="w-full accent-brand" />
            {!date && <span className="text-danger">{t("Cerca e scegli prima una data.")}</span>}
          </div>
        )}

        {/* Sbordo consentito + Fasi di sviluppo sulla stessa riga (compatto) */}
        <div className="flex gap-2 mt-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-sage-dark">{t("Sbordo consentito")}: {cur.overhang}%</label>
            <input type="range" min={0} max={30} step={5} value={cur.overhang}
              onChange={(e) => patch({ overhang: Number(e.target.value) })} className="w-full accent-brand mt-1" />
          </div>
          <label className="text-xs text-sage-dark flex-1">{t("Fasi di sviluppo")}
            <select className="field-input mt-1" value={cur.nPhases} onChange={(e) => patch({ nPhases: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        {cur.nPhases > 1 && (
          <label className="text-xs text-sage-dark block mt-1">{t("Ordine fasi")}
            <select className="field-input mt-1 w-full" value={cur.phaseOrder} onChange={(e) => patch({ phaseOrder: e.target.value as PhaseOrder })}>
              <option value="canal_distance">{t("Vicinanza al canale")}</option>
              <option value="suitability">{t("Idoneità")}</option>
              <option value="rows">{t("Per file")}</option>
            </select>
          </label>
        )}
      </div>
    );
  }

  // Aggregato del layout su tutti i campi.
  const laid = fields.filter((f) => f.lay);
  const agg = useMemo(() => {
    const L = laid.map((f) => f.lay!);
    return {
      count: laid.length,
      pivots: L.reduce((s, l) => s + l.n_pivots, 0),
      net: L.reduce((s, l) => s + l.net_ha, 0),
      q: L.reduce((s, l) => s + l.water.q_total_ls, 0),
      pipe: L.reduce((s, l) => s + l.network_total_m, 0),
    };
  }, [laid]);

  // ---- export ----
  function saveBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const pdfLangTouched = useRef(false);
  useEffect(() => { if (!pdfLangTouched.current) setPdfLang(lang); }, [lang]);

  // Storico delle revisioni: vive sul server, quindi resta anche cambiando
  // computer o browser. Si ricarica quando cambia il progetto.
  const loadRevs = useCallback(async () => {
    if (!projectId) { setRevs([]); return; }
    try { setRevs(await api.listRevisions(projectId)); } catch { setRevs([]); }
  }, [projectId]);
  useEffect(() => { loadRevs(); }, [loadRevs]);

  async function downloadPdf() {
    if (!fields.length) return needField();
    if (!pdfSheet && !pdfPlan) { setMsg(t("Seleziona almeno una sezione da stampare.")); return; }
    const sel = pdfPick;
    if (!sel.length) { setMsg(t("Seleziona almeno un campo da esportare.")); return; }
    setBusy("pdf"); setMsg("");
    try {
      const pname = projects.find((p) => p.id === projectId)?.name || "Progetto";
      const cname = clients.find((c) => c.id === clientId)?.name;
      // La planimetria deve mostrare il progetto REALE: pivot e tubazioni come
      // sono sulla mappa, non un layout ricalcolato dal poligono.
      const canalLines = canals.filter((c) => !c.hidden && c.geojson?.coordinates?.length >= 2)
        .map((c) => c.geojson.coordinates);
      const planOf = (fid: number) => {
        const pvs = pivots.filter((p) => p.field === fid);
        const pls = pivotLines.filter((l) => l.kind === "pipe" && l.field === fid);
        if (!pvs.length) return {};    // niente disegnato: resta il layout automatico
        const fc = fcFromModel(pvs, pls);
        // Alla tavola servono i dati di macchina: centro, raggio, portata e
        // pressione d'esercizio calcolate dal modulo Irrigazione.
        let k = 0;
        for (const ft of fc.features) {
          if (ft.properties?.kind !== "pivot") continue;
          const pv = pvs[k++];
          if (!pv) continue;
          ft.properties.lat = pv.lat;
          ft.properties.lng = pv.lng;
          ft.properties.r = pv.r;
          ft.properties.q_m3h = Math.round(pivotFlow(pv) * 3.6);
          ft.properties.ha = Math.round(pvAreaM2(pv) / 100) / 100;
          ft.properties.p_bar = Math.round(pivotPressure(pv) * 100) / 100;
        }
        // Poligoni figli del campo: entrano nel disegno della tavola.
        const kidRings = fields.filter((x) => x.parentId === fid)
          .map((x) => x.geom.coordinates[0]).filter((r) => r?.length >= 3);
        return { plan_fc: fc, plan_canals: canalLines, plan_rings: kidRings, plan_format: pdfFormat };
      };
      // Fonte d'acqua e computo: di progetto, uguali per ogni campo, nella lingua della stampa.
      const extra = { plan_source: inLang(pdfLang, sourceDrawing), extra_sections: pdfSheet ? inLang(pdfLang, pdfSections) : null };
      if (sel.length === 1) {
        const f = sel[0];
        const blob = await api.downloadReport(f.geom, paramsFrom(effSettings(f)),
          { project_name: fields.length > 1 ? `${pname} — ${f.name}` : pname,
            client_name: cname, notes, include_suitability: pdfSheet,
            lang: pdfLang, include_sheet: pdfSheet, include_plan: pdfPlan,
            project_id: projectId, area_id: f.savedId ?? null, ...planOf(f.id), ...extra });
        saveBlob(blob, `scheda_${safe(fields.length > 1 ? f.name : pname)}.pdf`);
      } else {
        const zip = new JSZip();
        for (let i = 0; i < sel.length; i++) {
          const f = sel[i];
          setMsg(t("Genero campo {i}/{n}…", { i: i + 1, n: sel.length }));
          const blob = await api.downloadReport(f.geom, paramsFrom(effSettings(f)),
            { project_name: `${pname} — ${f.name}`, client_name: cname, notes, include_suitability: pdfSheet,
              lang: pdfLang, include_sheet: pdfSheet, include_plan: pdfPlan,
              project_id: projectId, area_id: f.savedId ?? null, ...planOf(f.id), ...extra });
          zip.file(`scheda_${safe(f.name)}.pdf`, blob);
        }
        const zblob = await zip.generateAsync({ type: "blob" });
        saveBlob(zblob, `schede_${safe(pname)}.zip`);
        setMsg("");
      }
      loadRevs();
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  // ---- Esportazione per Ceres (.ceres) ----------------------------------------
  // JSON { app, ver, name, m } con m = progetto Ceres in Base64 UTF-8 (stesso
  // formato del link #m=). Campi "ff" e macchine "p" ad array posizionali.
  // Le campate sono composte con il listino del produttore e i diametri scelti
  // da Argus (velocità nei tubi), quindi marcate come scelte ([12] = 1).
  // ---- COMPUTO METRICO (solo quantità) ---------------------------------------
  // Voci del progetto così com'è sulla mappa: pivot e campate, tubazioni per
  // diametro, canali, strade di servizio, pompe e opere della fonte d'acqua,
  // fotovoltaico. Niente prezzi: è il computo delle quantità.
  type CRow = { cat: string; item: string; qty: number | null; unit: string; note?: string };
  // phase: solo le voci di quella fase di realizzazione; le opere comuni (rete,
  // fonte d'acqua, stazioni, fotovoltaico) stanno nella fase 1.
  function computoRows(phase?: number): CRow[] {
    const R: CRow[] = [];
    const pvs = phase ? pivots.filter((p) => (p.phase ?? 1) === phase) : pivots;
    const common = !phase || phase === 1;
    const lenOf = (ln: number[][]) => ln.reduce((a, p, i) => {
      if (!i) return 0; const q = ln[i - 1]; const kx = 111320 * Math.cos(((p[1] + q[1]) / 2) * Math.PI / 180);
      return a + Math.hypot((p[0] - q[0]) * kx, (p[1] - q[1]) * 110540);
    }, 0);
    const cPiv = tx("Pivot"), PIPE = ['10"', '8"5/8', '6"5/8'];
    if (pvs.length) {
      const ha = pvs.reduce((a, p) => a + pvAreaM2(p) / 10000, 0);
      R.push({ cat: cPiv, item: `${tx("Pivot")} ${PIVOT_BRANDS[pivotBrand]}`, qty: pvs.length, unit: tx("n."), note: `${tx("Superficie irrigata")} ${fx(ha, { maximumFractionDigits: 1 })} ha` });
      const spans = new Map<string, number>(), ohs = new Map<number, number>();
      let mLen = 0, noComp = 0;
      for (const pv of pvs) {
        const c = spanComposition(pv, pivotBrand);
        if (!c) { noComp++; mLen += pv.r; continue; }
        mLen += c.total;
        for (const sp of c.spans) { const k = `${sp.pipe}|${sp.len}`; spans.set(k, (spans.get(k) ?? 0) + 1); }
        if (c.oh) ohs.set(c.oh, (ohs.get(c.oh) ?? 0) + 1);
      }
      [...spans.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([k, n]) => {
        const [pi, len] = k.split("|").map(Number);
        R.push({ cat: cPiv, item: tx("Campata {d} da {l} m", { d: PIPE[pi], l: fx(len, { maximumFractionDigits: 1 }) }), qty: n, unit: tx("n.") });
      });
      [...ohs.entries()].sort((a, b) => a[0] - b[0]).forEach(([len, n]) => R.push({ cat: cPiv, item: tx("Sbraccio da {l} m", { l: fx(len, { maximumFractionDigits: 1 }) }), qty: n, unit: tx("n.") }));
      if (noComp) R.push({ cat: cPiv, item: tx("Pivot da comporre in Ceres (listino non disponibile)"), qty: noComp, unit: tx("n.") });
      R.push({ cat: cPiv, item: tx("Lunghezza totale delle macchine"), qty: Math.round(mLen), unit: "m" });
      const nGun = pvs.filter((p) => p.gun && p.gun > 0).length;
      if (nGun) R.push({ cat: cPiv, item: tx("Irrigatore finale"), qty: nGun, unit: tx("n.") });
      const nSec = pvs.filter((p) => (p.deg ?? 360) < 360).length;
      if (nSec) R.push({ cat: cPiv, item: tx("Pivot a settore (con fermi di fine corsa)"), qty: nSec, unit: tx("n.") });
    }
    // Lineari, rotoloni e goccia salvati sui campi
    for (const [k, d] of Object.entries(sysDesigns)) {
      const f = fieldOfKey(k); if (!f) continue;
      if (phase && (d.phase ?? 1) !== phase) continue;
      if (d.sys === "lineari") {
        const r = calcLin(f, d.p as LinP), cL = `${tx("Lineari")} · ${f.name}`;
        R.push({ cat: cL, item: `${tx("Lineari")} ${PIVOT_BRANDS[pivotBrand]}`, qty: r.machines.length, unit: tx("n."), note: `${fx(r.ha, { maximumFractionDigits: 1 })} ha · ${fx(Math.round(r.qLs))} l/s` });
        const spans = new Map<string, number>();
        for (const m of r.machines) {
          R.push({ cat: cL, item: `L${m.i}`, qty: Math.round(m.L), unit: "m", note: `${tx("corsa")} ${fx(Math.round(m.travel))} m` });
          R.push({ cat: cL, item: tx("Condotta con idranti DN {d}", { d: m.dn }), qty: Math.round(m.travel), unit: "m", note: `${tx("Prevalenza all'ingresso del campo")} ${fx(Math.round(m.head))} m` });
          const c = spanComposition({ r: m.L, q: m.qLs }, pivotBrand, true);
          for (const sp of c?.spans ?? []) { const kk = `${sp.pipe}|${sp.len}`; spans.set(kk, (spans.get(kk) ?? 0) + 1); }
        }
        [...spans.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([kk, n]) => {
          const [pi, len] = kk.split("|").map(Number);
          R.push({ cat: cL, item: tx("Campata {d} da {l} m", { d: ['10"', '8"5/8', '6"5/8'][pi], l: fx(len, { maximumFractionDigits: 1 }) }), qty: n, unit: tx("n.") });
        });
      } else if (d.sys === "rotoloni") {
        const p = d.p as RotP, r = calcRot(f, p), cR = `${tx("Rotoloni")} · ${f.name}`;
        R.push({ cat: cR, item: tx("Rotolone con tubo da {l} m e irrigatore da {q} m³/h", { l: fx(p.hoseLen), q: fx(p.gunQ) }), qty: r.nMach, unit: tx("n."), note: `${fx(r.coveredHa, { maximumFractionDigits: 1 })} ha · ${fx(r.lanes)} ${tx("corsie")} · ${fx(r.runs.length)} ${tx("tirate")}` });
        R.push({ cat: cR, item: tx("Portata totale"), qty: Math.round(r.qLs), unit: "l/s" });
        R.push({ cat: cR, item: tx("Condotta di testata DN {d}", { d: r.dn }), qty: r.mainLen, unit: "m", note: `${tx("Prevalenza all'ingresso del campo")} ${fx(Math.round(r.head))} m` });
        R.push({ cat: cR, item: tx("Idranti"), qty: r.hydrants, unit: tx("n.") });
      } else {
        const p = d.p as DripP, r = calcDrip(f, p), cD = `${tx("Goccia")} · ${f.name}`;
        R.push({ cat: cD, item: tx("Ali gocciolanti"), qty: Math.round(r.latM), unit: "m", note: `${tx("Interfila delle ali (m)")} ${fx(p.latSp)}` });
        R.push({ cat: cD, item: tx("Gocciolatori"), qty: Math.round(r.emitters), unit: tx("n."), note: `${fx(p.emQ)} l/h · ${fx(p.emSp)} m` });
        R.push({ cat: cD, item: tx("Condotte secondarie"), qty: Math.round(r.subLen), unit: "m", note: `DN ${r.dnSub}` });
        R.push({ cat: cD, item: tx("Gruppo di filtrazione e testata"), qty: 1, unit: tx("n."), note: `${fx(Math.round(r.qLs))} l/s · ${tx("Prevalenza all'ingresso del campo")} ${fx(Math.round(r.head))} m` });
        R.push({ cat: cD, item: tx("Valvole di settore"), qty: r.nSec, unit: tx("n."), note: `${fx(Math.round(r.qLs))} l/s ${tx("per settore")}` });
      }
    }
    if (!common) return R;
    const cNet = tx("Rete di adduzione");
    if (hydra && hydra.byDn.length) {
      for (const [dn, m] of [...hydra.byDn].sort((a, b) => a[0] - b[0])) R.push({ cat: cNet, item: tx("Tubazione DN {d}", { d: dn }), qty: Math.round(m), unit: "m" });
    } else {
      const m = pivotLines.filter((l) => l.kind === "pipe").reduce((a, l) => a + lenOf(l.coords), 0);
      if (m > 0) R.push({ cat: cNet, item: tx("Tubazioni (diametri da calcolare nella pagina Tubazioni)"), qty: Math.round(m), unit: "m" });
    }
    const mCan = canals.filter((c) => !c.hidden && c.geojson?.coordinates?.length >= 2).reduce((a, c) => a + lenOf(c.geojson.coordinates), 0);
    if (mCan > 0) R.push({ cat: cNet, item: tx("Canale"), qty: Math.round(mCan), unit: "m" });
    const mRoad = roads.filter((r) => r.kind === "service" && !r.hidden).reduce((a, r) => a + lenOf(r.coords), 0);
    if (mRoad > 0) R.push({ cat: tx("Strade"), item: tx("Strade di servizio"), qty: Math.round(mRoad), unit: "m" });
    // Fonte d'acqua (schema scelto) oppure stazione di pompaggio
    const S = srcPt ? sourceSchemes() : null;
    const sc = S ? (S.schemes.find((x) => x.key === (srcShown ?? S.best?.key)) ?? null) : null;
    if (S && sc) {
      const cF = `${tx("Fonte d'acqua")} · ${tx("schema")} ${sc.key}`;
      for (const st of sc.stages) {
        const kW = STD_KW.find((k) => k >= st.kW * 1.1) ?? Math.round(st.kW);
        R.push({ cat: cF, item: `${st.name}`, qty: Math.round(st.kW), unit: "kW", note: `${fx(Math.round(st.qLs))} l/s · ${fx(Math.round(st.head))} m · ${tx("motore normalizzato")} ${fx(kW)} kW` });
      }
      if (sc.main?.kind === "pipe") R.push({ cat: cF, item: tx("Adduttrice DN {d}", { d: sc.main.dn ?? 0 }), qty: Math.round(sc.main.L * (sc.main.n ?? 1)), unit: "m", note: (sc.main.n ?? 1) > 1 ? `${sc.main.n} ${tx("linee in parallelo")}` : undefined });
      if (sc.main?.kind === "canal") R.push({ cat: cF, item: tx("Canale a gravità"), qty: Math.round(sc.main.L), unit: "m", note: `${tx("scavo massimo")} ${fx(sc.main.cutMax ?? 0, { maximumFractionDigits: 1 })} m` });
      if (sc.res) {
        R.push({ cat: cF, item: tx("Vasca di accumulo"), qty: Math.round(sc.res.vol), unit: "m³", note: `${fx(sc.res.ha, { maximumFractionDigits: 2 })} ha · ${tx("profondità")} ${fx(resDepth)} m` });
        R.push({ cat: cF, item: tx("Scavo della vasca (volume utile + franco 0,5 m)"), qty: Math.round(sc.res.vol * (1 + 0.5 / Math.max(1, resDepth))), unit: "m³" });
      }
      const qIn = sc.key === "B" ? sc.stages[0].qLs : sc.key === "C" ? (S.Vday + (sc.res?.evap ?? 0)) / 3.6 / Math.max(1, Math.min(srcHours, 24)) : S.Qd;
      for (const blk of intakeAdvice(qIn, S.drop, S.Qd, sc.key === "C")) for (const [k, v] of blk.rows) R.push({ cat: cF, item: k, qty: null, unit: "", note: v });
      if (srcEnergy !== "rete") {
        R.push({ cat: cF, item: tx("Campo fotovoltaico"), qty: Math.round(sc.pvKwp), unit: "kWp" });
        if (sc.battKwh > 0) R.push({ cat: cF, item: tx("Batterie"), qty: Math.round(sc.battKwh), unit: "kWh" });
      }
    } else if (pivots.length) {
      const P = pumpStation();
      if (P.best) {
        const cP = tx("Stazione di pompaggio");
        R.push({ cat: cP, item: tx("Pompe da {k} kW", { k: fx(P.best.kW) }), qty: P.best.nTot, unit: tx("n."), note: `${P.best.nDuty} ${tx("in servizio")} + ${P.best.nTot - P.best.nDuty} ${tx("di riserva")} · ${fx(Math.round(P.qDes))} l/s · ${fx(Math.round(P.head))} m` });
        R.push({ cat: cP, item: tx("Potenza installata"), qty: Math.round(P.best.kWInst), unit: "kW" });
      }
    }
    if (powerMode === "solar" && pivots.length) {
      const So = solarSizing(), cS = tx("Fotovoltaico");
      R.push({ cat: cS, item: tx("Campo FV senza batterie"), qty: Math.round(So.no.kwp), unit: "kWp", note: `${fx(So.no.land / 10000, { maximumFractionDigits: 2 })} ha` });
      R.push({ cat: cS, item: tx("Campo FV con batterie (alternativa)"), qty: Math.round(So.bat.kwp), unit: "kWp", note: `${tx("Batterie")} ${fx(Math.round(So.bat.battKwh))} kWh` });
    }
    return R;
  }
  async function downloadComputo() {
    const rows = computoRows();
    if (!rows.length) { setMsg(t("Posa prima i pivot sul campo attivo.")); return; }
    const pname = projects.find((x) => x.id === projectId)?.name || "Argus Total";
    const cname = clients.find((c) => c.id === clientId)?.name || "";
    const today = new Date().toISOString().slice(0, 10);
    const sheet: (string | number | null)[][] = [
      [t("Computo metrico")], [`${cname ? cname + " · " : ""}${pname}`], [today], [],
    ];
    const bold = [0];
    const block = (title: string, rr: CRow[]) => {
      bold.push(sheet.length); sheet.push([title]);
      bold.push(sheet.length); sheet.push([t("Categoria"), t("Voce"), t("Quantità"), t("Unità"), t("Note")]);
      for (const r of rr) sheet.push([r.cat, r.item, r.qty, r.unit, r.note ?? ""]);
      sheet.push([]);
    };
    if (nPhases > 1) for (let ph = 1; ph <= nPhases; ph++) block(`${t("Fase")} ${ph}${ph === 1 ? ` (${t("con le opere comuni")})` : ""}`, computoRows(ph));
    block(nPhases > 1 ? t("Totale") : t("Computo metrico"), rows);
    const blob = await buildXlsx(t("Computo metrico"), sheet, { boldRows: bold, widths: [28, 52, 12, 8, 70] });
    saveBlob(blob, `${safe(pname)}_computo.xlsx`);
  }
  function exportCeres() {
    const hasLin = Object.values(sysDesigns).some((d) => d.sys === "lineari");
    if (!pivots.length && !hasLin) { setMsg(t("Posa prima i pivot sul campo attivo.")); return; }
    const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
    const inRing = (lng: number, lat: number, ring: number[][]) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    // campo di ogni pivot: quello assegnato, altrimenti quello che ne contiene il centro
    const owner = pivots.map((pv) => {
      if (pv.field != null && fields.some((f) => f.id === pv.field)) return pv.field;
      const hit = fields.filter((f) => inRing(pv.lng, pv.lat, f.geom.coordinates[0]))
        .sort((a, b) => ringAreaHa(a.geom.coordinates) - ringAreaHa(b.geom.coordinates))[0];
      return hit?.id ?? null;
    });
    const used = new Set(owner.filter((x): x is number => x != null));
    const linFields = Object.entries(sysDesigns).filter(([, d]) => d.sys === "lineari").map(([k]) => fieldOfKey(k)).filter((f): f is Field => !!f);
    for (const f of linFields) used.add(f.id);
    const ffSrc = fields.filter((f) => used.has(f.id));
    if (!ffSrc.length) { setMsg(t("Nessun pivot è dentro un campo: impossibile esportare per Ceres.")); return; }
    const idOf = new Map(ffSrc.map((f, i) => [f.id, i + 1]));
    const ff = ffSrc.map((f) => {
      const ring = f.geom.coordinates[0].slice();
      if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
      const st = effSettings(f);
      const n = owner.filter((o) => o === f.id).length;
      return { i: idOf.get(f.id)!, v: ring.map((p) => [r6(p[1]), r6(p[0])]),
        q: [50, Math.max(800, Math.round(st.radius)), 0, Math.max(1, Math.round(st.gap)), Math.max(14, n), 0, 25] };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any[] = [];
    pivots.forEach((pv, k) => {
      const fid = owner[k]; if (fid == null) return;
      const c = spanComposition(pv, pivotBrand);
      const deg = Math.round(Math.max(1, Math.min(360, pv.deg ?? 360))), az = Math.round(pv.az ?? 0) % 360;
      const gun = pv.gun && pv.gun > 0 ? 1 : 0, throwM = Math.round(pv.gun && pv.gun > 0 ? pv.gun : 25);
      p.push(c
        ? [r6(pv.lat), r6(pv.lng), Math.round(c.total), deg, deg >= 360 ? 0 : az, gun, throwM, 0, 0, idOf.get(fid)!,
          Math.round(c.oh * 10), c.spans.map((sp) => [sp.pipe, Math.round(sp.len * 10)]), 1]
        : [r6(pv.lat), r6(pv.lng), Math.round(pv.r), deg, deg >= 360 ? 0 : az, gun, throwM, 0, 0, idOf.get(fid)!, 0, [], 0]);
    });
    const skipped = pivots.length - p.length;
    // Lineari: tipo 1, punto di partenza = centro della macchina a inizio corsa,
    // [4] direzione di marcia, [8] corsa.
    for (const f of linFields) {
      const d = Object.entries(sysDesigns).find(([k]) => fieldOfKey(k)?.id === f.id)?.[1]; if (!d) continue;
      for (const m of calcLin(f, d.p as LinP).machines) {
        const c = spanComposition({ r: m.L, q: m.qLs }, pivotBrand, true);
        p.push([r6(m.start[1]), r6(m.start[0]), Math.round(c ? c.total : m.L), 0, Math.round(m.az) % 360, 0, 25, 1, Math.round(m.travel), idOf.get(f.id)!,
          c ? Math.round(c.oh * 10) : 0, c ? c.spans.map((sp) => [sp.pipe, Math.round(sp.len * 10)]) : [], c ? 1 : 0]);
      }
    }
    const cname = clients.find((c) => c.id === clientId)?.name || "";
    const pname = projects.find((x) => x.id === projectId)?.name || "";
    const today = new Date(); const dt = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: any = { c: cname || pname, ...(pname ? { r: pname } : {}), dt, ...(pivotBrand !== "starpivot" ? { pb: pivotBrand } : {}), ff, p };
    const json = JSON.stringify(obj);
    const m = btoa(unescape(encodeURIComponent(json)));
    // verifica: la decodifica deve restituire lo stesso JSON
    if (decodeURIComponent(escape(atob(m))) !== json) { setMsg(t("Esportazione per Ceres non riuscita: verifica di codifica fallita.")); return; }
    const name = pname || cname || "Argus Total";
    saveBlob(new Blob([JSON.stringify({ app: "ceres", ver: "78.16", name, m })], { type: "application/json" }), `${safe(name)}.ceres`);
    setMsg(t("File .ceres esportato: {n} pivot in {f} campi.", { n: fmt(p.length), f: fmt(ff.length) })
      + (skipped ? " " + t("{n} pivot fuori dai campi non esportati.", { n: fmt(skipped) }) : ""));
  }
  function downloadGeoJSON() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const feats: any[] = [];
    for (const f of fields) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fc = f.layGeo as any;
      if (fc?.features) for (const ft of fc.features) feats.push({ ...ft, properties: { ...ft.properties, field: f.name } });
    }
    if (!feats.length) { setMsg(t("Genera prima il layout.")); return; }
    saveBlob(new Blob([JSON.stringify({ type: "FeatureCollection", features: feats })],
      { type: "application/geo+json" }), "layout_pivot.geojson");
  }
  // ---- Link di sola lettura MULTIPLI (uno per vista/cliente) ----
  async function refreshShares(pid: number) { try { setShares(await api.listShares(pid)); } catch { /* silenzioso */ } }
  // Crea un NUOVO link che «fotografa» la visibilità attuale (quali aree/campi e
  // gruppi di pivot sono mostrati): link diversi possono mostrare livelli diversi.
  async function createNamedShare() {
    if (!projectId) { setMsg(t("Seleziona un progetto prima di creare il link.")); return; }
    const pid = projectId;
    setBusy("share"); setMsg("");
    try {
      await saveAll(true);   // salva stato e allinea gli id area
      const map = fieldToAreaRef.current;
      const hiddenFields: Record<number, boolean> = {};
      const hiddenPivots: Record<number, boolean> = {};
      const hiddenPipes: Record<number, boolean> = {};
      for (const f of fields) if (f.hidden) { const aid = map.get(f.id); if (aid != null) hiddenFields[aid] = true; }
      for (const fid of hiddenPivotFields) { const aid = map.get(fid); if (aid != null) hiddenPivots[aid] = true; }
      for (const fid of hiddenPipeFields) { const aid = map.get(fid); if (aid != null) hiddenPipes[aid] = true; }
      const name = (shareName.trim() || t("Vista {n}", { n: shares.length + 1 }));
      const sv = await api.createShareView(pid, name, { hiddenFields, hiddenPivots, hiddenPipes, source: sourceDrawing() });
      setShareName("");
      const url = `${window.location.origin}/view/${sv.token}`;
      try { await navigator.clipboard.writeText(url); setMsg(t("Link «{name}» creato e copiato ✓", { name: sv.name })); }
      catch { setMsg(t("Link «{name}» creato ✓", { name: sv.name })); }
      await refreshShares(pid);
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  async function removeShare(token: string) {
    if (!projectId) return;
    if (!confirm(t("Eliminare questo link? Chi ce l'ha non potrà più aprirlo."))) return;
    try { await api.deleteShare(token); await refreshShares(projectId); } catch (e) { showErr(e); }
  }

  // ---- ricerca località (Nominatim) ----
  const [q, setQ] = useState("");
  async function geocode(e: React.FormEvent) {
    e.preventDefault(); const s = q.trim(); if (!s) return;
    const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) { mapApi.current?.flyTo(parseFloat(m[1]), parseFloat(m[2]), 13); return; }
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(s)}`);
      const j = await r.json();
      if (j[0]) mapApi.current?.flyTo(parseFloat(j[0].lat), parseFloat(j[0].lon), 13);
      else setMsg(t("Località non trovata."));
    } catch { setMsg(t("Località non trovata.")); }
  }

  // Firma del contenuto salvabile (esclude savedId, che cambia col salvataggio
  // stesso: così l'autosave non si ri-innesca da solo dopo aver salvato).
  const saveSig = useMemo(() => {
    try {
      return JSON.stringify([
        fields.map((f) => [f.name, f.parentId ?? 0, f.level ?? "", f.score ?? 0, f.style ?? 0, f.hidden ? 1 : 0, f.geom.coordinates[0]]),
        canals.map((c) => [c.owner ?? 0, c.hidden ? 1 : 0, c.geojson.coordinates]),
        roads.map((r) => [r.id, r.owner ?? 0, r.hidden ? 1 : 0, r.width_m, r.coords]),
        watercourses.map((w) => [w.owner ?? 0, w.hidden ? 1 : 0]),
        pivots.map((p) => [Math.round(p.lat * 1e6), Math.round(p.lng * 1e6), p.r, p.field ?? 0, p.conn ?? "", p.q ?? 0]),
        [mmDes, hoursDay],                                  // cambiano la portata salvata dei pivot
        pivotLines.map((l) => [l.kind, l.field ?? 0, l.coords.length]),
        [...hiddenPivotFields].sort((a, b) => a - b),
        [...hiddenPipeFields].sort((a, b) => a - b),
      ]);
    } catch { return ""; }
  }, [fields, canals, roads, watercourses, pivots, pivotLines, hiddenPivotFields, hiddenPipeFields, mmDes, hoursDay]);
  latestSigRef.current = saveSig;

  // Esegue un salvataggio serializzato: se ne arriva un altro mentre salva, lo
  // mette in coda e lo lancia al termine (nessun salvataggio concorrente).
  async function runSave(fn: () => Promise<void>) {
    savingRef.current = true;
    try { await fn(); } catch { /* gestito in saveAll */ }
    finally {
      savingRef.current = false;
      const next = pendingSaveRef.current;
      if (next) { pendingSaveRef.current = null; void runSave(next); }
    }
  }
  // Salvataggio AUTOMATICO: ~1.5s dopo l'ultima modifica, se il contenuto è cambiato.
  useEffect(() => {
    if (!projectId || suppressAutosaveRef.current) return;
    if (saveSig === lastSavedSigRef.current) return;
    const doSave = async () => { const ok = await saveAll(true); if (ok) lastSavedSigRef.current = saveSig; };
    const tm = setTimeout(() => {
      if (savingRef.current) { pendingSaveRef.current = doSave; return; }
      void runSave(doSave);
    }, 1500);
    return () => clearTimeout(tm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveSig, projectId]);

  // Quota (min/max/mediana) del campo attivo per il riquadro informazioni.
  useEffect(() => {
    const a = fields.find((f) => f.id === activeId) ?? null;
    if (!a) { setElevStats(null); return; }
    const cached = elevCache.current.get(a.id);
    if (cached) { setElevStats({ id: a.id, s: cached }); return; }
    let cancelled = false;
    setElevStats({ id: a.id, loading: true });
    api.fetchElevationStats(a.geom)
      .then((s) => { if (cancelled) return; elevCache.current.set(a.id, s); setElevStats({ id: a.id, s }); })
      .catch(() => { if (!cancelled) setElevStats({ id: a.id, err: true }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, elevNonce]);

  const hasFields = fields.length > 0;
  const rootFields = fields.filter((f) => f.parentId == null);
  // Gruppi pivot per campo (un «livello» pivot per campo nel pannello Livelli).
  const pivotGroups = (() => {
    const m = new Map<number, number>();
    for (const p of pivots) { const k = p.field ?? -1; m.set(k, (m.get(k) ?? 0) + 1); }
    return Array.from(m.entries()).map(([fid, n]) => ({ fid, n, name: fid < 0 ? t("Senza campo") : (fields.find((f) => f.id === fid)?.name ?? t("Campo")) }));
  })();
  // Gruppi tubazioni per campo (le tubazioni sono oggetti come canali e pivot).
  const pipeGroups = (() => {
    const m = new Map<number, number>();
    for (const l of pivotLines) if (l.kind === "pipe") { const k = l.field ?? -1; m.set(k, (m.get(k) ?? 0) + 1); }
    return Array.from(m.entries()).map(([fid, n]) => ({ fid, n, name: fid < 0 ? t("Senza campo") : (fields.find((f) => f.id === fid)?.name ?? t("Campo")) }));
  })();

  // Riga oggetto (canale/strada/invaso/pivot) trascinabile: occhio, zoom, elimina.
  // Trascinandola su un campo diventa «sua»; sulla dropzone si scollega.
  function objRow(kind: "canal" | "road" | "water" | "pivot" | "pipe", dragId: number | string, key: string, hidden: boolean, onToggle: () => void, label: React.ReactNode, onZoom: () => void, onRemove: () => void) {
    return (
      <li key={key} draggable
        onDragStart={(e) => { e.stopPropagation(); dragRef.current = { kind, id: dragId }; e.dataTransfer.effectAllowed = "move"; }}
        onDragEnd={() => { dragRef.current = null; setDragOverField(null); }}
        className="flex items-center gap-1 text-[11px] bg-panel rounded px-1.5 py-0.5 cursor-move">
        <button className="text-brand-mid w-4" title={t("Mostra/Nascondi")} onClick={onToggle}>{hidden ? "○" : "◉"}</button>
        <button className="flex-1 text-left leading-tight" title={t("Zoom · trascina su un campo per assegnarlo")} onClick={onZoom}>{label}</button>
        <button className="text-danger w-4" title={t("Rimuovi")} onClick={onRemove}>✕</button>
      </li>
    );
  }
  // ---- LINEARI · ROTOLONI · GOCCIA ---------------------------------------------
  // Si progettano sul poligono attivo (area o campo). «Salva sul campo» li
  // conserva nel progetto: compaiono sempre sulla mappa, nel computo e (i
  // lineari) nel file .ceres.
  type SysKind = "lineari" | "rotoloni" | "goccia";
  type LinP = { maxLen: number; minTravel: number; az: number | null };
  type RotP = { throw: number; gunQ: number; spacingPct: number; hoseLen: number; depth: number; az: number | null };
  type DripP = { latSp: number; emSp: number; emQ: number; latMax: number; sectors: number; az: number | null };
  type SysDesign = { sys: SysKind; p: LinP | RotP | DripP; phase?: number };
  const LIN_DEF: LinP = { maxLen: 600, minTravel: 200, az: null };
  const ROT_DEF: RotP = { throw: 40, gunQ: 40, spacingPct: 70, hoseLen: 350, depth: 30, az: null };
  const DRIP_DEF: DripP = { latSp: 1.5, emSp: 0.3, emQ: 1.0, latMax: 120, sectors: 0, az: null };
  const [linP, setLinP] = useState<LinP>(LIN_DEF);
  const [rotP, setRotP] = useState<RotP>(ROT_DEF);
  const [dripP, setDripP] = useState<DripP>(DRIP_DEF);
  const [sysDesigns, setSysDesigns] = useState<Record<string, SysDesign>>({});   // chiave: a<area salvata> o f<campo>
  const sysKey = (f: Field) => (f.savedId != null ? `a${f.savedId}` : `f${f.id}`);
  // ---- FASI DI REALIZZAZIONE ----
  // Pivot e sistemi dei campi si dividono in N fasi di superficie simile,
  // nell'ordine scelto (dalla fonte d'acqua, da ovest a est, da sud a nord).
  const nPhases = Math.max(1, ...pivots.map((p) => p.phase ?? 1), ...Object.values(sysDesigns).map((d) => d.phase ?? 1));
  function assignPhases() {
    type It = { kind: "pv" | "sys"; idx: number | string; pt: number[]; ha: number };
    const items: It[] = pivots.map((p, i) => ({ kind: "pv", idx: i, pt: [p.lng, p.lat], ha: pvAreaM2(p) / 10000 }));
    for (const [k, d] of Object.entries(sysDesigns)) {
      const f = fieldOfKey(k); if (!f) continue;
      const ring = f.geom.coordinates[0];
      const c = [ring.reduce((a, q) => a + q[0], 0) / ring.length, ring.reduce((a, q) => a + q[1], 0) / ring.length];
      items.push({ kind: "sys", idx: k, pt: c, ha: ringAreaHa(f.geom.coordinates) });
      void d;
    }
    if (!items.length) { setMsg(t("Posa prima i pivot sul campo attivo.")); return; }
    const water = waterLinesLL();
    const origin = srcPt ?? (water[0]?.[0] ?? null);
    const key = (it: It) => phaseOrderBy === "ovest" ? it.pt[0] : phaseOrderBy === "sud" ? it.pt[1]
      : origin ? Math.hypot((it.pt[0] - origin[0]) * Math.cos((it.pt[1] * Math.PI) / 180), it.pt[1] - origin[1]) : it.pt[0];
    items.sort((a, b) => key(a) - key(b));
    const tot = items.reduce((a, x) => a + x.ha, 0), n = Math.max(1, Math.min(10, phaseN));
    let acc = 0;
    const phOf = new Map<string, number>();
    for (const it of items) {
      const ph = Math.min(n, 1 + Math.floor(((acc + it.ha / 2) / Math.max(1e-9, tot)) * n));
      acc += it.ha; phOf.set(`${it.kind}|${it.idx}`, ph);
    }
    commitPivots(pivots.map((p, i) => ({ ...p, phase: phOf.get(`pv|${i}`) ?? 1 })));
    setSysDesigns((ds) => Object.fromEntries(Object.entries(ds).map(([k, d]) => [k, { ...d, phase: phOf.get(`sys|${k}`) ?? 1 }])));
    setMsg(t("Divisi in {n} fasi ✓", { n }));
  }
  function phaseSummary() {
    const out: { ph: number; nPiv: number; ha: number; qLs: number; sys: number }[] = [];
    for (let ph = 1; ph <= nPhases; ph++) {
      const pv = pivots.filter((p) => (p.phase ?? 1) === ph);
      const ds = Object.entries(sysDesigns).filter(([, d]) => (d.phase ?? 1) === ph);
      let ha = pv.reduce((a, p) => a + pvAreaM2(p) / 10000, 0), q = pv.reduce((a, p) => a + pivotFlow(p), 0);
      for (const [k] of ds) { const f = fieldOfKey(k); if (f) { ha += ringAreaHa(f.geom.coordinates); } }
      out.push({ ph, nPiv: pv.length, ha, qLs: q, sys: ds.length });
    }
    return out;
  }
  const fieldOfKey = (k: string) => fields.find((f) => sysKey(f) === k) ?? null;
  const ringOf = (f: Field) => f.geom.coordinates[0] as SysLL[];
  // Idraulica dei sistemi nel campo: diametro commerciale dalla velocità
  // massima, perdite Hazen-Williams (F = fattore delle uscite distribuite).
  const hwLoss = (qLs: number, Dm: number, Lm: number, C = hwC, F = 1) =>
    qLs > 0 ? F * (10.67 * Lm * Math.pow(qLs / 1000, 1.852)) / (Math.pow(C, 1.852) * Math.pow(Dm, 4.87)) : 0;
  const dnFor = (qLs: number) => {
    const need = Math.sqrt((4 * (qLs / 1000)) / (Math.PI * vMax)) * 1000;
    return DN_LIST.find((d) => d >= need) ?? DN_LIST[DN_LIST.length - 1];
  };
  const DN_ID = (dn: number) => dn * 0.88 / 1000;            // diametro interno PE/PVC ≈ 88% del DN
  const r0 = (x: number) => Math.round(x);
  function calcLin(f: Field, p: LinP) {
    const L = linearLayout(ringOf(f), { maxLen: p.maxLen, minTravel: p.minTravel, az: p.az });
    const hd = Math.max(1, Math.min(24, hoursDay));
    const machines = L.machines.map((m) => {
      const qLs = (m.areaHa * 10000 * mmDes) / (hd * 3600);
      // macchina: irrigatori + perdite nelle campate (portata che cala linearmente) + 0,3 bar
      const c = spanComposition({ r: m.L, q: qLs }, pivotBrand, true);
      let hfSpan = 0, x = 0;
      if (c) for (const sp of c.spans) { const q = qLs * Math.max(0, 1 - (x + sp.len / 2) / m.L); hfSpan += hwLoss(q, SPAN_ID[sp.pipe], sp.len, 130); x += sp.len; }
      else hfSpan = hwLoss(qLs, latDN / 1000, m.L, 130, 0.36);
      const pMach = sprinkBar + hfSpan / 10.2 + pivotPointBar + 0.5;     // + 0,5 bar di tubo flessibile e attacco
      // condotta con idranti lungo il bordo della corsa: caso peggiore, macchina in fondo
      const dn = dnFor(qLs), hfMain = hwLoss(qLs, DN_ID(dn), m.travel);
      return { ...m, qLs, pMach, dn, hfMain, head: pMach * 10.2 + hfMain };
    });
    return { ...L, machines, ha: machines.reduce((a, m) => a + m.areaHa, 0), qLs: machines.reduce((a, m) => a + m.qLs, 0),
      head: machines.reduce((a, m) => Math.max(a, m.head), 0) };
  }
  function calcRot(f: Field, p: RotP) {
    const spacing = 2 * p.throw * p.spacingPct / 100;
    const L = reelLayout(ringOf(f), { spacing, hoseLen: p.hoseLen, throw: p.throw, az: p.az });
    const hd = Math.max(1, Math.min(24, hoursDay));
    const cycleDays = Math.max(1, p.depth / Math.max(0.1, mmDes));              // giorni fra due passaggi
    const runH = L.runs.map((r) => (r.areaHa * 10 * p.depth) / Math.max(1, p.gunQ));   // ore per tirata
    const totH = runH.reduce((a, x) => a + x, 0);
    const nMach = Math.max(1, Math.ceil(totH / (hd * cycleDays)));
    const qLs = (nMach * p.gunQ) / 3.6, q1 = p.gunQ / 3.6;
    // tubo PE della macchina: il più piccolo con velocità ≤ 2,5 m/s
    const HOSE = [75, 82, 90, 100, 110, 120, 125, 140];
    const hoseMm = HOSE.find((d) => (q1 / 1000) / (Math.PI * (d / 1000) ** 2 / 4) <= 2.5) ?? HOSE[HOSE.length - 1];
    const hfHose = hwLoss(q1, hoseMm / 1000, p.hoseLen, 140);
    const pGun = 4.5;                                                            // bar al cannone
    const hHyd = pGun * 10.2 + hfHose + 10.2;                                    // + 1 bar di turbina e carrello
    // condotta con idranti in testata: una per corsia, tutte le macchine in fondo (caso peggiore)
    const mainLen = r0(L.lanes * spacing), dn = dnFor(qLs), hfMain = hwLoss(qLs, DN_ID(dn), mainLen);
    const firsts = new Map<number, typeof L.runs[number]>();
    for (const run of L.runs) { const f0 = firsts.get(run.lane); if (!f0 || run.y0 < f0.y0) firsts.set(run.lane, run); }
    const headland = [...firsts.entries()].sort((a, b) => a[0] - b[0]).map(([, run]) => run.axis[0]);
    return { ...L, spacing, cycleDays, totH, nMach, qLs, rateMmH: (p.gunQ / Math.max(1, Math.PI * p.throw * p.throw)) * 1000,
      hoseMm, hfHose, pGun, hHyd, mainLen, dn, hfMain, head: hHyd + hfMain, hydrants: L.lanes, headland };
  }
  function calcDrip(f: Field, p: DripP) {
    const rate = p.emQ / Math.max(0.01, p.latSp * p.emSp);                      // mm/h
    const hSec = mmDes / Math.max(0.01, rate);                                  // ore per settore
    const hd = Math.max(1, Math.min(24, hoursDay));
    const auto = Math.max(1, Math.floor(hd / Math.max(0.1, hSec)));
    const nSec = p.sectors > 0 ? p.sectors : auto;
    const L = dripLayout(ringOf(f), { latMax: p.latMax, nSectors: nSec, az: p.az });
    const latM = (L.fieldHa * 10000) / Math.max(0.1, p.latSp);
    const maxSecHa = L.sectors.reduce((a, s) => Math.max(a, s.areaHa), 0);
    const qLs = (maxSecHa * 10000 * rate) / 3600;
    // ala gocciolante Ø16 (interno 13,6 mm): perdite con F = 0,36 (uscite distribuite)
    const qLat = (p.latMax / Math.max(0.05, p.emSp)) * p.emQ / 3600;           // l/s
    const hfLat = hwLoss(qLat, 0.0136, p.latMax, 140, 0.36);
    // secondaria: alimenta ali su due lati; portata del settore divisa tra le sue secondarie
    const nSubSec = Math.max(1, Math.round(L.submains.length * maxSecHa / Math.max(1e-9, L.fieldHa)));
    const qSub = qLs / nSubSec, subLen = L.submains.length ? L.subLen / L.submains.length : 0;
    const dnSub = dnFor(qSub), hfSub = hwLoss(qSub, DN_ID(dnSub), subLen, 140, 0.36);
    const dnMain = dnFor(qLs);
    const pEm = 1.0;                                                             // bar al gocciolatore
    const head = pEm * 10.2 + hfLat + hfSub + 7;                                 // + filtri 5 m e valvola di settore 2 m
    return { ...L, rate, hSec, nSec, auto, latM, emitters: latM / Math.max(0.05, p.emSp), qLs,
      hoursUsed: hSec * nSec, ok: hSec * nSec <= hd + 1e-6, qLat, hfLat, nSubSec, qSub, dnSub, hfSub, dnMain, pEm, head };
  }
  // Disegno: progetti salvati di tutti i campi + anteprima del campo attivo.
  function sysDrawItems(): { polys: { ring: number[][]; color: string; label?: string; dashed?: boolean }[]; lines: { coords: number[][]; color: string; dashed?: boolean; weight?: number }[] } {
    const polys: { ring: number[][]; color: string; label?: string; dashed?: boolean }[] = [];
    const lines: { coords: number[][]; color: string; dashed?: boolean; weight?: number }[] = [];
    const add = (f: Field, d: SysDesign, preview: boolean) => {
      if (d.sys === "lineari") {
        for (const m of calcLin(f, d.p as LinP).machines) {
          polys.push({ ring: m.ring, color: "#4CAF4F", label: `L${m.i} · ${fmt(Math.round(m.L))}×${fmt(Math.round(m.travel))} m`, dashed: preview });
          lines.push({ coords: m.feed, color: "#0284c7", dashed: true, weight: 3 });
        }
      } else if (d.sys === "rotoloni") {
        const r = calcRot(f, d.p as RotP);
        for (const run of r.runs) { polys.push({ ring: run.ring, color: "#f0b429", dashed: preview }); lines.push({ coords: run.axis, color: "#b7791f", weight: 1.5 }); }
        if (r.headland.length >= 2) lines.push({ coords: r.headland, color: "#1d4ed8", weight: 3 });
      } else {
        const r = calcDrip(f, d.p as DripP);
        const pal = ["#4CAF4F", "#20aae2", "#87bf59", "#f0b429", "#a855f7", "#ef4444"];
        r.sectors.forEach((s, k) => polys.push({ ring: s.ring, color: pal[k % pal.length], label: `${t("Settore")} ${s.i} · ${fmt(s.areaHa, { maximumFractionDigits: 1 })} ha`, dashed: preview }));
        for (const sm of r.submains) lines.push({ coords: sm, color: "#1d4ed8", weight: 2 });
      }
    };
    for (const [k, d] of Object.entries(sysDesigns)) { const f = fieldOfKey(k); if (f && !(active && f.id === active.id && tab === "impianti" && irrigSys !== "pivot")) add(f, d, false); }
    if (active && tab === "impianti" && irrigSys !== "pivot") {
      add(active, { sys: irrigSys, p: irrigSys === "lineari" ? linP : irrigSys === "rotoloni" ? rotP : dripP }, !sysDesigns[sysKey(active)] || sysDesigns[sysKey(active)].sys !== irrigSys);
    }
    return { polys, lines };
  }
  useEffect(() => {
    const m = mapApi.current; if (!m) return;
    const it = sysDrawItems();
    m.setDesign?.(it.polys.length || it.lines.length ? it : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sysDesigns, fields, active, tab, irrigSys, linP, rotP, dripP, mmDes, hoursDay, lang]);
  // Apre i parametri salvati quando si passa a un campo che ne ha.
  useEffect(() => {
    if (!active) return;
    const d = sysDesigns[sysKey(active)];
    if (!d) return;
    if (d.sys === "lineari") setLinP(d.p as LinP); else if (d.sys === "rotoloni") setRotP(d.p as RotP); else setDripP(d.p as DripP);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);
  function renderSystems() {
    if (!active) return <p className="text-[12px] text-sage-dark bg-panel rounded-lg px-3 py-4 text-center">{t("Seleziona un'area o un campo a sinistra.")}</p>;
    const sys = irrigSys as SysKind;
    const key = sysKey(active), saved = sysDesigns[key];
    const num = (label: string, v: number, set: (x: number) => void, step = 1, min = 0, max = 1e9) => (
      <label className="text-[11px] text-sage-dark">{label}
        <input type="number" min={min} max={max} step={step} value={v}
          onChange={(e) => { const x = Number(e.target.value); if (Number.isFinite(x)) set(Math.max(min, Math.min(max, x))); }} className="field-input mt-0.5 py-1 text-sm" /></label>
    );
    const azCtl = (az: number | null, set: (a: number | null) => void) => (
      <div className="col-span-2 flex items-end gap-2">
        <label className="flex items-center gap-2 text-[11px] text-sage-dark pb-1.5 flex-1">
          <input type="checkbox" checked={az == null} onChange={(e) => set(e.target.checked ? null : 0)} />{t("Orientamento automatico (lato lungo)")}</label>
        {az != null && <label className="text-[11px] text-sage-dark flex-1">{t("Azimut (°)")}
          <input type="number" min={0} max={179} step={1} value={az} onChange={(e) => set(((Number(e.target.value) % 180) + 180) % 180)} className="field-input mt-0.5 py-1 text-sm" /></label>}
      </div>
    );
    const box = (rows: [string, string][]) => (
      <table className="w-full text-[11px] bg-panel rounded-lg"><tbody>
        {rows.map((r, i) => <tr key={i}><td className="text-sage-dark px-2 py-0.5">{r[0]}</td><td className="text-right text-brand-darker font-semibold px-2 py-0.5 tabular-nums">{r[1]}</td></tr>)}
      </tbody></table>
    );
    let body: React.ReactNode = null;
    if (sys === "lineari") {
      const r = calcLin(active, linP);
      const c = r.machines.map((m) => spanComposition({ r: m.L, q: m.qLs }, pivotBrand, true));
      body = (<>
        <div className="grid grid-cols-2 gap-2">
          {num(t("Lunghezza massima della macchina (m)"), linP.maxLen, (x) => setLinP({ ...linP, maxLen: x }), 10, 50, 1500)}
          {num(t("Corsa minima (m)"), linP.minTravel, (x) => setLinP({ ...linP, minTravel: x }), 10, 0, 5000)}
          {azCtl(linP.az, (a) => setLinP({ ...linP, az: a }))}
        </div>
        {box([
          [t("Macchine"), fmt(r.machines.length)],
          [t("Superficie irrigata"), `${fmt(r.ha, { maximumFractionDigits: 1 })} ha / ${fmt(r.fieldHa, { maximumFractionDigits: 1 })} ha`],
          [t("Portata totale"), `${fmt(Math.round(r.qLs))} l/s`],
          [t("Direzione di marcia"), `${fmt(Math.round(r.az))}°`],
          [t("Pressione alla macchina"), `${fmt(Math.max(...r.machines.map((m) => m.pMach), 0), { maximumFractionDigits: 2 })} bar`],
          [t("Prevalenza all'ingresso del campo"), `${fmt(Math.round(r.head))} m`],
        ])}
        <div className="text-[11px] text-sage-dark space-y-0.5">
          {r.machines.map((m, i) => (
            <div key={i}>• L{m.i}: <b>{fmt(Math.round(m.L))} m</b> × {t("corsa")} {fmt(Math.round(m.travel))} m · {fmt(m.areaHa, { maximumFractionDigits: 1 })} ha · {fmt(Math.round(m.qLs))} l/s{c[i] ? ` · ${c[i]!.spans.length} ${t("campate")}` : ""} · {t("idranti")} DN {m.dn} ({t("perdite")} {fmt(Math.round(m.hfMain))} m)</div>
          ))}
        </div>
        <p className="text-[10px] text-sage-dark leading-snug">{t("Alimentazione da canale o tubo flessibile lungo un bordo della corsa (tratteggio blu). Le campate seguono il produttore scelto per i pivot.")}</p>
      </>);
    } else if (sys === "rotoloni") {
      const r = calcRot(active, rotP);
      body = (<>
        <div className="grid grid-cols-2 gap-2">
          {num(t("Gittata dell'irrigatore (m)"), rotP.throw, (x) => setRotP({ ...rotP, throw: x }), 1, 10, 80)}
          {num(t("Portata dell'irrigatore (m³/h)"), rotP.gunQ, (x) => setRotP({ ...rotP, gunQ: x }), 1, 5, 200)}
          {num(t("Interasse delle corsie (% del diametro bagnato)"), rotP.spacingPct, (x) => setRotP({ ...rotP, spacingPct: x }), 5, 40, 100)}
          {num(t("Lunghezza del tubo (m)"), rotP.hoseLen, (x) => setRotP({ ...rotP, hoseLen: x }), 10, 50, 1000)}
          {num(t("Altezza d'acqua per passaggio (mm)"), rotP.depth, (x) => setRotP({ ...rotP, depth: x }), 1, 5, 100)}
          {azCtl(rotP.az, (a) => setRotP({ ...rotP, az: a }))}
        </div>
        {box([
          [t("Corsie · tirate"), `${fmt(r.lanes)} · ${fmt(r.runs.length)}`],
          [t("Interasse delle corsie"), `${fmt(Math.round(r.spacing))} m`],
          [t("Superficie irrigata"), `${fmt(r.coveredHa, { maximumFractionDigits: 1 })} ha / ${fmt(r.fieldHa, { maximumFractionDigits: 1 })} ha`],
          [t("Turno irriguo"), `${fmt(r.cycleDays, { maximumFractionDigits: 1 })} ${t("giorni")}`],
          [t("Ore di lavoro per turno"), `${fmt(Math.round(r.totH))} h`],
          [t("Rotoloni necessari"), fmt(r.nMach)],
          [t("Portata totale"), `${fmt(Math.round(r.qLs))} l/s`],
          [t("Intensità di pioggia"), `${fmt(r.rateMmH, { maximumFractionDigits: 1 })} mm/h`],
          [t("Tubo della macchina"), `PE Ø${r.hoseMm} · ${t("perdite")} ${fmt(Math.round(r.hfHose))} m`],
          [t("Prevalenza all'idrante"), `${fmt(Math.round(r.hHyd))} m (${t("cannone")} ${fmt(r.pGun)} bar)`],
          [t("Condotta di testata"), `DN ${r.dn} · ${fmt(r.mainLen)} m · ${fmt(r.hydrants)} ${t("idranti")}`],
          [t("Prevalenza all'ingresso del campo"), `${fmt(Math.round(r.head))} m`],
        ])}
        {r.rateMmH > infiltration && <p className="text-[11px] text-rust">{t("L'intensità supera l'assorbimento del terreno ({i} mm/h): rischio di ruscellamento, riduci la portata o aumenta la gittata.", { i: fmt(infiltration) })}</p>}
      </>);
    } else {
      const r = calcDrip(active, dripP);
      body = (<>
        <div className="grid grid-cols-2 gap-2">
          {num(t("Interfila delle ali (m)"), dripP.latSp, (x) => setDripP({ ...dripP, latSp: x }), 0.1, 0.2, 10)}
          {num(t("Distanza tra gocciolatori (m)"), dripP.emSp, (x) => setDripP({ ...dripP, emSp: x }), 0.05, 0.1, 2)}
          {num(t("Portata del gocciolatore (l/h)"), dripP.emQ, (x) => setDripP({ ...dripP, emQ: x }), 0.1, 0.3, 8)}
          {num(t("Lunghezza massima dell'ala (m)"), dripP.latMax, (x) => setDripP({ ...dripP, latMax: x }), 10, 20, 500)}
          <label className="text-[11px] text-sage-dark col-span-2">{t("Settori")}
            <select className="field-input mt-0.5 py-1 text-sm" value={dripP.sectors} onChange={(e) => setDripP({ ...dripP, sectors: Number(e.target.value) })}>
              <option value={0}>{t("Automatico ({n})", { n: r.auto })}</option>
              {Array.from({ length: 24 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
            </select></label>
          {azCtl(dripP.az, (a) => setDripP({ ...dripP, az: a }))}
        </div>
        {box([
          [t("Superficie"), `${fmt(r.fieldHa, { maximumFractionDigits: 1 })} ha`],
          [t("Intensità di erogazione"), `${fmt(r.rate, { maximumFractionDigits: 2 })} mm/h`],
          [t("Ore per settore"), `${fmt(r.hSec, { maximumFractionDigits: 1 })} h`],
          [t("Settori"), `${fmt(r.nSec)} (${fmt(r.hoursUsed, { maximumFractionDigits: 1 })} h/${t("giorno")})`],
          [t("Portata del settore più grande"), `${fmt(Math.round(r.qLs))} l/s`],
          [t("Ali gocciolanti"), `${fmt(Math.round(r.latM / 1000))} km`],
          [t("Gocciolatori"), fmt(Math.round(r.emitters))],
          [t("Condotte secondarie"), `${fmt(Math.round(r.subLen))} m · DN ${r.dnSub}`],
          [t("Perdite: ala · secondaria"), `${fmt(r.hfLat, { maximumFractionDigits: 1 })} · ${fmt(r.hfSub, { maximumFractionDigits: 1 })} m`],
          [t("Condotta di settore"), `DN ${r.dnMain}`],
          [t("Prevalenza all'ingresso del campo"), `${fmt(Math.round(r.head))} m (${t("gocciolatori")} ${fmt(r.pEm)} bar + ${t("filtri e valvola")} 7 m)`],
        ])}
        {!r.ok && <p className="text-[11px] text-rust">{t("Con {n} settori servono {h} h al giorno, più delle ore di esercizio: riduci i settori o aumenta la portata dei gocciolatori.", { n: r.nSec, h: fmt(r.hoursUsed, { maximumFractionDigits: 1 }) })}</p>}
      </>);
    }
    return (
      <div className="space-y-2">
        <p className="text-[11px] text-sage-dark">{t("Campo")}: <b className="text-brand-darker">{active.name}</b> · {t("fabbisogno")} {fmt(mmDes, { maximumFractionDigits: 1 })} mm/{t("giorno")} · {fmt(hoursDay)} h/{t("giorno")}</p>
        {body}
        <div className="flex gap-2">
          <button className="btn-primary flex-1 basis-0" onClick={() => setSysDesigns((d) => ({ ...d, [key]: { sys, p: sys === "lineari" ? linP : sys === "rotoloni" ? rotP : dripP } }))}>
            {saved && saved.sys === sys ? t("Aggiorna sul campo") : t("Salva sul campo")}</button>
          {saved && <button className="btn-ghost flex-1 basis-0" onClick={() => setSysDesigns((d) => { const n = { ...d }; delete n[key]; return n; })}>{t("Togli dal campo")}</button>}
        </div>
        {saved && saved.sys !== sys && <p className="text-[10px] text-sage-dark">{t("Su questo campo è salvato un altro sistema: salvando lo sostituisci.")}</p>}
      </div>
    );
  }
  // ---- Impostazioni di progetto salvate sul server ---------------------------
  // Produttore dei pivot e fonte d'acqua (presa, tracciato, livelli, parametri)
  // viaggiano con il progetto: si ritrovano su qualunque computer.
  const projLoaded = useRef<number | null>(null);
  const projSaved = useRef<string>("");
  const fonteState = () => ({ pt: srcPt, route: srcRoute, type: srcType, qmax: srcQmax, hours: srcHours, range: srcRange,
    sed: srcSediment, energy: srcEnergy, monthly: srcMonthly, sectors: srcSectors, resDepth, resDays, resEvapK, eta: wtwEta,
    canalSlope, bankSlope, settleMm, filterCap, wellQ, shown: srcShown });
  useEffect(() => {
    if (projectId == null) { projLoaded.current = null; return; }
    if (projLoaded.current === projectId) return;
    const pr = projects.find((p) => p.id === projectId); if (!pr) return;
    const st = (pr.settings ?? {}) as { pivot_brand?: string; fonte?: Record<string, unknown> };
    let brand = st.pivot_brand as PivotBrand | undefined;
    if (!brand) { try { brand = (window.localStorage.getItem(`argus.pivotBrand.${projectId}`) as PivotBrand | null) ?? undefined; } catch { /* */ } }
    setPivotBrand(brand && brand in PIVOT_BRANDS ? brand : "starpivot");
    const fo = (st.fonte ?? {}) as Record<string, unknown>;
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    const ty = (["fiume", "canale", "pozzo", "invaso"].includes(fo.type as string) ? fo.type : "fiume") as SrcType;
    setSrcPt(Array.isArray(fo.pt) ? (fo.pt as number[]) : null);
    setSrcRoute(Array.isArray(fo.route) ? (fo.route as number[][]) : null);
    setSrcType(ty); setSrcQmax(num(fo.qmax, 0)); setSrcHours(num(fo.hours, 24)); setSrcRange(num(fo.range, SRC_RANGE_DEF[ty]));
    setSrcSediment(typeof fo.sed === "boolean" ? fo.sed : ty === "fiume");
    setSrcEnergy((["rete", "fv-gen", "fv-batt"].includes(fo.energy as string) ? fo.energy : "rete") as "rete" | "fv-gen" | "fv-batt");
    setSrcMonthly(Array.isArray(fo.monthly) && (fo.monthly as unknown[]).length === 12 ? (fo.monthly as number[]) : null);
    setSrcSectors(num(fo.sectors, 0)); setResDepth(num(fo.resDepth, 4)); setResDays(num(fo.resDays, 3)); setResEvapK(num(fo.resEvapK, 1.1));
    setWtwEta(num(fo.eta, 75)); setCanalSlope(num(fo.canalSlope, 0.3)); setBankSlope(num(fo.bankSlope, 2));
    setSettleMm(num(fo.settleMm, 0.1)); setFilterCap(num(fo.filterCap, 400)); setWellQ(num(fo.wellQ, 30));
    setSrcShown(typeof fo.shown === "string" ? fo.shown : null); setSrcElev(null);
    const te = (st as { terrain?: { dem?: string; smooth?: number } }).terrain ?? {};
    setDemModel(te.dem === "COPERNICUS_90" ? "COPERNICUS_90" : "COPERNICUS_30"); setDemSmooth(num(te.smooth, 100));
    setSpanVmax(num((st as { span_vmax?: number }).span_vmax, 3));
    const sy = (st as { systems?: Record<string, SysDesign> }).systems;
    setSysDesigns(sy && typeof sy === "object" ? sy : {});
    projSaved.current = "";   // il primo salvataggio allinea le chiavi mancanti
    projLoaded.current = projectId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, projects]);
  useEffect(() => {
    if (projectId == null || projLoaded.current !== projectId) return;
    const payload = { pivot_brand: pivotBrand, span_vmax: spanVmax, fonte: fonteState(), terrain: { dem: demModel, smooth: demSmooth },
      systems: Object.fromEntries(Object.entries(sysDesigns).filter(([k]) => k.startsWith("a"))) };
    const js = JSON.stringify(payload);
    if (js === projSaved.current) return;
    const pid = projectId;
    const h = window.setTimeout(() => {
      api.updateProject(pid, { settings: payload } as Partial<api.Project>)
        .then((pr) => { projSaved.current = js; setProjects((ps) => ps.map((p) => (p.id === pid ? { ...p, settings: pr.settings } : p))); })
        .catch(() => { /* riprova alla prossima modifica */ });
    }, 900);
    return () => window.clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pivotBrand, srcPt, srcRoute, srcType, srcQmax, srcHours, srcRange, srcSediment, srcEnergy, srcMonthly, srcSectors,
    resDepth, resDays, resEvapK, wtwEta, canalSlope, bankSlope, settleMm, filterCap, wellQ, srcShown, demModel, demSmooth, spanVmax, sysDesigns]);
  // ---- FONTE D'ACQUA → SCHEMI D'IMPIANTO ----------------------------------
  // L'utente indica la presa (fiume, canale, pozzo, invaso) e, se vuole, il
  // tracciato fino alla vasca. Con le quote del DEM (presa, profilo del
  // tracciato, vasca, ogni pivot) si confrontano schemi alternativi:
  //  A pompaggio diretto in pressione · B sollevamento + vasca + rilancio ·
  //  C canale a gravità + vasca + rilancio (solo se la presa è abbastanza alta).
  // Il rilancio può essere diviso in settori (ognuno spinge solo fino al suo
  // pivot più alto). Ogni schema è valutato per l'alimentazione scelta (rete,
  // FV con generatore, FV con batterie) con criteri solo tecnici.
  const SRC_RANGE_DEF: Record<SrcType, number> = { fiume: 4, canale: 0.5, pozzo: 40, invaso: 3 };
  const llDist = (a: number[], b: number[]) => {
    const kx = 111320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180), ky = 110540;
    return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * ky);
  };
  const lineLen = (ln: number[][]) => ln.reduce((a, p, i) => (i ? a + llDist(ln[i - 1], p) : 0), 0);
  // Vasca di accumulo: in fondo al tracciato disegnato, altrimenti accanto al
  // pivot più vicino alla presa, verso la presa.
  function reservoirSpot(src: number[], ignoreRoute = false): number[] | null {
    if (!pivots.length) return null;
    if (!ignoreRoute && srcRoute && srcRoute.length >= 2) return srcRoute[srcRoute.length - 1];
    const near = pivots.reduce((a, p) => (llDist([p.lng, p.lat], src) < llDist([a.lng, a.lat], src) ? p : a));
    const d = llDist([near.lng, near.lat], src); if (d < 1) return [near.lng, near.lat];
    const off = Math.min(d * 0.9, near.r + 250);
    const t = off / d;
    return [near.lng + (src[0] - near.lng) * t, near.lat + (src[1] - near.lat) * t];
  }
  // Tracciato presa → vasca: quello disegnato (con il primo punto sulla presa)
  // oppure la linea retta.
  function srcLine(src: number[]): number[][] | null {
    const R = reservoirSpot(src); if (!R) return null;
    return srcRoute && srcRoute.length >= 2 ? [src, ...srcRoute.slice(1)] : [src, R];
  }
  // Punti di campionamento del profilo lungo il tracciato (~60 tratti).
  function samplePath(ln: number[][]): { pts: number[][]; d: number[] } {
    const L = lineLen(ln), step = Math.max(25, L / 60);
    const pts: number[][] = [ln[0]], d: number[] = [0];
    let acc = 0;
    for (let i = 1; i < ln.length; i++) {
      const a = ln[i - 1], b = ln[i], seg = llDist(a, b);
      for (let s2 = step - (acc % step); s2 < seg; s2 += step) {
        const u = s2 / seg; pts.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]); d.push(acc + s2);
      }
      acc += seg; pts.push(b); d.push(acc);
    }
    return { pts, d };
  }
  const elevKey = (src: number[]) => JSON.stringify([src, srcRoute, pivots.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(";")]);
  function startPickSource() {
    setSrcPicking(true);
    mapApi.current?.pickPoint((lat, lng) => { setSrcPicking(false); setSrcRoute(null); setSrcPt([lng, lat]); });
  }
  // Tracciato proposto dal sistema: condotta (strade e bordi dei campi, meno
  // risalite, fuori dai cerchi) o canale a gravità (pendenza costante).
  async function proposeRoute(kind: "pipe" | "canal") {
    if (!srcPt) return;
    const dst = srcRoute && srcRoute.length >= 2 ? srcRoute[srcRoute.length - 1] : reservoirSpot(srcPt, true);
    if (!dst) return;
    setBusy("route");
    try {
      const r = await api.autoRoute({ src: srcPt, dst, mode: kind,
        roads: roads.filter((x) => !x.hidden && x.coords.length >= 2).map((x) => x.coords),
        edges: fields.map((f) => f.geom.coordinates[0]),
        circles: pivots.map((p) => [p.lng, p.lat, p.r]), target_permille: canalSlope });
      setSrcRoute(r.coords);
      setMsg(kind === "canal"
        ? t("Canale proposto: {km} km, scavo massimo {c} m, rilevato massimo {f} m ✓", { km: fmt(r.length_m / 1000, { maximumFractionDigits: 2 }), c: fmt(r.cut_max_m, { maximumFractionDigits: 1 }), f: fmt(r.fill_max_m, { maximumFractionDigits: 1 }) })
        : t("Condotta proposta: {km} km, quota massima {z} m ✓", { km: fmt(r.length_m / 1000, { maximumFractionDigits: 2 }), z: fmt(Math.round(r.z_max ?? 0)) }));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function startDrawRoute() {
    if (!srcPt) return;
    setSrcDrawing(true);
    mapApi.current?.drawRoadManual((coords) => {
      setSrcDrawing(false);
      if (coords.length >= 2) setSrcRoute([srcPt, ...coords.slice(1)]);
    });
    setMsg(t("Traccia il percorso dalla presa alla vasca: clic per i vertici, doppio clic sulla posizione della vasca."));
  }
  useEffect(() => {
    if (!srcPicking) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { mapApi.current?.pickPoint(null); setSrcPicking(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [srcPicking]);
  // Quote: presa, vasca, ogni pivot e profilo del tracciato, in una sola richiesta.
  useEffect(() => {
    if (!srcPt || !pivots.length) return;
    const key = elevKey(srcPt);
    if (srcElev?.key === key) return;
    const ln = srcLine(srcPt); if (!ln) return;
    const R = ln[ln.length - 1];
    const prof = samplePath(ln);
    let stop = false;
    setBusy("fonte");
    api.fetchElevation([srcPt, R, ...pivots.map((p) => [p.lng, p.lat]), ...prof.pts])
      .then((res) => {
        if (stop) return;
        const z = res.points.map((q) => (q.elev_m == null ? null : Number(q.elev_m)));
        const zPiv = z.slice(2, 2 + pivots.length);
        const zp = zPiv.filter((v): v is number => v != null);
        setSrcElev({ zS: z[0], zR: z[1], zPmax: zp.length ? Math.max(...zp) : null, zPiv,
          prof: { d: prof.d, z: z.slice(2 + pivots.length) }, key });
      })
      .catch((e) => { if (!stop) { showErr(e); setSrcElev(null); } })
      .finally(() => { if (!stop) setBusy(""); });
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcPt, srcRoute, pivots]);
  const DN_MAIN = [110, 125, 160, 200, 250, 315, 400, 500, 630, 710, 800, 900, 1000, 1200, 1400, 1600];
  function sizeMain(qLs: number, L: number) {
    const Q = qLs / 1000;
    let n = 1, dn = DN_MAIN[DN_MAIN.length - 1];
    for (;;) {
      const fit = DN_MAIN.find((d) => (Q / n) / (Math.PI * Math.pow(d / 1000, 2) / 4) <= vMax);
      if (fit) { dn = fit; break; }
      n++;
    }
    const D = dn / 1000, q1 = Q / n;
    const hf = (10.67 * L * Math.pow(q1, 1.852)) / (Math.pow(Math.max(60, hwC), 1.852) * Math.pow(D, 4.87));
    return { dn, n, hf };
  }
  // Settori di rilancio: k-medie sulle posizioni dei pivot (settori contigui).
  function sectorize(k: number): number[] {
    const n = pivots.length; if (k <= 1 || n <= 1) return pivots.map(() => 0);
    const P2 = pivots.map((p) => [p.lng * Math.cos((p.lat * Math.PI) / 180), p.lat]);
    // semi: il primo è il pivot più a ovest, poi il più lontano dai semi già scelti
    const seeds = [P2.reduce((a, p, i) => (p[0] < P2[a][0] ? i : a), 0)];
    while (seeds.length < Math.min(k, n)) {
      let bi = 0, bd = -1;
      P2.forEach((p, i) => { const d = Math.min(...seeds.map((s2) => Math.hypot(p[0] - P2[s2][0], p[1] - P2[s2][1]))); if (d > bd) { bd = d; bi = i; } });
      seeds.push(bi);
    }
    let C = seeds.map((s2) => P2[s2].slice());
    let lab = pivots.map(() => 0);
    for (let it = 0; it < 30; it++) {
      lab = P2.map((p) => C.reduce((a, c, j) => (Math.hypot(p[0] - c[0], p[1] - c[1]) < Math.hypot(p[0] - C[a][0], p[1] - C[a][1]) ? j : a), 0));
      C = C.map((c, j) => { const m = P2.filter((_, i) => lab[i] === j); return m.length ? [m.reduce((a, p) => a + p[0], 0) / m.length, m.reduce((a, p) => a + p[1], 0) / m.length] : c; });
    }
    return lab;
  }
  type Stage = { name: string; qLs: number; head: number; kW: number; hours: number; hAvg?: number; share?: number };
  type Sector = { i: number; n: number; qLs: number; head: number; kW: number; zTop: number | null; center: number[] };
  type Scheme = { key: "A" | "B" | "C"; name: string; ok: boolean; why?: string; stages: Stage[];
    main?: { kind: "pipe" | "canal"; L: number; dn?: number; n?: number; hf?: number; hiPt?: number; cutMax?: number; fillMax?: number };
    res?: { vol: number; ha: number; r: number; evap: number; days: number }; sectors?: Sector[];
    mwh: number; kWabs: number; pvKwp: number; battKwh: number; solarPct: number; nStations: number };
  function sourceSchemes() {
    if (!srcPt || !pivots.length) return null;
    const P = pumpStation();
    const ln = srcLine(srcPt)!;
    const R = ln[ln.length - 1];
    const eta = Math.max(0.3, wtwEta / 100);
    const hd = Math.max(1, Math.min(24, hoursDay));
    // Fabbisogno di punta: ettari irrigati × ETc della coltura più esigente
    // (meno la pioggia utile, diviso l'efficienza); mai sotto le portate dei pivot.
    const VdayCrop = P.irrHa * 10 * mm24Suggested;                        // m³/giorno
    const Vday = Math.max(P.qDes * 3.6 * hd, VdayCrop);
    const Qd = Vday / 3.6 / hd;                                           // l/s ai pivot
    const eRes = Math.max(0, resEvapK) * et0Peak;                          // mm/g evaporati dalla vasca
    const pMaxBar = pivots.length ? Math.max(...pivots.map((p) => pivotPressure(p))) : 0;
    const Hd = Math.max(hydra ? hydra.headMax : pMaxBar * 10.2 + Math.max(0, psHeadExtra), sysTotals().headMax);   // prevalenza della distribuzione (pivot e altri sistemi)
    const E = srcElev && srcElev.key === elevKey(srcPt) ? srcElev : null;
    const zS = E?.zS ?? null, zR = E?.zR ?? null, zP = E?.zPmax ?? null;
    // Livello minimo: con i livelli mese per mese vale il più basso dei mesi
    // irrigui (fabbisogno netto > 0); altrimenti l'escursione unica.
    const netMm = P.netMm;
    const irrMonths = netMm ? netMm.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0) : [...Array(12).keys()];
    const months = srcMonthly && srcMonthly.length === 12 ? srcMonthly : null;
    const drop = months ? Math.max(...(irrMonths.length ? irrMonths : [...Array(12).keys()]).map((i) => months[i])) : srcRange;
    // Quota media pesata sui volumi mensili: la prevalenza media cala quando il fiume è alto.
    const wSum = netMm ? netMm.reduce((a, x) => a + x, 0) : 0;
    const dropAvg = months ? (wSum > 0 ? months.reduce((a, d, i) => a + d * netMm![i], 0) / wSum : months.reduce((a, d) => a + d, 0) / 12) : drop;
    const zLow = zS != null ? zS - drop : null;
    const L = srcRoute ? lineLen(ln) : lineLen(ln) * 1.1;                // linea retta: +10% di tracciato
    const prof = E?.prof ?? null;
    const psh = Math.max(0.5, pvPsh ?? (fields.map((f) => (f.lay as { solar?: { psh_design?: number } } | null | undefined)?.solar?.psh_design).find((x) => x) ?? 6));
    const sunH = Math.max(1, Math.min(14, pvSunH));
    const solar = srcEnergy !== "rete";
    const kWof = (qLs: number, H: number) => (qLs * H * 9.81) / 1000 / eta;
    const mwhOf = (H: number) => (P.volYear * H) / 367 / eta / 1000;
    const qMaxOk = (q: number) => !(srcQmax > 0 && q > srcQmax * 1.0001);
    // Prevalenza di una condotta in pressione dalla presa: la linea dei carichi
    // deve restare ≥ 2 m sopra il profilo in ogni punto (colmi del tracciato),
    // e arrivare alla quota zEnd con il carico residuo hEnd.
    const pipeHead = (hf: number, zEnd: number | null, hEnd: number) => {
      if (zLow == null || zEnd == null) return { H: Math.max(0, psLift) + hf + hEnd, hiPt: 0 };
      let H = zEnd + hEnd + hf - zLow, hiPt = 0;
      if (prof && prof.d.length > 1) {
        const Lp = prof.d[prof.d.length - 1] || 1;
        prof.z.forEach((z, i) => {
          if (z == null) return;
          const need = z + 2 + (hf * prof.d[i]) / Lp - zLow;
          if (need > H) { H = need; hiPt = z; }
        });
      }
      return { H: Math.max(0, H), hiPt };
    };
    // Vasca: compenso giornaliero fra ore di riempimento e ore di irrigazione,
    // più i giorni di scorta (consumo + evaporazione). L'evaporazione dipende
    // dallo specchio d'acqua, che dipende dal volume: si itera.
    const res = (hIn: number) => {
      const depth = Math.max(1, resDepth);
      let vol = Vday, evap = 0;
      for (let k = 0; k < 8; k++) {
        evap = (vol / depth) * eRes / 1000;                               // m³/g dallo specchio pieno
        vol = (Vday + evap) * (1 - Math.min(hIn, hd) / Math.max(hIn, hd)) + Math.max(0, resDays) * (Vday + evap);
      }
      const areaM2 = (vol / depth) * 1.25;                                // + argini
      return { vol, ha: areaM2 / 10000, r: Math.sqrt(areaM2 / Math.PI), evap, days: Math.max(0, resDays) };
    };
    // Rilancio dalla vasca diviso in k settori: ognuno spinge fino al proprio pivot più alto.
    const zPiv = E?.zPiv ?? null;
    const sectorsFor = (k: number): Sector[] => {
      const lab = sectorize(k), kk = Math.max(...lab) + 1;
      const out2: Sector[] = [];
      for (let j = 0; j < kk; j++) {
        const idx = pivots.map((_, i) => i).filter((i) => lab[i] === j); if (!idx.length) continue;
        const flow = idx.reduce((a, i) => a + pivotFlow(pivots[i]), 0);
        const qLs = (Qd * flow) / Math.max(1e-9, P.qDes);                 // quota del fabbisogno di punta
        const zs = zPiv ? idx.map((i) => zPiv[i]).filter((v): v is number => v != null) : [];
        const zTop = zs.length ? Math.max(...zs) : zP;
        const head = Hd + (zTop != null && zR != null ? Math.max(0, zTop - zR) : 0);
        out2.push({ i: out2.length + 1, n: idx.length, qLs, head, kW: kWof(qLs, head), zTop,
          center: [idx.reduce((a, i) => a + pivots[i].lng, 0) / idx.length, idx.reduce((a, i) => a + pivots[i].lat, 0) / idx.length] });
      }
      return out2;
    };
    const kMax = Math.min(6, pivots.length);
    const sectorOpts = Array.from({ length: kMax }, (_, i) => sectorsFor(i + 1));
    const sEnergy = (ss: Sector[]) => ss.reduce((a, x) => a + x.qLs * x.head, 0);
    // Automatico: il numero minimo di settori che dà almeno il 90% del risparmio
    // massimo, purché il risparmio rispetto a un solo settore superi il 5%.
    let kAuto = 1;
    if (sectorOpts.length > 1) {
      const e1 = sEnergy(sectorOpts[0]), eMin = Math.min(...sectorOpts.map(sEnergy));
      if (e1 > 0 && (e1 - eMin) / e1 > 0.05) kAuto = sectorOpts.findIndex((ss) => e1 - sEnergy(ss) >= 0.9 * (e1 - eMin)) + 1;
    }
    const kUse = srcSectors > 0 ? Math.min(srcSectors, kMax) : kAuto;
    const secs = sectorOpts[kUse - 1] ?? sectorsFor(1);
    const secSave = sectorOpts.length ? 1 - sEnergy(secs) / Math.max(1e-9, sEnergy(sectorOpts[0])) : 0;
    const boosterStages = (): Stage[] => secs.length > 1
      ? secs.map((x) => ({ name: tx("Rilancio settore {i} ({n} pivot)", { i: x.i, n: x.n }), qLs: x.qLs, head: x.head, kW: x.kW, hours: hd, share: x.qLs / Math.max(1e-9, Qd) }))
      : [{ name: tx("Rilancio dalla vasca ai pivot"), qLs: Qd, head: secs[0]?.head ?? Hd, kW: kWof(Qd, secs[0]?.head ?? Hd), hours: hd }];
    // energia: quota diurna (copribile dal FV) e notturna
    const finish = (sc: Omit<Scheme, "mwh" | "kWabs" | "pvKwp" | "battKwh" | "solarPct">): Scheme => {
      let mwh = 0, kWabs = 0, kWday = 0, eDayKwh = 0, eSunKwh = 0;
      for (const st of sc.stages) {
        mwh += mwhOf(st.hAvg ?? st.head) * (st.share ?? 1);                // settori: quota del volume annuo
        kWabs += st.kW; kWday += st.kW;
        eDayKwh += st.kW * st.hours;                                       // kWh nel giorno di punta
        eSunKwh += st.kW * Math.min(st.hours, sunH);                       // di cui nelle ore di sole
      }
      let pvKwp = 0, battKwh = 0, solarPct = 0;
      if (solar && eDayKwh > 0) {
        const dayShare = eSunKwh / eDayKwh;
        if (srcEnergy === "fv-gen") {
          pvKwp = Math.max((eDayKwh * dayShare) / (psh * 0.75), 1.25 * kWday);
          solarPct = dayShare * 100;
        } else {
          const night = eDayKwh * (1 - dayShare);
          pvKwp = Math.max((eDayKwh * dayShare + night / 0.9) / (psh * 0.75), 1.25 * kWday);
          battKwh = night / 0.8;
          solarPct = 100;
        }
      }
      return { ...sc, mwh, kWabs, pvKwp, battKwh, solarPct };
    };
    const out: Scheme[] = [];
    // A — pompaggio diretto
    {
      const hours = hd;
      const m = sizeMain(Qd, L);
      const ph = pipeHead(m.hf, zP, Hd + 2);
      const H = ph.H;
      let ok = true, why: string | undefined;
      if (srcHours < hd) { ok = false; why = tx("La fonte è disponibile {a} h al giorno, i pivot lavorano {b} h: serve un accumulo.", { a: fx(srcHours), b: fx(hd) }); }
      else if (!qMaxOk(Qd)) { ok = false; why = tx("Servono {q} l/s, la fonte ne dà {m}.", { q: fx(Math.round(Qd)), m: fx(srcQmax) }); }
      else if (srcEnergy === "fv-gen" && hd > sunH) { why = tx("Di notte le pompe vanno a generatore: senza accumulo il sole copre solo le ore diurne."); }
      out.push(finish({ key: "A", name: tx("Pompaggio diretto in pressione"), ok, why, nStations: 1,
        stages: [{ name: tx("Stazione di presa e spinta"), qLs: Qd, head: H, kW: kWof(Qd, H), hours, hAvg: H - (drop - dropAvg) }],
        main: { kind: "pipe", L, dn: m.dn, n: m.n, hf: m.hf, hiPt: ph.hiPt } }));
    }
    // B — sollevamento + vasca + rilancio
    {
      const h1 = Math.min(srcHours, solar ? sunH : 22);
      const rB = res(h1);
      const q1 = (Vday + rB.evap) / 3.6 / Math.max(1, h1);                 // la presa reintegra anche l'evaporato
      const m = sizeMain(q1, L);
      const ph = pipeHead(m.hf, zR != null ? zR + 3 : null, 2);
      const H1 = ph.H;
      let ok = true, why: string | undefined;
      if (!qMaxOk(q1)) {
        const need = (Vday + rB.evap) / 3.6 / Math.max(1, srcQmax);
        if (need > srcHours) { ok = false; why = tx("La fonte non basta: servono {h} h di prelievo al giorno a {m} l/s.", { h: fx(Math.round(need)), m: fx(srcQmax) }); }
        else why = tx("Con {m} l/s disponibili la presa deve lavorare {h} h al giorno.", { m: fx(srcQmax), h: fx(Math.round(need)) });
      }
      const bst = boosterStages();
      out.push(finish({ key: "B", name: tx("Sollevamento, vasca di accumulo e rilancio"), ok, why, nStations: 1 + bst.length,
        stages: [{ name: tx("Presa e sollevamento alla vasca"), qLs: q1, head: H1, kW: kWof(q1, H1), hours: h1, hAvg: H1 - (drop - dropAvg) }, ...bst],
        main: { kind: "pipe", L, dn: m.dn, n: m.n, hf: m.hf, hiPt: ph.hiPt }, res: rB, sectors: secs.length > 1 ? secs : undefined }));
    }
    // C — canale a gravità + vasca + rilancio
    {
      const s = Math.max(0.05, canalSlope) / 1000;
      const need = L * s + 1;                                              // dislivello minimo per il canale
      const avail = zLow != null && zR != null ? zLow - zR : null;
      const hIn = Math.min(srcHours, 24);
      // profilo: pelo libero da zLow con pendenza s; scavo dove il terreno è più
      // alto (+ 0,5 m di franco), rilevato dove è più basso.
      let cutMax = 0, fillMax = 0;
      if (prof && zLow != null) prof.z.forEach((z, i) => {
        if (z == null) return;
        const wl = zLow - s * prof.d[i] * (L / Math.max(1, prof.d[prof.d.length - 1]));
        cutMax = Math.max(cutMax, z - wl + 0.5); fillMax = Math.max(fillMax, wl + 0.5 - z);
      });
      let ok = srcType !== "pozzo" && avail != null && avail >= need, why: string | undefined;
      if (srcType === "pozzo") why = tx("Da pozzo non è possibile la gravità.");
      else if (avail == null) why = tx("Quote non disponibili: indica di nuovo la fonte.");
      else if (!ok) why = tx("Dislivello tra presa e vasca {d} m, ne servono almeno {n}: canale a gravità non possibile.", { d: fx(Math.round(avail)), n: fx(Math.round(need)) });
      else if (cutMax > 6) { ok = false; why = tx("Lungo il tracciato il canale andrebbe scavato fino a {m} m: serve un altro percorso o una condotta.", { m: fx(Math.round(cutMax)) }); }
      const rC = res(hIn);
      const qc = (Vday + rC.evap) / 3.6 / Math.max(1, hIn);
      if (ok && !qMaxOk(qc)) { ok = false; why = tx("Servono {q} l/s, la fonte ne dà {m}.", { q: fx(Math.round(qc)), m: fx(srcQmax) }); }
      const bst = boosterStages();
      out.push(finish({ key: "C", name: tx("Canale a gravità, vasca e rilancio"), ok, why, nStations: bst.length,
        stages: bst, main: { kind: "canal", L, cutMax, fillMax }, res: rC, sectors: secs.length > 1 ? secs : undefined }));
    }
    // Consigliato — rete: minor energia; FV + generatore: minor energia da
    // generatore; in entrambi entro il 3% vince lo schema con meno stazioni.
    // FV + batterie: entro il 10% di energia vince lo schema con meno kWh di
    // batterie (l'accumulo in acqua costa meno di quello elettrico), poi meno stazioni.
    const feas = out.filter((x) => x.ok);
    const score = (x: Scheme) => (srcEnergy === "fv-gen" ? x.mwh * (1 - x.solarPct / 100) : x.mwh);
    let best: Scheme | null = null;
    if (feas.length) {
      const mn = Math.min(...feas.map(score));
      if (srcEnergy === "fv-batt") {
        const band = feas.filter((x) => score(x) <= mn * 1.10 + 1);
        best = band.reduce((a, x) => (x.battKwh < a.battKwh * 0.97 || (x.battKwh <= a.battKwh * 1.03 && x.nStations < a.nStations) ? x : a));
      } else {
        const band = feas.filter((x) => score(x) <= mn * 1.03 + 1);
        best = band.reduce((a, x) => (x.nStations < a.nStations || (x.nStations === a.nStations && score(x) < score(a)) ? x : a));
      }
    }
    return { schemes: out, best, Qd, Vday, irrHa: P.irrHa, eRes, Hd, L, zS, zR, zP, zLow, R, ln, hasElev: !!E, psh, sunH,
      drop, dropAvg, months: !!months, kAuto, kUse, secSave, prof, netMm };
  }
  // Montaggio della presa e trattamento dell'acqua, dimensionati sulla portata di presa.
  function intakeAdvice(qIn: number, drop: number, qPiv: number, gravity: boolean): { text: string; rows: [string, string][] }[] {
    const out: { text: string; rows: [string, string][] }[] = [];
    if (gravity) {
      out.push({ text: tx("Presa a gravità: opera di presa con soglia, griglia e paratoia di regolazione all'imbocco del canale."),
        rows: [[tx("Griglia"), tx("superficie lorda {a} m² (0,6 m/s, luce libera 50%), con sgrigliatore", { a: fx(qIn / 1000 / 0.6 / 0.5, { maximumFractionDigits: 1 }) })]] });
    }
    const Q = qIn / 1000;                                                  // m³/s
    // pompe: in parallelo da ~250 l/s al massimo, più una di riserva
    const nDuty = Math.max(1, Math.ceil(qIn / 250)), qP = Q / nDuty;
    // campana di aspirazione a 1,0 m/s e sommergenza minima ANSI/HI 9.8: S = D (1 + 2,3 Fr)
    const Db = Math.sqrt((4 * qP) / (Math.PI * 1.0));
    const Fr = 1.0 / Math.sqrt(9.81 * Db);
    const Smin = Db * (1 + 2.3 * Fr);
    const depthMin = Smin + 0.5 * Db;                                      // + distanza dal fondo
    const pumps: [string, string] = [tx("Pompe"), tx("{n} in servizio da {q} l/s + 1 di riserva", { n: nDuty, q: fx(Math.round(qP * 1000)) })];
    const subm: [string, string] = [tx("Sommergenza minima (ANSI/HI 9.8)"), tx("{s} m sopra la campana, fondale minimo {d} m al livello più basso", { s: fx(Smin, { maximumFractionDigits: 1 }), d: fx(depthMin, { maximumFractionDigits: 1 }) })];
    if (gravity) { /* nessuna pompa alla presa */ } else if (srcType === "fiume" || srcType === "invaso") {
      if (drop >= 2) {
        out.push({ text: tx("Escursione di {m} m: pontone galleggiante con pompe ad asse orizzontale o sommergibili, collegato a riva con tubazione flessibile.", { m: fx(drop) }),
          rows: [pumps, subm,
            [tx("Pontone"), tx("circa {a} m² di coperta, ancorato a pali o con funi a riva", { a: fx(Math.ceil(((nDuty + 1) * 12 + 20) / 5) * 5) })],
            [tx("Collegamento a riva"), tx("tubazione flessibile o passerella snodata lunga almeno {l} m", { l: fx(Math.ceil(drop * Math.sqrt(1 + bankSlope * bankSlope) + 10)) })]] });
      } else if (drop >= 0.5) {
        out.push({ text: tx("Escursione di {m} m: pompa su slitta lungo la sponda inclinata, spostabile con il livello.", { m: fx(drop) }),
          rows: [pumps, subm,
            [tx("Binario della slitta"), tx("{l} m lungo la sponda (pendenza {p}:1), con argano", { l: fx(Math.ceil(drop * Math.sqrt(1 + bankSlope * bankSlope) + 3)), p: fx(bankSlope) })]] });
      } else {
        const V = (900 * qP) / 10;                                         // vasca di presa: 10 avviamenti/h per pompa
        out.push({ text: tx("Livello stabile: pozzo di presa in sponda con pompe verticali o ad asse orizzontale sotto battente."),
          rows: [pumps, subm, [tx("Pozzo di presa"), tx("volume utile minimo {v} m³ (10 avviamenti/h per pompa)", { v: fx(Math.ceil(V)) })]] });
      }
      if (drop > 5) out.push({ text: tx("Oltre 5 m di escursione le pompe in aspirazione non funzionano: solo soluzioni galleggianti o sommergibili."), rows: [] });
    } else if (srcType === "canale") {
      const Ag = Q / 0.6 / 0.5;                                            // griglia: 0,6 m/s, 50% di luce libera
      out.push({ text: tx("Presa da canale con griglia e paratoia, pompe ad asse orizzontale in camera asciutta sotto battente."),
        rows: [pumps, subm, [tx("Griglia"), tx("superficie lorda {a} m² (0,6 m/s, luce libera 50%), con sgrigliatore", { a: fx(Ag, { maximumFractionDigits: 1 }) })]] });
    } else {
      const nW = Math.max(1, Math.ceil(qIn / Math.max(1, wellQ)));
      out.push({ text: tx("Pompe sommerse in pozzo, livello dinamico {m} m: prevedere un pozzo per pompa o un pozzo di riserva.", { m: fx(drop) }),
        rows: [[tx("Pozzi"), tx("{n} in servizio da {q} l/s + 1 di riserva", { n: nW, q: fx(Math.round(qIn / nW)) })],
          [tx("Pompe sommerse"), tx("una per pozzo, installata almeno 5 m sotto il livello dinamico")]] });
    }
    if (srcSediment && srcType !== "pozzo") {
      // Sedimentazione (Stokes, 20 °C): vs = g (ρs − ρ) d² / 18 μ; area = Q / vs × 1,5.
      const d = Math.max(0.02, settleMm) / 1000;
      const vs = (9.81 * 1650 * d * d) / (18 * 1.0e-3);
      const A = (Q / vs) * 1.5, W = Math.sqrt(A / 4), Lb = 4 * W;
      const h = Math.max(1.5, Q / (W * 0.3));                              // velocità orizzontale ≤ 0,3 m/s
      out.push({ text: tx("Acqua con sedimenti: dissabbiatore o vasca di sedimentazione prima della presa, filtri autopulenti a monte dei pivot."),
        rows: [[tx("Dissabbiatore"), tx("{l} × {w} m, profondità {h} m: trattiene le particelle da {d} mm (velocità di caduta {v} mm/s)", { l: fx(Math.ceil(Lb)), w: fx(Math.ceil(W)), h: fx(h, { maximumFractionDigits: 1 }), d: fx(settleMm), v: fx(vs * 1000, { maximumFractionDigits: 1 }) })]] });
    }
    const qh = (qPiv / 1000) * 3600;
    const nF = Math.max(1, Math.ceil(qh / Math.max(10, filterCap)));
    out.push({ text: tx("Filtrazione a monte dei pivot"),
      rows: [[tx("Filtri autopulenti"), tx("{n} da {c} m³/h in parallelo (portata ai pivot {q} m³/h)", { n: nF, c: fx(filterCap), q: fx(Math.round(qh)) })]] });
    return out;
  }
  // Disegno dello schema scelto (mappa, tavola PDF, link condiviso).
  function sourceDrawing() {
    if (!srcPt) return null;
    const S = sourceSchemes();
    const sc = S?.schemes.find((x) => x.key === (srcShown ?? S?.best?.key));
    const R = S?.R ?? null;
    const km = (m: number) => `${fx(m / 1000, { maximumFractionDigits: 1 })} km`;
    return {
      src: srcPt,
      line: sc && S ? S.ln : null,
      lineKind: (sc?.main?.kind ?? "pipe") as "pipe" | "canal",
      reservoir: sc?.res && R ? { center: R, r: sc.res.r } : null,
      points: (sc?.sectors ?? []).map((x) => ({ pt: x.center, label: `S${x.i}`, tip: `${tx("Settore")} ${x.i} · ${x.n} pivot · ${fx(Math.round(x.qLs))} l/s · ${fx(Math.round(x.head))} m` })),
      labels: { src: `${tx("Fonte d'acqua")} · ${tx(srcType)}`, res: sc?.res ? `${tx("Vasca di accumulo")} · ${fx(Math.round(sc.res.vol))} m³` : "",
        line: sc?.main ? (sc.main.kind === "canal" ? `${tx("Canale a gravità")} · ${km(sc.main.L)}` : `${tx("Adduttrice")} · ${sc.main.n && sc.main.n > 1 ? `${sc.main.n}×` : ""}DN ${sc.main.dn} · ${km(sc.main.L)}`) : "" },
    };
  }
  // Sezioni della scheda PDF (già tradotte nella lingua della stampa).
  function pdfSections(): { title: string; header?: string[]; widths?: number[]; rows: string[][] }[] {
    const out: { title: string; header?: string[]; widths?: number[]; rows: string[][] }[] = [];
    const S = srcPt ? sourceSchemes() : null;
    const sc = S ? (S.schemes.find((x) => x.key === (srcShown ?? S.best?.key)) ?? null) : null;
    if (S && sc) {
      const rows: string[][] = [];
      rows.push([tx("Tipo di fonte"), `${tx(srcType)} · ${tx("Livello minimo alla presa")} ${S.zLow != null ? fx(Math.round(S.zLow)) + " m" : "—"}`]);
      rows.push([tx("Fabbisogno di punta"), `${fx(Math.round(S.Vday))} m³/${tx("giorno")} (${fx(Math.round(S.Qd))} l/s)`]);
      rows.push([tx("schema"), `${sc.key} · ${sc.name}`]);
      for (const st of sc.stages) rows.push([st.name, `${fx(Math.round(st.qLs))} l/s · ${fx(Math.round(st.head))} m · ${fx(Math.round(st.kW))} kW · ${fx(Math.round(st.hours))} h/${tx("giorno")}`]);
      if (sc.main?.kind === "pipe") rows.push([tx("Adduttrice"), `${sc.main.n && sc.main.n > 1 ? sc.main.n + " × " : ""}DN ${sc.main.dn} · ${fx(Math.round(sc.main.L))} m · ${tx("perdite")} ${fx(Math.round(sc.main.hf ?? 0))} m`]);
      if (sc.main?.kind === "canal") rows.push([tx("Canale a gravità"), `${fx(Math.round(sc.main.L))} m · ${tx("pendenza")} ${fx(canalSlope, { maximumFractionDigits: 2 })}‰`]);
      if (sc.res) rows.push([tx("Vasca di accumulo"), `${fx(Math.round(sc.res.vol))} m³ · ${fx(sc.res.ha, { maximumFractionDigits: 2 })} ha · ${tx("scorta")} ${fx(sc.res.days)} ${tx("giorni")} · ${tx("evaporazione")} ${fx(Math.round(sc.res.evap))} m³/${tx("giorno")}`]);
      rows.push([tx("Energia"), `${fx(Math.round(sc.kWabs))} kW · ${fx(Math.round(sc.mwh))} MWh/${tx("anno")}${srcEnergy !== "rete" ? ` · FV ${fx(Math.round(sc.pvKwp))} kWp${sc.battKwh > 0 ? ` · ${tx("Batterie")} ${fx(Math.round(sc.battKwh))} kWh` : ""}` : ""}`]);
      const qIn = sc.key === "B" ? sc.stages[0].qLs : sc.key === "C" ? (S.Vday + (sc.res?.evap ?? 0)) / 3.6 / Math.max(1, Math.min(srcHours, 24)) : S.Qd;
      for (const blk of intakeAdvice(qIn, S.drop, S.Qd, sc.key === "C")) {
        rows.push(["", blk.text]);
        for (const [k, v] of blk.rows) rows.push([k, v]);
      }
      out.push({ title: tx("Fonte d'acqua"), rows });
    }
    const cr = computoRows();
    if (cr.length) {
      const rows: string[][] = []; let last = "";
      for (const r of cr) {
        if (r.cat !== last) { rows.push([r.cat, "", "", ""]); last = r.cat; }
        rows.push([r.item, r.qty != null ? fx(r.qty) : "", r.unit, r.note ?? ""]);
      }
      out.push({ title: tx("Computo metrico"), header: [tx("Voce"), tx("Quantità"), tx("Unità"), tx("Note")], widths: [5, 1.4, 1, 5], rows });
    }
    return out;
  }
  useEffect(() => {
    const m = mapApi.current; if (!m) return;
    m.setSourceScheme?.(sourceDrawing());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcPt, srcRoute, srcShown, srcElev, srcType, srcEnergy, srcHours, srcQmax, srcRange, srcMonthly, srcSectors, pivots, mmDes, hoursDay, resDepth, resDays, resEvapK, et0Peak, wtwEta, canalSlope, lang]);
  // Profilo del tracciato (SVG): terreno, e linea dei carichi o pelo libero del canale.
  function renderProfile(S: NonNullable<ReturnType<typeof sourceSchemes>>, sc: Scheme | undefined) {
    const pr = S.prof; if (!pr || pr.d.length < 2 || !sc?.main) return null;
    const pts = pr.d.map((d, i) => [d, pr.z[i]] as [number, number | null]).filter((p): p is [number, number] => p[1] != null);
    if (pts.length < 2) return null;
    const Lp = pr.d[pr.d.length - 1] || 1, Wd = 300, Ht = 90;
    const lineY: [number, number][] = [];
    if (S.zLow != null) {
      if (sc.main.kind === "canal") {
        const s = Math.max(0.05, canalSlope) / 1000 * (S.L / Lp);
        lineY.push([0, S.zLow], [Lp, S.zLow - s * Lp]);
      } else {
        const st = sc.stages[0];
        lineY.push([0, S.zLow + st.head], [Lp, S.zLow + st.head - (sc.main.hf ?? 0)]);
      }
    }
    const ys = [...pts.map((p) => p[1]), ...lineY.map((p) => p[1]), ...(S.zLow != null ? [S.zLow] : [])];
    const y0 = Math.min(...ys) - 2, y1 = Math.max(...ys) + 2;
    const X = (d: number) => (d / Lp) * Wd, Y = (z: number) => Ht - ((z - y0) / Math.max(1, y1 - y0)) * Ht;
    const ground = pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
    return (
      <div className="bg-panel rounded-lg p-2">
        <div className="text-[11px] text-sage-dark mb-1">{t("Profilo del tracciato")} · {uKm(Lp / 1000, 1)} · {fmt(Math.round(y0 + 2))}–{fmt(Math.round(y1 - 2))} m</div>
        <svg viewBox={`0 0 ${Wd} ${Ht}`} className="w-full h-[90px]" preserveAspectRatio="none">
          <path d={`${ground}L${Wd},${Ht}L0,${Ht}Z`} fill="#c9b18a" fillOpacity={0.45} stroke="#8a6d3b" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {lineY.length === 2 && <line x1={X(lineY[0][0])} y1={Y(lineY[0][1])} x2={X(lineY[1][0])} y2={Y(lineY[1][1])}
            stroke={sc.main.kind === "canal" ? "#0284c7" : "#1d4ed8"} strokeWidth={1.6} strokeDasharray={sc.main.kind === "canal" ? "5,3" : undefined} vectorEffect="non-scaling-stroke" />}
        </svg>
        <div className="text-[10px] text-sage-dark">{sc.main.kind === "canal" ? t("Linea tratteggiata: pelo libero del canale.") : t("Linea blu: linea dei carichi della condotta (deve restare sopra il terreno).")}</div>
      </div>
    );
  }
  function renderSource() {
    const S = sourceSchemes();
    const num = (label: string, v: number, set: (x: number) => void, step = 1, min = 0, max = 1e9) => (
      <label className="text-[11px] text-sage-dark">{label}
        <input type="number" min={min} max={max} step={step} value={v}
          onChange={(e) => { const x = Number(e.target.value); if (Number.isFinite(x)) set(Math.max(min, Math.min(max, x))); }} className="field-input mt-0.5 py-1 text-sm" /></label>
    );
    const mwh = (x: number) => fmt(Math.round(x));
    return (
      <div className="space-y-3">
        {!pivots.length && <p className="text-[11px] text-sage-dark">{t("Posa prima i pivot: lo schema d'impianto parte da dove sono i campi.")}</p>}
        {/* 1 — fonte */}
        <div className="bg-panel rounded-lg p-2 space-y-2">
          <div className="text-xs font-semibold text-brand-darker">{t("1 · Da dove si prende l'acqua")}</div>
          <button className="btn-primary w-full" disabled={!pivots.length || busy === "fonte"}
            onClick={srcPicking ? () => { mapApi.current?.pickPoint(null); setSrcPicking(false); } : startPickSource}>
            {srcPicking ? t("Clicca sulla mappa… (Esc annulla)") : srcPt ? t("📍 Sposta il punto di presa") : t("📍 Indica la fonte sulla mappa")}
          </button>
          {srcPt && (
            <div className="flex gap-2">
              <button className="btn-ghost flex-1 basis-0 text-[12px]" disabled={srcDrawing} onClick={startDrawRoute}>
                {srcDrawing ? t("Traccia sulla mappa…") : srcRoute ? t("✏️ Ridisegna il tracciato") : t("✏️ Disegna il tracciato fino alla vasca")}</button>
              {srcRoute && <button className="btn-ghost text-[12px]" onClick={() => setSrcRoute(null)} title={t("Torna al tracciato in linea retta")}>{t("Linea retta")}</button>}
            </div>
          )}
          {srcPt && (
            <div className="flex gap-2">
              <button className="btn-ghost flex-1 basis-0 text-[12px]" disabled={busy === "route"} onClick={() => proposeRoute("pipe")}
                title={t("Percorso più corto che segue strade e bordi dei campi, evita i cerchi irrigati e le risalite.")}>{busy === "route" ? "…" : t("🧭 Proponi condotta")}</button>
              <button className="btn-ghost flex-1 basis-0 text-[12px]" disabled={busy === "route" || srcType === "pozzo"} onClick={() => proposeRoute("canal")}
                title={t("Canale a gravità con pendenza costante, scendendo dalla presa alla vasca: il minor scavo possibile.")}>{busy === "route" ? "…" : t("🧭 Proponi canale")}</button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-sage-dark">{t("Tipo di fonte")}
              <select className="field-input mt-0.5 py-1 text-sm" value={srcType}
                onChange={(e) => { const v = e.target.value as SrcType; setSrcType(v); setSrcRange(SRC_RANGE_DEF[v]); setSrcSediment(v === "fiume"); }}>
                <option value="fiume">{t("fiume")}</option><option value="canale">{t("canale")}</option>
                <option value="pozzo">{t("pozzo")}</option><option value="invaso">{t("invaso")}</option>
              </select></label>
            {num(srcType === "pozzo" ? t("Livello dinamico (m)") : t("Escursione di livello (m)"), srcRange, setSrcRange, 0.5, 0, 300)}
            {num(t("Portata disponibile (l/s, 0 = illimitata)"), srcQmax, setSrcQmax, 10, 0)}
            {num(t("Ore di prelievo consentite"), srcHours, setSrcHours, 1, 1, 24)}
          </div>
          {srcType !== "pozzo" && (
            <label className="flex items-center gap-2 text-[11px] text-sage-dark">
              <input type="checkbox" checked={srcSediment} onChange={(e) => setSrcSediment(e.target.checked)} />{t("Acqua con sedimenti")}
            </label>
          )}
          {srcType !== "pozzo" && (
            <label className="flex items-center gap-2 text-[11px] text-sage-dark">
              <input type="checkbox" checked={!!srcMonthly} onChange={(e) => setSrcMonthly(e.target.checked ? Array(12).fill(srcRange) : null)} />
              {t("Livello minimo mese per mese (m sotto il punto di presa)")}
            </label>
          )}
          {srcMonthly && srcType !== "pozzo" && (
            <div className="grid grid-cols-6 gap-1">
              {srcMonthly.map((v, i) => (
                <label key={i} className="text-[10px] text-sage-dark text-center">{new Date(2000, i, 1).toLocaleString(lang, { month: "short" })}
                  <input type="number" min={0} max={50} step={0.1} value={v}
                    onChange={(e) => { const x = Number(e.target.value); if (Number.isFinite(x)) setSrcMonthly((m) => m ? m.map((y, k) => (k === i ? Math.max(0, Math.min(50, x)) : y)) : m); }}
                    className="field-input mt-0.5 px-1 py-0.5 text-[11px] text-center" /></label>
              ))}
            </div>
          )}
        </div>

        {S && (<>
          {/* 2 — dati */}
          <div className="text-[11px] text-sage-dark bg-panel rounded-lg p-2 leading-relaxed">
            {t("Superficie irrigata")} <b>{uHa(S.irrHa)}</b> · {t("ETc di punta")} <b>{fmt(etcMax, { maximumFractionDigits: 1 })} mm/{t("giorno")}</b> ({t(cropMax?.label ?? "Altro")}, Kc {fmt(kcMax, { maximumFractionDigits: 2 })}) · {t("lordo")} <b>{fmt(mmDes, { maximumFractionDigits: 1 })} mm</b><br />
            {srcRoute ? t("Tracciato disegnato") : t("Tracciato in linea retta (+10%)")}: <b>{uKm(S.L / 1000, 1)}</b> · {t("Fabbisogno di punta")}: <b>{fmt(Math.round(S.Vday))} m³/{t("giorno")}</b> ({fmt(Math.round(S.Qd))} l/s)<br />
            {S.hasElev && S.zLow != null && S.zR != null
              ? <>{t("Livello minimo alla presa")} <b>{fmt(Math.round(S.zLow))} m</b>{S.months && <> ({t("mesi irrigui")}; {t("medio")} −{fmt(S.dropAvg, { maximumFractionDigits: 1 })} m)</>} · {t("vasca")} <b>{fmt(Math.round(S.zR))} m</b>{S.zP != null && <> · {t("pivot più alto")} <b>{fmt(Math.round(S.zP))} m</b></>}</>
              : busy === "fonte" ? "…" : <span className="text-rust">{t("Quote non disponibili: indica di nuovo la fonte.")}</span>}
          </div>

          {/* 3 — energia */}
          <div>
            <div className="text-xs font-semibold text-brand-darker mb-1">{t("2 · Alimentazione")}</div>
            <div className="seg">
              <div className="seg-item" data-active={srcEnergy === "rete"} onClick={() => setSrcEnergy("rete")}>{t("Rete / generatore")}</div>
              <div className="seg-item" data-active={srcEnergy === "fv-gen"} onClick={() => setSrcEnergy("fv-gen")}>{t("FV + generatore")}</div>
              <div className="seg-item" data-active={srcEnergy === "fv-batt"} onClick={() => setSrcEnergy("fv-batt")}>{t("FV + batterie")}</div>
            </div>
          </div>

          {/* 4 — schemi */}
          <div className="text-xs font-semibold text-brand-darker">{t("3 · Schemi d'impianto")}</div>
          {pivots.length > 1 && (
            <div className="flex items-center gap-2 text-[11px] text-sage-dark">
              <label className="flex-1">{t("Settori di rilancio")}
                <select className="field-input mt-0.5 py-1 text-sm" value={srcSectors} onChange={(e) => setSrcSectors(Number(e.target.value))}>
                  <option value={0}>{t("Automatico ({n})", { n: S.kAuto })}</option>
                  {Array.from({ length: Math.min(6, pivots.length) }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
                </select></label>
              <span className="flex-1 leading-snug">{S.kUse > 1
                ? t("{k} settori: il rilancio spinge ogni settore solo fino al suo pivot più alto ({p}% di energia di rilancio in meno).", { k: S.kUse, p: fmt(Math.round(S.secSave * 100)) })
                : t("Un solo settore: le quote dei pivot sono simili, dividere non fa risparmiare.")}</span>
            </div>
          )}
          {S.schemes.map((sc) => {
            const isBest = S.best === sc; const shown = (srcShown ?? S.best?.key) === sc.key;
            return (
              <div key={sc.key} className={"rounded-lg p-2 border " + (isBest ? "border-brand/50 bg-brand/5" : "border-black/10") + (sc.ok ? "" : " opacity-60")}>
                <div className="flex items-center gap-2">
                  <b className="text-[12px] text-brand-darker flex-1">{sc.key} · {sc.name}</b>
                  {isBest && <span className="text-[10px] font-bold bg-brand text-white rounded-full px-1.5">{t("consigliato")}</span>}
                  {sc.ok && <button className={"text-[11px] " + (shown ? "text-brand font-semibold" : "text-brand-mid")} onClick={() => setSrcShown(sc.key)}>{shown ? "◉" : "○"} {t("mappa")}</button>}
                </div>
                {sc.why && <div className={"text-[11px] mt-0.5 " + (sc.ok ? "text-sage-dark" : "text-rust")}>{sc.why}</div>}
                {sc.ok && (
                  <div className="text-[11px] text-sage-dark leading-relaxed mt-1">
                    {sc.stages.map((st, i) => (
                      <div key={i}>• {st.name}: <b>{fmt(Math.round(st.qLs))} l/s</b> · {fmt(Math.round(st.head))} m · <b>{fmt(Math.round(st.kW))} kW</b> · {fmt(Math.round(st.hours))} h/{t("giorno")}</div>
                    ))}
                    {sc.main && (sc.main.kind === "canal"
                      ? <div>• {t("Canale a gravità")}: {uKm(sc.main.L / 1000, 1)} · {t("pendenza")} {fmt(canalSlope, { maximumFractionDigits: 2 })}‰{S.prof && <> · {t("scavo massimo")} {fmt(sc.main.cutMax ?? 0, { maximumFractionDigits: 1 })} m · {t("rilevato massimo")} {fmt(sc.main.fillMax ?? 0, { maximumFractionDigits: 1 })} m</>}</div>
                      : <div>• {t("Adduttrice")}: {sc.main.n && sc.main.n > 1 ? `${sc.main.n} × ` : ""}DN {sc.main.dn} · {uKm(sc.main.L / 1000, 1)} · {t("perdite")} {fmt(Math.round(sc.main.hf ?? 0))} m{!!sc.main.hiPt && <> · {t("prevalenza decisa dal colmo a {z} m", { z: fmt(Math.round(sc.main.hiPt)) })}</>}</div>)}
                    {sc.res && <div>• {t("Vasca di accumulo")}: <b>{fmt(Math.round(sc.res.vol))} m³</b> · {uHa(sc.res.ha, 1)} · {t("profondità")} {fmt(resDepth)} m · {t("scorta")} {fmt(sc.res.days)} {t("giorni")} · {t("evaporazione")} {fmt(Math.round(sc.res.evap))} m³/{t("giorno")}</div>}
                    <div className="mt-0.5 text-brand-darker">{t("Potenza assorbita")} <b>{fmt(Math.round(sc.kWabs))} kW</b> · {t("Energia")} <b>{mwh(sc.mwh)} MWh/{t("anno")}</b>
                      {srcEnergy !== "rete" && <> · FV <b>{fmt(Math.round(sc.pvKwp))} kWp</b> ({fmt(Math.round(sc.solarPct))}% {t("dal sole")}){sc.battKwh > 0 && <> · {t("Batterie")} <b>{fmt(Math.round(sc.battKwh))} kWh</b></>}</>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {S.best && (
            <p className="text-[11px] text-brand-darker bg-panel rounded-lg p-2 leading-relaxed">
              {srcEnergy === "fv-gen" ? t("Consigliato lo schema con meno energia da generatore; a parità (entro il 3%) il più semplice.")
                : srcEnergy === "fv-batt" ? t("Consigliato, entro il 10% di energia, lo schema con meno batterie: accumulare acqua in vasca è più semplice che accumulare elettricità.")
                : t("Consigliato lo schema con il minor consumo di energia; a parità (entro il 3%) il più semplice, con meno stazioni.")}
              {S.best.key === "B" && srcEnergy !== "rete" && <> {t("La vasca fa da «batteria d'acqua»: si solleva l'acqua con il sole e si irriga anche di notte.")}</>}
            </p>
          )}
          {S.best && (
            <button className="btn-ghost w-full" onClick={() => {
              const sc = S.schemes.find((x) => x.key === (srcShown ?? S.best!.key)) ?? S.best!;
              // la pagina Pompaggio dimensiona la stazione che alimenta i pivot
              const liftToPivots = sc.key === "A" ? Math.max(0, sc.stages[0].head - S.Hd) : Math.max(0, (S.zP ?? 0) - (S.zR ?? 0));
              setPsLift(Math.round(liftToPivots)); goTab("pompaggio");
            }}>{t("Usa questo schema nella pagina Pompaggio →")}</button>
          )}

          {renderProfile(S, S.schemes.find((x) => x.key === (srcShown ?? S.best?.key)))}

          {/* 5 — presa */}
          {(() => {
            const sc = S.schemes.find((x) => x.key === (srcShown ?? S.best?.key)) ?? S.schemes[0];
            const qIn = sc.key === "B" ? sc.stages[0].qLs : sc.key === "C" ? (S.Vday + (sc.res?.evap ?? 0)) / 3.6 / Math.max(1, Math.min(srcHours, 24)) : S.Qd;
            return (
              <div className="bg-panel rounded-lg p-2">
                <div className="text-xs font-semibold text-brand-darker mb-1">{t("4 · Montaggio della presa e trattamento")} <span className="font-normal text-sage-dark">({t("schema")} {sc.key} · {fmt(Math.round(qIn))} l/s)</span></div>
                <div className="space-y-1.5">
                  {intakeAdvice(qIn, S.drop, S.Qd, sc.key === "C").map((x, i) => (
                    <div key={i} className="text-[11px] text-brand-darker">
                      <div>• {x.text}</div>
                      {!!x.rows.length && (
                        <table className="w-full mt-0.5 ml-2"><tbody>
                          {x.rows.map((r, k) => <tr key={k}><td className="text-sage-dark pr-2 align-top whitespace-nowrap">{r[0]}</td><td>{r[1]}</td></tr>)}
                        </tbody></table>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          <button className="text-[11px] text-brand-mid" onClick={() => setSrcOpen((o) => !o)}>{srcOpen ? "▾" : "▸"} {t("Parametri di calcolo")}</button>
          {srcOpen && (
            <div className="grid grid-cols-2 gap-2">
              {num(t("Profondità utile della vasca (m)"), resDepth, setResDepth, 0.5, 1, 15)}
              {num(t("Giorni di scorta nella vasca"), resDays, setResDays, 0.5, 0, 60)}
              {num(t("Evaporazione della vasca (× ET₀)"), resEvapK, setResEvapK, 0.05, 0, 2)}
              {num(t("Rendimento pompa + motore (%)"), wtwEta, setWtwEta, 1, 30, 95)}
              {num(t("Pendenza del canale (‰)"), canalSlope, setCanalSlope, 0.05, 0.05, 5)}
              {num(t("Ore di pompaggio col sole"), pvSunH, setPvSunH, 0.5, 1, 14)}
              {num(t("Pendenza della sponda (orizz. : vert.)"), bankSlope, setBankSlope, 0.5, 0.5, 10)}
              {num(t("Particella da sedimentare (mm)"), settleMm, setSettleMm, 0.02, 0.02, 2)}
              {num(t("Portata di un filtro (m³/h)"), filterCap, setFilterCap, 50, 10, 5000)}
              {num(t("Portata di un pozzo (l/s)"), wellQ, setWellQ, 5, 1, 500)}
            </div>
          )}
          <p className="text-[10px] text-sage-dark leading-snug">{t("Se non disegni il tracciato si usa la linea retta + 10%. Portate e fabbisogno dalla pagina Irrigazione, prevalenza ai pivot dalla pagina Tubazioni, irraggiamento e mesi irrigui dal clima del sito.")}</p>
        </>)}
      </div>
    );
  }
  // ---- STAZIONE DI POMPAGGIO: configurazione consigliata in base alla potenza ----
  // Portata di progetto = somma delle portate dei pivot (pagina Irrigazione).
  // Prevalenza = prevalenza alla presa calcolata nella pagina Tubazioni (se c'è),
  // altrimenti pressione del pivot più esigente + perdite stimate; più il
  // sollevamento dalla fonte. Volume annuo dal clima del sito mese per mese:
  // (ET₀·Kc medio − pioggia efficace) / efficienza, sulla superficie irrigata.
  // Per ogni N di pompe in servizio (+ scorte): motore standard IEC, rendimento,
  // potenza assorbita e installata, energia annua. Criterio solo tecnico:
  // tra le soluzioni con consumo entro psTolPct % dal minimo vince quella con la
  // minor potenza installata (scorte comprese), preferendo motori in bassa
  // tensione (≤ 315 kW); a parità, la più modulare.
  const STD_KW = [0.75, 1.1, 1.5, 2.2, 3, 4, 5.5, 7.5, 11, 15, 18.5, 22, 30, 37, 45, 55, 75, 90, 110, 132, 160, 200, 250, 315, 355, 400, 450, 500, 560, 630, 710, 800, 900, 1000];
  // Lineari, rotoloni e goccia salvati: portata, superficie e prevalenza all'ingresso del campo.
  function sysTotals() {
    let qLs = 0, ha = 0, headMax = 0;
    for (const [k, d] of Object.entries(sysDesigns)) {
      const f = fieldOfKey(k); if (!f) continue;
      const r = d.sys === "lineari" ? calcLin(f, d.p as LinP) : d.sys === "rotoloni" ? calcRot(f, d.p as RotP) : calcDrip(f, d.p as DripP);
      qLs += r.qLs; headMax = Math.max(headMax, r.head);
      ha += d.sys === "lineari" ? (r as ReturnType<typeof calcLin>).ha : d.sys === "rotoloni" ? (r as ReturnType<typeof calcRot>).coveredHa : (r as ReturnType<typeof calcDrip>).fieldHa;
    }
    return { qLs, ha, headMax };
  }
  function pumpStation() {
    const n = pivots.length;
    const SY = sysTotals();
    const qDes = pivots.reduce((a, p) => a + pivotFlow(p), 0) + SY.qLs;              // l/s (pivot + altri sistemi)
    const irrHa = pivots.reduce((a, p) => a + pvAreaM2(p) / 10000, 0) + SY.ha;
    const pMaxBar = n ? Math.max(...pivots.map((p) => pivotPressure(p))) : 0;
    const headFromNet = hydra ? hydra.headMax : null;
    const head = Math.max(headFromNet ?? (n ? pMaxBar * 10.2 + Math.max(0, psHeadExtra) : 0), SY.headMax) + Math.max(0, psLift);
    const clim = fields.map((f) => (f.lay as { climate?: { eto_month_mm?: number[]; rain_month_mm?: number[]; source?: string } } | null | undefined)?.climate)
      .find((c) => c && c.eto_month_mm?.length === 12 && c.rain_month_mm?.length === 12);
    const kcAvg = (CROPS[cropKey] ?? 1.1) * Math.max(0.3, psKcAvg / 100);
    const eff = Math.max(0.3, effPct / 100);
    let netMm: number[] | null = null; let grossYearMm: number;
    if (clim) {
      netMm = clim.eto_month_mm!.map((e, i) => Math.max(0, e * kcAvg - (clim.rain_month_mm![i] * psRainEff) / 100));
      grossYearMm = netMm.reduce((a, x) => a + x, 0) / eff;
    } else {
      grossYearMm = mmDes * Math.max(0, psDaysFallback);
    }
    grossYearMm = Math.min(grossYearMm, mmDes * 365);                                // non oltre la piena portata
    const volYear = grossYearMm / 1000 * irrHa * 10000;                              // m³/anno
    const hoursFull = qDes > 0 ? volYear / (qDes * 3.6) : 0;                         // ore equivalenti a piena portata
    type Cfg = { nDuty: number; nTot: number; qU: number; pShaft: number; kW: number; etaP: number; etaM: number;
      pAbs: number; kWInst: number; kWhYear: number };
    const cfgs: Cfg[] = [];
    if (qDes > 0 && head > 0) {
      for (let nDuty = 1; nDuty <= 10; nDuty++) {
        const qU = qDes / nDuty;
        if (qU < 5) break;
        const etaP = 0.87 - 0.12 * Math.exp(-qU / 80);                               // pompe piccole rendono meno
        const pShaft = (qU * head * 9.81) / 1000 / etaP;                              // kW all'albero
        const kW = STD_KW.find((k) => k >= pShaft * 1.1) ?? 0;                        // motore standard, margine 10%
        if (!kW) continue;
        const etaM = 0.965 - 0.06 * Math.exp(-kW / 25);
        const nTot = nDuty + Math.max(0, psSpares);
        const pAbs = (pShaft * nDuty) / etaM;                                         // kW elettrici in servizio
        cfgs.push({ nDuty, nTot, qU, pShaft, kW, etaP, etaM, pAbs, kWInst: kW * nTot,
          kWhYear: (volYear * head) / 367 / (etaP * etaM) });                         // ρg/3,6e6 = 1/367
      }
    }
    const minE = cfgs.length ? cfgs.reduce((a, c) => (c.kWhYear < a.kWhYear ? c : a)) : null;
    const minInst = cfgs.length ? cfgs.reduce((a, c) => (c.kWInst < a.kWInst ? c : a)) : null;
    let band = minE ? cfgs.filter((c) => c.kWhYear <= minE.kWhYear * (1 + Math.max(0, psTolPct) / 100)) : [];
    if (band.some((c) => c.kW < 355)) band = band.filter((c) => c.kW < 355);       // bassa tensione se possibile
    const best = band.length ? band.reduce((a, c) => (c.kWInst < a.kWInst || (c.kWInst === a.kWInst && c.nDuty > a.nDuty) ? c : a)) : null;
    return { n, qDes, irrHa, head, headFromNet, pMaxBar, clim, netMm, grossYearMm, volYear, hoursFull, cfgs, best, minE, minInst };
  }
  function renderPumpStation() {
    const P = pumpStation();
    const mwh = (x: number) => fmt(Math.round(x / 1000));
    const steps: { ok: boolean; warn?: boolean; text: string; tab?: string; action?: string }[] = [
      { ok: P.n > 0, text: P.n ? t("Pivot posati: {n} · {a}", { n: P.n, a: uHa(P.irrHa) }) : t("Posa i pivot sul campo"), tab: "impianti", action: t("Impianti") },
      { ok: Math.abs(mm24 - mm24Suggested) < 0.6, warn: true,
        text: t("Fabbisogno {v} mm/g (consigliato {s})", { v: fmt(mm24, { maximumFractionDigits: 1 }), s: fmt(mm24Suggested, { maximumFractionDigits: 1 }) }), tab: "irrigazione", action: t("Irrigazione") },
      { ok: !!P.clim, warn: true, text: P.clim ? t("Clima del sito mese per mese ({src})", { src: P.clim.source ?? "NASA POWER" }) : t("Clima del sito assente: consumo annuo stimato su {d} giorni", { d: psDaysFallback }), tab: "impianti", action: t("Rilancia il layout") },
      { ok: P.headFromNet != null, warn: true, text: P.headFromNet != null ? t("Prevalenza dalla rete calcolata: {m} m", { m: fmt(Math.round(P.headFromNet)) }) : t("Prevalenza stimata: calcola i diametri delle tubazioni"), tab: "accessori", action: t("Tubazioni") },
      { ok: true, text: t("Sollevamento dalla fonte: {m} m (canale ≈ 2–5 m, pozzo = livello dinamico)", { m: fmt(psLift) }) },
    ];
    const num = (label: string, v: number, set: (x: number) => void, step = 1, min = 0, max = 1e9) => (
      <label className="text-[11px] text-sage-dark">{label}
        <input type="number" min={min} max={max} step={step} value={v}
          onChange={(e) => { const x = Number(e.target.value); if (Number.isFinite(x)) set(Math.max(min, Math.min(max, x))); }} className="field-input mt-0.5 py-1 text-sm" /></label>
    );
    const B = P.best;
    return (
      <div className="space-y-3">
        {/* 1 — guida */}
        <div className="bg-panel rounded-lg p-2">
          <div className="text-xs font-semibold text-brand-darker mb-1">{t("Prima di scegliere le pompe")}</div>
          <ul className="space-y-0.5">
            {steps.map((st, i) => (
              <li key={i} className="flex items-center gap-1.5 text-[11px]">
                <span className={st.ok ? "text-brand" : st.warn ? "text-amber" : "text-danger"}>{st.ok ? "✓" : st.warn ? "!" : "✕"}</span>
                <span className="flex-1 text-brand-darker">{st.text}</span>
                {!st.ok && st.tab && <button className="text-brand-mid shrink-0" onClick={() => goTab(st.tab!)}>{st.action} →</button>}
              </li>
            ))}
          </ul>
          <div className="mt-2">{num(t("Sollevamento dalla fonte (m)"), psLift, setPsLift, 1, 0, 300)}</div>
        </div>

        {!P.n ? <p className="text-[11px] text-sage-dark">{t("Posa i pivot per dimensionare la stazione di pompaggio.")}</p> : (<>
          {/* 2 — dati di progetto */}
          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="bg-panel rounded-lg p-2"><div className="text-lg font-semibold text-brand">{fmt(Math.round(P.qDes))}</div><div className="text-[11px] text-sage-dark">{t("Portata di progetto (l/s)")}</div></div>
            <div className="bg-panel rounded-lg p-2"><div className="text-lg font-semibold text-brand">{fmt(Math.round(P.head))}</div><div className="text-[11px] text-sage-dark">{t("Prevalenza totale (m)")}</div></div>
            <div className="bg-panel rounded-lg p-2"><div className="text-lg font-semibold text-brand">{fmt(Math.round(P.volYear / 1000))}</div><div className="text-[11px] text-sage-dark">{t("Volume annuo (migliaia di m³)")}</div></div>
            <div className="bg-panel rounded-lg p-2"><div className="text-lg font-semibold text-brand">{fmt(Math.round(P.hoursFull))}</div><div className="text-[11px] text-sage-dark">{t("Ore/anno a piena portata")}</div></div>
          </div>
          {P.netMm && (
            <div>
              <div className="text-[11px] text-sage-dark mb-1">{t("Fabbisogno netto mensile (mm) dal clima del sito")}</div>
              <div className="flex items-end gap-0.5 h-12">
                {P.netMm.map((v, i) => {
                  const mx = Math.max(1, ...P.netMm!);
                  return <div key={i} className="flex-1 bg-brand/70 rounded-t" style={{ height: `${Math.max(2, (v / mx) * 100)}%` }}
                    title={`${new Date(2026, i, 1).toLocaleString(lang, { month: "short" })}: ${fmt(Math.round(v))} mm`} />;
                })}
              </div>
              <div className="flex gap-0.5 text-[9px] text-sage-dark">{P.netMm.map((_, i) => <div key={i} className="flex-1 text-center">{new Date(2026, i, 1).toLocaleString(lang, { month: "narrow" })}</div>)}</div>
            </div>
          )}

          {/* 3 — consigliata */}
          {B && (
            <div className="rounded-lg p-2 border border-brand/40 bg-brand/5">
              <div className="text-xs font-semibold text-brand-darker">{t("Configurazione consigliata")}</div>
              <div className="text-[15px] font-semibold text-brand mt-0.5">
                {B.nDuty} × {fmt(B.kW)} kW {t("in servizio")}{psSpares > 0 ? ` + ${psSpares} ${t("di scorta")}` : ""}
              </div>
              <div className="text-[11px] text-sage-dark leading-relaxed">
                {fmt(Math.round(B.qU))} l/s · {fmt(Math.round(P.head))} m {t("per pompa")} · {t("rendimento")} {fmt(Math.round(B.etaP * B.etaM * 100))}%<br />
                {t("Potenza installata")} <b>{fmt(B.kWInst)} kW</b> ({t("di cui in servizio")} {fmt(B.kW * B.nDuty)} kW) · {t("Assorbimento")} <b>{fmt(Math.round(B.pAbs))} kW</b><br />
                {t("Energia")} <b>{mwh(B.kWhYear)} MWh/{t("anno")}</b>
                {P.minE && P.minE !== B ? (
                  <><br />{t("Consumo entro il {t}% del minimo ({c}: {d} MWh/anno in meno): si sceglie la soluzione con meno potenza installata.", { t: fmt(psTolPct), c: `${P.minE.nDuty}×${fmt(P.minE.kW)} kW`, d: mwh(B.kWhYear - P.minE.kWhYear) })}</>
                ) : P.minInst === B ? (
                  <><br />{t("Soluzione con il minor consumo e la minor potenza installata.")}</>
                ) : null}
                {B.kW >= 355 && <><br /><span className="text-rust">{t("Motori ≥ 355 kW: di norma servono media tensione e avviamento dedicato.")}</span></>}
              </div>
            </div>
          )}

          {/* 4 — confronto */}
          <table className="w-full text-[11px] tabular-nums">
            <thead><tr className="text-sage-dark border-b border-black/10 text-right">
              <th className="text-left font-medium py-0.5">{t("Pompe")}</th><th className="font-medium">kW</th><th className="font-medium">l/s</th>
              <th className="font-medium">η</th><th className="font-medium">{t("kW installati")}</th><th className="font-medium">MWh/{t("anno")}</th>
            </tr></thead>
            <tbody>
              {P.cfgs.map((c) => (
                <tr key={c.nDuty} className={"text-right " + (c === B ? "font-semibold text-brand-darker bg-brand/10" : "")}>
                  <td className="text-left py-0.5">{c.nDuty}+{c.nTot - c.nDuty}
                    {c === P.minE && <span className="ml-1 text-[9px] text-brand-mid" title={t("Minor consumo di energia")}>⚡</span>}
                    {c === P.minInst && <span className="ml-1 text-[9px] text-brand-mid" title={t("Minor potenza installata")}>▼</span>}</td>
                  <td>{fmt(c.kW)}</td><td>{fmt(Math.round(c.qU))}</td><td>{fmt(Math.round(c.etaP * c.etaM * 100))}%</td>
                  <td>{fmt(c.kWInst)}</td><td>{mwh(c.kWhYear)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[10px] text-sage-dark leading-snug">{t("Più pompe piccole: la scorta pesa meno sulla potenza installata (vale 1/N della stazione) e si segue meglio la domanda, ma il rendimento scende. Poche pompe grandi: rendimento migliore, ma la scorta raddoppia la potenza installata. ⚡ = minor consumo · ▼ = minor potenza installata.")}</p>
          {powerMode === "solar" && <p className="text-[10px] text-rust leading-snug">{t("Con alimentazione fotovoltaica conta soprattutto la potenza: campo FV e inverter si dimensionano sulla potenza assorbita dalle pompe.")}</p>}

          {/* 5 — parametri */}
          <button className="text-[11px] text-brand-mid" onClick={() => setPsOpen((o) => !o)}>{psOpen ? "▾" : "▸"} {t("Parametri di calcolo")}</button>
          {psOpen && (
            <div className="grid grid-cols-2 gap-2">
              {num(t("Pompe di scorta"), psSpares, setPsSpares, 1, 0, 4)}
              {num(t("Tolleranza sul consumo di energia (%)"), psTolPct, setPsTolPct, 0.5, 0, 20)}
              {num(t("Kc medio / Kc di punta (%)"), psKcAvg, setPsKcAvg, 1, 30, 100)}
              {num(t("Pioggia efficace (%)"), psRainEff, setPsRainEff, 1, 0, 100)}
              {P.headFromNet == null && num(t("Perdite in rete stimate (m)"), psHeadExtra, setPsHeadExtra, 1, 0, 200)}
              {!P.clim && num(t("Giorni di irrigazione all'anno"), psDaysFallback, setPsDaysFallback, 5, 0, 365)}
            </div>
          )}
        </>)}
      </div>
    );
  }
  // ---- Fotovoltaico per i pivot: energia giornaliera e superficie necessaria ----
  // Energia di un pivot al giorno = pompaggio (volume lordo × prevalenza totale /
  // rendimento) + motori delle torri. Prevalenza = pressione al centro del pivot
  // (irrigatori + condotta del pivot) + sollevamento e perdite in rete.
  // SENZA batterie: si pompa solo col sole (ore di pompaggio), con pompa più grande;
  //   kWp = max(energia / (ore sole equivalenti × PR), 1,25 × potenza di picco).
  // CON batterie: si pompa nelle ore di esercizio; la quota fuori dalle ore di sole
  //   passa dalle batterie (perdita di ciclo); capacità = energia notturna / DoD.
  // Superficie: moduli = kWp / (Wp/m²); terreno = moduli / copertura del suolo.
  function solarSizing() {
    const psSite = fields.map((f) => (f.lay as { solar?: { psh_design?: number; design_month?: number } } | null | undefined)?.solar)
      .find((x) => x && x.psh_design);
    const psh = Math.max(0.5, pvPsh ?? psSite?.psh_design ?? 6);
    const PR = Math.max(0.3, pvPR / 100), eta = Math.max(0.2, pvEta / 100);
    const hSun = Math.max(1, Math.min(14, pvSunH)), hRun = Math.max(1, Math.min(24, hoursDay));
    let ePump = 0, eTow = 0, irrHa = 0;
    for (const pv of pivots) {
      const areaM2 = pvAreaM2(pv);
      irrHa += areaM2 / 10000;
      const vol = (areaM2 * mmDes) / 1000;                          // m³/giorno (lordo di progetto)
      const head = pivotPressure(pv) * 10.197 + Math.max(0, pvHead); // m
      ePump += (vol * head) / 367 / eta;                            // kWh/giorno (ρg/3,6e6 = 1/367)
      eTow += Math.ceil(pv.r / 55) * 0.55 * 0.5 * hRun;             // torri: ~0,55 kW, 50% di marcia
    }
    const eDay = ePump + eTow;
    const pvArea = (kwp: number) => {
      const mod = (kwp * 1000) / Math.max(50, pvWm2);               // m² di moduli
      return { mod, land: mod / Math.max(0.1, pvGcr / 100) };       // m² di terreno
    };
    // senza batterie
    const pSun = eDay / hSun;
    const kwpNo = Math.max(eDay / (psh * PR), 1.25 * pSun);
    // con batterie
    const fSun = Math.min(1, hSun / hRun);
    const eNight = eDay * (1 - fSun);
    const kwpBat = (eDay * fSun + eNight / Math.max(0.5, pvBattEff / 100)) / (psh * PR);
    const battKwh = eNight / Math.max(0.2, pvDod / 100);
    return { psh, pshAuto: pvPsh == null, designMonth: psSite?.design_month, eDay, ePump, eTow, irrHa, n: pivots.length,
      no: { kwp: kwpNo, pPump: pSun, ...pvArea(kwpNo) },
      bat: { kwp: kwpBat, pPump: eDay / hRun, battKwh, ...pvArea(kwpBat) } };
  }
  function renderPowerSupply() {
    if (!pivots.length) return null;
    const num = (label: string, v: number, set: (x: number) => void, step = 1, min = 0, max = 100000) => (
      <label className="text-[11px] text-sage-dark">{label}
        <input type="number" min={min} max={max} step={step} value={v}
          onChange={(e) => { const x = Number(e.target.value); if (Number.isFinite(x)) set(x); }} className="field-input mt-0.5 py-1 text-sm" /></label>
    );
    const S = powerMode === "solar" ? solarSizing() : null;
    const kw = (x: number) => `${fmt(Math.round(x))} kW`;
    const kwp = (x: number) => `${fmt(Math.round(x))} kWp`;
    const m2 = (x: number) => x >= 10000 ? uHa(x / 10000, 1) : `${fmt(Math.round(x))} m²`;
    const row = (label: string, a: string, b: string, strong = false) => (
      <tr className={strong ? "font-semibold text-brand-darker" : ""}>
        <td className="py-0.5 pr-2 text-sage-dark">{label}</td><td className="text-right">{a}</td><td className="text-right">{b}</td>
      </tr>
    );
    return (
      <div className="bg-panel rounded-lg p-2 space-y-2">
        <div className="text-xs font-semibold text-brand-darker">{t("Alimentazione dei pivot")}</div>
        <div className="seg">
          <div className="seg-item" data-active={powerMode === "grid"} onClick={() => setPowerMode("grid")}>{t("Rete / generatore")}</div>
          <div className="seg-item" data-active={powerMode === "solar"} onClick={() => setPowerMode("solar")}>{t("Fotovoltaico")}</div>
        </div>
        {S && (<>
          <div className="text-[11px] text-sage-dark leading-relaxed">
            {t("Energia richiesta")}: <b>{fmt(Math.round(S.eDay))} kWh/{t("giorno")}</b> · {S.n} pivot · {uHa(S.irrHa)}
            <br />{t("Irraggiamento di progetto")}: <b>{fmt(S.psh, { maximumFractionDigits: 1 })} kWh/m²/{t("giorno")}</b>
            {S.pshAuto && S.designMonth ? ` (${t("mese di punta")}: ${new Date(2026, S.designMonth - 1, 1).toLocaleString(lang, { month: "long" })})` : S.pshAuto ? ` (${t("valore predefinito: posa i pivot per il dato del sito")})` : ""}
          </div>
          <table className="w-full text-[11px] tabular-nums">
            <thead><tr className="text-sage-dark border-b border-black/10">
              <th />
              <th className="text-right font-medium">{t("Senza batterie")}</th>
              <th className="text-right font-medium">{t("Con batterie")}</th>
            </tr></thead>
            <tbody>
              {row(t("Ore di pompaggio"), `${fmt(Math.min(14, Math.max(1, pvSunH)))} h`, `${fmt(Math.min(24, Math.max(1, hoursDay)))} h`)}
              {row(t("Potenza pompe + torri"), kw(S.no.pPump), kw(S.bat.pPump))}
              {row(t("Campo fotovoltaico"), kwp(S.no.kwp), kwp(S.bat.kwp), true)}
              {row(t("Superficie moduli"), m2(S.no.mod), m2(S.bat.mod))}
              {row(t("Terreno occupato"), m2(S.no.land), m2(S.bat.land), true)}
              {row(t("% della superficie irrigata"), `${fmt((S.no.land / 10000 / Math.max(0.01, S.irrHa)) * 100, { maximumFractionDigits: 1 })}%`, `${fmt((S.bat.land / 10000 / Math.max(0.01, S.irrHa)) * 100, { maximumFractionDigits: 1 })}%`)}
              {row(t("Batterie"), "—", `${fmt(Math.round(S.bat.battKwh))} kWh`, true)}
            </tbody>
          </table>
          <p className="text-[10px] text-sage-dark leading-snug">{t("Senza batterie si pompa solo con il sole: pompe più grandi, nessun accumulo. Con batterie si pompa nelle ore di esercizio impostate: pompe più piccole, campo un po' più grande per le perdite di ciclo. Superficie a terra esclusa viabilità e cabine.")}</p>
          <button className="text-[11px] text-brand-mid" onClick={() => setSolarOpen((o) => !o)}>{solarOpen ? "▾" : "▸"} {t("Parametri del calcolo")}</button>
          {solarOpen && (
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] text-sage-dark">{t("Irraggiamento (kWh/m²/giorno)")}
                <input type="number" min={0.5} max={12} step={0.1} value={pvPsh ?? ""} placeholder={fmt(S.psh, { maximumFractionDigits: 1 })}
                  onChange={(e) => setPvPsh(e.target.value === "" ? null : Number(e.target.value))} className="field-input mt-0.5 py-1 text-sm" /></label>
              {num(t("Ore di pompaggio col sole"), pvSunH, setPvSunH, 0.5, 1, 14)}
              {num(t("Sollevamento + perdite in rete (m)"), pvHead, setPvHead, 1, 0, 300)}
              {num(t("Rendimento pompa·motore·inverter (%)"), pvEta, setPvEta, 1, 20, 95)}
              {num(t("Performance ratio FV (%)"), pvPR, setPvPR, 1, 30, 95)}
              {num(t("Potenza moduli (Wp/m²)"), pvWm2, setPvWm2, 5, 50, 300)}
              {num(t("Copertura del suolo (%)"), pvGcr, setPvGcr, 1, 10, 100)}
              {num(t("Profondità di scarica (%)"), pvDod, setPvDod, 1, 20, 100)}
              {num(t("Rendimento ciclo batterie (%)"), pvBattEff, setPvBattEff, 1, 50, 100)}
            </div>
          )}
          <p className="text-[10px] text-sage-dark">{t("Volume e ore di esercizio dalla pagina Irrigazione; pressione di ogni pivot dal calcolo idraulico.")}</p>
        </>)}
      </div>
    );
  }
  // Gruppo di strade nell'albero Livelli: UNA riga (occhio, zoom, rimuovi tutto),
  // espandibile per vedere i singoli tratti.
  function roadGroupRow(gkey: string, items: { r: RoadL; i: number }[]) {
    if (!items.length) return null;
    const ids = new Set(items.map((x) => x.r.id));
    const anyVis = items.some((x) => !x.r.hidden);
    const km = items.reduce((a, x) => a + lineLenKm(x.r.coords), 0);
    const open = openRoadGroups.has(gkey);
    return (
      <li key={gkey}>
        <div className="flex items-center gap-1 text-[11px] bg-panel rounded px-1.5 py-0.5">
          <button className="text-sage-dark w-3 text-[10px]" onClick={() => toggleRoadGroup(gkey)}>{open ? "▾" : "▸"}</button>
          <button className="text-brand-mid w-4" title={t("Mostra/Nascondi tutto")} onClick={() => setRoadsHiddenByIds(ids, anyVis)}>{anyVis ? "◉" : "○"}</button>
          <button className="flex-1 text-left leading-tight" title={t("Zoom")} onClick={() => zoomToCoords(items.flatMap((x) => x.r.coords))}>
            {t("Strade")} · {items.length} {t("tratti")} · {uKm(km)}
          </button>
          <button className="text-danger w-4" title={t("Rimuovi tutte")} onClick={() => removeRoadsByIds(ids)}>✕</button>
        </div>
        {open && (
          <ul className="space-y-0.5 mt-0.5 ml-4">
            {items.map(({ r, i }) => objRow("road", r.id, `r${r.id}`, !!r.hidden, () => toggleRoadHidden(i), <>{t("Strada")} {i + 1} · {uM(r.width_m)}</>, () => zoomToCoords(r.coords), () => removeRoad(i)))}
          </ul>
        )}
      </li>
    );
  }
  // Cartella del pannello Livelli (intestazione con freccia + occhio + conteggio).
  function renderLayerFolder(key: "canali" | "strade" | "invasi" | "pivot", label: string, count: number, anyVisible: boolean, onToggleAll: () => void, body: React.ReactNode) {
    const open = openFolders[key];
    return (
      <div className="mt-1">
        <div className="flex items-center gap-1 px-1 py-1 rounded-md hover:bg-black/5">
          <button className="text-sage-dark w-3 text-[10px]" onClick={() => setOpenFolders((o) => ({ ...o, [key]: !o[key] }))}>{open ? "▾" : "▸"}</button>
          <button className="text-brand-mid w-4" title={t("Mostra/Nascondi tutto")} onClick={onToggleAll} disabled={!count}>{count && anyVisible ? "◉" : "○"}</button>
          <button className="flex-1 text-left text-xs font-semibold text-brand-darker" onClick={() => setOpenFolders((o) => ({ ...o, [key]: !o[key] }))}>{label}</button>
          <span className="text-[11px] text-sage-dark tabular-nums">{count}</span>
        </div>
        {open && count > 0 && <ul className="space-y-0.5 ml-4 mt-0.5">{body}</ul>}
        {open && count === 0 && <p className="text-[11px] text-sage-dark ml-5 mb-1">{t("Vuoto")}</p>}
      </div>
    );
  }

  // ---- Riepilogo di progetto (pagina «Informazioni») -----------------------
  // Numeri d'insieme su tutto ciò che è disegnato: macchine, acqua, rete.
  const projectStats = useMemo(() => {
    const pvs = pivots;
    const rs = pvs.map((p) => p.r).sort((a, b) => a - b);
    const med = rs.length ? (rs.length % 2 ? rs[(rs.length - 1) / 2] : (rs[rs.length / 2 - 1] + rs[rs.length / 2]) / 2) : 0;
    const pivHa = pvs.reduce((a, p) => a + pvAreaM2(p) / 10000, 0);
    const qLs = pvs.reduce((a, p) => a + pivotFlow(p), 0);

    const pipes = pivotLines.filter((l) => l.kind === "pipe");
    const pipeM = pipes.reduce((a, l) => a + lineLenKm(l.coords), 0) * 1000;

    // Stazioni di pompaggio = prese sull'acqua: vertici di tubazione a contatto
    // con canale o corso d'acqua. Stessa soglia (15 m) e stesso criterio del
    // calcolo idraulico, così i due numeri non si contraddicono.
    const water = waterLinesLL();
    const latRef = pvs[0]?.lat ?? fields[0]?.geom.coordinates[0][0][1] ?? 45;
    const mLng = 111320 * Math.cos((latRef * Math.PI) / 180), mLat = 110540;
    const W = water.map((ln) => ln.map((q) => [q[0] * mLng, q[1] * mLat] as [number, number]));
    const dSeg = (p: [number, number], a: [number, number], b: [number, number]) => {
      const vx = b[0] - a[0], vy = b[1] - a[1]; const l2 = vx * vx + vy * vy || 1e-9;
      let tt = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2; tt = Math.max(0, Math.min(1, tt));
      return Math.hypot(p[0] - (a[0] + vx * tt), p[1] - (a[1] + vy * tt));
    };
    const taps: [number, number][] = [];
    for (const l of pipes) {
      for (const c of l.coords) {
        const m2: [number, number] = [c[0] * mLng, c[1] * mLat];
        let on = false;
        for (const w of W) { for (let i = 0; i < w.length - 1; i++) if (dSeg(m2, w[i], w[i + 1]) < 15) { on = true; break; } if (on) break; }
        // Due prese a meno di 40 m sono la stessa opera: si contano una volta.
        if (on && !taps.some((tp) => Math.hypot(tp[0] - m2[0], tp[1] - m2[1]) < 40)) taps.push(m2);
      }
    }

    // Ettari irrigati: unione dei cerchi ritagliata sui poligoni. Sommare le
    // aree conterebbe due volte le sovrapposizioni e le parti fuori campo.
    const rings = fields.map((f) => f.geom.coordinates[0]).filter((r) => r?.length >= 4);
    const grossHa = fields.reduce((a, f) => a + ringAreaHa(f.geom.coordinates), 0);
    let irrHa = 0;
    if (rings.length && pvs.length) {
      let mnx = 180, mny = 90, mxx = -180, mxy = -90;
      for (const rg of rings) for (const q of rg) {
        if (q[0] < mnx) mnx = q[0]; if (q[0] > mxx) mxx = q[0];
        if (q[1] < mny) mny = q[1]; if (q[1] > mxy) mxy = q[1];
      }
      const N = 320;
      const inPoly = (x: number, y: number, rg: number[][]) => {
        let inside = false;
        for (let i = 0, j = rg.length - 1; i < rg.length; j = i++) {
          const xi = rg[i][0], yi = rg[i][1], xj = rg[j][0], yj = rg[j][1];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      };
      const pc = pvs.map((p) => [p.lng * mLng, p.lat * mLat, p.r * p.r] as [number, number, number]);
      let tot = 0, cov = 0;
      for (let iy = 0; iy < N; iy++) {
        const y = mny + ((mxy - mny) * (iy + 0.5)) / N;
        for (let ix = 0; ix < N; ix++) {
          const x = mnx + ((mxx - mnx) * (ix + 0.5)) / N;
          if (!rings.some((rg) => inPoly(x, y, rg))) continue;
          tot++;
          const px = x * mLng, py = y * mLat;
          for (const [cx, cy, r2] of pc) {
            const dx = px - cx, dy = py - cy;
            if (dx * dx + dy * dy <= r2) { cov++; break; }
          }
        }
      }
      if (tot) irrHa = (grossHa * cov) / tot;
    }

    return {
      n: pvs.length, medR: med, minR: rs[0] ?? 0, maxR: rs[rs.length - 1] ?? 0,
      medHa: (Math.PI * med * med) / 10000, pivHa,
      qLs, qM3h: qLs * 3.6, pumps: taps.length,
      pipeM, pipeN: pipes.length,
      grossHa, irrHa, todoHa: Math.max(0, grossHa - irrHa),
    };
  }, [pivots, pivotLines, fields, canals, watercourses, mmDes, hoursDay]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Campi che finiranno nell'esportazione (tutti tranne quelli tolti a mano).
  const pdfPick = fields.filter((f) => !pdfSkip.has(f.id));

  // Statistiche di un poligono per il pannello Livelli: superficie irrigata
  // (somma dei cerchi dei pivot che gli appartengono), medie per macchina e
  // sviluppo complessivo delle tubazioni del gruppo.
  function fieldStats(fid: number) {
    const pv = pivots.filter((p) => p.field === fid);
    const irrHa = pv.reduce((s, p) => s + pvAreaM2(p) / 10000, 0);
    const pipes = pivotLines.filter((l) => l.kind === "pipe" && l.field === fid);
    const canalKm = canals.filter((c) => c.owner === fid).reduce((s, c) => s + (c.length_m || 0) / 1000, 0);
    // Mediana dei raggi: piu' rappresentativa della media quando il gruppo ha
    // alcuni pivot ridotti sui bordi che abbasserebbero il valore medio.
    const rs = pv.map((p) => p.r).sort((a, b) => a - b);
    const medR = rs.length ? (rs.length % 2 ? rs[(rs.length - 1) / 2] : (rs[rs.length / 2 - 1] + rs[rs.length / 2]) / 2) : 0;
    return {
      n: pv.length,
      irrHa,
      medHa: (Math.PI * medR * medR) / 10000,
      medR,
      pipeN: pipes.length,
      pipeM: pipes.reduce((s, l) => s + lineLenKm(l.coords), 0) * 1000,
      canalKm,
    };
  }

  // Riga dell'elenco Campi come albero: un campo con, annidati, i suoi
  // poligoni figli (famiglia) e le eventuali sotto-aree (macro).
  function renderFieldNode(f: Field, depth: number) {
    const st = fieldStats(f.id);
    const kids = fields.filter((x) => x.parentId === f.id);
    const ownedCanals = canals.map((c, i) => ({ c, i })).filter((x) => x.c.owner === f.id);
    const ownedRoads = roads.map((r, i) => ({ r, i })).filter((x) => x.r.owner === f.id);
    const ownedWater = watercourses.map((w, i) => ({ w, i })).filter((x) => x.w.owner === f.id);
    const ownedPivN = pivots.filter((p) => p.field === f.id).length;
    const ownedPipeN = pivotLines.filter((l) => l.kind === "pipe" && l.field === f.id).length;
    const hasNested = kids.length || (f.macros?.length ?? 0) || ownedCanals.length || ownedRoads.length || ownedWater.length || ownedPivN || ownedPipeN;
    return (
      <li key={f.id}
        draggable
        onDragStart={(e) => { e.stopPropagation(); dragRef.current = { kind: "field", id: f.id }; e.dataTransfer.effectAllowed = "move"; }}
        onDragOver={(e) => { if (dragRef.current && !(dragRef.current.kind === "field" && dragRef.current.id === f.id)) { e.preventDefault(); e.stopPropagation(); if (dragOverField !== f.id) setDragOverField(f.id); } }}
        onDragLeave={(e) => { e.stopPropagation(); setDragOverField((d) => (d === f.id ? null : d)); }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); assignToField(dragRef.current, f.id); dragRef.current = null; setDragOverField(null); }}
        onDragEnd={() => { dragRef.current = null; setDragOverField(null); }}
        className={`text-sm rounded-lg px-2 py-1 cursor-move ${dragOverField === f.id ? "ring-2 ring-brand" : f.id === activeId ? "bg-brand/10 ring-1 ring-brand/40" : "bg-panel"} ${f.hidden ? "opacity-50" : ""}`}>
        <div className="flex items-center justify-between">
          <button className="truncate text-left flex-1" title={t("Seleziona · trascina qui gli oggetti per assegnarli")} onClick={() => selectField(f.id)}>
            {depth > 0 && <span className="text-brand-light">↳ </span>}
            <span className="text-[9px] uppercase font-semibold mr-1 px-1 py-0.5 rounded" style={{ background: (f.level === "campo" ? "#e4f4ea" : "#fdefe0"), color: (f.level === "campo" ? "#03683a" : "#b5651a") }}>{f.level === "campo" ? t("Campo") : t("Area")}</span>
            <span className={f.id === activeId ? "font-semibold text-brand" : ""}>{f.name}</span>
            <span className="text-sage"> · {t("lorda")} {uHa(ringAreaHa(f.geom.coordinates))}</span>
            {st.irrHa > 0 && <span className="text-brand-light"> · {t("irrigata")} {uHa(st.irrHa)}</span>}
            {f.level === "campo" && f.score != null && <span className="text-brand-light"> · {t("Idoneità")} {fmt(f.score)}</span>}
            {!!kids.length && <span className="text-brand-light"> · {kids.length} {t("figli")}</span>}
            {!!f.macros?.length && <span className="text-brand-light"> · {f.macros.length} {t("sotto-aree")}</span>}
          </button>
          <span className="flex gap-1 shrink-0 items-center">
            <button className="text-sm text-brand w-4 font-semibold" title={t("Aggiungi poligono figlio")} onClick={() => addChild(f.id)}>＋</button>
            <button className="text-xs text-brand-mid w-4" title={f.hidden ? t("Mostra sulla mappa") : t("Nascondi dalla mappa")} onClick={() => toggleFieldHidden(f.id)}>{f.hidden ? "○" : "◉"}</button>
            <button className="text-xs text-brand-mid" title={t("Esporta KMZ")} onClick={() => exportKmz(safe(f.name), [{ name: f.name, geom: f.geom }, ...(f.macros ?? []).map((mm) => ({ name: mm.name, geom: mm.geom }))])}>⤓</button>
            <button className="text-xs text-brand-mid" title={t("Nome campo")} onClick={() => renameField(f)}>✎</button>
            <button className="text-xs text-danger" title={t("Rimuovi")} onClick={() => removeField(f)}>✕</button>
          </span>
        </div>
        {hasNested ? (
          <ul className="mt-1 ml-1 space-y-1 border-l-2 border-brand/20 pl-2">
            {kids.map((k) => renderFieldNode(k, depth + 1))}
            {(f.macros ?? []).map((mm) => (
              <li key={`m${mm.id}`} className="flex items-center justify-between text-[11px] text-sage-dark">
                <span className="truncate flex-1">↳ {mm.name} · {uHa(mm.area_ha)} · {t("Idoneità")} {fmt(mm.mean_score)}{mm.savedId ? " ✓" : ""}</span>
                <span className="flex gap-1 shrink-0">
                  <button className="text-brand-mid" title={t("Esporta KMZ")} onClick={() => exportKmz(safe(mm.name), [{ name: mm.name, geom: mm.geom }])}>⤓</button>
                  <button className="text-brand-mid" title={t("Nome sotto-area")} onClick={() => renameFieldMacro(f.id, mm)}>✎</button>
                  <button className="text-danger" title={t("Rimuovi")} onClick={() => removeFieldMacro(f.id, mm.id)}>✕</button>
                </span>
              </li>
            ))}
            {ownedCanals.map(({ c, i }) => objRow("canal", i, `c${i}`, !!c.hidden, () => toggleCanalHidden(i), <>{t("Canale")} {i + 1} · {uM(c.length_m)}</>, () => zoomToCoords(c.geojson.coordinates), () => removeCanal(i)))}
            {roadGroupRow(`f${f.id}`, ownedRoads)}
            {ownedWater.map(({ w, i }) => { const coords = w.geojson.type === "Polygon" ? w.geojson.coordinates[0] : w.geojson.coordinates; return objRow("water", i, `w${i}`, !!w.hidden, () => toggleWaterHidden(i), <>{w.kind} {i + 1}</>, () => zoomToCoords(coords), () => removeWater(i)); })}
            {ownedPivN > 0 && objRow("pivot", f.id, `pv${f.id}`, hiddenPivotFields.has(f.id), () => togglePivotFieldHidden(f.id),
              <>{t("Pivot")} · {ownedPivN} · {uHa(st.irrHa)}<span className="text-sage-dark"> · {t("mediana")} {uHa(st.medHa, 1)} / {uM(st.medR)}</span></>,
              () => zoomToCoords(f.geom.coordinates[0]), () => removePivotsOfField(f.id))}
            {ownedPipeN > 0 && objRow("pipe", f.id, `pi${f.id}`, hiddenPipeFields.has(f.id), () => togglePipeFieldHidden(f.id),
              <>{t("Tubazioni")} · {ownedPipeN} {t("rami")} · {uM(st.pipeM)}</>,
              () => zoomToPipesOfField(f.id), () => removePipesOfField(f.id))}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <main>
      <MapCanvas apiRef={mapApi} onCreate={addDrawnField} onEditActive={updateActiveGeom} onSelect={selectField}
        onCanalProfile={(i) => setProfileCanal(i)} onDrawChange={setDrawing} />

      {/* Pannellino di controllo del disegno/tracciatura (snap ai confini dei poligoni attivo). */}
      {drawing && (
        <div className="ui-scale fixed top-20 left-1/2 -translate-x-1/2 z-[500] widget px-2 py-1.5 flex items-center gap-2 pointer-events-auto">
          <span className="text-[11px] text-sage-dark px-1 hidden sm:inline">{t("Disegno in corso — aggancia ai bordi/vertici")}</span>
          <button className="btn-ghost" title={t("Annulla ultimo punto")} onClick={() => mapApi.current?.drawUndo()}>↶ {t("Ultimo punto")}</button>
          <button className="btn-primary" title={t("Concludi il tracciato")} onClick={() => mapApi.current?.drawFinish()}>{t("Fine")}</button>
          <button className="btn-ghost text-danger" title={t("Esci dalla modalità disegno")} onClick={() => mapApi.current?.drawCancel()}>✕ {t("Chiudi")}</button>
        </div>
      )}

      <div className="overlay-layer">
        {/* Header "famiglia Argus": cluster flottanti sopra la mappa, non una
            barra piena. Il contenitore lascia passare i click alla mappa negli
            spazi vuoti; ogni cluster è un'isola con ombra propria. */}
        <div className="absolute top-3 left-3 right-3 grid grid-cols-[1fr_auto_1fr] items-start gap-3 z-[1500] font-brand">

          {/* colonna sinistra */}
          <div className="flex items-center gap-3 flex-wrap justify-self-start">

          {/* 1 — marchio · Home · cronologia · avvisi */}
          <div className="nabu-bar pl-2 pr-2 py-1.5 gap-1 relative">
            <button onClick={goHome} title={t("Vista iniziale")} className="flex items-center gap-2 pr-1">
              <div className="bg-white rounded-full p-1 flex items-center justify-center shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/argusmark.png" alt="Argus" className="h-6 w-6" />
              </div>
              <div className="leading-tight text-left">
                <div className="font-brand font-extrabold text-[15px] text-nabu-cream">Argus Total</div>
                <div className="text-[9px] uppercase tracking-[0.18em] text-nabu-sub">NABU</div>
              </div>
            </button>

            <span className="w-px h-7 bg-white/10" />

            <button onClick={goHome} className="nav-pill" title={t("Vista iniziale")} aria-label={t("Home")}><IcoHome /></button>

            <button onClick={undo} disabled={!canUndo} className="nav-pill"
              title={canUndo ? t("Annulla l'ultima operazione") : t("Niente da annullare")} aria-label={t("Annulla")}>
              ↩{undoN > 1 ? ` (${undoN})` : ""}
            </button>
            <button onClick={redo} disabled={!canRedo} className="nav-pill"
              title={canRedo ? t("Rifai l'operazione annullata") : t("Niente da rifare")} aria-label={t("Rifai")}>
              ↪{redoN > 1 ? ` (${redoN})` : ""}
            </button>

            <button onClick={() => { setBellOpen((o) => { if (!o) setAlertsSeen(alerts.length); return !o; }); setMapMenuOpen(false); }}
              className="nav-pill relative" title={t("Avvisi")} aria-label={t("Avvisi")}>
              <IcoBell />
              {unseen > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 text-[10px] font-bold bg-nabu-accent text-white rounded-full grid place-items-center">
                  {unseen > 9 ? "9+" : unseen}
                </span>
              )}
            </button>

            {bellOpen && (<>
              <div className="fixed inset-0" onClick={() => setBellOpen(false)} />
              <div className="absolute top-full right-0 mt-2 widget p-2 w-80 max-h-72 overflow-auto scroll-soft z-10">
                <div className="px-2 py-1 text-[11px] font-semibold text-sage-dark uppercase tracking-wide">{t("Avvisi")}</div>
                {!alerts.length && <div className="px-2 py-2 text-sm text-sage-dark">{t("Nessun avviso.")}</div>}
                {alerts.map((n) => (
                  <div key={n.id} className="px-2 py-1.5 text-[13px] text-brand-darker border-t border-black/5 first:border-0">
                    <span className="text-[10px] text-sage-dark tabular-nums mr-2">
                      {new Date(n.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    {n.text}
                  </div>
                ))}
                {alerts.length > 0 && (
                  <button onClick={() => { setAlerts([]); setAlertsSeen(0); }}
                    className="mt-1 w-full text-[12px] text-sage-dark hover:text-brand py-1">{t("Svuota")}</button>
                )}
              </div>
            </>)}
          </div>

          {/* 2 — strumenti mappa */}
          <div className="relative">
            <div className="nabu-cluster gap-1 px-1.5 py-1.5">
              <button onClick={() => { setMapMenuOpen((o) => !o); setBellOpen(false); }}
                className={"tool-btn " + (mapMenuOpen ? "tool-btn-active" : "")}
                title={t("Livelli e mappa di base")} aria-label={t("Livelli")}><IcoLayers /></button>
              <button onClick={toggleMeasure} className={"tool-btn " + (measuring ? "tool-btn-active" : "")}
                title={t("Misura distanze/aree")} aria-label={t("Righello")}><IcoRuler /></button>
              <button onClick={toggleCircles} className={"tool-btn " + (circling ? "tool-btn-active" : "")}
                title={t("Simula pivot: cerchi dal centro")} aria-label={t("Cerchi")}><IcoCircleRuler /></button>
              <button onClick={toggleElevation} className={"tool-btn " + (elevOn ? "text-white" : "")}
                style={elevOn ? { background: "#b23b1e" } : undefined}
                title={t("Profilo altimetrico / dislivelli (polilinea)")} aria-label={t("Quote")}><IcoElevation /></button>
              <span className="w-px h-5 bg-black/10" />
              <button onClick={() => setPropsOpen((o) => !o)}
                className={"tool-btn font-semibold italic " + (propsOpen ? "bg-brand/10 text-brand" : "")}
                title={t("Proprietà (livello / oggetto selezionato)")} aria-label={t("Proprietà")}>i</button>
            </div>

            {mapMenuOpen && (<>
              <div className="fixed inset-0" onClick={() => setMapMenuOpen(false)} />
              <div className="absolute top-full left-0 mt-2 widget p-3 w-56 z-10 space-y-2">
                <div className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide">{t("Mappa di base")}</div>
                {([["sat", t("Satellite")], ["street", t("Stradale")], ["topo", t("Topografica")]] as const).map(([k, label]) => (
                  <label key={k} className="flex items-center gap-2 text-sm text-brand-darker cursor-pointer">
                    <input type="radio" name="basemap" checked={basemap === k} onChange={() => setBasemap(k)} />
                    {label}
                  </label>
                ))}
                <div className="border-t border-black/5 pt-2">
                  <label className="flex items-center gap-2 text-sm text-brand-darker cursor-pointer">
                    <input type="checkbox" checked={mapLabels} onChange={(e) => setMapLabels(e.target.checked)} />
                    {t("Etichette (confini e nomi)")}
                  </label>
                </div>
                {measuring && (
                  <button onClick={() => { mapApi.current?.stopMeasure(); setMeasureTxt(""); mapApi.current?.startMeasure(setMeasureTxt); }}
                    className="btn-ghost w-full">{t("Cancella misure")}</button>
                )}
                {circling && (
                  <button onClick={() => { setCircleInfo(null); mapApi.current?.clearCircles(); }}
                    className="btn-ghost w-full">{t("Cancella cerchi")}</button>
                )}
              </div>
            </>)}
          </div>

          {measuring && measureTxt && (
            <div className="nabu-bar px-3 py-2.5 text-sm text-white">{measureTxt}</div>
          )}

          {circling && circleInfo && (circleInfo.r != null || circleInfo.n > 0) && (
            <div className="nabu-bar px-3 py-2.5 text-sm text-white">
              {circleInfo.r != null
                ? `${t("Raggio")} ${uM(circleInfo.r)} \u00b7 ${uHa(circleInfo.ha ?? 0, 1)}`
                : `${t("Cerchi")}: ${circleInfo.n} \u00b7 ${uHa(circleInfo.totHa, 1)}`}
            </div>
          )}
          </div>

          {/* 3 — ricerca: colonna centrale della griglia, quindi centrata sullo schermo */}
          <form onSubmit={geocode} className="nabu-cluster gap-2 pl-1.5 pr-1.5 py-1.5 w-[min(28rem,calc(42vw/var(--ui-scale)))] min-w-[220px] justify-self-center">
            <button type="button" onClick={() => mapApi.current?.locate()}
              className="bg-nabu-accent text-white rounded-[9px] w-9 h-9 grid place-items-center shrink-0 hover:bg-nabu-accentDark"
              title={t("Usa la mia posizione (GPS)")} aria-label={t("La mia posizione")}><IcoCross /></button>
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={t("Indirizzo o coordinate GPS (lat, lon)")}
              className="flex-1 bg-transparent text-sm outline-none min-w-0" />
            <button type="submit"
              className="bg-nabu-accent text-white text-[13px] font-semibold rounded-[9px] px-3.5 py-2 shrink-0 hover:bg-nabu-accentDark">
              {t("Cerca")}
            </button>
          </form>

          {/* 4 — blocco destro */}
          <div className="flex items-center gap-3 flex-wrap justify-end justify-self-end">
            <div className="nabu-bar p-1 gap-1" role="group" aria-label={t("Unità di misura")}>
              <button onClick={() => setUnits("metric")}
                className={"px-3 py-1.5 rounded-[9px] text-[13px] font-medium transition " + (!imperial ? "bg-nabu-accent text-white" : "text-nabu-sage hover:text-white")}>
                {t("Metrico")}
              </button>
              <button onClick={() => setUnits("imperial")}
                className={"px-3 py-1.5 rounded-[9px] text-[13px] font-medium transition " + (imperial ? "bg-nabu-accent text-white" : "text-nabu-sage hover:text-white")}>
                {t("Imperiale")}
              </button>
            </div>

            <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}
              className="nabu-bar text-white text-sm px-3.5 py-2.5 appearance-none outline-none border-none"
              aria-label={t("Lingua")}>
              {LANGS.map((l) => <option key={l.code} value={l.code} className="text-brand-dark">{l.label}</option>)}
            </select>

            {usage && (
              <div className={"nabu-cluster text-xs px-3.5 py-2.5 font-medium " + creditClass(usage)}
                title={t("Crediti")}>
                <span className="opacity-80 mr-1.5">{usage.scope === "user" ? t("Crediti") : t("Totale")}</span>
                <b className="tabular-nums">{usage.requests_used}{usage.requests_limit != null ? ` / ${usage.requests_limit}` : ""}</b>
              </div>
            )}

            {me?.is_admin && (
              <button onClick={() => setMsg(t("Dashboard multi-cliente: non ancora disponibile in Argus Total."))}
                className="nabu-bar text-white px-3.5 py-2.5 hover:bg-nabu-greenDark"
                title={t("Dashboard")} aria-label={t("Dashboard")}><IcoDash /></button>
            )}
            {me?.is_admin && (
              <button onClick={openUsers}
                className="nabu-bar text-white px-3.5 py-2.5 hover:bg-nabu-greenDark"
                title={t("Gestione utenti")} aria-label={t("Gestione utenti")}>👥</button>
            )}
            {me && (
              <button onClick={logout}
                className="nabu-bar text-white text-sm px-4 py-2.5 hover:bg-nabu-greenDark"
                title={t("Esci")}>{t("Esci")}</button>
            )}
          </div>
        </div>

        {elevOn && (
          <div className="absolute top-[4.5rem] left-1/2 -translate-x-1/2 z-[1400] px-3 py-1.5 rounded-xl text-xs text-white shadow-cluster w-[280px] bg-nabu-green">
            {!elevData || !elevData.points.length ? (
              <span>{t("Profilo: clicca i punti sulla mappa")}</span>
            ) : (<>
              <div className="font-semibold">
                {t("Dislivello totale")}: {elevData.total_drop_m != null ? uM(elevData.total_drop_m, 1) : "—"}
                {" · "}{t("Lungh.")}: {uKm((elevData.length_m || 0) / 1000)}
              </div>
              <div className="mt-0.5 max-h-28 overflow-y-auto scroll-soft leading-tight">
                {elevData.points.map((p, i) => (
                  <div key={i} className="flex justify-between gap-3">
                    <span className="opacity-90">{i + 1}</span>
                    <span>{p.elev_m != null ? uM(p.elev_m, 0) : "—"}</span>
                    <span className="opacity-80 w-16 text-right">
                      {p.drop_prev_m != null ? (p.drop_prev_m >= 0 ? `▼ ${uM(p.drop_prev_m, 1)}` : `▲ ${uM(-p.drop_prev_m, 1)}`) : ""}
                    </span>
                  </div>
                ))}
              </div>
            </>)}
          </div>
        )}

        {/* Colonna sinistra: pannello Progetto + widget Proprietà (impilati) */}
        <div className="absolute top-[4.5rem] left-4 bottom-[6.5rem] w-[440px] max-w-[calc(100vw/var(--ui-scale)_-_2rem)] flex flex-col gap-3 z-30 pointer-events-none">
        {leftMin ? (
          <button onClick={() => setLeftMin(false)} title={t("Espandi il pannello Progetto")}
            className="pointer-events-auto self-start widget px-3 py-2 flex items-center gap-2 text-sm text-brand-darker hover:bg-black/5">
            <IcoExpand /> {t("Progetto")}
          </button>
        ) : (
        <div className="pointer-events-auto w-full max-h-[calc(52vh/var(--ui-scale))] shrink-0 widget flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 pt-2 shrink-0">
            <span className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide">{t("Progetto")}</span>
            <button onClick={() => setLeftMin(true)} title={t("Riduci a icona")}
              className="text-sage-dark hover:text-brand p-1 rounded hover:bg-black/5"><IcoMinimize /></button>
          </div>
          <div className="overflow-auto scroll-soft p-4 pt-2 space-y-4">
          <section>
            <h3 className="text-sm font-semibold text-brand-darker mb-1">{t("Cliente")}</h3>
            <div className="flex gap-2">
              <select className="field-input" value={clientId ?? ""}
                onChange={(e) => setClientId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">{t("Seleziona o crea")}</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button className="btn-primary shrink-0" onClick={newClient}>+</button>
              <button className="btn-ghost shrink-0 text-danger px-2 disabled:opacity-40 disabled:cursor-not-allowed" disabled={clientId == null} onClick={deleteCurrentClient}
                title={t("Elimina cliente")} aria-label={t("Elimina cliente")}><IcoTrash /></button>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-brand-darker mb-1">{t("Progetto")}</h3>
            <div className="flex gap-2">
              <select className="field-input" value={projectId ?? ""}
                onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">{t("Seleziona o crea")}</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button className="btn-primary shrink-0" onClick={newProject}>+</button>
              <button className="btn-ghost shrink-0 text-danger px-2 disabled:opacity-40 disabled:cursor-not-allowed" disabled={projectId == null} onClick={deleteCurrentProject}
                title={t("Elimina progetto")} aria-label={t("Elimina progetto")}><IcoTrash /></button>
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-semibold text-brand-darker">{t("Campi")}</h3>
              {hasFields && <span className="text-[11px] text-sage-dark">{rootFields.length} {t("campi")} · {uHa(totalHa)}</span>}
            </div>
            <div className="flex gap-2">
              <button className="btn-primary flex-1 basis-0" onClick={draw}>{t("Disegna area")}</button>
              <button className="btn-ghost flex-1 basis-0" onClick={() => fileRef.current?.click()}>{t("Importa")}</button>
              <button className="btn-ghost flex-1 basis-0" onClick={clearAllFields}>{t("Svuota campi")}</button>
            </div>
            <input ref={fileRef} type="file" accept=".geojson,.json,.kml,.kmz" className="hidden"
              onChange={(e) => { importFile(e.target.files?.[0] ?? undefined); if (e.target) e.target.value = ""; }} />

            {hasFields && (
                <ul className="space-y-1 mt-2">
                  {rootFields.map((f) => renderFieldNode(f, 0))}
                </ul>
              )}
            {hasFields && (
              <div
                onDragOver={(e) => { if (dragRef.current) { e.preventDefault(); if (dragOverField !== "root") setDragOverField("root"); } }}
                onDragLeave={() => setDragOverField((d) => (d === "root" ? null : d))}
                onDrop={(e) => { e.preventDefault(); assignToField(dragRef.current, null); dragRef.current = null; setDragOverField(null); }}
                className={`text-[11px] text-center rounded-lg border border-dashed mt-1 py-1 ${dragOverField === "root" ? "border-brand text-brand bg-brand/5" : "border-black/15 text-sage-dark"}`}>
                {t("Trascina qui per scollegare (livello principale)")}
              </div>
            )}

            {/* Oggetti NON ancora assegnati a un campo: elenco semplice (niente cartelle),
                mostrato solo se ce ne sono. Quelli assegnati compaiono sotto al campo. */}
            {(() => {
              const cItems = canals.map((c, i) => ({ c, i })).filter((x) => x.c.owner == null);
              const rItems = roads.map((r, i) => ({ r, i })).filter((x) => x.r.owner == null);
              const wItems = watercourses.map((w, i) => ({ w, i })).filter((x) => x.w.owner == null);
              const pGroups = pivotGroups.filter((g) => g.fid < 0 || !fields.some((f) => f.id === g.fid));
              const tGroups = pipeGroups.filter((g) => g.fid < 0 || !fields.some((f) => f.id === g.fid));
              if (!cItems.length && !rItems.length && !wItems.length && !pGroups.length && !tGroups.length) return null;
              return (
                <div className="mt-3 border-t border-brand/15 pt-2">
                  <div className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide mb-1">{t("Oggetti non assegnati")}</div>
                  <p className="text-[11px] text-sage-dark mb-1">{t("Trascinali su un campo per assegnarli.")}</p>
                  <ul className="space-y-0.5">
                    {cItems.map(({ c, i }) => objRow("canal", i, `c${i}`, !!c.hidden, () => toggleCanalHidden(i), <>{t("Canale")} {i + 1} · {uM(c.length_m)}</>, () => zoomToCoords(c.geojson.coordinates), () => removeCanal(i)))}
                    {roadGroupRow("unassigned", rItems)}
                    {wItems.map(({ w, i }) => { const coords = w.geojson.type === "Polygon" ? w.geojson.coordinates[0] : w.geojson.coordinates; return objRow("water", i, `w${i}`, !!w.hidden, () => toggleWaterHidden(i), <>{w.kind} {i + 1}</>, () => zoomToCoords(coords), () => removeWater(i)); })}
                    {pGroups.map((g) => objRow("pivot", g.fid, `pg${g.fid}`, hiddenPivotFields.has(g.fid), () => togglePivotFieldHidden(g.fid), <>{g.name} · {g.n} pivot</>, () => {}, () => removePivotsOfField(g.fid)))}
                    {tGroups.map((g) => objRow("pipe", g.fid, `tg${g.fid}`, hiddenPipeFields.has(g.fid), () => togglePipeFieldHidden(g.fid), <>{g.name} · {g.n} {t("tubazioni")}</>, () => zoomToPipesOfField(g.fid), () => removePipesOfField(g.fid)))}
                  </ul>
                </div>
              );
            })()}

            {/* I livelli (con visibilità, download, elimina) sono nel widget «Proprietà» a sinistra. */}

            {/* Stesse regole per tutti vs impostazioni per campo */}
            <label className="text-xs text-sage-dark mt-3 block">{t("Regole di progetto")}</label>
            <div className="seg mt-1">
              <div className="seg-item" data-active={sameRules} onClick={() => setSameRules(true)}>{t("Stesse regole per tutti")}</div>
              <div className="seg-item" data-active={!sameRules} onClick={() => setSameRules(false)}>{t("Impostazioni per campo")}</div>
            </div>
            {!sameRules && active && (
              <p className="text-[11px] text-brand-mid mt-1">{t("Stai modificando: {name}", { name: active.name })}</p>
            )}

            {projectId && (
              <div className="mt-3 flex items-center gap-2 text-[11px] text-sage-dark">
                <span className={"inline-block w-2 h-2 rounded-full " + (autosave === "saving" ? "bg-amber-400 animate-pulse" : autosave === "error" ? "bg-danger" : "bg-brand")} />
                {autosave === "saving" ? t("Salvataggio automatico…") : autosave === "error" ? t("Salvataggio non riuscito (riprovo alla prossima modifica)") : t("Salvataggio automatico attivo — le modifiche vengono salvate da sole")}
              </div>
            )}
            {/* Lista unica: i campi (e i livelli salvati) si caricano automaticamente
                all'apertura del progetto nell'elenco «Campi» qui sopra. Nessun
                elenco «Aree salvate»/«Livelli salvati» separato. */}
          </section>
          </div>
        </div>
        )}

        {/* Widget Proprietà: livelli + oggetto selezionato, subito sotto il pannello Progetto */}
        {!propsOpen && (
          <button onClick={() => setPropsOpen(true)} title={t("Espandi il pannello Proprietà")}
            className="pointer-events-auto self-start widget px-3 py-2 flex items-center gap-2 text-sm text-brand-darker hover:bg-black/5">
            <IcoExpand /> {t("Proprietà")}
          </button>
        )}
        {propsOpen && (
          <div className="pointer-events-auto w-full flex-1 min-h-0 widget flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-3 pt-2 shrink-0">
              <span className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide">{t("Proprietà")}</span>
              <button onClick={() => setPropsOpen(false)} title={t("Riduci a icona")}
                className="text-sage-dark hover:text-brand p-1 rounded hover:bg-black/5"><IcoMinimize /></button>
            </div>
            <div className="overflow-auto scroll-soft p-3 pt-1 space-y-2">
              {selPivot ? (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <b className="text-brand-darker text-sm">{t("Pivot")} #{pivotSel.idx + 1}</b>
                    <button className="text-[11px] text-brand-mid" onClick={() => setPivotSel({ mode: "group", idx: -1 })}>← {t("Gruppo")}</button>
                  </div>
                  <p className="text-[11px] text-sage-dark mb-2">{t("Trascina il pallino giallo sulla mappa per spostarlo.")}</p>
                  <div className="flex gap-2">
                    <label className="text-[11px] text-sage-dark flex-1">{t("Raggio (m)")}
                      <input type="number" min={30} max={1000} step={5} value={Math.round(selPivot.r)}
                        onChange={(e) => updateSelPivot({ r: Number(e.target.value) })} className="field-input mt-1" /></label>
                    <label className="text-[11px] text-sage-dark flex-1">{t("Connessione")}
                      <select className="field-input mt-1" value={selPivot.conn ?? "canal"}
                        onChange={(e) => updateSelPivot({ conn: e.target.value })}>
                        <option value="canal">{t("Canaletta (gravità)")}</option>
                        <option value="pipe">{t("Tubazione (pressione)")}</option>
                      </select></label>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <label className="text-[11px] text-sage-dark flex-1">{t("Portata (l/s)")}
                      <input type="number" min={0} step={1} value={selPivot.q ?? ""} placeholder={String(Math.round(pivotFlow({ r: selPivot.r })))}
                        onChange={(e) => updateSelPivot({ q: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })}
                        className="field-input mt-1" /></label>
                    <label className="text-[11px] text-sage-dark flex-1">{t("Pressione (bar)")}
                      <input type="number" min={0} step={0.1} value={selPivot.p ?? ""} placeholder={pivotPressure({ r: selPivot.r }).toFixed(1)}
                        onChange={(e) => updateSelPivot({ p: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })}
                        className="field-input mt-1" /></label>
                  </div>
                  <div className="text-[10px] text-sage-dark mt-1">{t("Vuoto = calcolato da superficie e fabbisogno.")}</div>
                  <div className="flex gap-2 mt-2">
                    <label className="text-[11px] text-sage-dark flex-1">{t("Settore irrigato (°)")}
                      <input type="number" min={10} max={360} step={5} value={Math.round(selPivot.deg ?? 360)}
                        onChange={(e) => { const d = Math.max(10, Math.min(360, Number(e.target.value) || 360)); updateSelPivot(d >= 360 ? { deg: undefined, az: undefined } : { deg: d, az: selPivot.az ?? 0 }); }}
                        className="field-input mt-1" /></label>
                    <label className="text-[11px] text-sage-dark flex-1">{t("Inizio settore (azimut °)")}
                      <input type="number" min={0} max={359} step={5} value={Math.round(selPivot.az ?? 0)} disabled={(selPivot.deg ?? 360) >= 360}
                        onChange={(e) => updateSelPivot({ az: ((Number(e.target.value) % 360) + 360) % 360 })}
                        className="field-input mt-1" /></label>
                  </div>
                  <label className="text-[11px] text-sage-dark block mt-2">{t("Fase di realizzazione")}
                    <select className="field-input mt-1" value={selPivot.phase ?? 1} onChange={(e) => updateSelPivot({ phase: Number(e.target.value) })}>
                      {Array.from({ length: Math.max(nPhases, phaseN) }, (_, i) => <option key={i + 1} value={i + 1}>{t("Fase")} {i + 1}</option>)}
                    </select></label>
                  <div className="flex gap-2 mt-2 items-end">
                    <label className="flex items-center gap-2 text-[11px] text-sage-dark flex-1 pb-2">
                      <input type="checkbox" checked={!!selPivot.gun} onChange={(e) => updateSelPivot({ gun: e.target.checked ? 25 : undefined })} />
                      {t("Irrigatore finale")}</label>
                    <label className="text-[11px] text-sage-dark flex-1">{t("Gittata (m)")}
                      <input type="number" min={5} max={60} step={1} value={selPivot.gun ?? 25} disabled={!selPivot.gun}
                        onChange={(e) => updateSelPivot({ gun: Math.max(5, Math.min(60, Number(e.target.value) || 25)) })}
                        className="field-input mt-1" /></label>
                  </div>
                  <div className="text-[11px] text-sage-dark mt-1">{t("Area")}: <b>{uHa(pvAreaM2(selPivot) / 10000, 1)}</b></div>
                  {(() => {
                    const c = spanComposition(selPivot, pivotBrand);
                    if (!c) return <div className="text-[11px] text-sage-dark mt-1">{PIVOT_BRANDS[pivotBrand]}: {t("composizione delle campate in Ceres")}</div>;
                    const PIPE = ['10"', '8"5/8', '6"5/8'];
                    const groups: { pipe: number; len: number; n: number }[] = [];
                    for (const sp of c.spans) { const g = groups[groups.length - 1]; if (g && g.pipe === sp.pipe && g.len === sp.len) g.n++; else groups.push({ ...sp, n: 1 }); }
                    return (
                      <div className="text-[11px] text-sage-dark mt-1 leading-snug">
                        {PIVOT_BRANDS[pivotBrand]} · {fmt(c.total, { maximumFractionDigits: 1 })} m: {groups.map((g) => `${g.n}×${PIPE[g.pipe]} ${fmt(g.len, { maximumFractionDigits: 1 })} m`).join(" + ")}{c.oh ? ` + ${t("sbraccio")} ${fmt(c.oh, { maximumFractionDigits: 1 })} m` : ""}
                      </div>
                    );
                  })()}
                  <button className="btn-ghost w-full text-danger mt-2" onClick={deleteSelPivot}>{t("Elimina pivot")}</button>
                </div>
              ) : pivots.length && pivotSel.mode === "group" ? (
                <div>
                  <b className="text-brand-darker text-sm">{t("Gruppo pivot")} · {pivots.length}</b>
                  <p className="text-[11px] text-sage-dark mt-1">{t("Sulla mappa: 2° clic su un pivot per modificarlo singolarmente.")}</p>
                  <button className="btn-ghost w-full mt-2" onClick={applyRadiusToAll}>{t("Applica raggio {r} m a tutti", { r: pivotR })}</button>
                  <div className="flex gap-2 mt-2">
                    <button className="btn-ghost flex-1 basis-0 text-[12px]" onClick={() => commitPivots(pivots.map((p) => ({ ...p, gun: 25 })))}>{t("Irrigatore finale su tutti")}</button>
                    <button className="btn-ghost flex-1 basis-0 text-[12px]" onClick={() => commitPivots(pivots.map((p) => ({ ...p, gun: undefined })))}>{t("Toglilo a tutti")}</button>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-sage-dark mt-2">
                    <input type="checkbox" checked={pivotLabels} onChange={(e) => setPivotLabels(e.target.checked)} />
                    {t("Mostra superficie e portata sulla mappa")}
                  </label>
                  {/* Elenco pivot: superficie e portata di ciascuno; clic = selezione singola */}
                  <table className="w-full text-[11px] mt-2 tabular-nums">
                    <thead>
                      <tr className="text-sage-dark text-left border-b border-black/10">
                        <th className="font-medium py-0.5">#</th>
                        <th className="font-medium text-right">{t("Raggio (m)")}</th>
                        <th className="font-medium text-right">{t("Area")}</th>
                        <th className="font-medium text-right">{t("Portata (l/s)")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pivots.map((pv, i) => (
                        <tr key={i} className="hover:bg-black/5 cursor-pointer" title={t("Modifica")}
                          onClick={() => setPivotSel({ mode: "single", idx: i })}>
                          <td className="py-0.5 text-brand-mid">{i + 1}</td>
                          <td className="text-right">{Math.round(pv.r)}</td>
                          <td className="text-right">{uHa(pvAreaM2(pv) / 10000, 1)}</td>
                          <td className="text-right">{fmt(Math.round(pivotFlow(pv)))}{pv.q && pv.q > 0 ? "*" : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-black/10 font-semibold text-brand-darker">
                        <td className="py-0.5">{t("Totale")}</td>
                        <td />
                        <td className="text-right">{uHa(pivots.reduce((a, pv) => a + pvAreaM2(pv) / 10000, 0))}</td>
                        <td className="text-right">{fmt(Math.round(pivots.reduce((a, pv) => a + pivotFlow(pv), 0)))}</td>
                      </tr>
                    </tfoot>
                  </table>
                  {pivots.some((pv) => pv.q && pv.q > 0) && <p className="text-[10px] text-sage-dark mt-1">* {t("portata impostata a mano")}</p>}
                </div>
              ) : active ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <b className="text-brand-darker text-sm truncate">{active.name}</b>
                    <button className="text-[11px] text-brand-mid shrink-0" onClick={() => renameField(active)}>{t("Rinomina")}</button>
                  </div>
                  <div className="seg">
                    <div className="seg-item" data-active={(active.level ?? "area") === "area"} onClick={() => setFieldLevel("area")}>{t("Area")}</div>
                    <div className="seg-item" data-active={active.level === "campo"} onClick={() => setFieldLevel("campo")}>{t("Campo")}</div>
                  </div>
                  {(() => {
                    const defC = active.level === "campo" ? "#03a047" : "#e8973d";
                    const defF = active.level === "campo" ? "#038037" : "#e8973d";
                    const defO = active.level === "campo" ? 0.16 : 0.08;
                    return (
                      <>
                        <div className="flex items-center gap-4">
                          <label className="flex items-center gap-1.5 text-[11px] text-sage-dark">{t("Perimetro")}
                            <input type="color" value={active.style?.color ?? defC} onChange={(e) => patchFieldStyle({ color: e.target.value })} className="w-8 h-6 rounded border border-black/10 bg-white p-0 cursor-pointer" /></label>
                          <label className="flex items-center gap-1.5 text-[11px] text-sage-dark">{t("Riempimento")}
                            <input type="color" value={active.style?.fillColor ?? defF} onChange={(e) => patchFieldStyle({ fillColor: e.target.value })} className="w-8 h-6 rounded border border-black/10 bg-white p-0 cursor-pointer" /></label>
                        </div>
                        <label className="block text-[11px] text-sage-dark">{t("Trasparenza riempimento")}: <b>{Math.round((active.style?.fillOpacity ?? defO) * 100)}%</b>
                          <input type="range" min={0} max={100} step={5} value={Math.round((active.style?.fillOpacity ?? defO) * 100)} onChange={(e) => patchFieldStyle({ fillOpacity: Number(e.target.value) / 100 })} className="w-full mt-1" /></label>
                        <div>
                          <div className="text-[11px] text-sage-dark mb-1">{t("Preimpostazioni")} {active.level === "campo" ? t("(campo)") : t("(area)")}</div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {(active.level === "campo" ? CAMPO_PRESETS : AREA_PRESETS).map((p) => {
                              const on = active.style?.color === p.color && active.style?.fillColor === p.fillColor;
                              return (
                                <button key={p.name} title={p.name}
                                  onClick={() => patchFieldStyle({ color: p.color, fillColor: p.fillColor, fillOpacity: p.fillOpacity })}
                                  className={"w-7 h-7 rounded-lg " + (on ? "ring-2 ring-offset-1 ring-brand" : "")}
                                  style={{ background: p.fillColor, boxShadow: `inset 0 0 0 3px ${p.color}` }} />
                              );
                            })}
                          </div>
                        </div>
                      </>
                    );
                  })()}
                  {(() => {
                    const ring: number[][] = active.geom.coordinates[0] || [];
                    let per = 0; for (let i = 1; i < ring.length; i++) per += distM(ring[i - 1], ring[i]);
                    const nV = Math.max(1, ring.length - 1);
                    let sx = 0, sy = 0; for (let i = 0; i < nV; i++) { sx += ring[i][0]; sy += ring[i][1]; }
                    const clat = sy / nV, clng = sx / nV;
                    const kids = fields.filter((f) => f.parentId === active.id).length;
                    const npv = pivots.filter((p) => p.field === active.id).length;
                    const ncan = canals.filter((c) => c.owner === active.id).length;
                    const nrd = roads.filter((r) => r.owner === active.id).length;
                    const nwt = watercourses.filter((w) => w.owner === active.id).length;
                    return (
                      <div className="text-[11px] text-sage-dark bg-panel rounded-lg p-2 leading-relaxed">
                        {t("Superficie")}: <b>{uHa(ringAreaHa(active.geom.coordinates))}</b><br />
                        {t("Perimetro")}: <b>{uM(Math.round(per))}</b> · {t("Vertici")}: <b>{nV}</b><br />
                        {t("Centro")}: <b>{clat.toFixed(5)}, {clng.toFixed(5)}</b><br />
                        {t("Quota")}: {elevStats && elevStats.id === active.id
                          ? (elevStats.loading ? <span className="opacity-60">…</span> : elevStats.err ? "—"
                            : <>{t("min")} <b>{elevStats.s?.min_m ?? "—"} m</b> · {t("max")} <b>{elevStats.s?.max_m ?? "—"} m</b> · {t("mediana")} <b>{elevStats.s?.median_m ?? "—"} m</b></>)
                          : <span className="opacity-60">…</span>}<br />
                        {kids > 0 && <>{t("Poligoni figli")}: <b>{kids}</b> · </>}
                        {t("Pivot")}: <b>{npv}</b> · {t("Canali")}: <b>{ncan}</b> · {t("Strade")}: <b>{nrd}</b> · {t("Invasi")}: <b>{nwt}</b>
                      </div>
                    );
                  })()}
                  <button className="btn-ghost w-full text-[11px]" onClick={resetFieldStyle}>{t("Ripristina colori predefiniti")}</button>
                </div>
              ) : (
                <div>
                  <p className="text-[11px] text-sage-dark">{t("Clicca un campo nell'elenco «Campi» per vederne colori e informazioni, oppure un oggetto sulla mappa.")}</p>
                </div>
              )}
            </div>
          </div>
        )}
        </div>

        {/* Menu verticale (bordo destro): ogni voce apre la sua finestra;
            ri-cliccando la voce attiva la finestra si chiude. */}
        <div className="absolute top-[4.5rem] right-4 z-40 widget p-1.5 flex flex-col gap-1">
          {TABS.map((tb, i) => {
            const Ico = TAB_ICONS[tb.key as keyof typeof TAB_ICONS] ?? IcoNavAnalisi;
            const on = tab === tb.key && !rightMin;
            return (
              <button key={tb.key} onClick={() => toggleTab(tb.key)} title={t(tb.label)}
                className={"w-[68px] py-2 rounded-xl flex flex-col items-center gap-1 transition " +
                  (on ? "bg-brand text-white" : "text-sage-dark hover:bg-black/5")}>
                <Ico />
                <span className="text-[10px] leading-none font-medium">
                  <span className={on ? "opacity-70 mr-0.5" : "opacity-50 mr-0.5"}>{i + 1}</span>{t(tb.label)}
                </span>
              </button>
            );
          })}
        </div>

        {/* Finestra degli strumenti: si apre a sinistra del menu verticale */}
        {/* NB: niente «relative» qui insieme ad «absolute». Sono due utility di
            posizionamento e in Tailwind vince l'ultima nel CSS (relative), non
            l'ultima scritta: il pannello perdeva il posizionamento e finiva nel
            flusso, in basso a sinistra. «absolute» fa già da riferimento per il
            pulsante di chiusura. */}
        {!rightMin && (
        <div className="absolute top-[4.5rem] right-[7rem] w-[440px] max-w-[calc(100vw/var(--ui-scale)_-_9rem)] max-h-[calc(78vh/var(--ui-scale))] widget flex flex-col overflow-hidden">
          {/* Il comando di chiusura galleggia nell'angolo invece di occupare una
              riga propria: la riga dedicata lasciava una fascia vuota sopra il
              primo titolo. */}
          <button onClick={() => setRightMin(true)} title={t("Chiudi")}
            className="absolute top-1.5 right-1.5 z-10 text-sage-dark hover:text-brand p-1 rounded hover:bg-black/5"><IcoMinimize /></button>
          <div className="overflow-auto scroll-soft p-4 pt-2.5 space-y-4">
          {!sameRules && active && (
            <div className="text-[11px] text-brand-mid bg-brand/10 rounded-lg px-2 py-1">
              {t("Stai modificando: {name}", { name: active.name })}
            </div>
          )}

          <section hidden={tab !== "analisi"}>
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Anteprima satellitare")}</h3>
            <div className="flex gap-2 items-end">
              <label className="text-xs text-sage-dark flex-1 basis-0 min-w-0">{t("Indice")}
                <select className="field-input mt-1 w-full" value={index} onChange={(e) => setIndex(e.target.value)}>
                  {INDICES.map((i) => <option key={i.id} value={i.id}>{i.id.toUpperCase()} — {t(i.label)}</option>)}
                </select>
              </label>
              <button className="btn-ghost flex-1 basis-0 whitespace-nowrap" disabled={busy === "scenes" || !activeGeom} onClick={searchScenes}>
                {busy === "scenes" ? t("Cerco…") : t("Cerca date")}
              </button>
            </div>

            {!!scenes.length && (
              <>
                <label className="text-xs text-sage-dark mt-2 block">{t("Date disponibili")}</label>
                <select className="field-input mt-1" value={date} onChange={(e) => setDate(e.target.value)}>
                  {scenes.map((s) => (
                    <option key={s.date} value={s.date}>
                      {fmtDate(s.date)}{s.cloud != null ? ` · ${fmt(Math.round(s.cloud))}%` : ""}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-xs text-sage-dark mt-2">
                  <input type="checkbox" checked={normalized} onChange={(e) => setNormalized(e.target.checked)} />
                  {t("Vista normalizzata (contrasto sull'area)")}
                </label>
                <div className="flex gap-2 mt-2">
                  <button className="btn-primary flex-1 basis-0" disabled={busy === "preview"} onClick={showPreview}>
                    {busy === "preview" ? t("Ricompongo…") : t("Anteprima sulla mappa")}
                  </button>
                  <button className="btn-ghost flex-1 basis-0" onClick={clearPreview}>{t("Rimuovi anteprima")}</button>
                </div>
                {scale && index !== "rgb" && <ScaleBar scale={scale} />}
              </>
            )}
          </section>

          <section hidden={tab !== "analisi"} className="border-t border-black/5 pt-3">
            <SectionHead title={t("Quota (DEM)")} help={t("Il rilievo ombreggiato mostra i sensi delle pendenze; le isoipse ravvicinate = terreno più ripido.")} />
            <div className="flex gap-2">
              <button className="btn-primary flex-1 basis-0" disabled={busy === "dem" || !activeGeom} onClick={showDem}>
                {busy === "dem" ? t("Ricompongo…") : t("Mostra DEM")}
              </button>
              <button className="btn-ghost flex-1 basis-0" onClick={clearDem}>{t("Rimuovi DEM")}</button>
            </div>
            {demInfo && (
              <div className="mt-2">
                <ScaleBar scale={demInfo.scale} unit=" m" />
                <p className="text-xs text-sage-dark mt-1">
                  {t("min")} {uM(demInfo.min)} · {t("max")} {uM(demInfo.max)}
                </p>
              </div>
            )}
          </section>

          <section hidden={tab !== "analisi"} className="border-t border-black/5 pt-3">
            <SectionHead title={t("Corsi d'acqua esistenti")} help={t("Rileva e ricalca fiumi, canali e paludi (NDWI) e gli impluvi/alvei dalla morfologia del terreno (DEM), anche asciutti. Falla prima di progettare: i pivot li evitano automaticamente.")} />
            <label className="text-xs text-sage-dark block">{t("Sensibilità")}: {waterSens}/5 {waterSens >= 4 ? t("(rileva anche corsi stretti/deboli)") : ""}
              <input type="range" min={1} max={5} step={1} value={waterSens}
                onChange={(e) => setWaterSens(Number(e.target.value))} className="w-full accent-brand" disabled={waterPreview} />
            </label>
            {!waterPreview ? (
              <div className="flex gap-2 mt-1">
                <button className="btn-primary flex-1 basis-0" disabled={busy === "water" || !activeGeom || !date} onClick={detectWater}>
                  {busy === "water" ? t("Calcolo…") : t("Rileva corsi d'acqua")}
                </button>
                <button className="btn-ghost flex-1 basis-0" onClick={clearWater}>{t("Rimuovi")}</button>
              </div>
            ) : (
              <div className="mt-1 bg-brand/5 rounded-lg p-2">
                <p className="hint mb-1">{t("Anteprima modificabile: trascina i vertici, aggiungi o elimina elementi, poi Conferma.")}</p>
                <div className="flex gap-2 flex-wrap">
                  <button className="btn-ghost text-xs px-2 py-1" onClick={() => mapApi.current?.waterDraw("river")}>+ {t("Fiume/canale")}</button>
                  <button className="btn-ghost text-xs px-2 py-1" onClick={() => mapApi.current?.waterDraw("basin")}>+ {t("Bacino")}</button>
                  <button className={"text-xs px-2 py-1 rounded-lg " + (waterRemoveOn ? "bg-danger text-white" : "btn-ghost")} onClick={toggleWaterRemove}>{t("Elimina elemento")}</button>
                </div>
                <div className="flex gap-2 mt-2">
                  <button className="btn-primary flex-1 basis-0" onClick={confirmWaterUI}>{t("Conferma")}</button>
                  <button className="btn-ghost flex-1 basis-0" onClick={cancelWaterPreview}>{t("Annulla")}</button>
                </div>
              </div>
            )}
            {!waterPreview && !!watercourses.length && (
              <div className="mt-2 text-xs text-sage-dark bg-panel rounded-lg p-2 leading-relaxed">
                {watercourses.filter((w) => w.geojson.type === "LineString").length} {t("fiumi/canali (asse)")} · {watercourses.filter((w) => w.kind === "basin").length} {t("bacini")} · {watercourses.filter((w) => w.kind === "wetland").length} {t("paludi")}<br />
                {uHa(watercourses.reduce((s, w) => s + w.area_ha, 0))} {t("totali")}
                <button className="text-brand-mid ml-2" onClick={() => exportKmz("corsi_dacqua", watercourses.map((w, i) => ({ name: `${w.kind} ${i + 1}`, geom: w.geojson })))}>⤓ KMZ</button>
              </div>
            )}
          </section>

          <section hidden={tab !== "analisi"} className="border-t border-black/5 pt-3">
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Idoneità del terreno")}</h3>
            <div className="flex gap-3 items-start">
              <div className="flex-1 min-w-0">
                <div className="text-xs text-sage-dark mb-1">{t("Pesi dei fattori")}</div>
                <WeightRow label={t("Pendenza")} v={cur.weights.slope} onChange={(v) => setW("slope", v)} />
                <WeightRow label={t("Vigore")} v={cur.weights.vigor} onChange={(v) => setW("vigor", v)} />
                <WeightRow label={t("Umidità")} v={cur.weights.moisture} onChange={(v) => setW("moisture", v)} />
                <WeightRow label={t("Clima")} v={cur.weights.climate} onChange={(v) => setW("climate", v)} />
              </div>
              <div className="w-32 shrink-0 space-y-2">
                <div>
                  <div className="text-[11px] leading-tight text-sage-dark mb-1">{t("Pend. ideale (‰)")}</div>
                  <input type="number" min={0} max={100} step={0.5} value={cur.slopeIdeal}
                    onChange={(e) => patch({ slopeIdeal: Number(e.target.value) })} className="field-input px-2 py-1.5 text-sm w-full" />
                </div>
                <div>
                  <div className="text-[11px] leading-tight text-sage-dark mb-1">{t("Pend. max (‰)")}</div>
                  <input type="number" min={0} max={200} step={0.5} value={cur.slopeMax}
                    onChange={(e) => patch({ slopeMax: Number(e.target.value) })} className="field-input px-2 py-1.5 text-sm w-full" />
                </div>
              </div>
            </div>
            <div className="flex gap-2 mt-2">
              <button className="btn-primary flex-1 basis-0" disabled={busy === "suit" || !activeGeom || !date} onClick={computeSuit}>
                {busy === "suit" ? t("Calcolo…") : t("Calcola idoneità")}
              </button>
              <button className="btn-ghost flex-1 basis-0" onClick={clearSuit}>{t("Rimuovi idoneità")}</button>
            </div>

            {suit && (
              <div className="mt-3 space-y-2">
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div className="bg-panel rounded-lg p-2">
                    <div className="text-lg font-semibold text-brand">
                      {fmt(imperial ? suit.suitable_ha * 2.47105 : suit.suitable_ha, { maximumFractionDigits: 0 })}</div>
                    <div className="text-[11px] text-sage-dark">{t("Superficie idonea")} ({imperial ? "ac" : "ha"})</div>
                  </div>
                  <div className="bg-panel rounded-lg p-2">
                    <div className="text-lg font-semibold text-brand">{fmt(suit.mean_score)}/100</div>
                    <div className="text-[11px] text-sage-dark">{t("Idoneità media")}</div>
                  </div>
                </div>
                {!!suit.wetland_ha && suit.wetland_ha > 0 && (
                  <div className="text-xs text-danger bg-danger/10 rounded-lg p-2">
                    {t("Aree paludose/acqua escluse (NDWI + vegetazione)")}: <b>{uHa(suit.wetland_ha)}</b>
                  </div>
                )}
                <div>
                  <div className="text-xs font-semibold text-sage-dark mb-1">{t("Ripartizione classi")}</div>
                  {suit.classes.map((c) => (
                    <div key={c.key} className="flex items-center text-xs py-0.5">
                      <span className="inline-block w-3 h-3 rounded-sm mr-2" style={{ background: c.color }} />
                      <span className="flex-1">{t(c.label)}</span>
                      <span className="text-sage-dark">
                        {uHa(c.ha)} · {fmt(c.pct)}%
                      </span>
                    </div>
                  ))}
                </div>
                {suit.elevation && suit.elevation.min_m != null && (
                  <div className="text-xs text-sage-dark bg-panel rounded-lg p-2 leading-relaxed">
                    <b className="text-brand-darker">{t("Quota del netto coltivabile")}</b><br />
                    {t("Minima")}: <b>{uM(suit.elevation.min_m)}</b> · {t("Massima")}: <b>{uM(suit.elevation.max_m ?? 0)}</b> · {t("Mediana")}: <b>{uM(suit.elevation.median_m ?? 0)}</b><br />
                    <span className="text-brand-mid">{t("Dislivello")}: {uM((suit.elevation.max_m ?? 0) - (suit.elevation.min_m ?? 0), 1)}</span>
                  </div>
                )}
                <div className="text-xs text-sage-dark bg-panel rounded-lg p-2 leading-relaxed">
                  {t("Pendenza")}: {fmt(suit.slope.mean_pct * 10)}‰ ({t("max")} {fmt(suit.slope.max_pct * 10)}‰)<br />
                  {t("ET₀ annua")}: {fmt(suit.climate.eto_year_mm)} mm · {t("Pioggia annua")}: {fmt(suit.climate.rain_year_mm)} mm<br />
                  {t("Deficit idrico")}: {fmt(suit.climate.deficit_year_mm)} mm · {t("Indice di aridità")}: {suit.climate.aridity_index != null ? fmt(suit.climate.aridity_index) : "—"}
                </div>
                {suit.cached && <p className="text-[11px] text-brand-light">↻ {t("Ricalcolo dai dati in cache: nessun consumo di quota.")}</p>}
              </div>
            )}
          </section>

          <section hidden={tab !== "analisi"} className="border-t border-black/5 pt-3">
            <SectionHead title={t("Analisi → Campi")} help={t("Individua le zone idonee nell'AREA attiva: diventano CAMPI (poligoni operativi generati dal sistema), annidati sotto l'area e selezionabili singolarmente. Passo facoltativo: puoi comunque lavorare direttamente sull'AREA (inserire pivot, analizzarla, ecc.) senza generare campi.")} />
            <div className="flex gap-2 items-end">
              <label className="text-xs text-sage-dark flex-1">{t("Soglia idoneità")}: {macroThr}/100
                <input type="range" min={40} max={90} step={5} value={macroThr}
                  onChange={(e) => setMacroThr(Number(e.target.value))} className="w-full accent-brand mt-2 mb-1.5" />
              </label>
              <label className="text-xs text-sage-dark w-24">{t("Area minima (ha)")}
                <input type="number" min={1} max={100000} step={1} value={macroMinHa}
                  onChange={(e) => setMacroMinHa(Number(e.target.value))} className="field-input mt-1" />
              </label>
            </div>
            <div className="flex gap-2 mt-2">
              <button className="btn-primary flex-1 basis-0" disabled={busy === "macro" || !activeGeom || !date} onClick={detectMacroareas}>
                {busy === "macro" ? t("Calcolo…") : t("Individua macro-aree")}
              </button>
              <button className="btn-ghost flex-1 basis-0" onClick={clearMacro}>{t("Rimuovi")}</button>
            </div>
            {!!macroAreas.length && (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-xs font-semibold text-sage-dark">{macroAreas.length} {t("zone idonee")}</div>
                  <button className="text-xs text-brand-mid disabled:opacity-40" disabled={activeId == null} onClick={addAllMacroToField}>{t("Crea tutti i campi")}</button>
                </div>
                <p className="hint mb-1">{active ? t("Diventeranno CAMPI sotto l'area: {name}", { name: active.name }) : t("Seleziona un'area a sinistra per crearne i campi.")}</p>
                <ul className="space-y-1">
                  {macroAreas.map((m, i) => (
                    <li key={i} className="flex items-center justify-between text-sm bg-panel rounded-lg px-2 py-1">
                      <span className="flex-1 truncate">{t("Zona")} {i + 1} · {uHa(m.area_ha)} · {t("Idoneità")} {fmt(m.mean_score)}</span>
                      <button className="text-xs text-brand-mid shrink-0 disabled:opacity-40" disabled={activeId == null} onClick={() => addMacroToField(m)}>+ {t("Campo")}</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section hidden={tab !== "analisi"} className="border-t border-black/5 pt-3">
            <SectionHead title={t("Dimensione pivot consigliata")} help={t("Dal tipo di suolo (infiltrazione) e dall'ET₀ di punta stima il raggio massimo del pivot perché l'intensità di pioggia al bordo non superi l'infiltrazione del terreno. Il valore è usato come raggio di default nella pagina Impianti.")} />
            <div className="flex gap-2 items-end">
              <label className="text-xs text-sage-dark flex-1 basis-0 min-w-0">{t("Tipo di suolo")}
                <select className="field-input mt-1 w-full px-2" value={soilKey}
                  onChange={(e) => { setSoilKey(e.target.value); infTouched.current = false; setInfiltration(soilOf(e.target.value).inf); }}>
                  {SOILS.map((so) => <option key={so.key} value={so.key}>{t(so.label)}</option>)}
                </select>
              </label>
              <label className="text-xs text-sage-dark flex-1 basis-0 min-w-0">{t("Infiltrazione (mm/h)")}
                <input type="number" min={0.5} max={200} step={0.5} value={infiltration}
                  onFocus={() => { infTouched.current = true; }}
                  onChange={(e) => setInfiltration(Number(e.target.value))} className="field-input mt-1 w-full px-2" /></label>
              <label className="text-xs text-sage-dark flex-1 basis-0 min-w-0">{t("ET₀ di punta (mm/g)")}
                <input type="number" min={1} max={20} step={0.5} value={et0Peak}
                  onChange={(e) => setEt0Peak(Number(e.target.value))} className="field-input mt-1 w-full px-2" /></label>
            </div>
            {/* Il valore agronomico proposto resta visibile anche dopo una
                correzione a mano: così si vede subito di quanto ci si discosta
                e si può tornare indietro con un clic. */}
            <div className="flex items-center gap-2 mt-1 text-[11px] text-sage-dark">
              <span>
                {t("Infiltrazione tipica per «{s}»", { s: t(soilOf(soilKey).label) })}:{" "}
                <b className="text-brand-darker tabular-nums">{soilOf(soilKey).inf} mm/h</b>{" "}
                <span className="opacity-80">({soilOf(soilKey).lo}–{soilOf(soilKey).hi})</span>
              </span>
              {Math.abs(infiltration - soilOf(soilKey).inf) > 0.05 && (
                <button className="text-brand-mid underline shrink-0"
                  onClick={() => { infTouched.current = false; setInfiltration(soilOf(soilKey).inf); }}>
                  {t("Usa il valore consigliato")}
                </button>
              )}
            </div>
            <div className="flex items-center justify-between mt-2 text-xs">
              <span>{t("Raggio consigliato")}: <b>{recRadius} m</b></span>
              <button className="text-brand-mid" onClick={() => setPivotR(recRadius)}>{t("Usa raggio consigliato")}</button>
            </div>
          </section>

          <section hidden={tab !== "rilievo"}>
            <SectionHead title={t("Dati agronomici")} help={t("Scegli la coltura: dal suo Kc di punta, dall'ET₀ della zona e dalla piovosità utile la piattaforma propone il piano irriguo dei pivot. Efficienza dell'impianto e ore di esercizio si regolano nella pagina Irrigazione.")} />
            {/* Basta la coltura: Kc, efficienza e ore sono parametri di secondo
                livello e vivono in Irrigazione. Qui accanto compare subito il
                piano irriguo che ne deriva. */}
            <div className="flex gap-2 items-end">
              <label className="text-xs text-sage-dark flex-1 basis-0 min-w-0">{t("Coltura")}
                <select className="field-input mt-1 w-full px-2" value={cropKey}
                  onChange={(e) => { setCropKey(e.target.value); patch({ kc: cropOf(e.target.value).kc }); }}>
                  {CROP_LIST.map((cp) => <option key={cp.key} value={cp.key}>{t(cp.label)}</option>)}
                </select>
              </label>
              <div className="flex-1 basis-0 min-w-0">
                <div className="text-xs text-sage-dark">{t("Piano irriguo consigliato")}</div>
                <div className="field-input mt-1 flex items-baseline gap-1 bg-panel">
                  <b className="text-brand-darker tabular-nums">{fmt(mm24Suggested, { maximumFractionDigits: 1 })}</b>
                  <span className="text-xs text-sage-dark">mm/24h</span>
                </div>
              </div>
            </div>
            <div className="text-[11px] text-sage-dark mt-1">
              {t("Kc")} {fmt(cropOf(cropKey).kc, { maximumFractionDigits: 2 })} · ET₀ {fmt(et0Peak, { maximumFractionDigits: 1 })} mm/g
              {rainMm > 0 ? ` · ${t("pioggia")} ${fmt(rainMm, { maximumFractionDigits: 1 })} mm` : ""}
              {" · "}{t("efficienza")} {fmt(effPct, { maximumFractionDigits: 0 })}%
            </div>
          </section>

          <section hidden={tab !== "rilievo"} className="border-t border-black/5 pt-3">
            <SectionHead title={t("Canali")} help={t("Traccia uno o più canali: automatici a gravità (a pendenza costante, con presa/finale opzionali) oppure a mano. Ogni canale è modificabile ed esportabile in KMZ. Lo spessore è mostrato come banda sulla mappa e viene evitato dai pivot come preesistenza. Se presa e finale non sono impostati: presa nel punto più alto, finale sul bordo più basso.")} />
            <div className="flex gap-2">
              <label className="text-xs text-sage-dark flex-1">{t("Pendenza target (‰)")}
                <input type="number" min={0.1} max={100} step={0.5} value={canalPermille}
                  onChange={(e) => setCanalPermille(Number(e.target.value))} className="field-input mt-1" />
              </label>
              <label className="text-xs text-sage-dark flex-1">{t("Spessore canale (m)")}
                <input type="number" min={1} max={200} step={1} value={canalWidth}
                  onChange={(e) => setCanalWidth(Number(e.target.value))} className="field-input mt-1" />
              </label>
            </div>

            <div className="bg-panel rounded-lg p-2 mt-2">
              <div className="text-xs font-semibold text-sage-dark mb-1">{t("Presa e finale (opzionali)")}</div>
              <div className="flex gap-2">
                <button className={`flex-1 basis-0 ${pickMode === "start" ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => (pickMode === "start" ? cancelPick() : armPick("start"))}>
                  {pickMode === "start" ? t("Clicca sulla mappa…") : (canalStart ? "✓ " : "") + t("Imposta presa")}
                </button>
                <button className={`flex-1 basis-0 ${pickMode === "end" ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => (pickMode === "end" ? cancelPick() : armPick("end"))}>
                  {pickMode === "end" ? t("Clicca sulla mappa…") : (canalEnd ? "✓ " : "") + t("Imposta finale")}
                </button>
              </div>
              {(canalStart || canalEnd) && (
                <button className="text-xs text-brand-mid mt-1" onClick={resetPicks}>{t("Azzera presa/finale")}</button>
              )}
            </div>

            <div className="flex gap-2 mt-2">
              <button className="btn-primary flex-1 basis-0" disabled={busy === "canal" || !activeGeom} onClick={traceCanal}>
                {busy === "canal" ? t("Calcolo…") : t("Traccia canale")}
              </button>
              <button className="btn-ghost flex-1 basis-0" disabled={busy === "canal" || !activeGeom} onClick={traceCanalManual}>
                {t("Traccia a mano")}
              </button>
            </div>
            <label className="flex items-center gap-2 text-xs text-sage-dark mt-2">
              <input type="checkbox" checked={snapCanal} onChange={(e) => setSnapCanal(e.target.checked)} />
              {t("Aggancia il tracciato a mano all'alveo reale (DEM)")}
            </label>
            <div className="flex gap-2 mt-2">
              <button className="btn-ghost flex-1 basis-0" disabled={busy === "canal"} onClick={() => canalFileRef.current?.click()}>{t("Importa KMZ come canali")}</button>
              <button className="btn-ghost flex-1 basis-0" disabled={!canals.length && !canalStart && !canalEnd} onClick={clearCanalUI}>{t("Rimuovi tutti")}</button>
            </div>
            <input ref={canalFileRef} type="file" accept=".kmz,.kml,.geojson,.json" multiple className="hidden"
              onChange={(e) => { importCanals(e.target.files); if (e.target) e.target.value = ""; }} />

            {canals.length > 0 && (
              <ul className="mt-3 space-y-2">
                {canals.map((c, i) => (
                  <li key={i} className={"text-xs text-sage-dark bg-panel rounded-lg p-2 leading-relaxed " + (editingCanal === i ? "ring-1 ring-brand/50" : "")}>
                    <div className="flex items-center justify-between mb-1">
                      <b className="text-brand-darker">{t("Canale")} {i + 1}{!!(c.waypoints?.length) && <span className="font-normal text-sage-dark"> · {c.waypoints.length} {t("punti")}</span>}</b>
                      <span className="flex gap-2 shrink-0">
                        <button className={editingCanal === i ? "text-brand font-semibold" : "text-brand-mid"}
                          onClick={() => (editingCanal === i ? endEditCanal() : startEditCanal(i))}>
                          {editingCanal === i ? t("Fine modifica") : t("Modifica percorso")}
                        </button>
                        <button className="text-brand-mid" title={t("Esporta KMZ")} onClick={() => exportCanalKmz(i, c)}>⤓ KMZ</button>
                        <button className="text-brand-mid disabled:opacity-40" disabled={!projectId} title={t("Salva nel progetto")} onClick={() => saveCanalLayer(i, c)}>{t("Salva")}</button>
                        <button className="text-danger" onClick={() => removeCanal(i)}>{t("Rimuovi")}</button>
                      </span>
                    </div>
                    {t("Lunghezza")}: <b>{uKm(c.length_m / 1000)}</b> · {t("Dislivello")}: {uM(c.drop_m, 1)}<br />
                    {t("Pendenza media")}: <b>{fmt(c.mean_permille)}‰</b> · {t("Pendenza target (‰)")}: {fmt(c.target_permille)}‰
                    {c.mean_permille > c.target_permille * 1.5 && (
                      <><br /><span className="text-danger">{t("Pendenza reale oltre il target: terreno acclive.")}</span></>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section hidden={tab !== "impianti"}>
            <SectionHead title={t("Impianti")} help={t("«Inserisci impianti» dispone i pivot a reticolo SOLO sul poligono selezionato a sinistra — indifferentemente un'AREA o un CAMPO: puoi lavorare direttamente sull'area senza per forza generare i campi. Ripetendo su un altro poligono i pivot si aggiungono senza cancellare gli altri. Scegli la disposizione: «A quadrato» (pivot allineati) oppure «A triangolo» (file sfalsate di mezzo passo per incastrare i pivot e recuperare più spazio). Come alimentarli (canali o tubazioni) è indipendente e si definisce nell'adduzione. I pivot sono modificabili: 1° clic = gruppo, 2° clic = singolo (pannello «Proprietà», icona «i»). Strade e canali preesistenti si tracciano nella pagina Rilievo.")} />

            {/* Sistemi irrigui: pagine interne del widget. Oggi solo il pivot ha
                contenuti, gli altri sono segnaposto dichiarati. */}
            <div className="flex gap-1 mb-3">
              {([["pivot", "Pivot"], ["lineari", "Lineari"], ["rotoloni", "Rotoloni"], ["goccia", "Goccia"]] as const).map(([k, lab]) => (
                <button key={k} onClick={() => setIrrigSys(k)}
                  className={"flex-1 basis-0 text-[12px] font-medium rounded-lg py-1.5 transition " +
                    (irrigSys === k ? "bg-brand text-white" : "bg-panel text-sage-dark hover:bg-brand-mint/20")}>
                  {t(lab)}
                </button>
              ))}
            </div>

            {irrigSys !== "pivot" ? (
              renderSystems()
            ) : (<>

            <label className="text-xs text-sage-dark block mb-1">{t("Produttore dei pivot")}
              <select className="field-input mt-1 text-sm" value={pivotBrand} onChange={(e) => setPivotBrand(e.target.value as PivotBrand)}>
                {(Object.keys(PIVOT_BRANDS) as PivotBrand[]).map((k) => <option key={k} value={k}>{PIVOT_BRANDS[k]}</option>)}
              </select>
            </label>
            <label className="text-xs text-sage-dark block mb-1">{t("Velocità massima nei tubi delle campate (m/s)")}
              <input type="number" min={1} max={5} step={0.1} value={spanVmax}
                onChange={(e) => { const x = Number(e.target.value); if (Number.isFinite(x)) setSpanVmax(Math.max(1, Math.min(5, x))); }} className="field-input mt-1 text-sm" />
            </label>
            <label className="text-xs text-sage-dark block mb-1">{t("Disposizione")}</label>
            <div className="seg mb-1">
              <div className="seg-item" data-active={cur.layoutCfg === "square"} onClick={() => patch({ layoutCfg: "square" })}>{t("A quadrato")}</div>
              <div className="seg-item" data-active={cur.layoutCfg === "staggered"} onClick={() => patch({ layoutCfg: "staggered" })}>{t("A triangolo")}</div>
            </div>
            <div className="mb-2" />

            <label className="text-xs text-sage-dark block mb-1">{t("Modalità di progettazione")}</label>
            <div className="seg mb-2">
              <div className="seg-item" data-active={designMode === "standard"} onClick={() => setDesignMode("standard")}>{t("Standard")}</div>
              <div className="seg-item" data-active={designMode === "advanced"} onClick={() => setDesignMode("advanced")}>{t("Avanzata")}</div>
            </div>

            <div className="bg-panel rounded-lg p-2 mt-2">
              <div className="text-xs font-semibold text-sage-dark mb-1">{t("Raggio e distanze di rispetto (m)")}</div>
              {/* Raggio e distanze su un'unica riga: in standard sono quattro
                  campi, in avanzata cinque (min e max al posto del raggio). I
                  campi stretti tengono l'unita' fuori dall'etichetta. */}
              <div className="flex gap-1.5">
                {designMode === "standard" ? (
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] leading-tight text-sage-dark mb-1 truncate" title={t("Raggio pivot")}>{t("Raggio pivot")}</div>
                    <input type="number" min={30} max={1000} step={10} value={pivotR}
                      onChange={(e) => setPivotR(Number(e.target.value))} className="field-input px-1.5 py-1.5 text-sm" />
                  </div>
                ) : (<>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] leading-tight text-sage-dark mb-1 truncate" title={t("Raggio min")}>{t("Raggio min")}</div>
                    <input type="number" min={30} max={1000} step={10} value={advMinR}
                      onChange={(e) => setAdvMinR(Number(e.target.value))} className="field-input px-1.5 py-1.5 text-sm" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] leading-tight text-sage-dark mb-1 truncate" title={t("Raggio max")}>{t("Raggio max")}</div>
                    <input type="number" min={30} max={1000} step={10} value={advMaxR}
                      onChange={(e) => setAdvMaxR(Number(e.target.value))} className="field-input px-1.5 py-1.5 text-sm" />
                  </div>
                </>)}
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] leading-tight text-sage-dark mb-1 truncate" title={t("Tra i pivot")}>{t("Tra i pivot")}</div>
                  <input type="number" min={0} max={500} step={5} value={safetyM}
                    onChange={(e) => setSafetyM(Number(e.target.value))} className="field-input px-1.5 py-1.5 text-sm" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] leading-tight text-sage-dark mb-1 truncate" title={t("Da strade")}>{t("Da strade")}</div>
                  <input type="number" min={0} max={500} step={5} value={pivClearRoad}
                    onChange={(e) => setPivClearRoad(Number(e.target.value))} className="field-input px-1.5 py-1.5 text-sm" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] leading-tight text-sage-dark mb-1 truncate" title={t("Da canali/invasi")}>{t("Da canali/invasi")}</div>
                  <input type="number" min={0} max={500} step={5} value={pivClearWater}
                    onChange={(e) => setPivClearWater(Number(e.target.value))} className="field-input px-1.5 py-1.5 text-sm" />
                </div>
              </div>
            </div>

            {renderMeshParams()}

            {designMode === "standard" && (
              <div className="bg-panel rounded-lg p-2 mt-2">
                <label className="text-xs text-sage-dark block mb-1">
                  {t("Copri di più con pivot più piccoli sui bordi")}: <b>{minPivotPct >= 100 ? t("no") : t("fino a {p}% del raggio", { p: minPivotPct })}</b>
                </label>
                <input type="range" min={40} max={100} step={5} value={minPivotPct}
                  onChange={(e) => setMinPivotPct(Number(e.target.value))} className="w-full" />
                <p className="text-[10px] text-sage-dark mt-1 leading-snug">
                  {minPivotPct >= 100
                    ? t("Tutti i pivot a piena dimensione. Abbassa la percentuale per riempire i contorni con pivot più piccoli e coprire più superficie.")
                    : t("Il grosso del campo resta coperto dai pivot a piena dimensione ({r} m); sui contorni si aggiungono pivot ridotti fino a {min} m di raggio.", { r: Math.round(pivotR), min: Math.round(pivotR * minPivotPct / 100) })}
                </p>
                <label className="flex items-center gap-2 text-xs text-sage-dark mt-2">
                  <input type="checkbox" checked={fillFull} onChange={(e) => setFillFull(e.target.checked)} />
                  {t("Riempi i vuoti anche con pivot interi fuori griglia")}
                </label>
                {fillFull && (
                  <p className="text-[10px] text-sage-dark mt-1 leading-snug">
                    {t("I pivot fuori griglia non sono allineati alle dorsali: la loro adduzione non entra nel calcolo della rete.")}
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <label className="text-[11px] text-sage-dark">{t("Modello del terreno")}
                    <select className="field-input mt-0.5 py-1 text-sm" value={demModel} onChange={(e) => setDemModel(e.target.value as "COPERNICUS_30" | "COPERNICUS_90")}>
                      <option value="COPERNICUS_30">Copernicus 30 m</option><option value="COPERNICUS_90">Copernicus 90 m</option>
                    </select></label>
                  <label className="text-[11px] text-sage-dark">{t("Pendenza misurata su (m)")}
                    <input type="number" min={0} max={500} step={20} value={demSmooth}
                      onChange={(e) => { const x = Number(e.target.value); if (Number.isFinite(x)) setDemSmooth(Math.max(0, Math.min(500, x))); }} className="field-input mt-0.5 py-1 text-sm" /></label>
                </div>
                <p className="text-[10px] text-sage-dark mt-1 leading-snug">{t("Il Copernicus DEM include alberi, edifici e argini: misurare la pendenza su 100 m o più evita di escludere terreno pianeggiante per falsi ripidi.")}</p>
              </div>
            )}

            {designMode === "standard" ? (
              <div className="text-xs text-sage-dark bg-panel rounded-lg p-2 mt-2 leading-relaxed">
                {t("Raggio")}: <b>{uM(pivotR)}</b> · {t("Area per pivot")}: <b>{uHa(Math.PI * pivotR * pivotR / 10000, 1)}</b><br />
                {t("Interasse (centro-centro)")}: <b>{uM(2 * pivotR + safetyM)}</b>
              </div>
            ) : (
              <div className="text-xs text-sage-dark bg-panel rounded-lg p-2 mt-2 leading-relaxed">
                {t("Cerco il raggio unico (uguale per tutti i pivot) che copre più superficie tra {min} e {max} m, evitando strade, canali e fiumi e rispettando i franchi.", { min: Math.min(advMinR, advMaxR), max: Math.max(advMinR, advMaxR) })}
              </div>
            )}
            <div className="flex gap-2 mt-2">
              <button className="btn-primary flex-1 basis-0"
                disabled={busy === "layout" || !active}
                onClick={insertImpianti}>
                {busy === "layout" ? t("Calcolo…") : designMode === "advanced"
                  ? (active ? t("Ottimizza e inserisci su «{name}»", { name: active.name }) : t("Ottimizza e inserisci"))
                  : (active ? t("Inserisci su «{name}»", { name: active.name }) : t("Inserisci impianti"))}
              </button>
              <button className="btn-ghost flex-1 basis-0" onClick={clearImpianti}>{t("Rimuovi")}</button>
            </div>


            {/* Riepilogo disposizione + dimensionamento idraulico */}
            {agg.count > 0 && (
              <div className="mt-3 space-y-2">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="bg-panel rounded-lg p-2">
                    <div className="text-lg font-semibold text-brand">{agg.pivots}</div>
                    <div className="text-[11px] text-sage-dark">{t("Totale pivot")}</div>
                  </div>
                  <div className="bg-panel rounded-lg p-2">
                    <div className="text-lg font-semibold text-brand">{fmt(imperial ? agg.net * 2.47105 : agg.net, { maximumFractionDigits: 0 })}</div>
                    <div className="text-[11px] text-sage-dark">{t("Totale superficie netta")} ({imperial ? "ac" : "ha"})</div>
                  </div>
                  <div className="bg-panel rounded-lg p-2">
                    <div className="text-lg font-semibold text-brand">{fmt(agg.q, { maximumFractionDigits: 0 })}</div>
                    <div className="text-[11px] text-sage-dark">{t("Totale portata (l/s)")}</div>
                  </div>
                </div>
                {laid.length > 1 && (
                  <div>
                    <div className="text-xs font-semibold text-sage-dark mb-1">{t("Riepilogo per campo")}</div>
                    {laid.map((f) => (
                      <div key={f.id} className="flex items-center text-xs py-0.5">
                        <span className="flex-1 truncate">{f.name}</span>
                        <span className="text-sage-dark">
                          {f.lay!.n_pivots} pivot · {uHa(f.lay!.net_ha)} · {fmt(f.lay!.water.q_total_ls, { maximumFractionDigits: 0 })} l/s
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-xs text-sage-dark bg-panel rounded-lg p-2 leading-relaxed">
                  {t("Rete totale")}: <b>{uKm(agg.pipe / 1000, 1)}</b>
                </div>
                {(() => {
                  const lf = fields.filter((f) => f.lay && Number((f.lay as { excluded_slope_ha?: number }).excluded_slope_ha) > 0);
                  if (!lf.length) return null;
                  const ha = lf.reduce((s, f) => s + Number((f.lay as { excluded_slope_ha?: number }).excluded_slope_ha), 0);
                  const pm = Math.round(Number(lf[0].lay!.slope_max_pct) * 10);
                  return (
                    <div className="text-xs rounded-lg p-2 leading-relaxed flex items-center gap-2 border border-danger/30 text-danger"
                      style={{ background: "repeating-linear-gradient(45deg, rgba(217,45,32,.10) 0 2px, transparent 2px 6px)" }}>
                      <span>{t("Zone escluse per pendenza oltre {p}‰: {a}", { p: pm, a: uHa(ha) })}</span>
                    </div>
                  );
                })()}
                {renderPowerSupply()}
              </div>
            )}
            </>)}
          </section>



          <section hidden={tab !== "strade"}>
            <SectionHead title={t("Strade")} help={t("Traccia o importa le strade preesistenti (con spessore). Gli impianti evitano il footprint reale secondo il franco «Da strade» impostato nella pagina Impianti.")} />

            {/* Livello Strade: linee disegnabili/importabili che i pivot rispettano */}
            <div className="bg-panel rounded-lg p-2">
              <div className="text-xs font-semibold text-sage-dark mb-2">{t("Strade")} · {roads.length}</div>
              <div className="flex gap-2">
                <button className="btn-primary flex-1 basis-0" onClick={drawRoad}>{t("Traccia strada")}</button>
                <button className="btn-ghost flex-1 basis-0" onClick={() => roadFileRef.current?.click()}>{t("Importa KMZ")}</button>
                <button className="btn-ghost flex-1 basis-0" disabled={!roads.length} onClick={clearRoads}>{t("Rimuovi tutte")}</button>
              </div>
              <div className="flex gap-2 mt-2">
                <button className="btn-ghost flex-1 basis-0" onClick={genServiceRoads}
                  title={t("Strade nei corridoi tra le file di pivot, con raccordi ortogonali al centro di ogni pivot e accesso dal bordo del campo o dalla strada esistente più vicina. Non contano come ostacolo per il layout.")}>{t("Genera strade di servizio")}</button>
                <button className="btn-ghost flex-1 basis-0" disabled={busy === "osm"} onClick={detectOsmRoads}
                  title={t("Strade e piste già mappate su OpenStreetMap attorno al campo attivo. La copertura varia: nelle zone rurali molte piste mancano.")}>{busy === "osm" ? "…" : t("Rileva strade esistenti (OSM)")}</button>
              </div>
              <input ref={roadFileRef} type="file" accept=".geojson,.json,.kml,.kmz" multiple className="hidden"
                onChange={(e) => { importRoads(e.target.files); if (e.target) e.target.value = ""; }} />
              <label className="flex items-center gap-2 text-[11px] text-sage-dark mt-1">
                {t("Spessore predefinito (m)")}
                <input type="number" min={1} max={200} step={1} value={roadWidth}
                  onChange={(e) => setRoadWidth(Number(e.target.value))} className="field-input w-20 py-0.5" />
              </label>
              {!roads.length
                ? null
                : (
                  <ul className="space-y-1 mt-1">
                    {([["service", t("Strade di servizio")], ["osm", t("Strade OpenStreetMap")], ["existing", t("Strade esistenti")]] as [string, string][]).map(([kind, label]) => {
                      const items = roads.map((r, i) => ({ r, i })).filter((x) => (x.r.kind ?? "existing") === kind);
                      if (!items.length) return null;
                      const ids = new Set(items.map((x) => x.r.id));
                      const gk = `panel-${kind}`;
                      const open = openRoadGroups.has(gk);
                      const widths = [...new Set(items.map((x) => Math.round(x.r.width_m)))];
                      const km = items.reduce((a, x) => a + lineLenKm(x.r.coords), 0);
                      return (
                        <li key={gk}>
                          <div className="flex items-center justify-between gap-2 text-[11px] text-brand-darker bg-panel rounded px-1.5 py-1">
                            <button className="text-sage-dark w-3 text-[10px]" onClick={() => toggleRoadGroup(gk)}>{open ? "▾" : "▸"}</button>
                            <button className="truncate flex-1 text-left font-medium" onClick={() => toggleRoadGroup(gk)}>{label} · {items.length} {t("tratti")} · {uKm(km)}</button>
                            <input type="number" min={1} max={200} step={1} value={widths.length === 1 ? widths[0] : ""} placeholder="–" title={t("Spessore (m)")}
                              onChange={(e) => { const w = Number(e.target.value); if (w > 0) setRoadsWidthByIds(ids, w); }} className="field-input w-16 py-0.5 shrink-0" />
                            <span className="flex gap-1 shrink-0">
                              <button className="text-brand-mid" title={t("Esporta KMZ")} onClick={() => exportKmz(safe(label), items.map(({ i, r }) => ({ name: `${t("Strada")} ${i + 1}`, geom: { type: "LineString" as const, coordinates: r.coords } })))}>⤓</button>
                              <button className="text-danger" title={t("Rimuovi tutte")} onClick={() => removeRoadsByIds(ids)}>✕</button>
                            </span>
                          </div>
                          {open && (
                            <ul className="space-y-1 mt-1 ml-4">
                              {items.map(({ r, i }) => (
                      <li key={r.id} className="flex items-center justify-between gap-2 text-[11px] text-sage-dark">
                        <span className="truncate flex-1">{t("Strada")} {i + 1} · {uKm(lineLenKm(r.coords))}</span>
                        <input type="number" min={1} max={200} step={1} value={Math.round(r.width_m)} title={t("Spessore (m)")}
                          onChange={(e) => setRoadWidthAt(i, Number(e.target.value))} className="field-input w-16 py-0.5 shrink-0" />
                        <span className="flex gap-1 shrink-0">
                          <button className="text-brand-mid" title={t("Esporta KMZ")} onClick={() => exportKmz(safe(`${t("Strada")}_${i + 1}`), [{ name: `${t("Strada")} ${i + 1}`, geom: { type: "LineString", coordinates: r.coords } }])}>⤓</button>
                          <button className="text-danger" title={t("Rimuovi")} onClick={() => removeRoad(i)}>✕</button>
                        </span>
                      </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
            </div>
          </section>

          <section hidden={tab !== "accessori"}>
            <SectionHead title={t("Tubazioni")} help={t("Infrastrutture accessorie del progetto. «Diramazioni da canale» posa in automatico una fila di pivot lungo il canale e traccia la tubazione più corta per alimentarli.")} />

            <div className="bg-panel rounded-lg p-2">
              <div className="text-xs font-semibold text-sage-dark mb-1">{t("Tubazioni di adduzione dal canale")}</div>

              {canals.length > 1 && (
                <label className="block mb-2">
                  <span className="text-[10px] text-sage-dark block mb-1">{t("Canale")}</span>
                  <select className="field-input px-2 py-1.5 text-sm" value={pipeCanalIdx}
                    onChange={(e) => setPipeCanalIdx(Number(e.target.value))}>
                    {canals.map((c, i) => <option key={i} value={i}>{`${t("Canale")} ${i + 1}`}</option>)}
                  </select>
                </label>
              )}

              <div className="max-w-[12rem]">
                <div className="text-[10px] leading-tight text-sage-dark mb-1 truncate">{t("Pivot per linea (max)")}</div>
                <input type="number" min={1} max={100} step={1} value={pipeMaxPerLine}
                  onChange={(e) => setPipeMaxPerLine(Math.max(1, Number(e.target.value)))} className="field-input px-2 py-1.5 text-sm" />
              </div>

              {nPipes > 0 && (
                <div className="text-[11px] text-sage-dark mt-2">{t("Tubazioni attive")}: <b>{nPipes}</b></div>
              )}

              <div className="flex gap-2 mt-2">
                <button className="btn-primary flex-1 basis-0" disabled={!active || !canals.length}
                  onClick={generatePipes}>
                  {active ? t("Traccia tubazioni su «{name}»", { name: active.name }) : t("Traccia tubazioni")}
                </button>
                <button className="btn-ghost flex-1 basis-0" disabled={!nPipes} onClick={removePipes}>{t("Rimuovi tubazioni")}</button>
              </div>
              <div className="flex gap-2 mt-2">
                <button className="btn-ghost flex-1 basis-0" disabled={!active} onClick={() => drawPipeManual("new")}>{t("Disegna tubazione")}</button>
                <button className="btn-ghost flex-1 basis-0" disabled={pipeSel.mode !== "single"} onClick={deleteSelectedPipe}>
                  {t("Elimina la tubazione selezionata")}
                </button>
              </div>
              {!canals.length && <p className="text-[10px] text-danger mt-1">{t("Traccia prima un canale nella pagina Rilievo.")}</p>}
            </div>

            <div className="border-t border-black/5 mt-3 pt-3">
              <div className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide">{t("Idraulica")}</div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <label className="text-[11px] text-sage-dark">{t("Velocità max (m/s)")}
                  <input type="number" min={0.3} step={0.1} value={vMax}
                    onChange={(e) => setVMax(Math.max(0.3, Number(e.target.value)))} className="field-input px-2 py-1.5 text-sm mt-0.5" />
                </label>
                <label className="text-[11px] text-sage-dark">{t("Scabrezza (C Hazen-Williams)")}
                  <input type="number" min={80} max={160} step={5} value={hwC}
                    onChange={(e) => setHwC(Math.max(80, Math.min(160, Number(e.target.value))))} className="field-input px-2 py-1.5 text-sm mt-0.5" />
                </label>
              </div>
              <button className="btn-primary w-full mt-2" disabled={!nPipes} onClick={runHydraulics}>
                {t("Calcola diametri")}
              </button>
              {hydra && (
                <div className="mt-2 text-[11px] text-brand-darker bg-panel rounded-lg p-2 leading-relaxed">
                  <div><b>{t("Portata totale")}</b>: {fmt(Math.round(hydra.totalQ))} l/s · {t("prese")}: {hydra.nSources}</div>
                  <div>{t("Prevalenza richiesta alla presa")}: <b>{fmt(hydra.headMax / 10.2, { maximumFractionDigits: 1 })} bar</b> ({fmt(Math.round(hydra.headMax))} m)
                    {!hydra.withElev && ` · ${t("senza dislivelli")}`}</div>
                  <div>{t("Perdita di carico massima su un tratto")}: {fmt(hydra.hlMax, { maximumFractionDigits: 2 })} m</div>
                  <div className="mt-1"><b>{t("Metri per diametro")}</b></div>
                  <table className="w-full tabular-nums">
                    <tbody>
                      {hydra.byDn.map(([dn, m]) => (
                        <tr key={dn}><td className="pr-2">DN {dn}</td><td className="text-right">{fmt(Math.round(m))} m</td></tr>
                      ))}
                    </tbody>
                  </table>
                  {hydra.unserved > 0 && (
                    <div className="text-danger mt-1">{t("{n} pivot non sono su nessuna tubazione: la loro portata non è conteggiata.", { n: hydra.unserved })}</div>
                  )}
                </div>
              )}
            </div>

          </section>

          <section hidden={tab !== "fonte"}>
            <SectionHead title={t("Fonte d'acqua")} help={t("Indica da dove si prende l'acqua: il sistema confronta pompaggio diretto, vasca di accumulo con rilancio e canale a gravità, per l'alimentazione scelta, e suggerisce come montare la presa.")} />
            {renderSource()}
          </section>

          <section hidden={tab !== "pompaggio"}>
            <SectionHead title={t("Stazione di pompaggio")} help={t("Dimensionamento consigliato della stazione di pompaggio in base alla potenza: numero e potenza delle pompe, scorte, potenza installata e consumo annuo di energia. Usa portate e fabbisogno della pagina Irrigazione, la prevalenza calcolata nella pagina Tubazioni e il clima del sito mese per mese.")} />
            {renderPumpStation()}
          </section>

          <section hidden={tab !== "irrigazione"}>
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Fabbisogno e portate")}</h3>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] text-sage-dark">{t("Coltura")}
                <select className="field-input mt-0.5 px-2 py-1.5 text-sm" value={cropKey}
                  onChange={(e) => { setCropKey(e.target.value); patch({ kc: cropOf(e.target.value).kc }); }}>
                  {CROP_LIST.map((cp) => <option key={cp.key} value={cp.key}>{t(cp.label)}</option>)}
                </select></label>
              <label className="text-[11px] text-sage-dark">{t("Tipo di suolo")}
                <select className="field-input mt-0.5 px-2 py-1.5 text-sm" value={soilKey}
                  onChange={(e) => { setSoilKey(e.target.value); infTouched.current = false; setInfiltration(soilOf(e.target.value).inf); }}>
                  {SOILS.map((so) => <option key={so.key} value={so.key}>{t(so.label)}</option>)}
                </select></label>
              <label className="text-[11px] text-sage-dark">{t("ET₀ di punta (mm/g)")}
                <input type="number" min={1} step={0.5} value={et0Peak}
                  onChange={(e) => setEt0Peak(Math.max(1, Number(e.target.value)))} className="field-input mt-0.5 px-2 py-1.5 text-sm" /></label>
              <label className="text-[11px] text-sage-dark">{t("Piovosità utile (mm/24h)")}
                <input type="number" min={0} step={0.5} value={rainMm}
                  onChange={(e) => setRainMm(Math.max(0, Number(e.target.value)))} className="field-input mt-0.5 px-2 py-1.5 text-sm" /></label>
              <label className="text-[11px] text-sage-dark">{t("Efficienza impianto (%)")}
                <input type="number" min={40} max={100} step={1} value={effPct}
                  onChange={(e) => setEffPct(Math.max(40, Math.min(100, Number(e.target.value))))} className="field-input mt-0.5 px-2 py-1.5 text-sm" /></label>
              <label className="text-[11px] text-sage-dark">{t("Ore di esercizio al giorno")}
                <input type="number" min={1} max={24} step={1} value={hoursDay}
                  onChange={(e) => setHoursDay(Math.max(1, Math.min(24, Number(e.target.value))))} className="field-input mt-0.5 px-2 py-1.5 text-sm" /></label>
            </div>

            <div className="flex items-end gap-2 mt-2">
              <label className="text-[11px] text-sage-dark flex-1">{t("Fabbisogno (mm/24h)")}
                <input type="number" min={0} step={0.5} value={mm24}
                  onChange={(e) => setMm24(Math.max(0, Number(e.target.value)))} className="field-input mt-0.5 px-2 py-1.5 text-sm" /></label>
              <button className="btn-ghost whitespace-nowrap" onClick={() => setMm24(Math.round(mm24Suggested * 10) / 10)}>
                {t("Consigliato")}: {fmt(mm24Suggested, { maximumFractionDigits: 1 })}
              </button>
            </div>
            {mm24 < mm24Suggested - 0.05 && (
              <p className="text-[11px] text-amber mt-1">{t("Rete, stazioni e vasche sono dimensionate su {v} mm/g: ETc di punta della coltura più esigente ({c}, Kc {k}).", { v: fmt(mmDes, { maximumFractionDigits: 1 }), c: t(cropMax?.label ?? "Altro"), k: fmt(kcMax, { maximumFractionDigits: 2 }) })}</p>
            )}

            <h3 className="text-sm font-semibold text-brand-darker mt-3 mb-2">{t("Assorbimento del terreno")}</h3>
            <div className="grid grid-cols-3 gap-2">
              <label className="text-[11px] text-sage-dark">{t("Assorbimento (mm/h)")}
                <input type="number" min={0.5} step={0.5} value={infiltration}
                  onFocus={() => { infTouched.current = true; }}
                  onChange={(e) => setInfiltration(Math.max(0.5, Number(e.target.value)))}
                  className="field-input mt-0.5 px-2 py-1.5 text-sm" />
                <span className="block text-[10px] text-sage-dark mt-0.5 leading-tight">
                  {t("tipico")} {soilOf(soilKey).inf} mm/h
                </span></label>
              <label className="text-[11px] text-sage-dark">{t("Larghezza bagnata (m)")}
                <input type="number" min={3} step={1} value={wetW}
                  onChange={(e) => setWetW(Math.max(3, Number(e.target.value)))} className="field-input mt-0.5 px-2 py-1.5 text-sm" /></label>
              <label className="text-[11px] text-sage-dark">{t("Giri al giorno")}
                <input type="number" min={1} step={1} value={turnsDay}
                  onChange={(e) => setTurnsDay(Math.max(1, Number(e.target.value)))} className="field-input mt-0.5 px-2 py-1.5 text-sm" /></label>
              <label className="text-[11px] text-sage-dark col-span-2">{t("Profilo di bagnatura")}
                <select className="field-input mt-0.5 px-2 py-1.5 text-sm" value={pattern} onChange={(e) => setPattern(e.target.value)}>
                  <option value="rettangolare">{t("Rettangolare (×1,00)")}</option>
                  <option value="ellittica">{t("Ellittica (×1,27)")}</option>
                  <option value="triangolare">{t("Triangolare (×2,00)")}</option>
                </select></label>
              <label className="text-[11px] text-sage-dark">{t("Invaso superficiale (mm)")}
                <input type="number" min={0} step={0.5} value={surfStore}
                  onChange={(e) => setSurfStore(Math.max(0, Number(e.target.value)))} className="field-input mt-0.5 px-2 py-1.5 text-sm" /></label>
            </div>

            <h3 className="text-sm font-semibold text-brand-darker mt-3 mb-2">{t("Pressione del pivot")}</h3>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] text-sage-dark">{t("Pressione agli irrigatori (bar)")}
                <input type="number" min={0.5} step={0.1} value={sprinkBar}
                  onChange={(e) => setSprinkBar(Math.max(0.5, Number(e.target.value)))} className="field-input mt-0.5 px-2 py-1.5 text-sm" /></label>
              <label className="text-[11px] text-sage-dark">{t("Perdite al punto pivot (bar)")}
                <input type="number" min={0} step={0.05} value={pivotPointBar}
                  onChange={(e) => setPivotPointBar(Math.max(0, Number(e.target.value)))} className="field-input mt-0.5 px-2 py-1.5 text-sm" /></label>
              {!SPAN_LIST[pivotBrand] && <label className="text-[11px] text-sage-dark">{t("Condotta del pivot (mm)")}
                <input type="number" min={100} step={1} value={latDN}
                  onChange={(e) => setLatDN(Math.max(100, Number(e.target.value)))} className="field-input mt-0.5 px-2 py-1.5 text-sm" /></label>}
            </div>
            {pivots.length > 0 && (() => {
              const big = pivots.reduce((a, p) => (pivotPressure(p) > pivotPressure(a) ? p : a), pivots[0]);
              const pp = pivotPressureParts(big);
              return (
                <p className="text-[11px] text-sage-dark mt-1 leading-snug">
                  {t("Pivot più esigente")}: <b className="text-brand-darker">{fmt(pp.total, { maximumFractionDigits: 2 })} bar</b> = {t("irrigatori")} {fmt(pp.sprink, { maximumFractionDigits: 2 })} + {t("campate")} {fmt(pp.spans, { maximumFractionDigits: 2 })} + {t("punto pivot")} {fmt(pp.point, { maximumFractionDigits: 2 })}
                  {pp.how === "spans" ? ` (${t("diametri delle campate {b}", { b: PIVOT_BRANDS[pivotBrand] })})` : ""}. {t("Entra nella prevalenza della rete (pagina Tubazioni) e delle pompe.")}
                </p>
              );
            })()}

            {pivots.length > 0 && (() => {
              const rMax = Math.max(...pivots.map((p) => p.r));
              const rate = rimPeak(rMax);
              const tot = pivots.reduce((a, p) => a + pivotFlow(p), 0);
              const big = pivots.reduce((a, p) => (p.r > a.r ? p : a), pivots[0]);
              return (
                <div className="mt-3 text-[11px] bg-panel rounded-lg p-2 leading-relaxed text-brand-darker">
                  <div>{t("Pivot più grande")}: {Math.round(big.r)} m · {fmt(Math.round(pivotFlow(big)))} l/s · {pivotPressure(big).toFixed(1)} bar</div>
                  <div>{t("Portata totale dei pivot")}: <b>{fmt(Math.round(tot))} l/s</b></div>
                  <div className="mt-1">
                    {t("All'estremità del pivot")} ({Math.round(rMax)} m): {t("bagnatura")} {fmt(wetHours(rMax) * 60, { maximumFractionDigits: 1 })} min · {fmt(depthPass(), { maximumFractionDigits: 1 })} mm {t("a giro")}
                  </div>
                  <div className={rate > infiltration ? "text-danger font-semibold" : ""}>
                    {t("Intensità istantanea di picco")}: {fmt(rate, { maximumFractionDigits: 1 })} mm/h — {t("assorbimento")} {fmt(infiltration, { maximumFractionDigits: 1 })} mm/h
                    {rate > infiltration ? " ⚠" : " ✓"}
                  </div>
                  {(() => {
                    const ro = runoffMm(rMax); const need = turnsNeeded(rMax);
                    return ro > 0 ? (
                      <div className="text-danger font-semibold">
                        {t("Ruscellamento")}: {fmt(ro, { maximumFractionDigits: 1 })} mm {t("a giro")}
                        {need ? ` · ${t("servono {n} giri/giorno", { n: need })}` : ` · ${t("aumenta la larghezza bagnata")}`}
                        {need ? <button className="btn-ghost ml-2 py-0.5" onClick={() => setTurnsDay(need)}>{t("Applica")}</button> : null}
                      </div>
                    ) : <div>{t("Nessun ruscellamento previsto")} ✓</div>;
                  })()}
                </div>
              );
            })()}
          </section>

          <section hidden={tab !== "export"}>
            <SectionHead title={t("Esporta progetto")} help={t("La scheda include idoneità, layout, dimensionamento idrico, fasi e schema dell'impianto.")} />
            <label className="text-xs text-sage-dark">{t("Note (facoltative)")}
              <input className="field-input mt-1" value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder={t("es. coltura, cliente, fase")} />
            </label>
            {/* Quali campi esportare: uno solo, alcuni o tutti. Con più di uno
                selezionato i PDF escono raggruppati in uno ZIP. */}
            {fields.length > 1 && (
              <div className="mt-2 bg-panel rounded-lg p-2 space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide flex-1">
                    {t("Campi da esportare")} <span className="tabular-nums normal-case">({pdfPick.length}/{fields.length})</span>
                  </div>
                  <button className="text-[11px] text-brand hover:underline" onClick={() => setPdfSkip(new Set())}>{t("Tutti")}</button>
                  <button className="text-[11px] text-brand hover:underline"
                    disabled={activeId == null}
                    onClick={() => setPdfSkip(new Set(fields.filter((f) => f.id !== activeId).map((f) => f.id)))}>
                    {t("Solo attivo")}
                  </button>
                </div>
                <ul className="max-h-36 overflow-auto scroll-soft space-y-0.5">
                  {fields.map((f) => (
                    <li key={f.id}>
                      <label className="flex items-center gap-2 text-sm text-brand-darker cursor-pointer">
                        <input type="checkbox" checked={!pdfSkip.has(f.id)}
                          onChange={(e) => setPdfSkip((sk) => {
                            const n = new Set(sk);
                            if (e.target.checked) n.delete(f.id); else n.add(f.id);
                            return n;
                          })} />
                        <span className="text-[9px] uppercase font-semibold px-1 py-0.5 rounded shrink-0"
                          style={{ background: (f.level === "campo" ? "#e4f4ea" : "#fdefe0"), color: (f.level === "campo" ? "#03683a" : "#b5651a") }}>
                          {f.level === "campo" ? t("Campo") : t("Area")}
                        </span>
                        <span className="truncate">{f.name}</span>
                        <span className="text-sage-dark text-[11px] shrink-0 ml-auto">{uHa(ringAreaHa(f.geom.coordinates))}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Cosa stampare: la scheda con i dati, la tavola della planimetria, o
                entrambe. La lingua della stampa e' indipendente da quella
                dell'interfaccia: si esporta per il cliente, non per se'. */}
            <div className="mt-2 bg-panel rounded-lg p-2 space-y-1.5">
              <div className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide">{t("Cosa stampare")}</div>
              <label className="flex items-center gap-2 text-sm text-brand-darker cursor-pointer">
                <input type="checkbox" checked={pdfSheet} onChange={(e) => setPdfSheet(e.target.checked)} />
                {t("Scheda progetto")}
              </label>
              <label className="flex items-center gap-2 text-sm text-brand-darker cursor-pointer">
                <input type="checkbox" checked={pdfPlan} onChange={(e) => setPdfPlan(e.target.checked)} />
                {t("Planimetria su ortofoto")}
              </label>
              {pdfPlan && (
                <div className="pt-1">
                  <div className="text-xs text-sage-dark mb-1">{t("Formato della tavola")}</div>
                  <div className="seg">
                    <button className="seg-item" data-active={pdfFormat === "a3"} onClick={() => setPdfFormat("a3")}
                      title={t("Foglio grande: tratti sottili e più dettagli sul disegno.")}>A3</button>
                    <button className="seg-item" data-active={pdfFormat === "a4"} onClick={() => setPdfFormat("a4")}
                      title={t("Foglio da ufficio: tratti più marcati, meno etichette.")}>A4</button>
                  </div>
                </div>
              )}
              <label className="block text-xs text-sage-dark pt-1">{t("Lingua della stampa")}
                <select className="field-input mt-1 text-sm" value={pdfLang} onChange={(e) => { pdfLangTouched.current = true; setPdfLang(e.target.value as Lang); }}>
                  {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
              </label>
            </div>
            <div className="flex gap-2 mt-2">
              <button className="btn-primary flex-1 basis-0"
                disabled={busy === "pdf" || !hasFields || (!pdfSheet && !pdfPlan) || !pdfPick.length}
                title={!pdfPick.length ? t("Seleziona almeno un campo da esportare.")
                  : (!pdfSheet && !pdfPlan ? t("Seleziona almeno una sezione da stampare.") : undefined)}
                onClick={downloadPdf}>
                {busy === "pdf" ? t("Preparo…") : (pdfPick.length > 1 ? t("Scarica PDF (ZIP)") : t("Scarica PDF"))}
              </button>
              <button className="btn-ghost flex-1 basis-0" disabled={!laid.length} onClick={downloadGeoJSON}>{t("Layout GeoJSON")}</button>
            </div>
            <button className="btn-ghost w-full mt-2" disabled={!pivots.length && !Object.values(sysDesigns).some((d) => d.sys === "lineari")} onClick={exportCeres}
              title={t("Campi e pivot con le campate del produttore scelto in Impianti, da aprire in Ceres con File › Apri file.")}>{t("Esporta per Ceres (.ceres)")}</button>
            <div className="mt-3 bg-panel rounded-lg p-2 space-y-1.5">
              <div className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide">{t("Fasi di realizzazione")}</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[11px] text-sage-dark">{t("Numero di fasi")}
                  <input type="number" min={1} max={10} step={1} value={phaseN} onChange={(e) => setPhaseN(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} className="field-input mt-0.5 py-1 text-sm" /></label>
                <label className="text-[11px] text-sage-dark">{t("Ordine")}
                  <select className="field-input mt-0.5 py-1 text-sm" value={phaseOrderBy} onChange={(e) => setPhaseOrderBy(e.target.value as "fonte" | "ovest" | "sud")}>
                    <option value="fonte">{t("dalla fonte d'acqua")}</option><option value="ovest">{t("da ovest a est")}</option><option value="sud">{t("da sud a nord")}</option>
                  </select></label>
              </div>
              <div className="flex gap-2 items-center">
                <button className="btn-ghost flex-1 text-[12px]" disabled={!pivots.length && !Object.keys(sysDesigns).length} onClick={assignPhases}>{t("Dividi in fasi")}</button>
                {nPhases > 1 && <label className="flex items-center gap-1 text-[11px] text-sage-dark"><input type="checkbox" checked={phaseColors} onChange={(e) => setPhaseColors(e.target.checked)} />{t("Colori per fase")}</label>}
              </div>
              {nPhases > 1 && (
                <table className="w-full text-[11px]"><tbody>
                  {phaseSummary().map((r) => (
                    <tr key={r.ph}><td className="text-brand-darker font-semibold">{t("Fase")} {r.ph}</td>
                      <td className="text-right tabular-nums">{fmt(r.nPiv)} pivot{r.sys ? ` + ${fmt(r.sys)} ${t("campi")}` : ""}</td>
                      <td className="text-right tabular-nums">{fmt(r.ha, { maximumFractionDigits: 1 })} ha</td>
                      <td className="text-right tabular-nums">{fmt(Math.round(r.qLs))} l/s</td></tr>
                  ))}
                </tbody></table>
              )}
              <p className="text-[10px] text-sage-dark leading-snug">{t("Fasi di superficie simile. Rete principale, fonte d'acqua, stazioni e fotovoltaico vanno nella fase 1. Il computo in Excel ha un blocco per fase più il totale.")}</p>
            </div>
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <button className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide flex-1 text-left" onClick={() => setComputoOpen((o) => !o)}>
                  {computoOpen ? "▾" : "▸"} {t("Computo metrico")}</button>
                <button className="text-[11px] text-brand hover:underline" disabled={!pivots.length && !Object.keys(sysDesigns).length} onClick={downloadComputo}>{t("Scarica Excel")}</button>
              </div>
              {computoOpen && (() => {
                const rows = computoRows();
                if (!rows.length) return <p className="text-[11px] text-sage-dark mt-1">{t("Posa prima i pivot sul campo attivo.")}</p>;
                let last = "";
                return (
                  <table className="w-full text-[11px] mt-1"><tbody>
                    {rows.map((r, i) => {
                      const head = r.cat !== last; last = r.cat;
                      return (
                        <React.Fragment key={i}>
                          {head && <tr><td colSpan={3} className="pt-1.5 font-semibold text-brand-darker">{r.cat}</td></tr>}
                          <tr className="align-top">
                            <td className="text-brand-darker pr-1">{r.item}{r.note && <div className="text-[10px] text-sage-dark">{r.note}</div>}</td>
                            <td className="text-right tabular-nums whitespace-nowrap">{r.qty != null ? fmt(r.qty) : ""}</td>
                            <td className="pl-1 text-sage-dark whitespace-nowrap">{r.unit}</td>
                          </tr>
                        </React.Fragment>
                      );
                    })}
                  </tbody></table>
                );
              })()}
              <p className="text-[10px] text-sage-dark mt-1 leading-snug">{t("Solo quantità, senza prezzi. Le campate dipendono dal produttore scelto in Impianti; pompe e opere della fonte dallo schema mostrato nella pagina Fonte d'acqua.")}</p>
            </div>

            {/* Storico delle revisioni: ogni export prende il numero successivo
                e la tavola lo porta stampato nel cartiglio. Vive sul server,
                quindi resta anche cambiando computer. */}
            {!!revs.length && (
              <div className="mt-3">
                <div className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide mb-1">
                  {t("Revisioni esportate")} <span className="tabular-nums normal-case">({revs.length})</span>
                </div>
                <ul className="max-h-40 overflow-auto scroll-soft space-y-0.5">
                  {revs.map((r) => {
                    const f = r.area_id != null ? fields.find((x) => x.savedId === r.area_id) : null;
                    const when = r.created_at ? new Date(r.created_at) : null;
                    return (
                      <li key={`${r.area_id ?? "p"}-${r.n}`}
                        className="flex items-baseline gap-2 text-[11px] bg-panel rounded px-1.5 py-1">
                        <b className="text-brand-darker tabular-nums shrink-0">{t("Rev. {n}", { n: r.n })}</b>
                        <span className="truncate flex-1 text-sage-dark">
                          {f?.name ?? r.label}
                          {r.summary?.pivots ? ` · ${r.summary.pivots} pivot` : ""}
                        </span>
                        <span className="text-sage-dark shrink-0 uppercase">{r.fmt}</span>
                        <span className="text-sage-dark shrink-0 tabular-nums">
                          {when ? when.toLocaleDateString() : ""}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Link pubblici di sola lettura: uno per vista/cliente */}
            <div className="mt-4 border-t border-brand/15 pt-3">
              <div className="text-sm font-semibold text-brand-darker mb-1">{t("Link per i clienti (sola lettura)")}</div>
              <p className="text-[11px] text-sage-dark mb-2">{t("Ogni link «fotografa» ciò che è visibile ORA (aree/campi e gruppi di pivot con l'occhio acceso). Nascondi/mostra i livelli come vuoi, poi crea il link: puoi farne più d'uno per mostrare a clienti diversi cose diverse.")}</p>
              <div className="flex gap-2">
                <input value={shareName} onChange={(e) => setShareName(e.target.value)} placeholder={t("Nome del link (es. Cliente A)")} className="field-input text-sm flex-1" />
                <button className="btn-primary shrink-0" disabled={busy === "share" || !projectId} onClick={createNamedShare}>
                  {busy === "share" ? t("Creo…") : t("Crea link")}
                </button>
              </div>
              {shares.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {shares.map((s) => {
                    const url = `${window.location.origin}/view/${s.token}`;
                    return (
                      <li key={s.token} className="flex items-center gap-1 text-[12px] bg-panel rounded-lg px-2 py-1">
                        <span className="flex-1 truncate font-medium text-brand-darker">{s.name}</span>
                        <button className="text-brand-mid shrink-0 px-1" title={t("Copia link")} onClick={() => { navigator.clipboard?.writeText(url); setMsg(t("Link copiato ✓")); }}>⧉</button>
                        <a className="text-brand-mid shrink-0 px-1" title={t("Apri")} href={url} target="_blank" rel="noreferrer">↗</a>
                        <button className="text-danger shrink-0 px-1" title={t("Elimina link")} onClick={() => removeShare(s.token)}>✕</button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Commenti lasciati dai clienti sui link */}
            {projectId != null && (() => {
              const order = [...comments].reverse();             // numerazione in ordine di arrivo
              const list = comments.filter((c) => showResolved || !c.resolved);
              const unseenN = comments.filter((c) => !c.seen).length;
              const openN = comments.filter((c) => !c.resolved).length;
              const when = (iso: string | null) => {
                if (!iso) return "";
                const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
                return d.toLocaleString(lang, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
              };
              return (
                <div className="mt-4 border-t border-brand/15 pt-3">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="text-sm font-semibold text-brand-darker flex-1">{t("Commenti dei clienti")} · {openN}</div>
                    {unseenN > 0 && <span className="text-[10px] font-bold bg-nabu-accent text-white rounded-full px-1.5">{unseenN} {t("nuovi")}</span>}
                    <button className="text-[11px] text-brand-mid" onClick={() => projectId && refreshComments(projectId, false)} title={t("Aggiorna")}>↻</button>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-sage-dark mb-1">
                    <label className="flex items-center gap-1"><input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />{t("Mostra risolti")}</label>
                    {unseenN > 0 && <button className="text-brand-mid ml-auto" onClick={markAllCommentsSeen}>{t("Segna tutti come letti")}</button>}
                  </div>
                  {!list.length ? (
                    <p className="text-[11px] text-sage-dark">{comments.length ? t("Nessun commento aperto.") : t("Nessun commento: i clienti possono scriverne dal link di sola lettura.")}</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {list.map((c) => (
                        <li key={c.id} className={"rounded-lg px-2 py-1.5 text-[12px] " + (c.seen ? "bg-panel" : "bg-nabu-accent/10 border border-nabu-accent/40") + (c.resolved ? " opacity-60" : "")}
                          onMouseEnter={() => { if (!c.seen) patchComment(c.id, { seen: true }); }}>
                          <div className="flex items-center gap-1 text-[11px] text-sage-dark">
                            <span className="font-semibold text-brand-darker">#{order.indexOf(c) + 1}</span>
                            <span className="truncate flex-1">{c.author || t("Anonimo")} · {c.share_name || t("link")} · {when(c.created_at)}</span>
                            {c.lat != null && c.lng != null && (
                              <button className="text-brand-mid shrink-0" title={t("Mostra sulla mappa")} onClick={() => mapApi.current?.flyTo(c.lat as number, c.lng as number, 15)}>📍</button>
                            )}
                            <button className={"shrink-0 " + (c.resolved ? "text-brand" : "text-sage-dark hover:text-brand")} title={c.resolved ? t("Riapri") : t("Segna come risolto")}
                              onClick={() => patchComment(c.id, { resolved: !c.resolved })}>✓</button>
                            <button className="text-danger shrink-0" title={t("Elimina")} onClick={() => removeComment(c.id)}>✕</button>
                          </div>
                          <div className="text-brand-darker whitespace-pre-wrap break-words mt-0.5">{c.body}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })()}
          </section>

          {/* ---------------- Informazioni: riepilogo del progetto ------------- */}
          <section hidden={tab !== "informazioni"}>
            <SectionHead title={t("Informazioni")} help={t("Numeri d'insieme di tutto ciò che è disegnato: macchine, acqua, rete e superfici. Si aggiornano da soli a ogni modifica.")} />
            {!pivots.length && !fields.length ? (
              <p className="text-[11px] text-sage-dark">{t("Niente da riepilogare: disegna o importa un'area e inserisci gli impianti.")}</p>
            ) : (() => {
              const st = projectStats;
              const tile = (label: string, value: React.ReactNode, sub?: React.ReactNode) => (
                <div className="bg-panel rounded-lg px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-sage-dark">{label}</div>
                  <div className="text-[15px] font-semibold text-brand-darker tabular-nums leading-tight">{value}</div>
                  {sub && <div className="text-[11px] text-sage-dark leading-tight mt-0.5">{sub}</div>}
                </div>
              );
              const pct = st.grossHa > 0 ? (st.irrHa / st.grossHa) * 100 : 0;
              return (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    {tile(t("Pivot"), st.n,
                      st.n ? <>{t("mediana")} {uM(st.medR)} · {uHa(st.medHa, 1)}<br />{t("da {min} a {max}", { min: uM(st.minR), max: uM(st.maxR) })}</> : null)}
                    {tile(t("Portata complessiva"), `${fmt(st.qM3h, { maximumFractionDigits: 0 })} m³/h`,
                      `${fmt(st.qLs, { maximumFractionDigits: 0 })} l/s`)}
                    {tile(t("Stazioni di pompaggio"), st.pumps,
                      st.pumps ? t("prese sul canale o corso d'acqua") : t("nessuna presa sull'acqua"))}
                    {tile(t("Tubazioni"), uM(st.pipeM), `${st.pipeN} ${t("rami")}`)}
                  </div>

                  <div className="bg-panel rounded-lg px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-sage-dark mb-1">{t("Superfici")}</div>
                    <div className="h-2 rounded-full bg-white overflow-hidden">
                      <div className="h-full bg-brand-light" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
                    </div>
                    <div className="flex justify-between text-[12px] mt-1.5">
                      <span className="text-brand-darker"><b className="tabular-nums">{uHa(st.irrHa)}</b> {t("irrigati")}</span>
                      <span className="text-sage-dark"><b className="tabular-nums">{uHa(st.todoHa)}</b> {t("da irrigare")}</span>
                    </div>
                    <div className="text-[11px] text-sage-dark mt-1">
                      {t("Superficie lorda")}: <b className="tabular-nums">{uHa(st.grossHa)}</b> · {fmt(pct, { maximumFractionDigits: 1 })}%
                    </div>
                  </div>

                  {fields.length > 1 && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-sage-dark mb-1">{t("Per campo")}</div>
                      <ul className="space-y-0.5 max-h-48 overflow-auto scroll-soft">
                        {fields.map((f) => {
                          const fs = fieldStats(f.id);
                          return (
                            <li key={f.id} className="flex items-baseline gap-2 text-[11px] bg-panel rounded px-1.5 py-1">
                              <span className="truncate flex-1 text-brand-darker">{f.name}</span>
                              <span className="text-sage-dark tabular-nums shrink-0">{fs.n} pivot</span>
                              <span className="text-sage-dark tabular-nums shrink-0">{uHa(fs.irrHa)}</span>
                              <span className="text-sage-dark tabular-nums shrink-0">{uM(fs.pipeM)}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  <p className="text-[10px] text-sage-dark leading-tight">
                    {t("Gli ettari irrigati misurano l'unione dei cerchi ritagliata sui poligoni: le sovrapposizioni non si contano due volte.")}
                  </p>
                </div>
              );
            })()}
          </section>

          {/* Resta solo l'avviso sui dati demo: senza quello il riquadro
              sarebbe una nota informativa vuota. */}
          {providerMode === "synthetic" && (
            <p hidden={tab !== "export"} className="hint">
              {t("Dati sintetici (demo) — nessun credito Copernicus consumato.")}
            </p>
          )}
          </div>
        </div>
        )}

        {/* Messaggi */}
        {/* Barra di disegno delle tubazioni: compare sulla pagina Accessori o
            quando una tubazione è selezionata. */}
        {(tab === "accessori" || pipeSel.mode !== "none" || pivotSel.mode === "single") && (
          <div className="absolute bottom-16 left-1/2 -translate-x-1/2 nabu-cluster gap-1 px-1.5 py-1.5 z-[1400]">
            <span className="text-[11px] text-sage-dark px-1.5 select-none">{t("Tubazioni")}</span>
            <span className="w-px h-6 bg-black/10" />
            <button className="tool-btn" title={t("Disegna tubazione")} aria-label={t("Disegna tubazione")}
              disabled={!active} onClick={() => drawPipeManual("new")}><IcoPipeNew /></button>
            <button className="tool-btn" title={t("Aggiungi un ramo da una tubazione esistente")} aria-label={t("Ramo")}
              disabled={!active || !nPipes} onClick={() => drawPipeManual("branch")}><IcoPipeBranch /></button>
            <button className="tool-btn" title={t("Aggiungi un punto: seleziona la tubazione e clicca sulla linea")} aria-label={t("Punto")}
              disabled={!nPipes}
              onClick={() => setMsg(t("Aggiungi un punto: seleziona la tubazione e clicca sulla linea"))}><IcoPipePoint /></button>
            <span className="w-px h-6 bg-black/10" />
            <button className="tool-btn" title={t("Elimina la tubazione selezionata")} aria-label={t("Elimina")}
              disabled={pipeSel.mode !== "single"} onClick={deleteSelectedPipe}><IcoTrash /></button>
            {(pivotSel.mode === "single" || (nPipes > 0 && pivots.some((p) => !fedPivotKeys(pivotLines).has(pKey(p))))) && (<>
              <span className="w-px h-6 bg-black/10" />
              <span className="text-[11px] text-sage-dark px-1 select-none">
                {t("Collega il pivot")}{(() => { const x = pivotToConnect(); return x ? ` #${x.idx + 1}` : ""; })()}
              </span>
              <button className="tool-btn" title={t("Collega il pivot alla tubazione a sinistra")} aria-label={t("A sinistra")}
                onClick={() => connectSelPivot("left")}><IcoArrowLeft /></button>
              <button className="tool-btn" title={t("Collega il pivot alla tubazione a destra")} aria-label={t("A destra")}
                onClick={() => connectSelPivot("right")}><IcoArrowRight /></button>
            </>)}
          </div>
        )}

        {msg && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pill-dark px-4 py-2 text-sm max-w-[calc(80vw/var(--ui-scale))]">
            {msg} <button className="ml-2 opacity-70" onClick={() => setMsg("")}>✕</button>
          </div>
        )}

        {/* Profilo altimetrico del canale */}
        {profileCanal != null && canals[profileCanal] && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40" onClick={() => setProfileCanal(null)}>
            <div className="widget p-4 w-[640px] max-w-[calc(92vw/var(--ui-scale))]" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-brand-darker">{t("Profilo elevazione")} — {t("Canale")} {profileCanal + 1}</h3>
                <button className="text-sage-dark hover:text-danger" onClick={() => setProfileCanal(null)}>✕</button>
              </div>
              <ProfileChart canal={canals[profileCanal]} imperial={imperial} t={t} fmt={fmt} />
              <div className="text-xs text-sage-dark mt-2 leading-relaxed">
                {t("Lunghezza")}: <b>{uKm(canals[profileCanal].length_m / 1000)}</b> · {t("Dislivello")}: <b>{uM(canals[profileCanal].drop_m, 1)}</b> · {t("Pendenza media")}: <b>{fmt(canals[profileCanal].mean_permille)}‰</b><br />
                {t("Quota")} {uM(canals[profileCanal].elev_start_m, 1)} → {uM(canals[profileCanal].elev_end_m, 1)}
              </div>
            </div>
          </div>
        )}

        {/* Revisione software */}
        <div className="absolute bottom-1 left-3 text-[11px] text-white/80 z-10 pointer-events-none">Argus Total {REV} · by Nabu srl — Agrostar Group srl</div>

        {/* Modale gestione utenti e crediti (solo admin) */}
        {showUsers && me?.is_admin && (
          <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={() => setShowUsers(false)}>
            <div className="w-full max-w-2xl max-h-[calc(85vh/var(--ui-scale))] bg-white rounded-2xl shadow-xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div className="px-4 py-3 flex items-center justify-between border-b border-black/5">
                <div className="font-semibold text-brand-darker">{t("Gestione utenti e crediti")}</div>
                <button onClick={() => setShowUsers(false)} className="text-sage-dark hover:text-brand text-xl leading-none px-2">×</button>
              </div>

              <div className="overflow-auto scroll-soft p-4 space-y-4">
                {/* Nuovo utente */}
                <div className="bg-panel rounded-lg p-3">
                  <div className="text-xs font-semibold text-sage-dark mb-2">{t("Nuovo utente")}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <input className="field-input" placeholder={t("Email")} value={nuEmail} onChange={(e) => setNuEmail(e.target.value)} />
                    <input className="field-input" placeholder={t("Nome (opzionale)")} value={nuName} onChange={(e) => setNuName(e.target.value)} />
                    <input className="field-input" type="password" placeholder={t("Password (min 8)")} value={nuPass} onChange={(e) => setNuPass(e.target.value)} />
                    <input className="field-input" type="number" min={0} step={1} placeholder={t("Crediti")} value={nuCredits} onChange={(e) => setNuCredits(Number(e.target.value))} />
                  </div>
                  <button className="btn-primary mt-2" onClick={createMember}>{t("Crea utente")}</button>
                </div>

                {usersMsg && <p className="text-sm text-danger">{usersMsg}</p>}

                {/* Elenco utenti */}
                <div className="space-y-2">
                  {adminUsers.map((u) => (
                    <div key={u.id} className="bg-panel rounded-lg px-3 py-2 flex items-center gap-2 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-brand-darker truncate">{u.email}{!u.is_active && <span className="text-danger"> · {t("disattivato")}</span>}</div>
                        <div className="text-[11px] text-sage-dark">{u.role === "owner" ? t("proprietario") : u.role}{u.full_name ? ` · ${u.full_name}` : ""}</div>
                      </div>
                      {u.role === "owner" ? (
                        <span className="text-[11px] text-sage-dark italic">{t("crediti illimitati")}</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-sm tabular-nums text-sage-dark">{u.credits_used} /</span>
                          <input type="number" min={0} step={1} defaultValue={u.credits ?? 0}
                            onBlur={(e) => patchMember(u.id, { credits: Number(e.target.value) })}
                            className="field-input w-20 px-2 py-1 text-sm" title={t("Crediti assegnati")} />
                          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => patchMember(u.id, { reset_used: true })} title={t("Azzera i crediti usati")}>{t("Azzera")}</button>
                          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => patchMember(u.id, { is_active: !u.is_active })}>{u.is_active ? t("Disattiva") : t("Attiva")}</button>
                          <button className="btn-ghost px-2 py-1 text-xs text-danger" onClick={() => removeMember(u.id)} title={t("Elimina")}>×</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <p className="text-[11px] text-sage-dark">{t("Ogni operazione consuma 1 credito; l'amministratore ha crediti illimitati.")}</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

// Grafico del profilo altimetrico (quota vs distanza) del canale.
function ProfileChart({ canal, imperial, t, fmt }: {
  canal: Canal; imperial: boolean;
  t: (s: string, v?: Record<string, string | number>) => string;
  fmt: (n: number, o?: Intl.NumberFormatOptions) => string;
}) {
  const prof = canal.profile || [];
  if (prof.length < 2) return <div className="hint">{t("Profilo non disponibile per questo canale.")}</div>;
  const W = 600, H = 240, pl = 52, pr = 12, pt = 12, pb = 30;
  const iw = W - pl - pr, ih = H - pt - pb;
  const dMax = prof[prof.length - 1][0] || 1;
  const elevs = prof.map((p) => p[1]);
  let eMin = Math.min(...elevs), eMax = Math.max(...elevs);
  if (eMax - eMin < 1) eMax = eMin + 1;
  const cLen = (m: number) => imperial ? m * 3.28084 : m;                 // per etichette
  const cDist = (m: number) => imperial ? m * 3.28084 : m;
  const x = (d: number) => pl + (d / dMax) * iw;
  const y = (e: number) => pt + (1 - (e - eMin) / (eMax - eMin)) * ih;
  const pts = prof.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  const area = `${pl},${pt + ih} ${pts} ${pl + iw},${pt + ih}`;
  const distU = imperial ? "ft" : "m", elevU = imperial ? "ft" : "m";
  const yticks = [eMin, (eMin + eMax) / 2, eMax];
  const xticks = [0, dMax / 2, dMax];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ background: "#f6faf6", borderRadius: 8 }}>
      <polygon points={area} fill="#0284c7" opacity={0.12} />
      <polyline points={pts} fill="none" stroke="#0284c7" strokeWidth={2} />
      {/* assi */}
      <line x1={pl} y1={pt} x2={pl} y2={pt + ih} stroke="#cbd5cb" />
      <line x1={pl} y1={pt + ih} x2={pl + iw} y2={pt + ih} stroke="#cbd5cb" />
      {yticks.map((e, k) => (
        <g key={`y${k}`}>
          <text x={pl - 6} y={y(e) + 3} textAnchor="end" fontSize={10} fill="#5b6b5b">{fmt(cLen(e), { maximumFractionDigits: 0 })}</text>
          <line x1={pl} y1={y(e)} x2={pl + iw} y2={y(e)} stroke="#e5ebe5" />
        </g>
      ))}
      {xticks.map((d, k) => (
        <text key={`x${k}`} x={x(d)} y={H - 8} textAnchor={k === 0 ? "start" : k === 2 ? "end" : "middle"} fontSize={10} fill="#5b6b5b">
          {fmt(cDist(d) / (imperial ? 1 : 1), { maximumFractionDigits: 0 })} {distU}
        </text>
      ))}
      <text x={12} y={pt + 10} fontSize={10} fill="#5b6b5b" transform={`rotate(-90 12 ${pt + ih / 2})`} textAnchor="middle">{t("quota")} ({elevU})</text>
    </svg>
  );
}

function WeightRow({ label, v, onChange }: { label: string; v: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="text-xs w-16 shrink-0">{label}</span>
      <input type="range" min={0} max={1} step={0.05} value={v}
        onChange={(e) => onChange(Number(e.target.value))} className="flex-1 accent-brand" />
      <span className="text-xs text-sage-dark w-8 text-right">{v.toFixed(2)}</span>
    </div>
  );
}

function ScaleBar({ scale, unit = "" }: { scale: ColorScale; unit?: string }) {
  const { fmt } = useI18n();
  const grad = `linear-gradient(90deg, ${scale.colors.join(",")})`;
  return (
    <div className="mt-2">
      <div className="h-2.5 rounded" style={{ background: grad }} />
      <div className="flex justify-between text-[10px] text-sage-dark mt-0.5">
        <span>{fmt(scale.vmin)}{unit}</span><span>{fmt(scale.vmax)}{unit}</span>
      </div>
    </div>
  );
}
