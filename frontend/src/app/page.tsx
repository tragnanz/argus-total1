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
import { Dxf, toUtm, utmZone } from "@/lib/dxf";
import { designCanal, canalEarthworks, LININGS, lining, pivotUniformity, cuGrade, SPRINKLERS, solarMonths, riverBalance, type LiningId, type CanalSection, type CuResult } from "@/lib/hydro";
import type { LL, RGB, TvSheet, TvCommon, TvPivot, TvLine, TvPoint, TvColItem, TvTrenchItem, TvDraw, TvTech } from "@/lib/tavole";
import { linearLayout, reelLayout, dripLayout, type LL as SysLL } from "@/lib/systems";
import type {
  Area, Client, Polygon, Project, Scene, ColorScale, SuitMeta, SuitWeights,
  LayoutMeta, LayoutConfig, Transport, PhaseOrder, LayoutParams, GeoJSONFC, MacroArea, Canal, GuidedResult, ProjectLayer, Watercourse, ElevationResult,
} from "@/lib/api";

// Revisione software: aggiornare a ogni versione consegnata.
const REV = "v0.6.230";

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
const DEFAULT_KC = 1.15;   // Kc di partenza delle impostazioni del campo (finché non si sceglie la coltura)
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
  { key: "solare", label: "Pivot solari" },
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
  nPhases: 1, phaseOrder: "canal_distance", kc: DEFAULT_KC, eff: 0.85, hours: 20,
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
type CanalL = Canal & { hidden?: boolean; uid?: number; owner?: number; exist?: boolean };   // exist: canale esistente (non entra nel computo)
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
  // canali, corsi d'acqua, altri sistemi, fonte d'acqua (punto, tracciato, parametri), colture
  cn?: unknown[]; wc?: unknown[]; sy?: Record<string, unknown>; fo?: Record<string, unknown>;
  cr?: { base: string[]; fields: Record<string, string[]> };
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
// Tara dei pivot solari: il cerchio attorno al perno che contiene i pannelli non è irriguo.
// Il raggio dipende dal campo FV (stato della pagina): la funzione è impostata a ogni render.
let solarTaraR: (p: { r: number; solar?: boolean }) => number = () => 0;
const pvAreaM2 = (p: { r: number; deg?: number; gun?: number; solar?: boolean }) => {
  const f = Math.max(1, Math.min(360, p.deg ?? 360)) / 360, R0 = p.solar ? Math.min(p.r, solarTaraR(p)) : 0;
  return f * Math.PI * (Math.pow(p.r + Math.max(0, p.gun ?? 0), 2) - R0 * R0);
};
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
const IcoNavSolare = () => (<svg {...navProps}><circle cx="17" cy="6" r="2.4" /><path d="M17 1.5v1.2M21.5 6h-1.2M20.2 2.8l-.8.8" /><path d="M3 19 6 11h11l3 8Z" /><path d="M4.5 15h14M9.5 11 9 19M14 11l.5 8" /></svg>);
const IcoNavExport = () => (<svg {...navProps}><path d="M12 3v11" /><path d="m7 10 5 5 5-5" /><path d="M4 20h16" /></svg>);
const IcoNavIrrigazione = () => (<svg {...navProps}><path d="M12 3s5 5.5 5 9a5 5 0 0 1-10 0c0-3.5 5-9 5-9Z" /><path d="M10 13a2 2 0 0 0 4 0" /></svg>);
const IcoNavInfo = () => (<svg {...navProps}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.6v.6" /></svg>);
const TAB_ICONS = {
  analisi: IcoNavAnalisi, rilievo: IcoNavRilievo, impianti: IcoNavImpianti,
  fonte: IcoNavFonte, accessori: IcoNavAccessori, pompaggio: IcoNavPompaggio, solare: IcoNavSolare, strade: IcoNavStrade, irrigazione: IcoNavIrrigazione, export: IcoNavExport,
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
  // Dimensionamento dei canali (moto uniforme, Manning — come Nereus pag. 03)
  const [canalLin, setCanalLin] = useState<LiningId>("earth");
  const [canalQ, setCanalQ] = useState(0);            // portata del canale (l/s); 0 = portata di progetto
  const [canalFb, setCanalFb] = useState(0.3);        // franco minimo (m)
  const [cuModel, setCuModel] = useState("kpt_black");   // irrigatori del calcolo di uniformità (Nereus pag. 18)
  const cuMemo = useRef(new Map<string, CuResult | null>());
  // Fossi di scolo dei campi (Nereus pag. 17, scheda «Fosso»): coefficiente di drenaggio in mm/24h
  // Fertirrigazione: prodotto liquido, dose di N per intervento, interventi per stagione
  const FERTS = [{ k: "uan32", label: "UAN 32 (soluzione azotata 32% N)", n: 32, rho: 1.32 }, { k: "an20", label: "Nitrato ammonico liquido (20% N)", n: 20, rho: 1.27 },
    { k: "urea20", label: "Urea in soluzione (20% N)", n: 20, rho: 1.13 }, { k: "custom", label: "Altro prodotto", n: 15, rho: 1.2 }] as const;
  const [fert, setFert] = useState<{ on: boolean; k: string; n: number; rho: number; dose: number; times: number }>({ on: false, k: "uan32", n: 32, rho: 1.32, dose: 30, times: 6 });
  const [ndvi, setNdvi] = useState<(api.NdviOut & { sig: string }) | null>(null);   // ultima lettura NDVI dei pivot
  const [drainOn, setDrainOn] = useState(false);
  // quote del perimetro di ogni campo (DEM), punti ogni ~25 m: { pts [lng, lat], z }
  const [drainProf, setDrainProf] = useState<Record<string, { pts: number[][]; z: (number | null)[] }>>({});
  const [drainC, setDrainC] = useState(12.96);         // mm/24h = 1,5 l/s·ha
  const [drainS, setDrainS] = useState(2);             // pendenza del fondo (‰)
  const [drainB, setDrainB] = useState(0.5);           // base del fosso (m)
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
  // Colture dell'azienda (una o più, in rotazione) e colture di ogni campo (una o più):
  // un campo senza colture proprie segue quelle dell'azienda. Salvate con il progetto.
  const [farmCrops, setFarmCrops] = useState<string[]>(["canna"]);
  const [fieldCrops, setFieldCrops] = useState<Record<string, string[]>>({});
  const [solarCfg, setSolarCfg] = useState({ wp: 550, k: 1.6, batt: 0, off: 6 });   // pivot solari: modulo Wp, kWp/kW, ore di batteria, distanza dal perno (m)
  // la coltura più esigente dell'azienda (Kc di punta di riferimento)
  const cropKey = [...farmCrops].sort((a, b) => cropOf(b).kc - cropOf(a).kc)[0] ?? "canna";
  // lista di chiavi valide (vecchi progetti: una sola stringa)
  const cropList = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? [v] : [])
    .filter((k): k is string => typeof k === "string" && CROP_LIST.some((c) => c.key === k)).filter((k, i, a) => a.indexOf(k) === i);
  // Pagina Impianti: sistema irriguo scelto. Per ora è implementato il pivot;
  // gli altri sono predisposti e restano vuoti finché non arrivano.
  const [irrigSys, setIrrigSys] = useState<"pivot" | "lineari" | "rotoloni" | "goccia">("pivot");
  const [mm24, setMm24] = useState(8);               // fabbisogno lordo (mm/24h)
  const [rainMm, setRainMm] = useState(0);           // piovosità utile (mm/24h)
  const [effPct, setEffPct] = useState(85);          // efficienza dell'impianto (%)
  // Etichette sulla mappa con superficie e portata di ogni pivot (spegnibili).
  // Vista mappa: etichette e livelli nascosti (per utente, nel browser)
  const MAP_VIEW = [["field", "Nomi di campi e punti"], ["pivot", "Ettari e portata dei pivot"], ["stn", "Sigle delle stazioni"], ["solar", "Etichette kWp"], ["mod", "Pannelli FV"], ["tara", "Tara FV"], ["basin", "Bacino del fiume"], ["ditch", "Fossi di scolo"]] as const;
  const [mapHide, setMapHide] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("argus.mapHide") || "[]"); } catch { return []; } });
  useEffect(() => {
    try { localStorage.setItem("argus.mapHide", JSON.stringify(mapHide)); } catch { /* */ }
    for (const [k] of MAP_VIEW) document.body.classList.toggle(`mh-${k}`, mapHide.includes(k));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapHide]);
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
  // Azionamento delle pompe di superficie: motore elettrico (2 o 4 poli, 1450/2900 giri)
  // o motore diesel (motopompa: velocità intermedie e serie MEC-MG solo a motore termico)
  const [pumpDrive, setPumpDrive] = useState<"el" | "diesel">("el");
  type SrcElev = { zS: number | null; zR: number | null; zPmax: number | null; zPiv: (number | null)[];
    prof: { d: number[]; z: (number | null)[] }; key: string };
  const [srcElev, setSrcElev] = useState<SrcElev | null>(null);
  const [srcRoute, setSrcRoute] = useState<number[][] | null>(null);   // tracciato disegnato presa → vasca ([lng, lat])
  const [srcMonthly, setSrcMonthly] = useState<number[] | null>(null); // livello minimo mese per mese (m sotto il punto di presa)
  const [srcSectors, setSrcSectors] = useState(0);                   // settori di rilancio (0 = automatico)
  // Portata del fiume alla presa (GloFAS + bacino dal DEM) e quota da lasciare al fiume
  // meas: portate misurate dall'ente (pick = -2): medie e magre mensili in m³/s, con la fonte del dato
  type RiverMeas = { mean: number[]; low: number[]; q347?: number; days?: number; years?: string[]; note?: string };
  type RiverSt = { data: api.RiverOut; pick: number; dmv: number; c: number; meas?: RiverMeas | null; corrOff?: boolean };
  const [river, setRiver] = useState<RiverSt | null>(null);
  const [bankSlope, setBankSlope] = useState(2);                     // pendenza della sponda (orizzontale : verticale)
  const [settleMm, setSettleMm] = useState(0.1);                     // particella da sedimentare (mm)
  const [filterCap, setFilterCap] = useState(400);                   // portata di un filtro autopulente (m³/h)
  const [wellQ, setWellQ] = useState(30);                            // portata di un pozzo (l/s)
  const [srcPicking, setSrcPicking] = useState(false);
  const [srcShown, setSrcShown] = useState<string | null>(null);     // schema disegnato sulla mappa
  const [srcOpen, setSrcOpen] = useState(false);                     // parametri aperti
  const [srcDrawing, setSrcDrawing] = useState(false);               // tracciato in disegno
  const [computoOpen, setComputoOpen] = useState(false);
  const [variants, setVariants] = useState<Variant[]>([]);             // varianti salvate del progetto (livelli «variant»)
  const [variantName, setVariantName] = useState("");
  const [variantsOpen, setVariantsOpen] = useState(false);
  const [cableM, setCableM] = useState(50);
  const [costKwh, setCostKwh] = useState(0.22);                      // energia di rete (€/kWh)
  const [costDiesel, setCostDiesel] = useState(1.6);                 // gasolio (€/l)
  const [dieselLkWh, setDieselLkWh] = useState(0.3);                 // consumo del generatore (l/kWh)
  const [genShare, setGenShare] = useState(40);                      // quota di energia dal generatore con FV + generatore (%)
  const [costMaintKw, setCostMaintKw] = useState(15);                // manutenzione pompe e quadri (€/kW installato/anno)
  const [costPvOm, setCostPvOm] = useState(12);                      // gestione e manutenzione FV (€/kWp/anno)
  const [costBattKwh, setCostBattKwh] = useState(300);               // sostituzione batterie (€/kWh)
  const [battLife, setBattLife] = useState(10);                      // vita delle batterie (anni)                          // distanza dal punto di consegna dell'energia alle pompe (m)
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
  const [fieldPicked, setFieldPicked] = useState(false);
  const [srcPicked, setSrcPicked] = useState(false);       // fonte d'acqua / adduttrice cliccata sulla mappa   // campo selezionato con un clic sulla mappa (⌫ lo elimina)
  // gruppi di strade aperti (albero Livelli e pannello Strade): chiusi di default
  const [openRoadGroups, setOpenRoadGroups] = useState<Set<string>>(new Set());
  const toggleRoadGroup = (k: string) => setOpenRoadGroups((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const [openFolders, setOpenFolders] = useState({ campi: true, canali: true, strade: true, invasi: true, pivot: true }); // cartelle del pannello Livelli
  const [pivotSel, setPivotSel] = useState<PivotSel>({ mode: "none", idx: -1 });
  // Livello Strade (linee, con spessore) disegnabile/importabile: i pivot le rispettano.
  const [roads, setRoads] = useState<RoadL[]>([]);
  const [roadSel, setRoadSelState] = useState<string | null>(null);   // strada in modifica
  const roadSelRef = useRef<string | null>(null);
  const setRoadSel = (v: string | null) => { roadSelRef.current = v; setRoadSelState(v); };
  const [roadWidth, setRoadWidth] = useState(8);      // spessore strada di default (m)
  const [canalWidth, setCanalWidth] = useState(6);    // spessore canale/fiume di default (m)

  const [excludeWater, setExcludeWater] = useState(true);  // niente pivot su acqua/paludi (NDWI)
  const [soilKey, setSoilKey] = useState("franco");
  // Infiltrazione di base del suolo (mm/h). Un solo valore per tutta l'app:
  // «infiltrazione» negli impianti e «assorbimento» in irrigazione sono la
  // stessa grandezza, tenerli separati li faceva divergere.
  const [infiltration, setInfiltration] = useState(SOILS[2].inf);
  const infTouched = useRef(false);      // true se l'utente lo ha corretto a mano
  // Suolo dal satellite (SoilGrids) e parametri del programma irriguo
  const [soilSat, setSoilSat] = useState<(api.SoilOut & { n: number }) | null>(null);
  const [rootDepth, setRootDepth] = useState(0.8);      // profondità delle radici (m)
  const [rawP, setRawP] = useState(0.5);                // frazione dell'acqua disponibile consumabile senza stress (FAO-56 p)
  const [v100, setV100] = useState(2.3);                // velocità dell'ultima torre al 100% del timer (m/min)
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
  // ⌫ / Canc elimina l'elemento selezionato (pivot, tubazione, campo cliccato sulla
  // mappa); Esc toglie la selezione. Nei campi di testo i tasti restano al testo.
  const selKeys = useRef<{ del: () => boolean; esc: () => boolean }>({ del: () => false, esc: () => false });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace" && e.key !== "Escape") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const done = e.key === "Escape" ? selKeys.current.esc() : selKeys.current.del();
      if (done) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
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
    histPaused.current = true;            // il caricamento non entra nella cronologia
    suppressAutosaveRef.current = true;   // non salvare durante il caricamento (evita di sovrascrivere il progetto)
    clearAllFields();
    setCanals([]); setRoads([]); setWatercourses([]); setGuided(null); setPivots([]); setPivotLines([]); setHiddenPivotFields(new Set()); setHiddenPipeFields(new Set());
    setVariants([]);
    try {
      const [areasList, layersList] = await Promise.all([api.listAreas(pid), api.listLayers(pid)]);
      setAreas(areasList); setLayers(layersList);
      setVariants(layersList.filter((l) => l.kind === "variant").map((l) => {
        const d = (l.data ?? {}) as Record<string, unknown>;
        return { id: l.id, name: l.name, created: String(d.created ?? ""), metrics: d.metrics as VarMetrics, computo: (d.computo ?? []) as CRow[],
          snapshot: (d.snapshot ?? {}) as Record<string, unknown>, ceres: (d.ceres ?? null) as Record<string, unknown> | null, chosen: !!d.chosen };
      }).filter((v) => v.metrics).sort((a, b) => a.id - b.id));
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
      histBaseline(1200);
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
    setVariants([]);
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
  // fit = inquadra i canali (solo dopo un tracciamento, un'importazione o un caricamento esplicito;
  // non con Annulla, lo spessore o la visibilità, che non devono spostare la vista)
  function renderCanals(list: CanalL[] = canals, fit = false) {
    mapApi.current?.showCanals(list.filter((c) => !c.hidden).map((c) => ({ coords: c.geojson.coordinates, start: c.start, end: c.end, width_m: canalWidth })), t("Presa"), t("Sbocco"), fit);
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
      setSysDesigns((ds) => {
        const out: typeof ds = {};
        for (const [k, d] of Object.entries(ds)) {
          const f = fields.find((x) => sysKey(x) === k);
          const aid = f ? savedMap.get(f.id) : undefined;
          out[aid != null ? `a${aid}` : k] = d;
        }
        return out;
      });
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
      // Le aree si ricreano a ogni salvataggio (id nuovi): i sistemi salvati sui
      // campi (chiave a<id area>) seguono il loro campo.
      setSysDesigns((ds) => {
        const out: typeof ds = {};
        for (const [k, d] of Object.entries(ds)) {
          const f = fields.find((x) => sysKey(x) === k);
          const aid = f ? fieldToArea.get(f.id) : undefined;
          out[aid != null ? `a${aid}` : k] = d;
        }
        return out;
      });
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
      renderCanals(next, true);
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
      renderCanals(next, true);
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
        // il canale appena tracciato resta modificabile (punti e «+» a metà dei tratti)
        const ni = next.length - 1;
        if (ni >= 0 && next[ni].start && next[ni].end) { setEditingCanal(ni); installCanalEditor(ni, next[ni]); }
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
    setMsg(t("Trascina presa, finale o i punti del percorso; trascina un «+» a metà di un tratto (o clicca la linea) per aggiungere un punto. Il canale resta sempre in discesa."));
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
        renderCanals(next, true);
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
  // Una sola fonte per le colture: ogni campo ha la coltura scelta (il Kc del campo
  // uguale a quello della coltura di progetto, o il Kc di partenza mai cambiato,
  // vale la coltura di progetto); il dimensionamento usa la più esigente.
  // chiave stabile del campo: l'id dell'area salvata nel progetto
  const cropFKey = (f: Field) => (f.savedId != null ? String(f.savedId) : `f${f.id}`);
  // colture del campo: le sue, altrimenti (vecchi progetti con il Kc impostato per campo)
  // la coltura di quel Kc, altrimenti quelle dell'azienda
  const cropsOfField = (f: Field): { key: string; label: string; kc: number }[] => {
    const own = fieldCrops[cropFKey(f)];
    if (own?.length) return own.map(cropOf).sort((a, b) => b.kc - a.kc);
    const kc = effSettings(f).kc;
    const farm = farmCrops.map(cropOf).sort((a, b) => b.kc - a.kc);
    if (!kc || farm.some((c) => Math.abs(kc - c.kc) < 1e-6) || Math.abs(kc - DEFAULT_KC) < 1e-6) return farm;
    return [CROP_LIST.find((c) => Math.abs(c.kc - kc) < 1e-6) ?? { key: "altro", label: "Altro", kc }];
  };
  const cropsOf = (fs: Field[]) => {
    const out = [...new Map(fs.flatMap((f) => cropsOfField(f)).map((c) => [c.key, c] as const)).values()];
    if (!out.length) out.push(...farmCrops.map(cropOf));
    return out.sort((a, b) => b.kc - a.kc);
  };
  // Kc medio del campo: le sue colture in rotazione, a quote uguali
  const kcOfField = (f: Field) => { const cs = cropsOfField(f); return cs.reduce((a, c) => a + c.kc, 0) / Math.max(1, cs.length); };
  const designCrops = cropsOf(fields.filter((f) => pivots.some((p) => p.field === f.id)));
  // Kc medio dell'azienda pesato sulla superficie irrigata dai pivot (consumi annui)
  const kcAreaAvg = (() => {
    let a = 0, w = 0;
    for (const p of pivots) { const f = fields.find((x) => x.id === p.field); const ha = pvAreaM2(p); a += (f ? kcOfField(f) : cropOf(cropKey).kc) * ha; w += ha; }
    return w > 0 ? a / w : farmCrops.reduce((x, k) => x + cropOf(k).kc, 0) / Math.max(1, farmCrops.length);
  })();
  const cropMax = designCrops[0];
  const kcMax = cropMax.kc;
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
      phaseColor: nPhases > 1 && phaseColors, ...(pivots[k].solar ? (() => { const sp = solarPolys(pivots[k]), all = sp.flat();
        return { solarPolys: sp, solarTaraR: solarSize(pivots[k]).taraR, solarTag: { lat: all.reduce((a, q) => a + q[0], 0) / all.length, lng: all.reduce((a, q) => a + q[1], 0) / all.length, text: `${fmt(solarSize(pivots[k]).kWp, { maximumFractionDigits: 1 })} kWp` } }; })() : {}) }));
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
        setPipeSel({ mode: "none", idx: -1 }); setFieldPicked(false); setSrcPicked(false);
        setPivotSel((s) => (s.mode === "none" ? { mode: "group", idx: -1 } : { mode: "single", idx: real }));
      },
      onMove: (i, lat, lng) => { const real = visIdx[i]; commitPivots(pivots.map((p, k) => (k === real ? { ...p, lat, lng } : p))); },
      onBackground: () => {
        endRoadEdit();
        setPivotSel({ mode: "none", idx: -1 }); setPipeSel({ mode: "none", idx: -1 }); setFieldPicked(false); setSrcPicked(false);
        if (editPipeRef.current != null) { editPipeRef.current = null; api2.endPipeEdit?.(); setMsg(""); }
      },
      // Clic su una tubazione: la rende modificabile (maniglie sui vertici).
      onLineClick: (li) => {
        const target = pivotLines.indexOf(visL[li]);   // indice reale nel modello
        if (target < 0) return;
        setFieldPicked(false); setSrcPicked(false);
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
        openPipeEditor(target);
      },
    }, pipeSelForShow, waterLinesLL());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pivots, pivotLines, pivotSel, pipeSel, hiddenPivotFields, hiddenPipeFields, canals, watercourses, pivotLabels, mm24, mmDes, hoursDay, imperial, phaseColors, solarCfg, pivotBrand]);

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
  // Elemento selezionato che ⌫ può eliminare (nome per la barretta in alto)
  const delTarget: { name: string; del: () => void } | null =
    roadSel === "__src" ? null
    : roadSel != null ? { name: t("Strada"), del: () => { const id = roadSel; endRoadEdit(); setRoads((rs) => rs.filter((r) => r.id !== id)); setMsg(t("Strada eliminata ✓")); } }
    : pipeSel.mode === "single" ? { name: t("Tubazione"), del: deleteSelectedPipe }
    : pivotSel.mode === "single" && pivots[pivotSel.idx] ? { name: `${t("Pivot")} P${pivotSel.idx + 1}`, del: () => { deleteSelPivot(); setMsg(t("Pivot eliminato ✓")); } }
    : fieldPicked && active ? { name: active.name, del: () => { setFieldPicked(false); removeField(active); } }
    : srcPicked && srcPt ? { name: t("Fonte d'acqua e adduttrice"), del: () => {
        setSrcPicked(false); setSrcPt(null); setSrcRoute(null); setSrcShown(null); setSrcElev(null); setMsg(t("Fonte d'acqua eliminata ✓"));
      } }
    : null;
  const clearSel = () => {
    const any = pivotSel.mode !== "none" || pipeSel.mode !== "none" || fieldPicked || srcPicked || roadSel != null;
    endRoadEdit();
    setPivotSel({ mode: "none", idx: -1 }); setPipeSel({ mode: "none", idx: -1 }); setFieldPicked(false); setSrcPicked(false);
    if (editPipeRef.current != null) { editPipeRef.current = null; mapApi.current?.endPipeEdit?.(); }
    return any;
  };
  selKeys.current = {
    del: () => {
      if (delTarget) { delTarget.del(); return true; }
      if (pivotSel.mode === "group" || pipeSel.mode === "group") { setMsg(t("Clicca ancora l'elemento da eliminare: il primo clic seleziona il gruppo.")); return true; }
      return false;
    },
    esc: () => (drawing ? false : clearSel()),
  };
  function applyRadiusToAll() { commitPivots(pivots.map((p) => ({ ...p, r: pivotR }))); }

  // ---- livello Strade (linee) ----
  const rid = () => `r${roads.length}_${roads.reduce((s, r) => s + r.coords.length, 0)}`;
  useEffect(() => {
    const vis = roads.filter((r) => !r.hidden);
    mapApi.current?.showRoads?.(vis.map((r) => ({ coords: r.coords, width_m: r.width_m, kind: r.kind })), (i) => { const r = vis[i]; if (r) openRoadEditor(r.id, r.coords); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roads]);
  // Aggiorna la banda-spessore dei canali quando cambia lo spessore di default.
  useEffect(() => {
    if (canals.length) renderCanals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canalWidth]);
  // Strada selezionata: maniglie sui vertici e "+" a metà dei tratti; ⌫ la elimina.
  function openRoadEditor(id: string, coords: number[][]) {
    if (editPipeRef.current != null) { editPipeRef.current = null; }
    setPivotSel({ mode: "none", idx: -1 }); setPipeSel({ mode: "none", idx: -1 }); setFieldPicked(false); setSrcPicked(false);
    setRoadSel(id);
    setMsg(t("Strada in modifica: trascina i punti o i «+» a metà dei tratti per aggiungerne; doppio clic su un punto per toglierlo, ⌫ per eliminare la strada."));
    mapApi.current?.editPipe?.(coords, (c) => setRoads((rs) => rs.map((r) => (r.id === id ? { ...r, coords: c } : r))),
      [], [], { pivot: t("Punto"), canal: t("Punto"), free: t("Punto") });
  }
  function endRoadEdit() { if (roadSelRef.current != null) { setRoadSel(null); mapApi.current?.endPipeEdit?.(); } }
  function drawRoad() {
    mapApi.current?.drawRoadManual((coords) => {
      if (coords.length < 2) return;
      const id = rid();
      setRoads((rs) => [...rs, { id, coords, width_m: roadWidth }]);
      setTimeout(() => openRoadEditor(id, coords), 0);   // appena tracciata resta modificabile
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
  function computeHydraulics(apply: boolean, elev?: Map<string, number> | null, quiet = false) {
    const pipes = pivotLines.map((l, i) => ({ l, i })).filter((x) => x.l.kind === "pipe");
    if (!pipes.length) { if (!quiet) setMsg(t("Nessuna tubazione da dimensionare.")); return null; }
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
    // Senza presa sul canale: la rete parte dalla stazione (fonte d'acqua o
    // pozzo) o, in mancanza, dall'inizio della prima tubazione.
    if (!sources.length) {
      const ref = srcRoute && srcRoute.length >= 2 ? srcRoute[srcRoute.length - 1] : srcPt ?? pipes[0].l.coords[0];
      let bk = "", bd = Infinity;
      for (const [k, q] of posOf) { const d = Math.hypot((q[0] - ref[0]) * mLng, (q[1] - ref[1]) * mLat); if (d < bd) { bd = d; bk = k; } }
      if (bk) sources.push(bk);
    }
    if (!sources.length) { if (!quiet) setMsg(t("Nessuna presa sul canale: collega almeno una tubazione all'acqua.")); return null; }
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
    const lens = (i: number) => pivotLines[i].coords.map((q, k, a) => (k ? Math.hypot((q[0] - a[k - 1][0]) * mLng, (q[1] - a[k - 1][1]) * mLat) : 0)).slice(1);
    return { byDn: [...byDn.entries()].sort((a, b) => a[0] - b[0]), totalQ, hlMax, unserved, isolated, nSources: sources.length,
      headMax, withElev: !!elev,
      // per tubazione: [indice, diametri dei tratti, lunghezze dei tratti] (sfiati, scarichi, non ritorno)
      lines: [...dnOf.entries()].map(([i, dns]) => [i, dns.map((d) => d ?? 0), lens(i), (qsOf.get(i) ?? []).map((q) => q ?? 0)] as [number, number[], number[], number[]]) };
  }
  type HydraRes = { byDn: [number, number][]; totalQ: number; hlMax: number; unserved: number; isolated: number; nSources: number; headMax: number; withElev: boolean;
    lines?: [number, number[], number[], number[]?][] };
  const [hydra, setHydra] = useState<null | HydraRes>(null);
  // Diametri della rete: quelli calcolati, oppure si calcolano al momento
  // dell'esportazione (computo, .ceres, varianti) senza passare dalla pagina.
  const hydraOverride = useRef<HydraRes | null>(null);
  // l'override vale finché lo stato non riceve un calcolo diverso (pagina Tubazioni, variante caricata)
  useEffect(() => { if (hydra !== hydraOverride.current) hydraOverride.current = null; }, [hydra]);
  const hydraNow = (): HydraRes | null => hydraOverride.current ?? hydra;
  function ensureHydra(): HydraRes | null {
    const h0 = hydraNow(); if (h0) return h0;
    if (!pivotLines.some((l) => l.kind === "pipe")) return null;
    const h = computeHydraulics(true, null, true);
    if (h) { hydraOverride.current = h; setHydra(h); }
    return h;
  }
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
      // la tubazione appena tracciata resta in modifica: si possono spostare i punti e aggiungerne in mezzo
      const vis = next.filter((l) => !(l.kind === "pipe" && l.field != null && hiddenPipeFields.has(l.field)));
      setPipeSel({ mode: "single", idx: vis.indexOf(next[next.length - 1]) });
      setTimeout(() => openPipeEditor(next.length - 1, coords), 0);
      setMsg(t("Tubazione aggiunta ✓") + " " + t("Trascina i punti o i «+» a metà dei tratti per aggiungerne; doppio clic su un punto per toglierlo."));
    }, pivots.map((pv) => [pv.lng, pv.lat]),
    [...canals.filter((c) => !c.hidden).map((c) => c.geojson.coordinates as number[][]),
     ...watercourses.filter((w) => !w.hidden && w.geojson?.type === "LineString")
       .map((w) => w.geojson.coordinates as unknown as number[][]),
     // per un RAMO anche le tubazioni esistenti sono bersaglio di aggancio:
     // lo stacco cade esattamente sulla linea da cui deriva
     ...(mode === "branch" ? pivotLines.filter((l) => l.kind === "pipe").map((l) => l.coords) : [])]);
  }
  // Editor del tracciato di UNA tubazione (maniglie sui vertici, "+" a metà dei tratti per aggiungere punti).
  function openPipeEditor(target: number, coordsStart?: number[][]) {
    editPipeRef.current = target;
    setMsg(t("Trascina i punti: si agganciano ai centri dei pivot e al canale. Trascina un «+» a metà di un tratto (o clicca la linea) per aggiungere un punto; doppio clic (o tasto destro) su un punto per eliminarlo."));
    const openEditor = (coords0: number[][]) => {
      mapApi.current?.editPipe?.(coords0, (coords) => {
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
    openEditor(coordsStart ?? pivotLines[target].coords);
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
  // Fiume alla presa, mese per mese: portata media e di magra (GloFAS o bacino), quota lasciata al
  // fiume, prelevabile, fabbisogno lordo dei mesi e bilancio (ore di prelievo, vasca di compenso).
  const MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  function riverCalc(rv: RiverSt | null = river) {
    if (!rv) return null;
    const cell = rv.pick >= 0 ? rv.data.glofas.cells[rv.pick] : null, b = rv.data.basin;
    let mean: number, mMean: number[], mLow: number[], src: string, corr: api.RiverCorr | null = null, q347 = cell?.q347 ?? 0, qMin0 = cell?.min ?? 0;
    if (rv.pick === -2 && rv.meas && rv.meas.mean.length === 12) {
      mMean = rv.meas.mean; mLow = rv.meas.low.length === 12 ? rv.meas.low : rv.meas.mean.map((x) => x * 0.5);
      mean = mMean.reduce((a, x, i) => a + x * MDAYS[i], 0) / 365; src = "meas";
    } else if (cell) {
      mean = cell.mean; mMean = cell.month_mean; mLow = cell.month_q80; src = "glofas";
      // stazione misurata sullo stesso fiume: vale per le celle di portata simile a quella su cui è stata tarata
      const c = rv.data.corr;
      if (c && !rv.corrOff && c.f_month?.length === 12 && Math.abs(Math.log(cell.mean / c.ref_mean)) < Math.log(3)) {
        corr = c; src = "corr";
        mMean = cell.month_mean.map((q, i) => q * c.f_month[i]); mLow = cell.month_q80.map((q, i) => q * c.f_month[i]);
        mean = mMean.reduce((a, x, i) => a + x * MDAYS[i], 0) / 365; q347 = cell.q347 * c.f_year; qMin0 = cell.min * c.f_year;
      }
    }
    else if (b?.area_km2 && b.rain_month_mm?.length === 12) {
      mMean = b.rain_month_mm.map((r, i) => (b.area_km2! * 1e6 * (r / 1000) * rv.c) / (MDAYS[i] * 86400));
      mean = mMean.reduce((a, x, i) => a + x * MDAYS[i], 0) / 365; mLow = mMean.map((x) => x * 0.5); src = "basin";
    } else return null;
    const dmv = (mean * Math.max(0, rv.dmv)) / 100;                    // m³/s lasciati al fiume
    const avail = mLow.map((q) => Math.max(0, (q - dmv) * 1000));     // l/s prelevabili
    const P = pumpStation(), eff = Math.max(0.3, effPct / 100);
    const needM3 = P.netMm ? P.netMm.map((mm, i) => Math.min(mm / eff, mmDes * MDAYS[i]) * 10 * P.irrHa) : MDAYS.map((d) => mmDes * d * 10 * P.irrHa);
    const bal = riverBalance(avail, needM3, srcHours);
    const irr = needM3.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
    const qMin = irr.length ? Math.min(...irr.map((i) => avail[i])) : Math.min(...avail);
    return { src, cell, corr, q347, qMin0, mean, mMean, mLow, dmv, avail, needM3, bal, qMin: Math.floor(qMin), irr };
  }
  // Fiume come fonte: la portata si stima da sola appena c'è il punto di presa (e di nuovo se la presa si sposta di oltre 300 m)
  const riverAuto = useRef("");
  useEffect(() => {
    if (srcType !== "fiume" || !srcPt || projLoaded.current !== projectId || busy === "river") return;
    const d = river?.data;
    if (d && distM([d.lon, d.lat], srcPt) < 300) return;
    const key = `${projectId}|${srcPt[0].toFixed(4)}|${srcPt[1].toFixed(4)}`;
    if (riverAuto.current === key) return;                      // un tentativo per punto (niente ripetizioni su errore)
    const h = window.setTimeout(() => { riverAuto.current = key; void estimateRiver(); }, 900);
    return () => window.clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcType, srcPt, projectId, river]);
  // Portate misurate: CSV giornaliero (data;valore) → medie e magre mensili come GloFAS; oppure 12 valori
  // mensili (uno per mese, gennaio→dicembre), opzionalmente seguiti da 12 valori di magra. Unità m³/s (o l/s se indicato).
  function parseRiverMeas(text: string, unitLs: boolean): RiverMeas | null {
    const k = unitLs ? 0.001 : 1, lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const daily: { m: number; y: string; v: number }[] = [];
    for (const l of lines) {
      const mm = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[\s;,\t]+(-?[\d.,]+)/.exec(l) ?? /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})[\s;,\t]+(-?[\d.,]+)/.exec(l);
      if (!mm) continue;
      const iso = mm[1].length === 4, y = iso ? mm[1] : mm[3], m = Number(iso ? mm[2] : mm[2]) - 1, v = Number(mm[4].replace(",", ".")) * k;
      if (m >= 0 && m < 12 && Number.isFinite(v) && v >= 0) daily.push({ m, y, v });
    }
    if (daily.length >= 60) {
      const pct = (a: number[], p: number) => { const s2 = [...a].sort((x, y2) => x - y2); return s2.length ? s2[Math.min(s2.length - 1, Math.floor((p / 100) * (s2.length - 1)))] : 0; };
      const by = MDAYS.map((_, i) => daily.filter((d) => d.m === i).map((d) => d.v));
      if (by.some((a) => !a.length)) return null;
      const ys = [...new Set(daily.map((d) => d.y))].sort();
      return { mean: by.map((a) => a.reduce((s2, x) => s2 + x, 0) / a.length), low: by.map((a) => pct(a, 20)), q347: pct(daily.map((d) => d.v), 5), days: daily.length, years: [ys[0], ys[ys.length - 1]] };
    }
    const nums = text.replace(/(\d),(\d)/g, "$1.$2").split(/[\s;\t\n]+/).map(Number).filter((x) => Number.isFinite(x) && x >= 0).map((x) => x * k);
    if (nums.length >= 24) return { mean: nums.slice(0, 12), low: nums.slice(12, 24) };
    if (nums.length >= 12) return { mean: nums.slice(0, 12), low: [] };
    return null;
  }
  const [measText, setMeasText] = useState("");
  const [measLs, setMeasLs] = useState(false);
  function applyRiverMeas(text: string, note?: string) {
    const m = parseRiverMeas(text, measLs);
    if (!m) { setMsg(t("Portate non riconosciute: servono 12 valori mensili (gennaio→dicembre) o un CSV giornaliero data;valore.")); return; }
    setRiver((r) => (r ? { ...r, pick: -2, meas: { ...m, note } } : { data: { lat: srcPt?.[1] ?? 0, lon: srcPt?.[0] ?? 0, glofas: { cells: [], pick: -1 } }, pick: -2, dmv: 10, c: 0.2, meas: { ...m, note } }));
    setMsg(t("Portate misurate applicate ✓"));
  }
  async function estimateRiver() {
    if (!srcPt) return;
    setBusy("river");
    try {
      const d = await api.riverFlow(srcPt[1], srcPt[0]);
      let pick = d.glofas.pick;
      // con un bacino misurato (non troncato) si propone la cella GloFAS più coerente con le piogge del bacino
      const b = d.basin;
      // (solo con un bacino vero: sotto 20 km² lo sbocco è un fosso vicino alla presa, non il fiume)
      if (b?.area_km2 && b.area_km2 >= 20 && !b.truncated && b.rain_month_mm?.length === 12 && d.glofas.cells.length) {
        const qb = b.rain_month_mm.reduce((a, r) => a + r, 0) / 1000 * b.area_km2 * 1e6 * 0.2 / (365 * 86400);
        // un grande fiume sulla presa (≥ 50 m³/s, mille volte quello che il bacino locale può dare)
        // ha un bacino che il DEM non contiene: resta la cella GloFAS proposta
        const big = pick >= 0 && d.glofas.cells[pick].mean >= 50 && d.glofas.cells[pick].mean > 1000 * qb;
        if (qb > 0 && !big) pick = d.glofas.cells.map((c, i) => ({ i, e: Math.abs(Math.log(c.mean / qb)) })).sort((x, y) => x.e - y.e)[0].i;
      }
      if (!d.glofas.cells.length) pick = -1;
      setRiver({ data: d, pick, dmv: river?.dmv ?? 10, c: river?.c ?? 0.2 });
      setMsg(d.glofas.cells.length || d.basin?.area_km2 ? t("Portata del fiume stimata ✓") : t("Nessun dato di portata per questo punto."));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function renderRiver() {
    const R = riverCalc(), d = river?.data, b = d?.basin;
    const mon = (i: number) => new Date(2000, i, 1).toLocaleString(lang, { month: "short" });
    const f1 = (x: number) => fmt(x, { maximumFractionDigits: x < 10 ? 2 : x < 100 ? 1 : 0 });
    return (
      <div className="border-t border-black/5 pt-2 space-y-1.5" data-river>
        <button className="btn-ghost w-full text-[12px]" disabled={busy === "river"} onClick={estimateRiver}
          title={t("Bacino che drena fino alla presa (dal DEM) e serie storica giornaliera delle portate GloFAS (Copernicus) delle celle vicine: media, magra mese per mese e quota da lasciare al fiume.")}>
          {busy === "river" ? t("Calcolo il bacino e leggo le portate…") : river ? t("🌊 Ricalcola la portata del fiume") : t("🌊 Stima la portata del fiume alla presa")}</button>
        {river && d && (<>
          <div className="text-[11px] text-sage-dark leading-snug">
            {b?.area_km2 ? <>{t("Bacino a monte della presa")}: <b>{b.truncated ? "≥ " : ""}{fmt(b.area_km2, { maximumFractionDigits: b.area_km2 < 100 ? 1 : 0 })} km²</b>{b.z_max != null && <> · {t("quota massima")} {fmt(Math.round(b.z_max))} m</>}{b.truncated && <> · <span className="text-rust">{t("bacino più grande della finestra del DEM: vale la serie GloFAS")}</span></>}</> : <span className="text-rust">{t("Bacino non calcolato")}{b?.error ? `: ${b.error}` : ""}</span>}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="text-[11px] text-sage-dark col-span-3">{t("Serie di portata")}
              <select className="field-input mt-0.5 py-1 text-[12px]" value={river.pick} onChange={(e) => setRiver({ ...river, pick: Number(e.target.value) })}>
                {d.glofas.cells.map((c, i) => <option key={i} value={i}>GloFAS · {t("cella a {d} km", { d: fmt(c.dist_km, { maximumFractionDigits: 1 }) })} · {t("media")} {f1(c.mean)} m³/s</option>)}
                {b?.area_km2 && b.rain_month_mm && <option value={-1}>{t("Metodo del bacino (piogge × coefficiente di deflusso)")}</option>}
                <option value={-2}>{river.meas ? t("Portate misurate dall'ente") + (river.meas.years ? ` · ${river.meas.years.join("–")}` : "") : t("Portate misurate dall'ente (da inserire)")}</option>
              </select></label>
            {d.corr && river.pick >= 0 && (
              <div className="col-span-3 text-[11px] leading-snug rounded border border-black/10 p-1.5" data-river-corr>
                <label className="flex items-start gap-1.5">
                  <input type="checkbox" className="mt-0.5" checked={!river.corrOff} onChange={(e) => setRiver({ ...river, corrOff: !e.target.checked })} />
                  <span>{t("Corretta con la stazione misurata {s} ({r}, {d} km): osservati {o} m³/s contro {g} m³/s di GloFAS, fattore {f}", { s: d.corr.station.name, r: d.corr.station.river, d: fmt(Math.round(d.corr.station.dist_km)), o: f1(d.corr.obs_mean), g: f1(d.corr.sim_mean), f: fmt(d.corr.f_year, { maximumFractionDigits: 2 }) })}
                    <span className="block text-[10px] text-sage-dark">{d.corr.station.source} · {d.corr.station.years.join("–")}</span></span>
                </label>
              </div>
            )}
            {river.pick === -2 && (
              <div className="col-span-3 space-y-1" data-river-meas>
                <textarea className="field-input w-full text-[11px] font-mono" rows={3} value={measText} onChange={(e) => setMeasText(e.target.value)}
                  placeholder={t("12 portate medie mensili (gen→dic), eventualmente seguite da 12 portate di magra; oppure un CSV giornaliero «data;portata»")} />
                <div className="flex items-center gap-2 text-[11px] text-sage-dark">
                  <label className="flex items-center gap-1"><input type="checkbox" checked={measLs} onChange={(e) => setMeasLs(e.target.checked)} />{t("valori in l/s")}</label>
                  <button className="btn-ghost text-[11px] py-0.5 ml-auto" disabled={!measText.trim()} onClick={() => applyRiverMeas(measText)}>{t("Applica")}</button>
                  <label className="btn-ghost text-[11px] py-0.5 cursor-pointer">{t("Importa CSV")}
                    <input type="file" accept=".csv,.txt" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const tx2 = await f.text(); setMeasText(tx2.slice(0, 200000)); applyRiverMeas(tx2, f.name); } e.target.value = ""; }} /></label>
                </div>
                {river.meas && <p className="text-[10px] text-sage-dark">{t("In uso: {n}", { n: river.meas.days ? t("{d} giorni misurati ({y})", { d: fmt(river.meas.days), y: (river.meas.years ?? []).join("–") }) : t("12 medie mensili inserite") })}{river.meas.note ? ` · ${river.meas.note}` : ""}</p>}
              </div>
            )}
            <label className="text-[11px] text-sage-dark" title={t("Deflusso minimo da lasciare in alveo, in percentuale della portata media (es. 10%): va verificato con l'ente che rilascia la concessione.")}>{t("Da lasciare al fiume (%)")}
              <input type="number" min={0} max={100} step={1} value={river.dmv} onChange={(e) => setRiver({ ...river, dmv: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} className="field-input mt-0.5 py-1 text-sm" /></label>
            {river.pick < 0 && <label className="text-[11px] text-sage-dark" title={t("Quota della pioggia che arriva al fiume: 0,1 terreni permeabili e clima arido, 0,3–0,5 bacini montani e argillosi.")}>{t("Coeff. di deflusso")}
              <input type="number" min={0.02} max={0.9} step={0.05} value={river.c} onChange={(e) => setRiver({ ...river, c: Math.max(0.02, Math.min(0.9, Number(e.target.value) || 0.2)) })} className="field-input mt-0.5 py-1 text-sm" /></label>}
          </div>
          {R && (<>
            <div className="text-[11px] text-sage-dark leading-snug">
              {t("Portata media")} <b>{f1(R.mean)} m³/s</b>{R.cell && <> · Q347 {f1(R.q347)} m³/s · {t("minima")} {f1(R.qMin0)} m³/s · {R.cell.years.join("–")}</>} · {t("lasciati al fiume")} {f1(R.dmv)} m³/s
            </div>
            {(() => {
              // grafico: portata media del mese (barra), magra (barra scura) e quota prelevabile; linea = portata che serve all'impianto
              // scala in radice quadrata: la magra e la portata che serve restano leggibili accanto alle piene
              const need = R.bal.rows.map((r) => r.qNeed24 / 1000), mx = Math.sqrt(Math.max(...R.mMean, ...need, 1e-6)), sc = (q: number) => Math.sqrt(Math.max(0, q)) / mx;
              const H = 78, w = 100 / 12, iMin = R.mMean.indexOf(Math.min(...R.mMean));
              const share = R.qMin > 0 && Math.max(...need) > 0 ? (R.qMin / 1000) / Math.max(...need) : null;
              return (
                <div data-river-chart>
                  <div className="text-[11px] text-brand-darker leading-snug">
                    {t("Portata media mese per mese")}: {t("da {a} m³/s ({ma}) a {b} m³/s ({mb})", { a: f1(Math.min(...R.mMean)), ma: mon(iMin), b: f1(Math.max(...R.mMean)), mb: mon(R.mMean.indexOf(Math.max(...R.mMean))) })}
                    {share != null && <> · {t("nel mese irriguo più scarso il fiume dà il {p}% della portata di punta dell'impianto", { p: fmt(Math.min(999, Math.round(share * 100))) })}</>}
                  </div>
                  <svg viewBox={`0 0 100 ${H + 2}`} className="w-full mt-1" preserveAspectRatio="none" style={{ height: 90 }}>
                    {R.mMean.map((q, i) => {
                      const hM = sc(q) * H, hL = sc(R.mLow[i]) * H, hA = sc(R.avail[i] / 1000) * H;
                      return (<g key={i}>
                        <rect x={i * w + 1} y={H - hM} width={w - 2} height={hM} fill="#9fd3ee"><title>{`${mon(i)}: ${t("media")} ${f1(q)} m³/s · ${t("magra")} ${f1(R.mLow[i])} m³/s · ${t("prelevabile")} ${fmt(Math.round(R.avail[i]))} l/s`}</title></rect>
                        <rect x={i * w + 1} y={H - hL} width={w - 2} height={hL} fill="#2e86ab" />
                        <rect x={i * w + 2.5} y={H - hA} width={w - 5} height={Math.max(0, hA)} fill="#0b6b3a" opacity={0.85} />
                      </g>);
                    })}
                    {need.map((q, i) => (q > 0 ? <line key={i} x1={i * w + 0.5} x2={(i + 1) * w - 0.5} y1={H - sc(q) * H} y2={H - sc(q) * H} stroke="#d64b34" strokeWidth={1.6} vectorEffect="non-scaling-stroke" /> : null))}
                  </svg>
                  <div className="flex text-[9px] leading-none text-sage-dark mt-0.5">{R.mMean.map((_, i) => <div key={i} className="flex-1 text-center">{mon(i).slice(0, 3)}</div>)}</div>
                  <div className="flex flex-wrap gap-x-3 text-[10px] text-sage-dark">
                    <span><i className="inline-block w-2.5 h-2.5 align-middle mr-1" style={{ background: "#9fd3ee" }} />{t("media")}</span>
                    <span><i className="inline-block w-2.5 h-2.5 align-middle mr-1" style={{ background: "#2e86ab" }} />{t("magra")}</span>
                    <span><i className="inline-block w-2.5 h-2.5 align-middle mr-1" style={{ background: "#0b6b3a" }} />{t("prelevabile")}</span>
                    <span><i className="inline-block w-3 h-0.5 align-middle mr-1" style={{ background: "#d64b34" }} />{t("serve all'impianto")}</span>
                    <span className="opacity-70">{t("scala in radice quadrata")}</span>
                  </div>
                </div>
              );
            })()}
            <div className="overflow-x-auto">
              <table className="w-full text-[10px] tabular-nums" data-river-table>
                <thead><tr className="text-sage-dark"><th className="text-left font-normal"></th>{R.avail.map((_, i) => <th key={i} className="font-normal">{mon(i)}</th>)}</tr></thead>
                <tbody>
                  <tr><td className="text-sage-dark pr-1">{t("media")} m³/s</td>{R.mMean.map((q, i) => <td key={i} className="text-center">{f1(q)}</td>)}</tr>
                  <tr><td className="text-sage-dark pr-1">{t("magra")} m³/s</td>{R.mLow.map((q, i) => <td key={i} className="text-center">{f1(q)}</td>)}</tr>
                  <tr><td className="text-sage-dark pr-1">{t("prelevabile")} l/s</td>{R.avail.map((q, i) => <td key={i} className="text-center font-semibold text-brand-darker">{fmt(Math.round(q))}</td>)}</tr>
                  <tr><td className="text-sage-dark pr-1">{t("serve")} l/s</td>{R.bal.rows.map((r, i) => <td key={i} className="text-center">{r.qNeed24 > 0 ? fmt(Math.round(r.qNeed24)) : "—"}</td>)}</tr>
                  <tr><td className="text-sage-dark pr-1">{t("ore di prelievo")}</td>{R.bal.rows.map((r, i) => <td key={i} className={"text-center " + (r.hours > srcHours ? "text-danger font-semibold" : "")}>{r.needM3 > 0 ? (Number.isFinite(r.hours) ? fmt(Math.ceil(r.hours)) : "∞") : "—"}</td>)}</tr>
                </tbody>
              </table>
            </div>
            <div className="text-[11px] leading-snug">
              {R.bal.deficitM3 <= 1
                ? <span className="text-brand-darker">{t("Il fiume basta in tutti i mesi irrigui con {h} h di prelievo al giorno.", { h: fmt(srcHours) })}</span>
                : R.bal.feasible
                  ? <span className="text-rust">{t("Nei mesi segnati il fiume non basta: servono {v} m³ di vasca di compenso, riempita con l'acqua dei mesi in avanzo (deficit {d} m³).", { v: fmt(Math.ceil(R.bal.storeM3 / 100) * 100), d: fmt(Math.round(R.bal.deficitM3)) })}</span>
                  : <span className="text-danger">{t("Il fiume non basta nemmeno sull'anno: mancano {d} m³. Serve un'altra fonte o meno superficie irrigata.", { d: fmt(Math.round(R.bal.deficitM3 - R.bal.rows.reduce((a, r) => a + r.surplus, 0))) })}</span>}
            </div>
            <button className="btn-ghost w-full text-[12px]" disabled={R.qMin <= 0 || srcQmax === R.qMin} onClick={() => setSrcQmax(R.qMin)}
              title={t("Imposta come portata disponibile il prelevabile del mese irriguo più scarso.")}>{t("Usa {q} l/s come portata disponibile", { q: fmt(R.qMin) })}</button>
            <p className="text-[10px] text-sage-dark leading-snug text-justify">{R.src === "meas" ? t("Portate misurate dall'ente: sostituiscono la stima GloFAS nel bilancio del fiume.") : R.src === "corr"
              ? t("Serie GloFAS della presa riportata, mese per mese, alle portate osservate della stazione: l'andamento dei mesi è quello del modello, i volumi quelli misurati.") : R.src === "glofas"
              ? t("Rianalisi GloFAS a ~5 km: sui fiumi grandi è affidabile, sui torrenti e vicino a dighe o derivazioni va confrontata con le misure dell'ente gestore. «Magra» = portata superata l'80% dei giorni del mese.")
              : t("Stima di larga massima dalle piogge medie del bacino: la magra è posta a metà della media mensile. Da confrontare con misure di portata.")}</p>
          </>)}
        </>)}
      </div>
    );
  }
  // Uniformità di distribuzione del pivot (sprinkler chart generato come Nereus pag. 18)
  const PIPE_DE = [273, 219.1, 168.3];
  function pivotCU(pv: PivotItem): CuResult | null {
    const c = spanComposition({ r: pv.r, gun: pv.gun, q: pv.q, deg: pv.deg }, pivotBrand);
    const q = pivotFlow(pv) * 3.6, gun = Math.max(0, pv.gun ?? 0), pP = pivotPressure(pv);
    const qSpk = q * (gun > 0 ? (pv.r * pv.r) / ((pv.r + gun) * (pv.r + gun)) : 1);
    const spans = c ? c.spans.map((sp) => ({ len: sp.len, deMm: PIPE_DE[sp.pipe] ?? 168.3 })) : Array.from({ length: Math.max(1, Math.round(pv.r / 50)) }, () => ({ len: pv.r / Math.max(1, Math.round(pv.r / 50)), deMm: 168.3 }));
    const key = `${cuModel}|${spans.map((s) => s.len.toFixed(1) + ":" + s.deMm).join(",")}|${(c?.oh ?? 0).toFixed(1)}|${qSpk.toFixed(1)}|${pP.toFixed(2)}`;
    if (cuMemo.current.has(key)) return cuMemo.current.get(key)!;
    const r = pivotUniformity({ spans, overhang: c?.oh ?? 0, qSpkM3h: qSpk, pPivotBar: Math.max(1.5, pP), model: cuModel });
    if (cuMemo.current.size > 300) cuMemo.current.clear();
    cuMemo.current.set(key, r);
    return r;
  }
  // Pivot solare mese per mese: produzione FV con l'irraggiamento del sito, ore di marcia che servono
  // per dare il fabbisogno del mese, ore in cui il sole regge da solo il motore, batteria necessaria.
  function pivotSolarMonths(pv: PivotItem) {
    const cl = projSettings().site_climate?.data; if (!cl?.rs || cl.rs.length !== 12) return null;
    const z = solarSize(pv), P = pumpStation(), eff = Math.max(0.3, effPct / 100);
    const hoursNeed = MDAYS.map((d, i) => (P.netMm ? Math.min(hoursDay, ((P.netMm[i] / eff / d) / Math.max(0.1, mmDes)) * hoursDay) : hoursDay));
    const rows = solarMonths({ lat: pv.lat, rsMJ: cl.rs, kWp: z.kWp, kW: z.kW, hoursNeed, battKwh: z.batt });
    const need = rows.filter((r) => r.hNeed > 0.05);
    return { rows, z, okAll: need.every((r) => r.ok), battMax: Math.ceil(Math.max(0, ...need.map((r) => r.battNeed))), dayOnly: need.filter((r) => r.hNeed <= r.hSun + 1e-6).map((r) => r.m) };
  }
  // ---- SUOLO DAL SATELLITE ------------------------------------------------------
  async function readSoil() {
    const pts = (fields.length ? fields : []).slice(0, 6).map((f) => { const r = f.geom.coordinates[0]; return [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length]; });
    if (!pts.length && srcPt) pts.push(srcPt);
    if (!pts.length) return needField();
    setBusy("soil");
    try {
      const res: api.SoilOut[] = [];
      for (const [lon, lat] of pts) { try { res.push(await api.siteSoil(lat, lon)); } catch (e) { if (!res.length && pts.length === 1) throw e; } }
      if (!res.length) throw new Error(t("SoilGrids non ha dati per questi campi."));
      const avg = (k: "sand" | "silt" | "clay" | "soc_gkg" | "taw_mm_m" | "inf_mmh" | "fc" | "wp") => res.reduce((a, r) => a + r[k], 0) / res.length;
      const cnt = new Map<string, number>(); res.forEach((r) => cnt.set(r.key, (cnt.get(r.key) ?? 0) + 1));
      const key = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0], usda = res.find((r) => r.key === key)!.usda;
      const out = { ...res[0], sand: avg("sand"), silt: avg("silt"), clay: avg("clay"), soc_gkg: avg("soc_gkg"), taw_mm_m: Math.round(avg("taw_mm_m")), inf_mmh: Math.round(avg("inf_mmh") * 10) / 10, fc: avg("fc"), wp: avg("wp"), key, usda, n: res.length };
      setSoilSat(out); setSoilKey(key);
      if (!infTouched.current) setInfiltration(out.inf_mmh);
      setMsg(t("Suolo letto da SoilGrids ✓"));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  // ---- VERIFICA DEL RUSCELLAMENTO PER PIVOT (irrigatori reali) ----------------
  // Larghezza bagnata in punta = diametro bagnato dell'ultimo irrigatore dello sprinkler chart;
  // a parità di portata dose e tempo di bagnatura sono proporzionali alla durata del giro.
  function pivotRunoff(pv: PivotItem) {
    const u = pivotCU(pv); if (!u || !u.spk.length) return null;
    const last = u.spk[u.spk.length - 1], W = 2 * last.R, r = pv.r;
    const dose = depthPass(), Th = turnHours(), tw = (W * Th) / (2 * Math.PI * r);
    const runoff = Math.max(0, dose - (infiltration * tw + surfStore));
    let need = 0;
    for (let n = 1; n <= 24; n++) { const d = mm24 / n, th = Math.max(0.05, hoursDay / n), t2 = (W * th) / (2 * Math.PI * r); if (d <= infiltration * t2 + surfStore) { need = n; break; } }
    const k = mmDes / hoursDay - (infiltration * W) / (2 * Math.PI * r);            // mm/h netti a giro lento
    const dMax = k > 0 ? (mmDes * (surfStore / k)) / hoursDay : Infinity;            // dose massima senza ruscellamento
    return { u, W, tw, dose, runoff, need, peak: u.peak, dMax };
  }
  // ---- PROGRAMMA IRRIGUO MENSILE ------------------------------------------------
  // Mese per mese per il pivot più grande: fabbisogno lordo al giorno, ore di marcia, dose per giro
  // (la minore fra acqua facilmente disponibile, dose senza ruscellamento e fabbisogno di 7 giorni,
  // non sotto la dose al 100% del timer), durata del giro, timer, giri a settimana e intervallo.
  function irrigProgram() {
    if (!pivots.length) return null;
    const pv = pivots.reduce((a, p) => (p.r > a.r ? p : a), pivots[0]);
    const P = pumpStation(), eff = Math.max(0.3, effPct / 100);
    const taw = soilSat?.taw_mm_m ?? ({ sabbioso: 60, franco_sabbioso: 110, franco: 160, franco_limoso: 190, franco_argilloso: 170, argilloso: 160 } as Record<string, number>)[soilKey] ?? 140;
    const RAW = taw * rootDepth * rawP;
    const ro = pivotRunoff(pv), dRun = ro ? ro.dMax : Infinity;
    const T100 = (2 * Math.PI * pv.r) / Math.max(0.1, v100 * 60);                       // ore per giro al 100%
    const dMin = (mmDes * T100) / hoursDay;                                             // dose al 100% del timer
    const rows = MDAYS.map((d, i) => {
      const G = P.netMm ? Math.min(mmDes, P.netMm[i] / eff / d) : mmDes;               // mm/giorno lordi
      if (G < 0.05) return { m: i, G: 0, h: 0, D: 0, T: 0, timer: 0, perWeek: 0, every: 0 };
      const h = Math.min(24, (G / mmDes) * hoursDay);
      const D = Math.max(dMin, Math.min(RAW, dRun, G * 7));
      const T = (D * hoursDay) / mmDes, timer = Math.min(100, (100 * T100) / T);
      return { m: i, G, h, D, T, timer, perWeek: (7 * G) / D, every: D / G };
    });
    const qPv = pivots.reduce((a, p) => a + pivotFlow(p), 0), simul = srcQmax > 0 ? Math.max(1, Math.floor(srcQmax / Math.max(1, pivotFlow(pv)))) : pivots.length;
    return { pv, taw, RAW, dRun, dMin, T100, rows, simul: Math.min(simul, pivots.length), qPv };
  }
  // Fossi di scolo: uno per campo, lungo tutto il perimetro, dimensionato sulla portata di drenaggio
  // del campo (Q = C·A·10/86,4 l/s) con Manning, terra inerbita, scarpe 1:1,5 come Nereus pag. 17.
  function drainCalcs() {
    if (!drainOn) return [];
    const used = new Set<number>(pivots.map((p) => p.field).filter((x): x is number => x != null));
    const fs = fields.filter((f) => !used.size || used.has(f.id));
    return fs.map((f, i) => {
      const ring = f.geom.coordinates[0], ha = ringAreaHa(f.geom.coordinates);
      const L = ring.reduce((a, p, k) => a + (k ? distM(ring[k - 1], p) : 0), 0);
      const q = (drainC * ha * 10) / 86.4;
      const base = { f, n: i + 1, ha, L, q, ring };
      const pr = drainProf[String(f.id)];
      // con le quote: sbocco nel punto più basso, spartiacque nel più alto, due rami lungo il perimetro;
      // ogni ramo in 3 tratti, sezione per la portata a valle del tratto e pendenza dal terreno (minimo quella impostata)
      if (pr && pr.z.filter((z) => z != null).length >= 6) {
        const n = pr.pts.length, z = pr.z.map((v, k) => v ?? pr.z.slice(0, k).reverse().find((x) => x != null) ?? pr.z.find((x) => x != null) ?? 0) as number[];
        const iOut = z.indexOf(Math.min(...z)), iTop = z.indexOf(Math.max(...z));
        const seg = (k: number) => distM(pr.pts[k], pr.pts[(k + 1) % n]);
        const walk = (dir: 1 | -1) => { const idx: number[] = [iTop]; let k = iTop; while (k !== iOut) { k = (k + dir + n) % n; idx.push(k); } return idx; };
        const reaches: { L: number; q: number; S: number; sec: CanalSection | null; cut: number; z0: number; z1: number }[] = [];
        const qPerM = q / Math.max(1, L);
        for (const dir of [1, -1] as const) {
          const idx = walk(dir); let acc = 0; const cum = [0];
          for (let k = 1; k < idx.length; k++) { acc += dir === 1 ? seg(idx[k - 1]) : seg(idx[k]); cum.push(acc); }
          const Lb = acc; if (Lb < 1) continue;
          for (let r = 0; r < 3; r++) {
            const a = (r * Lb) / 3, b2 = ((r + 1) * Lb) / 3, ia = cum.findIndex((c) => c >= a), ib = cum.findIndex((c) => c >= b2 - 1e-6);
            const z0 = z[idx[Math.max(0, ia)]], z1 = z[idx[ib < 0 ? idx.length - 1 : ib]], Lr = b2 - a;
            const S = Math.max(drainS, ((z0 - z1) / Math.max(1, Lr)) * 1000);
            const sec = designCanal(qPerM * b2, S, "grass", { b: drainB, m: 1.5, fb: 0.3 });
            reaches.push({ L: Lr, q: qPerM * b2, S, sec, cut: sec ? (sec.b + sec.m * sec.H) * sec.H * Lr : 0, z0, z1 });
          }
        }
        const sec = designCanal(q, Math.max(drainS, Math.min(...reaches.map((r) => r.S))), "grass", { b: drainB, m: 1.5, fb: 0.3 });
        return { ...base, sec, cut: reaches.reduce((a, r) => a + r.cut, 0), dem: true as const, outlet: pr.pts[iOut], zOut: z[iOut], zTop: z[iTop], reaches,
          sMean: (L > 0 ? ((z[iTop] - z[iOut]) / (L / 2)) * 1000 : 0) };
      }
      const sec = designCanal(q, Math.max(0.1, drainS), "grass", { b: drainB, m: 1.5, fb: 0.3 });
      const A = sec ? (sec.b + sec.m * sec.H) * sec.H : 0;
      return { ...base, sec, cut: A * L, dem: false as const, outlet: null as number[] | null, zOut: null as number | null, zTop: null as number | null, reaches: [] as { L: number; q: number; S: number; sec: CanalSection | null; cut: number; z0: number; z1: number }[], sMean: 0 };
    });
  }
  // bacino e fossi di scolo sulla mappa
  useEffect(() => {
    const b = river?.data.basin;
    mapApi.current?.setHydro?.({ basin: b?.ring ?? null, basinLabel: b?.area_km2 ? `${t("Bacino a monte della presa")}: ${b.truncated ? "≥ " : ""}${fmt(b.area_km2, { maximumFractionDigits: 1 })} km²` : undefined,
      ditches: drainCalcs().map((d) => ({ ring: drainProf[String(d.f.id)]?.pts ? [...drainProf[String(d.f.id)].pts, drainProf[String(d.f.id)].pts[0]] : d.ring, outlet: d.outlet, label: `F${d.n} · ${fmt(Math.round(d.q))} l/s${d.sec ? ` · b ${fmt(d.sec.b, { maximumFractionDigits: 2 })} m · y ${fmt(d.sec.y, { maximumFractionDigits: 2 })} m` : ""}` })) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [river, drainOn, drainC, drainS, drainB, drainProf, fields, pivots]);
  // ---- NDVI DEI PIVOT DAL SATELLITE ------------------------------------------------
  const pivSig = () => pivots.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)},${Math.round(p.r)}`).join("|");
  async function readNdvi() {
    if (!pivots.length) return;
    setBusy("ndvi");
    try {
      const r = await api.pivotNdvi(pivots.map((p) => ({ lat: p.lat, lng: p.lng, r: p.r, deg: p.deg, az: p.az })));
      setNdvi({ ...r, sig: pivSig() }); setMsg(t("NDVI letto dalla scena Sentinel-2 del {d} ✓", { d: r.date }));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  // ---- FERTIRRIGAZIONE ------------------------------------------------------------
  // Per ogni pivot diverso: prodotto per intervento (kg e litri), iniezione distribuita su un giro
  // del mese di punta, portata della pompa dosatrice, concentrazione di N nell'acqua; serbatoio per
  // un intervento su tutti i pivot con il 20% di scorta, prodotto della stagione.
  function fertCalc() {
    if (!fert.on || !pivots.length) return null;
    const IP = irrigProgram(), Tpeak = IP ? Math.max(1, ...IP.rows.map((r) => r.T)) : hoursDay;
    const groups = new Map<string, { names: string[]; ha: number; q: number; T: number }>();
    pivots.forEach((pv, k) => {
      const ha = pvAreaM2(pv) / 1e4, q = pivotFlow(pv) * 3.6, T = IP ? Tpeak * (pv.r / IP.pv.r) : Tpeak;      // giro proporzionale al raggio
      const key = `${Math.round(ha * 10)}|${Math.round(q)}`, g = groups.get(key);
      if (g) g.names.push(`P${k + 1}`); else groups.set(key, { names: [`P${k + 1}`], ha, q, T });
    });
    const rows = [...groups.values()].map((g) => {
      const kgN = fert.dose * g.ha, kg = kgN / (fert.n / 100), l = kg / fert.rho;
      const ppm = (kgN * 1000) / Math.max(1, g.q * g.T);                  // g/m³ = mg/l di N
      return { ...g, kgN, kg, l, lh: l / g.T, ppm };
    });
    const lAll = rows.reduce((a, r) => a + r.l * r.names.length, 0);
    return { rows, lAll, tank: Math.ceil((lAll * 1.2) / 500) * 500, season: lAll * fert.times, kgSeason: rows.reduce((a, r) => a + r.kg * r.names.length, 0) * fert.times, nPumps: pivots.length };
  }
  // ---- COLPO D'ARIETE (arresto improvviso delle pompe) --------------------------
  // Joukowsky ΔH = a·Δv/g con celerità dell'onda per tubo in PE100 SDR17 (a = 1425/√(1 + K/E·SDR),
  // K acqua 2,07 GPa, E PE100 ≈ 1,0 GPa a breve termine). Δv = velocità di esercizio (la colonna si ferma).
  // Massimo = prevalenza di esercizio + ΔH; minimo = prevalenza − ΔH (sotto −5 m rischio di cavitazione).
  function waterHammer() {
    const H = hydraNow(); if (!H?.lines?.length) return null;
    const a = 1425 / Math.sqrt(1 + (2.07 / 1.0) * 17), g = 9.81;
    const byDn = new Map<number, { v: number; L: number }>();
    let Lmax = 0;
    for (const [, dns, lens, qs] of H.lines) {
      let Ll = 0;
      dns.forEach((dn, k) => {
        const L = lens[k] ?? 0; Ll += L; if (!dn) return;
        const Di = (dn * (1 - 2 / 17)) / 1000, v = ((qs?.[k] ?? 0) / 1000) / ((Math.PI * Di * Di) / 4);
        const e = byDn.get(dn) ?? { v: 0, L: 0 }; e.v = Math.max(e.v, v); e.L += L; byDn.set(dn, e);
      });
      Lmax = Math.max(Lmax, Ll);
    }
    const Hop = Math.max(10, H.headMax);
    const rows = [...byDn.entries()].sort((x, y) => y[0] - x[0]).map(([dn, e]) => {
      const dH = (a * e.v) / g, hMax = Hop + dH, hMin = Hop - dH;
      const pn = [6, 10, 16, 20, 25].find((p) => p * 10.2 >= hMax) ?? 25;
      return { dn, v: e.v, L: e.L, dH, hMax, hMin, pn, over: hMax > 10 * 10.2, vac: hMin < -5 };
    });
    const tCrit = (2 * Lmax) / a;
    return { a, Hop, rows, Lmax, tCrit, over: rows.some((r) => r.over), vac: rows.some((r) => r.vac), dHmax: Math.max(0, ...rows.map((r) => r.dH)) };
  }
  async function readDrainDem() {
    const used = new Set<number>(pivots.map((p) => p.field).filter((x): x is number => x != null));
    const fs = fields.filter((f) => !used.size || used.has(f.id));
    if (!fs.length) return needField();
    setBusy("drainDem");
    try {
      const out: Record<string, { pts: number[][]; z: (number | null)[] }> = {};
      for (const f of fs) {
        const ring = f.geom.coordinates[0].slice(); if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
        const L = ring.reduce((a, p, k) => a + distM(p, ring[(k + 1) % ring.length]), 0), step = Math.max(25, L / 200), pts: number[][] = [];
        ring.forEach((p, k) => { const q = ring[(k + 1) % ring.length], d = distM(p, q), m = Math.max(1, Math.round(d / step)); for (let j = 0; j < m; j++) pts.push([p[0] + ((q[0] - p[0]) * j) / m, p[1] + ((q[1] - p[1]) * j) / m]); });
        const r = await api.fetchElevation(pts);
        out[String(f.id)] = { pts: pts.map((p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]), z: r.points.map((x) => (x.elev_m == null ? null : Math.round(x.elev_m * 100) / 100)) };
      }
      setDrainProf(out); setMsg(t("Quote del perimetro lette dal DEM ✓"));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  // Sezione e movimenti di terra di ogni canale visibile (pendenza di progetto = target del tracciato)
  function canalCalcs() {
    const vis = canals.filter((c) => !c.hidden && c.geojson?.coordinates?.length >= 2);
    if (!vis.length) return [];
    const q = canalQ > 0 ? canalQ : Math.max(1, Math.round(pumpStation().qDes));
    return vis.map((c) => {
      const S = Math.max(0.05, c.target_permille || c.mean_permille || 0.3);
      const sec = designCanal(q, S, canalLin, { fb: canalFb });
      return { c, idx: canals.indexOf(c), q, S, sec, ew: sec ? canalEarthworks(c.profile, sec) : null };
    });
  }
  type CRow = { cat: string; item: string; qty: number | null; unit: string; note?: string; key?: string };   // key: sigle delle tavole
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
      R.push({ cat: cPiv, key: "pivot", item: `${tx("Pivot")} ${PIVOT_BRANDS[pivotBrand]}`, qty: pvs.length, unit: tx("n."), note: `${tx("Superficie irrigata")} ${fx(ha, { maximumFractionDigits: 1 })} ha` });
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
      const sol = pvs.filter((p) => p.solar);
      if (sol.length) {
        const cS = tx("Pivot solari"), SZ = sol.map((p) => solarSize(p));
        R.push({ cat: cS, key: "solar", item: tx("Campo fotovoltaico vicino al centro del pivot"), qty: Math.round(SZ.reduce((a, z) => a + z.kWp, 0) * 10) / 10, unit: "kWp", note: `${sol.length} pivot` });
        R.push({ cat: cS, key: "solar", item: tx("Moduli fotovoltaici da {w} Wp", { w: fx(solarCfg.wp) }), qty: SZ.reduce((a, z) => a + z.n, 0), unit: tx("n.") });
        R.push({ cat: cS, key: "solar", item: tx("Struttura di sostegno dei moduli"), qty: SZ.reduce((a, z) => a + z.rows, 0), unit: tx("file") });
        R.push({ cat: cS, key: "solar", item: tx("Inverter / regolatore fotovoltaico del pivot"), qty: sol.length, unit: tx("n."), note: SZ.map((z) => `${fx(z.inv)} kW`).join(" · ") });
        const bk = SZ.reduce((a, z) => a + z.batt, 0); if (bk > 0) R.push({ cat: cS, key: "solar", item: tx("Batterie del pivot solare"), qty: bk, unit: "kWh" });
        R.push({ cat: cS, key: "solar", item: tx("Tara non irrigua attorno al perno (area del campo FV)"), qty: Math.round(SZ.reduce((a, z) => a + z.taraM2, 0) / 100) / 100, unit: "ha", note: SZ.map((z) => `Ø ${fx(2 * z.taraR)} m`).join(" · ") });
      }
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
    const HYc = hydraNow();
    if (HYc && HYc.byDn.length) {
      for (const [dn, m] of [...HYc.byDn].sort((a, b) => a[0] - b[0])) R.push({ cat: cNet, key: `pipe:${dn}`, item: tx("Tubazione DN {d}", { d: dn }), qty: Math.round(m), unit: "m" });
    } else {
      const m = pivotLines.filter((l) => l.kind === "pipe").reduce((a, l) => a + lenOf(l.coords), 0);
      if (m > 0) R.push({ cat: cNet, item: tx("Tubazioni (diametri da calcolare nella pagina Tubazioni)"), qty: Math.round(m), unit: "m" });
    }
    if (common) for (const k of canalCalcs().filter((x) => !x.c.exist)) {
      const cC = tx("Canali"), nm = `${tx("Canale")} ${k.idx + 1}`, L = k.ew?.len ?? lenOf(k.c.geojson.coordinates);
      R.push({ cat: cC, key: "canal", item: k.sec ? tx("{n}: sezione trapezia, base {b} m, tirante {y} m, franco {f} m, scarpe 1:{m} · {lin}", { n: nm, b: fx(k.sec.b, { maximumFractionDigits: 2 }), y: fx(k.sec.y, { maximumFractionDigits: 2 }), f: fx(k.sec.fb, { maximumFractionDigits: 2 }), m: fx(k.sec.m), lin: tx(lining(k.sec.lin).label) }) : nm,
        qty: Math.round(L), unit: "m", note: k.sec ? `${fx(k.q)} l/s · ${fx(k.S, { maximumFractionDigits: 2 })}‰ · v ${fx(k.sec.v, { maximumFractionDigits: 2 })} m/s` : undefined });
      if (k.ew) {
        R.push({ cat: cC, key: "canal", item: tx("{n}: scavo", { n: nm }), qty: Math.round(k.ew.cut), unit: "m³" });
        if (k.ew.fill > 1) R.push({ cat: cC, key: "canal", item: tx("{n}: rilevato degli argini", { n: nm }), qty: Math.round(k.ew.fill), unit: "m³" });
        if (k.sec && (k.sec.lin === "concr" || k.sec.lin === "liner" || k.sec.lin === "stone"))
          R.push({ cat: cC, key: "canal", item: tx("{n}: rivestimento in {lin}", { n: nm, lin: tx(lining(k.sec.lin).label).toLowerCase() }), qty: Math.round(k.ew.linedM2), unit: "m²" });
      }
    }
    { const FC = common ? fertCalc() : null;
      if (FC) {
        const cFe = tx("Fertirrigazione");
        R.push({ cat: cFe, key: "fert", item: tx("Pompa dosatrice per fertirrigazione"), qty: FC.nPumps, unit: tx("n."), note: `${fx(Math.max(...FC.rows.map((r) => r.lh)), { maximumFractionDigits: 1 })} l/h max` });
        R.push({ cat: cFe, key: "fert", item: tx("Serbatoio del fertilizzante"), qty: FC.tank, unit: "l" });
      }
    }
    if (common) for (const d of drainCalcs()) {
      const cD = tx("Drenaggio");
      R.push({ cat: cD, key: "drain", item: d.sec ? tx("Fosso di scolo F{n} ({f}): base {b} m, tirante {y} m, scarpe 1:1,5, inerbito", { n: d.n, f: d.f.name, b: fx(d.sec.b, { maximumFractionDigits: 2 }), y: fx(d.sec.y, { maximumFractionDigits: 2 }) }) : `F${d.n}`, qty: Math.round(d.L), unit: "m", note: `${fx(Math.round(d.q))} l/s · ${fx(drainS)}‰` });
      R.push({ cat: cD, key: "drain", item: tx("Fosso di scolo F{n}: scavo", { n: d.n }), qty: Math.round(d.cut), unit: "m³" });
    }
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
    // Pompe Caprari consigliate e linee elettriche
    const stl = pumpStationsList();
    for (const st of stl) if (st.pick) R.push({ cat: tx("Pompe e linee elettriche"), key: `pump:${st.name}`, item: `${st.name}: Caprari ${st.pick.model}`, qty: st.nTot, unit: tx("n."),
      note: `${tx("motore")} ${fx(st.pick.motor, { maximumFractionDigits: 1 })} kW · ${fx(Math.round(st.qLs))} l/s · ${fx(Math.round(st.head))} m · η ${fx(Math.round(st.pick.eta))} %` });
    const byS = new Map<string, number>();
    for (const c of cableRuns(stl)) { const k = `${c.mat} 3×${fx(c.S, { maximumFractionDigits: 1 })} mm²`; byS.set(k, (byS.get(k) ?? 0) + c.L); }
    for (const [k, m] of byS) R.push({ cat: tx("Pompe e linee elettriche"), key: `cable:${k}`, item: `${tx("Cavo interrato")} ${k}`, qty: Math.round(m), unit: "m" });
    const G = powerGear(stl), cE = tx("Pompe e linee elettriche");
    for (const pn of G.panels) {
      R.push({ cat: cE, item: `${tx("Quadro di comando delle pompe")} · ${pn.name}`, qty: 1, unit: tx("n."), note: `${pn.n} × ${fx(pn.kWp, { maximumFractionDigits: 1 })} kW` });
      if (pn.inverter) R.push({ cat: cE, item: `${tx("Inverter")} ${fx(pn.kWp, { maximumFractionDigits: 1 })} kW`, qty: pn.n, unit: tx("n.") });
    }
    if (G.supply === "mt") R.push({ cat: cE, item: tx("Cabina di trasformazione MT/BT"), qty: G.kva, unit: "kVA", note: `${fx(Math.round(G.kW))} kW` });
    else if (G.supply === "bt") R.push({ cat: cE, item: tx("Punto di consegna in bassa tensione"), qty: Math.round(G.kW), unit: "kW" });
    else if (G.supply === "gen") R.push({ cat: cE, item: tx("Gruppo elettrogeno"), qty: G.kva, unit: "kVA" });
    // Pezzi speciali della rete e attacchi dei pivot
    const NF = netFittings(hydraNow()), cN = tx("Pezzi speciali della rete");
    if (NF) {
      for (const [dn, n] of [...NF.air.entries()].sort((a, b) => a[0] - b[0])) if (dn) R.push({ cat: cN, key: `air:${dn}`, item: `${tx("Sfiato d'aria")} DN ${dn}`, qty: n, unit: tx("n."), note: NF.withProfile ? tx("sui colmi del profilo") : tx("ogni 500 m (senza quote)") });
      if (NF.drains) R.push({ cat: cN, key: "drain", item: tx("Scarico"), qty: NF.drains, unit: tx("n.") });
      for (const [dn, n] of [...NF.tees.entries()].sort((a, b) => a[0] - b[0])) R.push({ cat: cN, key: `tee:${dn}`, item: `${tx("Tee")} DN ${dn}`, qty: n, unit: tx("n.") });
      for (const [k, n] of NF.reds) R.push({ cat: cN, key: `red:${k}`, item: `${tx("Riduzione")} DN ${k.replace("x", " × ")}`, qty: n, unit: tx("n.") });
    }
    if (pivots.length) {
      const mv = new Map<number, number>();
      for (const pv of pivots) { const r = pivotRiser(pv); mv.set(r.mv, (mv.get(r.mv) ?? 0) + 1); }
      for (const [dn, n] of [...mv.entries()].sort((a, b) => a[0] - b[0])) R.push({ cat: cN, key: `mv:${dn}`, item: `${tx("Idrovalvola e diffusore del pivot")} DN ${dn}`, qty: n, unit: tx("n.") });
    }
    return R;
  }
  async function downloadComputo() {
    ensureHydra(); await ensureProfile();
    const blob = await computoXlsx();
    if (!blob) { setMsg(t("Posa prima i pivot sul campo attivo.")); return; }
    const pname = projects.find((x) => x.id === projectId)?.name || "Argus Total";
    saveBlob(blob, `${safe(pname)}_computo.xlsx`);
  }
  async function computoXlsx(): Promise<Blob | null> {
    const rows = computoRows();
    if (!rows.length) return null;
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
    return buildXlsx(t("Computo metrico"), sheet, { boldRows: bold, widths: [28, 52, 12, 8, 70] });
  }
  // Il file .ceres completo (progetto Ceres in «m» + computo per Mercurius).
  function ceresFile(riferimento: string, revisione: number): { err: string } | { file: Record<string, unknown>; name: string; n: number; nf: number; skipped: number } {
    const hasLin = Object.values(sysDesigns).some((d) => d.sys === "lineari");
    if (!pivots.length && !hasLin) return { err: t("Posa prima i pivot sul campo attivo.") };
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
    if (!ffSrc.length) return { err: t("Nessun pivot è dentro un campo: impossibile esportare per Ceres.") };
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
    if (decodeURIComponent(escape(atob(m))) !== json) return { err: t("Esportazione per Ceres non riuscita: verifica di codifica fallita.") };
    const name = pname || cname || "Argus Total";
    return { file: { app: "ceres", ver: "78.16", name, m, ...mercuriusComputo(riferimento, revisione) }, name, n: p.length, nf: ff.length, skipped };
  }
  // ---- Dati del sito salvati nel progetto (clima NASA POWER e profilo della rete) --------
  // Si scaricano una volta: dalla seconda esportazione non si aspetta la rete.
  const projSettings = () => ((projects.find((x) => x.id === projectId)?.settings ?? {}) as { site_climate?: { key: string; data: api.SiteClimate }; net_profile?: { sig: string; lines: [number, number[], (number | null)[]][] } });
  const siteCenter = (): [number, number] | null => {
    const mp = pivots.length ? pivots.map((p) => [p.lng, p.lat]) : fields.filter((f) => f.parentId == null).flatMap((f) => f.geom.coordinates[0]);
    if (!mp.length) return null;
    return [mp.reduce((a, q) => a + q[1], 0) / mp.length, mp.reduce((a, q) => a + q[0], 0) / mp.length];
  };
  const climKey = (c: [number, number]) => `${c[0].toFixed(2)},${c[1].toFixed(2)}`;     // ~1 km: la griglia NASA POWER è di 0,5°
  function patchSettings(pid: number, patch: Record<string, unknown>) {
    api.updateProject(pid, { settings: patch } as Partial<api.Project>)
      .then((p2) => setProjects((ps) => ps.map((p) => (p.id === pid ? { ...p, settings: p2.settings } : p)))).catch(() => { /* resta solo in memoria */ });
  }
  async function siteClimateCached(): Promise<api.SiteClimate | null> {
    const c = siteCenter(); if (!c || !projectId) return null;
    const sc = projSettings().site_climate;
    if (sc?.key === climKey(c) && sc.data?.eto_month_mm?.length === 12 && sc.data?.tmax?.length === 12) return sc.data;
    try {
      const d = await api.siteClimate(c[0], c[1]);
      if (d?.eto_month_mm?.length !== 12 || d?.tmax?.length !== 12) return null;
      patchSettings(projectId, { site_climate: { key: climKey(c), data: d } });
      return d;
    } catch { return null; }
  }
  // ET₀ di punta del sito (media del mese più caldo, FAO-56) per allineare il parametro di progetto
  const siteEt0Peak = (() => { const d = projSettings().site_climate?.data; return d?.eto_day?.length === 12 ? Math.max(...d.eto_day) : null; })();
  const et0Hint = () => siteEt0Peak != null && Math.abs(siteEt0Peak - et0Peak) >= 0.15 ? (
    <button type="button" className="text-[10px] text-left text-sky-700 hover:underline mt-0.5" onClick={() => setEt0Peak(Math.round(siteEt0Peak * 10) / 10)}
      title={t("ET₀ FAO-56 Penman-Monteith del mese di punta, dai normali climatici NASA POWER del sito")}>
      {t("Sito: {v} mm/g · usa questo valore", { v: fmt(siteEt0Peak, { maximumFractionDigits: 1 }) })}</button>) : null;
  // La revisione successiva per Mercurius (stesso riferimento, revisione più alta)
  const nextCeresRev = () => Math.max(1, Math.round(Number((projects.find((x) => x.id === projectId)?.settings as { ceres_rev?: number } | undefined)?.ceres_rev ?? 0)) + 1);
  // Revisione dei documenti: l'ultima esportata; durante il pacchetto ZIP quella nuova, uguale per PDF, .xlsx e .ceres.
  const revOverride = useRef<number | null>(null);
  const docRev = () => revOverride.current ?? Math.max(1, nextCeresRev() - 1);
  function saveCeresRev(pid: number, rev: number) {
    api.updateProject(pid, { settings: { ceres_rev: rev } } as Partial<api.Project>)
      .then((p2) => setProjects((ps) => ps.map((p) => (p.id === pid ? { ...p, settings: p2.settings } : p)))).catch(() => { /* silenzioso */ });
  }
  // Ortofoto nella planimetria del .ceres (la tavola dell'offerta Mercurius):
  // il riquadro diventa quello esatto dell'immagine. Senza rete resta il disegno.
  async function withPhoto(file: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pl = file.planimetria as { riquadro: { ovest: number; sud: number; est: number; nord: number }; elementi: unknown } | undefined;
    if (!pl) return file;
    try {
      const o = await api.ortho([pl.riquadro.ovest, pl.riquadro.sud, pl.riquadro.est, pl.riquadro.nord]);
      return { ...file, planimetria: { formato: 1, riquadro: o.riquadro, immagine: o.immagine, attribuzione: o.attribuzione, elementi: pl.elementi } };
    } catch { return file; }
  }
  const catNote = () => catStat.current ? " " + t("Codici a catalogo Olympus: {a} su {b}.", { a: fmt(catStat.current.on), b: fmt(catStat.current.tot) }) : "";
  async function exportCeres() {
    if (!projectId) { setMsg(t("Seleziona un progetto prima di creare il link.")); return; }
    const rev = nextCeresRev();
    ensureHydra(); await ensureProfile();
    const r = ceresFile(`ARGUS-${projectId}`, rev);
    if ("err" in r) { setMsg(r.err); return; }
    const pid = projectId;
    setBusy("ceres");
    try {
      const file = await withPhoto(r.file);
      saveBlob(new Blob([JSON.stringify(file)], { type: "application/json" }), `${safe(r.name)}_rev${rev}.ceres`);
      saveCeresRev(pid, rev);
      setMsg(t("File .ceres esportato: {n} pivot in {f} campi.", { n: fmt(r.n), f: fmt(r.nf) })
        + " " + t("Computo per Mercurius: riferimento {r}, revisione {v}.", { r: `ARGUS-${pid}`, v: rev }) + catNote()
        + (r.skipped ? " " + t("{n} pivot fuori dai campi non esportati.", { n: fmt(r.skipped) }) : ""));
    } finally { setBusy(""); }
  }
  // ---- OLYMPUS · MERCURIUS: invio diretto del progetto ------------------------
  // Come in Ceres: accesso con l'utenza Olympus (email e password → token, la
  // password non si salva), catalogo da /catalogo/per-ceres, import da
  // /progetti/import. Il dominio di Argus va aggiunto in Olympus fra le origini
  // ammesse (OLYMPUS_CORS_ORIGINS_EXTRA).
  const [olyUrl, setOlyUrl] = useState("");
  const [olyEmail, setOlyEmail] = useState("");
  const [olyPass, setOlyPass] = useState("");
  const [olyUser, setOlyUser] = useState<string | null>(null);
  const [olyMsg, setOlyMsg] = useState<{ bad: boolean; m: string } | null>(null);
  const [olyCustomers, setOlyCustomers] = useState<{ id: string; name: string }[] | null>(null);
  const [olyCust, setOlyCust] = useState("");
  const [olyTerr, setOlyTerr] = useState("");                            // r:<codice regione> | c:<ISO2>
  const [olyTerrs, setOlyTerrs] = useState<{ v: string; n: string }[]>([]);
  const [olyOpen, setOlyOpen] = useState(false);
  const [olyLink, setOlyLink] = useState<string | null>(null);
  const olyTok = useRef<{ a: string; r: string } | null>(null);
  useEffect(() => {
    try {
      const j = JSON.parse(localStorage.getItem("argus-olympus") || "{}");
      if (j.url) setOlyUrl(j.url); if (j.email) setOlyEmail(j.email);
      const tk = JSON.parse(sessionStorage.getItem("argus-olympus-tok") || "null");
      if (tk?.a) { olyTok.current = tk; setOlyUser(j.email || "Olympus"); }
    } catch { /* niente da ricordare */ }
  }, []);
  const setOlyTokens = (tk: { a: string; r: string } | null) => {
    olyTok.current = tk;
    try { if (tk) sessionStorage.setItem("argus-olympus-tok", JSON.stringify(tk)); else sessionStorage.removeItem("argus-olympus-tok"); } catch { /* */ }
    if (!tk) setOlyUser(null);
  };
  const oly = <T,>(path: string, init?: { method?: string; body?: unknown }) => api.olympusCall<T>(olyUrl, olyTok.current, path, init, setOlyTokens);
  const olyErr = (e: unknown) => setOlyMsg({ bad: true, m: e instanceof api.OlympusError ? e.message : `${t("Olympus non raggiungibile: controlla l'indirizzo e che Argus sia fra le origini ammesse.")} ${e instanceof Error ? e.message : ""}` });
  async function olyLogin() {
    if (!olyUrl.trim() || !olyEmail.trim() || !olyPass) return;
    setBusy("oly"); setOlyMsg(null);
    try {
      const r = await api.olympusCall<{ access_token: string; refresh_token: string }>(olyUrl, null, "/auth/login", { method: "POST", body: { email: olyEmail.trim(), password: olyPass } });
      setOlyTokens({ a: r.access_token, r: r.refresh_token }); setOlyUser(olyEmail.trim()); setOlyPass("");
      try { localStorage.setItem("argus-olympus", JSON.stringify({ url: olyUrl.trim(), email: olyEmail.trim() })); } catch { /* */ }
      try { const c = await oly<unknown>("/catalogo/per-ceres"); const n = storeCatalog(c); setOlyMsg({ bad: false, m: t("Collegato a Olympus. Catalogo aggiornato: {n} articoli.", { n: fmt(n) }) }); }
      catch { setOlyMsg({ bad: false, m: t("Collegato a Olympus.") }); }
    } catch (e) { olyErr(e); } finally { setBusy(""); }
  }
  function olyLogout() { setOlyTokens(null); setOlyCustomers(null); setOlyMsg(null); }
  async function olyCatalog() {
    setBusy("oly"); setOlyMsg(null);
    try { const n = storeCatalog(await oly<unknown>("/catalogo/per-ceres")); setOlyMsg({ bad: false, m: t("Catalogo aggiornato: {n} articoli.", { n: fmt(n) }) }); }
    catch (e) { olyErr(e); } finally { setBusy(""); }
  }
  async function catalogFromFile(f: File) {
    try { const n = storeCatalog(JSON.parse(await f.text())); setOlyMsg({ bad: false, m: t("Catalogo aggiornato: {n} articoli.", { n: fmt(n) }) }); }
    catch (e) { setOlyMsg({ bad: true, m: e instanceof Error ? e.message : String(e) }); }
  }
  async function olyLoadTerritories() {
    if (olyTerrs.length) return;
    try {
      const [rg, ct] = await Promise.all([oly<{ code: string; name: string }[]>("/regions"), oly<{ iso2: string; name: string }[]>("/countries")]);
      const out = [...rg.map((r) => ({ v: `r:${r.code}`, n: `Italia · ${r.name}` })), ...ct.filter((c) => c.iso2 !== "IT").map((c) => ({ v: `c:${c.iso2}`, n: c.name }))];
      setOlyTerrs(out);
    } catch { /* senza elenco si sceglie un cliente esistente */ }
  }
  async function olySend(customerId?: string, newCustomer?: string) {
    if (!projectId || !olyTok.current) return;
    const pid = projectId;
    setBusy("oly"); setOlyMsg(null); setOlyLink(null);
    try {
      let rev = nextCeresRev();
      ensureHydra(); await ensureProfile();
      for (let tries = 0; tries < 4; tries++) {
        const r = ceresFile(`ARGUS-${pid}`, rev);
        if ("err" in r) { setOlyMsg({ bad: true, m: r.err }); return; }
        const file = await withPhoto(r.file);
        try {
          const out = await oly<{ id?: string; code?: string; revisione?: number }>("/progetti/import", { method: "POST", body: { computo: file, ...(customerId ? { customer_id: customerId } : newCustomer ? { nuovo_cliente: { ragione_sociale: newCustomer,
            ...(olyTerr.startsWith("r:") ? { region_code: olyTerr.slice(2) } : olyTerr.startsWith("c:") ? { country_iso2: olyTerr.slice(2) } : {}) } } : {}) } });
          saveCeresRev(pid, rev); setOlyCustomers(null);
          setOlyLink(out.id ? `${api.olympusBase(olyUrl).replace(/\/api\/v1$/, "")}/progetti/${out.id}` : null);
          setOlyMsg({ bad: false, m: t("Progetto {c} creato in Olympus: riferimento {r}, revisione {v}.", { c: out.code ?? "", r: `ARGUS-${pid}`, v: rev }) + catNote() });
          return;
        } catch (e) {
          if (e instanceof api.OlympusError && e.status === 409) {
            const m = /revisione (\d+)/.exec(e.message); rev = Math.max(rev + 1, m ? Number(m[1]) + 1 : 0); continue;
          }
          if (e instanceof api.OlympusError && e.status === 422 && /Cliente non trovato/i.test(e.message)) {
            const cname = clients.find((c) => c.id === clientId)?.name || "";
            const q = cname.split(/\s+/)[0] || "";
            await olySearchCustomers(q); olyLoadTerritories();
            setOlyMsg({ bad: true, m: t("Cliente «{n}» non trovato in Olympus: sceglilo e invia di nuovo.", { n: cname }) });
            return;
          }
          throw e;
        }
      }
    } catch (e) { olyErr(e); } finally { setBusy(""); }
  }
  async function olySearchCustomers(q: string) {
    try {
      let res = await oly<{ items: { id: string; legal_name?: string; name?: string; city?: string }[] }>(`/customers?q=${encodeURIComponent(q)}&page_size=30`);
      if (!res.items.length && q) res = await oly<typeof res>("/customers?page_size=30");
      setOlyCustomers(res.items.map((c) => ({ id: c.id, name: `${c.legal_name ?? c.name ?? ""}${c.city ? ` · ${c.city}` : ""}` })));
      setOlyCust(res.items[0]?.id ?? "");
    } catch (e) { olyErr(e); }
  }
  // ---- RELAZIONE TECNICA GENERALE PER IL CLIENTE (PDF) -------------------------------
  // Impostata come le relazioni tecniche Agrostar: copertina con la foto aerea del
  // sito, capitoli numerati in prosa con tabelle e figure. Nessun prezzo: le
  // condizioni economiche stanno solo nell'offerta Mercurius (il backend rifiuta «€»).
  const [relBrand, setRelBrand] = useState<"agrostar" | "nabu">("agrostar");
  // ---- Tavole PDF (motore delle tavole di Ceres) ----------------------------------
  // Tre tavole in un solo PDF: planimetria generale, tavola delle tubazioni (tratti,
  // nodi, valvole, sezioni di scavo, profilo) e tavola delle linee elettriche (cavi,
  // sezioni, schema unifilare). Il font del PDF ha solo l'alfabeto latino-1: le
  // altre lingue escono in inglese.
  const [tvCompact, setTvCompact] = useState(true);   // tabelle e disegni accorpati sulle stesse pagine
  // out: per il PDF di progetto (relazione + tavole) il PDF non si scarica ma torna al chiamante
  // Elaborati del progetto: codice ARGUS-<id>-TAV-01 … come il riferimento Mercurius
  type TvKind = "plan" | "pipe" | "elec" | "can" | "dr" | "phase" | "det" | "wk" | "sch" | "cmp";
  type TavOut = { blob?: Blob; kinds?: TvKind[]; codes?: string[]; titles?: string[]; lang?: Lang; full?: boolean; defer?: boolean; build?: () => Promise<Blob> };
  const elabCode = (pid: number, kind: TvKind, n: number) => `ARGUS-${pid}-${kind === "sch" ? "SCH" : kind === "cmp" ? "CMP" : "TAV"}-${String(n).padStart(2, "0")}`;
  async function downloadTavole(out?: TavOut) {
    if (!projectId || (!pivots.length && !pivotLines.some((l) => l.kind === "pipe"))) { setMsg(t("Posa prima i pivot sul campo attivo.")); return; }
    const pid = projectId;
    if (!out) setBusy("tav");
    try {
      ensureHydra(); await ensureProfile();
      const TV = await import("@/lib/tavole");
      let logo: string | null = null;
      try { const b = await (await fetch("/argusmark.png")).blob(); logo = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(b); }); } catch { logo = null; }
      const lng: Lang = (["it", "en", "fr", "es", "pt", "de", "af", "ms", "id"] as Lang[]).includes(pdfLang) ? pdfLang : "en";
      const rev = docRev();
      const { sheets, sheetsA, sheetsB, wkMeta, common, kinds, codes, titles, cname: wkCli, rev: wkRev, date: wkDate } = inLang(lng, () => {
        const n0 = (x: number) => fx(Math.round(x)), n1 = (x: number) => fx(x, { maximumFractionDigits: 1 }), n2 = (x: number) => fx(x, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const LLf = (q: number[]): LL => [q[1], q[0]];
        const pname = projects.find((x) => x.id === pid)?.name || "Argus Total", cname = clients.find((c) => c.id === clientId)?.name || "—";
        const d = new Date(), date = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
        const HY = hydraNow(), stations = pumpStationsList(), cabs = cableRuns(stations), G = powerGear(stations);
        const S = srcPt && pivots.length ? sourceSchemes() : null;
        const sc = S ? (S.schemes.find((x) => x.key === (srcShown ?? S.best?.key)) ?? null) : null;
        const resPt = srcRoute && srcRoute.length >= 2 ? srcRoute[srcRoute.length - 1] : null;
        const usedF = fields.filter((f) => f.parentId == null && (pivots.some((p) => p.field === f.id) || pivotLines.some((l) => l.field === f.id)));
        const fieldsShown = (usedF.length ? usedF : fields.filter((f) => f.parentId == null)).filter((f) => !f.hidden);
        const fieldsTv = fieldsShown.map((f) => ({ pts: f.geom.coordinates[0].map(LLf) }));
        const gross = fieldsShown.reduce((a, f) => a + ringAreaHa(f.geom.coordinates), 0);
        const pHa = (p: PivotItem) => pvAreaM2(p) / 1e4;
        const covHa = pivots.reduce((a, p) => a + pHa(p), 0);
        const pivTv: TvPivot[] = pivots.map((p, k) => {
          const deg = Math.min(360, p.deg ?? 360), azc = (p.az ?? 0) + deg / 2, c = spanComposition(p, pivotBrand);
          return { lat: p.lat, lng: p.lng, r: p.r, deg, az: azc, ring: TV.pivotRing(p.lat, p.lng, p.r, deg, azc),
            gunRing: p.gun && p.gun > 0 ? TV.pivotRing(p.lat, p.lng, p.r + p.gun, deg, azc) : null, spans: c?.spans.map((s) => s.len),
            line1: `P${k + 1} · R ${n0(p.r)} m · ${n0(deg)}° · ${n1(pHa(p))} ha`,
            line2: `${n1(pivotFlow(p) * 3.6)} m³/h · ${n1(pivotPressure(p))} bar${p.solar ? ` · FV ${n1(solarSize(p).kWp)} kWp` : ""}`,
            ...(p.solar ? { pv: solarPolys(p) as LL[][] } : {}) };
        });
        // ---- rete: tratti T# a diametro costante ----
        type Run = { n: number; i: number; dn: number; L: number; q: number; pts: number[][]; hf: number; d0: number };
        const runs: Run[] = [];
        for (const [i, dns, ls, qs] of HY?.lines ?? []) {
          const co = pivotLines[i]?.coords; if (!co) continue;
          let cur: Run | null = null, dAcc = 0;
          dns.forEach((dn, k) => {
            const L = ls[k] ?? 0, q = qs?.[k] ?? 0;
            const hf = q > 0 && dn > 0 ? (10.67 * L * Math.pow(q / 1000, 1.852)) / (Math.pow(hwC, 1.852) * Math.pow(dn / 1000, 4.87)) : 0;
            if (cur && cur.dn === dn) { cur.L += L; cur.q = Math.max(cur.q, q); cur.hf += hf; cur.pts.push(co[k + 1]); }
            else { cur = { n: runs.length + 1, i, dn, L, q, pts: [co[k], co[k + 1]], hf, d0: dAcc }; runs.push(cur); }
            dAcc += L;
          });
        }
        if (!runs.length) pivotLines.forEach((l, i) => { if (l.kind === "pipe" && l.coords.length >= 2) runs.push({ n: runs.length + 1, i, dn: 0, L: l.coords.reduce((a, q, k, c) => a + (k ? distM(c[k - 1], q) : 0), 0), q: 0, pts: l.coords, hf: 0, d0: 0 }); });
        const vel = (r: Run) => (r.q > 0 && r.dn > 0 ? r.q / 1000 / (Math.PI * Math.pow(r.dn / 1000 * (1 - 2 / 17), 2) / 4) : 0);
        // nodi: vertici con 3+ tratti (T, croce) o cambio di diametro (riduzione)
        const key = (q: number[]) => `${q[0].toFixed(5)},${q[1].toFixed(5)}`;
        const nodeMap = new Map<string, { q: number[]; dns: number[] }>();
        for (const r of runs) for (let k = 0; k < r.pts.length - 1; k++) for (const q of [r.pts[k], r.pts[k + 1]]) {
          const e = nodeMap.get(key(q)) ?? nodeMap.set(key(q), { q, dns: [] }).get(key(q))!; e.dns.push(r.dn);
        }
        const nodes: { n: number; q: number[]; type: string; dns: number[] }[] = [];
        for (const e of nodeMap.values()) {
          const mx = Math.max(...e.dns), mn = Math.min(...e.dns), deg = e.dns.length;
          const type = deg >= 4 ? tx("Raccordi a croce") : deg === 3 ? tx("Raccordi a T") : deg === 2 && mn < mx && mn > 0 ? tx("Riduzione") : "";
          if (type) nodes.push({ n: nodes.length + 1, q: e.q, type, dns: [...new Set(e.dns)].sort((a, b) => b - a) });
        }
        // apparecchiature: sfiati (inizio, colmi, fine in salita), scarichi (avvallamenti), idrovalvole ai pivot, non ritorno e misuratore alle stazioni
        const prof = netProfRef.current?.sig === netSig() ? netProfRef.current.lines : null;
        const lineAt = (co: number[][], x: number) => { let c = 0; for (let k = 0; k < co.length - 1; k++) { const L = distM(co[k], co[k + 1]); if (x <= c + L + 1e-6) { const f = L ? (x - c) / L : 0; return [co[k][0] + (co[k + 1][0] - co[k][0]) * f, co[k][1] + (co[k + 1][1] - co[k][1]) * f]; } c += L; } return co[co.length - 1]; };
        const runAt = (i: number, x: number) => runs.find((r) => r.i === i && x >= r.d0 - 1e-6 && x <= r.d0 + r.L + 1e-6) ?? runs.find((r) => r.i === i);
        type Ap = { tag: string; k: "I" | "S" | "V" | "M"; type: string; dn: string; run: string; prog: number | null; q: number[]; z: number | null };
        const aps: Ap[] = []; let nS = 0, nD = 0;
        const pushAp = (k: Ap["k"], type: string, i: number, x: number, z: number | null) => {
          const co = pivotLines[i].coords, r = runAt(i, x), tag = k === "S" ? `S${++nS}` : `D${++nD}`;
          aps.push({ tag, k, type, dn: r?.dn ? `Ø${r.dn}` : "—", run: r ? `T${r.n}` : "—", prog: x, q: lineAt(co, x), z });
        };
        const lineIdx = [...new Set(runs.map((r) => r.i))];
        for (const i of lineIdx) {
          const co = pivotLines[i].coords, Ltot = co.reduce((a, q, k, c) => a + (k ? distM(c[k - 1], q) : 0), 0), pr = prof?.get(i);
          if (pr && pr.z.filter((z) => z != null).length >= 3) {
            const n = pr.d.length, z = pr.z.map((v) => v ?? NaN);
            const win = (k: number, rr: number) => { const o: number[] = []; for (let j = 0; j < n; j++) if (Math.abs(pr.d[j] - pr.d[k]) <= rr && Number.isFinite(z[j])) o.push(z[j]); return o; };
            pushAp("S", tx("Valvole di sfiato / aria"), i, 0, Number.isFinite(z[0]) ? z[0] : null);
            let dl = 0;
            for (let k = 1; k < n - 1; k++) {
              if (!Number.isFinite(z[k])) continue;
              const near = win(k, 150), far = win(k, 400);
              if (z[k] >= Math.max(...near) && z[k] - Math.min(...far) >= 1) pushAp("S", tx("Valvole di sfiato / aria"), i, pr.d[k], z[k]);
              else if (z[k] <= Math.min(...near) && Math.max(...far) - z[k] >= 1) { pushAp("V", tx("Scarichi invernali (gelo)"), i, pr.d[k], z[k]); dl++; }
            }
            if (Number.isFinite(z[n - 1]) && Number.isFinite(z[n - 2]) && z[n - 1] < z[n - 2]) { pushAp("V", tx("Scarichi invernali (gelo)"), i, pr.d[n - 1], z[n - 1]); dl++; }
            else pushAp("S", tx("Valvole di sfiato / aria"), i, pr.d[n - 1], Number.isFinite(z[n - 1]) ? z[n - 1] : null);
            if (!dl) { let kmin = 0; for (let k = 1; k < n; k++) if (z[k] < z[kmin]) kmin = k; pushAp("V", tx("Scarichi invernali (gelo)"), i, pr.d[kmin], Number.isFinite(z[kmin]) ? z[kmin] : null); }
          } else {
            pushAp("S", tx("Valvole di sfiato / aria"), i, 0, null);
            for (let x = 500; x < Ltot - 50; x += 500) pushAp("S", tx("Valvole di sfiato / aria"), i, x, null);
            pushAp("V", tx("Scarichi invernali (gelo)"), i, Ltot, null);
          }
        }
        pivots.forEach((p, k) => { const rs = pivotRiser(p); aps.push({ tag: `I${k + 1}`, k: "I", type: tx("Idrovalvola") + ` · P${k + 1}`, dn: `DN${rs.mv}`, run: "—", prog: null, q: [p.lng, p.lat], z: null }); });
        stations.forEach((st, k) => { if (!st.pt) return;
          const dn = runs.find((r) => r.pts.some((q) => distM(q, st.pt!) < 30))?.dn;
          aps.push({ tag: `NR${k + 1}`, k: "V", type: tx("Valvole di non ritorno") + ` · ${st.name}`, dn: dn ? `Ø${dn}` : "—", run: "—", prog: null, q: st.pt, z: null });
          aps.push({ tag: `M${k + 1}`, k: "M", type: tx("Misuratore di portata") + ` · ${st.name}`, dn: dn ? `Ø${dn}` : "—", run: "—", prog: null, q: st.pt, z: null }); });
        // ---- elementi comuni della planimetria ----
        const PIPE_C = "#c2691a", ADD_C = "#1769ff", CAB_C = "#e11d48", PUMP_C = "#0ea5e9";
        const srcLines: TvLine[] = srcRoute && srcRoute.length >= 2 ? [{ id: "src", pts: srcRoute.map(LLf), color: ADD_C, width: 0.9 }] : [];
        const basePts: TvPoint[] = [];
        if (srcPt) basePts.push({ pt: LLf(srcPt), color: "#1d6fb8", lab: tx("Fonte d'acqua") });
        if (resPt && sc?.res) basePts.push({ pt: LLf(resPt), color: "#1d6fb8", resR: sc.res.r, resLab: `${tx("Vasca di accumulo")} · ${n0(sc.res.vol)} m³` });
        {   // stazioni nello stesso punto (presa e rilanci alla vasca): un solo simbolo con un'etichetta
          const grp = new Map<string, { pt: number[]; names: string[] }>();
          stations.forEach((st) => { if (!st.pt) return; const k2 = key(st.pt); (grp.get(k2) ?? grp.set(k2, { pt: st.pt, names: [] }).get(k2)!).names.push(st.name); });
          for (const g of grp.values()) basePts.push({ pt: LLf(g.pt), color: PUMP_C, square: true, lab: g.names.length > 1 ? `${g.names[0]} +${g.names.length - 1}` : g.names[0] });
        }
        const pivItems: TvColItem[] = pivots.map((p, k) => ({ head: pivTv[k].line1, lines: [pivTv[k].line2 ?? ""] }));
        const stItems: TvColItem[] = stations.map((st) => ({ head: st.name, lines: [`${n1(st.qLs * 3.6)} m³/h · ${n0(st.head)} m · ${n1(st.kW)} kW`, st.pick ? `${st.pick.n} × ${st.pick.model ?? ""}`.trim() : ""].filter(Boolean) }));
        const cellsBase = (title: string): [string, string][] => [[tx("Cliente"), cname], [tx("Riferimento"), `${pname} · ${title}`], [tx("Superficie campo"), `${n1(gross)} ha`],
          [tx("Copertura"), gross > 0 ? `${n0((covHa / gross) * 100)} %` : "—"], [tx("Coperta / non cop."), `${n1(covHa)} / ${n1(Math.max(0, gross - covHa))} ha`],
          [tx("Macchine"), `${pivots.length} pivot`], [tx("Data"), `${date} · Rev. ${rev}`]];
        const totL = runs.reduce((a, r) => a + r.L, 0);
        const byDn = new Map<number, number>(); runs.forEach((r) => byDn.set(r.dn, (byDn.get(r.dn) ?? 0) + r.L));
        // 1 — planimetria generale
        const sh1: TvSheet = { title: tx("Planimetria generale"), fields: fieldsTv, pivots: pivTv,
          lines: [...srcLines, ...runs.map((r) => ({ id: "p" + r.n, pts: r.pts.map(LLf), color: PIPE_C, dash: true, width: 0.6 }))], points: basePts,
          column: [{ title: tx("Impianto"), items: [...pivItems, ...stItems] },
            ...(pivots.some((p) => p.solar) ? [{ title: tx("Pivot solari"), items: pivots.map((p, k) => (p.solar ? { head: `P${k + 1} · ${n1(solarSize(p).kWp)} kWp`, lines: [`${solarSize(p).n} × ${solarCfg.wp} Wp · ${n1(pivotKw(p))} kW${solarSize(p).batt ? ` · ${solarSize(p).batt} kWh` : ""}`, `${tx("tara")} Ø ${n0(2 * solarSize(p).taraR)} m · ${(solarSize(p).taraM2 / 1e4).toFixed(2)} ha`] } : null)).filter(Boolean) as TvColItem[] }] : []),
            { title: tx("Tubo sotterraneo"), items: [...byDn.entries()].sort((a, b) => b[0] - a[0]).map(([dn, L]) => ({ head: dn ? `PE100 PN10 Ø${dn}` : tx("Tubo sotterraneo"), lines: [`${n0(L)} m`] })) }],
          cells: cellsBase(tx("Planimetria generale")) };
        // 2 — tubazioni
        const trenchItems: TvTrenchItem[] = [...byDn.keys()].filter((x) => x > 0).sort((a, b) => b - a).map((dn) => {
          const tr = TV.trench(dn), sandTop = Math.max(0.2, tr.cover - 0.15);
          return { title: `${tx("Tratto")} Ø${dn} · PE100 PN10`, w: tr.w, h: tr.h, sandTop, tape: Math.max(0.15, tr.cover - 0.4),
            objs: [{ k: "pipe", x: 0, y: tr.cover + tr.od / 2, r: tr.od / 2 }],
            notes: [tx("Ricoprimento sopra il tubo {c} m", { c: n2(tr.cover) }), tx("Letto di posa in sabbia 0,10 m"), tx("Rinfianco e copertura in sabbia (giallo)"), tx("Nastro segnalatore (arancio tratteggiato)"), tx("Rinterro con il terreno di scavo")] };
        });
        const trenchPages: TvDraw[] = [];
        for (let k = 0; k < trenchItems.length; k += 4) trenchPages.push({ kind: "trench", title: tx("Sezioni tipo di scavo"), items: trenchItems.slice(k, k + 4) });
        // profilo della linea più lunga, con la piezometrica dalla prevalenza alla presa
        const profPages: TvDraw[] = [];
        if (prof) {
          // un profilo per ogni linea con le quote (dalla più lunga), fino a 8
          const bests = lineIdx.map((i) => ({ i, pr: prof.get(i) })).filter((x) => x.pr && x.pr.z.filter((z) => z != null).length >= 3)
            .sort((a, b) => (b.pr!.d[b.pr!.d.length - 1] ?? 0) - (a.pr!.d[a.pr!.d.length - 1] ?? 0)).slice(0, 8);
          for (const best of bests) if (best.pr) {
            const pr = best.pr, zs = pr.z.map((z, k) => z ?? pr.z.slice(0, k).reverse().find((v) => v != null) ?? pr.z.find((v) => v != null) ?? 0) as number[];
            // piezometrica: dalla fine della linea (pressione del pivot più esigente) risalendo le perdite,
            // alzata quanto serve per tenere almeno 5 m d'acqua su tutto il profilo
            const pEnd = Math.max(...pivots.map((p) => pivotPressure(p) * 10.2), 20);
            const lossAt = (x: number) => runs.filter((r) => r.i === best.i).reduce((a, r) => a + (x >= r.d0 + r.L ? r.hf : x > r.d0 ? (r.hf * (x - r.d0)) / Math.max(1, r.L) : 0), 0);
            const Lend = pr.d[pr.d.length - 1] ?? 0, lossEnd = lossAt(Lend), raw = pr.d.map((dd) => zs[zs.length - 1] + pEnd + (lossEnd - lossAt(dd)));
            const lift = Math.max(0, ...raw.map((h, k) => zs[k] + 5 - h));
            const pts = pr.d.map((dd, k) => ({ d: dd, z: zs[k], hgl: raw[k] + lift }));
            const highs = aps.filter((a) => a.k === "S" && a.prog != null && a.z != null && runs.some((r) => r.i === best.i && `T${r.n}` === a.run)).map((a) => ({ d: a.prog!, z: a.z! }));
            const lows = aps.filter((a) => a.k === "V" && a.prog != null && a.z != null && runs.some((r) => r.i === best.i && `T${r.n}` === a.run)).map((a) => ({ d: a.prog!, z: a.z! }));
            const L = pr.d[pr.d.length - 1] ?? 1, tl = runs.filter((r) => r.i === best.i).map((r) => `T${r.n}`);
            profPages.push({ kind: "profile", title: `${tx("Profilo longitudinale")}${bests.length > 1 ? ` · ${tl[0] ?? ""}${tl.length > 1 ? "–" + tl[tl.length - 1] : ""}` : ""}`, sub: `${tl[0] ?? ""}${tl.length > 1 ? "–" + tl[tl.length - 1] : ""} · ${n0(L)} m`, L, pts, highs, lows,
              labT: tx("terreno"), labH: tx("linea piezometrica"), labA: tx("Valvole di sfiato / aria"), labD: tx("Scarichi invernali (gelo)") });
          }
        }
        const coordS = (q: number[]) => `${q[1].toFixed(6)}, ${q[0].toFixed(6)}`;
        const fitCount = new Map<string, number>(); nodes.forEach((nd) => fitCount.set(nd.type, (fitCount.get(nd.type) ?? 0) + 1));
        const sh2: TvSheet = { title: tx("Tavola delle tubazioni"), fields: fieldsTv, pivots: pivTv, vertices: false,
          lines: [...srcLines, ...runs.map((r) => ({ id: "p" + r.n, pts: r.pts.map(LLf), color: PIPE_C, dash: true, width: 0.7, lab: `T${r.n}${r.dn ? " · Ø" + r.dn : ""}` }))],
          points: basePts, nodes: nodes.map((nd) => ({ pt: LLf(nd.q), lab: `N${nd.n}` })), app: aps.map((a) => ({ pt: LLf(a.q), lab: a.tag, k: a.k })),
          column: [{ title: tx("Tratti delle tubazioni"), items: [{ head: `${runs.length} ${tx("Tratto").toLowerCase()} · ${n0(totL)} m`, lines: [...byDn.entries()].sort((a, b) => b[0] - a[0]).map(([dn, L]) => `Ø${dn} · ${n0(L)} m`) }] },
            { title: tx("Raccordi"), items: [...fitCount.entries()].map(([k, n]) => ({ head: `${k} · ${n}`, lines: [] })) },
            { title: tx("Valvole e apparecchiature"), items: [["S", tx("Valvole di sfiato / aria")], ["V", tx("Scarichi invernali (gelo)") + " / " + tx("Valvole di non ritorno")], ["I", tx("Idrovalvola")], ["M", tx("Misuratore di portata")]]
              .map(([k, l]) => ({ head: `${k} · ${l}`, lines: [`${aps.filter((a) => a.k === k).length}`] })) }],
          cells: cellsBase(tx("Tavola delle tubazioni")),
          tech: [{ title: tx("Tratti delle tubazioni"), blocks: [{ table: { w: [8, 14, 22, 10, 14, 10, 10, 10],
              cols: [{ t: tx("Tratto") }, { t: tx("Tipo") }, { t: tx("Materiale e classe") }, { t: "Ø (mm)", a: "r" }, { t: tx("Lunghezza") + " (m)", a: "r" }, { t: "l/s", a: "r" }, { t: "m/s", a: "r" }, { t: "hf (bar)", a: "r" }],
              rows: runs.map((r) => [`T${r.n}`, tx("Tubo sotterraneo"), "PE100 PN10 SDR17", r.dn ? String(r.dn) : "—", n0(r.L), r.q ? n1(r.q) : "—", r.q ? n2(vel(r)) : "—", r.hf ? n2(r.hf / 10.2) : "—"]) } }] },
            ...(nodes.length ? [{ title: tx("Nodi e raccordi"), blocks: [{ table: { w: [8, 22, 20, 26], cols: [{ t: tx("Nodo") }, { t: tx("Tipo") }, { t: "Ø (mm)" }, { t: tx("Coordinate (lat, lng)") }],
              rows: nodes.map((nd) => [`N${nd.n}`, nd.type, nd.dns.join(" × "), coordS(nd.q)]) } }] }] : []),
            { title: tx("Valvole e apparecchiature"), blocks: [{ table: { w: [7, 26, 9, 8, 11, 22, 9], cols: [{ t: tx("Sigla") }, { t: tx("Tipo") }, { t: "DN/Ø" }, { t: tx("Tratto") }, { t: tx("Progressiva (m)"), a: "r" }, { t: tx("Coordinate (lat, lng)") }, { t: tx("Quota (m)"), a: "r" }],
              rows: aps.map((a) => [a.tag, a.type, a.dn, a.run, a.prog != null ? n0(a.prog) : "—", coordS(a.q), a.z != null ? n1(a.z) : "—"]) } }] }],
          draw: [...trenchPages, ...profPages] };
        // 3 — linee elettriche
        const cabRows = cabs.map((c, k) => ({ c, n: k + 1, form: `3×${fx(c.S)} mm² ${c.mat}` }));
        const sh3: TvSheet = { title: tx("Tavola delle linee elettriche"), fields: fieldsTv, pivots: pivTv, vertices: false,
          lines: [...srcLines, ...runs.map((r) => ({ id: "p" + r.n, pts: r.pts.map(LLf), color: "#b9a58c", dash: true, width: 0.35 })),
            ...cabRows.filter((x) => x.c.coords && x.c.coords.length >= 2).map((x) => ({ id: "c" + x.n, pts: x.c.coords!.map(LLf), color: CAB_C, dash: true, width: 0.6, lab: `C${x.n} · ${x.form}`, labColor: [225, 29, 72] as RGB }))],
          points: basePts,
          column: [{ title: tx("Linee elettriche"), items: cabRows.map((x) => ({ head: `C${x.n} · ${x.c.name}`, lines: [`${x.form} · ${n0(x.c.L)} m · ${n1(x.c.kW)} kW · ${n1(x.c.I)} A · ${n1(x.c.dv)} %`] })) },
            { title: tx("Allacciamento elettrico"), items: [{ head: `${n0(G.kW)} kW · ${G.kva} kVA`, lines: [G.supply.toUpperCase()] }] }],
          cells: cellsBase(tx("Tavola delle linee elettriche")),
          tech: cabRows.length ? [{ title: tx("Linee elettriche"), blocks: [{ table: { w: [8, 30, 18, 8, 12, 10, 10, 10],
            cols: [{ t: tx("Linea") }, { t: tx("Tipo") }, { t: tx("Formazione") }, { t: "V", a: "r" }, { t: tx("Lunghezza") + " (m)", a: "r" }, { t: "kW", a: "r" }, { t: "A", a: "r" }, { t: tx("Caduta") + " (%)", a: "r" }],
            rows: cabRows.map((x) => [`C${x.n}`, x.c.name, x.form, "400", n0(x.c.L), n1(x.c.kW), n1(x.c.I), n2(x.c.dv)]) } }] }] : [],
          draw: cabRows.length ? [
            { kind: "trench", title: tx("Sezioni tipo di scavo"), items: [
              { title: tx("Scavo per cavo interrato (trincea 0,40 × 0,80 m)"), w: 0.4, h: 0.8, sandTop: 0.55, tape: 0.4, objs: [{ k: "cable", x: -0.05, y: 0.72 }, { k: "cable", x: 0.05, y: 0.72 }, { k: "tile", x: 0, y: 0.62, w: 0.3 }],
                notes: [tx("Cavi a 0,80 m di profondità, in trincea propria 0,40 m"), tx("Tegolo o lastra di protezione sopra i cavi"), tx("Nastro segnalatore (arancio tratteggiato)"), tx("Rinterro con il terreno di scavo")] },
              ...(runs.length ? (() => { const dn = Math.max(...runs.map((r) => r.dn), 110), tr = TV.trench(dn);
                return [{ title: tx("Cavo posato nello scavo del tubo (scavo comune, senza scavo in più)"), w: tr.w, h: tr.h, sandTop: Math.max(0.2, tr.cover - 0.15), tape: Math.max(0.15, tr.cover - 0.4),
                  objs: [{ k: "pipe" as const, x: -tr.w * 0.1, y: tr.cover + tr.od / 2, r: tr.od / 2 }, { k: "cable" as const, x: tr.w / 2 - 0.08, y: tr.h - 0.05 }, { k: "tile" as const, x: tr.w / 2 - 0.08, y: tr.h - 0.14, w: 0.14 }],
                  notes: [tx("Cavo nello scavo del tubo, a lato e sul fondo, con il tegolo sopra"), tx("Ricoprimento sopra il tubo {c} m", { c: n2(tr.cover) }), tx("Nastro segnalatore (arancio tratteggiato)")] }]; })() : [])] },
            { kind: "unif", title: tx("Schema unifilare"), note: tx("Schema indicativo: ogni utenza ha il suo interruttore nel quadro della fonte; sezioni, lunghezze e cadute dalle linee disegnate."),
              srcs: [{ cap: tx("Allacciamento elettrico").toUpperCase(), name: `${G.supply.toUpperCase()} · ${G.kva} kVA`, info: `${n0(G.kW)} kW`,
                loads: cabRows.map((x) => ({ name: x.c.name.split(" · ").pop() ?? x.c.name, info: `${n1(x.c.kW)} kW · ${n1(x.c.I)} A`, cab: `C${x.n} · ${x.form}`, cab2: `${n0(x.c.L)} m · ${n1(x.c.dv)} %` })) }] }] : [] };
        // 3b — canali da realizzare: tracciato, sezione tipo e profilo con fondo e pelo libero
        const CCt = canalCalcs().filter((k) => !k.c.exist && k.sec);
        const shCan: TvSheet | null = CCt.length ? { title: tx("Tavola dei canali"), fields: fieldsTv, pivots: pivTv, vertices: false,
          lines: CCt.map((k) => ({ id: "k" + (k.idx + 1), pts: k.c.geojson.coordinates.map(LLf), color: "#2E86AB", width: 1.1, lab: `K${k.idx + 1} · ${n0(k.ew?.len ?? k.c.length_m)} m` })),
          points: basePts,
          column: [{ title: tx("Canali"), items: CCt.map((k) => ({ head: `K${k.idx + 1} · ${n0(k.ew?.len ?? k.c.length_m)} m`, lines: [`${n0(k.q)} l/s · ${n2(k.S)}‰ · ${tx(lining(k.sec!.lin).label)}`, `b ${n2(k.sec!.b)} · y ${n2(k.sec!.y)} · f ${n2(k.sec!.fb)} m · v ${n2(k.sec!.v)} m/s`] })) }],
          cells: cellsBase(tx("Tavola dei canali")),
          tech: [{ title: tx("Canali"), blocks: [{ table: { w: [7, 10, 9, 10, 9, 9, 9, 10, 9, 10, 9],
            cols: [{ t: tx("Sigla") }, { t: tx("Lunghezza") + " (m)", a: "r" }, { t: "l/s", a: "r" }, { t: tx("Pendenza") + " (‰)", a: "r" }, { t: "b (m)", a: "r" }, { t: "y (m)", a: "r" }, { t: tx("franco") + " (m)", a: "r" }, { t: tx("ciglio") + " (m)", a: "r" }, { t: "v (m/s)", a: "r" }, { t: tx("Scavo") + " (m³)", a: "r" }, { t: tx("Rilevato") + " (m³)", a: "r" }],
            rows: CCt.map((k) => [`K${k.idx + 1}`, n0(k.ew?.len ?? k.c.length_m), n0(k.q), n2(k.S), n2(k.sec!.b), n2(k.sec!.y), n2(k.sec!.fb), n2(k.sec!.topW), n2(k.sec!.v), k.ew ? n0(k.ew.cut) : "—", k.ew ? n0(k.ew.fill) : "—"]) } },
            { kv: [[tx("Metodo"), tx("Manning, moto uniforme")], [tx("Rivestimento"), `${tx(lining(canalLin).label)} · n ${lining(canalLin).n} · v max ${n1(lining(canalLin).vmax)} m/s`],
              [tx("Movimenti di terra"), tx("argini con coronamento di 1 m")], [tx("Franco minimo"), `${n2(canalFb)} m`]] }] }],
          draw: [
            { kind: "chan", title: tx("Sezioni tipo dei canali"), items: CCt.slice(0, 4).map((k) => ({ title: `K${k.idx + 1} · ${n0(k.q)} l/s · ${n2(k.S)}‰`, b: k.sec!.b, y: k.sec!.y, fb: k.sec!.fb, m: k.sec!.m, lined: ["concr", "liner", "stone"].includes(k.sec!.lin),
              notes: [tx(lining(k.sec!.lin).label) + ` · n ${lining(k.sec!.lin).n}`, `v = ${n2(k.sec!.v)} m/s`, `${tx("ciglio")} ${n2(k.sec!.topW)} m`] })) },
            ...CCt.filter((k) => (k.c.profile?.length ?? 0) >= 3).slice(0, 4).map((k) => {
              const z0 = k.c.profile[0][1], bed0 = z0 - k.sec!.H;
              return { kind: "profile" as const, title: `${tx("Profilo longitudinale")} · K${k.idx + 1}`, sub: `K${k.idx + 1} · ${n0(k.ew?.len ?? k.c.length_m)} m · ${n2(k.S)}‰`, L: k.c.profile[k.c.profile.length - 1][0],
                pts: k.c.profile.map(([d, z]) => ({ d, z, hgl: bed0 - (k.S / 1000) * d + k.sec!.y })), highs: [], lows: [],
                labT: tx("terreno"), labH: tx("pelo libero"), labA: "", labD: "" };
            })] } : null;
        // 3c — fossi di scolo dei campi
        const DRt = drainCalcs().filter((d) => d.sec);
        const shDr: TvSheet | null = DRt.length ? { title: tx("Tavola dei fossi di scolo"), fields: fieldsTv, pivots: pivTv, vertices: false,
          lines: DRt.map((d) => ({ id: "f" + d.n, pts: d.ring.map(LLf), color: "#8a6d3b", dash: true, width: 0.9, lab: `F${d.n} · ${n0(d.q)} l/s` })),
          points: basePts,
          column: [{ title: tx("Fossi di scolo"), items: DRt.map((d) => ({ head: `F${d.n} · ${d.f.name}`, lines: [`${n1(d.ha)} ha · ${n0(d.q)} l/s · ${n0(d.L)} m`, `b ${n2(d.sec!.b)} · y ${n2(d.sec!.y)} · ${tx("ciglio")} ${n2(d.sec!.topW)} m`] })) }],
          cells: cellsBase(tx("Tavola dei fossi di scolo")),
          tech: [{ title: tx("Fossi di scolo"), blocks: [{ table: { w: [8, 22, 9, 9, 10, 9, 9, 10, 9, 10],
            cols: [{ t: tx("Sigla") }, { t: tx("Campo") }, { t: "ha", a: "r" }, { t: "l/s", a: "r" }, { t: tx("Lunghezza") + " (m)", a: "r" }, { t: "b (m)", a: "r" }, { t: "y (m)", a: "r" }, { t: tx("ciglio") + " (m)", a: "r" }, { t: "v (m/s)", a: "r" }, { t: tx("Scavo") + " (m³)", a: "r" }],
            rows: DRt.map((d) => [`F${d.n}`, d.f.name, n1(d.ha), n0(d.q), n0(d.L), n2(d.sec!.b), n2(d.sec!.y), n2(d.sec!.topW), n2(d.sec!.v), n0(d.cut)]) } },
            { kv: [[tx("Coefficiente di drenaggio"), `${n2(drainC)} mm/24h · ${n2(drainC / 8.64)} l/s·ha`], [tx("Pendenza"), `${n1(drainS)}‰`]] }] }],
          draw: [{ kind: "chan", title: tx("Sezione tipo dei fossi di scolo"), items: DRt.slice(0, 4).map((d) => ({ title: `F${d.n} · ${n0(d.q)} l/s`, b: d.sec!.b, y: d.sec!.y, fb: d.sec!.fb, m: d.sec!.m, lined: false,
            notes: [tx("Terra inerbita") + " · n 0,03", `v = ${n2(d.sec!.v)} m/s`] })) }] } : null;
        // 4 — fasi di realizzazione (pivot colorati per fase)
        const PH_RGB: RGB[] = [[46, 224, 160], [0, 159, 227], [245, 158, 11], [225, 29, 72], [139, 92, 246], [16, 185, 129], [236, 72, 153], [99, 102, 241], [234, 179, 8], [20, 184, 166]];
        const shPh: TvSheet | null = nPhases > 1 ? { title: tx("Fasi di realizzazione"), fields: fieldsTv, vertices: false,
          pivots: pivTv.map((pv, k) => ({ ...pv, fill: PH_RGB[((pivots[k].phase ?? 1) - 1) % PH_RGB.length], line2: `${tx("Fase")} ${pivots[k].phase ?? 1} · ${pv.line2 ?? ""}` })),
          lines: [...srcLines, ...runs.map((r) => ({ id: "p" + r.n, pts: r.pts.map(LLf), color: "#9aa5b1", dash: true, width: 0.45 }))], points: basePts,
          column: [{ title: tx("Fasi di realizzazione"), items: phaseSummary().map((r) => ({ head: `${tx("Fase")} ${r.ph}${r.ph === 1 ? ` (${tx("con le opere comuni")})` : ""}`,
            lines: [`${r.nPiv} pivot · ${n1(r.ha)} ha · ${n0(r.qLs)} l/s`, pivots.map((p, k) => ((p.phase ?? 1) === r.ph ? `P${k + 1}` : "")).filter(Boolean).join(", ")] })) }],
          cells: cellsBase(tx("Fasi di realizzazione")) } : null;
        // 5 — particolari costruttivi tipo
        const NOTES: Record<string, [string, string[]]> = {
          pivot: [tx("Attacco del pivot"), [tx("Condotta interrata in PE100 dalla rete"), tx("Blocco di ancoraggio in calcestruzzo sulla curva"), tx("Idrovalvola master con comando idraulico"), tx("Pilota e filtro di comando dell'idrovalvola"), tx("Torre centrale del pivot con giunto rotante"), tx("Plinti di fondazione della torre centrale")]],
          air: [tx("Pozzetto di sfiato"), [tx("Condotta in PE100"), tx("Tee con derivazione verticale"), tx("Saracinesca di intercettazione"), tx("Sfiato a doppio effetto"), tx("Pozzetto in calcestruzzo con fondo drenante"), tx("Chiusino carrabile")]],
          drain: [tx("Pozzetto di scarico"), [tx("Condotta in PE100"), tx("Derivazione di scarico dal fondo del tubo"), tx("Saracinesca di scarico"), tx("Pozzo perdente in ghiaia o scarico nel fosso"), tx("Pozzetto in calcestruzzo con fondo drenante"), tx("Chiusino carrabile")]],
          station: [tx("Stazione di pompaggio (pianta)"), [tx("Pompa (vedi schede tecniche)"), tx("Valvola di non ritorno"), tx("Saracinesca di mandata"), tx("Collettore di mandata"), tx("Misuratore di portata"), tx("Collettore di aspirazione"), tx("Quadro elettrico di comando e protezione")]],
          pond: [tx("Sezione della vasca di accumulo"), [tx("Argine in terra compattata con strada di servizio in sommità"), tx("Scarpate interne 1:2 con telo impermeabile"), tx("Livello massimo dell'acqua"), tx("Fondo della vasca"), tx("Franco di sicurezza 0,5 m")]],
        };
        // piazzola del pivot, stazioni di pompaggio e vasca: i disegni delle opere di Ceres (più sotto);
        // qui restano i pozzetti della rete, che Ceres non disegna
        const detKeys = (runs.length ? ["air", "drain"] : []) as ("pivot" | "air" | "drain" | "station" | "pond")[];
        const nPumpMax = Math.max(2, ...stations.map((st) => st.nTot));
        const shDet: TvSheet | null = detKeys.length ? { title: tx("Pozzetti della rete"), noMap: true, fields: [], pivots: [], lines: [], points: [], column: [], cells: [],
          draw: [{ kind: "details", title: tx("Pozzetti di sfiato e di scarico"), items: detKeys.map((k) => ({ key: k, title: NOTES[k][0], notes: NOTES[k][1], n: nPumpMax })) }] } : null;
        // 6 — schede tecniche: curve delle pompe e campate dei pivot (solo nel progetto completo)
        const PIPE_TXT = ['10"', '8"5/8', '6"5/8'], PIPE_W = [1.3, 0.85, 0.5];
        const curveItems = stations.filter((st) => st.pick).map((st) => {
          const pk = st.pick!, rec = (capRef.current ?? []).find((c) => c[1] === pk.model && c[2] === pk.rpm);
          return { name: `${st.name} · Caprari ${pk.model}`, sub: `${st.nTot > 1 ? `${st.nTot} × ` : ""}${pk.model} · ${fx(pk.rpm)} ${tx("giri/min")} · ${tx("motore")} ${n1(pk.motor)} kW${pk.diesel ? " diesel" : ""} · ${tx("rendimento")} ${n0(pk.eta)} % · ${n1(st.qLs)} l/s · ${n0(st.head)} m`,
            pts: (rec?.[4] ?? []) as number[][], q: pk.q, H: pk.H };
        }).filter((it) => it.pts.length >= 2);
        const spanItems = pivots.map((pv, k) => { const c = spanComposition(pv, pivotBrand);
          return c ? { name: `P${k + 1}`, info: `R ${n0(pv.r)} m · ${c.spans.length} ${tx("campate")} · ${n1(pivotFlow(pv))} l/s · ${n1(pivotPressure(pv))} bar`,
            spans: c.spans.map((sp) => ({ len: sp.len, d: PIPE_TXT[sp.pipe] ?? "", w: PIPE_W[sp.pipe] ?? 0.5 })), oh: c.oh, gun: pv.gun ?? 0 } : null; }).filter(Boolean) as { name: string; info: string; spans: { len: number; d: string; w: number }[]; oh: number; gun: number }[];
        const schDraw: TvDraw[] = [];
        for (let k = 0; k < curveItems.length; k += 4) schDraw.push({ kind: "curve", title: tx("Curve delle pompe e punto di lavoro"), items: curveItems.slice(k, k + 4),
          labQ: tx("Portata Q (m³/h)"), labH: tx("Prevalenza H (m)"), labEta: tx("Rendimento (%)"), labSys: tx("Curva dell'impianto"), labDuty: tx("Punto di lavoro") });
        for (let k = 0; k < spanItems.length; k += 12) schDraw.push({ kind: "spans", title: tx("Composizione delle campate dei pivot"), items: spanItems.slice(k, k + 12),
          labTower: tx("Torre"), labOh: tx("Sbalzo"), labGun: tx("Irrigatore finale") });
        // uniformità dei pivot (una riga per macchina diversa) e pivot solari mese per mese
        const cuRows = new Map<string, string[]>();
        pivots.forEach((pv, k) => { const u = pivotCU(pv); if (!u) return; const key = `${n0(pv.r)}|${n1(u.CU)}|${n0(u.peak)}`;
          const row = cuRows.get(key); if (row) { row[0] += `, P${k + 1}`; return; }
          cuRows.set(key, [`P${k + 1}`, n0(pv.r), u.model, String(u.n), n1(u.CU), n1(u.DU), n0(u.peak), tx(cuGrade(u.CU))]); });
        const cuTech: TvTech[] = cuRows.size ? [{ title: tx("Uniformità di distribuzione dei pivot"), blocks: [{ table: { w: [20, 9, 20, 8, 9, 9, 12, 13],
          cols: [{ t: tx("Pivot") }, { t: "R (m)", a: "r" }, { t: tx("Irrigatori") }, { t: tx("uscite"), a: "r" }, { t: "CU (%)", a: "r" }, { t: "DU (%)", a: "r" }, { t: tx("picco") + " (mm/h)", a: "r" }, { t: tx("Giudizio") }],
          rows: [...cuRows.values()].map((r) => [r[0].length > 40 ? r[0].slice(0, 38) + "…" : r[0], ...r.slice(1)]) } },
          { kv: [[tx("Metodo"), tx("Sprinkler chart generato: uscite a passo costante, portata proporzionale a raggio × larghezza di competenza, ugello commerciale arrotondato; profilo ellittico, CU Heermann-Hein e DU sul quarto più basso (ASABE S436)")]] }] }] : [];
        const solP0 = pivots.map((pv, k) => ({ pv, k })).filter((x) => x.pv.solar);
        const solTech: TvTech[] = solP0.length ? (() => { const sm = pivotSolarMonths(solP0[0].pv); if (!sm) return [];
          const ml = (i: number) => { try { return new Date(2026, i, 15).toLocaleString(pdfLang, { month: "short" }); } catch { return String(i + 1); } };
          return [{ title: tx("Pivot solari: produzione e ore di marcia mese per mese"), blocks: [{ table: { w: [16, ...Array(12).fill(7)],
            cols: [{ t: `P${solP0[0].k + 1}` }, ...sm.rows.map((r) => ({ t: ml(r.m), a: "r" as const }))],
            rows: [[tx("FV") + " kWh/g", ...sm.rows.map((r) => n0(r.E))], [tx("sole sufficiente") + " h", ...sm.rows.map((r) => n1(r.hSun))], [tx("marcia") + " h", ...sm.rows.map((r) => (r.hNeed > 0.05 ? n1(r.hNeed) : "—"))],
              [tx("batteria") + " kWh", ...sm.rows.map((r) => (r.battNeed > 0.5 ? n0(r.battNeed) : "—"))]] } },
            { kv: [[tx("Campo FV"), `${n1(sm.z.kWp)} kWp · ${sm.z.n} × ${solarCfg.wp} Wp · ${n1(sm.z.kW)} kW`], [tx("Metodo"), tx("Irraggiamento medio mensile del sito (NASA POWER) sul piano dei moduli (+10%), rendimento d'impianto 0,80, potenza a mezza sinusoide sulla durata del giorno")]] }] }]; })() : [];
        const progTech: TvTech[] = (() => { const IP = irrigProgram(); if (!IP) return [];
          const ml = (i: number) => { try { return new Date(2026, i, 15).toLocaleString(pdfLang, { month: "short" }); } catch { return String(i + 1); } };
          const on = IP.rows.filter((r) => r.G > 0); if (!on.length) return [];
          return [{ title: tx("Programma irriguo mese per mese"), blocks: [{ table: { w: [16, ...on.map(() => Math.max(5, Math.floor(84 / on.length)))],
            cols: [{ t: `P${pivots.indexOf(IP.pv) + 1}` }, ...on.map((r) => ({ t: ml(r.m), a: "r" as const }))],
            rows: [["mm/g", ...on.map((r) => n1(r.G))], [tx("ore/giorno"), ...on.map((r) => n0(r.h))], [tx("dose") + " mm", ...on.map((r) => n0(r.D))], [tx("timer") + " %", ...on.map((r) => n0(r.timer))], [tx("giro") + " h", ...on.map((r) => n0(r.T))], [tx("giri/sett."), ...on.map((r) => n1(r.perWeek))]] } },
            { kv: [[tx("Suolo"), soilSat ? `${tx(soilOf(soilSat.key).label)} · ${soilSat.usda} · ${n0(soilSat.taw_mm_m)} mm/m` : tx(soilOf(soilKey).label)], [tx("Assorbimento"), `${n1(infiltration)} mm/h`]] }] }]; })();
        const shSch: TvSheet | null = out?.full && (schDraw.length || stations.length || cuTech.length || solTech.length || progTech.length) ? { title: tx("Schede tecniche"), noMap: true, fields: [], pivots: [], lines: [], points: [], column: [], cells: [],
          tech: [...cuTech, ...progTech, ...solTech, ...(stations.length ? [{ title: tx("Pompe"), blocks: [{ table: { w: [24, 22, 6, 9, 10, 9, 10, 10],
            cols: [{ t: tx("Stazione") }, { t: tx("Pompa") }, { t: "n.", a: "r" }, { t: tx("giri/min"), a: "r" }, { t: "Q (l/s)", a: "r" }, { t: "H (m)", a: "r" }, { t: tx("Motore") + " (kW)", a: "r" }, { t: tx("Rendimento") + " (%)", a: "r" }],
            rows: stations.map((st) => [st.name, st.pick ? `Caprari ${st.pick.model}` : "—", fx(st.nTot), st.pick ? fx(st.pick.rpm) : "—", n1(st.qLs), n0(st.head), st.pick ? n1(st.pick.motor) : n1(st.kW), st.pick ? n0(st.pick.eta) : "—"]) } }] } as TvTech] : [])],
          draw: schDraw } : null;
        // 7 — computo metrico con i rimandi alle sigle delle tavole (solo nel progetto completo)
        const nPipe = 2, nElec = runs.length ? 3 : 2;
        const lst = (a: string[]) => (a.length > 8 ? a.slice(0, 8).join(", ") + " …" : a.join(", "));
        const tvRef = (n: number, a: string[]) => (a.length ? `${tx("Tav.")} ${String(n).padStart(2, "0")} · ${lst(a)}` : "");
        const refOf = (key?: string): string => {
          if (!key) return "";
          const [k, v] = key.split(/:(.*)/s);
          if (k === "pivot") return `${tx("Tav.")} 01 · P1${pivots.length > 1 ? "–P" + pivots.length : ""}`;
          if (k === "pipe") return tvRef(nPipe, runs.filter((r) => String(r.dn) === v).map((r) => `T${r.n}`));
          if (k === "air") return tvRef(nPipe, aps.filter((a) => a.k === "S" && a.dn === `Ø${v}`).map((a) => a.tag));
          if (k === "drain") return tvRef(nPipe, aps.filter((a) => a.tag.startsWith("D")).map((a) => a.tag));
          if (k === "mv") return tvRef(nPipe, pivots.map((p, i) => (String(pivotRiser(p).mv) === v ? `I${i + 1}` : "")).filter(Boolean));
          if (k === "tee") return tvRef(nPipe, nodes.filter((nd) => nd.dns.length >= 1 && nd.type !== tx("Riduzione") && String(nd.dns[0]) === v).map((nd) => `N${nd.n}`));
          if (k === "red") { const [mx, mn] = v.split("x"); return tvRef(nPipe, nodes.filter((nd) => nd.type === tx("Riduzione") && String(nd.dns[0]) === mx && String(nd.dns[nd.dns.length - 1]) === mn).map((nd) => `N${nd.n}`)); }
          if (k === "cable") return tvRef(nElec, cabs.map((c, i) => (`${c.mat} 3×${fx(c.S, { maximumFractionDigits: 1 })} mm²` === v ? `C${i + 1}` : "")).filter(Boolean));
          if (k === "pump") { const i = stations.findIndex((st) => st.name === v); return i >= 0 ? `${tx("Schede tecniche")} · NR${i + 1}, M${i + 1}` : ""; }
          return "";
        };
        const cRows = out?.full ? computoRows() : [];
        const cats = [...new Set(cRows.map((r) => r.cat))];
        const shCmp: TvSheet | null = cRows.length ? { title: tx("Computo metrico"), noMap: true, fields: [], pivots: [], lines: [], points: [], column: [], cells: [],
          tech: [{ title: tx("Computo metrico delle opere"), blocks: cats.map((c) => ({ h: c, table: { w: [36, 10, 7, 21, 26],
            cols: [{ t: tx("Voce") }, { t: tx("Quantità"), a: "r" as const }, { t: tx("Unità") }, { t: tx("Rif. tavole") }, { t: tx("Note") }],
            rows: cRows.filter((r) => r.cat === c).map((r) => [r.item, r.qty == null ? "—" : fx(r.qty), r.unit, refOf(r.key), r.note ?? ""]) } })) }] } : null;
        const common: TvCommon = { format: pdfFormat, compact: tvCompact, brand: "Argus Total", brandSub: "by Nabu · Agrostar Group", version: REV, logo,
          coordsTitle: tx("COORDINATE GPS"), centroidLabel: tx("Centro campo"), client: cname, rev: String(rev),
          footer: `© ${new Date().getFullYear()} Nabu srl · Agrostar Group · Argus Total ${REV} · ${tx("esportato il")} {d}`,
          disclaimer: tx("I risultati sono stime a scopo di progettazione preliminare e non sostituiscono la verifica di un tecnico qualificato. Dati da confermare sul campo.") };
        // ---- disegni delle opere di Ceres (stesso motore): piazzola del pivot, stazioni, pompa verticale, vasca, gruppo elettrogeno
        const wkJobs: { type: string; ctx: Record<string, unknown>; name: string }[] = [];
        {
          const grp = new Map<string, { ctx: Record<string, unknown>; names: string[] }>();
          pivots.forEach((pv, k) => {
            const c = spanComposition(pv, pivotBrand), dm = c && c.spans.length ? Math.max(...c.spans.map((sp) => PIPE_MM[sp.pipe] ?? 168)) : 0;
            const ctx = { mk: pivotBrand, pp: "fix", prof: "std", tube: dm >= 200 ? 254 : dm > 0 && dm < 160 ? 168 : 203, pivDn: pivotRiser(pv).mv };
            const key = JSON.stringify(ctx); const g = grp.get(key) ?? grp.set(key, { ctx, names: [] }).get(key)!; g.names.push(`P${k + 1}`);
          });
          for (const g of grp.values()) wkJobs.push({ type: "pad", ctx: g.ctx, name: g.names.join(", ") });
          const sg = new Map<string, { ctx: Record<string, unknown>; names: string[]; vert: boolean }>();
          stations.forEach((st) => {
            const pk = st.pick; if (!pk) return;
            const kind = pk.diesel ? "moto" : pk.fam === "vert" ? "vert" : pk.fam === "subm" ? "subm" : "horiz";
            const atRes = !!(resPt && st.pt && distM(st.pt, resPt) < 30), inst = st.well ? "well" : kind === "vert" ? "sump" : atRes ? "flooded" : "bank";
            const ctx = { kind, model: pk.model, motorKw: pk.motor, stKw: pk.motor, motoKw: pk.motor, stN: st.nTot, motoN: st.nTot, stQ: Math.round(st.qLs * 10) / 10, rpm: pk.rpm,
              water: st.well ? "well" : "surf", drive: pk.diesel ? "diesel" : "el", inst, ...(atRes && sc?.res ? { rvType: "earth" } : {}) };
            const key = JSON.stringify(ctx); const g = sg.get(key) ?? sg.set(key, { ctx, names: [], vert: kind === "vert" }).get(key)!; g.names.push(st.name);
          });
          for (const g of sg.values()) { wkJobs.push({ type: "station", ctx: g.ctx, name: g.names.join(" · ") }); if (g.vert) wkJobs.push({ type: "vpump", ctx: g.ctx, name: String(g.ctx.model) }); }
          if (sc?.res && S) {
            const fillQ = Math.round((sc.key === "B" ? sc.stages[0].qLs : S.Qd) * 3.6 * 10) / 10;
            wkJobs.push({ type: "reservoir", ctx: { rv: { ok: true, type: "earth", V: sc.res.vol, H: resDepth, Q: Math.round((stations.filter((st) => st.pt && resPt && distM(st.pt, resPt) < 30).reduce((x, st) => x + st.qLs, 0) || S.Qd) * 3.6), Vday: Math.round(sc.res.vol / Math.max(1, sc.res.days || resDays)), days: Math.max(1, sc.res.days || resDays), fillQ, soil: "loam", mode: "eff" },
              dnIn: sc.main?.dn ?? 0, dnOut: runs.length ? Math.max(...runs.map((r) => r.dn)) : 0 }, name: `${n0(sc.res.vol)} m³` });
          }
          if (G.supply === "gen") wkJobs.push({ type: "gen", ctx: { kva: G.kva }, name: `${G.kva} kVA` });
        }
        type Ent = [TvKind, TvSheet | null, number?];
        const all: Ent[] = [["plan", sh1], ["pipe", runs.length ? sh2 : null], ["elec", cabRows.length ? sh3 : null], ["can", shCan], ["dr", shDr], ["phase", shPh], ["det", shDet],
          ...wkJobs.map((_, i) => ["wk", null, i] as Ent), ["sch", shSch], ["cmp", shCmp]];
        const kept = all.filter((x) => x[1] || x[0] === "wk");
        let nT = 0; const codes: string[] = [], titles: string[] = [];
        kept.forEach(([k, sh, wi]) => {
          if (k === "sch" || k === "cmp") { codes.push(elabCode(pid, k, 1)); sh!.title = `${sh!.title} · ${codes[codes.length - 1]}`; titles.push(sh!.title); return; }
          nT++; codes.push(elabCode(pid, k, nT));
          if (k === "wk") { const j = wkJobs[wi!], WKN: Record<string, string> = { pad: tx("Piazzola del pivot"), station: tx("Stazione di pompaggio"), vpump: tx("Pompa verticale"), reservoir: tx("Vasca di accumulo"), gen: tx("Basamento del gruppo elettrogeno") };
            titles.push(`${tx("Tav.")} ${String(nT).padStart(2, "0")} · ${WKN[j.type] ?? j.type} · ${j.name}`); return; }
          sh!.title = `${tx("Tav.")} ${String(nT).padStart(2, "0")} · ${sh!.title}`; titles.push(sh!.title);
          if (sh!.cells.length) sh!.cells[1] = [sh!.cells[1][0], `${codes[codes.length - 1]} · ${sh!.cells[1][1].split(" · ")[0]}`];
        });
        const kinds = kept.map((x) => x[0]);
        const iWk = kinds.indexOf("wk"), iTail = kinds.findIndex((k) => k === "sch" || k === "cmp");
        const sheetsA = kept.filter((x) => x[1] && x[0] !== "sch" && x[0] !== "cmp").map((x) => x[1]!), sheetsB = kept.filter((x) => x[0] === "sch" || x[0] === "cmp").map((x) => x[1]!);
        const wkMeta = kept.map((x, i) => (x[0] === "wk" ? { job: wkJobs[x[2]!], code: codes[i], tav: titles[i].split(" · ")[0] } : null)).filter(Boolean) as { job: { type: string; ctx: Record<string, unknown>; name: string }; code: string; tav: string }[];
        void iWk; void iTail;
        const sheets = [...sheetsA, ...sheetsB];
        return { sheets, sheetsA, sheetsB, wkMeta, common, kinds, codes, titles, cname, rev, date: new Date().toISOString().slice(0, 10) };
      });
      void sheets;
      if (out) { out.kinds = kinds; out.codes = codes; out.titles = titles; out.lang = lng; }
      // le tavole di Argus, poi i disegni delle opere di Ceres (A3, con il loro computo dei materiali), poi schede e computo
      const buildAll = async (): Promise<Blob> => {
        const parts: ArrayBuffer[] = [await (await TV.buildTavole(sheetsA, common)).arrayBuffer()];
        if (wkMeta.length) {
          const WK = await import("@/lib/ceres-wk/wk.js");
          const I = (await import("@/lib/ceres-wk/i18n.json")).default as Record<string, Record<string, string>>;
          const TT = (k: string) => I[k]?.[lng] ?? I[k]?.en ?? I[k]?.it ?? k;
          const disc = TT("wk_disc").replace(/Ceres/g, "Argus Total (Ceres)");
          for (const m of wkMeta) {
            const ty = m.job.type, par = WK.wkDefaults(ty, m.job.ctx), sh = WK.wkBuild(ty, par, TT);
            const ttl = `${m.tav} · ${TT("wk_t_" + ty)} · ${m.job.name}`;
            const meta = { title: ttl, sub: [wkCli, m.code, m.job.name].filter(Boolean).join(" · "), app: "Argus Total", by: "by Nabu · Agrostar Group", ver: `${TT("sp_mWorks") !== "sp_mWorks" ? TT("sp_mWorks") : ""} · ${REV}`,
              logo: common.logo, foot1: `Argus Total ${REV} · © ${new Date().getFullYear()} Nabu · Agrostar Group`, disc, notesT: TT("wk_notesT"), qtyT: TT("wk_qtyT"), brand: "Argus Total · Agrostar Group",
              cells: [[tx("Cliente"), wkCli || "—"], [tx("Riferimento"), m.code], [TT("wk_bSheet"), `${TT("wk_t_" + ty)} · ${m.job.name}`], [TT("wk_bScale"), TT("wk_scaleV")], [`${tx("Data")} · REV.`, `${wkDate} · Rev. ${wkRev}`]],
              cellW: [0.2, 0.17, 0.33, 0.14, 0.16] };
            try { parts.push(WK.wkPdf(sh, meta).output("arraybuffer")); } catch (e) { console.error(e); }
          }
        }
        if (sheetsB.length) parts.push(await (await TV.buildTavole(sheetsB, common)).arrayBuffer());
        if (parts.length === 1) return new Blob([parts[0]], { type: "application/pdf" });
        const { PDFDocument } = await import("pdf-lib");
        const outDoc = await PDFDocument.load(parts[0]);
        for (const b of parts.slice(1)) { const d2 = await PDFDocument.load(b); (await outDoc.copyPages(d2, d2.getPageIndices())).forEach((pg) => outDoc.addPage(pg)); }
        return new Blob([await outDoc.save()], { type: "application/pdf" });
      };
      if (out?.defer) { out.build = buildAll; return; }
      const blob = await buildAll();
      if (out) { out.blob = blob; return; }
      const pname = (projects.find((x) => x.id === pid)?.name || "Argus").replace(/[^\w\-]+/g, "_");
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `Tavole_${pname}_${pdfFormat.toUpperCase()}_${REV}.pdf`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      setMsg(t("Tavole PDF pronte ✓"));
    } catch (e) { if (out) throw e; setMsg(`${t("Errore generazione PDF")}: ${String((e as Error)?.message ?? e)}`); }
    finally { if (!out) setBusy(""); }
  }
  async function downloadRelazione(opt?: { tav?: TavOut; out?: { blob?: Blob } }) {
    if (!projectId || (!pivots.length && !Object.keys(sysDesigns).length)) { setMsg(t("Posa prima i pivot sul campo attivo.")); return; }
    const pid = projectId;
    if (!opt?.out) setBusy("rel");
    try {
      ensureHydra(); await ensureProfile();
      // dati meteorologici mensili del sito (NASA POWER + ET₀ Penman-Monteith), anche senza layout dei campi
      let meteo: api.SiteClimate | null = null;
      {
        meteo = await siteClimateCached();
      }
      const rev = docRev();
      const company = relBrand === "nabu" ? "Nabu srl" : "Agrostar srl";
      let bbox: number[] | null = null;
      const doc = inLang(pdfLang, () => {
        const n0 = (x: number) => fx(Math.round(x)), n1 = (x: number) => fx(x, { maximumFractionDigits: 1 }), n2 = (x: number) => fx(x, { maximumFractionDigits: 2 });
        const pname = projects.find((x) => x.id === pid)?.name || "Argus Total", cname = clients.find((c) => c.id === clientId)?.name || "";
        const d = new Date(), date = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
        const P = pumpStation(), VM = variantMetrics(), HY = hydraNow(), NF = netFittings(HY);
        const S = srcPt && pivots.length ? sourceSchemes() : null;
        const sc = S ? (S.schemes.find((x) => x.key === (srcShown ?? S.best?.key)) ?? null) : null;
        const stations = pumpStationsList(), cabs = cableRuns(stations), G = powerGear(stations);
        const plan = mercuriusComputo(`ARGUS-${pid}`, rev).planimetria as { riquadro?: { ovest: number; sud: number; est: number; nord: number }; elementi?: { features?: { properties?: { tipo?: string } }[] } } | undefined;
        const feats = plan?.elementi?.features ?? [];
        if (plan?.riquadro) bbox = [plan.riquadro.ovest, plan.riquadro.sud, plan.riquadro.est, plan.riquadro.nord];
        const usedF = fields.filter((f) => pivots.some((p) => p.field === f.id) || Object.keys(sysDesigns).some((k) => fieldOfKey(k)?.id === f.id));
        const fieldsShown = usedF.length ? usedF : fields;
        const gross = fieldsShown.reduce((a, f) => a + ringAreaHa(f.geom.coordinates), 0);
        const pts = pivots.length ? pivots.map((p) => [p.lng, p.lat]) : fieldsShown.flatMap((f) => f.geom.coordinates[0]);
        const lon = pts.reduce((a, q) => a + q[0], 0) / Math.max(1, pts.length), lat = pts.reduce((a, q) => a + q[1], 0) / Math.max(1, pts.length);
        const dms = (v: number, pos: string, neg: string) => { const a = Math.abs(v), dd = Math.floor(a), mm = Math.floor((a - dd) * 60), ss = ((a - dd) * 60 - mm) * 60; return `${dd}°${String(mm).padStart(2, "0")}′${ss.toFixed(1)}″${v >= 0 ? pos : neg}`; };
        const PIPE_TXT = ['10"', '8"5/8', '6"5/8'];
        const cropLbl = tx((pivots.length ? designCrops : cropsOf(fieldsShown))[0].label);
        const month = (i: number) => { try { return new Date(2026, i, 15).toLocaleString(pdfLang, { month: "short" }); } catch { return String(i + 1); } };
        const monthLong = (i: number) => { try { return new Date(2026, i, 15).toLocaleString(pdfLang, { month: "long" }); } catch { return String(i + 1); } };
        // Indice come le relazioni tecniche Agrostar (General Explanatory Note)
        const ch: { title: string; blocks: Record<string, unknown>[] }[] = [];
        const nSys = Object.keys(sysDesigns).length;
        // 1 — Introduzione
        ch.push({ title: tx("Introduzione"), blocks: [
          { p: tx("La presente relazione tecnica generale descrive il progetto dell'impianto di irrigazione «{p}» per {c} e costituisce parte integrante della documentazione di progetto.", { p: pname, c: cname || tx("il committente") }) },
          { p: tx("Il documento riassume le condizioni di partenza, le ipotesi di progetto e le soluzioni tecniche adottate: inquadramento del sito, clima e fabbisogno irriguo, portata di progetto, fonte d'acqua, disposizione delle macchine, rete di distribuzione, stazioni di pompaggio e alimentazione elettrica.") },
          { p: tx("L'impianto irriga {ha} ha con {n} pivot e richiede una portata di progetto di {q} l/s.", { ha: n1(VM.ha), n: fx(pivots.length), q: n0(P.qDes) })
            + (nSys ? " " + tx("Sono previsti inoltre {k} campi con sistemi lineari, a rotolone o a goccia.", { k: fx(nSys) }) : "") },
          { p: tx("Il progetto si propone di:") },
          { bullets: [tx("distribuire l'acqua in modo uniforme ed efficiente su tutta la superficie irrigata;"), tx("dimensionare rete, pompe e linee elettriche sulla domanda di punta della coltura più esigente;"),
            tx("contenere i consumi di energia con pompe scelte per rendimento al punto di lavoro;"), tx("rendere l'impianto realizzabile per fasi e semplice da gestire e mantenere.")] },
          { p: tx("Il documento è rivolto al committente, ai progettisti e ai soggetti coinvolti nella valutazione e nella realizzazione dell'impianto. Le condizioni economiche sono riportate nell'offerta.") },
        ] });
        // 2 — Inquadramento geografico
        ch.push({ title: tx("Inquadramento geografico"), blocks: [
          { p: tx("Il sito di progetto si trova alle coordinate {lat}, {lon} (WGS84). L'area comprende {nf} appezzamenti per una superficie lorda di {g} ha, di cui {ha} ha irrigati.", { lat: dms(lat, "N", "S"), lon: dms(lon, "E", "W"), nf: fx(fieldsShown.length), g: n1(gross), ha: n1(VM.ha) }) },
          { figure: "site", caption: tx("Inquadramento dell'area di progetto su ortofoto") },
          { table: { header: [tx("Campo"), tx("Superficie lorda") + " (ha)", tx("Superficie irrigata") + " (ha)", tx("Pivot")], widths: [40, 20, 20, 20],
            rows: fieldsShown.map((f) => { const pv = pivots.filter((p) => p.field === f.id); return [f.name, n1(ringAreaHa(f.geom.coordinates)), n1(pv.reduce((a, p) => a + pvAreaM2(p) / 10000, 0)), fx(pv.length)]; }) } },
          { p: tx("Le superfici sono misurate sui confini digitalizzati dei campi; le quote del terreno derivano dal modello digitale del terreno Copernicus ({m} m).", { m: demModel === "COPERNICUS_90" ? "90" : "30" }) },
        ] });
        // dati climatici del sito (dal layout dei campi)
        const clim = P.clim ?? (meteo ? { eto_month_mm: meteo.eto_month_mm, rain_month_mm: meteo.rain_month_mm, source: meteo.source } : null);
        const eto = clim?.eto_month_mm ?? null, rain = clim?.rain_month_mm ?? null;
        const months12 = Array.from({ length: 12 }, (_, i) => month(i));
        const srcClim = clim?.source ?? meteo?.source ?? "NASA POWER";
        const seasonIdx = eto ? eto.map((_, i) => i).filter((i) => eto[i] >= Math.max(...eto) * 0.4) : [];
        const re = Math.max(0, Math.min(100, psRainEff)) / 100;
        // 3 — Inquadramento climatico
        const c3: Record<string, unknown>[] = [];
        if (meteo && eto && rain) {
          const M = meteo, eY = eto.reduce((a, x) => a + x, 0), rY = rain.reduce((a, x) => a + x, 0), ai = eY > 0 ? rY / eY : 0;
          const cls = ai < 0.05 ? tx("iperarida") : ai < 0.2 ? tx("arida") : ai < 0.5 ? tx("semiarida") : ai < 0.65 ? tx("subumida secca") : tx("umida");
          const tm = M.tmax.map((x, i) => (x + M.tmin[i]) / 2), iC = tm.indexOf(Math.min(...tm)), iH = tm.indexOf(Math.max(...tm));
          const iRs = M.rs.indexOf(Math.max(...M.rs)), iRw = rain.indexOf(Math.max(...rain)), iRd = rain.indexOf(Math.min(...rain));
          const etoD = eto.map((e, i) => e / [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][i]), iPk = etoD.indexOf(Math.max(...etoD));
          const sR = seasonIdx.reduce((a, i) => a + rain[i], 0), sE = seasonIdx.reduce((a, i) => a + eto[i], 0);
          c3.push({ p: tx("Il clima del sito è descritto dai normali climatici mensili {src} nel punto di progetto: temperatura massima e minima, umidità relativa, vento a 2 m, radiazione solare e precipitazione. Con un indice di aridità (pioggia annua su ET₀ annua) di {ai}, secondo la classificazione UNEP l'area ricade in una zona climatica {cls}.", { src: srcClim, ai: n2(ai), cls }) });
          c3.push({ p: tx("Il mese più freddo è {mc}, con temperature fra {a} e {b} °C; il più caldo è {mh}, con minime di {c} °C e massime di {d} °C. L'umidità relativa media varia fra {h1} e {h2} %, il vento a 2 m fra {w1} e {w2} m/s e la radiazione solare arriva a {rs} MJ/m² al giorno a {mrs}.",
            { mc: monthLong(iC), a: n1(M.tmin[iC]), b: n1(M.tmax[iC]), mh: monthLong(iH), c: n1(M.tmin[iH]), d: n1(M.tmax[iH]), h1: n0(Math.min(...M.rh)), h2: n0(Math.max(...M.rh)), w1: n1(Math.min(...M.wind)), w2: n1(Math.max(...M.wind)), rs: n1(M.rs[iRs]), mrs: monthLong(iRs) }) });
          c3.push({ p: tx("La pioggia annua è di {r} mm: il mese più piovoso è {mw} ({x} mm), il più secco {md} ({y} mm). Da {a} a {b}, quando la domanda evaporativa è più alta, cadono {sr} mm contro un'ET₀ di {se} mm nello stesso periodo.",
            { r: n0(rY), mw: monthLong(iRw), x: n0(rain[iRw]), md: monthLong(iRd), y: n0(rain[iRd]), a: monthLong(seasonIdx[0] ?? 0), b: monthLong(seasonIdx[seasonIdx.length - 1] ?? 11), sr: n0(sR), se: n0(sE) }) });
          c3.push({ p: tx("L'evapotraspirazione di riferimento FAO-56 Penman-Monteith è di circa {e} mm all'anno, con una punta di {d} mm al giorno a {m}. Il deficit idrico annuo (ET₀ meno pioggia) è di {def} mm: l'irrigazione è un fattore di produzione e va dimensionata sulle condizioni di punta, non sulle medie annue.",
            { e: n0(eY), d: n1(etoD[iPk]), m: monthLong(iPk), def: n0(eY - rY) }) });
          c3.push({ chart: { x: months12, y: "mm", y2: "°C", bars: [{ name: tx("Pioggia") + " (mm)", values: rain.map((v) => Math.round(v * 10) / 10) }],
            lines: [{ name: "ET₀ (mm)", values: eto }, { name: "T max (°C)", values: M.tmax, axis: "y2", dash: true, color: "#F59E0B" }, { name: "T min (°C)", values: M.tmin, axis: "y2", dash: true, color: "#E11D48" }] },
            caption: tx("Dati meteorologici del sito: pioggia ed ET₀ mensili, temperature massime e minime ({src})", { src: srcClim }) });
          c3.push({ table: { header: [tx("Mese"), "T max (°C)", "T min (°C)", tx("UR") + " (%)", tx("Vento") + " (m/s)", "Rs (MJ/m²·g)", tx("Pioggia") + " (mm)", "ET₀ (mm/g)", "ET₀ (mm)"], widths: [12, 11, 11, 10, 11, 12, 11, 11, 11],
            rows: [...months12.map((mo, i) => [mo, n1(M.tmax[i]), n1(M.tmin[i]), n0(M.rh[i]), n1(M.wind[i]), n1(M.rs[i]), n1(rain[i]), n1(etoD[i]), n0(eto[i])]),
              [tx("Anno"), n1(M.tmax.reduce((a, x) => a + x, 0) / 12), n1(M.tmin.reduce((a, x) => a + x, 0) / 12), n0(M.rh.reduce((a, x) => a + x, 0) / 12), n1(M.wind.reduce((a, x) => a + x, 0) / 12), n1(M.rs.reduce((a, x) => a + x, 0) / 12), n0(rY), n1(eY / 365), n0(eY)]] },
            caption: tx("Dati meteorologici mensili del sito ({src}); UR = umidità relativa, Rs = radiazione solare globale", { src: srcClim }) });
          c3.push({ table: { header: [tx("Mese"), "ET₀ (mm)", tx("Pioggia") + " (mm)", tx("Bilancio") + " (mm)"], widths: [25, 25, 25, 25],
            rows: [...eto.map((e, i) => [month(i), n0(e), n0(rain[i]), n0(rain[i] - e)]), [tx("Anno"), n0(eY), n0(rY), n0(rY - eY)]] }, caption: tx("Bilancio idrico climatico mensile (pioggia meno ET₀)") });
        } else if (eto && rain) {
          const eY = eto.reduce((a, x) => a + x, 0), rY = rain.reduce((a, x) => a + x, 0);
          const iMax = eto.indexOf(Math.max(...eto)), iRain = rain.indexOf(Math.max(...rain));
          c3.push({ p: tx("Il clima del sito è descritto dalle serie mensili di evapotraspirazione di riferimento e di pioggia ({src}). L'ET₀ annua è di circa {e} mm e la pioggia annua di {r} mm: il rapporto fra pioggia ed evapotraspirazione è di {k}.", { src: clim?.source ?? "NASA POWER", e: n0(eY), r: n0(rY), k: n2(eY > 0 ? rY / eY : 0) }) });
          c3.push({ p: tx("La domanda evaporativa è massima a {m} ({x} mm nel mese); la pioggia si concentra soprattutto a {mr} ({y} mm). Il deficit idrico estivo va coperto con l'irrigazione, che va dimensionata sulle condizioni di punta e non sulle medie annue.", { m: monthLong(iMax), x: n0(eto[iMax]), mr: monthLong(iRain), y: n0(rain[iRain]) }) });
          c3.push({ table: { header: [tx("Mese"), "ET₀ (mm)", tx("Pioggia") + " (mm)", tx("Bilancio") + " (mm)"], widths: [25, 25, 25, 25],
            rows: [...eto.map((e, i) => [month(i), n0(e), n0(rain[i]), n0(rain[i] - e)]), [tx("Anno"), n0(eY), n0(rY), n0(rY - eY)]] } });
        } else {
          c3.push({ p: tx("Per questo progetto non è disponibile una serie climatica mensile del sito: il fabbisogno è stimato dall'ET₀ di punta di {e} mm al giorno indicata in progetto. La serie climatica si ottiene generando il layout dei campi.", { e: n1(et0Peak) }) });
        }
        ch.push({ title: tx("Inquadramento climatico"), blocks: c3 });
        // 4 — Piano colturale
        // stesse colture del dimensionamento (cropMax è la prima)
        const crops = pivots.length ? designCrops : cropsOf(fieldsShown);
        const haOf = (f: Field) => pivots.filter((p) => p.field === f.id).reduce((a, p) => a + pvAreaM2(p) / 10000, 0);
        const cropTable = fieldsShown.length > 1 || crops.length > 1
          ? [{ table: { header: [tx("Campo"), tx("Superficie irrigata") + " (ha)", tx("Colture"), "Kc"], widths: [26, 18, 36, 20],
              rows: fieldsShown.map((f) => { const cs = cropsOfField(f); return [f.name, n1(haOf(f)), cs.map((c) => tx(c.label)).join(", "), cs.map((c) => n2(c.kc)).join(" · ")]; }) } }] : [];
        ch.push({ title: tx("Piano colturale"), blocks: [
          { p: tx("Il piano colturale considerato per il dimensionamento comprende: {c}. L'impianto è dimensionato sulla coltura più esigente, {m}, in modo che rete, pompe e linee elettriche coprano la domanda di punta di ogni coltura della rotazione.", { c: crops.map((c) => `${tx(c.label)} (Kc ${n2(c.kc)})`).join(", "), m: tx(crops[0].label) }) },
          ...cropTable,
          { p: tx("Le colture con fabbisogno minore lavorano con turni più brevi o con dosi ridotte; l'alternanza delle colture distribuisce la domanda d'acqua nel corso della stagione e riduce i picchi sulla rete.") },
        ] });
        // 5 — Metodologia di stima dell'evapotraspirazione
        const KC_STAGE: Record<string, [number, number, number]> = { canna: [0.4, 1.25, 0.75], mais: [0.3, 1.2, 0.6], medica: [0.4, 1.15, 1.1], cereali: [0.3, 1.15, 0.4], ortive: [0.6, 1.05, 0.9], altro: [0.5, 1.1, 0.8] };
        ch.push({ title: tx("Metodologia di stima dell'evapotraspirazione"), blocks: [
          { p: tx("Il fabbisogno idrico delle colture è stimato con la metodologia FAO-56, riferimento internazionale per la pianificazione irrigua. L'evapotraspirazione di riferimento (ET₀) esprime la domanda climatica dell'atmosfera ed è calcolata con l'equazione di Penman-Monteith, che integra temperatura, umidità, vento e radiazione solare. L'evapotraspirazione della coltura si ottiene come ETc = ET₀ × Kc, con coefficienti colturali che seguono le fasi di sviluppo: iniziale, di sviluppo, di piena copertura e finale.") },
          ...(eto ? [{ p: tx("I dati meteorologici sono i normali climatici mensili {src} nel punto del sito: temperatura massima e minima a 2 m, umidità relativa, velocità del vento a 2 m, radiazione solare globale e precipitazione. Per ogni mese l'ET₀ è calcolata con l'equazione FAO-56 Penman-Monteith:", { src: srcClim }) },
            { p: "ET₀ = [ 0,408 · Δ · (Rn − G) + γ · 900 / (T + 273) · u₂ · (es − ea) ] / [ Δ + γ · (1 + 0,34 · u₂) ]" },
            { bullets: [tx("Rn: radiazione netta alla superficie (MJ/m² al giorno), dalla radiazione solare con albedo 0,23 e dal bilancio a onde lunghe;"), tx("G: flusso di calore nel suolo, trascurabile alla scala mensile;"),
              tx("T: temperatura media dell'aria a 2 m (°C); u₂: velocità del vento a 2 m (m/s);"), tx("es − ea: deficit di pressione di vapore (kPa), dalle temperature e dall'umidità relativa;"),
              tx("Δ: pendenza della curva della pressione di vapore (kPa/°C); γ: costante psicrometrica (kPa/°C), dalla quota del sito.")] }] : []),
          { p: tx("Il fabbisogno irriguo netto (NIR) è la differenza fra ETc e pioggia efficace; il fabbisogno lordo (GIR) divide il netto per l'efficienza di applicazione del sistema irriguo.") },
          { bullets: ["ETc = ET₀ × Kc", tx("Pe = pioggia × {re} % (pioggia efficace)", { re: fx(psRainEff) }), "NIR = ETc − Pe", tx("GIR = NIR ÷ Ea (efficienza di applicazione, {eff} % in progetto)", { eff: fx(effPct) }),
            tx("Q = A × dose ÷ (ore × 3,6): portata in l/s con A in ettari, dose in mm al giorno e ore di funzionamento giornaliere")] },
          { p: tx("Coefficienti colturali applicati per fase di sviluppo (FAO-56):") },
          ...crops.map((c) => { const k = KC_STAGE[c.key] ?? KC_STAGE.altro; return { bullets: [`${tx(c.label)}: ${tx("Kc iniziale {a}, di piena copertura {b}, finale {c}", { a: n2(k[0]), b: n2(k[1]), c: n2(k[2]) })}`] }; }),
        ] });
        // 6 — Pioggia e pioggia efficace
        const c6: Record<string, unknown>[] = [{ p: tx("Nei climi con estati secche solo una parte della pioggia è utile alla coltura: la pioggia efficace è la frazione che resta nella zona delle radici, al netto di evaporazione immediata, ruscellamento e percolazione profonda. Per il dimensionamento è stimata in modo prudente.") }];
        if (eto && rain) {
          c6.push({ p: tx("I dati di pioggia sono i normali mensili {src} nel punto del sito. È considerata efficace il {re} % della pioggia mensile, per tenere conto di evaporazione immediata, ruscellamento e infiltrazione oltre le radici. La tabella riporta pioggia totale ed efficace mese per mese.", { src: srcClim, re: fx(psRainEff) }) });
          if (seasonIdx.length) {
            const sR = seasonIdx.reduce((a, i) => a + rain[i], 0), iX = seasonIdx.reduce((a, i) => (rain[i] > rain[a] ? i : a), seasonIdx[0]), iN = seasonIdx.reduce((a, i) => (rain[i] < rain[a] ? i : a), seasonIdx[0]);
            c6.push({ p: tx("Nella stagione irrigua, da {a} a {b}, cadono in tutto {r} mm, di cui {pe} mm efficaci: il mese più piovoso è {mx} ({x} mm), il più secco {mn} ({y} mm). Questo contributo riduce il fabbisogno della coltura; il resto va fornito con l'irrigazione.",
              { a: monthLong(seasonIdx[0]), b: monthLong(seasonIdx[seasonIdx.length - 1]), r: n0(sR), pe: n0(sR * re), mx: monthLong(iX), x: n1(rain[iX]), mn: monthLong(iN), y: n1(rain[iN]) }) });
          }
          c6.push({ chart: { x: months12, y: "mm", bars: [{ name: tx("Pioggia") + " (mm)", values: rain.map((v) => Math.round(v * 10) / 10) }, { name: tx("Pioggia efficace") + " (mm)", values: rain.map((v) => Math.round(v * re * 10) / 10) }] },
            caption: tx("Pioggia totale ed efficace mese per mese ({src})", { src: srcClim }) });
          c6.push({ table: { header: [tx("Mese"), tx("Pioggia") + " (mm)", tx("Pioggia efficace") + " (mm)"], widths: [34, 33, 33],
            rows: [...rain.map((r, i) => [month(i), n1(r), n1(r * re)]), [tx("Anno"), n0(rain.reduce((a, x) => a + x, 0)), n0(rain.reduce((a, x) => a + x * re, 0))]] } });
        } else {
          c6.push({ p: tx("In progetto è considerata una pioggia utile di {r} mm al giorno nel periodo di punta.", { r: n1(rainMm) }) });
        }
        ch.push({ title: tx("Pioggia e pioggia efficace"), blocks: c6 });
        // 7… — per ogni coltura: ETc, NIR, GIR sulla stagione irrigua
        const effs = [0.85, 0.8, 0.75, 0.7];
        for (const c of crops.slice(0, 3)) {
          const k = KC_STAGE[c.key] ?? KC_STAGE.altro;
          const cb: Record<string, unknown>[] = [];
          if (eto && rain) {
            const mx = Math.max(...eto), season = eto.map((e, i) => i).filter((i) => eto[i] >= mx * 0.4);
            const n = season.length;
            const kcOf = (j: number) => (j === 0 ? k[0] + (k[1] - k[0]) * 0.3 : j === n - 1 ? k[2] : j < n / 2 ? k[0] + (k[1] - k[0]) * Math.min(1, (j + 0.5) / Math.max(1, n / 2 - 0.5)) : k[1]);
            const rows = season.map((i, j) => { const kc = kcOf(j); return { i, kc, etc: eto[i] * kc, pe: rain[i] * re }; });
            const etcT = rows.reduce((a, r) => a + r.etc, 0), nirT = rows.reduce((a, r) => a + Math.max(0, r.etc - r.pe), 0);
            const pk = rows.reduce((a, r) => (r.etc / 30.4 > a.etc / 30.4 ? r : a), rows[0]);
            cb.push({ p: tx("La tabella riporta, per la stagione irrigua da {a} a {b}, l'ET₀ mensile, il coefficiente colturale e l'evapotraspirazione della coltura.", { a: monthLong(season[0]), b: monthLong(season[n - 1]) }) });
            cb.push({ table: { header: [tx("Mese"), "ET₀ (mm)", "Kc", "ETc (mm)"], widths: [25, 25, 25, 25], rows: rows.map((r) => [month(r.i), n0(eto[r.i]), n2(r.kc), n0(r.etc)]) } });
            cb.push({ p: tx("L'ETc stagionale è di circa {e} mm; la punta giornaliera cade a {m}, con circa {d} mm al giorno.", { e: n0(etcT), m: monthLong(pk.i), d: n1(pk.etc / 30.4) }) });
            cb.push({ p: tx("Il fabbisogno irriguo netto (NIR) è l'ETc meno la pioggia efficace:") });
            cb.push({ table: { header: [tx("Mese"), "ETc (mm)", tx("Pioggia") + " (mm)", tx("Pioggia efficace") + " (mm)", "NIR (mm)"], widths: [20, 20, 20, 20, 20],
              rows: rows.map((r) => [month(r.i), n0(r.etc), n1(rain[r.i]), n1(r.pe), n1(Math.max(0, r.etc - r.pe))]) } });
            cb.push({ chart: { x: rows.map((r) => month(r.i)), y: "mm", bars: [{ name: "ETc (mm)" }, { name: tx("Pioggia efficace") + " (mm)" }].map((b, k) => ({ ...b, values: rows.map((r) => Math.round((k ? r.pe : r.etc) * 10) / 10) })),
              lines: [{ name: "NIR (mm)", values: rows.map((r) => Math.round(Math.max(0, r.etc - r.pe) * 10) / 10), color: "#E11D48" }] }, caption: tx("{c}: ETc, pioggia efficace e fabbisogno irriguo netto mese per mese", { c: tx(c.label) }) });
            cb.push({ p: tx("Il fabbisogno netto stagionale è di circa {n} mm: è l'acqua che deve arrivare alla coltura, escluse le perdite di applicazione. Il fabbisogno lordo (GIR) si ottiene dividendo il netto per l'efficienza di applicazione (Ea):", { n: n0(nirT) }) });
            cb.push({ bullets: effs.map((e) => tx("Ea {e}: circa {g} mm", { e: fx(e, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), g: n0(nirT / e) })) });
            cb.push({ p: tx("Con l'efficienza di progetto del {eff} % il fabbisogno lordo è di circa {g} mm; nei mesi di punta l'impianto deve poter distribuire {d} mm al giorno.", { eff: fx(effPct), g: n0(nirT / Math.max(0.3, effPct / 100)), d: n1(mmDes) }) });
          } else {
            cb.push({ p: tx("Senza serie climatica mensile, la domanda di punta della coltura è stimata in {etc} mm al giorno (ET₀ di punta {et0} mm × Kc {kc}); con l'efficienza di progetto del {eff} % la dose lorda è di {mm} mm ogni 24 ore.", { etc: n1(et0Peak * c.kc), et0: n1(et0Peak), kc: n2(c.kc), eff: fx(effPct), mm: n1(mmDes) }) });
          }
          ch.push({ title: tx("{c}: ETc, fabbisogno irriguo netto (NIR) e lordo (GIR)", { c: tx(c.label) }), blocks: cb });
        }
        // Portata nominale dell'impianto
        const qMax = pivots.length ? Math.max(...pivots.map((p) => pivotFlow(p))) : 0;
        ch.push({ title: tx("Portata nominale dell'impianto"), blocks: [
          { p: tx("La portata nominale è dimensionata sulla dose di punta e non sui valori medi: la dose di progetto è di {mm} mm ogni 24 ore per la coltura più esigente ({crop}, Kc {kc}, ET₀ di punta {et0} mm al giorno), al netto della pioggia utile e dell'efficienza dell'impianto.", { mm: n1(mmDes), crop: cropLbl, kc: n2(kcMax), et0: n1(et0Peak) }) },
          { p: tx("La portata di ogni pivot si ricava dalla superficie irrigata e dalla dose distribuita nelle ore di funzionamento giornaliere: Q = A × dose ÷ (ore × 3,6), con A in ettari, dose in millimetri e Q in litri al secondo.") },
          { bullets: [tx("Dose di progetto: {mm} mm ogni 24 ore", { mm: n1(mmDes) }), tx("Ore di funzionamento: {h} h al giorno", { h: n1(hoursDay) }),
            ...(pivots.length ? [tx("Portata del pivot più grande: {q} l/s", { q: n1(qMax) })] : []),
            tx("Portata totale dell'impianto: {q} l/s ({m3} m³/h)", { q: n0(P.qDes), m3: n0(P.qDes * 3.6) }), tx("Volume annuo stimato: {v} m³", { v: n0(P.volYear) })] },
        ] });
        // Fonte d'acqua: i dati del modulo Fonte d'acqua (presa, portate, livelli, quote)
        const fb: Record<string, unknown>[] = [];
        const srcName = tx(srcType), asl = tx("m s.l.m.");
        const qIn = sc && S ? (sc.key === "B" ? sc.stages[0].qLs : sc.key === "C" ? (S.Vday + (sc.res?.evap ?? 0)) / 3.6 / Math.max(1, Math.min(srcHours, 24)) : S.Qd) : P.qDes;
        if (srcPt) {
          const zTxt = S?.zS != null ? " " + tx("La quota della presa sul modello digitale del terreno è di {z} m s.l.m.", { z: n1(S.zS) }) : "";
          fb.push({ p: tx("L'acqua è prelevata da {tipo}; il punto di presa si trova alle coordinate {lat}, {lon} (WGS84).", { tipo: srcName, lat: dms(srcPt[1], "N", "S"), lon: dms(srcPt[0], "E", "W") }) + zTxt });
          // corso d'acqua rilevato vicino alla presa (NDWI): larghezza e sviluppo
          const kx = 111320 * Math.cos((srcPt[1] * Math.PI) / 180), ky = 110540;
          const flat = (c: unknown): number[][] => (Array.isArray(c) && typeof c[0] === "number" ? [c as number[]] : Array.isArray(c) ? (c as unknown[]).flatMap(flat) : []);
          let near: { w: WaterL; d: number } | null = null;
          for (const w of watercourses.filter((x) => !x.hidden)) {
            const d = Math.min(...flat(w.geojson.coordinates).map((q) => Math.hypot((q[0] - srcPt[0]) * kx, (q[1] - srcPt[1]) * ky)));
            if (d < 500 && (!near || d < near.d)) near = { w, d };
          }
          if (near && (srcType === "fiume" || srcType === "canale" || srcType === "invaso")) {
            const w = near.w;
            const bits = [w.mean_width_m ? tx("larghezza media {w} m", { w: n0(w.mean_width_m) }) : "", w.length_m ? tx("sviluppo di {l} km nell'area rilevata", { l: n1(w.length_m / 1000) }) : "",
              w.area_ha ? tx("superficie d'acqua di {a} ha", { a: n1(w.area_ha) }) : ""].filter(Boolean);
            if (bits.length) fb.push({ p: tx("Il corso d'acqua alla presa è stato rilevato dalle immagini Sentinel-2 (indice NDWI) e dal modello del terreno: {d}.", { d: bits.join(", ") }) });
          }
        }
        if (sc && S) {
          fb.push({ p: tx("Il fabbisogno di punta dell'impianto è di {v} m³ al giorno, pari a {q} l/s ai pivot; la presa preleva {qi} l/s nelle ore consentite ({h} h al giorno).", { v: n0(S.Vday), q: n0(S.Qd), qi: n0(qIn), h: n1(srcHours) })
            + " " + (srcQmax > 0 ? tx("La portata disponibile della fonte è di {q} l/s: il prelievo ne impegna il {p}%.", { q: n0(srcQmax), p: n0((qIn / srcQmax) * 100) }) : tx("Nel progetto la portata della fonte non è limitata: va verificata con l'ente gestore e con le misure di portata nei mesi di magra.")) });
          if (!sc.ok && sc.why) fb.push({ p: tx("Attenzione: {w}", { w: sc.why }) });
          const rows: string[][] = [[tx("Tipo di fonte"), srcName]];
          if (srcPt) rows.push([tx("Coordinate della presa"), `${dms(srcPt[1], "N", "S")}, ${dms(srcPt[0], "E", "W")}`]);
          if (S.zS != null) rows.push([tx("Quota della presa"), `${n1(S.zS)} ${asl}`]);
          rows.push([tx("Portata disponibile"), srcQmax > 0 ? `${n0(srcQmax)} l/s` : tx("non limitata")]);
          rows.push([tx("Ore di prelievo consentite"), `${n1(srcHours)} h/${tx("giorno")}`]);
          rows.push([tx("Fabbisogno di punta"), `${n0(S.Vday)} m³/${tx("giorno")} (${n0(S.Qd)} l/s)`]);
          rows.push([tx("Portata prelevata alla presa"), `${n0(qIn)} l/s (${n0(qIn * 3.6)} m³/h)`]);
          rows.push([tx("Volume annuo stimato"), `${n0(P.volYear)} m³`]);
          if (srcType === "pozzo") {
            const nW = Math.max(1, Math.ceil(qIn / Math.max(1, wellQ)));
            rows.push([tx("Livello dinamico del pozzo"), `${n1(S.drop)} m`], [tx("Portata di un pozzo"), `${n0(wellQ)} l/s`], [tx("Pozzi"), tx("{n} in servizio da {q} l/s + 1 di riserva", { n: nW, q: n0(qIn / nW) })]);
          } else {
            rows.push([tx("Abbassamento massimo del livello nei mesi irrigui"), `${n1(S.drop)} m`]);
            if (S.months) rows.push([tx("Abbassamento medio pesato sui volumi"), `${n1(S.dropAvg)} m`]);
            if (S.zLow != null) rows.push([tx("Livello minimo di progetto alla presa"), `${n1(S.zLow)} ${asl}`]);
          }
          if (S.zR != null) rows.push([tx("Quota della vasca o del punto di consegna"), `${n1(S.zR)} ${asl}`]);
          if (S.zP != null) rows.push([tx("Quota del pivot più alto"), `${n1(S.zP)} ${asl}`]);
          rows.push([tx("Distanza presa – impianto"), `${n0(S.L)} m`]);
          if (srcType !== "pozzo") rows.push([tx("Acqua con sedimenti"), srcSediment ? tx("sì") : tx("no")]);
          fb.push({ h: tx("Dati della fonte d'acqua") });
          fb.push({ table: { header: [tx("Parametro"), tx("Valore")], rows, widths: [0.55, 0.45] } });
          // livelli mese per mese
          if (S.months && srcMonthly && srcType !== "pozzo") {
            fb.push({ h: tx("Livelli della fonte mese per mese") });
            fb.push({ p: S.netMm
              ? tx("Il livello della fonte varia nel corso dell'anno: la tabella riporta l'abbassamento minimo del pelo libero sotto il punto di presa mese per mese e il fabbisogno irriguo netto dello stesso mese. Il dimensionamento delle pompe considera l'abbassamento peggiore dei mesi irrigui ({d} m); il consumo di energia usa la media pesata sui volumi ({a} m).", { d: n1(S.drop), a: n1(S.dropAvg) })
              : tx("Il livello della fonte varia nel corso dell'anno: la tabella riporta l'abbassamento minimo del pelo libero sotto il punto di presa mese per mese. Senza i dati climatici del sito il dimensionamento delle pompe considera l'abbassamento peggiore dell'anno ({d} m) e il consumo di energia la media dei dodici mesi ({a} m).", { d: n1(S.drop), a: n1(S.dropAvg) }) });
            const f1 = (x: number) => fx(x, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), nm = S.netMm;
            const hd = [tx("Mese"), tx("Abbassamento (m)"), ...(S.zS != null ? [tx("Quota del pelo libero (m s.l.m.)")] : []), ...(nm ? [tx("Fabbisogno netto (mm)"), tx("Mese irriguo")] : [])];
            const mr = srcMonthly.map((d, i) => [monthLong(i), f1(d), ...(S.zS != null ? [f1(S.zS! - d)] : []), ...(nm ? [n0(Math.max(0, nm[i])), nm[i] > 0 ? tx("sì") : tx("no")] : [])]);
            fb.push({ table: { header: hd, rows: mr } });
          } else if (srcType !== "pozzo") {
            fb.push({ p: tx("In assenza di misure mese per mese il progetto considera un'escursione unica del livello di {r} m per tutto l'anno; con le misure di magra della fonte il calcolo delle pompe va aggiornato.", { r: n1(srcRange) }) });
          }
        } else {
          fb.push({ p: tx("Il punto di presa non è ancora stato indicato nel modulo Fonte d'acqua: la portata disponibile alla presa deve essere almeno pari alla portata di progetto di {q} l/s ({m3} m³/h) per {h} ore al giorno.", { q: n0(P.qDes), m3: n0(P.qDes * 3.6), h: n1(hoursDay) }) });
        }
        // portata del fiume alla presa e bilancio con il fabbisogno, mese per mese
        { const RV = srcType !== "pozzo" ? riverCalc() : null;
          if (RV) {
            const b = river?.data.basin, ff = (x: number) => fx(x, { maximumFractionDigits: x < 10 ? 2 : x < 100 ? 1 : 0 });
            fb.push({ h: tx("Portata del fiume alla presa") });
            fb.push({ p: (b?.area_km2 ? tx("Il bacino che drena fino alla presa, ricavato dal modello digitale del terreno, misura {a} km².", { a: (b.truncated ? "≥ " : "") + ff(b.area_km2) }) + " " : "")
              + (RV.src === "meas"
                ? tx("La portata è quella misurata dall'ente gestore{y}: portata media {q} m³/s; la magra di ogni mese è {how}.", { y: river?.meas?.years ? ` (${river.meas.years.join("–")})` : "", q: ff(RV.mean), how: river?.meas?.days ? tx("la portata superata l'80% dei giorni del mese") : river?.meas?.low.length === 12 ? tx("quella indicata dall'ente") : tx("posta a metà della media") })
                : RV.src === "corr" && RV.corr
                ? tx("La portata parte dalla rianalisi idrologica GloFAS (Copernicus Emergency Management Service) sulla cella del fiume più vicina alla presa, serie giornaliera {y}, ed è corretta mese per mese con le portate osservate alla stazione di {s} sul fiume {r} ({d} km dalla presa, {yo}; fonte {src}): lì GloFAS dà {g} m³/s contro {o} m³/s misurati. Portata media corretta {q} m³/s, Q347 {q3} m³/s.", { y: RV.cell!.years.join("–"), s: RV.corr.station.name, r: RV.corr.station.river, d: n0(RV.corr.station.dist_km), yo: RV.corr.station.years.join("–"), src: RV.corr.station.source, g: ff(RV.corr.sim_mean), o: ff(RV.corr.obs_mean), q: ff(RV.mean), q3: ff(RV.q347) })
                : RV.src === "glofas"
                ? tx("La portata è stimata dalla rianalisi idrologica GloFAS (Copernicus Emergency Management Service) sulla cella del fiume più vicina alla presa, serie giornaliera {y}: portata media {q} m³/s, Q347 {q3} m³/s. La portata di magra di ogni mese è quella superata l'80% dei giorni del mese.", { y: RV.cell!.years.join("–"), q: ff(RV.mean), q3: ff(RV.cell!.q347) })
                : tx("La portata è stimata dalle piogge medie mensili del bacino con un coefficiente di deflusso di {c}: portata media {q} m³/s. La portata di magra è posta a metà della media del mese.", { c: fx(river!.c), q: ff(RV.mean) }))
              + " " + tx("In alveo restano {p}% della portata media ({d} m³/s); il resto della magra è il prelevabile del mese, da confrontare con il fabbisogno lordo dell'impianto per {h} ore di prelievo al giorno.", { p: fx(river!.dmv), d: ff(RV.dmv), h: n0(srcHours) }) });
            fb.push({ table: { header: [tx("Mese"), tx("Media") + " (m³/s)", tx("Magra") + " (m³/s)", tx("Prelevabile") + " (l/s)", tx("Fabbisogno lordo") + " (m³)", tx("Ore di prelievo")],
              rows: RV.bal.rows.map((r, i) => [monthLong(i), ff(RV.mMean[i]), ff(RV.mLow[i]), n0(RV.avail[i]), r.needM3 > 0 ? n0(r.needM3) : "—", r.needM3 > 0 ? (Number.isFinite(r.hours) ? n1(r.hours) : "∞") : "—"]) } });
            fb.push({ p: RV.bal.deficitM3 <= 1
              ? tx("Il fiume basta in tutti i mesi irrigui con {h} h di prelievo al giorno.", { h: n0(srcHours) })
              : RV.bal.feasible
                ? tx("Nei mesi in cui le ore di prelievo superano quelle consentite il fiume non basta: servono {v} m³ di vasca di compenso, riempita con l'acqua dei mesi in avanzo (deficit {d} m³).", { v: n0(Math.ceil(RV.bal.storeM3 / 100) * 100), d: n0(RV.bal.deficitM3) })
                : tx("Il fiume non basta nemmeno sull'anno: mancano {d} m³. Serve un'altra fonte o meno superficie irrigata.", { d: n0(RV.bal.deficitM3 - RV.bal.rows.reduce((a, r) => a + r.surplus, 0)) }) });
          }
        }
        ch.push({ title: tx("Fonte d'acqua: portata e disponibilità"), blocks: fb });
        // Infrastrutture idriche esistenti e opere di presa
        const ib: Record<string, unknown>[] = [];
        const nCan = canals.filter((c) => !c.hidden).length, nWat = watercourses.filter((w) => !w.hidden).length;
        if (nCan || nWat) ib.push({ p: tx("Nell'area sono presenti {c} canali e {w} corsi d'acqua rilevati sulla mappa, considerati nel tracciato delle tubazioni e nelle prese.", { c: fx(nCan), w: fx(nWat) }) });
        if (sc && S) {
          let txt = tx("L'acqua raggiunge l'impianto secondo lo schema {k} – {name}.", { k: sc.key, name: sc.name });
          if (sc.main?.kind === "pipe" && sc.main.dn) txt += " " + tx("L'adduttrice in PE100 DN {dn} è lunga {l} m.", { dn: sc.main.dn, l: n0(sc.main.L * (sc.main.n ?? 1)) });
          if (sc.main?.kind === "canal") txt += " " + tx("Un canale a gravità di {l} m porta l'acqua alla vasca.", { l: n0(sc.main.L) });
          ib.push({ p: txt });
          if (sc.res) ib.push({ p: tx("La vasca di accumulo ha un volume utile di {v} m³ su {ha} ha, con una profondità utile di {d} m, e garantisce {g} giorni di scorta.", { v: n0(sc.res.vol), ha: n2(sc.res.ha), d: n1(resDepth), g: fx(resDays) }) });
          // schemi valutati
          if (S.schemes.length > 1) {
            ib.push({ h: tx("Schemi di adduzione valutati") });
            ib.push({ table: { header: [tx("Schema"), tx("Stazioni"), tx("Potenza (kW)"), tx("Energia (MWh/anno)"), tx("Esito")],
              rows: S.schemes.map((x) => [`${x.key} – ${x.name}`, fx(x.nStations), n0(x.kWabs), n0(x.mwh), x.key === sc.key ? tx("adottato") : x.ok ? tx("fattibile") : tx("non fattibile")]),
              widths: [0.44, 0.12, 0.14, 0.16, 0.14] } });
          }
          // stazioni dello schema
          if (sc.stages.length) ib.push({ table: { header: [tx("Stazione"), tx("Portata (l/s)"), tx("Prevalenza (m)"), tx("Potenza (kW)"), tx("Ore al giorno")],
            rows: sc.stages.map((st) => [st.name, n0(st.qLs), n0(st.head), n0(st.kW), n0(st.hours)]), widths: [0.44, 0.14, 0.14, 0.14, 0.14] } });
          // opere di presa e trattamento
          ib.push({ h: tx("Opera di presa e trattamento dell'acqua") });
          for (const blk of intakeAdvice(qIn, S.drop, S.Qd, sc.key === "C")) {
            ib.push({ p: blk.text });
            if (blk.rows.length) ib.push({ table: { header: [tx("Elemento"), tx("Caratteristiche")], rows: blk.rows.map(([k, v]) => [k, v]), widths: [0.3, 0.7] } });
          }
        }
        if (!ib.length) ib.push({ p: tx("Il progetto non prevede opere sulle infrastrutture idriche esistenti oltre alla presa dell'impianto.") });
        { const CK = canalCalcs().filter((k) => k.sec);
          if (CK.length) {
            const L0 = lining(canalLin);
            ib.push({ h: tx("Canali") });
            ib.push({ p: tx("I canali sono dimensionati a moto uniforme con la formula di Manning, Q = (1/n)·A·R^(2/3)·i^(1/2), per {q} l/s alla pendenza di fondo del tracciato. Rivestimento: {lin} (n = {n}, velocità massima {v} m/s). La sezione trapezia parte da quella idraulicamente più efficiente e si allarga se la velocità supera il limite del rivestimento; il franco è il maggiore tra {f} m e il 20% del tirante.", { q: n0(CK[0].q), lin: tx(L0.label).toLowerCase(), n: String(L0.n), v: n1(L0.vmax), f: n2(canalFb) }) });
            ib.push({ table: { header: [tx("Canale"), tx("Stato"), tx("Lunghezza") + " (m)", tx("Pendenza") + " (‰)", "b (m)", "y (m)", tx("Franco") + " (m)", "v (m/s)", tx("Scavo") + " (m³)", tx("Rilevato") + " (m³)"],
              rows: CK.map((k) => [`K${k.idx + 1}`, k.c.exist ? tx("esistente") : tx("da realizzare"), n0(k.ew?.len ?? k.c.length_m), n2(k.S), n2(k.sec!.b), n2(k.sec!.y), n2(k.sec!.fb), n2(k.sec!.v), k.ew && !k.c.exist ? n0(k.ew.cut) : "—", k.ew && !k.c.exist ? n0(k.ew.fill) : "—"]) } });
            const slow = CK.filter((k) => k.sec!.slow).map((k) => `K${k.idx + 1}`);
            if (slow.length) ib.push({ p: tx("Nei canali {l} la velocità resta sotto 0,3 m/s: rischio di deposito e di crescita di erbe, da gestire con la manutenzione o con una pendenza maggiore.", { l: slow.join(", ") }) });
          }
          const DR = drainCalcs().filter((d) => d.sec);
          if (DR.length) {
            ib.push({ h: tx("Fossi di scolo") });
            ib.push({ p: tx("Ogni campo è circondato da un fosso di scolo che smaltisce {c} mm in 24 ore ({q} l/s per ettaro). Il fosso, in terra inerbita con scarpe 1:1,5 e pendenza di fondo {s}‰, ha la sezione dello sbocco per l'intera portata del campo; lo sbocco va nel punto più basso del perimetro, verso il ricettore.", { c: n2(drainC), q: n2(drainC / 8.64), s: n1(drainS) }) });
            if (DR.some((d) => d.dem)) ib.push({ p: tx("Le quote del perimetro sono lette dal modello digitale del terreno: lo sbocco di ogni fosso è nel punto più basso del perimetro, i due rami partono dal punto più alto e la loro sezione cresce verso valle con la portata raccolta; la pendenza di ogni tratto segue il terreno e non scende sotto il valore minimo impostato.") });
            ib.push({ table: { header: [tx("Fosso"), tx("Campo"), "ha", "l/s", tx("Lunghezza") + " (m)", "b (m)", "y (m)", "v (m/s)", tx("Sbocco") + " (m)", tx("Scavo") + " (m³)"],
              rows: DR.map((d) => [`F${d.n}`, d.f.name, n1(d.ha), n0(d.q), n0(d.L), n2(d.sec!.b), n2(d.sec!.y), n2(d.sec!.v), d.zOut != null ? n1(d.zOut) : "—", n0(d.cut)]) } });
          }
        }
        ch.push({ title: tx("Infrastrutture idriche esistenti e opere di presa"), blocks: ib });
        // Nota tecnica sulle stime – metodologia
        const cnum = ch.length + 1;
        ch.push({ title: tx("Nota tecnica sulle stime – metodologia"), blocks: [
          { p: tx("Le stime della relazione sono ottenute con criteri prudenti, adatti a una progettazione di massima, e vanno confermate con i rilievi in campo.") },
          { h: `${cnum}.1 ${tx("Stima del fabbisogno idrico")}`, toc: true },
          { p: tx("Il fabbisogno è calcolato con FAO-56 sui dati climatici del sito, con Kc per fase colturale e pioggia efficace prudenziale; la dose di progetto copre la punta della coltura più esigente.") },
          { h: `${cnum}.2 ${tx("Dimensionamento idraulico della rete")}`, toc: true },
          { p: tx("La rete è risolta come albero a partire dalla presa: la portata di ogni tratto è la somma delle portate a valle; il diametro è il più piccolo che rispetta la velocità massima di {v} m/s e le perdite di carico sono calcolate con Hazen-Williams (C = {c}).", { v: n1(vMax), c: fx(hwC) }) },
          { h: `${cnum}.3 ${tx("Metodologia di progettazione dell'impianto irriguo")}`, toc: true },
          { p: tx("I pivot sono disposti sul campo massimizzando la superficie irrigata nel rispetto delle pendenze ammesse; le campate sono composte dal listino del produttore con diametri scelti per la portata. Le pompe sono scelte sulle curve Caprari per il miglior rendimento e le linee elettriche per corrente e caduta di tensione.") },
        ] });
        // Struttura generale dell'impianto
        const sb: Record<string, unknown>[] = [
          { p: tx("L'impianto è organizzato in {nf} appezzamenti serviti da una rete di distribuzione unica; ogni pivot ha il proprio attacco con idrovalvola e la propria linea di alimentazione elettrica dalla stazione di pompaggio.", { nf: fx(fieldsShown.length) }) },
        ];
        const mRoad = roads.filter((r) => r.kind === "service" && !r.hidden).reduce((a, r) => a + r.coords.reduce((b, q, j, cc) => b + (j ? distM(cc[j - 1], q) : 0), 0), 0);
        if (mRoad > 0) sb.push({ p: tx("Le strade di servizio previste misurano {l} m e danno accesso ai punti pivot, alle stazioni e alle opere di presa.", { l: n0(mRoad) }) });
        if (nPhases > 1) {
          sb.push({ p: tx("La realizzazione è suddivisa in {n} fasi di superficie simile; la rete principale, la fonte d'acqua, le stazioni di pompaggio e l'eventuale impianto fotovoltaico sono realizzati nella prima fase.", { n: fx(nPhases) }) });
          sb.push({ table: { header: [tx("Fase"), tx("Pivot"), tx("Altri campi"), tx("Superficie") + " (ha)", "l/s"], widths: [16, 16, 20, 24, 24], rows: phaseSummary().map((r) => [fx(r.ph), fx(r.nPiv), fx(r.sys), n1(r.ha), n0(r.qLs)]) } });
        }
        ch.push({ title: tx("Struttura generale dell'impianto"), blocks: sb });
        // Linee guida di progettazione dell'impianto irriguo
        const lb: Record<string, unknown>[] = [];
        if (pivots.length) {
          const comp = pivots.map((pv) => spanComposition(pv, pivotBrand));
          lb.push({ p: tx("L'impianto è composto da {n} pivot {b}, per una superficie irrigata di {ha} ha. Ogni macchina è formata da campate in acciaio zincato, con diametro e lunghezza scelti in funzione della portata, e dallo sbraccio terminale; dove il campo lo richiede i pivot lavorano a settore e montano l'irrigatore finale.",
            { n: fx(pivots.length), b: PIVOT_BRANDS[pivotBrand], ha: n1(pivots.reduce((a, p) => a + pvAreaM2(p) / 10000, 0)) }) });
          lb.push({ figure: "plan", caption: tx("Planimetria dell'impianto: pivot, tubazioni, linee elettriche e stazioni di pompaggio") });
          lb.push({ table: { header: [tx("Pivot"), tx("Settore"), tx("Lunghezza") + " (m)", tx("Superficie") + " (ha)", tx("Campate"), tx("Sbraccio") + " (m)", tx("Irrigatore finale"), "l/s", "bar"], widths: [8, 9, 11, 11, 22, 9, 11, 9, 10],
            rows: pivots.map((pv, k) => { const c = comp[k], deg = pv.deg ?? 360; const sp = new Map<string, number>(); for (const x of c?.spans ?? []) { const kk = `${PIPE_TXT[x.pipe]} ${n1(x.len)} m`; sp.set(kk, (sp.get(kk) ?? 0) + 1); }
              return [`P${k + 1}`, deg >= 360 ? "360°" : `${Math.round(deg)}°`, n0(c ? c.total : pv.r), n2(pvAreaM2(pv) / 10000), [...sp.entries()].map(([kk, n]) => `${n} × ${kk}`).join(", ") || "—", c?.oh ? n1(c.oh) : "—", pv.gun && pv.gun > 0 ? `${n0(pv.gun)} m` : "—", n1(pivotFlow(pv)), n2(pivotPressure(pv))]; }) } });
          lb.push({ bullets: [tx("Lunghezza totale delle macchine: {l} m", { l: n0(comp.reduce((a, c, k) => a + (c ? c.total : pivots[k].r), 0)) }), tx("Campate totali: {n}", { n: fx(comp.reduce((a, c) => a + (c?.spans.length ?? 0), 0)) }),
            tx("Pressione massima all'ingresso dei pivot: {p} bar", { p: n2(P.pMaxBar) })] });
        }
        if (nSys) {
          const cats = new Set([tx("Lineari"), tx("Rotoloni"), tx("Goccia")]);
          const rr = computoRows().filter((r) => cats.has(r.cat.split(" · ")[0]));
          lb.push({ p: tx("Sui campi non coperti dai pivot sono previsti sistemi lineari, a rotolone o a goccia, descritti nella tabella seguente.") });
          lb.push({ table: { header: [tx("Campo"), tx("Voce"), tx("Quantità"), tx("Unità")], widths: [28, 44, 14, 14], rows: rr.map((r) => [r.cat, r.item, r.qty != null ? fx(r.qty) : "", r.unit]) } });
        }
        if (HY?.byDn.length) {
          lb.push({ h: tx("Rete di distribuzione") });
          lb.push({ p: tx("La distribuzione avviene con tubazioni interrate in PE100 PN10. I diametri sono scelti tratto per tratto in modo che la velocità non superi {v} m/s; le perdite di carico sono calcolate con la formula di Hazen-Williams (C = {c}).", { v: n1(vMax), c: fx(hwC) }) });
          lb.push({ table: { header: [tx("Diametro"), tx("Lunghezza") + " (m)"], widths: [50, 50], rows: [...HY.byDn].sort((a, b) => a[0] - b[0]).map(([dn, m]) => [`DN ${dn}`, n0(m)]) } });
          lb.push({ p: tx("La rete misura complessivamente {km} km e richiede alla presa una prevalenza di {h} m per garantire la pressione di esercizio al pivot più sfavorito.", { km: n2(HY.byDn.reduce((a, x) => a + x[1], 0) / 1000), h: n0(HY.headMax) }) });
          if (NF) {
            const fl: string[] = [];
            for (const [dn, n] of [...NF.air.entries()].sort((a, b) => a[0] - b[0])) if (dn) fl.push(`${tx("Sfiato d'aria")} DN ${dn}: ${fx(n)}`);
            if (NF.drains) fl.push(`${tx("Scarico")}: ${fx(NF.drains)}`);
            for (const [dn, n] of [...NF.tees.entries()].sort((a, b) => a[0] - b[0])) fl.push(`${tx("Tee")} DN ${dn}: ${fx(n)}`);
            for (const [k2, n] of NF.reds) fl.push(`${tx("Riduzione")} DN ${k2.replace("x", " × ")}: ${fx(n)}`);
            const mv = new Map<number, number>(); for (const pv of pivots) { const r = pivotRiser(pv); mv.set(r.mv, (mv.get(r.mv) ?? 0) + 1); }
            for (const [dn, n] of [...mv.entries()].sort((a, b) => a[0] - b[0])) fl.push(`${tx("Idrovalvola e diffusore del pivot")} DN ${dn}: ${fx(n)}`);
            lb.push({ p: NF.withProfile ? tx("Gli sfiati sono posti sui punti alti del profilo del terreno e gli scarichi nei punti bassi; all'attacco di ogni pivot sono previsti idrovalvola master e diffusore.")
              : tx("In assenza del profilo del terreno gli sfiati sono previsti ogni 500 m e all'inizio di ogni linea; all'attacco di ogni pivot sono previsti idrovalvola master e diffusore.") }, { bullets: fl });
          }
        }
        if (stations.length) {
          lb.push({ h: tx("Stazioni di pompaggio") });
          lb.push({ p: tx("Le pompe sono scelte sulle curve caratteristiche Caprari per il miglior rendimento al punto di lavoro, cioè alla portata e alla prevalenza richieste dall'impianto. Ogni stazione ha il proprio quadro di comando e protezione.") });
          lb.push({ table: { header: [tx("Stazione"), "l/s", "m", tx("Pompa"), tx("Motore") + " (kW)", "η (%)"], widths: [28, 9, 9, 32, 12, 10],
            rows: stations.map((st) => [st.name, n0(st.qLs), n0(st.head), st.pick ? `${st.nTot > 1 ? `${st.nTot} × ` : ""}Caprari ${st.pick.model}` : "—", st.pick ? n1(st.pick.motor) : n1(st.kW), st.pick ? n0(st.pick.eta) : "—"]) } });
        }
        { const WH = waterHammer();
          if (WH) {
            lb.push({ h: tx("Colpo d'ariete") });
            lb.push({ p: tx("All'arresto improvviso delle pompe la colonna d'acqua si ferma e genera un'onda di pressione (Joukowsky, ΔH = a·Δv/g). Con tubi in PE100 SDR17 la celerità dell'onda è di circa {a} m/s; sulla prevalenza di esercizio di {h} m la sovrappressione massima è di {d} m. Le valvole vanno chiuse in almeno {t} s (due volte il tempo di percorrenza della linea più lunga).", { a: n0(WH.a), h: n0(WH.Hop), d: n0(WH.dHmax), t: n0(Math.ceil(WH.tCrit)) })
              + " " + (WH.over || WH.vac ? tx("In alcuni tratti la pressione esce dai limiti del PN10: sono previsti tubi della classe indicata in tabella e una protezione contro il colpo d'ariete (cassa d'aria o valvola anticipatrice) all'uscita della stazione.") : tx("Con le velocità di progetto i tubi PN10 reggono il colpo d'ariete; sono comunque previsti sfiati nei punti alti e avvio e arresto graduali delle pompe.")) });
            lb.push({ table: { header: ["DN", "v (m/s)", "ΔH (m)", tx("Massimo") + " (m)", tx("Minimo") + " (m)", "PN"], rows: WH.rows.map((r) => [String(r.dn), n2(r.v), n0(r.dH), n0(r.hMax), n0(r.hMin), String(r.pn)]) } });
          }
        }
        { const us = pivots.map((pv) => pivotCU(pv)).filter((u): u is CuResult => !!u);
          if (us.length) {
            const lo = Math.min(...us.map((u) => u.CU)), hi = Math.max(...us.map((u) => u.CU)), pk = Math.max(...us.map((u) => u.peak));
            lb.push({ h: tx("Uniformità di distribuzione dei pivot") });
            lb.push({ p: tx("Per ogni pivot è stato generato lo sprinkler chart con irrigatori {m}: uscite a passo costante di 3 m dalla prima uscita a 7 m, portata di ogni uscita proporzionale al raggio e alla larghezza di competenza, ugello commerciale arrotondato e raggio bagnato dalle tabelle del costruttore. Il coefficiente di uniformità di Heermann-Hein risulta tra {a}% e {b}% ({g}); l'intensità istantanea di picco arriva a {p} mm/h e va confrontata con la velocità di infiltrazione del terreno.", { m: us[0].model, a: n1(lo), b: n1(hi), g: tx(cuGrade(lo)), p: n0(pk) }) });
          }
        }
        ch.push({ title: tx("Linee guida di progettazione dell'impianto irriguo"), blocks: lb });
        // Alimentazione elettrica
        const kp = stations.reduce((a, st) => a + (st.pick && !st.pick.diesel ? st.pick.motor * st.nTot : st.pick ? 0 : st.kW), 0);
        const eb: Record<string, unknown>[] = [{ p: tx("L'alimentazione prevista è: {a}. La potenza installata complessiva è di {kw} kW, di cui {kp} kW per le pompe; il consumo annuo stimato è di {mwh} MWh, pari a {kwhha} kWh per ettaro.",
          { a: VM.energy, kw: n0(G.kW), kp: n0(kp), mwh: n0(VM.mwh), kwhha: n0(VM.ha > 0 ? (VM.mwh * 1000) / VM.ha : 0) }) }];
        const dst = stations.filter((st) => st.pick?.diesel);
        if (dst.length) eb.push({ p: tx("Le pompe di superficie sono motopompe con motore diesel accoppiato tramite flangia SAE e giunto elastico: {l}. Il consumo stimato di gasolio è di {g} litri all'anno.", {
          l: dst.map((st) => `${st.name} (${st.nTot > 1 ? `${st.nTot} × ` : ""}${n0(st.pick!.motor)} kW, ${n0(st.pick!.rpm)} ${tx("giri/min")})`).join("; "),
          g: n0((VM.dieselMwh ?? 0) * 1000 * dieselLkWh) }) });
        if (G.supply === "mt") eb.push({ p: tx("Con la potenza installata è prevista una cabina di trasformazione MT/BT da {kva} kVA.", { kva: fx(G.kva) }) });
        if (G.supply === "bt") eb.push({ p: tx("La fornitura è in bassa tensione, con un punto di consegna dotato di quadro generale.") });
        if (G.supply === "gen") eb.push({ p: tx("Nelle ore senza sole l'energia è fornita da un gruppo elettrogeno da {kva} kVA.", { kva: fx(G.kva) }) });
        if (VM.pvKwp) eb.push({ p: tx("Il campo fotovoltaico ha una potenza di {kwp} kWp", { kwp: n0(VM.pvKwp) }) + (VM.battKwh ? " " + tx("con un accumulo a batterie di {kwh} kWh.", { kwh: n0(VM.battKwh) }) : ".") });
        const solP = pivots.filter((p) => p.solar);
        if (solP.length) {
          const tk2 = solP.reduce((a, p) => a + solarSize(p).kWp, 0);
          eb.push({ p: tx("{n} pivot sono alimentati da pannelli fotovoltaici posati accanto al perno centrale, per {k} kWp in tutto: le torri e l'irrigatore finale lavorano a energia solare e questi pivot non hanno la linea elettrica dalla stazione. Il campo è dimensionato con {f} kWp per ogni kW assorbito dal pivot.", { n: fx(solP.length), k: n1(tk2), f: n1(solarCfg.k) })
            + (solarCfg.batt > 0 ? " " + tx("Le batterie danno {h} ore di autonomia senza sole.", { h: fx(solarCfg.batt) }) : " " + tx("Senza batterie i pivot solari irrigano di giorno.")) });
          { const sm0 = pivotSolarMonths(solP[0]);
            if (sm0) {
              const ml = (i: number) => { try { return new Date(2026, i, 15).toLocaleString(pdfLang, { month: "long" }); } catch { return String(i + 1); } };
              const bad = sm0.rows.filter((r) => r.hNeed > 0.05 && r.hNeed > r.hSun + 1e-6).map((r) => ml(r.m));
              eb.push({ p: tx("Con l'irraggiamento medio del sito mese per mese, il campo FV regge da solo il motore del pivot per {h1}–{h2} ore al giorno.", { h1: n1(Math.min(...sm0.rows.map((r) => r.hSun))), h2: n1(Math.max(...sm0.rows.map((r) => r.hSun))) })
                + " " + (bad.length ? tx("Nei mesi di {m} le ore di marcia necessarie superano quelle di sole: servono circa {b} kWh di batterie per pivot, oppure si accetta di irrigare solo di giorno con una dose minore.", { m: bad.join(", "), b: n0(sm0.battMax) })
                  : tx("In tutti i mesi irrigui le ore di sole bastano per le ore di marcia necessarie: il pivot fa il suo giro di giorno senza batterie.")) });
            }
          }
          const taraHa = solP.reduce((a, p) => a + solarSize(p).taraM2, 0) / 1e4;
          eb.push({ p: tx("Il campo FV occupa un cerchio attorno al perno che il pivot attraversa senza irrigare: questa area è contata come tara ({ha} ha in tutto) e tolta dalla superficie irrigata, dalla portata e dai fabbisogni.", { ha: n1(taraHa) }) });
          eb.push({ table: { header: [tx("Pivot"), "kW", "kWp", tx("Moduli"), tx("Batterie") + " (kWh)", tx("Tara") + " Ø (m)", tx("Tara") + " (ha)"], widths: [12, 11, 13, 22, 14, 14, 14],
            rows: pivots.map((p, k) => (p.solar ? [`P${k + 1}`, n1(pivotKw(p)), n1(solarSize(p).kWp), `${solarSize(p).n} × ${solarCfg.wp} Wp`, solarSize(p).batt ? n0(solarSize(p).batt) : "—", n0(2 * solarSize(p).taraR), (solarSize(p).taraM2 / 1e4).toFixed(2)] : null)).filter(Boolean) as string[][] } });
        }
        eb.push({ p: tx("Le linee elettriche sono interrate, a 400 V; la sezione è scelta per la corrente di esercizio e una caduta di tensione non superiore al 4 %. I pivot sono alimentati dalla stazione che li serve, con le linee posate nella stessa trincea delle tubazioni.") });
        if (cabs.length) eb.push({ table: { header: [tx("Linea"), "kW", tx("Cavo"), tx("Lunghezza") + " (m)", "ΔV (%)"], widths: [38, 12, 22, 16, 12], rows: cabs.map((c) => [c.name, n1(c.kW), `${c.mat} 3 × ${n1(c.S)} mm²`, n0(c.L), n1(c.dv)]) } });
        if (G.panels.length) eb.push({ bullets: G.panels.map((pn) => `${tx("Quadro di comando delle pompe")} · ${pn.name}: ${pn.n} × ${n1(pn.kWp)} kW${pn.inverter ? ` · ${tx("Inverter")}` : ""}`) });
        ch.push({ title: tx("Alimentazione elettrica"), blocks: eb });
        // Gestione e funzionamento
        ch.push({ title: tx("Gestione e funzionamento"), blocks: [
          { p: tx("Nei mesi di punta l'impianto lavora {h} ore al giorno alla dose di progetto di {mm} mm. Il programma irriguo segue il fabbisogno della coltura, con turni assegnati ai pivot in modo da contenere la potenza impegnata e bilanciare le portate sulla rete.", { h: n1(hoursDay), mm: n1(mmDes) }) },
          { p: tx("Le stazioni di pompaggio sono dotate di quadri di comando e protezione e, dove previsto, di inverter per regolare la portata. La manutenzione ordinaria riguarda pompe, valvole, sfiati e scarichi della rete e le macchine di irrigazione.") },
          ...((() => { const FC = fertCalc(); if (!FC) return [];
            const pr = FERTS.find((x) => x.k === fert.k);
            return [{ h: tx("Fertirrigazione") },
              { p: tx("Il concime liquido ({p}, {n}% di N, {r} kg/l) è iniettato nella mandata di ogni pivot con una pompa dosatrice, distribuito su un giro intero: {d} kg di N per ettaro a intervento, {t} interventi per stagione. Un intervento su tutti i pivot richiede {l} l di prodotto; il serbatoio previsto è di {v} l.", { p: tx(pr?.label ?? "Altro prodotto"), n: n0(fert.n), r: n2(fert.rho), d: n0(fert.dose), t: n0(fert.times), l: n0(FC.lAll), v: n0(FC.tank) }) },
              { table: { header: [tx("Pivot"), "ha", tx("Prodotto") + " (l)", tx("Durata del giro") + " (h)", tx("Pompa") + " (l/h)", "N (mg/l)"], rows: FC.rows.map((r) => [r.names.join(", "), n1(r.ha), n0(r.l), n0(r.T), n1(r.lh), n0(r.ppm)]) } }]; })()),
          ...(soilSat ? [{ h: tx("Suolo") }, { p: tx("Il suolo dei campi, dalla banca dati SoilGrids (ISRIC, 250 m, strato 0-30 cm, {n} punti), ha sabbia {s}%, limo {l}% e argilla {a}%: classe USDA «{u}», «{k}» nella classificazione del progetto. Con le equazioni di Saxton l'acqua disponibile è di {taw} mm per metro di suolo; l'assorbimento di base assunto è di {i} mm/h.", { n: String(soilSat.n), s: n0(soilSat.sand), l: n0(soilSat.silt), a: n0(soilSat.clay), u: soilSat.usda, k: tx(soilOf(soilSat.key).label).toLowerCase(), taw: n0(soilSat.taw_mm_m), i: n1(infiltration) }) }] : []),
          ...((() => { const IP = irrigProgram(); if (!IP) return [];
            const ml = (i: number) => { try { return new Date(2026, i, 15).toLocaleString(pdfLang, { month: "long" }); } catch { return String(i + 1); } };
            return [{ h: tx("Programma irriguo mese per mese") },
              { p: tx("Programma per il pivot più grande (P{n}, {r} m; giro al 100% del timer in {h} h). La dose per giro è la minore fra l'acqua facilmente disponibile ({raw} mm: {taw} mm/m × {z} m di radici × {p}), la dose che il terreno assorbe senza ruscellamento in punta ({d}) e il fabbisogno di una settimana, e non scende sotto la dose al 100% del timer.", { n: String(pivots.indexOf(IP.pv) + 1), r: n0(IP.pv.r), h: n1(IP.T100), raw: n0(IP.RAW), taw: n0(IP.taw), z: n1(rootDepth), p: fx(rawP), d: Number.isFinite(IP.dRun) ? `${n1(IP.dRun)} mm` : tx("senza limite") }) },
              { table: { header: [tx("Mese"), tx("Fabbisogno lordo") + " (mm/g)", tx("Ore di marcia") + " (h/g)", tx("Dose per giro") + " (mm)", tx("Timer") + " (%)", tx("Durata del giro") + " (h)", tx("Giri a settimana")],
                rows: IP.rows.filter((r) => r.G > 0).map((r) => [ml(r.m), n1(r.G), n1(r.h), n0(r.D), n0(r.timer), n0(r.T), n1(r.perWeek)]) } },
              ...(IP.simul < pivots.length ? [{ p: tx("Con {q} l/s disponibili alla fonte lavorano insieme {s} pivot su {n}: i pivot si alternano a turni.", { q: n0(srcQmax), s: String(IP.simul), n: String(pivots.length) }) }] : [])]; })()),
        ] });
        // Prossimi passi raccomandati
        ch.push({ title: tx("Prossimi passi raccomandati"), blocks: [{ numbered: [
          tx("Rilievo topografico di dettaglio lungo i tracciati delle tubazioni e nelle aree dei pivot."), tx("Verifica della portata disponibile alla fonte e del livello dell'acqua nei mesi di punta."),
          tx("Analisi del suolo (tessitura, infiltrazione, salinità) per confermare dose e pluviometria."), tx("Verifica con il distributore di energia della potenza disponibile e del punto di consegna."),
          tx("Conferma dei tracciati e delle interferenze (strade, canali, sottoservizi) prima della posa.")] }] });
        // Note e limitazioni
        // Tavole esecutive allegate (PDF di progetto completo)
        const what: Record<TvKind, [string, string]> = { plan: [tx("Planimetria generale"), tx("Campi, pivot, rete di distribuzione, adduttrice, vasca e stazioni di pompaggio su ortofoto in scala")],
          pipe: [tx("Tavola delle tubazioni"), tx("Tratti, nodi e raccordi, valvole e apparecchiature, sezioni tipo di scavo e profilo longitudinale")],
          elec: [tx("Tavola delle linee elettriche"), tx("Linee elettriche, sezioni tipo di scavo dei cavi e schema unifilare")],
          dr: [tx("Tavola dei fossi di scolo"), tx("Fossi di scolo lungo i campi, portata di drenaggio, sezione tipo e scavi")],
          can: [tx("Tavola dei canali"), tx("Tracciato dei canali, sezione tipo con tirante e franco, profilo con fondo e pelo libero, scavi e rilevati")],
          phase: [tx("Fasi di realizzazione"), tx("Pivot e campi divisi per fase, con superficie e portata di ogni fase")],
          det: [tx("Pozzetti della rete"), tx("Pozzetti di sfiato e di scarico: schema tipo con le parti numerate")],
          wk: [tx("Disegno costruttivo"), tx("Viste quotate in scala, note di esecuzione e computo dei materiali della tavola (motore delle opere di Ceres)")],
          sch: [tx("Schede tecniche"), tx("Curve delle pompe con il punto di lavoro e composizione delle campate dei pivot")],
          cmp: [tx("Computo metrico"), tx("Quantità delle opere per categoria, senza prezzi, con i rimandi alle sigle delle tavole")] };
        const tk = opt?.tav?.kinds ?? [], tc = opt?.tav?.codes ?? [], tt2 = opt?.tav?.titles ?? [];
        const wTitle = (k: TvKind, i: number) => (k === "wk" ? (tt2[i] ?? "").split(" · ").slice(1).join(" · ") || what.wk[0] : what[k][0]);
        if (tk.length) {
          ch.push({ title: tx("Tavole esecutive"), blocks: [
            { p: tx("Fanno parte del progetto le tavole esecutive che seguono, allegate in coda alla presente relazione nel formato {f} orizzontale.", { f: pdfFormat.toUpperCase() }) },
            { table: { header: [tx("Codice"), tx("Titolo"), tx("Contenuto")], widths: [24, 26, 50],
              rows: tk.map((k, i) => [tc[i] ?? "", wTitle(k, i), what[k][1]]) } }] });
        }
        ch.push({ title: tx("Note e limitazioni"), blocks: [{ p: tx("Le stime contenute in questa relazione si basano sui dati disponibili in fase di progetto: confini digitalizzati dei campi, modello digitale del terreno, dati climatici e parametri di progetto indicati. I valori vanno confermati con i rilievi e le verifiche in campo prima della realizzazione; quantità e condizioni economiche sono riportate nell'offerta.") }] });
        const title = tx("Relazione tecnica generale"), revTxt = `Rev ${String(rev).padStart(2, "0")}`;
        return {
          lang: pdfLang, brand: relBrand,
          cover_title: `${tx("Impianto di irrigazione")}${pivots.length ? `\n${tx("a pivot centrale")}` : ""}`,
          title, revision: revTxt, date, client: cname || pname, recipient_label: tx("Alla cortese attenzione di"), recipient: cname ? [pname] : [],
          header: `${company} <> ${cname || pname} – ${title} – ${revTxt} – ${date}`, toc_title: tx("Indice"), figure_label: tx("Figura"), chapter_label: tx("Capitolo"), label: pname,
          site: { features: feats.filter((f) => f.properties?.tipo === "campo") }, plan: { features: feats }, chapters: ch,
          // elenco degli elaborati (pagina dopo la copertina), solo nel progetto completo
          ...(tk.length ? { elaborati: { title: tx("Elenco degli elaborati"),
            intro: tx("Il progetto «{p}» è composto dagli elaborati che seguono. Il codice di ogni elaborato riprende il riferimento del progetto in Mercurius (ARGUS-{id}); la revisione è la stessa per tutti.", { p: pname, id: fx(pid, { useGrouping: false }) }),
            header: [tx("Codice"), tx("Elaborato"), tx("Contenuto"), tx("Formato"), "Rev."], widths: [22, 20, 36, 14, 8],
            rows: [[`ARGUS-${pid}-REL-01`, tx("Relazione tecnica generale"), tx("Sito, clima e fabbisogno irriguo, portata, fonte d'acqua, rete, pompaggio ed energia"), "A4", String(rev).padStart(2, "0")],
              ...tk.map((k, i) => [tc[i] ?? "", wTitle(k, i), what[k][1], k === "sch" || k === "cmp" ? pdfFormat.toUpperCase() : `${k === "wk" ? "A3" : pdfFormat.toUpperCase()} ${tx("orizz.")}`, String(rev).padStart(2, "0")]),
              ...(opt?.tav?.full ? [[`ARGUS-${pid}-CMP-01`, tx("Computo metrico"), tx("Foglio di calcolo delle quantità, anche per fasi"), "XLSX", String(rev).padStart(2, "0")],
                [`ARGUS-${pid}`, tx("File di progetto per Ceres e Mercurius"), tx("Campi, pivot e computo per l'offerta"), ".ceres", String(rev).padStart(2, "0")],
                [`ARGUS-${pid}-GEO`, tx("Planimetria in formato GIS"), tx("Campi, pivot, rete, cavi e stazioni in coordinate WGS84"), "GeoJSON", String(rev).padStart(2, "0")]] : [])],
            note: tx("Tutti gli elaborati sono senza prezzi: quantità e condizioni economiche sono riportate nell'offerta.") } } : {}),
        };
      });
      const pname = projects.find((x) => x.id === pid)?.name || "progetto";
      const rb = await api.relazione(doc, bbox);
      if (opt?.out) { opt.out.blob = rb; return; }
      saveBlob(rb, `${safe(pname)}_relazione_tecnica.pdf`);
      setMsg(t("Relazione tecnica scaricata ✓"));
    } catch (e) { if (opt?.out) throw e; showErr(e); } finally { if (!opt?.out) setBusy(""); }
  }
  // PDF di progetto completo: relazione tecnica (A4 verticale) seguita dalle tavole esecutive (A3/A4 orizzontali)
  // PACCHETTO DI PROGETTO (ZIP): PDF di progetto (relazione A4 + tavole, particolari,
  // schede tecniche e computo), computo .xlsx, file .ceres e planimetria GeoJSON.
  // Tavole (nel browser) e relazione (sul server) si preparano in parallelo.
  const [prog, setProg] = useState<{ k: number; n: number; lab: string } | null>(null);
  async function downloadProgetto() {
    if (!projectId || !pivots.length) { setMsg(t("Posa prima i pivot sul campo attivo.")); return; }
    const pid = projectId, t0 = performance.now();
    revOverride.current = nextCeresRev();          // il pacchetto è una revisione nuova, come «Esporta per Ceres»
    const steps = [t("Dati del sito"), t("Tavole e relazione"), t("Unione dei PDF"), t("Computo, file .ceres e GeoJSON"), t("Pacchetto ZIP")];
    const step = (k: number) => setProg({ k, n: steps.length, lab: steps[k] });
    setBusy("all");
    try {
      step(0);
      ensureHydra();
      await Promise.all([ensureProfile(), siteClimateCached(), capRef.current ? Promise.resolve() : new Promise((r) => setTimeout(r, 800))]);
      step(1);
      const tav: TavOut = { full: true, defer: true }; await downloadTavole(tav);
      if (!tav.build) throw new Error(t("Errore generazione PDF"));
      const rel: { blob?: Blob } = {};
      const [tb] = await Promise.all([tav.build(), downloadRelazione({ tav, out: rel })]);
      if (!rel.blob) throw new Error(t("Errore generazione PDF"));
      step(2);
      const { PDFDocument } = await import("pdf-lib");
      const out = await PDFDocument.load(await rel.blob.arrayBuffer());
      const tv = await PDFDocument.load(await tb.arrayBuffer());
      (await out.copyPages(tv, tv.getPageIndices())).forEach((pg) => out.addPage(pg));
      const pname = projects.find((x) => x.id === pid)?.name || "progetto";
      out.setTitle(`${pname} · ${t("Progetto esecutivo")}`); out.setCreator(`Argus Total ${REV}`); out.setProducer("Argus Total · Nabu · Agrostar Group");
      const pdfBytes = await out.save();
      step(3);
      const rev = docRev(), base = `ARGUS-${pid}`;
      const zip = new JSZip();
      zip.file(`${base}_${safe(pname)}_progetto_esecutivo_rev${String(rev).padStart(2, "0")}.pdf`, pdfBytes);
      const xl = await computoXlsx(); if (xl) zip.file(`${base}-CMP-01_computo.xlsx`, xl);
      const cf = ceresFile(base, rev);
      if (!("err" in cf)) zip.file(`${base}_${safe(cf.name)}_rev${rev}.ceres`, JSON.stringify(await withPhoto(cf.file)));
      const ceresWarn = "err" in cf ? " " + t("Attenzione: il file .ceres non è nel pacchetto.") + " " + cf.err : "";
      const plan = (mercuriusComputo(base, rev).planimetria as { elementi?: { features?: unknown[] } } | undefined)?.elementi?.features ?? [];
      if (plan.length) zip.file(`${base}-GEO_planimetria.geojson`, JSON.stringify({ type: "FeatureCollection", features: plan }));
      { const dx = buildDxf(); if (dx) zip.file(`${base}-GEO_planimetria_UTM${dx.zone}.dxf`, dx.text); }
      step(4);
      const zb = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
      saveBlob(zb, `${base}_${safe(pname)}_progetto_rev${String(rev).padStart(2, "0")}.zip`);
      saveCeresRev(pid, rev);
      setMsg(t("Progetto esecutivo scaricato ✓ ({n} pagine)", { n: out.getPageCount() }) + ` · ${fmt((performance.now() - t0) / 1000, { maximumFractionDigits: 1 })} s`
        + " · " + t("Computo per Mercurius: riferimento {r}, revisione {v}.", { r: base, v: rev }) + ceresWarn);
    } catch (e) { showErr(e); } finally { revOverride.current = null; setBusy(""); setProg(null); }
  }
  function renderOlympus() {
    return (
      <div className="mt-3 bg-panel rounded-lg p-2 space-y-1.5">
        <button className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide w-full text-left" onClick={() => setOlyOpen((o) => !o)}>
          {olyOpen ? "▾" : "▸"} Olympus · Mercurius{olyUser ? ` · ${olyUser}` : ""}</button>
        {olyOpen && <>
          {!olyUser ? (
            <div className="space-y-1.5">
              <input className="field-input py-1 text-sm w-full" placeholder={t("Indirizzo di Olympus (es. olympus.agrostar.it)")} value={olyUrl} onChange={(e) => setOlyUrl(e.target.value)} />
              <input className="field-input py-1 text-sm w-full" type="email" placeholder="Email" autoComplete="username" value={olyEmail} onChange={(e) => setOlyEmail(e.target.value)} />
              <input className="field-input py-1 text-sm w-full" type="password" placeholder="Password" autoComplete="current-password" value={olyPass} onChange={(e) => setOlyPass(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") olyLogin(); }} />
              <button className="btn-ghost w-full text-[12px]" disabled={busy === "oly" || !olyUrl.trim() || !olyEmail.trim() || !olyPass} onClick={olyLogin}>{t("Accedi a Olympus")}</button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <button className="btn-primary w-full text-[12px]" disabled={busy === "oly" || !projectId || (!pivots.length && !Object.keys(sysDesigns).length)} onClick={() => olySend()}>
                {busy === "oly" ? t("Preparo…") : t("Invia il progetto a Olympus")}</button>
              {olyCustomers && (
                <div className="space-y-1">
                  <input className="field-input py-1 text-sm w-full" placeholder={t("Cerca il cliente in Olympus")} onKeyDown={(e) => { if (e.key === "Enter") olySearchCustomers((e.target as HTMLInputElement).value); }} />
                  <select className="field-input py-1 text-sm w-full" value={olyCust} onChange={(e) => setOlyCust(e.target.value)}>
                    {olyCustomers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <button className="btn-ghost w-full text-[12px]" disabled={!olyCust || busy === "oly"} onClick={() => olySend(olyCust)}>{t("Invia con questo cliente")}</button>
                  {(clients.find((c) => c.id === clientId)?.name ?? "").trim().length >= 2 && olyTerrs.length > 0 && (
                    <select className="field-input py-1 text-sm w-full" value={olyTerr} onChange={(e) => setOlyTerr(e.target.value)}>
                      <option value="">{t("Regione o Paese del cliente nuovo")}</option>
                      {olyTerrs.map((x) => <option key={x.v} value={x.v}>{x.n}</option>)}
                    </select>)}
                  {(clients.find((c) => c.id === clientId)?.name ?? "").trim().length >= 2 && (
                    <button className="btn-ghost w-full text-[12px]" disabled={busy === "oly" || !olyTerr} onClick={() => olySend(undefined, clients.find((c) => c.id === clientId)!.name.trim())}>
                      {t("Crea il cliente «{n}» in Olympus e invia", { n: clients.find((c) => c.id === clientId)!.name.trim() })}</button>)}
                </div>
              )}
              <div className="flex gap-2">
                <button className="btn-ghost flex-1 text-[12px]" disabled={busy === "oly"} onClick={olyCatalog}>{t("Aggiorna catalogo")}</button>
                <button className="btn-ghost flex-1 text-[12px]" onClick={olyLogout}>{t("Esci")}</button>
              </div>
            </div>
          )}
          <label className="text-[11px] text-brand cursor-pointer hover:underline block">{t("Carica il catalogo da file (olympus-catalogo.json)")}
            <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) catalogFromFile(f); e.target.value = ""; }} /></label>
          <p className="text-[10px] text-sage-dark leading-snug">{olyCat ? t("Catalogo Olympus: {n} articoli. Le voci senza codice prendono quello dell'articolo corrispondente.", { n: fmt(Object.keys(olyCat).length) }) : t("Senza catalogo le voci che Argus non sa codificare arrivano in Mercurius «da prezzare».")}</p>
          {olyMsg && <p className={`text-[11px] leading-snug ${olyMsg.bad ? "text-danger" : "text-brand-darker"}`}>{olyMsg.m}</p>}
          {olyLink && <a className="text-[12px] text-brand font-semibold hover:underline block" href={olyLink} target="_blank" rel="noopener noreferrer">{t("Apri il progetto in Olympus")} ↗</a>}
        </>}
      </div>
    );
  }
  // ---- COMPUTO PER MERCURIUS (tracciato «ceres/computo-metrico» v1) ----------
  // Va nello stesso file .ceres, accanto ad app/ver/name/m: Ceres lo ignora,
  // Olympus/Mercurius lo importa e ne fa l'offerta. Righe a codice del catalogo
  // Mercurius (senza prezzi); dove il catalogo non ha l'articolo il codice è
  // ARGUS-… e la riga arriva «da prezzare». Descrizioni in italiano (catalogo).
  // ---- POMPE CAPRARI, CAVI, PESI, CATALOGO OLYMPUS ---------------------------
  // Banca dati delle pompe Caprari: la stessa di Ceres (curve dal catalogo),
  // in public/caprari.json, caricata una volta sola.
  // [famiglia, modello, giri/min, motore kW | null, [[q m³/h, H m, NPSHr m, P kW]…]]
  type CapPump = [string, string, number, number | null, (number | null)[][]];
  const capRef = useRef<CapPump[] | null>(null);
  const [capReady, setCapReady] = useState(false);
  useEffect(() => {
    fetch("/caprari.json").then((r) => (r.ok ? r.json() : null)).then((d) => { if (Array.isArray(d)) { capRef.current = d; setCapReady(true); } }).catch(() => { /* senza curve resta la stazione generica */ });
  }, []);
  type PumpPick = { model: string; fam: string; rpm: number; n: number; motor: number; pAbs: number; eta: number; H: number; q: number; diesel?: boolean };
  // Curve a motore elettrico: 2 o 4 poli a 50 Hz; le velocità intermedie e la serie
  // MEC-MG (flangia SAE per motori diesel) vanno solo con il motore termico.
  const electricRpm = (model: string, rpm: number) => (rpm === 1450 || rpm === 2900) && !/^MEC-MG/i.test(model);
  // La pompa con il rendimento migliore che dà almeno la prevalenza richiesta
  // (fino a +12 %, poi +25 %) alla portata di una pompa; nFix fissa quante
  // pompe lavorano in parallelo, altrimenti si prova da 1 a 4.
  function pickPump(qLs: number, head: number, well: boolean, nFix?: number): PumpPick | null {
    const db = capRef.current; if (!db || !(qLs > 0) || !(head > 0)) return null;
    const fams = well ? ["vert", "subm"] : ["horiz"];
    const ns = nFix ? [nFix] : [1, 2, 3, 4];
    let best: PumpPick | null = null, bestScore = -Infinity;
    for (const tol of [1.12, 1.25]) {
      for (const n of ns) {
        const q = (qLs * 3.6) / n;
        for (const [fam, model, rpm, mkw, pts] of db) {
          if (!fams.includes(fam)) continue;
          const diesel = fam === "horiz" && pumpDrive === "diesel";
          if (fam === "horiz" && !diesel && !electricRpm(model, rpm)) continue;
          const P = pts.filter((p) => p[0] != null && p[1] != null) as number[][];
          if (P.length < 2 || q < P[0][0] || q > P[P.length - 1][0]) continue;
          let i = 1; while (i < P.length - 1 && P[i][0] < q) i++;
          const a = P[i - 1], b = P[i], f = (q - a[0]) / ((b[0] - a[0]) || 1);
          const H = a[1] + (b[1] - a[1]) * f;
          if (H < head || H > head * tol) continue;
          const pw = a[3] != null && b[3] != null ? a[3] + (b[3] - a[3]) * f : null;
          const eta = pw && pw > 0 ? Math.min(0.9, (q * H) / 367 / pw) : 0.6;
          const pA = pw && pw > 0 ? pw : (q * H) / 367 / 0.6;
          // diesel: potenza continua del motore con il 20 % di margine (altitudine, temperatura, giri)
          const motor = diesel ? Math.ceil(pA * 1.2) : mkw ?? (STD_KW.find((k) => k >= pA * 1.1) ?? Math.ceil(pA * 1.1));
          const score = eta * 100 - n * 2 - (H / head - 1) * 30;
          if (score > bestScore) { bestScore = score; best = { model, fam, rpm, n, motor, pAbs: pA * n, eta: eta * 100, H, q, diesel }; }
        }
      }
      if (best) break;
    }
    return best;
  }
  // Inizio della rete (dove sta la stazione quando non c'è la fonte d'acqua)
  const pipeStart = (): number[] | null => pivotLines.find((l) => l.kind === "pipe" && l.coords.length >= 2)?.coords[0] ?? null;
  type PStation = { name: string; qLs: number; head: number; kW: number; nTot: number; nDuty: number; pt: number[] | null; well: boolean; pick: PumpPick | null };
  // Le stazioni di pompaggio del progetto: gli stadi dello schema della fonte
  // (presa alla fonte, rilanci alla vasca) oppure la stazione della pagina Pompaggio.
  function pumpStationsList(): PStation[] {
    const S = srcPt && pivots.length ? sourceSchemes() : null;
    const sc = S ? (S.schemes.find((x) => x.key === (srcShown ?? S.best?.key)) ?? null) : null;
    const out: PStation[] = [];
    if (sc) {
      const resPt = srcRoute && srcRoute.length >= 2 ? srcRoute[srcRoute.length - 1] : srcPt;
      sc.stages.forEach((st, i) => {
        const intake = i === 0 && sc.key !== "C";
        const well = intake && srcType === "pozzo";
        const pick = pickPump(st.qLs, st.head, well);
        const kW = pick ? pick.motor * pick.n : (STD_KW.find((k) => k >= st.kW * 1.1) ?? Math.ceil(st.kW));
        out.push({ name: st.name, qLs: st.qLs, head: st.head, kW, nTot: pick?.n ?? 1, nDuty: pick?.n ?? 1, pt: intake ? srcPt : resPt, well, pick });
      });
    } else if (pivots.length) {
      const P = pumpStation();
      if (P.best) {
        const pick = pickPump(P.qDes, P.head, false, P.best.nDuty);
        out.push({ name: tx("Stazione di pompaggio"), qLs: P.qDes, head: P.head, kW: P.best.kWInst, nTot: P.best.nTot, nDuty: P.best.nDuty,
          pt: srcPt ?? pipeStart(), well: false, pick });
      }
    }
    return out;
  }
  // ---- Linee elettriche --------------------------------------------------------
  // Sezione minima che regge la corrente (posa interrata) con caduta di tensione
  // ≤ 4 % a 400 V, cos φ 0,85: rame fino a 16 mm², alluminio dai 25 mm² in su
  // (le sezioni del listino Ceres/Mercurius: E-CU-…, E-AL-…).
  type CableRun = { name: string; kW: number; L: number; mat: "Cu" | "Al"; S: number; dv: number; I: number; coords?: number[][] };
  function cableFor(kW: number, L: number): { mat: "Cu" | "Al"; S: number; dv: number; I: number } {
    const I = (kW * 1000) / (Math.sqrt(3) * 400 * 0.85 * 0.9);
    const dv = (rho: number, S: number) => ((Math.sqrt(3) * I * L * (rho / S) * 0.85) / 400) * 100;
    for (const [S, amp] of [[2.5, 32], [10, 70], [16, 91]]) if (amp >= I && dv(0.0225, S) <= 4) return { mat: "Cu", S, dv: dv(0.0225, S), I };
    for (const [S, amp] of [[25, 90], [35, 109], [50, 129], [70, 159], [95, 188], [120, 214], [150, 242], [185, 271], [240, 313], [300, 351]])
      if (amp >= I && dv(0.036, S) <= 4) return { mat: "Al", S, dv: dv(0.036, S), I };
    return { mat: "Al", S: 300, dv: dv(0.036, 300), I };
  }
  const distM = (a: number[], b: number[]) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180), (a[1] - b[1]) * 110540);
  // Alimentazione delle pompe (dal punto di consegna dell'energia, distanza
  // impostata in Pompaggio) e dei pivot (dalla stazione al punto pivot: torri
  // 0,75 kW ciascuna, più la pompa di rilancio dell'irrigatore finale).
  // Percorso lungo le tubazioni (stessa trincea): Dijkstra sui vertici della rete
  function netPaths() {
    const key = (q: number[]) => `${q[0].toFixed(5)},${q[1].toFixed(5)}`;
    const pos = new Map<string, number[]>(), adj = new Map<string, [string, number][]>();
    for (const l of pivotLines) if (l.kind === "pipe") for (let k = 0; k < l.coords.length - 1; k++) {
      const A = l.coords[k], B = l.coords[k + 1], a = key(A), b = key(B), d = distM(A, B);
      pos.set(a, A); pos.set(b, B);
      (adj.get(a) ?? adj.set(a, []).get(a))!.push([b, d]); (adj.get(b) ?? adj.set(b, []).get(b))!.push([a, d]);
    }
    // il punto della rete più vicino: proiezione sul tratto più vicino
    const segs: [string, string][] = [];
    for (const [a, l] of adj) for (const [b] of l) if (a < b) segs.push([a, b]);
    const snap = (p: number[]) => {
      let best: { a: string; b: string; q: number[]; d: number; da: number; db: number } | null = null;
      for (const [a, b] of segs) {
        const A = pos.get(a)!, B = pos.get(b)!;
        const kx = 111320 * Math.cos((p[1] * Math.PI) / 180), ky = 110540;
        const vx = (B[0] - A[0]) * kx, vy = (B[1] - A[1]) * ky, l2 = vx * vx + vy * vy || 1e-9;
        const tt = Math.max(0, Math.min(1, (((p[0] - A[0]) * kx) * vx + ((p[1] - A[1]) * ky) * vy) / l2));
        const q = [A[0] + (B[0] - A[0]) * tt, A[1] + (B[1] - A[1]) * tt], d = distM(p, q);
        if (!best || d < best.d) best = { a, b, q, d, da: distM(q, A), db: distM(q, B) };
      }
      return best;
    };
    const cache = new Map<string, { dist: Map<string, number>; prev: Map<string, string> }>();
    const tree = (src: string) => {
      const c = cache.get(src); if (c) return c;
      const dist = new Map<string, number>([[src, 0]]), prev = new Map<string, string>(), done = new Set<string>();
      for (;;) {
        let u = "", ud = Infinity; for (const [k, d] of dist) if (!done.has(k) && d < ud) { ud = d; u = k; }
        if (!u) break; done.add(u);
        for (const [v, w] of adj.get(u) ?? []) if (ud + w < (dist.get(v) ?? Infinity)) { dist.set(v, ud + w); prev.set(v, u); }
      }
      const r = { dist, prev }; cache.set(src, r); return r;
    };
    return (from: number[], to: number[]): { coords: number[][]; L: number } | null => {
      const f = snap(from), g = snap(to); if (!f || !g) return null;
      // stesso tratto: si scorre direttamente lungo il tubo
      if ((f.a === g.a && f.b === g.b)) return { coords: [from, f.q, g.q, to], L: f.d + distM(f.q, g.q) + g.d };
      let best: { L: number; e1: string; e2: string } | null = null;
      for (const [e1, d1] of [[f.a, f.da], [f.b, f.db]] as [string, number][]) {
        const { dist } = tree(e1);
        for (const [e2, d2] of [[g.a, g.da], [g.b, g.db]] as [string, number][]) {
          const D = dist.get(e2); if (D == null) continue;
          const L = d1 + D + d2; if (!best || L < best.L) best = { L, e1, e2 };
        }
      }
      if (!best) return null;
      const { prev } = tree(best.e1);
      const path: number[][] = []; for (let k: string | undefined = best.e2; k; k = prev.get(k)) path.unshift(pos.get(k)!);
      return { coords: [from, f.q, ...path, g.q, to], L: f.d + best.L + g.d };
    };
  }
  function cableRuns(stations?: PStation[]): CableRun[] {
    const out: CableRun[] = [];
    const route = netPaths();
    const st = stations ?? pumpStationsList();
    for (const s of st) {
      if (s.pick?.diesel) continue;                                  // motopompa: niente linea elettrica
      const kW = s.pick ? s.pick.motor * s.nDuty : s.kW;
      if (!(kW > 0) || !(cableM > 0)) continue;
      out.push({ name: `${tx("alimentazione")} · ${s.name}`, kW, L: Math.round(cableM), ...cableFor(kW, cableM) });
    }
    const feed = st.length ? st[st.length - 1].pt : (srcPt ?? pipeStart());
    if (feed) pivots.forEach((pv, k) => {
      if (pv.solar) return;                                          // pivot solare: niente linea dalla stazione
      const c = spanComposition(pv, pivotBrand);
      const kW = (c ? c.spans.length : Math.max(1, Math.round(pv.r / 50))) * 0.75 + (pv.gun && pv.gun > 0 ? 1.5 : 0);
      // lungo la rete (stessa trincea del tubo, +3 % di scorta); senza rete in linea retta +15 %
      const r = route(feed, [pv.lng, pv.lat]);
      const L = Math.max(10, Math.round(r ? r.L * 1.03 : distM(feed, [pv.lng, pv.lat]) * 1.15));
      out.push({ name: `${tx("alimentazione")} · P${k + 1}`, kW, L, ...cableFor(kW, L), coords: r ? r.coords : [feed, [pv.lng, pv.lat]] });
    });
    return out;
  }
  // ---- Pesi unitari (per la spedizione in Mercurius) ----------------------------
  // Campate e sbracci Star Pivot dalla tabella del costruttore (come Ceres:
  // la voce più vicina per lunghezza); senza tabella, tubo d'acciaio + traliccio.
  const SPAN_KG: Record<number, number[][]> = {
    127: [[38.3, 1250], [44.2, 1367], [50.1, 1489], [56.1, 1614], [62, 1736]],
    168: [[38.3, 1457], [44.2, 1593], [50.1, 1748], [56.1, 1893], [62, 2047]],
    219: [[38.3, 1611], [44.2, 1643], [50.1, 1966], [56.1, 2191]] };
  const OVER_KG = [[1.8, 35], [3.7, 64], [5.9, 126], [7.8, 182], [9.6, 251], [11.9, 269], [13.7, 289], [15.5, 389], [17.8, 378], [19.7, 398], [23.8, 468], [25.6, 488]];
  const PIPE_MM = [254, 219, 168];
  const nearest = (tb: number[][], x: number) => tb.reduce((a, r) => (Math.abs(r[0] - x) < Math.abs(a[0] - x) ? r : a), tb[0]);
  function spanKg(pi: number, len: number): number {
    const dmm = PIPE_MM[pi] ?? 168, tb = SPAN_KG[dmm];
    if (tb) return nearest(tb, len)[1];
    const w = (dmm >= 250 ? 3.4 : dmm >= 200 ? 3 : 2.77) / 1000;
    return Math.PI * (dmm / 1000 - w) * w * 7850 * 1.9 * len;
  }
  const overKg = (len: number) => nearest(OVER_KG, len)[1];
  // PE100 PN10 = SDR 17, densità 0,95 kg/dm³ (kg al metro)
  const pipeKg = (dn: number) => { const e = dn / 17 / 1000; return 950 * Math.PI * (dn / 1000 - e) * e; };
  // ---- Profilo della rete e pezzi speciali ----------------------------------------
  // Quote del terreno lungo le tubazioni (un punto ogni ~50 m): gli sfiati vanno
  // sui colmi e gli scarichi negli avvallamenti. Si scarica una volta per forma della rete.
  const netProfRef = useRef<{ sig: string; lines: Map<number, { d: number[]; z: (number | null)[] }> } | null>(null);
  const netSig = () => JSON.stringify(pivotLines.filter((l) => l.kind === "pipe").map((l) => l.coords));
  async function ensureProfile() {
    const sig = netSig(); if (netProfRef.current?.sig === sig) return;
    const pipes = pivotLines.map((l, i) => ({ l, i })).filter((x) => x.l.kind === "pipe" && x.l.coords.length >= 2);
    if (!pipes.length) { netProfRef.current = { sig, lines: new Map() }; return; }
    const tot = pipes.reduce((a, { l }) => a + l.coords.reduce((b, q, k, c) => b + (k ? distM(c[k - 1], q) : 0), 0), 0);
    const step = Math.max(50, tot / 900);
    const pts: number[][] = []; const owner: { i: number; d: number }[] = [];
    for (const { l, i } of pipes) {
      let d0 = 0;
      for (let k = 0; k < l.coords.length - 1; k++) {
        const A = l.coords[k], B = l.coords[k + 1], L = distM(A, B), n = Math.max(1, Math.ceil(L / step));
        for (let j = 0; j < n; j++) { const f = j / n; pts.push([A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f]); owner.push({ i, d: d0 + L * f }); }
        d0 += L;
      }
      pts.push(l.coords[l.coords.length - 1]); owner.push({ i, d: d0 });
    }
    const lines = new Map<number, { d: number[]; z: (number | null)[] }>();
    const saved = projSettings().net_profile;
    if (saved?.sig === sig && Array.isArray(saved.lines)) {
      for (const [i, d, z] of saved.lines) lines.set(i, { d, z });
      netProfRef.current = { sig, lines }; return;
    }
    try {
      const r = await api.fetchElevation(pts);
      r.points.forEach((q, k) => { const o = owner[k]; const e = lines.get(o.i) ?? { d: [], z: [] }; e.d.push(o.d); e.z.push(q.elev_m); lines.set(o.i, e); });
    } catch { /* senza quote: regola dei 500 m */ }
    netProfRef.current = { sig, lines };
    if (projectId && lines.size && sig.length < 60000)
      patchSettings(projectId, { net_profile: { sig, lines: [...lines.entries()].map(([i, e]) => [i, e.d.map((x) => Math.round(x * 10) / 10), e.z.map((z) => (z == null ? null : Math.round(z * 10) / 10))]) } });
  }
  type NetFit = { air: Map<number, number>; drains: number; tees: Map<number, number>; reds: Map<string, number>; withProfile: boolean };
  // Sfiati (inizio linea + colmi con almeno 1 m di risalita, o ogni 500 m senza
  // quote), scarichi (avvallamenti e fondi linea), tee sui nodi a 3+ vie,
  // riduzioni dove il diametro cambia.
  function netFittings(HY: HydraRes | null): NetFit | null {
    if (!HY?.lines?.length) return null;
    const air = new Map<number, number>(), tees = new Map<number, number>(), reds = new Map<string, number>();
    let drains = 0, withProfile = false;
    const inc = (m: Map<number, number>, k: number) => m.set(k, (m.get(k) ?? 0) + 1);
    const prof = netProfRef.current?.sig === netSig() ? netProfRef.current.lines : null;
    const key = (q: number[]) => `${q[0].toFixed(5)},${q[1].toFixed(5)}`;
    const nodes = new Map<string, number[]>();
    for (const [i, dns, ls] of HY.lines) {
      const co = pivotLines[i]?.coords; if (!co) continue;
      dns.forEach((d, k) => { if (d > 0) { for (const q of [co[k], co[k + 1]]) (nodes.get(key(q)) ?? nodes.set(key(q), []).get(key(q))!).push(d); } });
      const dnAt = (x: number) => { let c = 0; for (let k = 0; k < ls.length; k++) { c += ls[k]; if (x <= c + 1e-6) return dns[k] || 0; } return dns[dns.length - 1] || 0; };
      if (!dns.some((d) => d > 0)) continue;
      const pr = prof?.get(i);
      const ok = pr ? pr.z.filter((z) => z != null).length >= 3 : false;
      if (ok && pr) {
        withProfile = true;
        const n = pr.d.length, z = pr.z.map((v) => v ?? NaN);
        const win = (k: number, r: number) => { const o: number[] = []; for (let j = 0; j < n; j++) if (Math.abs(pr.d[j] - pr.d[k]) <= r && Number.isFinite(z[j])) o.push(z[j]); return o; };
        inc(air, dnAt(0));
        let dl = 0;
        for (let k = 1; k < n - 1; k++) {
          if (!Number.isFinite(z[k])) continue;
          const near = win(k, 150), far = win(k, 400);
          if (z[k] >= Math.max(...near) && z[k] - Math.min(...far) >= 1) inc(air, dnAt(pr.d[k]));
          else if (z[k] <= Math.min(...near) && Math.max(...far) - z[k] >= 1) dl++;
        }
        if (Number.isFinite(z[n - 1]) && Number.isFinite(z[n - 2]) && z[n - 1] < z[n - 2]) dl++; else inc(air, dnAt(pr.d[n - 1]));
        drains += Math.max(1, dl);   // almeno uno scarico nel punto più basso della linea
      } else {
        let run = 0; inc(air, dnAt(0));
        dns.forEach((d, k) => { run += ls[k] ?? 0; while (run >= 500 && d > 0) { inc(air, d); run -= 500; } });
        drains++;
      }
    }
    for (const ds of nodes.values()) {
      const mx = Math.max(...ds), mn = Math.min(...ds);
      if (ds.length >= 3) inc(tees, mx);
      if (ds.length >= 2 && mn < mx) { const k = `${mx}x${mn}`; reds.set(k, (reds.get(k) ?? 0) + 1); }
    }
    return { air, drains, tees, reds, withProfile };
  }
  // Attacco del pivot: idrovalvola master (velocità ≤ 2,5 m/s) e diffusore verso il tubo della prima campata.
  function pivotRiser(pv: PivotItem): { mv: number; pipe: string } {
    const q = pivotFlow(pv) / 1000, need = Math.sqrt((4 * q) / (Math.PI * 2.5)) * 1000;
    const mv = [100, 125, 150, 200, 250, 300].find((d) => d >= need) ?? 300;
    const c = spanComposition(pv, pivotBrand);
    return { mv, pipe: ["10", "8-5-8", "6-5-8"][c?.spans[0]?.pipe ?? 2] };
  }
  // ---- PIVOT SOLARI: campo fotovoltaico accanto al centro del pivot ---------------------
  // Le torri (0,75 kW l'una) e l'irrigatore finale (1,5 kW) vanno a pannelli: il pivot non ha
  // la linea elettrica dalla stazione. kWp = potenza del pivot × fattore (rendimento del
  // sistema e ore di sole ridotte a inizio e fine giornata); batterie per le ore di autonomia.
  // il numero di torri non dipende dalla tara: si passa il pivot senza "solar" (evita il giro tara → kW → campate → portata → tara)
  const pivotKw = (pv: PivotItem) => (spanComposition({ r: pv.r, gun: pv.gun, q: pv.q, deg: pv.deg }, pivotBrand)?.spans.length ?? Math.max(1, Math.round(pv.r / 50))) * 0.75 + (pv.gun && pv.gun > 0 ? 1.5 : 0);
  function solarSize(pv: PivotItem) {
    const kW = pivotKw(pv), n = Math.max(2, Math.ceil((kW * solarCfg.k * 1000) / Math.max(100, solarCfg.wp)));
    const cols = Math.max(2, Math.ceil(Math.sqrt(n * 1.8))), rows = Math.ceil(n / cols);
    // tara: cerchio attorno al perno che contiene tutto il campo FV + 3 m di rispetto (il pivot ci gira sopra senza irrigare)
    const W = cols * 1.154 - 0.02, D = (rows - 1) * 3.5 + 2.065, taraR = Math.ceil(Math.max(solarCfg.off + D + 3, Math.hypot(solarCfg.off + D, W / 2) + 1));
    const taraM2 = (Math.max(1, Math.min(360, pv.deg ?? 360)) / 360) * Math.PI * taraR * taraR;
    return { kW, n, kWp: (n * solarCfg.wp) / 1000, rows, cols, batt: solarCfg.batt > 0 ? Math.ceil((kW * solarCfg.batt) / 0.9) : 0, inv: Math.ceil(kW * 1.25), taraR, taraM2 };
  }
  solarTaraR = (p) => (p.solar ? solarSize(p as PivotItem).taraR : 0);
  // moduli verticali 1,13 × 2,28 m inclinati di 25° (ingombro in pianta 1,13 × 2,07 m), file a 3,5 m,
  // a sud del centro (a nord nell'emisfero australe), a «off» metri dal perno
  function solarPolys(pv: PivotItem): [number, number][][] {
    const S2 = solarSize(pv), kx = 111320 * Math.cos((pv.lat * Math.PI) / 180), sgn = pv.lat >= 0 ? -1 : 1, mw = 1.13, md = 2.07, pitch = 3.5;
    const out: [number, number][][] = [], w = S2.cols * (mw + 0.02);
    for (let k = 0; k < S2.n; k++) {
      const r = Math.floor(k / S2.cols), c = k % S2.cols, x0 = -w / 2 + c * (mw + 0.02), y0 = solarCfg.off + r * pitch;
      const pt = (x: number, y: number): [number, number] => [pv.lat + (sgn * y) / 110540, pv.lng + x / kx];
      out.push([pt(x0, y0), pt(x0 + mw, y0), pt(x0 + mw, y0 + md), pt(x0, y0 + md)]);
    }
    return out;
  }
  // ---- Quadri, inverter e consegna dell'energia ----------------------------------------
  const KVA = [100, 160, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500];
  function powerGear(stations: PStation[]) {
    const solar = powerMode === "solar" || srcEnergy !== "rete";
    const elec = stations.filter((st) => !st.pick?.diesel);           // le motopompe hanno il loro quadro motore
    const panels = elec.map((st) => {
      const kWp = st.pick ? st.pick.motor : st.kW / Math.max(1, st.nDuty);
      return { name: st.name, n: st.nTot, kWp, inverter: solar || kWp >= 15 };
    });
    const pivKW = pivots.reduce((a, pv) => a + (pv.solar ? 0 : pivotKw(pv)), 0);   // i pivot solari hanno i loro pannelli
    const kW = elec.reduce((a, st) => a + (st.pick ? st.pick.motor * st.nDuty : st.kW), 0) + pivKW;
    const kva = KVA.find((k) => k >= kW / 0.85 / 0.8) ?? Math.ceil(kW / 0.85 / 0.8);
    const supply = srcEnergy === "fv-gen" ? "gen" : srcEnergy === "fv-batt" && powerMode === "solar" ? "pv" : kW > 100 ? "mt" : "bt";
    return { panels, kW, kva, supply };
  }
  // ---- Catalogo Olympus (codici, nomi e unità: i prezzi non si tengono) ----------
  const [olyCat, setOlyCat] = useState<Record<string, [string, string]> | null>(null);
  useEffect(() => {
    try { const s = localStorage.getItem("argus-olympus-catalog"); if (s) setOlyCat(JSON.parse(s)); } catch { /* catalogo assente */ }
  }, []);
  function storeCatalog(d: unknown): number {
    const arts = (d as { tracciato?: string; articoli?: { codice?: string; nome?: string; unita?: string }[] });
    if (!arts || arts.tracciato !== "olympus/catalogo" || !Array.isArray(arts.articoli)) throw new Error(t("Il file non è un catalogo Olympus (olympus/catalogo)."));
    const cat: Record<string, [string, string]> = {};
    for (const a of arts.articoli) if (a.codice) cat[String(a.codice).replace(/^CERES-/i, "").toUpperCase()] = [String(a.nome ?? ""), String(a.unita ?? "")];
    setOlyCat(cat);
    try { localStorage.setItem("argus-olympus-catalog", JSON.stringify(cat)); } catch { /* troppo grande: resta in memoria */ }
    return Object.keys(cat).length;
  }
  // Voci senza codice di catalogo (ARGUS-…) → articolo del catalogo che le
  // descrive, con la stessa unità; tubi di una PN che manca → PN vicina.
  const CAT_RULES: { re: RegExp; name: RegExp; unit?: RegExp; not?: RegExp }[] = [
    { re: /^ARGUS-FV$/, name: /fotovolt/i, unit: /^kwp$/i },
    { re: /^ARGUS-BATTERIE$/, name: /batteri|accumul/i, unit: /^kwh$/i },
    { re: /^ARGUS-SCAVO-VASCA$/, name: /scavo/i, unit: /^(m3|m³|mc)$/i },
    { re: /^ARGUS-ALA-GOCCIOLANTE$/, name: /gocciolant/i, unit: /^m$/i },
    { re: /^ARGUS-ROTOLONE$/, name: /rotolon|semovent/i, unit: /^pz$/i, not: /ombelical/i },
    { re: /^ARGUS-FILTRAZIONE$/, name: /filtrazion/i, unit: /^pz$/i },
    { re: /^ARGUS-VALVOLA-SETTORE$/, name: /elettrovalvol|valvola di settore/i, unit: /^pz$/i },
    { re: /^ARGUS-CANALE/, name: /canal/i, unit: /^m$/i },
    { re: /^ARGUS-STRADA/, name: /strad|viabilit/i, unit: /^m$/i },
    { re: /^ARGUS-QUADRO-POMPE$/, name: /quadro.*pomp/i, unit: /^pz$/i },
    { re: /^ARGUS-INVERTER$/, name: /inverter/i, unit: /^pz$/i, not: /motore/i },
    { re: /^ARGUS-CABINA-MT$/, name: /cabina/i, unit: /^pz$/i },
    { re: /^ARGUS-GRUPPO-ELETTROGENO$/, name: /gruppo elettrogeno|generatore/i, unit: /^pz$/i },
  ];
  function catRemap(sez: { righe: MRow[] }[]): { on: number; tot: number } | null {
    const cat = olyCat; if (!cat) return null;
    const key = (c: string) => c.replace(/^CERES-/i, "").toUpperCase();
    const codes = Object.keys(cat).sort();
    let on = 0, tot = 0;
    for (const s of sez) for (const r of s.righe) {
      tot++;
      if (cat[key(r.codice)]) { on++; continue; }
      const mp = /^P-PIPE-U-PE-100-PN-10-(\d+)$/.exec(key(r.codice));
      if (mp) {
        const alt = [`P-PIPE-U-PE-100-PN-12-5-${mp[1]}`, `P-PIPE-U-PE-100-PN-16-${mp[1]}`, `P-PIPE-U-PVC-U-PN-10-${mp[1]}`, `P-PIPE-U-PE-100-PN-6-${mp[1]}`].find((c) => cat[c]);
        if (alt) { r.codice = alt; on++; }
        continue;
      }
      const rule = CAT_RULES.find((x) => x.re.test(r.codice));
      if (!rule) continue;
      const hit = codes.find((c) => rule.name.test(cat[c][0]) && (!rule.not || !rule.not.test(cat[c][0])) && (!rule.unit || rule.unit.test(cat[c][1].trim())));
      if (hit) { r.codice = hit; on++; }
    }
    return { on, tot };
  }
  type MRow = { codice: string; quantita: number; unita?: string; descrizione?: string; a_cura_cliente?: boolean; peso_kg?: number };
  const catStat = useRef<{ on: number; tot: number } | null>(null);
  function mercuriusComputo(riferimento: string, revisione: number) {
    const sez: { titolo: string; righe: MRow[] }[] = [];
    const add = (titolo: string, righe: MRow[]) => {
      const ok = righe.filter((r) => r.quantita > 0).map((r) => ({ ...r, quantita: Math.round(r.quantita * 100) / 100 }));
      if (ok.length) sez.push({ titolo: titolo.slice(0, 160), righe: ok });
    };
    const PIPE = ["10", "8-5-8", "6-5-8"], PIPE_TXT = ['10"', '8"5/8', '6"5/8'];
    const BR = pivotBrand.toUpperCase();
    const spanCode = (pi: number, len: number) => pivotBrand === "starpivot"
      ? `SPAN-STARPIVOT-${PIPE[pi]}-${Math.round(len * 10)}-STD` : `ARGUS-SPAN-${BR}-${PIPE[pi]}-${Math.round(len * 10)}`;
    const ohCode = (len: number) => pivotBrand === "starpivot" ? `OVER-STARPIVOT-${Math.round(len * 10)}` : `ARGUS-OVER-${BR}-${Math.round(len * 10)}`;
    const it = (n: number, d = 0) => n.toLocaleString("it-IT", { maximumFractionDigits: d });
    let nSpansTot = 0;
    const pipeRows = (dn: number, m: number, cosa: string): MRow[] => [
      { codice: `P-PIPE-U-PE-100-PN-10-${dn}`, quantita: Math.round(m), unita: "m", descrizione: `Tubo PE100 PN10 DN ${dn} — ${cosa}`, peso_kg: Math.round(pipeKg(dn) * 100) / 100 },
      { codice: `POSA-TRENCH-${dn}`, quantita: Math.round(m), unita: "m" },
    ];
    // Pivot
    const macchine: Record<string, unknown>[] = [];
    if (pivots.length) {
      const R: MRow[] = [];
      const spans = new Map<string, number>(), ohs = new Map<number, number>();
      let noComp = 0;
      pivots.forEach((pv, k) => {
        const c = spanComposition(pv, pivotBrand);
        if (!c) noComp++;
        else { for (const sp of c.spans) { const kk = `${sp.pipe}|${sp.len}`; spans.set(kk, (spans.get(kk) ?? 0) + 1); } if (c.oh) ohs.set(c.oh, (ohs.get(c.oh) ?? 0) + 1); nSpansTot += c.spans.length; }
        if (macchine.length < 50) macchine.push({ nome: `P${k + 1}`, tipo: `${(pv.deg ?? 360) < 360 ? "pivot a settore" : "pivot"}${pv.solar ? " solare" : ""}`, superficie_ha: Math.round(pvAreaM2(pv) / 100) / 100,
          lunghezza_m: Math.round(c ? c.total : pv.r), pluviometria_mm_24h: Math.round(mmDes * 10) / 10,
          portata_ls: Math.round(pivotFlow(pv) * 10) / 10, pressione_bar: Math.round(pivotPressure(pv) * 100) / 100 });
      });
      R.push({ codice: pivotBrand === "starpivot" ? "PIV-POINT-FIX-STD" : `ARGUS-PIV-POINT-${BR}`, quantita: pivots.length, unita: "pz", descrizione: pivotBrand === "starpivot" ? undefined : `Punto pivot fisso ${PIVOT_BRANDS[pivotBrand]}` });
      R.push({ codice: pivotBrand === "starpivot" ? "PANEL-EM" : `ARGUS-PANEL-${BR}`, quantita: pivots.length, unita: "pz", descrizione: pivotBrand === "starpivot" ? undefined : `Quadro elettromeccanico ${PIVOT_BRANDS[pivotBrand]}` });
      [...spans.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([kk, n]) => {
        const [pi, len] = kk.split("|").map(Number);
        R.push({ codice: spanCode(pi, len), quantita: n, unita: "pz", descrizione: pivotBrand === "starpivot" ? undefined : `Campata ${PIVOT_BRANDS[pivotBrand]} ${PIPE_TXT[pi]} da ${it(len, 1)} m`, peso_kg: Math.round(spanKg(pi, len)) });
      });
      [...ohs.entries()].sort((a, b) => a[0] - b[0]).forEach(([len, n]) => R.push({ codice: ohCode(len), quantita: n, unita: "pz", descrizione: pivotBrand === "starpivot" ? undefined : `Sbraccio ${PIVOT_BRANDS[pivotBrand]} da ${it(len, 1)} m`, peso_kg: Math.round(overKg(len)) }));
      if (noComp) R.push({ codice: `ARGUS-PIVOT-${BR}`, quantita: noComp, unita: "pz", descrizione: `Pivot ${PIVOT_BRANDS[pivotBrand]} da comporre (listino non disponibile)` });
      R.push({ codice: "ENDGUN", quantita: pivots.filter((p) => p.gun && p.gun > 0).length, unita: "pz" });
      R.push({ codice: "EOT-ARM", quantita: pivots.filter((p) => (p.deg ?? 360) < 360).length * 2, unita: "pz", descrizione: "Fermo di fine corsa (pivot a settore)" });
      add(`Pivot ${PIVOT_BRANDS[pivotBrand]}`, R);
      const sol = pivots.filter((p) => p.solar);
      if (sol.length) {
        const SZ = sol.map((p) => solarSize(p)), kwp = SZ.reduce((a, z) => a + z.kWp, 0), bk = SZ.reduce((a, z) => a + z.batt, 0);
        add("Pivot solari", [
          { codice: "ARGUS-FV", quantita: kwp, unita: "kWp", descrizione: `Campo fotovoltaico dei pivot solari (${sol.length} pivot, ${SZ.reduce((a, z) => a + z.n, 0)} moduli da ${solarCfg.wp} Wp) con struttura di sostegno` },
          { codice: "ARGUS-INVERTER", quantita: sol.length, unita: "pz", descrizione: "Inverter / regolatore fotovoltaico del pivot" },
          ...(bk > 0 ? [{ codice: "ARGUS-BATTERIE", quantita: bk, unita: "kWh", descrizione: "Batterie dei pivot solari" }] : []),
        ]);
      }
    }
    // Lineari, rotoloni, goccia
    for (const [k, d] of Object.entries(sysDesigns)) {
      const f = fieldOfKey(k); if (!f) continue;
      const R: MRow[] = [];
      if (d.sys === "lineari") {
        const r = calcLin(f, d.p as LinP);
        const spans = new Map<string, number>();
        for (const m of r.machines) {
          const c = spanComposition({ r: m.L, q: m.qLs }, pivotBrand, true);
          for (const sp of c?.spans ?? []) { const kk = `${sp.pipe}|${sp.len}`; spans.set(kk, (spans.get(kk) ?? 0) + 1); nSpansTot++; }
          if (c?.oh) R.push({ codice: ohCode(c.oh), quantita: 1, unita: "pz", peso_kg: Math.round(overKg(c.oh)) });
          R.push(...pipeRows(m.dn, m.travel, `condotta con idranti L${m.i}`));
          if (macchine.length < 50) macchine.push({ nome: `${f.name} L${m.i}`.slice(0, 80), tipo: "lineare", superficie_ha: Math.round((m.L * m.travel) / 100) / 100,
            lunghezza_m: Math.round(m.L), pluviometria_mm_24h: Math.round(mmDes * 10) / 10, portata_ls: Math.round(m.qLs * 10) / 10 });
        }
        R.unshift({ codice: "CART-LINEAR-HOSE-4W-STD", quantita: r.machines.length, unita: "pz" }, { codice: "WSUP-HOSE-4W", quantita: r.machines.length, unita: "pz" });
        [...spans.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([kk, n]) => { const [pi, len] = kk.split("|").map(Number); R.splice(2, 0, { codice: spanCode(pi, len), quantita: n, unita: "pz", peso_kg: Math.round(spanKg(pi, len)) }); });
        add(`Lineari · ${f.name}`, R);
      } else if (d.sys === "rotoloni") {
        const p = d.p as RotP, r = calcRot(f, p);
        R.push({ codice: "ARGUS-ROTOLONE", quantita: r.nMach, unita: "pz", descrizione: `Rotolone con tubo da ${it(p.hoseLen)} m e irrigatore da ${it(p.gunQ)} m³/h` });
        R.push(...pipeRows(r.dn, r.mainLen, "condotta di testata"));
        R.push({ codice: "PT-HYDRANT", quantita: r.hydrants, unita: "pz" });
        add(`Rotoloni · ${f.name}`, R);
      } else {
        const p = d.p as DripP, r = calcDrip(f, p);
        R.push({ codice: "ARGUS-ALA-GOCCIOLANTE", quantita: Math.round(r.latM), unita: "m", descrizione: `Ala gocciolante, gocciolatori ${it(p.emQ, 1)} l/h ogni ${it(p.emSp, 2)} m` });
        R.push(...pipeRows(r.dnSub, r.subLen, "condotte secondarie"));
        R.push({ codice: "ARGUS-FILTRAZIONE", quantita: 1, unita: "pz", descrizione: `Gruppo di filtrazione e testata, ${it(r.qLs)} l/s` });
        R.push({ codice: "ARGUS-VALVOLA-SETTORE", quantita: r.nSec, unita: "pz", descrizione: "Valvola di settore" });
        add(`Goccia · ${f.name}`, R);
      }
    }
    // Rete di adduzione
    {
      const R: MRow[] = [];
      let tot = 0;
      const HY = hydraNow();
      if (HY) for (const [dn, m] of [...HY.byDn].sort((a, b) => a[0] - b[0])) { R.push(...pipeRows(dn, m, "rete di adduzione")); tot += m; }
      const lenOf = (ln: number[][]) => ln.reduce((a, q, i) => { if (!i) return 0; const o = ln[i - 1]; return a + Math.hypot((q[0] - o[0]) * 111320 * Math.cos(((q[1] + o[1]) / 2) * Math.PI / 180), (q[1] - o[1]) * 110540); }, 0);
      // Pezzi speciali: sfiati sui colmi, scarichi negli avvallamenti, tee e riduzioni (PE: da prezzare
      // se il catalogo non li ha), idrovalvola master e diffusore all'attacco di ogni pivot.
      const NF = netFittings(HY);
      if (NF) {
        for (const [dn, n] of [...NF.air.entries()].sort((a, b) => a[0] - b[0])) if (dn) R.push({ codice: `V-AIR-${dn}`, quantita: n, unita: "pz" });
        if (NF.drains) R.push({ codice: "V-DRAIN", quantita: NF.drains, unita: "pz" });
        for (const [dn, n] of [...NF.tees.entries()].sort((a, b) => a[0] - b[0])) R.push({ codice: `ARGUS-TEE-PE-${dn}`, quantita: n, unita: "pz", descrizione: `Tee PE100 a elettrofusione · DN ${dn}` });
        for (const [k, n] of NF.reds) R.push({ codice: `ARGUS-RID-PE-${k}`, quantita: n, unita: "pz", descrizione: `Riduzione PE100 · DN ${k.replace("x", " × ")}` });
      }
      if (pivots.length) {
        const mv = new Map<string, number>(), df = new Map<string, number>();
        for (const pv of pivots) { const r = pivotRiser(pv); mv.set(`MVALVE-${r.mv}`, (mv.get(`MVALVE-${r.mv}`) ?? 0) + 1); const k = `DIFFUSER-${r.mv}-${r.pipe}`; df.set(k, (df.get(k) ?? 0) + 1); }
        const DF_OK = new Set(["100-10", "100-6-5-8", "100-8", "100-8-5-8", "125-10", "125-6-5-8", "125-8", "125-8-5-8", "150-10", "150-8", "150-8-5-8", "200-10", "200-6-5-8", "250-6-5-8", "250-8", "250-8-5-8", "300-10", "300-6-5-8", "300-8", "300-8-5-8"]);
        for (const [c, n] of mv) R.push({ codice: c, quantita: n, unita: "pz" });
        for (const [c, n] of df) R.push(DF_OK.has(c.slice(9)) ? { codice: c, quantita: n, unita: "pz" }
          : { codice: `ARGUS-${c}`, quantita: n, unita: "pz", descrizione: `Diffusore idrovalvola DN${c.split("-")[1]} → tubo della prima campata` });
      }
      if (!tot) {
        tot = pivotLines.filter((l) => l.kind === "pipe").reduce((a, l) => a + lenOf(l.coords), 0);
        R.push({ codice: "ARGUS-TUBAZIONE", quantita: Math.round(tot), unita: "m", descrizione: "Tubazione interrata (diametri da calcolare nella pagina Tubazioni di Argus Total)" });
      }
      if (tot > 0) R.push({ codice: "SCAVO-TRINCEA", quantita: Math.round(tot), unita: "m" });
      for (const k of canalCalcs().filter((x) => !x.c.exist)) {
        const L = k.ew?.len ?? lenOf(k.c.geojson.coordinates), lab = lining(canalLin).label.toLowerCase();
        R.push({ codice: "ARGUS-CANALE", quantita: Math.round(L), unita: "m", descrizione: k.sec
          ? `Canale ${k.idx + 1}: sezione trapezia b ${it(k.sec.b, 2)} m, tirante ${it(k.sec.y, 2)} m, franco ${it(k.sec.fb, 2)} m, scarpe 1:${it(k.sec.m, 1)}, ${lab}, ${it(k.q)} l/s a ${it(k.S, 2)}‰`
          : `Canale ${k.idx + 1}` });
        if (k.ew) {
          R.push({ codice: "ARGUS-CANALE-SCAVO", quantita: Math.round(k.ew.cut), unita: "m³", descrizione: `Scavo del canale ${k.idx + 1}` });
          if (k.ew.fill > 1) R.push({ codice: "ARGUS-CANALE-RILEVATO", quantita: Math.round(k.ew.fill), unita: "m³", descrizione: `Rilevato degli argini del canale ${k.idx + 1}, compattato` });
          if (["concr", "liner", "stone"].includes(canalLin)) R.push({ codice: `ARGUS-CANALE-RIVEST-${canalLin.toUpperCase()}`, quantita: Math.round(k.ew.linedM2), unita: "m²", descrizione: `Rivestimento del canale ${k.idx + 1} in ${lab}` });
        }
      }
      { const FC = fertCalc();
        if (FC) {
          R.push({ codice: "ARGUS-FERT-POMPA", quantita: FC.nPumps, unita: "pz", descrizione: `Pompa dosatrice per fertirrigazione, fino a ${it(Math.max(...FC.rows.map((r) => r.lh)), 1)} l/h, con quadro e attacco alla mandata del pivot` });
          R.push({ codice: "ARGUS-FERT-SERBATOIO", quantita: FC.tank, unita: "l", descrizione: "Serbatoio in PE per il fertilizzante liquido, con bacino di contenimento" });
        }
      }
      for (const d of drainCalcs()) {
        R.push({ codice: "ARGUS-FOSSO-SCOLO", quantita: Math.round(d.L), unita: "m", descrizione: `Fosso di scolo F${d.n} (${d.f.name}), ${it(d.q)} l/s${d.sec ? `, base ${it(d.sec.b, 2)} m, tirante ${it(d.sec.y, 2)} m, scarpe 1:1,5, inerbito` : ""}` });
        R.push({ codice: "ARGUS-FOSSO-SCAVO", quantita: Math.round(d.cut), unita: "m³", descrizione: `Scavo del fosso di scolo F${d.n}` });
      }
      const mRoad = roads.filter((r) => r.kind === "service" && !r.hidden).reduce((a, r) => a + lenOf(r.coords), 0);
      R.push({ codice: "ARGUS-STRADA-SERVIZIO", quantita: Math.round(mRoad), unita: "m", descrizione: "Strada di servizio" });
      add("Rete di adduzione", R);
    }
    // Fonte d'acqua / pompaggio / energia
    const S = srcPt && pivots.length ? sourceSchemes() : null;
    const sc = S ? (S.schemes.find((x) => x.key === (srcShown ?? S.best?.key)) ?? null) : null;
    const P = pumpStation();
    const stations = pumpStationsList();
    const netMaxDn = Math.max(0, ...(hydraNow()?.byDn ?? []).map((x) => x[0]));
    // valvola di non ritorno all'uscita di ogni stazione (a catalogo fino al DN 225)
    const checkRow = (dn: number): MRow => [50, 63, 75, 90, 110, 125, 140, 160, 200, 225].includes(dn)
      ? { codice: `V-CHECK-${dn}`, quantita: 1, unita: "pz" }
      : { codice: `ARGUS-V-CHECK-${dn}`, quantita: 1, unita: "pz", descrizione: `Valvola di non ritorno · DN ${dn}` };
    const famTxt: Record<string, string> = { vert: "verticale sommersa", subm: "elettropompa sommersa", horiz: "ad asse orizzontale" };
    const stationDesc = (st: PStation) => `${st.name}: ` + (st.pick
      ? `${st.nTot > 1 ? st.nTot + " × " : ""}pompa Caprari ${st.pick.model} (${famTxt[st.pick.fam] ?? st.pick.fam}), ${st.pick.diesel ? `motore diesel ${it(st.pick.motor, 1)} kW a ${it(st.pick.rpm)} giri/min` : `motore ${it(st.pick.motor, 1)} kW`}, ${it(st.qLs)} l/s, ${it(st.head)} m`
      : `${it(st.kW, 1)} kW, ${it(st.qLs)} l/s, ${it(st.head)} m`);
    // motopompa: il motore diesel non è nel listino Caprari, resta da prezzare
    const dieselRows = (st: PStation): MRow[] => st.pick?.diesel ? [{ codice: "ARGUS-MOTORE-DIESEL", quantita: st.nTot, unita: "pz",
      descrizione: `Motore diesel ${it(st.pick.motor)} kW a ${it(st.pick.rpm)} giri/min, flangia SAE e volano, quadro motore e serbatoio · ${st.name}` }] : [];
    let scen = powerMode === "solar" ? "fotovoltaico" : "rete elettrica";
    if (S && sc) {
      const R: MRow[] = [];
      stations.forEach((st, i) => { R.push({ codice: "PT-PUMP", quantita: 1, unita: "pz", descrizione: stationDesc(st) }, ...dieselRows(st));
        const dn = i === 0 && sc.key !== "C" && sc.main?.kind === "pipe" && sc.main.dn ? sc.main.dn : netMaxDn; if (dn) R.push(checkRow(dn)); });
      if (sc.main?.kind === "pipe" && sc.main.dn) R.push(...pipeRows(sc.main.dn, sc.main.L * (sc.main.n ?? 1), "adduttrice"));
      if (sc.main?.kind === "canal") R.push({ codice: "ARGUS-CANALE-GRAVITA", quantita: Math.round(sc.main.L), unita: "m", descrizione: `Canale a gravità, scavo massimo ${it(sc.main.cutMax ?? 0, 1)} m${sc.main.sec ? `, sezione trapezia b ${it(sc.main.sec.b, 2)} m, tirante ${it(sc.main.sec.y, 2)} m, franco ${it(sc.main.sec.fb, 2)} m, ${lining(canalLin).label.toLowerCase()}` : ""}` });
      if (sc.res) {
        R.push({ codice: "PT-TANK", quantita: 1, unita: "pz", descrizione: `Vasca di accumulo ${it(sc.res.vol)} m³, profondità utile ${it(resDepth, 1)} m` });
        R.push({ codice: "ARGUS-SCAVO-VASCA", quantita: Math.round(sc.res.vol * (1 + 0.5 / Math.max(1, resDepth))), unita: "m³", descrizione: "Scavo della vasca (volume utile + franco 0,5 m)" });
      }
      if (srcEnergy !== "rete") {
        R.push({ codice: "ARGUS-FV", quantita: Math.round(sc.pvKwp), unita: "kWp", descrizione: "Campo fotovoltaico" });
        R.push({ codice: "ARGUS-BATTERIE", quantita: Math.round(sc.battKwh), unita: "kWh", descrizione: "Accumulo a batterie" });
        scen = srcEnergy === "fv-batt" ? "fotovoltaico con batterie" : "fotovoltaico con generatore";
      } else scen = "rete elettrica / generatore";
      add(`Fonte d'acqua · schema ${sc.key}`, R);
    } else if (P.best && stations.length) {
      add("Stazione di pompaggio", stations.flatMap((st) => [{ codice: "PT-PUMP", quantita: 1, unita: "pz", descrizione: stationDesc(st) } as MRow, ...dieselRows(st), ...(netMaxDn ? [checkRow(netMaxDn)] : [])]));
    }
    if (!sc && powerMode === "solar" && pivots.length) {
      const So = solarSizing();
      if (srcEnergy === "fv-batt") {
        add("Fotovoltaico", [{ codice: "ARGUS-FV", quantita: Math.round(So.bat.kwp), unita: "kWp", descrizione: "Campo fotovoltaico" },
          { codice: "ARGUS-BATTERIE", quantita: Math.round(So.bat.battKwh), unita: "kWh", descrizione: "Accumulo a batterie" }]);
        scen = "fotovoltaico con batterie";
      } else {
        add("Fotovoltaico", [{ codice: "ARGUS-FV", quantita: Math.round(So.no.kwp), unita: "kWp", descrizione: "Campo fotovoltaico senza batterie" }]);
        scen = "fotovoltaico";
      }
    }
    // Linee elettriche: alimentazione delle pompe e dei pivot
    const cabs = cableRuns(stations);
    {
      const byCode = new Map<string, { m: number; mat: string; S: number }>();
      for (const c of cabs) {
        const code = `E-${c.mat === "Cu" ? "CU" : "AL"}-${String(c.S).replace(".", "-")}`;
        const o = byCode.get(code) ?? { m: 0, mat: c.mat, S: c.S }; o.m += c.L; byCode.set(code, o);
      }
      add("Linee elettriche", [...byCode.entries()].map(([codice, o]) => ({ codice, quantita: Math.round(o.m), unita: "m",
        descrizione: `Linea elettrica interrata ${o.mat === "Cu" ? "Cu" : "Al"} 3 × ${it(o.S, 1)} mm²` })));
    }
    // Quadri delle pompe, inverter e consegna dell'energia
    {
      const G = powerGear(stations), R: MRow[] = [];
      for (const pn of G.panels) {
        R.push({ codice: "ARGUS-QUADRO-POMPE", quantita: 1, unita: "pz", descrizione: `Quadro di comando e protezione · ${pn.name} · ${pn.n} × ${it(pn.kWp, 1)} kW` });
        if (pn.inverter) R.push({ codice: "ARGUS-INVERTER", quantita: pn.n, unita: "pz", descrizione: `Inverter per pompa da ${it(pn.kWp, 1)} kW (velocità variabile)` });
      }
      if (G.supply === "mt") R.push({ codice: "ARGUS-CABINA-MT", quantita: 1, unita: "pz", descrizione: `Cabina di trasformazione MT/BT da ${it(G.kva)} kVA (${it(G.kW)} kW installati)` });
      else if (G.supply === "bt") R.push({ codice: "ARGUS-CONSEGNA-BT", quantita: 1, unita: "pz", descrizione: `Punto di consegna in bassa tensione con quadro generale (${it(G.kW)} kW installati)` });
      else if (G.supply === "gen") R.push({ codice: "ARGUS-GRUPPO-ELETTROGENO", quantita: 1, unita: "pz", descrizione: `Gruppo elettrogeno da ${it(G.kva)} kVA per le ore senza sole` });
      add("Quadri ed energia", R);
    }
    if (nSpansTot) add("Trasporto", [{ codice: "TRASP-TRUCK", quantita: Math.max(1, Math.ceil(nSpansTot / 7)), unita: "pz" }]);
    // Scheda tecnica
    const kWinst = sc ? sc.stages.reduce((a, st) => a + (STD_KW.find((k) => k >= st.kW * 1.1) ?? Math.ceil(st.kW)), 0) : P.best?.kWInst ?? 0;
    const mwh = sc ? sc.mwh : P.best ? P.best.kWhYear / 1000 : 0;
    const voci = [
      ["Portata complessiva", `${it(P.qDes)} l/s`], ["Prevalenza", `${it(sc ? Math.max(...sc.stages.map((s2) => s2.head)) : P.head)} m`],
      ["Fabbisogno di progetto", `${it(mmDes, 1)} mm/24h`], ["Potenza installata", `${it(kWinst)} kW`], ["Energia annua", `${it(mwh)} MWh`],
      ...(sc ? [["Schema della fonte", `${sc.key} · ${sc.name}`]] : []),
      ...(sc?.res ? [["Vasca di accumulo", `${it(sc.res.vol)} m³`]] : []),
      ...(hydraNow() ? [["Rete di adduzione", `${it(hydraNow()!.byDn.reduce((a, x) => a + x[1], 0) / 1000, 2)} km`]] : []),
      ...((() => { const us = pivots.map((pv) => pivotCU(pv)).filter((u): u is CuResult => !!u); if (!us.length) return [];
        const lo = Math.min(...us.map((u) => u.CU)), hi = Math.max(...us.map((u) => u.CU));
        return [...(soilSat ? [["Suolo (SoilGrids)", `${soilOf(soilSat.key).label} · ${soilSat.usda} · sabbia ${it(soilSat.sand)}% argilla ${it(soilSat.clay)}% · ${it(soilSat.taw_mm_m)} mm/m`]] : []), ["Uniformità dei pivot (CU)", `${it(lo, 1)}${hi - lo > 0.05 ? `–${it(hi, 1)}` : ""}% · ${us[0].model} · picco ${it(Math.max(...us.map((u) => u.peak)))} mm/h`]]; })()),
      ...(pivots.some((p) => p.solar) ? [["Tara FV non irrigua", `${it(pivots.reduce((a, p) => a + (p.solar ? solarSize(p).taraM2 : 0), 0) / 1e4, 2)} ha · ${pivots.filter((p) => p.solar).length} pivot solari, cerchio attorno al perno`]] : []),
      ["Macchine", `${pivots.length} pivot${Object.keys(sysDesigns).length ? `, ${Object.keys(sysDesigns).length} campi con altri sistemi` : ""}`],
    ].map(([etichetta, valore]) => ({ etichetta: etichetta.slice(0, 80), valore: valore.slice(0, 120) })).slice(0, 40);
    // Planimetria come dati (senza foto): campi, impronte dei pivot, tubazioni
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const feats: any[] = [];
    const usedF = new Set<number>([...pivots.map((p) => p.field).filter((x): x is number => x != null), ...Object.keys(sysDesigns).map((k) => fieldOfKey(k)?.id).filter((x): x is number => x != null)]);
    for (const f of fields) if (usedF.has(f.id)) feats.push({ type: "Feature", properties: { tipo: "campo", nome: f.name }, geometry: { type: "Polygon", coordinates: f.geom.coordinates } });
    pivots.forEach((pv, k) => {
      const deg = pv.deg ?? 360, az = pv.az ?? 0;
      feats.push({ type: "Feature", properties: { tipo: "impianto", impianto: `P${k + 1}`, macchina: "circle", raggio_m: Math.round(pv.r), angolo_gradi: deg,
        ...(deg < 360 ? { settore_gradi: [az % 360, (az + deg) % 360] } : {}) }, geometry: { type: "Point", coordinates: [pv.lng, pv.lat] } });
    });
    // tubazioni: un tratto per diametro (DN e lunghezza sulla tavola)
    const dnLines = new Map((hydraNow()?.lines ?? []).map(([i, d]) => [i, d] as [number, number[]]));
    pivotLines.forEach((l, i) => {
      if (l.kind !== "pipe" || l.coords.length < 2) return;
      const dns = dnLines.get(i);
      if (!dns) { feats.push({ type: "Feature", properties: { tipo: "tubazione", posa: "interrata" }, geometry: { type: "LineString", coordinates: l.coords } }); return; }
      let k0 = 0;
      for (let k = 1; k <= dns.length; k++) if (k === dns.length || dns[k] !== dns[k0]) {
        const co = l.coords.slice(k0, k + 1), L = co.reduce((a, q, j) => a + (j ? distM(co[j - 1], q) : 0), 0);
        feats.push({ type: "Feature", properties: { tipo: "tubazione", posa: "interrata", ...(dns[k0] ? { DN: dns[k0] } : {}), lunghezza_m: Math.round(L) }, geometry: { type: "LineString", coordinates: co } });
        k0 = k;
      }
    });
    if (sc?.main && srcRoute && srcRoute.length >= 2) feats.push({ type: "Feature", properties: { tipo: "tubazione", posa: "interrata", ...(sc.main.dn ? { DN: sc.main.dn } : {}), lunghezza_m: Math.round(sc.main.L) }, geometry: { type: "LineString", coordinates: srcRoute } });
    for (const st of stations) {
      if (!st.pt) continue;
      const pk = st.pick;
      feats.push({ type: "Feature", geometry: { type: "Point", coordinates: st.pt }, properties: {
        tipo: "attrezzatura", sottotipo: "pump", nome: st.name.slice(0, 80), portata_ls: Math.round(st.qLs * 10) / 10, prevalenza_m: Math.round(st.head * 10) / 10,
        famiglia: pk ? pk.fam : st.well ? "vert" : "horiz", motore_kw: Math.round(st.kW * 10) / 10,
        ...(pk ? { pompa_modello: pk.model, pompe_n: st.nTot, pompe_serie: 1, giri_min: pk.rpm, ...(pk.diesel ? { azionamento: "diesel" } : { poli: pk.rpm > 2000 ? 2 : 4 }), motore_pompa_kw: pk.motor,
          rendimento_pct: Math.round(pk.eta), prevalenza_pompa_m: Math.round(pk.H * 10) / 10, portata_pompa_m3h: Math.round(pk.q * 10) / 10,
          potenza_assorbita_kw: Math.round(pk.pAbs * 10) / 10 } : {}),
        ...(st.well ? { livello_m: Math.round(srcRange * 10) / 10, profondita_posa_m: Math.round(srcRange + 5) } : {}) } });
    }
    for (const rd of roads) if (!rd.hidden && rd.coords.length >= 2) feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: rd.coords },
      properties: { tipo: "strada", ...(rd.kind === "service" ? { sottotipo: "servizio" } : {}), ...(rd.width_m ? { larghezza_m: Math.round(rd.width_m * 10) / 10 } : {}), lunghezza_m: Math.round(rd.coords.reduce((a, q, j) => a + (j ? distM(rd.coords[j - 1], q) : 0), 0)) } });
    pivots.forEach((pv, k) => {
      if (!pv.solar) return;
      const z = solarSize(pv), all = solarPolys(pv).flat();
      const la = all.map((q) => q[0]), lo = all.map((q) => q[1]), s0 = Math.min(...la), n0 = Math.max(...la), w0 = Math.min(...lo), e0 = Math.max(...lo);
      feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [[[w0, s0], [e0, s0], [e0, n0], [w0, n0], [w0, s0]]] },
        properties: { tipo: "fotovoltaico", impianto: `P${k + 1}`, kwp: Math.round(z.kWp * 10) / 10, moduli: z.n, modulo_wp: solarCfg.wp, file: z.rows, ...(z.batt ? { batterie_kwh: z.batt } : {}) } });
      const kx = 111320 * Math.cos((pv.lat * Math.PI) / 180), ring: number[][] = [];
      for (let j = 0; j <= 48; j++) { const a = (j / 48) * 2 * Math.PI; ring.push([pv.lng + (z.taraR * Math.sin(a)) / kx, pv.lat + (z.taraR * Math.cos(a)) / 110540]); }
      feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] },
        properties: { tipo: "tara", impianto: `P${k + 1}`, raggio_m: z.taraR, superficie_ha: Math.round(z.taraM2 / 100) / 100, nota: "non irrigua (campo FV)" } });
    });
    for (const c of cabs) if (c.coords) feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: c.coords },
      properties: { tipo: "cavo", conduttori: 3, sezione_mmq: c.S, materiale: c.mat, lunghezza_m: c.L, nome: c.name.slice(0, 80) } });
    const xs: number[] = [], ys: number[] = [];
    const walk = (c: unknown): void => { if (Array.isArray(c) && typeof c[0] === "number") { xs.push(c[0] as number); ys.push(c[1] as number); } else if (Array.isArray(c)) c.forEach(walk); };
    feats.forEach((ft) => walk(ft.geometry.coordinates));
    pivots.forEach((pv) => { const dl = pv.r / 110540, dg = pv.r / (111320 * Math.cos(pv.lat * Math.PI / 180)); xs.push(pv.lng - dg, pv.lng + dg); ys.push(pv.lat - dl, pv.lat + dl); });
    const planimetria = xs.length ? (() => {
      let w = Math.min(...xs), e = Math.max(...xs), s = Math.min(...ys), n = Math.max(...ys);
      const mx = (e - w) * 0.06 || 0.002, my = (n - s) * 0.06 || 0.002; w -= mx; e += mx; s -= my; n += my;
      return { formato: 1, riquadro: { ovest: w, sud: s, est: e, nord: n }, immagine: null, elementi: { type: "FeatureCollection", features: feats } };
    })() : undefined;
    catStat.current = catRemap(sez);
    const cname = clients.find((c) => c.id === clientId)?.name || "";
    const pname = projects.find((x) => x.id === projectId)?.name || "Argus Total";
    return {
      tracciato: "ceres/computo-metrico", versione: 1,
      progetto: { riferimento: riferimento.slice(0, 80), revisione: Math.max(1, Math.min(999, revisione)), nome: pname.slice(0, 200),
        business_unit: "IRRIGAZIONE_MECCANIZZATA", generato_il: new Date().toISOString(), generato_da: `Argus Total ${REV}` },
      ...(cname ? { cliente: { nome: cname.slice(0, 200) } } : {}),
      tecnica: { superficie_ha: Math.round(P.irrHa * 100) / 100, fabbisogno_idrico_m3: Math.round(P.volYear), scenario_energetico: scen.slice(0, 40), macchine, voci },
      sezioni: sez,
      ...(planimetria ? { planimetria } : {}),
    };
  }
  // ---- VARIANTI DEL PROGETTO ---------------------------------------------------
  // Una variante è una fotografia del progetto (pivot e tubazioni, sistemi dei
  // campi, fonte d'acqua, alimentazione) con i suoi numeri e il suo computo,
  // salvata come livello «variant» del progetto. Si confrontano in tabella e si
  // possono ricaricare.
  type VarMetrics = { ha: number; qLs: number; head: number; kWinst: number; kWabs: number; mwh: number; pvKwp: number; battKwh: number;
    resVol: number; netKm: number; mainKm: number; nPivots: number; nSpans: number; nSys: number; scheme: string; energy: string; mm: number; ek?: string; volYear?: number; dieselMwh?: number };
  type Variant = { id: number; name: string; created: string; metrics: VarMetrics; computo: CRow[]; snapshot: Record<string, unknown>; ceres: Record<string, unknown> | null; chosen?: boolean };
  function variantMetrics(): VarMetrics {
    const P = pumpStation();
    const S = srcPt && pivots.length ? sourceSchemes() : null;
    const sc = S ? (S.schemes.find((x) => x.key === (srcShown ?? S.best?.key)) ?? null) : null;
    let nSpans = 0;
    for (const pv of pivots) nSpans += spanComposition(pv, pivotBrand)?.spans.length ?? 0;
    for (const [k, d] of Object.entries(sysDesigns)) { const f = fieldOfKey(k); if (f && d.sys === "lineari") for (const m of calcLin(f, d.p as LinP).machines) nSpans += spanComposition({ r: m.L, q: m.qLs }, pivotBrand, true)?.spans.length ?? 0; }
    let kWinst = 0, kWabs = 0, mwh = 0, head = P.head, pvKwp = 0, battKwh = 0;
    if (sc) {
      for (const st of sc.stages) { kWabs += st.kW; kWinst += STD_KW.find((k) => k >= st.kW * 1.1) ?? Math.ceil(st.kW); }
      mwh = sc.mwh; head = Math.max(...sc.stages.map((st) => st.head));
      if (srcEnergy !== "rete") { pvKwp = sc.pvKwp; battKwh = sc.battKwh; }
    } else if (P.best) {
      kWinst = P.best.kWInst; kWabs = P.best.pAbs; mwh = P.best.kWhYear / 1000;
    }
    if (!sc && powerMode === "solar" && pivots.length) { const So = solarSizing(); if (srcEnergy === "fv-batt") { pvKwp = So.bat.kwp; battKwh = So.bat.battKwh; } else pvKwp = So.no.kwp; }
    // Motopompe diesel: la loro quota di energia va a gasolio (stadi senza pozzo,
    // pesati su potenza × ore); fotovoltaico e batterie restano per il resto.
    let dieselMwh = 0;
    if (pumpDrive === "diesel") {
      const fr = sc ? (() => {
        const w = sc.stages.map((st, i) => st.kW * st.hours * (i === 0 && sc.key !== "C" && srcType === "pozzo" ? 0 : 1));
        const tot = sc.stages.reduce((a, st) => a + st.kW * st.hours, 0);
        return tot > 0 ? w.reduce((a, x) => a + x, 0) / tot : 0;
      })() : P.best ? 1 : 0;
      dieselMwh = mwh * fr; mwh -= dieselMwh; pvKwp *= 1 - fr; battKwh *= 1 - fr;
    }
    return { ha: P.irrHa, qLs: P.qDes, head, kWinst, kWabs, mwh, pvKwp, battKwh, resVol: sc?.res?.vol ?? 0,
      netKm: hydraNow() ? hydraNow()!.byDn.reduce((a, x) => a + x[1], 0) / 1000 : 0, mainKm: sc?.main ? (sc.main.L * (sc.main.n ?? 1)) / 1000 : 0,
      nPivots: pivots.length, nSpans, nSys: Object.keys(sysDesigns).length,
      scheme: sc ? `${sc.key} · ${sc.name}` : "—",
      energy: sc ? (srcEnergy === "rete" ? tx("Rete / generatore") : srcEnergy === "fv-gen" ? tx("FV + generatore") : tx("FV + batterie")) : (powerMode === "solar" ? (srcEnergy === "fv-batt" ? tx("FV + batterie") : srcEnergy === "fv-gen" ? tx("FV + generatore") : tx("Fotovoltaico")) : tx("Rete / generatore"))
        + (pumpDrive === "diesel" ? ` · ${tx("motopompe diesel")}` : ""),
      mm: mmDes, ek: powerMode === "solar" || sc ? srcEnergy : "rete", volYear: P.volYear, dieselMwh };
  }
  function variantSnapshot(): Record<string, unknown> {
    const centroid = (f: Field) => { const r = f.geom.coordinates[0]; return [r.reduce((a, q) => a + q[0], 0) / r.length, r.reduce((a, q) => a + q[1], 0) / r.length]; };
    return {
      pivots: pivots.map((p) => ({ ...p, field: undefined, unconn: undefined, label: undefined, phaseColor: undefined })),
      lines: pivotLines.map((l) => ({ ...l, field: undefined })),
      systems: Object.entries(sysDesigns).map(([k, d]) => { const f = fieldOfKey(k); return { d, name: f?.name ?? "", c: f ? centroid(f) : null }; }),
      fonte: fonteState(), crops: { base: farmCrops, fields: fieldCrops }, powerMode, pivotBrand, spanVmax, mm24, hoursDay, sprinkBar, pivotPointBar, hydra: hydraNow(),
    };
  }
  async function saveVariant(nameOverride?: string) {
    if (!projectId) { setMsg(t("Seleziona un progetto prima di creare il link.")); return; }
    const name = nameOverride || variantName.trim() || t("Variante {n}", { n: variants.length + 1 });
    ensureHydra(); await ensureProfile();
    setBusy("variant");
    try {
      // il .ceres della variante: riferimento proprio (ogni variante è un'offerta a sé), revisione 1
      const cf = ceresFile(`ARGUS-${projectId}-V${Date.now().toString(36).toUpperCase()}`, 1);
      const ceres = "err" in cf ? null : { ...cf.file, name: `${cf.name} · ${name}`, progetto: { ...(cf.file.progetto as object), nome: `${cf.name} · ${name}`.slice(0, 200) } };
      const data = { metrics: variantMetrics(), computo: computoRows(), snapshot: variantSnapshot(), created: new Date().toISOString(), ceres };
      const l = await api.createLayer({ project_id: projectId, kind: "variant", name, data });
      setVariants((vs) => [...vs, { id: l.id, name, created: data.created, metrics: data.metrics, computo: data.computo, snapshot: data.snapshot, ceres }]);
      setVariantName("");
      setMsg(t("Variante «{n}» salvata ✓", { n: name }));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  const variantData = (v: Variant, chosen: boolean) => ({ metrics: v.metrics, computo: v.computo, snapshot: v.snapshot, created: v.created, ceres: v.ceres, chosen });
  async function renameVariant(v: Variant) {
    const n = (prompt(t("Nuovo nome della variante"), v.name) ?? "").trim();
    if (!n || n === v.name) return;
    try { await api.updateLayer(v.id, { name: n }); setVariants((vs) => vs.map((x) => (x.id === v.id ? { ...x, name: n } : x))); } catch (e) { showErr(e); }
  }
  // Una sola variante «scelta»: quella che si propone al cliente (★ in tabella, Excel e PDF)
  async function chooseVariant(v: Variant) {
    const on = !v.chosen;
    try {
      for (const x of variants) {
        const want = on && x.id === v.id;
        if (!!x.chosen !== want) await api.updateLayer(x.id, { data: variantData(x, want) });
      }
      setVariants((vs) => vs.map((x) => ({ ...x, chosen: on && x.id === v.id })));
    } catch (e) { showErr(e); }
  }
  async function deleteVariant(v: Variant) {
    if (!confirm(t("Eliminare la variante «{n}»?", { n: v.name }))) return;
    try { await api.deleteLayer(v.id); setVariants((vs) => vs.filter((x) => x.id !== v.id)); } catch (e) { showErr(e); }
  }
  function loadVariant(v: Variant) {
    if (!confirm(t("Caricare la variante «{n}»? Il progetto sulla mappa viene sostituito: salva prima una variante dello stato attuale se ti serve.", { n: v.name }))) return;
    const sn = v.snapshot as { pivots?: PivotItem[]; lines?: PipeLine[]; systems?: { d: SysDesign; name: string; c: number[] | null }[];
      fonte?: Record<string, unknown>; crops?: { base?: unknown; fields?: Record<string, unknown> }; powerMode?: "grid" | "solar"; pivotBrand?: PivotBrand; spanVmax?: number; mm24?: number; hoursDay?: number;
      sprinkBar?: number; pivotPointBar?: number; hydra?: typeof hydra };
    const inRing = (lng: number, lat: number, ring: number[][]) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    const fieldAt = (lng: number, lat: number) => fields.filter((f) => inRing(lng, lat, f.geom.coordinates[0]))
      .sort((a, b) => ringAreaHa(a.geom.coordinates) - ringAreaHa(b.geom.coordinates))[0]?.id;
    const pv = (sn.pivots ?? []).map((p) => ({ ...p, field: fieldAt(p.lng, p.lat) }));
    const ln = (sn.lines ?? []).map((l) => ({ ...l, field: l.coords?.[0] ? fieldAt(l.coords[0][0], l.coords[0][1]) : undefined }));
    commitPivots(pv); setPivotLines(ln);
    const sys: Record<string, SysDesign> = {};
    for (const s2 of sn.systems ?? []) {
      const f = (s2.c ? fields.find((x) => x.id === fieldAt(s2.c![0], s2.c![1])) : undefined) ?? fields.find((x) => x.name === s2.name);
      if (f) sys[sysKey(f)] = s2.d;
    }
    setSysDesigns(sys);
    if (sn.fonte) applyFonte(sn.fonte);
    if (sn.crops) applyCrops(sn.crops);
    if (sn.powerMode) setPowerMode(sn.powerMode);
    if (sn.pivotBrand) setPivotBrand(sn.pivotBrand);
    if (sn.spanVmax) setSpanVmax(sn.spanVmax);
    if (sn.mm24) setMm24(sn.mm24);
    if (sn.hoursDay) setHoursDay(sn.hoursDay);
    if (sn.sprinkBar) setSprinkBar(sn.sprinkBar);
    if (sn.pivotPointBar != null) setPivotPointBar(sn.pivotPointBar);
    setHydra(sn.hydra ?? null);
    setMsg(t("Variante «{n}» caricata ✓", { n: v.name }));
  }
  // Righe del confronto: [etichetta, valore (numero o testo), decimali, verso]; 0 → «—» dove l'opera manca.
  // verso: 1 = più è meglio, -1 = meno è meglio, 0 = neutro (colore della differenza).
  function variantRows(): [string, (m: VarMetrics) => number | string, number, number][] {
    const opt = (x: number) => (x ? x : "—");
    return [
      [tx("Superficie irrigata") + " (ha)", (m) => m.ha, 1, 1],
      [tx("Pivot"), (m) => m.nPivots, 0, 0],
      [tx("Campi con lineari, rotoloni o goccia"), (m) => m.nSys, 0, 0],
      [tx("Campate"), (m) => m.nSpans, 0, 0],
      [tx("Portata totale") + " (l/s)", (m) => m.qLs, 0, 0],
      [tx("Prevalenza") + " (m)", (m) => m.head, 0, -1],
      [tx("Schema della fonte"), (m) => m.scheme, 0, 0],
      [tx("Alimentazione"), (m) => m.energy, 0, 0],
      [tx("Potenza installata") + " (kW)", (m) => m.kWinst, 0, -1],
      [tx("Potenza assorbita") + " (kW)", (m) => m.kWabs, 0, -1],
      [tx("Energia") + " (MWh/" + tx("anno") + ")", (m) => m.mwh + (m.dieselMwh || 0), 0, -1],
      [tx("Gasolio delle motopompe") + " (l/" + tx("anno") + ")", (m) => (m.dieselMwh ? m.dieselMwh * 1000 * dieselLkWh : "—"), 0, -1],
      [tx("Costo dell'energia") + " (€/" + tx("anno") + ")", (m) => Math.round(energyCost(m)), 0, -1],
      [tx("Manutenzione e ricambi") + " (€/" + tx("anno") + ")", (m) => Math.round(maintCost(m)), 0, -1],
      [tx("Costo di esercizio") + " (€/" + tx("anno") + ")", (m) => Math.round(opexCost(m)), 0, -1],
      [tx("Energia per ettaro") + " (kWh/ha)", (m) => (m.ha > 0 ? ((m.mwh + (m.dieselMwh || 0)) * 1000) / m.ha : "—"), 0, -1],
      [tx("Costo di esercizio per ettaro") + " (€/ha)", (m) => (m.ha > 0 ? opexCost(m) / m.ha : "—"), 0, -1],
      [tx("Energia per m³ pompato") + " (kWh/m³)", (m) => (m.volYear && m.volYear > 0 ? ((m.mwh + (m.dieselMwh || 0)) * 1000) / m.volYear : "—"), 3, -1],
      [tx("Fotovoltaico") + " (kWp)", (m) => opt(m.pvKwp), 0, 0],
      [tx("Batterie") + " (kWh)", (m) => opt(m.battKwh), 0, 0],
      [tx("Vasca di accumulo") + " (m³)", (m) => opt(m.resVol), 0, 0],
      [tx("Adduttrice") + " (km)", (m) => opt(m.mainKm), 1, -1],
      [tx("Rete di adduzione") + " (km)", (m) => opt(m.netKm), 1, -1],
    ];
  }
  // Costo dell'energia in esercizio: rete a €/kWh; FV + generatore: la quota
  // impostata va a gasolio (l/kWh × €/l); FV + batterie: nessun acquisto di energia.
  function energyCost(m: VarMetrics): number {
    const kWh = (m.mwh || 0) * 1000, ek = m.ek ?? "rete";
    const el = ek === "fv-batt" ? 0 : ek === "fv-gen" ? kWh * (genShare / 100) * dieselLkWh * costDiesel : kWh * costKwh;
    return el + (m.dieselMwh || 0) * 1000 * dieselLkWh * costDiesel;    // motopompe: gasolio sull'energia all'albero
  }
  // Manutenzione e ricambi all'anno: pompe e quadri (€/kW installato), FV (€/kWp),
  // batterie da sostituire a fine vita (€/kWh ÷ anni). Niente prezzi degli impianti.
  const maintCost = (m: VarMetrics) => (m.kWinst || 0) * costMaintKw + (m.pvKwp || 0) * costPvOm + (battLife > 0 ? ((m.battKwh || 0) * costBattKwh) / battLife : 0);
  const opexCost = (m: VarMetrics) => energyCost(m) + maintCost(m);
  // Differenza di una variante rispetto allo stato attuale: testo e segno (1 meglio, -1 peggio)
  function variantDiff(v: number | string, ref: number | string, d: number, dir: number): { txt: string; s: number } | null {
    const a = typeof v === "number" ? v : 0, b = typeof ref === "number" ? ref : 0;
    if (typeof v === "string" && typeof ref === "string") return null;
    const dd = Math.round((a - b) * 10 ** d) / 10 ** d;
    if (!dd) return null;
    return { txt: (dd > 0 ? "+" : "−") + fx(Math.abs(dd), { maximumFractionDigits: d }), s: dir ? Math.sign(dd) * dir : 0 };
  }
  // Varianti preparate da Argus: le tre alimentazioni sul progetto attuale e,
  // con la fonte d'acqua, gli altri schemi possibili (con o senza vasca).
  const latest = useRef<{ saveVariant: (n?: string) => Promise<void> } | null>(null);
  latest.current = { saveVariant };
  async function generateVariants() {
    if (!projectId || (!pivots.length && !Object.keys(sysDesigns).length)) return;
    ensureHydra(); await ensureProfile();
    const orig = { e: srcEnergy, pm: powerMode, sh: srcShown };
    const S = srcPt && pivots.length ? sourceSchemes() : null;
    const opts: { name: string; e: "rete" | "fv-gen" | "fv-batt"; sh?: string | null }[] = [
      { name: tx("Rete / generatore"), e: "rete" }, { name: tx("FV + generatore"), e: "fv-gen" }, { name: tx("FV + batterie"), e: "fv-batt" }];
    if (S) for (const sc of S.schemes.filter((x) => x.ok)) if (sc.key !== (srcShown ?? S.best?.key)) opts.push({ name: `${tx("schema")} ${sc.key} · ${sc.name}`, e: orig.e, sh: sc.key });
    setBusy("vgen");
    try {
      // rigenerare sostituisce le varianti con lo stesso nome invece di duplicarle
      const names = new Set(opts.map((o) => o.name));
      const old = variants.filter((v) => names.has(v.name));
      for (const v of old) await api.deleteLayer(v.id);
      if (old.length) setVariants((vs) => vs.filter((v) => !old.some((o) => o.id === v.id)));
      for (const o of opts) {
        setEnergy(o.e); if (o.sh !== undefined) setSrcShown(o.sh);
        await new Promise((r) => setTimeout(r, 150));
        await latest.current!.saveVariant(o.name);
      }
      setMsg(t("Create {n} varianti ✓", { n: opts.length }));
    } finally { setSrcEnergy(orig.e); setPowerMode(orig.pm); setSrcShown(orig.sh); setBusy(""); }
  }
  async function downloadVariantsPdf() {
    const pname = projects.find((x) => x.id === projectId)?.name || "";
    const cname = clients.find((c) => c.id === clientId)?.name || "";
    setBusy("vpdf");
    try {
      const body = inLang(pdfLang, () => {
        // nel PDF stanno lo stato attuale e le ultime 11 varianti
        const cols = [{ name: tx("Attuale"), m: variantMetrics(), c: computoRows() }, ...variants.slice(-11).map((v) => ({ name: (v.chosen ? "★ " : "") + v.name, m: v.metrics, c: v.computo }))];
        const rows = variantRows().map(([label, fn, d, dir]) => ({ label, cells: cols.map((c, k) => {
          const v = fn(c.m); const df = k ? variantDiff(v, fn(cols[0].m), d, dir) : null;
          return { v: typeof v === "number" ? fx(v, { maximumFractionDigits: d }) : v, ...(df ? { d: df.txt, s: df.s } : {}) };
        }) }));
        const keys: string[] = []; const cat = new Map<string, string>(); const lab = new Map<string, string>();
        for (const c of cols) for (const r of c.c) { const k = `${r.cat}|${r.item}|${r.unit}`; if (!lab.has(k)) { keys.push(k); lab.set(k, `${r.item}${r.unit ? ` (${r.unit})` : ""}`); cat.set(k, r.cat); } }
        const qty: { label: string; head?: boolean; values?: string[] }[] = [];
        let last = "";
        for (const k of keys) {
          if (cat.get(k) !== last) { last = cat.get(k)!; qty.push({ label: last, head: true }); }
          qty.push({ label: lab.get(k)!, values: cols.map((c) => { const r = c.c.find((x) => `${x.cat}|${x.item}|${x.unit}` === k); return r ? (r.qty != null ? fx(r.qty) : r.note ?? "") : "—"; }) });
        }
        return { title: tx("Confronto tra varianti"), subtitle: [cname, pname].filter(Boolean).join(" · "), date: new Date().toISOString().slice(0, 10),
          note: tx("Le differenze sotto ogni valore sono rispetto allo stato attuale del progetto: in verde quelle favorevoli, in rosso quelle sfavorevoli. Quantità senza prezzi."),
          columns: cols.map((c) => c.name), rows, qty_title: tx("Computo metrico"), qty_rows: qty.slice(0, 600), lang: pdfLang };
      });
      saveBlob(await api.variantsPdf(body), `${safe(pname || "progetto")}_varianti.pdf`);
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  async function downloadVariantCeres(v: Variant) {
    if (!v.ceres) return;
    setBusy("ceres");
    try { saveBlob(new Blob([JSON.stringify(await withPhoto(v.ceres))], { type: "application/json" }), `${safe(v.name)}.ceres`); } finally { setBusy(""); }
  }
  async function downloadVariants() {
    const cols = [{ name: t("Attuale"), m: variantMetrics(), c: computoRows() }, ...variants.map((v) => ({ name: (v.chosen ? "★ " : "") + v.name, m: v.metrics, c: v.computo }))];
    const sheet: (string | number | null)[][] = [[t("Confronto tra varianti")], [projects.find((x) => x.id === projectId)?.name ?? ""], []];
    const bold = [0, 3];
    sheet.push(["", ...cols.map((c) => c.name)]);
    const rnd = (v: number | string, d: number) => (typeof v === "number" ? Math.round(v * 10 ** d) / 10 ** d : v);
    for (const [lab, fn, d] of variantRows()) sheet.push([lab, ...cols.map((c) => rnd(fn(c.m), d))]);
    // differenze rispetto allo stato attuale
    if (cols.length > 1) {
      sheet.push([]); bold.push(sheet.length); sheet.push([t("Differenza rispetto allo stato attuale"), "", ...cols.slice(1).map((c) => c.name)]);
      for (const [lab, fn, d] of variantRows()) {
        const r0 = fn(cols[0].m); if (typeof r0 !== "number" && r0 !== "—") continue;
        sheet.push([lab, "", ...cols.slice(1).map((c) => { const v = fn(c.m); const a = typeof v === "number" ? v : 0, b = typeof r0 === "number" ? r0 : 0; return Math.round((a - b) * 10 ** d) / 10 ** d; })]);
      }
    }
    sheet.push([]);
    // quantità: tutte le voci del computo, una colonna per variante
    bold.push(sheet.length); sheet.push([t("Computo metrico"), ...cols.map((c) => c.name)]);
    const keys: string[] = []; const label = new Map<string, string>();
    for (const c of cols) for (const r of c.c) { const k = `${r.cat}|${r.item}|${r.unit}`; if (!label.has(k)) { keys.push(k); label.set(k, `${r.cat} · ${r.item} (${r.unit})`); } }
    for (const k of keys) sheet.push([label.get(k)!, ...cols.map((c) => { const r = c.c.find((x) => `${x.cat}|${x.item}|${x.unit}` === k); return r?.qty ?? (r ? r.note ?? "" : ""); })]);
    const blob = await buildXlsx(t("Confronto tra varianti"), sheet, { boldRows: bold, widths: [60, ...cols.map(() => 22)] });
    saveBlob(blob, `${safe(projects.find((x) => x.id === projectId)?.name || "progetto")}_varianti.xlsx`);
  }
  function renderVariants() {
    if (!variantsOpen) return (
      <div className="mt-3"><button className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide w-full text-left" onClick={() => setVariantsOpen(true)}>
        ▸ {t("Varianti del progetto")}{variants.length ? ` (${variants.length})` : ""}</button></div>);
    const cur = variantMetrics();
    const cols = [{ id: 0, name: t("Attuale"), m: cur }, ...variants.map((v) => ({ id: v.id, name: v.name, m: v.metrics, v }))];
    return (
      <div className="mt-3 bg-panel rounded-lg p-2 space-y-1.5">
        <div className="flex items-center gap-2">
          <button className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide flex-1 text-left" onClick={() => setVariantsOpen(false)}>▾ {t("Varianti del progetto")}</button>
          {variants.length > 0 && <button className="text-[11px] text-brand hover:underline" onClick={downloadVariants}>{t("Scarica Excel")}</button>}
          {variants.length > 0 && <button className="text-[11px] text-brand hover:underline" disabled={busy === "vpdf"} onClick={downloadVariantsPdf}>{busy === "vpdf" ? t("Preparo…") : t("Scarica PDF")}</button>}
        </div>
        {renderEnergyPick()}
        <div className="flex gap-2">
          <input className="field-input py-1 text-sm flex-1" value={variantName} placeholder={t("es. Pivot + FV, Lineari + vasca")} onChange={(e) => setVariantName(e.target.value)} />
          <button className="btn-ghost text-[12px]" disabled={!projectId || busy === "variant" || busy === "vgen"} onClick={() => saveVariant()}>{t("Salva variante")}</button>
        </div>
        <button className="btn-ghost w-full text-[12px]" disabled={!projectId || busy === "vgen" || (!pivots.length && !Object.keys(sysDesigns).length)} onClick={generateVariants}
          title={t("Salva una variante per ogni alimentazione (rete, FV + generatore, FV + batterie) e, con la fonte d'acqua, per ogni altro schema possibile.")}>
          {busy === "vgen" ? t("Preparo…") : t("Genera le varianti di alimentazione e di schema")}</button>
        <div className="grid grid-cols-4 gap-1.5">
          {([[t("Rete (€/kWh)"), costKwh, setCostKwh, 0.01], [t("Gasolio (€/l)"), costDiesel, setCostDiesel, 0.05], [t("Gasolio (l/kWh)"), dieselLkWh, setDieselLkWh, 0.01], [t("Quota generatore (%)"), genShare, setGenShare, 5],
            [t("Manutenzione (€/kW·anno)"), costMaintKw, setCostMaintKw, 1], [t("FV (€/kWp·anno)"), costPvOm, setCostPvOm, 1], [t("Batterie (€/kWh)"), costBattKwh, setCostBattKwh, 10], [t("Vita batterie (anni)"), battLife, setBattLife, 1]] as [string, number, (x: number) => void, number][]).map(([lab, v, set, st]) => (
            <label key={lab} className="text-[10px] text-sage-dark leading-tight">{lab}
              <input type="number" min={0} step={st} value={v} onChange={(e) => { const x = Number(e.target.value); if (Number.isFinite(x) && x >= 0) set(x); }} className="field-input mt-0.5 py-0.5 text-xs" /></label>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="text-[11px] w-full">
            <thead><tr><th />{cols.map((c) => (
              <th key={c.id} className="text-right px-1 align-bottom">
                <div className="text-brand-darker font-semibold">{"v" in c && c.v?.chosen ? "★ " : ""}{c.name}</div>
                {"v" in c && c.v && <div className="font-normal whitespace-nowrap">
                  <button className="text-brand-mid" title={t("Carica")} onClick={() => loadVariant(c.v!)}>↺</button>{" "}
                  <button className={c.v.chosen ? "text-amber" : "text-sage-dark"} title={t("Variante scelta")} onClick={() => chooseVariant(c.v!)}>★</button>{" "}
                  <button className="text-brand-mid" title={t("Rinomina")} onClick={() => renameVariant(c.v!)}>✎</button>{" "}
                  {c.v.ceres && <button className="text-brand-mid" title={t("Scarica .ceres (Ceres e Mercurius)")} onClick={() => downloadVariantCeres(c.v!)}>⬇</button>}{" "}
                  <button className="text-danger" title={t("Elimina")} onClick={() => deleteVariant(c.v!)}>✕</button></div>}
              </th>))}</tr></thead>
            <tbody>
              {variantRows().map(([lab, fn, d, dir]) => (
                <tr key={lab} className="border-t border-black/5">
                  <td className="text-sage-dark pr-1">{lab}</td>
                  {cols.map((c, k) => {
                    const v = fn(c.m); const df = k ? variantDiff(v, fn(cur), d, dir) : null;
                    return <td key={c.id} className="text-right tabular-nums px-1 text-brand-darker align-top">{typeof v === "number" ? fmt(v, { maximumFractionDigits: d, minimumFractionDigits: 0 }) : v}
                      {df && <div className={`text-[9px] leading-none ${df.s > 0 ? "text-brand" : df.s < 0 ? "text-danger" : "text-sage-dark"}`}>{df.txt}</div>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-sage-dark leading-snug">{t("Ogni variante salva pivot, tubazioni, sistemi dei campi, fonte d'acqua e alimentazione con i suoi numeri e il suo computo. ↺ la ricarica sulla mappa. Sotto ogni valore la differenza rispetto allo stato attuale (verde favorevole, rosso sfavorevole). Excel e PDF mettono a confronto anche tutte le quantità.")}</p>
      </div>
    );
  }
  // ---- DXF della planimetria (UTM, un layer per tipo di oggetto) ----------------
  function buildDxf(): { text: string; zone: number; n: number } | null {
    const allPts: number[][] = [...fields.flatMap((f) => f.geom.coordinates[0]), ...pivots.map((p) => [p.lng, p.lat])];
    if (!allPts.length) return null;
    const zone = utmZone(allPts.reduce((a, p) => a + p[0], 0) / allPts.length);
    const U = (q: number[]) => toUtm(q[1], q[0], zone);            // [lng, lat] → [E, N]
    const D = new Dxf([{ name: "CAMPI", color: 3 }, { name: "PIVOT", color: 2 }, { name: "PIVOT_TESTI", color: 7 }, { name: "IRRIGATORE_FINALE", color: 8 },
      { name: "TUBAZIONI", color: 5 }, { name: "TUBAZIONI_TESTI", color: 5 }, { name: "ADDUTTRICE", color: 150 }, { name: "CAVI", color: 1 }, { name: "CANALI", color: 4 },
      { name: "FOSSI_SCOLO", color: 34 }, { name: "STRADE", color: 9 }, { name: "STAZIONI", color: 6 }, { name: "FV_MODULI", color: 5 }, { name: "FV_TARA", color: 30 }]);
    for (const f of fields) { D.poly("CAMPI", f.geom.coordinates[0].map(U), true); const r = f.geom.coordinates[0]; D.text("CAMPI", U([r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length]), 12, f.name); }
    pivots.forEach((pv, k) => {
      const c = U([pv.lng, pv.lat]), deg = Math.max(1, Math.min(360, pv.deg ?? 360)), az = pv.az ?? 0;
      if (deg >= 359.5) D.circle("PIVOT", c, pv.r);
      else {
        D.arc("PIVOT", c, pv.r, 90 - (az + deg), 90 - az);
        for (const b of [az, az + deg]) { const t2 = ((90 - b) * Math.PI) / 180; D.poly("PIVOT", [c, [c[0] + pv.r * Math.cos(t2), c[1] + pv.r * Math.sin(t2)]]); }
      }
      if (pv.gun && pv.gun > 0) { if (deg >= 359.5) D.circle("IRRIGATORE_FINALE", c, pv.r + pv.gun); else D.arc("IRRIGATORE_FINALE", c, pv.r + pv.gun, 90 - (az + deg), 90 - az); }
      D.circle("PIVOT", c, 2);
      D.text("PIVOT_TESTI", [c[0] + 6, c[1] + 6], 8, `P${k + 1} R${Math.round(pv.r)} ${fmt(Math.round(pivotFlow(pv)))} l/s`);
      if (pv.solar) { for (const ring of solarPolys(pv)) D.poly("FV_MODULI", ring.map((q) => U([q[1], q[0]])), true); D.circle("FV_TARA", c, solarSize(pv).taraR); }
    });
    const dnLines = new Map((hydraNow()?.lines ?? []).map(([i, d]) => [i, d] as [number, number[]]));
    pivotLines.forEach((l, i) => {
      if (l.kind !== "pipe" || l.coords.length < 2) return;
      const pts = l.coords.map(U); D.poly("TUBAZIONI", pts);
      const dns = dnLines.get(i); if (dns?.length) dns.forEach((dn, k) => { if (!dn || !pts[k + 1]) return; D.text("TUBAZIONI_TESTI", [(pts[k][0] + pts[k + 1][0]) / 2, (pts[k][1] + pts[k + 1][1]) / 2], 5, `DN${dn}`); });
    });
    if (srcRoute && srcRoute.length >= 2) D.poly("ADDUTTRICE", srcRoute.map(U));
    try { const st = pumpStationsList(); for (const c of cableRuns(st)) if (c.coords && c.coords.length >= 2) D.poly("CAVI", c.coords.map(U));
      for (const s2 of st) if (s2.pt) { const p = U(s2.pt); D.circle("STAZIONI", p, 4); D.text("STAZIONI", [p[0] + 6, p[1] - 6], 6, s2.name); } } catch { /* senza stazioni */ }
    for (const c of canals.filter((x) => !x.hidden)) D.poly("CANALI", c.geojson.coordinates.map(U));
    for (const d of drainCalcs()) D.poly("FOSSI_SCOLO", d.ring.map(U), true);
    for (const r of roads.filter((x) => !x.hidden)) D.poly("STRADE", r.coords.map(U));
    return { text: D.toString(), zone, n: D.ents.length };
  }
  function downloadDxf() {
    const r = buildDxf(); if (!r) { setMsg(t("Niente da esportare: disegna prima campi o pivot.")); return; }
    const pname = projects.find((x) => x.id === projectId)?.name || "argus";
    saveBlob(new Blob([r.text], { type: "application/dxf" }), `${safe(pname)}_planimetria_UTM${r.zone}.dxf`);
    setMsg(t("DXF esportato: {n} oggetti, coordinate UTM fuso {z} (metri).", { n: fmt(r.n), z: r.zone }));
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
  function applyCrops(cr?: { base?: unknown; fields?: Record<string, unknown> }) {
    const b = cropList(cr?.base);
    if (b.length) setFarmCrops(b);
    const fc: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(cr?.fields && typeof cr.fields === "object" ? cr.fields : {})) { const l = cropList(v); if (l.length) fc[k] = l; }
    setFieldCrops(fc);
  }
  function applyFonte(fo: Record<string, unknown>) {
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    const ty = (["fiume", "canale", "pozzo", "invaso"].includes(fo.type as string) ? fo.type : "fiume") as SrcType;
    setSrcPt(Array.isArray(fo.pt) ? (fo.pt as number[]) : null);
    setSrcRoute(Array.isArray(fo.route) ? (fo.route as number[][]) : null);
    setSrcType(ty); setSrcQmax(num(fo.qmax, 0)); setSrcHours(num(fo.hours, 24)); setSrcRange(num(fo.range, SRC_RANGE_DEF[ty]));
    setSrcSediment(typeof fo.sed === "boolean" ? fo.sed : ty === "fiume");
    setSrcEnergy((["rete", "fv-gen", "fv-batt"].includes(fo.energy as string) ? fo.energy : "rete") as "rete" | "fv-gen" | "fv-batt");
    setPumpDrive(fo.drive === "diesel" ? "diesel" : "el");
    setSrcMonthly(Array.isArray(fo.monthly) && (fo.monthly as unknown[]).length === 12 ? (fo.monthly as number[]) : null);
    setSrcSectors(num(fo.sectors, 0)); setResDepth(num(fo.resDepth, 4)); setResDays(num(fo.resDays, 3)); setResEvapK(num(fo.resEvapK, 1.1));
    setWtwEta(num(fo.eta, 75)); setCanalSlope(num(fo.canalSlope, 0.3)); setBankSlope(num(fo.bankSlope, 2));
    { const rv = fo.river as RiverSt | null | undefined; setRiver(rv && rv.data && Array.isArray(rv.data.glofas?.cells) ? { data: rv.data, pick: num(rv.pick, -1), dmv: num(rv.dmv, 10), c: num(rv.c, 0.2), meas: rv.meas && Array.isArray(rv.meas.mean) ? rv.meas : null } : null); }
    setSettleMm(num(fo.settleMm, 0.1)); setFilterCap(num(fo.filterCap, 400)); setWellQ(num(fo.wellQ, 30));
    setSrcShown(typeof fo.shown === "string" ? fo.shown : null); setSrcElev(null); setCableM(num(fo.cableM, 50));
    const co = (fo.costs ?? {}) as Record<string, unknown>;
    setCostKwh(num(co.kwh, 0.22)); setCostDiesel(num(co.diesel, 1.6)); setDieselLkWh(num(co.lkwh, 0.3)); setGenShare(num(co.gen, 40));
    setCostMaintKw(num(co.mkw, 15)); setCostPvOm(num(co.pvom, 12)); setCostBattKwh(num(co.batt, 300)); setBattLife(num(co.blife, 10));
  }
  // ---- Impostazioni di progetto salvate sul server ---------------------------
  // Produttore dei pivot e fonte d'acqua (presa, tracciato, livelli, parametri)
  // viaggiano con il progetto: si ritrovano su qualunque computer.
  const projLoaded = useRef<number | null>(null);
  const projSaved = useRef<string>("");
  const fonteState = () => ({ pt: srcPt, route: srcRoute, type: srcType, qmax: srcQmax, hours: srcHours, range: srcRange,
    sed: srcSediment, energy: srcEnergy, drive: pumpDrive, monthly: srcMonthly, sectors: srcSectors, resDepth, resDays, resEvapK, eta: wtwEta,
    canalSlope, bankSlope, settleMm, filterCap, wellQ, shown: srcShown, cableM, river: river ? { ...river, data: { ...river.data, basin: river.data.basin ? { ...river.data.basin, ring: (river.data.basin.ring ?? []).filter((_, i) => i % 2 === 0) } : undefined } } : null, costs: { kwh: costKwh, diesel: costDiesel, lkwh: dieselLkWh, gen: genShare, mkw: costMaintKw, pvom: costPvOm, batt: costBattKwh, blife: battLife } });
  // ---- Cronologia Annulla/Ripristina UNIFICATA ----
  // Uno snapshot copre tutte le mosse del progetto: campi, pivot e tubazioni, strade,
  // canali, corsi d'acqua, altri sistemi, fonte d'acqua e colture. Le modifiche che
  // arrivano a raffica (meno di 600 ms: un'operazione che tocca più stati, una
  // digitazione veloce) valgono un passo solo. ⌘Z / Ctrl+Z annulla, ⇧⌘Z / Ctrl+Y rifà.
  const hist = useRef<{ past: Snapshot[]; fut: Snapshot[] }>({ past: [], fut: [] });
  const prevSnap = useRef<Snapshot | null>(null);
  const curSnap = useRef<Snapshot | null>(null);
  const applyingHist = useRef(false);
  const histPaused = useRef(true);               // fermo finché un progetto non è caricato
  const lastPush = useRef(0);
  const histSig = JSON.stringify([fonteState(), farmCrops, fieldCrops]);
  const syncHistUi = () => {
    const h = hist.current;
    setCanUndo(h.past.length > 0); setCanRedo(h.fut.length > 0);
    setUndoN(h.past.length); setRedoN(h.fut.length);
  };
  // dopo un caricamento: lo stato attuale è il punto di partenza, cronologia vuota
  function histBaseline(ms = 900) {
    histPaused.current = true;
    window.setTimeout(() => {
      hist.current = { past: [], fut: [] }; prevSnap.current = curSnap.current; histPaused.current = false; syncHistUi();
    }, ms);
  }
  useEffect(() => {
    const curr: Snapshot = { f: fields, a: activeIdRef.current, pv: pivots, pl: pivotLines, rd: roads, g: guided,
      cn: canals, wc: watercourses, sy: sysDesigns, fo: fonteState(), cr: { base: farmCrops, fields: fieldCrops } };
    curSnap.current = curr;
    if (histPaused.current || !prevSnap.current) { prevSnap.current = curr; return; }
    if (applyingHist.current) { applyingHist.current = false; prevSnap.current = curr; return; }
    const now = Date.now();
    if (now - lastPush.current > 600 || !hist.current.past.length) {
      hist.current.past.push(prevSnap.current);
      if (hist.current.past.length > 100) hist.current.past.shift();
    }
    lastPush.current = now;
    hist.current.fut = [];
    prevSnap.current = curr;
    syncHistUi();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, pivots, pivotLines, roads, guided, canals, watercourses, sysDesigns, histSig]);
  useEffect(() => { histBaseline(500); /* all'avvio */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function applySnap(s: Snapshot) {
    applyingHist.current = true; prevSnap.current = s; lastPush.current = 0;
    setActiveId(s.a); setFields(s.f); renderFields(s.f, s.a);
    setPivots(s.pv); setPivotLines(s.pl); setGuided(s.g); setRoads(s.rd);
    if (s.cn) { setCanals(s.cn as CanalL[]); renderCanals(s.cn as CanalL[]); }
    if (s.wc) { setWatercourses(s.wc as WaterL[]); renderWater(s.wc as WaterL[]); }
    if (s.sy) setSysDesigns(s.sy as Record<string, SysDesign>);
    if (s.fo && JSON.stringify(s.fo) !== JSON.stringify(fonteState())) applyFonte(s.fo);
    if (s.cr) { setFarmCrops(s.cr.base); setFieldCrops(s.cr.fields); }
    setPivotSel({ mode: "none", idx: -1 });
    // se lo stato ripristinato coincide con l'attuale l'effetto non riparte: niente flag appeso
    window.setTimeout(() => { applyingHist.current = false; }, 0);
  }
  function undo() {
    const h = hist.current; if (!h.past.length || !prevSnap.current) return;
    h.fut.push(prevSnap.current);
    applySnap(h.past.pop()!);
    syncHistUi();
  }
  function redo() {
    const h = hist.current; if (!h.fut.length || !prevSnap.current) return;
    h.past.push(prevSnap.current);
    applySnap(h.fut.pop()!);
    syncHistUi();
  }
  // ⌘Z / Ctrl+Z annulla, ⇧⌘Z / ⇧Ctrl+Z / Ctrl+Y rifà. Nei campi di testo resta
  // l'annulla del browser; durante il disegno ⌘Z toglie l'ultimo punto.
  const [isMac, setIsMac] = useState(false);
  useEffect(() => { try { setIsMac(/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)); } catch { /* */ } }, []);
  const histKeys = useRef({ undo, redo, drawing: false });
  histKeys.current = { undo, redo, drawing };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== "z" && k !== "y") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      e.preventDefault();
      if (histKeys.current.drawing && k === "z" && !e.shiftKey) { mapApi.current?.drawUndo(); return; }
      if (k === "y" || e.shiftKey) histKeys.current.redo(); else histKeys.current.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (projectId == null) { projLoaded.current = null; return; }
    if (projLoaded.current === projectId) return;
    const pr = projects.find((p) => p.id === projectId); if (!pr) return;
    const st = (pr.settings ?? {}) as { pivot_brand?: string; fonte?: Record<string, unknown> };
    let brand = st.pivot_brand as PivotBrand | undefined;
    if (!brand) { try { brand = (window.localStorage.getItem(`argus.pivotBrand.${projectId}`) as PivotBrand | null) ?? undefined; } catch { /* */ } }
    setPivotBrand(brand && brand in PIVOT_BRANDS ? brand : "starpivot");
    applyFonte((st.fonte ?? {}) as Record<string, unknown>);
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    const te = (st as { terrain?: { dem?: string; smooth?: number } }).terrain ?? {};
    setDemModel(te.dem === "COPERNICUS_90" ? "COPERNICUS_90" : "COPERNICUS_30"); setDemSmooth(num(te.smooth, 100));
    setSpanVmax(num((st as { span_vmax?: number }).span_vmax, 3));
    applyCrops((st as { crops?: { base?: unknown; fields?: Record<string, unknown> } }).crops);
    { const sp = (st as { solar_pv?: Partial<typeof solarCfg> }).solar_pv ?? {};
      setSolarCfg({ wp: num(sp.wp, 550), k: num(sp.k, 1.6), batt: num(sp.batt, 0), off: num(sp.off, 6) }); }
    { const cd = (st as { canal_design?: { lin?: string; q?: number; fb?: number } }).canal_design ?? {};
      setCanalLin(LININGS.some((l) => l.id === cd.lin) ? (cd.lin as LiningId) : "earth"); setCanalQ(num(cd.q, 0)); setCanalFb(num(cd.fb, 0.3)); }
    { const cm = (st as { cu_model?: string }).cu_model; setCuModel(SPRINKLERS.some((x) => x.id === cm) ? cm! : "kpt_black"); }
    { const nv = (st as { ndvi?: api.NdviOut & { sig: string } }).ndvi; setNdvi(nv && Array.isArray(nv.pivots) ? nv : null); }
    { const fe = (st as { fert?: Partial<typeof fert> }).fert ?? {};
      setFert({ on: !!fe.on, k: typeof fe.k === "string" ? fe.k : "uan32", n: num(fe.n, 32), rho: num(fe.rho, 1.32), dose: num(fe.dose, 30), times: num(fe.times, 6) }); }
    { const dr = (st as { drain?: { on?: boolean; c?: number; s?: number; b?: number } }).drain ?? {};
      setDrainOn(!!dr.on); setDrainC(num(dr.c, 12.96)); setDrainS(num(dr.s, 2)); setDrainB(num(dr.b, 0.5));
      setDrainProf(((dr as { prof?: Record<string, { pts: number[][]; z: (number | null)[] }> }).prof) ?? {}); }
    { const ss = (st as { soil_sat?: api.SoilOut & { n: number } }).soil_sat; setSoilSat(ss && typeof ss.sand === "number" ? ss : null);
      const ip = (st as { irr_prog?: { root?: number; p?: number; v100?: number } }).irr_prog ?? {};
      setRootDepth(num(ip.root, 0.8)); setRawP(num(ip.p, 0.5)); setV100(num(ip.v100, 2.3)); }
    const sy = (st as { systems?: Record<string, SysDesign> }).systems;
    setSysDesigns(sy && typeof sy === "object" ? sy : {});
    projSaved.current = "";   // il primo salvataggio allinea le chiavi mancanti
    histBaseline(1200);       // impostazioni di progetto caricate: punto di partenza della cronologia
    projLoaded.current = projectId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, projects]);
  useEffect(() => {
    if (projectId == null || projLoaded.current !== projectId) return;
    const payload = { pivot_brand: pivotBrand, span_vmax: spanVmax, fonte: fonteState(), terrain: { dem: demModel, smooth: demSmooth },
      crops: { base: farmCrops, fields: fieldCrops }, solar_pv: solarCfg, canal_design: { lin: canalLin, q: canalQ, fb: canalFb }, cu_model: cuModel, fert, ndvi, drain: { on: drainOn, c: drainC, s: drainS, b: drainB, prof: drainProf }, soil_sat: soilSat, irr_prog: { root: rootDepth, p: rawP, v100 },
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
  }, [projectId, pivotBrand, srcPt, srcRoute, srcType, srcQmax, srcHours, srcRange, srcSediment, srcEnergy, pumpDrive, srcMonthly, srcSectors,
    resDepth, resDays, resEvapK, wtwEta, canalSlope, bankSlope, settleMm, filterCap, wellQ, srcShown, river, demModel, demSmooth, spanVmax, sysDesigns, farmCrops, fieldCrops, solarCfg, canalLin, canalQ, canalFb, cuModel, fert, ndvi, drainOn, drainC, drainS, drainB, drainProf, soilSat, rootDepth, rawP, v100, cableM, costKwh, costDiesel, dieselLkWh, genShare, costMaintKw, costPvOm, costBattKwh, battLife]);
  useEffect(() => {
    if (projectId == null || projLoaded.current !== projectId || (!pivots.length && !fields.length)) return;
    const h = window.setTimeout(() => { void siteClimateCached(); }, 2500);
    return () => window.clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pivots.length, fields.length]);
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
      if (coords.length < 2) return;
      const route = [srcPt, ...coords.slice(1)];
      setSrcRoute(route);
      // il percorso appena tracciato resta modificabile (la presa resta ferma)
      setTimeout(() => {
        setRoadSel("__src");
        setMsg(t("Percorso in modifica: trascina i punti o i «+» a metà dei tratti per aggiungerne; doppio clic su un punto per toglierlo."));
        mapApi.current?.editPipe?.(route, (c) => setSrcRoute([srcPt, ...c.slice(1)]), [], [], { pivot: t("Punto"), canal: t("Punto"), free: t("Punto") });
      }, 0);
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
    main?: { kind: "pipe" | "canal"; L: number; dn?: number; n?: number; hf?: number; hiPt?: number; cutMax?: number; fillMax?: number; sec?: CanalSection | null };
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
    const Hd = Math.max(hydraNow() ? hydraNow()!.headMax : pMaxBar * 10.2 + Math.max(0, psHeadExtra), sysTotals().headMax);   // prevalenza della distribuzione (pivot e altri sistemi)
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
        stages: bst, main: { kind: "canal", L, cutMax, fillMax, sec: designCanal(qc, Math.max(0.05, canalSlope), canalLin, { fb: canalFb }) }, res: rC, sectors: secs.length > 1 ? secs : undefined }));
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
    const d = sourceDrawing();
    m.setSourceScheme?.(d ? { ...d, picked: srcPicked, onPick: () => {
      setSrcPicked(true); setFieldPicked(false); setPivotSel({ mode: "none", idx: -1 }); setPipeSel({ mode: "none", idx: -1 });
    } } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcPicked, srcPt, srcRoute, srcShown, srcElev, srcType, srcEnergy, srcHours, srcQmax, srcRange, srcMonthly, srcSectors, pivots, mmDes, hoursDay, resDepth, resDays, resEvapK, et0Peak, wtwEta, canalSlope, lang]);
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
          {srcPt && srcType !== "pozzo" && renderRiver()}
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
              <div className="seg-item" data-active={srcEnergy === "rete"} onClick={() => setEnergy("rete")}>{t("Rete / generatore")}</div>
              <div className="seg-item" data-active={srcEnergy === "fv-gen"} onClick={() => setEnergy("fv-gen")}>{t("FV + generatore")}</div>
              <div className="seg-item" data-active={srcEnergy === "fv-batt"} onClick={() => setEnergy("fv-batt")}>{t("FV + batterie")}</div>
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
                      ? <div>• {t("Canale a gravità")}: {uKm(sc.main.L / 1000, 1)} · {t("pendenza")} {fmt(canalSlope, { maximumFractionDigits: 2 })}‰{S.prof && <> · {t("scavo massimo")} {fmt(sc.main.cutMax ?? 0, { maximumFractionDigits: 1 })} m · {t("rilevato massimo")} {fmt(sc.main.fillMax ?? 0, { maximumFractionDigits: 1 })} m</>}
                        {sc.main.sec && <> · {t("sezione")} b {fmt(sc.main.sec.b, { maximumFractionDigits: 2 })} m, y {fmt(sc.main.sec.y, { maximumFractionDigits: 2 })} m, {t("ciglio")} {fmt(sc.main.sec.topW, { maximumFractionDigits: 2 })} m, v {fmt(sc.main.sec.v, { maximumFractionDigits: 2 })} m/s ({t(lining(canalLin).label).toLowerCase()})</>}</div>
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
    const headFromNet = hydraNow() ? hydraNow()!.headMax : null;
    const head = Math.max(headFromNet ?? (n ? pMaxBar * 10.2 + Math.max(0, psHeadExtra) : 0), SY.headMax) + Math.max(0, psLift);
    const clim = fields.map((f) => (f.lay as { climate?: { eto_month_mm?: number[]; rain_month_mm?: number[]; source?: string } } | null | undefined)?.climate)
      .find((c) => c && c.eto_month_mm?.length === 12 && c.rain_month_mm?.length === 12);
    const kcAvg = kcAreaAvg * Math.max(0.3, psKcAvg / 100);
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
  // Una sola scelta dell'alimentazione per tutto il progetto: vale per la fonte
  // d'acqua, per la pagina Layout e per le varianti.
  function setEnergy(k: "rete" | "fv-gen" | "fv-batt") { setSrcEnergy(k); setPowerMode(k === "rete" ? "grid" : "solar"); }
  function renderEnergyPick() {
    return (
      <div className="bg-panel rounded-lg p-2">
        <div className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide mb-1">{t("Alimentazione")}</div>
        <div className="seg text-[11px]">
          <div className="seg-item" data-active={srcEnergy === "rete" && powerMode === "grid"} onClick={() => setEnergy("rete")}>{t("Rete / generatore")}</div>
          <div className="seg-item" data-active={powerMode === "solar" && srcEnergy === "fv-gen"} onClick={() => setEnergy("fv-gen")}>{t("FV + generatore")}</div>
          <div className="seg-item" data-active={powerMode === "solar" && srcEnergy === "fv-batt"} onClick={() => setEnergy("fv-batt")}>{t("FV + batterie")}</div>
        </div>
      </div>
    );
  }
  // Pompe Caprari consigliate e linee elettriche (vanno nel computo e nel .ceres)
  function renderStationsPanel() {
    if (!pivots.length) return null;
    const st = pumpStationsList();
    const cabs = cableRuns(st);
    const famTxt: Record<string, string> = { vert: t("verticale sommersa"), subm: t("elettropompa sommersa"), horiz: t("ad asse orizzontale") };
    return (
      <div className="bg-panel rounded-lg p-2 space-y-1.5">
        <div className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide">{t("Pompe e linee elettriche")}</div>
        {!capReady && <p className="text-[11px] text-sage-dark">{t("Carico le curve delle pompe…")}</p>}
        <div className="text-[11px] text-sage-dark">{t("Pompe di superficie")}</div>
        <div className="seg">
          <div className="seg-item" data-active={pumpDrive === "el"} onClick={() => setPumpDrive("el")}>{t("Motore elettrico")}</div>
          <div className="seg-item" data-active={pumpDrive === "diesel"} onClick={() => setPumpDrive("diesel")}>{t("Motore diesel")}</div>
        </div>
        {pumpDrive === "diesel" && <p className="text-[11px] text-sage-dark">{t("Motopompe: anche le pompe a velocità intermedia e la serie MEC-MG; niente linee elettriche né quadri per queste pompe, consumo a gasolio.")}</p>}
        {st.map((x, i) => (
          <div key={i} className="text-[11px] leading-snug">
            <div className="text-brand-darker font-semibold">{x.name}</div>
            <div className="text-sage-dark">{fmt(Math.round(x.qLs))} l/s · {fmt(Math.round(x.head))} m{x.pick
              ? <> · <b className="text-brand-darker">{x.nTot > 1 ? `${x.nTot} × ` : ""}Caprari {x.pick.model}</b> ({famTxt[x.pick.fam] ?? x.pick.fam}) · {x.pick.diesel ? t("motore diesel") : t("motore")} {fmt(x.pick.motor, { maximumFractionDigits: 1 })} kW{x.pick.diesel ? <> · {fmt(x.pick.rpm)} {t("giri/min")}</> : null} · η {fmt(Math.round(x.pick.eta))} %</>
              : capReady ? <> · {t("nessuna pompa a catalogo per questo punto di lavoro")}</> : null}</div>
          </div>
        ))}
        <label className="text-[11px] text-sage-dark block">{t("Distanza dal punto di consegna dell'energia alle pompe (m)")}
          <input type="number" min={0} max={20000} step={10} value={cableM} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setCableM(Math.max(0, Math.min(20000, v))); }}
            className="field-input mt-0.5 py-1 text-sm" /></label>
        {cabs.length > 0 && (
          <table className="w-full text-[11px]"><tbody>
            {cabs.map((c, i) => (
              <tr key={i} className="border-t border-black/5">
                <td className="text-brand-darker pr-1">{c.name}</td>
                <td className="text-right tabular-nums whitespace-nowrap">{fmt(c.kW, { maximumFractionDigits: 1 })} kW</td>
                <td className="text-right tabular-nums whitespace-nowrap">{c.mat} 3×{fmt(c.S, { maximumFractionDigits: 1 })} mm²</td>
                <td className="text-right tabular-nums whitespace-nowrap">{fmt(c.L)} m</td>
                <td className="text-right tabular-nums whitespace-nowrap text-sage-dark">ΔV {fmt(c.dv, { maximumFractionDigits: 1 })} %</td>
              </tr>
            ))}
          </tbody></table>
        )}
        <p className="text-[10px] text-sage-dark leading-snug">{t("Pompe scelte dalle curve Caprari (le stesse di Ceres) per rendimento al punto di lavoro. Cavi interrati a 400 V con caduta di tensione entro il 4 %; i pivot sono alimentati dalla stazione che li serve, lungo le tubazioni. Tutto va nel computo e nel file .ceres per Mercurius.")}</p>
      </div>
    );
  }
  // Colture: una o più per l'azienda e, se serve, una o più per campo (rotazione).
  // Il dimensionamento della rete usa la più esigente, i consumi la media pesata sugli ettari.
  function cropChips(sel: string[], onToggle: (k: string) => void, dim = false) {
    return (
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {CROP_LIST.map((cp) => {
          const on = sel.includes(cp.key);
          return <button key={cp.key} type="button" onClick={() => onToggle(cp.key)} aria-pressed={on}
            title={`Kc ${fmt(cp.kc, { maximumFractionDigits: 2 })}`}
            className={"px-2.5 py-1 rounded-full border text-[11px] font-medium leading-none transition-colors " + (on
              ? (dim ? "bg-brand/10 border-brand/30 text-brand-dark" : "bg-brand border-brand text-white shadow-sm")
              : "bg-white border-black/10 text-sage-dark hover:border-brand/40 hover:text-brand-dark")}>
            {t(cp.label)}</button>;
        })}
      </div>
    );
  }
  const toggleFarmCrop = (k: string) => setFarmCrops((l) => {
    const n = l.includes(k) ? l.filter((x) => x !== k) : [...l, k];
    if (!n.length) return l;                                           // almeno una coltura
    patch({ kc: Math.max(...n.map((x) => cropOf(x).kc)) });
    return n;
  });
  // ---- Completamento del progetto: barra a sinistra con quello che manca ----------------
  const [progOpen, setProgOpen] = useState(() => { try { return localStorage.getItem("argus.progOpen") === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("argus.progOpen", progOpen ? "1" : "0"); } catch { /* */ } }, [progOpen]);
  type PStep = { k: string; ok: boolean; warn?: boolean; label: string; hint: string; tab?: string };
  const progSteps = useMemo((): PStep[] => {
    const hasPipes = pivotLines.some((l) => l.kind === "pipe");
    let pumpsOk = false;
    try { pumpsOk = capReady && pivots.length > 0 && pumpStationsList().some((st) => st.pick); } catch { pumpsOk = false; }
    const st = projSettings(), exported = Number((st as { ceres_rev?: number }).ceres_rev ?? 0) > 0;
    const etOk = siteEt0Peak == null || Math.abs(siteEt0Peak - et0Peak) < 0.15;
    return [
      { k: "client", ok: clientId != null, label: t("Cliente"), hint: t("Scegli o crea il cliente nel pannello Progetto") },
      { k: "fields", ok: fields.length > 0, label: t("Campi"), hint: t("Disegna o importa i campi"), tab: "analisi" },
      { k: "pivots", ok: pivots.length > 0 || Object.keys(sysDesigns).length > 0, label: t("Macchine di irrigazione"), hint: t("Posa i pivot sul campo"), tab: "impianti" },
      { k: "source", ok: !!srcPt, label: t("Fonte d'acqua"), hint: t("Indica la presa: fiume, canale, pozzo o invaso"), tab: "fonte" },
      { k: "pipes", ok: hasPipes, label: t("Rete di tubazioni"), hint: t("Collega i pivot alla fonte con le tubazioni"), tab: "accessori" },
      { k: "dn", ok: !!hydra, warn: hasPipes, label: t("Diametri della rete"), hint: t("Calcola i diametri nella pagina Tubazioni"), tab: "accessori" },
      { k: "pumps", ok: pumpsOk, label: t("Pompe"), hint: t("Scegli le pompe Caprari nella pagina Pompaggio"), tab: "pompaggio" },
      { k: "climate", ok: !!st.site_climate, warn: true, label: t("Clima del sito"), hint: t("Si scarica da solo all'apertura del progetto (NASA POWER)") },
      { k: "et0", ok: !!st.site_climate && etOk, warn: true, label: t("ET₀ di punta"), hint: siteEt0Peak != null ? t("Sito: {v} mm/g · usa questo valore", { v: fmt(siteEt0Peak, { maximumFractionDigits: 1 }) }) : t("Allinea l'ET₀ di punta al clima del sito"), tab: "irrigazione" },
      { k: "export", ok: exported, label: t("Pacchetto di progetto"), hint: t("Esporta relazione, tavole e computo"), tab: "export" },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, fields.length, pivots, sysDesigns, srcPt, pivotLines, hydra, capReady, projects, projectId, et0Peak, lang]);
  function renderProgress() {
    if (projectId == null) return null;
    const S2 = progSteps, done = S2.filter((x) => x.ok).length, next = S2.find((x) => !x.ok && !x.warn) ?? S2.find((x) => !x.ok);
    const pct = Math.round((done / S2.length) * 100);
    const act = (x: PStep) => { if (x.k === "et0" && siteEt0Peak != null) { setEt0Peak(Math.round(siteEt0Peak * 10) / 10); return; } if (x.tab) goTab(x.tab); else setLeftMin(false); };
    return (
      <div className="pointer-events-auto w-full widget px-3 py-2 shrink-0" data-testid="project-progress">
        <button type="button" className="w-full flex items-center gap-2 text-left" onClick={() => setProgOpen((o) => !o)} aria-expanded={progOpen}
          title={progOpen ? t("Riduci") : t("Mostra cosa manca per completare il progetto")}>
          <span className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide flex-1">{t("Completamento del progetto")}</span>
          <span className={`text-[11px] font-semibold tabular-nums ${done === S2.length ? "text-brand" : "text-brand-darker"}`}>{done}/{S2.length}</span>
          <span className="text-sage-dark text-[10px]">{progOpen ? "▴" : "▾"}</span>
        </button>
        <div className="mt-1.5 flex gap-[3px]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t("Completamento del progetto")}>
          {S2.map((x) => (
            <button key={x.k} type="button" onClick={() => act(x)} title={`${x.label}: ${x.ok ? "✓" : x.hint}`}
              className={`h-1.5 flex-1 rounded-full transition-colors ${x.ok ? "bg-brand" : x.warn ? "bg-amber/80" : "bg-black/10 hover:bg-black/20"}`} />
          ))}
        </div>
        {!progOpen && next && (
          <button type="button" onClick={() => act(next)} className="mt-1.5 w-full flex items-center gap-1.5 text-[11px] text-left text-brand-darker hover:text-brand">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${next.warn ? "bg-amber" : "bg-rust"}`} />
            <span className="flex-1 min-w-0 truncate"><b className="font-semibold">{next.label}</b> · {next.hint}</span>
            {next.tab && <span className="shrink-0 text-brand-mid">→</span>}
          </button>
        )}
        {progOpen && (
          <ul className="mt-2 space-y-1">
            {S2.map((x) => (
              <li key={x.k}>
                <button type="button" onClick={() => !x.ok && act(x)} disabled={x.ok}
                  className={`w-full flex items-start gap-2 rounded-md px-1.5 py-1 text-left text-[11px] ${x.ok ? "cursor-default" : "hover:bg-black/5"}`}>
                  <span className={`mt-[1px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full text-[9px] font-bold ${x.ok ? "bg-brand text-white" : x.warn ? "bg-amber text-white" : "border border-black/20 text-transparent"}`}>{x.ok ? "✓" : x.warn ? "!" : "·"}</span>
                  <span className="flex-1 min-w-0">
                    <span className={`block font-semibold ${x.ok ? "text-sage-dark" : "text-brand-darker"}`}>{x.label}</span>
                    {!x.ok && <span className="block text-sage-dark leading-snug">{x.hint}</span>}
                  </span>
                  {!x.ok && x.tab && <span className="shrink-0 text-brand-mid">→</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  async function downloadSolarSheet(k: number) {
    const pv = pivots[k]; if (!pv) return;
    setBusy(`sol${k}`);
    try {
      const c = spanComposition(pv, pivotBrand), PIPE_TXT = ['10"', '8"5/8', '6"5/8'];
      const lng: Lang = pdfLang;
      const doc = inLang(lng, () => ({
        lang: lng, name: `P${k + 1}`, r: pv.r, lat: pv.lat, gun: pv.gun ?? 0, q_ls: pivotFlow(pv), p_bar: pivotPressure(pv), show_flow: pivotLabels,
        spans: c ? c.spans.map((sp) => ({ len: sp.len, d: PIPE_TXT[sp.pipe] ?? "" })) : Array.from({ length: Math.max(1, Math.round(pv.r / 50)) }, () => ({ len: pv.r / Math.max(1, Math.round(pv.r / 50)), d: "" })),
        cfg: solarCfg, tara_r: solarSize(pv).taraR,
        labels: {
          kTara: tx("Tara (area non irrigua)"), vTara: tx("cerchio di {r} m di raggio attorno al perno: {a} m² non irrigati, tolti dalla superficie irrigata"),
          kicker: tx("CAMPO FOTOVOLTAICO DEL PIVOT SOLARE"), title: tx("{name} · {r} m · {n} campate{gun}"), withGun: tx(" · irrigatore finale"),
          sub: tx("{kw} kW assorbiti → {kwp} kWp: {n} moduli da {wp} Wp in {rows} file, a {off} m dal perno, inclinati di {tilt}° verso {dir}"), south: tx("sud"), north: tx("nord"),
          persp: tx("Vista prospettica · il pivot ruota sopra il campo FV: nel raggio dei pannelli (≈ {r} m) niente discese degli irrigatori"),
          plan: tx("PIANTA · scala grafica"), section: tx("SEZIONE DELLE FILE"), data: tx("DATI DI PROGETTO"),
          pivotPt: tx("perno"), panel: tx("quadro FV / inverter"), noDrops: tx("tara: cerchio non irriguo r {r} m"), span1: tx("1ª campata {l} m"),
          pipe: tx("tubo della campata ≈ 4,4 m"), truss: tx("traliccio ≈ 3,2 m"), pitch: tx("passo {p} m"),
          kPower: tx("Potenza del pivot"), vPower: tx("{t} torri × 0,75 kW{g} = {kw} kW"), vGun: tx(" + irrigatore finale 1,5 kW"),
          kField: tx("Campo FV"), vField: tx("{kwp} kWp ({k} kWp per kW): {n} moduli da {wp} Wp, 1,134 × 2,278 m"),
          kLayout: tx("Disposizione"), vLayout: tx("{rows} file da {cols} moduli verticali, inclinati {tilt}°, passo {p} m"),
          kArea: tx("Ingombro"), vArea: tx("{w} × {d} m = {a} m² · bordo a {off} m dal perno"),
          kHeight: tx("Altezza"), vHeight: tx("da {h0} a {h1} m: sotto il traliccio (≈ 3,2 m), il pivot ci passa sopra"),
          kFlow: tx("Portata del pivot"), vFlow: tx("{q} l/s ({m3} m³/h) a {p} bar"),
          kElec: tx("Elettrico"), vElecDay: tx("inverter / regolatore ≈ {inv} kW nel quadro vicino al perno; senza batterie il pivot irriga di giorno"),
          vElecBatt: tx("inverter / regolatore ≈ {inv} kW nel quadro vicino al perno; batterie {b} kWh ({h} h di autonomia)"),
          foot: tx("Argus Total · by Nabu · Agrostar Group — schema indicativo: moduli, strutture e altezze da verificare con il costruttore del pivot e dell'impianto FV."),
        },
      }));
      const pname = projects.find((x) => x.id === projectId)?.name || "progetto";
      saveBlob(await api.solarSheet(doc), `${safe(pname)}_P${k + 1}_campo_FV.pdf`);
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function renderSolarPivots() {
    if (!pivots.length) return <p className="text-[11px] text-sage-dark">{t("Posa i pivot per scegliere quali alimentare con i pannelli solari.")}</p>;
    const setAll = (on: boolean) => commitPivots(pivots.map((p) => ({ ...p, solar: on || undefined })));
    const nOn = pivots.filter((p) => p.solar).length;
    const SZ = pivots.map((p) => solarSize(p)), tot = pivots.reduce((a, p, k) => (p.solar ? { kWp: a.kWp + SZ[k].kWp, n: a.n + SZ[k].n, b: a.b + SZ[k].batt } : a), { kWp: 0, n: 0, b: 0 });
    const num = (label: string, v: number, set: (x: number) => void, step: number, min: number, max: number, hint?: string) => (
      <label className="text-[11px] text-sage-dark" title={hint}>{label}
        <input type="number" min={min} max={max} step={step} value={v}
          onChange={(e) => { const x = Number(e.target.value); if (Number.isFinite(x)) set(Math.max(min, Math.min(max, x))); }} className="field-input mt-0.5 py-1 text-sm" /></label>
    );
    return (
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-[11px] text-sage-dark cursor-pointer">
          <input type="checkbox" checked={pivotLabels} onChange={(e) => setPivotLabels(e.target.checked)} />
          {t("Mostra la portata dei pivot (sulla mappa, qui e nella scheda)")}</label>
        <div className="flex gap-2">
          <button className="btn-ghost flex-1 text-[12px]" onClick={() => setAll(true)} disabled={nOn === pivots.length}>{t("Tutti solari")}</button>
          <button className="btn-ghost flex-1 text-[12px]" onClick={() => setAll(false)} disabled={!nOn}>{t("Nessuno")}</button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {num(t("Modulo (Wp)"), solarCfg.wp, (x) => setSolarCfg((c) => ({ ...c, wp: x })), 10, 200, 800)}
          {num(t("Fattore kWp / kW"), solarCfg.k, (x) => setSolarCfg((c) => ({ ...c, k: x })), 0.1, 1, 4, t("kWp installati per ogni kW assorbito dal pivot: tiene conto del rendimento del sistema e del sole basso a inizio e fine giornata"))}
          {num(t("Autonomia con batterie (h)"), solarCfg.batt, (x) => setSolarCfg((c) => ({ ...c, batt: x })), 1, 0, 24, t("0 = il pivot lavora solo di giorno"))}
          {num(t("Distanza dal perno (m)"), solarCfg.off, (x) => setSolarCfg((c) => ({ ...c, off: x })), 1, 2, 40)}
        </div>
        <ul className="space-y-1">
          {pivots.map((p, k) => {
            const z = SZ[k];
            return (
              <li key={k} className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${p.solar ? "border-sky-700/40 bg-sky-50" : "border-black/5 bg-white"}`}>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!p.solar} onChange={(e) => commitPivots(pivots.map((q, i) => (i === k ? { ...q, solar: e.target.checked || undefined } : q)))} />
                  <b className="text-brand-darker w-7">P{k + 1}</b>
                  <span className="flex-1 text-sage-dark tabular-nums">{fmt(z.kW, { maximumFractionDigits: 2 })} kW → <b className="text-brand-darker">{fmt(z.kWp, { maximumFractionDigits: 1 })} kWp</b> · {z.n} {t("moduli")} · {z.rows}×{z.cols}{z.batt ? ` · ${fmt(z.batt)} kWh` : ""}</span>
                </label>
                {p.solar && <div className="pl-6 text-rust tabular-nums" data-tara={Math.round(z.taraM2)}>{t("tara")} Ø {fmt(2 * z.taraR)} m · −{fmt(z.taraM2 / 1e4, { maximumFractionDigits: 2 })} ha → {fmt(pvAreaM2(p) / 1e4, { maximumFractionDigits: 2 })} ha {t("irrigui")}</div>}
                <div className="mt-1 flex items-center gap-3 pl-6 text-sage-dark">
                  <label className="flex items-center gap-1 cursor-pointer" title={t("L'irrigatore finale aggiunge 1,5 kW di pompa di rilancio al pivot")}>
                    <input type="checkbox" checked={!!(p.gun && p.gun > 0)} onChange={(e) => commitPivots(pivots.map((q, i) => (i === k ? { ...q, gun: e.target.checked ? 25 : undefined } : q)))} />
                    {t("Irrigatore finale")}</label>
                  {pivotLabels && <span className="tabular-nums">{fmt(pivotFlow(p), { maximumFractionDigits: 1 })} l/s · {fmt(pivotPressure(p), { maximumFractionDigits: 1 })} bar</span>}
                  <button type="button" className="ml-auto text-brand-mid hover:underline disabled:opacity-40" disabled={busy === `sol${k}`} onClick={() => downloadSolarSheet(k)}
                    title={t("Scheda in scala del campo FV di questo pivot: vista prospettica, pianta quotata, sezione delle file e dati (PDF A3)")}>
                    {busy === `sol${k}` ? t("Preparo…") : t("Scheda in scala")} ↓</button>
                </div>
                {p.solar && (() => {
                  const sm = pivotSolarMonths(p); if (!sm) return <div className="pl-6 mt-1 text-sage-dark">{t("Irraggiamento del sito non ancora caricato.")}</div>;
                  return (
                    <div className="pl-6 mt-1" data-solar-months>
                      <div className="flex gap-0.5">
                        {sm.rows.map((r) => (
                          <div key={r.m} className={"flex-1 rounded-sm text-center text-[9px] leading-tight py-0.5 " + (r.hNeed <= 0.05 ? "bg-black/5 text-sage-dark" : r.hNeed <= r.hSun + 1e-6 ? "bg-brand/20 text-brand-darker" : r.ok ? "bg-amber-200 text-amber-900" : "bg-rose-200 text-rose-900")}
                            title={`${new Date(2000, r.m, 1).toLocaleString(lang, { month: "long" })}: ${fmt(r.E, { maximumFractionDigits: 0 })} kWh/${t("giorno")} · ${t("sole sufficiente")} ${fmt(r.hSun, { maximumFractionDigits: 1 })} h · ${t("marcia")} ${fmt(r.hNeed, { maximumFractionDigits: 1 })} h${r.battNeed > 0 ? ` · ${t("batteria")} ${fmt(Math.ceil(r.battNeed))} kWh` : ""}`}>
                            {new Date(2000, r.m, 1).toLocaleString(lang, { month: "narrow" })}<br />{r.hNeed > 0.05 ? fmt(Math.round(r.hNeed)) : "·"}</div>
                        ))}
                      </div>
                      <div className="mt-0.5 text-sage-dark">{sm.okAll && sm.battMax <= 0 ? t("Il sole basta per le ore di marcia di tutti i mesi irrigui.")
                        : sm.okAll ? t("Con le batterie impostate il pivot fa le sue ore in tutti i mesi.")
                          : t("Nei mesi in rosa il sole da solo non basta: servono circa {b} kWh di batterie (autonomia da impostare sopra).", { b: fmt(sm.battMax) })}</div>
                    </div>
                  );
                })()}
              </li>
            );
          })}
        </ul>
        {nOn > 0 && (
          <div className="grid grid-cols-4 gap-2 text-center">
            <div className="bg-panel rounded-lg p-2"><div className="text-lg font-semibold text-brand">{nOn}</div><div className="text-[11px] text-sage-dark">{t("pivot solari")}</div></div>
            <div className="bg-panel rounded-lg p-2" title={t("Area non irrigua attorno al perno, dove stanno i pannelli: è tolta dalla superficie irrigata")}><div className="text-lg font-semibold text-rust">−{fmt(pivots.reduce((a, p, k) => a + (p.solar ? SZ[k].taraM2 : 0), 0) / 1e4, { maximumFractionDigits: 2 })}</div><div className="text-[11px] text-sage-dark">{t("ha di tara")}</div></div>
            <div className="bg-panel rounded-lg p-2"><div className="text-lg font-semibold text-brand">{fmt(tot.kWp, { maximumFractionDigits: 1 })}</div><div className="text-[11px] text-sage-dark">kWp</div></div>
            <div className="bg-panel rounded-lg p-2"><div className="text-lg font-semibold text-brand">{fmt(tot.n)}</div><div className="text-[11px] text-sage-dark">{t("moduli")}</div></div>
          </div>
        )}
        <p className="text-[11px] leading-snug text-sage-dark text-justify">{t("I moduli si vedono sulla mappa accanto al centro di ogni pivot solare, a sud del perno. Per questi pivot spariscono la linea elettrica dalla stazione e la sua quota di potenza nel quadro; nel computo entrano campo FV, moduli, strutture, inverter ed eventuali batterie.")} {t("Il cerchio attorno al perno che contiene i pannelli non è irriguo: è contato come tara e tolto dalla superficie irrigata, dalla portata e dai consumi.")}</p>
      </div>
    );
  }
  function renderFarmCrops() {
    return (
      <div>
        <div className="text-xs text-sage-dark">{fields.length > 1 ? t("Colture dell'azienda") : t("Colture")}</div>
        {cropChips(farmCrops, toggleFarmCrop)}
      </div>
    );
  }
  function renderFieldCrops() {
    if (fields.length < 2) return null;
    const ha = (f: Field) => pivots.filter((p) => p.field === f.id).reduce((a, p) => a + pvAreaM2(p) / 10000, 0);
    return (
      <div className="mt-3 space-y-1.5">
        <div className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide">{t("Colture per campo")}</div>
        {fields.map((f) => {
          const own = fieldCrops[cropFKey(f)] ?? [];
          const toggle = (k: string) => setFieldCrops((m) => {
            const cur = m[cropFKey(f)] ?? [];
            const n = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
            const out = { ...m }; if (n.length) out[cropFKey(f)] = n; else delete out[cropFKey(f)]; return out;
          });
          return (
            <div key={f.id} className="rounded-lg border border-black/5 bg-white px-2.5 py-2 text-[11px] text-sage-dark">
              <div className="flex items-baseline gap-2">
                <span className="flex-1 min-w-0 truncate font-semibold text-brand-darker">{f.name}</span>
                {ha(f) > 0 && <span className="tabular-nums">{uHa(ha(f))}</span>}
                {own.length ? <button type="button" className="text-brand-dark hover:underline" onClick={() => setFieldCrops((m) => { const o = { ...m }; delete o[cropFKey(f)]; return o; })}>{t("Come l'azienda")}</button>
                  : <span className="italic">{t("Come l'azienda")}</span>}
              </div>
              {cropChips(own.length ? own : cropsOfField(f).map((c) => c.key), toggle, !own.length)}
            </div>
          );
        })}
        {designCrops.length > 1 && <p className="text-[11px] leading-snug text-sage-dark text-justify">{t("Rete, pompe e vasche sono dimensionate sulla coltura più esigente ({c}): con la rotazione le colture cambiano campo; i consumi annui usano il Kc medio pesato sugli ettari ({k}).", { c: t(cropMax.label), k: fmt(kcAreaAvg, { maximumFractionDigits: 2 }) })}</p>}
      </div>
    );
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
        {renderEnergyPick()}
        {renderStationsPanel()}
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
          <div className="seg-item" data-active={powerMode === "grid"} onClick={() => setEnergy("rete")}>{t("Rete / generatore")}</div>
          <div className="seg-item" data-active={powerMode === "solar"} onClick={() => setEnergy(srcEnergy === "rete" ? "fv-batt" : srcEnergy)}>{t("Fotovoltaico")}</div>
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

  const CC = tab === "rilievo" ? canalCalcs() : [];
  return (
    <main>
      <MapCanvas apiRef={mapApi} onCreate={addDrawnField} onEditActive={updateActiveGeom} onSelect={(id) => { selectField(id); setFieldPicked(true); setSrcPicked(false); setPivotSel({ mode: "none", idx: -1 }); setPipeSel({ mode: "none", idx: -1 }); }}
        onCanalProfile={(i) => setProfileCanal(i)} onDrawChange={setDrawing} />

      {/* Elemento selezionato: ⌫ (o il pulsante) lo elimina, Esc toglie la selezione */}
      {delTarget && !drawing && (
        <div className="ui-scale fixed top-20 left-1/2 -translate-x-1/2 z-[500] widget pl-3 pr-1.5 py-1.5 flex items-center gap-2 pointer-events-auto">
          <span className="text-[12px] text-sage-dark max-w-[220px] truncate"><b className="text-brand-darker">{delTarget.name}</b> · {t("selezionato")}</span>
          <button className="btn-ghost text-danger flex items-center gap-1.5" onClick={() => delTarget.del()} title={t("Elimina")}>
            {t("Elimina")} <kbd className="text-[10px] font-sans px-1.5 py-0.5 rounded border border-danger/30 bg-danger/5">{isMac ? "⌫" : "Canc"}</kbd>
          </button>
          <button className="btn-ghost" onClick={clearSel} title={t("Togli la selezione")}>
            <kbd className="text-[10px] font-sans px-1.5 py-0.5 rounded border border-black/10 bg-black/[0.03]">Esc</kbd>
          </button>
        </div>
      )}
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

            <div className="flex items-center rounded-full bg-white/5 ring-1 ring-white/10">
              <button onClick={undo} disabled={!canUndo} className="nav-pill relative px-2.5 disabled:opacity-60"
                title={canUndo ? `${t("Annulla l'ultima operazione")} (${isMac ? "⌘Z" : "Ctrl+Z"})` : t("Niente da annullare")} aria-label={t("Annulla")}>
                <IcoUndo />
                {undoN > 1 && <span className="absolute -top-1 -right-0.5 min-w-[15px] h-[15px] px-0.5 text-[9px] font-bold leading-[15px] text-center rounded-full bg-white/90 text-nabu-green tabular-nums">{undoN > 99 ? "99+" : undoN}</span>}
              </button>
              <button onClick={redo} disabled={!canRedo} className="nav-pill relative px-2.5 disabled:opacity-60"
                title={canRedo ? `${t("Rifai l'operazione annullata")} (${isMac ? "⇧⌘Z" : "Ctrl+Y"})` : t("Niente da rifare")} aria-label={t("Rifai")}>
                <IcoRedo />
                {redoN > 1 && <span className="absolute -top-1 -right-0.5 min-w-[15px] h-[15px] px-0.5 text-[9px] font-bold leading-[15px] text-center rounded-full bg-white/90 text-nabu-green tabular-nums">{redoN > 99 ? "99+" : redoN}</span>}
              </button>
            </div>

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
        {renderProgress()}
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
                <span className={"inline-block w-2 h-2 rounded-full " + (autosave === "saving" ? "bg-amber animate-pulse" : autosave === "error" ? "bg-danger" : "bg-brand")} />
                {autosave === "saving" ? t("Salvataggio automatico…") : autosave === "error" ? t("Salvataggio non riuscito (riprovo alla prossima modifica)") : t("Salvataggio automatico attivo — le modifiche vengono salvate da sole")}
              </div>
            )}
            <div className="mt-3" data-mapview>
              <div className="flex items-center justify-between">
                <label className="text-xs text-sage-dark">{t("Vista mappa")}</label>
                <span className="text-[11px] text-brand-mid space-x-2">
                  <button type="button" className="hover:underline" onClick={() => { setMapHide([]); setPivotLabels(true); }}>{t("Tutte")}</button>
                  <button type="button" className="hover:underline" onClick={() => { setMapHide(MAP_VIEW.map(([k]) => k)); setPivotLabels(false); }}>{t("Nessuna")}</button>
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {MAP_VIEW.map(([k, lab]) => {
                  const on = k === "pivot" ? pivotLabels : !mapHide.includes(k);
                  return (
                    <button key={k} type="button" data-mv={k} aria-pressed={on}
                      onClick={() => (k === "pivot" ? setPivotLabels(!on) : setMapHide((h) => (on ? [...h, k] : h.filter((x) => x !== k))))}
                      className={`rounded-full border px-2 py-0.5 text-[11px] transition ${on ? "border-brand/40 bg-brand/10 text-brand-darker" : "border-black/10 bg-white text-sage-dark line-through opacity-70"}`}>
                      {t(lab)}</button>
                  );
                })}
              </div>
            </div>
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
                  {(() => {
                    const u = pivotCU(selPivot);
                    return (
                      <div className="mt-2 bg-panel rounded-lg p-2 text-[11px] text-sage-dark leading-snug" data-cu>
                        <label className="flex items-center gap-2">{t("Uniformità con")}
                          <select className="field-input py-0.5 text-[11px] flex-1" value={cuModel} onChange={(e) => setCuModel(e.target.value)}>
                            {SPRINKLERS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
                        {u ? <div className="mt-1">CU <b className="text-brand-darker">{fmt(u.CU, { maximumFractionDigits: 1 })}%</b> ({t(cuGrade(u.CU))}) · DU {fmt(u.DU, { maximumFractionDigits: 1 })}% · {t("picco")} {fmt(u.peak, { maximumFractionDigits: 0 })} mm/h · {u.n} {t("uscite")}
                          {u.minMargin < 0.35 && <><br /><span className="text-rust">{t("Pressione in punta vicina a quella dei regolatori: margine {m} bar.", { m: fmt(u.minMargin, { maximumFractionDigits: 2 }) })}</span></>}</div>
                          : <div className="mt-1">{t("Uniformità non calcolabile per questa macchina.")}</div>}
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
                  onChange={(e) => setEt0Peak(Number(e.target.value))} className="field-input mt-1 w-full px-2" />{et0Hint()}</label>
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
            {renderFarmCrops()}
            <div className="mt-2.5 flex items-center justify-between gap-3 rounded-lg bg-panel px-3 py-2">
              <div className="text-xs text-sage-dark">{t("Piano irriguo consigliato")}</div>
              <div className="flex items-baseline gap-1">
                <b className="text-lg text-brand-darker tabular-nums leading-none">{fmt(mm24Suggested, { maximumFractionDigits: 1 })}</b>
                <span className="text-xs text-sage-dark">mm/24h</span>
              </div>
            </div>
            <div className="text-[11px] text-sage-dark mt-1">
              {t("Kc")} {fmt(kcMax, { maximumFractionDigits: 2 })} ({t(cropMax.label)}) · ET₀ {fmt(et0Peak, { maximumFractionDigits: 1 })} mm/g
              {rainMm > 0 ? ` · ${t("pioggia")} ${fmt(rainMm, { maximumFractionDigits: 1 })} mm` : ""}
              {" · "}{t("efficienza")} {fmt(effPct, { maximumFractionDigits: 0 })}%
            </div>
            {renderFieldCrops()}
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
            <div className="grid grid-cols-3 gap-2 mt-2" data-canal-design>
              <label className="text-xs text-sage-dark" title={t("Portata che il canale deve portare in moto uniforme. 0 = portata di progetto dell'impianto")}>{t("Portata (l/s, 0 = progetto)")}
                <input type="number" min={0} step={10} value={canalQ} onChange={(e) => setCanalQ(Math.max(0, Number(e.target.value) || 0))} className="field-input mt-1" /></label>
              <label className="text-xs text-sage-dark">{t("Rivestimento")}
                <select className="field-input mt-1" value={canalLin} onChange={(e) => setCanalLin(e.target.value as LiningId)}>
                  {LININGS.map((l) => <option key={l.id} value={l.id}>{t(l.label)} · n {l.n}</option>)}</select></label>
              <label className="text-xs text-sage-dark">{t("Franco minimo (m)")}
                <input type="number" min={0.1} max={2} step={0.05} value={canalFb} onChange={(e) => setCanalFb(Math.max(0.1, Number(e.target.value) || 0.3))} className="field-input mt-1" /></label>
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
                {canals.map((c, i) => { const k = CC.find((x) => x.idx === i); return (
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
                    {k?.sec && (
                      <div className="mt-1 pt-1 border-t border-black/5" data-canal-sec>
                        {t("Sezione")} ({fmt(k.q)} l/s, {t(lining(k.sec.lin).label).toLowerCase()}): {t("base")} <b>{fmt(k.sec.b, { maximumFractionDigits: 2 })} m</b> · {t("tirante")} <b>{fmt(k.sec.y, { maximumFractionDigits: 2 })} m</b> · {t("franco")} {fmt(k.sec.fb, { maximumFractionDigits: 2 })} m · {t("scarpe")} 1:{fmt(k.sec.m)} · {t("larghezza al ciglio")} <b>{fmt(k.sec.topW, { maximumFractionDigits: 2 })} m</b> · v <b className={k.sec.fast || k.sec.slow ? "text-danger" : ""}>{fmt(k.sec.v, { maximumFractionDigits: 2 })} m/s</b>
                        {k.ew && <><br />{t("Scavo")} <b>{fmt(Math.round(k.ew.cut))} m³</b>{k.ew.fill > 1 && <> · {t("rilevato degli argini")} <b>{fmt(Math.round(k.ew.fill))} m³</b></>} · {t("scavo massimo")} {fmt(k.ew.cutMax, { maximumFractionDigits: 1 })} m{["concr", "liner", "stone"].includes(k.sec.lin) && <> · {t("rivestimento")} {fmt(Math.round(k.ew.linedM2))} m²</>}</>}
                        {k.sec.slow && <><br /><span className="text-rust">{t("Velocità sotto 0,3 m/s: rischio di deposito e di erbe. Aumenta la pendenza o restringi la sezione.")}</span></>}
                        {k.sec.widened && <><br /><span className="text-sage-dark">{t("Base allargata per stare sotto la velocità massima del rivestimento ({v} m/s).", { v: fmt(lining(k.sec.lin).vmax) })}</span></>}
                        <label className="flex items-center gap-1.5 mt-1 cursor-pointer"><input type="checkbox" checked={!!c.exist} onChange={(e) => setCanals((cs) => cs.map((x, j) => (j === i ? { ...x, exist: e.target.checked || undefined } : x)))} />{t("Canale esistente (non entra nel computo)")}</label>
                      </div>
                    )}
                  </li>
                ); })}
              </ul>
            )}
            <div className="mt-3 border-t border-black/5 pt-2" data-drain>
              <label className="flex items-center gap-2 text-xs font-semibold text-brand-darker cursor-pointer">
                <input type="checkbox" checked={drainOn} onChange={(e) => setDrainOn(e.target.checked)} />{t("Fossi di scolo dei campi")}</label>
              {drainOn && (<>
                <div className="grid grid-cols-3 gap-2 mt-1">
                  <label className="text-[11px] text-sage-dark" title={t("Pioggia da smaltire in 24 ore: 12,96 mm/24h = 1,5 l/s per ettaro")}>{t("Coeff. (mm/24h)")}
                    <input type="number" min={1} max={100} step={0.5} value={drainC} onChange={(e) => setDrainC(Math.max(1, Number(e.target.value) || 12.96))} className="field-input mt-0.5 py-1 text-sm" /></label>
                  <label className="text-[11px] text-sage-dark">{t("Pendenza (‰)")}
                    <input type="number" min={0.1} max={50} step={0.5} value={drainS} onChange={(e) => setDrainS(Math.max(0.1, Number(e.target.value) || 2))} className="field-input mt-0.5 py-1 text-sm" /></label>
                  <label className="text-[11px] text-sage-dark">{t("Base (m)")}
                    <input type="number" min={0.2} max={5} step={0.1} value={drainB} onChange={(e) => setDrainB(Math.max(0.2, Number(e.target.value) || 0.5))} className="field-input mt-0.5 py-1 text-sm" /></label>
                </div>
                <button className="btn-ghost w-full text-[11px] mt-1" disabled={busy === "drainDem"} onClick={readDrainDem}
                  title={t("Quote del perimetro di ogni campo dal modello del terreno: sbocco nel punto più basso, pendenza dal terreno e sezione che cresce verso valle.")}>
                  {busy === "drainDem" ? t("Leggo le quote…") : Object.keys(drainProf).length ? t("⛰ Rileggi le quote del perimetro") : t("⛰ Leggi le quote del perimetro (DEM)")}</button>
                <ul className="mt-1 space-y-0.5 text-[11px] text-sage-dark">
                  {drainCalcs().map((d) => (
                    <li key={d.f.id}>{d.dem && <span className="block text-[10px]">{t("sbocco a quota {z} m (spartiacque {t2} m) · pendenza media {s}‰ · 2 rami in 3 tratti", { z: fmt(d.zOut ?? 0, { maximumFractionDigits: 1 }), t2: fmt(d.zTop ?? 0, { maximumFractionDigits: 1 }), s: fmt(d.sMean, { maximumFractionDigits: 1 }) })}</span>}<b className="text-brand-darker">F{d.n}</b> {d.f.name}: {fmt(d.ha, { maximumFractionDigits: 1 })} ha · <b>{fmt(Math.round(d.q))} l/s</b>{d.sec && <> · b {fmt(d.sec.b, { maximumFractionDigits: 2 })} m · y {fmt(d.sec.y, { maximumFractionDigits: 2 })} m · {t("ciglio")} {fmt(d.sec.topW, { maximumFractionDigits: 2 })} m · v {fmt(d.sec.v, { maximumFractionDigits: 2 })} m/s</>} · {fmt(Math.round(d.L))} m · {t("scavo")} <b>{fmt(Math.round(d.cut))} m³</b></li>
                  ))}
                </ul>
                <p className="text-[10px] text-sage-dark mt-0.5 leading-snug">{Object.keys(drainProf).length ? t("Con le quote: sbocco nel punto più basso del perimetro, portata che cresce verso valle e pendenza dal terreno (non meno di quella impostata). La sezione indicata è quella dello sbocco.") : t("Un fosso lungo tutto il perimetro di ogni campo con pivot, con la sezione dello sbocco (portata dell'intero campo). Lo sbocco va nel punto più basso del perimetro, verso il ricettore.")}</p>
              </>)}
            </div>
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
                  {(() => { const WH = waterHammer(); if (!WH) return null;
                    return (
                      <div className="mt-2 pt-2 border-t border-black/5" data-hammer>
                        <b>{t("Colpo d'ariete all'arresto delle pompe")}</b>
                        <table className="w-full tabular-nums mt-0.5">
                          <thead><tr className="text-left"><th className="font-normal">DN</th><th className="font-normal text-right">v m/s</th><th className="font-normal text-right">ΔH m</th><th className="font-normal text-right">{t("max")} m</th><th className="font-normal text-right">{t("min")} m</th><th className="font-normal text-right">PN</th></tr></thead>
                          <tbody>{WH.rows.map((r) => (
                            <tr key={r.dn} className={r.over || r.vac ? "text-danger" : ""}><td>{r.dn}</td><td className="text-right">{fmt(r.v, { maximumFractionDigits: 2 })}</td><td className="text-right">{fmt(Math.round(r.dH))}</td><td className="text-right">{fmt(Math.round(r.hMax))}</td><td className="text-right">{fmt(Math.round(r.hMin))}</td><td className="text-right">{r.pn}</td></tr>))}</tbody>
                        </table>
                        <p className="mt-0.5 leading-snug">{t("Celerità dell'onda {a} m/s (PE100 SDR17), prevalenza di esercizio {h} m. Valvole e saracinesche vanno chiuse in almeno {t2} s (2L/a sulla linea più lunga, {l} m).", { a: fmt(Math.round(WH.a)), h: fmt(Math.round(WH.Hop)), t2: fmt(Math.ceil(WH.tCrit)), l: fmt(Math.round(WH.Lmax)) })}
                          {WH.over && <> <span className="text-danger">{t("Con il PN10 la sovrappressione supera la classe del tubo: serve una protezione (cassa d'aria o valvola anticipatrice) oppure tubi della classe PN indicata.")}</span></>}
                          {WH.vac && <> <span className="text-danger">{t("Nella fase di depressione la pressione scende sotto −5 m: rischio di cavitazione e schiacciamento; servono cassa d'aria o valvole di aspirazione dell'aria nei punti alti.")}</span></>}
                          {!WH.over && !WH.vac && <> {t("Con le velocità di progetto i tubi PN10 reggono il colpo d'ariete; restano consigliati gli sfiati nei punti alti e l'avvio e l'arresto graduali delle pompe (inverter o avviatore).")}</>}</p>
                      </div>
                    ); })()}
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

          <section hidden={tab !== "solare"}>
            <SectionHead title={t("Pivot solari")} help={t("Pivot alimentati da pannelli fotovoltaici posati accanto al perno centrale: le torri e l'irrigatore finale vanno a energia solare e il pivot non ha la linea elettrica dalla stazione. Il campo FV si dimensiona sulla potenza del pivot; le batterie servono solo per lavorare senza sole.")} />
            {renderSolarPivots()}
          </section>
          <section hidden={tab !== "pompaggio"}>
            <SectionHead title={t("Stazione di pompaggio")} help={t("Dimensionamento consigliato della stazione di pompaggio in base alla potenza: numero e potenza delle pompe, scorte, potenza installata e consumo annuo di energia. Usa portate e fabbisogno della pagina Irrigazione, la prevalenza calcolata nella pagina Tubazioni e il clima del sito mese per mese.")} />
            {renderPumpStation()}
          </section>

          <section hidden={tab !== "irrigazione"}>
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Fabbisogno e portate")}</h3>
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2">{renderFarmCrops()}</div>
              <label className="text-[11px] text-sage-dark">{t("Tipo di suolo")}
                <select className="field-input mt-0.5 px-2 py-1.5 text-sm" value={soilKey}
                  onChange={(e) => { setSoilKey(e.target.value); infTouched.current = false; setInfiltration(soilOf(e.target.value).inf); }}>
                  {SOILS.map((so) => <option key={so.key} value={so.key}>{t(so.label)}</option>)}
                </select></label>
              <label className="text-[11px] text-sage-dark">{t("ET₀ di punta (mm/g)")}
                <input type="number" min={1} step={0.5} value={et0Peak}
                  onChange={(e) => setEt0Peak(Math.max(1, Number(e.target.value)))} className="field-input mt-0.5 px-2 py-1.5 text-sm" />{et0Hint()}</label>
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
            {renderFieldCrops()}

            <h3 className="text-sm font-semibold text-brand-darker mt-3 mb-2">{t("Assorbimento del terreno")}</h3>
            <div className="mb-2" data-soil>
              <button className="btn-ghost w-full text-[12px]" disabled={busy === "soil" || (!fields.length && !srcPt)} onClick={readSoil}
                title={t("Tessitura del suolo dei campi (SoilGrids, ISRIC, 250 m, 0-30 cm): classe USDA, acqua disponibile e assorbimento tipico.")}>
                {busy === "soil" ? t("Leggo il suolo…") : soilSat ? t("🛰 Rileggi il suolo dal satellite") : t("🛰 Leggi il suolo dal satellite (SoilGrids)")}</button>
              {soilSat && <p className="text-[11px] text-sage-dark mt-1 leading-snug">
                {t("Sabbia")} <b>{fmt(soilSat.sand, { maximumFractionDigits: 0 })}%</b> · {t("limo")} <b>{fmt(soilSat.silt, { maximumFractionDigits: 0 })}%</b> · {t("argilla")} <b>{fmt(soilSat.clay, { maximumFractionDigits: 0 })}%</b> · {soilSat.usda} (USDA) → <b>{t(soilOf(soilSat.key).label)}</b> · {t("acqua disponibile")} <b>{fmt(soilSat.taw_mm_m)} mm/m</b> · {t("sostanza organica")} {fmt(soilSat.soc_gkg * 1.72 / 10, { maximumFractionDigits: 1 })}% · {soilSat.n} {soilSat.n === 1 ? t("punto") : t("punti")}
              </p>}
            </div>
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
            {pivots.length > 0 && (() => {
              // verifica per pivot con lo sprinkler chart reale (una riga per macchina diversa)
              const seen = new Map<string, { names: string[]; r: ReturnType<typeof pivotRunoff>; pv: PivotItem }>();
              pivots.forEach((pv, k) => { const r = pivotRunoff(pv); if (!r) return; const key = `${Math.round(pv.r)}|${r.peak.toFixed(0)}|${r.W.toFixed(1)}`;
                const g = seen.get(key); if (g) g.names.push(`P${k + 1}`); else seen.set(key, { names: [`P${k + 1}`], r, pv }); });
              if (!seen.size) return null;
              return (
                <div className="mt-2 overflow-x-auto" data-runoff>
                  <div className="text-[11px] font-semibold text-sage-dark mb-0.5">{t("Ruscellamento pivot per pivot (irrigatori {m})", { m: [...seen.values()][0].r!.u.model })}</div>
                  <table className="w-full text-[10.5px] tabular-nums">
                    <thead><tr className="text-sage-dark text-left border-b border-black/10"><th className="font-medium">{t("Pivot")}</th><th className="font-medium text-right">{t("picco")} mm/h</th><th className="font-medium text-right">{t("bagnatura")} min</th><th className="font-medium text-right">{t("dose")} mm</th><th className="font-medium text-right">{t("dose max")} mm</th><th className="font-medium text-right">{t("giri/g min")}</th></tr></thead>
                    <tbody>{[...seen.values()].map(({ names, r }, i) => (
                      <tr key={i} className={r!.runoff > 0 ? "text-danger" : ""}>
                        <td className="py-0.5">{names.length > 4 ? `${names.slice(0, 4).join(", ")} …` : names.join(", ")}</td>
                        <td className={"text-right " + (r!.peak > infiltration ? "text-rust" : "")}>{fmt(r!.peak, { maximumFractionDigits: 0 })}</td>
                        <td className="text-right">{fmt(r!.tw * 60, { maximumFractionDigits: 1 })}</td>
                        <td className="text-right">{fmt(r!.dose, { maximumFractionDigits: 1 })}</td>
                        <td className="text-right">{Number.isFinite(r!.dMax) ? fmt(r!.dMax, { maximumFractionDigits: 1 }) : "∞"}</td>
                        <td className="text-right">{r!.need || "—"}</td>
                      </tr>))}</tbody>
                  </table>
                </div>
              );
            })()}

            <h3 className="text-sm font-semibold text-brand-darker mt-3 mb-2">{t("Controllo dal satellite (NDVI)")}</h3>
            <div className="text-[11px] text-sage-dark" data-ndvi>
              <button className="btn-ghost w-full text-[12px]" disabled={busy === "ndvi" || !pivots.length} onClick={readNdvi}
                title={t("Ultima scena Sentinel-2 poco nuvolosa degli ultimi 4 mesi: NDVI medio di ogni pivot, uniformità e anelli dal centro alla punta.")}>
                {busy === "ndvi" ? t("Leggo la scena Sentinel-2…") : ndvi ? t("🛰 Aggiorna l'NDVI dei pivot") : t("🛰 Leggi l'NDVI dei pivot (Sentinel-2)")}</button>
              {ndvi && (<>
                <p className="mt-1">{t("Scena del {d} · nuvolosità {c}% · {r} m/pixel", { d: ndvi.date, c: ndvi.cloud != null ? fmt(ndvi.cloud) : "—", r: fmt(ndvi.res_m) })}{ndvi.sig !== pivSig() && <span className="text-rust"> · {t("i pivot sono cambiati: aggiorna")}</span>}</p>
                <table className="w-full tabular-nums mt-0.5 text-[10.5px]">
                  <thead><tr className="text-left border-b border-black/10"><th className="font-medium">{t("Pivot")}</th><th className="font-medium text-right">NDVI</th><th className="font-medium text-right">CV %</th><th className="font-medium text-right">{t("deboli")} %</th><th className="font-medium pl-2">{t("centro → punta")}</th></tr></thead>
                  <tbody>{ndvi.pivots.map((p) => (
                    <tr key={p.i} className={p.ok && ((p.cv ?? 0) > 25 || (p.weak_pct ?? 0) > 15) ? "text-rust" : ""}>
                      <td>P{p.i + 1}</td>
                      {p.ok ? <><td className="text-right">{fmt(p.mean!, { maximumFractionDigits: 2 })}</td><td className="text-right">{fmt(p.cv!, { maximumFractionDigits: 0 })}</td><td className="text-right">{fmt(p.weak_pct!, { maximumFractionDigits: 0 })}</td>
                        <td className="pl-2"><span className="inline-flex gap-px align-middle">{(p.rings ?? []).map((v, j) => <i key={j} className="inline-block w-3 h-3 rounded-sm" title={v != null ? fmt(v, { maximumFractionDigits: 2 }) : "—"} style={{ background: v == null ? "#ddd" : `hsl(${Math.round(Math.max(0, Math.min(1, (v - 0.1) / 0.7)) * 120)},55%,45%)` }} />)}</span></td></>
                        : <td colSpan={4} className="text-right">{t("nuvole sul pivot ({p}% visibile)", { p: p.valid_pct })}</td>}
                    </tr>))}</tbody>
                </table>
                <p className="mt-0.5 leading-snug">{t("CV oltre il 25% o più del 15% di superficie debole indicano un pivot da controllare: punta più chiara = portata o pressione insufficienti in fondo; un anello chiaro = ugelli sbagliati in quella campata.")}</p>
              </>)}
            </div>

            <h3 className="text-sm font-semibold text-brand-darker mt-3 mb-2 flex items-center gap-2">
              <input type="checkbox" checked={fert.on} onChange={(e) => setFert({ ...fert, on: e.target.checked })} />{t("Fertirrigazione")}</h3>
            {fert.on && (() => {
              const FC = fertCalc();
              return (
                <div className="text-[11px] text-sage-dark" data-fert>
                  <div className="grid grid-cols-3 gap-2">
                    <label className="col-span-3">{t("Prodotto")}
                      <select className="field-input mt-0.5 py-1 text-sm" value={fert.k} onChange={(e) => { const f2 = FERTS.find((x) => x.k === e.target.value) ?? FERTS[0]; setFert({ ...fert, k: f2.k, n: f2.n, rho: f2.rho }); }}>
                        {FERTS.map((x) => <option key={x.k} value={x.k}>{t(x.label)}</option>)}</select></label>
                    <label>{t("N nel prodotto (%)")}<input type="number" min={1} max={46} step={1} value={fert.n} onChange={(e) => setFert({ ...fert, n: Math.max(1, Math.min(46, Number(e.target.value) || 32)) })} className="field-input mt-0.5 py-1 text-sm" /></label>
                    <label>{t("Densità (kg/l)")}<input type="number" min={0.8} max={1.6} step={0.01} value={fert.rho} onChange={(e) => setFert({ ...fert, rho: Math.max(0.8, Math.min(1.6, Number(e.target.value) || 1.3)) })} className="field-input mt-0.5 py-1 text-sm" /></label>
                    <label>{t("kg N/ha per intervento")}<input type="number" min={1} max={150} step={1} value={fert.dose} onChange={(e) => setFert({ ...fert, dose: Math.max(1, Math.min(150, Number(e.target.value) || 30)) })} className="field-input mt-0.5 py-1 text-sm" /></label>
                    <label>{t("Interventi per stagione")}<input type="number" min={1} max={30} step={1} value={fert.times} onChange={(e) => setFert({ ...fert, times: Math.max(1, Math.min(30, Number(e.target.value) || 6)) })} className="field-input mt-0.5 py-1 text-sm" /></label>
                  </div>
                  {FC && (<>
                    <table className="w-full tabular-nums mt-1 text-[10.5px]">
                      <thead><tr className="text-left border-b border-black/10"><th className="font-medium">{t("Pivot")}</th><th className="font-medium text-right">ha</th><th className="font-medium text-right">{t("prodotto")} l</th><th className="font-medium text-right">{t("giro")} h</th><th className="font-medium text-right">{t("pompa")} l/h</th><th className="font-medium text-right">N mg/l</th></tr></thead>
                      <tbody>{FC.rows.map((r, i) => (<tr key={i} className={r.ppm > 200 ? "text-rust" : ""}><td>{r.names.length > 3 ? `${r.names.slice(0, 3).join(", ")} …` : r.names.join(", ")}</td><td className="text-right">{fmt(r.ha, { maximumFractionDigits: 1 })}</td><td className="text-right">{fmt(Math.round(r.l))}</td><td className="text-right">{fmt(r.T, { maximumFractionDigits: 0 })}</td><td className="text-right">{fmt(r.lh, { maximumFractionDigits: 1 })}</td><td className="text-right">{fmt(Math.round(r.ppm))}</td></tr>))}</tbody>
                    </table>
                    <p className="mt-1 leading-snug">{t("Un intervento su tutti i pivot: {l} l di prodotto; serbatoio consigliato {v} l (+20%). Stagione: {s} l ({kg} t). Una pompa dosatrice per pivot, iniezione distribuita su un giro intero del mese di punta.", { l: fmt(Math.round(FC.lAll)), v: fmt(FC.tank), s: fmt(Math.round(FC.season)), kg: fmt(FC.kgSeason / 1000, { maximumFractionDigits: 1 }) })}
                      {FC.rows.some((r) => r.ppm > 200) && <> <span className="text-rust">{t("Sopra 200 mg/l di N l'acqua può bruciare le foglie: dividi la dose in più interventi.")}</span></>}</p>
                  </>)}
                </div>
              );
            })()}

            <h3 className="text-sm font-semibold text-brand-darker mt-3 mb-2">{t("Programma irriguo")}</h3>
            <div className="grid grid-cols-3 gap-2">
              <label className="text-[11px] text-sage-dark">{t("Radici (m)")}
                <input type="number" min={0.1} max={3} step={0.1} value={rootDepth} onChange={(e) => setRootDepth(Math.max(0.1, Math.min(3, Number(e.target.value) || 0.8)))} className="field-input mt-0.5 px-2 py-1.5 text-sm" /></label>
              <label className="text-[11px] text-sage-dark" title={t("Frazione dell'acqua disponibile che la coltura consuma senza stress (FAO-56: 0,5 per la maggior parte delle colture)")}>{t("Frazione p")}
                <input type="number" min={0.2} max={0.8} step={0.05} value={rawP} onChange={(e) => setRawP(Math.max(0.2, Math.min(0.8, Number(e.target.value) || 0.5)))} className="field-input mt-0.5 px-2 py-1.5 text-sm" /></label>
              <label className="text-[11px] text-sage-dark" title={t("Velocità dell'ultima torre con il timer al 100%")}>{t("Torre al 100% (m/min)")}
                <input type="number" min={0.5} max={6} step={0.1} value={v100} onChange={(e) => setV100(Math.max(0.5, Math.min(6, Number(e.target.value) || 2.3)))} className="field-input mt-0.5 px-2 py-1.5 text-sm" /></label>
            </div>
            {(() => {
              const IP = irrigProgram(); if (!IP) return null;
              const mon = (i: number) => new Date(2000, i, 1).toLocaleString(lang, { month: "short" });
              const on = IP.rows.filter((r) => r.G > 0);
              return (
                <div className="mt-2 text-[11px] text-sage-dark" data-program>
                  <p className="leading-snug">{t("Pivot P{n} ({r} m): giro al 100% del timer {h} h. Acqua facilmente disponibile {raw} mm ({taw} mm/m × {z} m × {p}); dose massima senza ruscellamento {d}.", { n: pivots.indexOf(IP.pv) + 1, r: fmt(Math.round(IP.pv.r)), h: fmt(IP.T100, { maximumFractionDigits: 1 }), raw: fmt(IP.RAW, { maximumFractionDigits: 0 }), taw: fmt(IP.taw), z: fmt(rootDepth), p: fmt(rawP), d: Number.isFinite(IP.dRun) ? `${fmt(IP.dRun, { maximumFractionDigits: 1 })} mm` : t("senza limite") })}</p>
                  <div className="overflow-x-auto mt-1">
                    <table className="w-full text-[10px] tabular-nums">
                      <thead><tr><th className="text-left font-normal"></th>{IP.rows.map((r) => <th key={r.m} className="font-normal">{mon(r.m)}</th>)}</tr></thead>
                      <tbody>
                        <tr><td className="pr-1">mm/{t("giorno")}</td>{IP.rows.map((r) => <td key={r.m} className="text-center">{r.G ? fmt(r.G, { maximumFractionDigits: 1 }) : "—"}</td>)}</tr>
                        <tr><td className="pr-1">{t("ore/giorno")}</td>{IP.rows.map((r) => <td key={r.m} className="text-center">{r.G ? fmt(r.h, { maximumFractionDigits: 0 }) : "—"}</td>)}</tr>
                        <tr><td className="pr-1">{t("dose")} mm</td>{IP.rows.map((r) => <td key={r.m} className="text-center font-semibold text-brand-darker">{r.G ? fmt(r.D, { maximumFractionDigits: 0 }) : "—"}</td>)}</tr>
                        <tr><td className="pr-1">{t("timer")} %</td>{IP.rows.map((r) => <td key={r.m} className="text-center">{r.G ? fmt(r.timer, { maximumFractionDigits: 0 }) : "—"}</td>)}</tr>
                        <tr><td className="pr-1">{t("giro")} h</td>{IP.rows.map((r) => <td key={r.m} className="text-center">{r.G ? fmt(r.T, { maximumFractionDigits: 0 }) : "—"}</td>)}</tr>
                        <tr><td className="pr-1">{t("giri/sett.")}</td>{IP.rows.map((r) => <td key={r.m} className="text-center">{r.G ? fmt(r.perWeek, { maximumFractionDigits: 1 }) : "—"}</td>)}</tr>
                      </tbody>
                    </table>
                  </div>
                  {on.length > 0 && <p className="mt-1 leading-snug">{IP.simul < pivots.length
                    ? t("Con {q} l/s disponibili lavorano insieme {s} pivot su {n}: si fanno turni, e nel mese di punta ogni pivot ha {h} h al giorno contro le {need} che servono.", { q: fmt(srcQmax), s: IP.simul, n: pivots.length, h: fmt((Math.min(24, srcHours) * IP.simul) / pivots.length, { maximumFractionDigits: 1 }), need: fmt(Math.max(...on.map((r) => r.h)), { maximumFractionDigits: 1 }) })
                    : t("La portata disponibile basta per far lavorare tutti i pivot insieme.")}</p>}
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
              <button className="btn-ghost flex-1 basis-0" disabled={!fields.length && !pivots.length} onClick={downloadDxf}
                title={t("Planimetria in DXF per AutoCAD: coordinate UTM in metri, un layer per campi, pivot, tubazioni, cavi, canali, fossi, strade, stazioni e campo FV.")}>{t("Planimetria DXF")}</button>
            </div>
            <button className="btn-ghost w-full mt-2" disabled={!pivots.length && !Object.values(sysDesigns).some((d) => d.sys === "lineari")} onClick={exportCeres}
              title={t("Campi e pivot con le campate del produttore scelto in Impianti, da aprire in Ceres con File › Apri file. Contiene anche il computo per Mercurius (riferimento del progetto e revisione crescente).")}>{busy === "ceres" ? t("Preparo…") : t("Esporta per Ceres (.ceres)")}</button>
            <button className="btn-primary w-full mt-3 flex items-center justify-center gap-2" disabled={busy === "all" || !pivots.length} onClick={downloadProgetto}
              title={t("Pacchetto ZIP: un PDF con relazione tecnica, elenco degli elaborati, tavole esecutive, particolari costruttivi, schede tecniche e computo metrico, più il computo in .xlsx, il file .ceres e la planimetria GeoJSON. Lingua, intestazione, formato e vista delle tavole come scelti qui sotto. Senza prezzi.")}>
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></svg>
              {busy === "all" ? t("Preparo…") : t("Progetto esecutivo completo (ZIP)")}</button>
            {prog ? (
              <div className="mt-1.5" role="progressbar" aria-valuemin={0} aria-valuemax={prog.n} aria-valuenow={prog.k + 1}>
                <div className="h-1.5 rounded-full bg-panel overflow-hidden"><div className="h-full rounded-full bg-sky-600 transition-all duration-500" style={{ width: `${((prog.k + 0.5) / prog.n) * 100}%` }} /></div>
                <div className="text-[11px] text-sage-dark text-center mt-1">{prog.k + 1}/{prog.n} · {prog.lab}</div>
              </div>
            ) : <div className="text-[11px] text-sage-dark text-center mt-1">{t("Relazione, tavole, particolari, schede tecniche e computo · .xlsx, .ceres, GeoJSON, DXF")}</div>}
            <div className="mt-2 flex gap-2 items-stretch">
              <button className="btn-ghost flex-1" disabled={busy === "rel" || (!pivots.length && !Object.keys(sysDesigns).length)} onClick={() => downloadRelazione()}
                title={t("Relazione tecnica generale per il cliente, nella lingua di stampa scelta sopra: copertina con la foto del sito, capitoli su sito, clima e fabbisogno, portata, fonte, impianto, rete, pompaggio ed energia. Senza prezzi.")}>
                {busy === "rel" ? t("Preparo…") : t("Relazione tecnica per il cliente (PDF)")}</button>
              <select className="field-input text-sm w-28" value={relBrand} onChange={(e) => setRelBrand(e.target.value as "agrostar" | "nabu")} title={t("Intestazione")}>
                <option value="agrostar">Agrostar</option><option value="nabu">Nabu</option>
              </select>
            </div>
            <div className="mt-2 flex gap-2 items-stretch">
            <button className="btn-ghost flex-1 flex items-center justify-center gap-2" disabled={busy === "tav" || (!pivots.length && !pivotLines.some((l) => l.kind === "pipe"))} onClick={() => downloadTavole()}
              title={t("Tavole di progetto come in Ceres: planimetria generale, tavola delle tubazioni (tratti, nodi, valvole, sezioni di scavo, profilo) e tavola delle linee elettriche (cavi, sezioni, schema unifilare), su ortofoto in scala. Senza prezzi.")}>
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="1.5" /><path d="M3 15h18M15 15v5M7 11l3-3 3 2 4-4" /></svg>
              {busy === "tav" ? t("Preparo…") : t("Tavole di progetto (PDF {f})", { f: pdfFormat.toUpperCase() })}</button>
              <select className="field-input text-sm w-36" value={tvCompact ? "1" : "0"} onChange={(e) => setTvCompact(e.target.value === "1")}
                title={t("Accorpata: tabelle, sezioni di scavo, profilo e schema unifilare uno dopo l'altro sulle stesse pagine. Separata: una pagina per ciascuno.")}>
                <option value="1">{t("Vista accorpata")}</option><option value="0">{t("Una per pagina")}</option>
              </select>
            </div>
            {renderOlympus()}
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
            {renderVariants()}
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
