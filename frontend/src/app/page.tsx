"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import JSZip from "jszip";
import type { MapHandle, PivotItem, PivotSel } from "@/components/MapCanvas";
import { useI18n, LANGS, type Lang } from "@/lib/i18n";
import { parseFieldsFromFile, parseLinesFromFile } from "@/lib/importGeo";
import * as api from "@/lib/api";
import type {
  Area, Client, Polygon, Project, Scene, ColorScale, SuitMeta, SuitWeights,
  LayoutMeta, LayoutConfig, Transport, PhaseOrder, LayoutParams, GeoJSONFC, MacroArea, Canal, GuidedResult, ProjectLayer, Watercourse, ElevationResult,
} from "@/lib/api";

// Revisione software: aggiornare a ogni versione consegnata.
const REV = "v0.6.109";

const MapCanvas = dynamic(() => import("@/components/MapCanvas"), { ssr: false });

const INDICES: { id: string; label: string }[] = [
  { id: "ndvi", label: "vegetazione" },
  { id: "ndmi", label: "umidità" },
  { id: "ndwi", label: "acqua" },
  { id: "ndre", label: "clorofilla" },
  { id: "msi", label: "stress idrico" },
  { id: "rgb", label: "Colore reale (RGB)" },
];

// Tipi di suolo → infiltrazione tipica (mm/h). L'utente può correggere il valore.
const SOILS: { key: string; label: string; inf: number }[] = [
  { key: "sabbioso", label: "Sabbioso", inf: 30 },
  { key: "franco_sabbioso", label: "Franco-sabbioso", inf: 20 },
  { key: "franco", label: "Franco", inf: 12 },
  { key: "franco_limoso", label: "Franco-limoso", inf: 8 },
  { key: "franco_argilloso", label: "Franco-argilloso", inf: 4 },
  { key: "argilloso", label: "Argilloso", inf: 2 },
];
const PIVOT_WET_W = 40;   // larghezza bagnata del pacchetto irriguo (m), assunzione

// Schede del pannello destro, in ordine progressivo del flusso di progetto.
// "Analisi" raggruppa satellite + idoneità + macro-aree in un'unica finestra.
const TABS: { key: string; label: string }[] = [
  { key: "analisi", label: "Analisi" },
  { key: "rilievo", label: "Rilievo" },
  { key: "impianti", label: "Impianti" },
  { key: "accessori", label: "Accessori" },
  { key: "export", label: "Esporta" },
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
type RoadL = { id: string; coords: number[][]; width_m: number; hidden?: boolean; owner?: number };

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
function pivotsFromFC(fc: any, defR: number): { pivots: PivotItem[]; lines: { kind: string; coords: number[][]; field?: number }[] } {
  const pivots: PivotItem[] = [];
  const lines: { kind: string; coords: number[][]; field?: number }[] = [];
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
      pivots.push({ lat, lng, r: Math.round(r), conn: f?.properties?.connection, field: f?.properties?.field });
    } else if (g?.type === "LineString") {
      lines.push({ kind: k, coords: g.coordinates, field: f?.properties?.field });
    }
  }
  return { pivots, lines };
}
// Ricostruisce il FeatureCollection dal modello (per salvataggio/esporto/statistiche).
function fcFromModel(pivots: PivotItem[], lines: { kind: string; coords: number[][]; field?: number }[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feats: any[] = pivots.map((pv) => ({
    type: "Feature",
    properties: { kind: "pivot", connection: pv.conn ?? "canal", phase: pv.conn === "pipe" ? 2 : 1, field: pv.field },
    geometry: { type: "Polygon", coordinates: [circleRing(pv.lat, pv.lng, pv.r)] },
  }));
  for (const ln of lines) {
    feats.push({ type: "Feature", properties: { kind: ln.kind, field: ln.field }, geometry: { type: "LineString", coordinates: ln.coords } });
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
function feederPipes(canal: number[][], pivs: { lat: number; lng: number }[], ring: number[][] | null, maxPerLine: number, flip: boolean): number[][][] {
  if (pivs.length < 1 || canal.length < 2) return [];
  const lat0 = pivs.reduce((s, p) => s + p.lat, 0) / pivs.length;
  const mLat = 111320, mLng = 111320 * Math.cos((lat0 * Math.PI) / 180) || 1e-9;
  const P: [number, number][] = pivs.map((p) => [p.lng * mLng, p.lat * mLat]);
  const C: [number, number][] = canal.map((c) => [c[0] * mLng, c[1] * mLat]);
  const R: [number, number][] | null = ring ? ring.map((c) => [c[0] * mLng, c[1] * mLat]) : null;
  const toLL = (x: number, y: number): number[] => [x / mLng, y / mLat];
  const cap = Math.max(1, Math.round(maxPerLine || 999));

  // passo tipico tra pivot (per separare le file)
  const nnd: number[] = [];
  for (let i = 0; i < P.length; i++) {
    let best = Infinity;
    for (let j = 0; j < P.length; j++) { if (i === j) continue; const d = (P[j][0] - P[i][0]) ** 2 + (P[j][1] - P[i][1]) ** 2; if (d < best) best = d; }
    if (best < Infinity) nnd.push(Math.sqrt(best));
  }
  const pitch = median(nnd) || 800;

  // Assi candidati del reticolo: il lato più lungo del campo (come l'auto-orient
  // del solutore) e la sua perpendicolare.
  let alpha = 0;
  if (R && R.length >= 2) { let bestLen = -1; for (let k = 0; k < R.length - 1; k++) { const dx = R[k + 1][0] - R[k][0], dy = R[k + 1][1] - R[k][1]; const L = dx * dx + dy * dy; if (L > bestLen) { bestLen = L; alpha = Math.atan2(dy, dx); } } }

  const dot = (a: [number, number], b: [number, number]) => a[0] * b[0] + a[1] * b[1];
  const clusterRows = (d: [number, number]): number[][] => {
    const n: [number, number] = [-d[1], d[0]];
    const order = P.map((_, i) => i).sort((a, b) => dot(P[a], n) - dot(P[b], n));
    const rows: number[][] = []; let cur: number[] = []; let prev = NaN;
    for (const i of order) { const pr = dot(P[i], n); if (cur.length && pr - prev > 0.5 * pitch) { rows.push(cur); cur = []; } cur.push(i); prev = pr; }
    if (cur.length) rows.push(cur);
    return rows;
  };
  // Residuo di "rettilineità": quanto i pivot di una fila si scostano dalla retta
  // fra i due estremi. L'asse giusto (file collineari) ha residuo minimo.
  const residual = (d: [number, number], rows: number[][]): number => {
    let tot = 0;
    for (const row of rows) {
      if (row.length < 3) continue;
      const s = row.slice().sort((a, b) => dot(P[a], d) - dot(P[b], d));
      const a = P[s[0]], b = P[s[s.length - 1]]; const ex = b[0] - a[0], ey = b[1] - a[1]; const el = Math.hypot(ex, ey) || 1;
      for (const i of row) tot += Math.abs(ex * (P[i][1] - a[1]) - ey * (P[i][0] - a[0])) / el;
    }
    return tot;
  };
  let ang = alpha, bestRes = Infinity;
  for (const a of [alpha, alpha + Math.PI / 2]) { const d: [number, number] = [Math.cos(a), Math.sin(a)]; const r = residual(d, clusterRows(d)); if (r < bestRes) { bestRes = r; ang = a; } }
  if (flip) ang += Math.PI / 2;
  const d: [number, number] = [Math.cos(ang), Math.sin(ang)];

  // Utility canale: punto più vicino, distanza, lato, e intersezione di una retta.
  const nearest = (pt: [number, number]): { q: [number, number]; dist: number; side: number } => {
    let bd = Infinity, bq: [number, number] = C[0], bk = 0;
    for (let k = 0; k < C.length - 1; k++) {
      const a = C[k], b = C[k + 1]; const abx = b[0] - a[0], aby = b[1] - a[1]; const l2 = abx * abx + aby * aby || 1e-9;
      const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * abx + (pt[1] - a[1]) * aby) / l2));
      const qx = a[0] + abx * t, qy = a[1] + aby * t; const dd = (pt[0] - qx) ** 2 + (pt[1] - qy) ** 2;
      if (dd < bd) { bd = dd; bq = [qx, qy]; bk = k; }
    }
    const a = C[bk], b = C[bk + 1]; const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const cross = ((b[0] - a[0]) / tl) * (pt[1] - bq[1]) - ((b[1] - a[1]) / tl) * (pt[0] - bq[0]);
    return { q: bq, dist: Math.sqrt(bd), side: cross >= 0 ? 1 : -1 };
  };
  // Intersezione della retta (A + t·d) col canale, punto più vicino ad A: mantiene
  // la tubazione PERFETTAMENTE dritta fino al canale.
  const lineHitCanal = (A: [number, number]): [number, number] | null => {
    let best: [number, number] | null = null, bestAbsT = Infinity;
    for (let k = 0; k < C.length - 1; k++) {
      const s0 = C[k], s1 = C[k + 1]; const ex = s1[0] - s0[0], ey = s1[1] - s0[1];
      const den = d[1] * ex - d[0] * ey; if (Math.abs(den) < 1e-9) continue;
      const bx = s0[0] - A[0], by = s0[1] - A[1];
      const t = (by * ex - bx * ey) / den; const u = (d[0] * by - d[1] * bx) / den;
      if (u < -0.02 || u > 1.02) continue;
      if (Math.abs(t) < bestAbsT) { bestAbsT = Math.abs(t); best = [A[0] + d[0] * t, A[1] + d[1] * t]; }
    }
    return best;
  };

  const rows = clusterRows(d);
  const pipes: number[][][] = [];
  for (const row of rows) {
    const sorted = row.slice().sort((a, b) => dot(P[a], d) - dot(P[b], d));
    // spezza in tratte dello stesso LATO del canale (niente scavalcamenti)
    const runs: number[][] = []; let cur: number[] = []; let curSide = 0;
    for (const i of sorted) { const sd = nearest(P[i]).side; if (cur.length && sd !== curSide) { runs.push(cur); cur = []; } cur.push(i); curSide = sd; }
    if (cur.length) runs.push(cur);
    for (const run of runs) {
      for (let c = 0; c < run.length; c += cap) {
        const chunk = run.slice(c, c + cap);
        const first = P[chunk[0]], last = P[chunk[chunk.length - 1]];
        const seq = nearest(last).dist < nearest(first).dist ? chunk.slice().reverse() : chunk;   // dal canale verso l'esterno
        const nearP = P[seq[0]];
        const tap = lineHitCanal(nearP) ?? nearest(nearP).q;
        const pts: [number, number][] = [tap, ...seq.map((i) => P[i])];
        pipes.push(pts.map(([x, y]) => toLL(x, y)));
      }
    }
  }
  return pipes;
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
const IcoElevation = () => (<svg {...svgProps}><path d="M3 20h18" /><path d="m3 17 5-7 3 3.5L16 5l5 12" /></svg>);
const IcoMinimize = () => (<svg {...svgProps}><path d="M5 12h14" /></svg>);
const IcoExpand = () => (<svg {...svgProps}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 12h6M12 9v6" /></svg>);
const IcoCross = () => (<svg {...svgProps}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>);

// Icone del menu verticale (20px): una per ogni pagina del flusso di progetto.
const navProps = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const IcoNavAnalisi = () => (<svg {...navProps}><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>);
const IcoNavRilievo = () => (<svg {...navProps}><path d="m3 20 6-9 4 5 3-4 5 8z" /></svg>);
const IcoNavImpianti = () => (<svg {...navProps}><circle cx="12" cy="12" r="8" /><path d="M12 12h8" /><circle cx="12" cy="12" r="1.6" /></svg>);
const IcoNavAccessori = () => (<svg {...navProps}><path d="M4 7h16M4 12h16M4 17h16" /><circle cx="9" cy="7" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="8" cy="17" r="2" /></svg>);
const IcoNavExport = () => (<svg {...navProps}><path d="M12 3v11" /><path d="m7 10 5 5 5-5" /><path d="M4 20h16" /></svg>);
const TAB_ICONS = {
  analisi: IcoNavAnalisi, rilievo: IcoNavRilievo, impianti: IcoNavImpianti,
  accessori: IcoNavAccessori, export: IcoNavExport,
};

// Intestazione di sezione con testo-guida apribile/chiudibile da "?"
// (compatta la vista: i suggerimenti restano nascosti finché non servono).
function SectionHead({ title, help, mb = "mb-2" }: { title: string; help?: string; mb?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={mb}>
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-semibold text-brand-darker">{title}</h3>
        {help && (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-label="Aiuto"
            className={"inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold leading-none transition "
              + (open ? "bg-brand text-white" : "bg-sage/20 text-sage-dark hover:bg-brand hover:text-white")}>?</button>
        )}
      </div>
      {help && open && <p className="hint mt-1">{help}</p>}
    </div>
  );
}

// Colore del widget crediti in base alla % usata: verde <50%, arancio <80%, rosso.
function creditColor(u: api.Usage): string {
  if (u.requests_limit == null || u.requests_limit === 0) return "#123524";
  const pct = u.pct_used ?? (100 * u.requests_used / u.requests_limit);
  return pct >= 80 ? "#b23b1e" : pct >= 50 ? "#c07a1e" : "#123524";
}

export default function Page() {
  const { t, lang, setLang, fmt, fmtDate } = useI18n();
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
  const [elevOn, setElevOn] = useState(false);
  const [elevData, setElevData] = useState<ElevationResult | null>(null);
  const [leftMin, setLeftMin] = useState(false);    // pannello Progetto ridotto a icona
  const [rightMin, setRightMin] = useState(false);  // pannello schede ridotto a icona
  const [propsOpen, setPropsOpen] = useState(true);   // widget Proprietà docked in basso a sinistra (toggle con «i»)
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;
  // NB: la cronologia Annulla/Ripristina è definita più sotto, dopo gli stati
  // pivot/strade che ora fanno parte dello snapshot.
  function toggleMeasure() {
    if (measuring) { setMeasuring(false); setMeasureTxt(""); mapApi.current?.stopMeasure(); setMsg(""); return; }
    if (elevOn) { setElevOn(false); setElevData(null); mapApi.current?.stopElevation(); }
    setMeasuring(true); setMsg(t("Misura: clicca i punti sulla mappa. 2 punti = distanza, 3+ = area."));
    mapApi.current?.startMeasure((txt) => setMeasureTxt(txt));
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
  const [designMode, setDesignMode] = useState<"standard" | "advanced">("standard"); // Systems: standard | avanzata (ottimizza raggio)
  const [advMinR, setAdvMinR] = useState(250);           // avanzata: raggio minimo del range (m)
  const [advMaxR, setAdvMaxR] = useState(450);           // avanzata: raggio massimo del range (m)
  const [pipeCanalIdx, setPipeCanalIdx] = useState(0);   // Accessori: canale da cui si diramano le tubazioni
  const [pipeMaxPerLine, setPipeMaxPerLine] = useState(8); // max pivot collegati sulla stessa tubazione
  const [pipeFlip, setPipeFlip] = useState(false);       // ruota di 90° la direzione delle file
  // Gerarchia pivot: modello modificabile (gruppo → singolo) derivato dal risultato.
  const [pivots, setPivots] = useState<PivotItem[]>([]);
  const [pivotLines, setPivotLines] = useState<{ kind: string; coords: number[][]; field?: number }[]>([]);
  const [dragOverField, setDragOverField] = useState<number | "root" | null>(null);   // evidenzia il bersaglio del trascinamento
  const [hiddenPivotFields, setHiddenPivotFields] = useState<Set<number>>(new Set()); // gruppi pivot (per campo) nascosti
  const [hiddenPipeFields, setHiddenPipeFields] = useState<Set<number>>(new Set());   // gruppi tubazioni (per campo) nascosti
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
  }
  function redo() {
    const h = hist.current; if (!h.fut.length || !prevSnap.current) return;
    h.past.push(prevSnap.current);
    applySnap(h.fut.pop()!);
    setCanUndo(true); setCanRedo(h.fut.length > 0);
  }

  const [excludeWater, setExcludeWater] = useState(true);  // niente pivot su acqua/paludi (NDWI)
  const [soilKey, setSoilKey] = useState("franco");
  const [infiltration, setInfiltration] = useState(12);   // mm/h
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
  const secShow = (k: string) => (tab === k ? "" : "hidden");
  // Menu verticale: clic su una voce apre la sua finestra; ri-clic sulla voce
  // attiva la chiude (mappa libera). Usato anche dai salti automatici di pagina.
  function goTab(k: string) { setTab(k); setRightMin(false); }
  function toggleTab(k: string) {
    if (tab === k && !rightMin) { setRightMin(true); return; }
    goTab(k);
  }

  const [notes, setNotes] = useState("");
  const [shares, setShares] = useState<api.ShareView[]>([]);   // link di sola lettura del progetto
  const [shareName, setShareName] = useState("");              // nome del prossimo link da creare
  const [autosave, setAutosave] = useState<"" | "saving" | "saved" | "error">("");   // stato salvataggio automatico
  const [drawing, setDrawing] = useState(false);   // disegno/tracciatura in corso → pannellino di controllo
  const [elevStats, setElevStats] = useState<{ id: number; loading?: boolean; err?: boolean; s?: api.ElevationStats } | null>(null);  // quota del campo attivo
  const [elevNonce, setElevNonce] = useState(0);   // forza il ricalcolo quota quando la geometria del campo cambia
  const elevCache = useRef<Map<number, api.ElevationStats>>(new Map());
  const [busy, setBusy] = useState<string>("");
  const [msg, setMsg] = useState<string>("");
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
    if (projectId) { openProject(projectId); refreshShares(projectId); }
    else { setAreas([]); setLayers([]); setShares([]); }
  }, [projectId]);

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
  function showErr(e: unknown) { setMsg(e instanceof Error ? e.message : String(e)); refreshUsage(); }

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
  function removePivotsOfField(fid: number) {
    const mp = pivots.filter((p) => p.field !== fid);
    const ml = pivotLines.filter((l) => l.field !== fid);
    setPivots(mp); setPivotLines(ml); setPivotSel({ mode: "none", idx: -1 });
    setGuided(mp.length ? { geojson: fcFromModel(mp, ml), meta: { n_pivots: mp.length, radius_m: pivotR, net_ha: Math.round(mp.reduce((s, x) => s + Math.PI * x.r * x.r / 10000, 0) * 10) / 10, safety_m: safetyM } } : null);
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
  async function saveAll(silent = false): Promise<boolean> {
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
      const [oldAreas, oldLayers] = await Promise.all([api.listAreas(pid), api.listLayers(pid)]);

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
        newLayerIds.push((await api.createLayer({ project_id: pid, kind: "pivots", name: t("Pivot"), data: { geojson: fcFromModel(mp, ml), meta: guided?.meta ?? { n_pivots: pivots.length } } })).id);
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
      for (const l of oldLayers) if (rewritten.has(l.kind)) { try { await api.deleteLayer(l.id); } catch { /* ignora */ } }
      const byId = new Map(oldAreas.map((a) => [a.id, a] as const));
      const depth = (a: typeof oldAreas[number]) => { let d = 0; let cur: typeof oldAreas[number] | undefined = a; while (cur?.parent_area_id != null && d < 30) { d++; cur = byId.get(cur.parent_area_id); } return d; };
      for (const a of [...oldAreas].sort((x, y) => depth(y) - depth(x))) { try { await api.deleteArea(a.id); } catch { /* ignora */ } }

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
      const netHa = next.reduce((s, p) => s + (Math.PI * p.r * p.r) / 10000, 0);
      return { ...prev, geojson, meta: { ...prev.meta, n_pivots: next.length, n_canal_conn: nCanal, n_pipe_conn: nPipe, net_ha: Math.round(netHa * 10) / 10 } };
    });
  }
  // Ridisegna i pivot sulla mappa a ogni cambio di modello/selezione.
  useEffect(() => {
    const api2 = mapApi.current; if (!api2) return;
    // Filtra i gruppi pivot nascosti (per campo) e rimappa gli indici visibili → reali.
    const visIdx = pivots.map((_, k) => k).filter((k) => !hiddenPivotFields.has(pivots[k].field ?? -1));
    const visP = visIdx.map((k) => pivots[k]);
    // Le tubazioni hanno una visibilità propria (oggetto a sé); le altre linee
    // seguono la visibilità del gruppo pivot del loro campo.
    const visL = pivotLines.filter((l) => l.kind === "pipe"
      ? !hiddenPipeFields.has(l.field ?? -1)
      : !hiddenPivotFields.has(l.field ?? -1));
    if (!visP.length && !visL.length) { api2.clearPivots?.(); return; }
    let selForShow = pivotSel;
    if (pivotSel.mode === "single") { const vpos = visIdx.indexOf(pivotSel.idx); selForShow = vpos >= 0 ? { mode: "single", idx: vpos } : { mode: "none", idx: -1 }; }
    api2.showPivots?.({ pivots: visP, lines: visL }, selForShow, {
      onClick: (i) => { const real = visIdx[i]; setPivotSel((s) => (s.mode === "none" ? { mode: "group", idx: -1 } : { mode: "single", idx: real })); },
      onMove: (i, lat, lng) => { const real = visIdx[i]; commitPivots(pivots.map((p, k) => (k === real ? { ...p, lat, lng } : p))); },
      onBackground: () => setPivotSel({ mode: "none", idx: -1 }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pivots, pivotLines, pivotSel, hiddenPivotFields, hiddenPipeFields]);

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
    mapApi.current?.showRoads?.(vis.map((r) => ({ coords: r.coords, width_m: r.width_m })), (i) => { const id = vis[i]?.id; if (id != null) setRoads((rs) => rs.filter((r) => r.id !== id)); });
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
      ...roads.map((r) => ({ geojson: { type: "LineString", coordinates: r.coords }, width_m: r.width_m, clear_m: pivClearRoad })),
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
    const netHa = mergedP.reduce((s, x) => s + (Math.PI * x.r * x.r) / 10000, 0);
    setGuided({ geojson: fcFromModel(mergedP, mergedL), meta: { n_pivots: mergedP.length, radius_m: radiusM, net_ha: Math.round(netHa * 10) / 10, safety_m: safetyM } });
    refreshUsage();
  }
  // STANDARD: raggio scelto dall'utente (+ eventuale % di pivot marginali).
  async function insertImpiantiActive() {
    if (!active) return needField();
    const fid = active.id;
    setBusy("layout"); setMsg("");
    try {
      const p: LayoutParams = { ...paramsFrom(effSettings(active)), radius_m: pivotR, gap_m: safetyM, roads: obstacleLines(), clear_road_m: pivClearRoad, min_pivot_pct: minPivotPct };
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
        const area = np.reduce((s, x) => s + (Math.PI * x.r * x.r) / 10000, 0);
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
    const ring = active.geom?.coordinates?.[0] ?? null;
    const pipesLL = feederPipes(canal.geojson.coordinates, fieldPivs.map((p) => ({ lat: p.lat, lng: p.lng })), ring, pipeMaxPerLine, pipeFlip);
    if (!pipesLL.length) { setMsg(t("Nessuna tubazione tracciabile con questi pivot.")); return; }
    const newL = pipesLL.map((coords) => ({ kind: "pipe", coords, field: fid }));
    const mergedL = [...pivotLines.filter((l) => !(l.kind === "pipe" && l.field === fid)), ...newL];
    setPivotLines(mergedL);
    if (guided) setGuided({ ...guided, geojson: fcFromModel(pivots, mergedL) });
    setMsg(t("Tubazioni tracciate: {n} rami dal canale ✓", { n: pipesLL.length }));
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

        <label className="text-xs text-sage-dark mt-2 block">{t("Orientamento reticolo")}</label>
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
  async function downloadPdf() {
    if (!fields.length) return needField();
    setBusy("pdf"); setMsg("");
    try {
      const pname = projects.find((p) => p.id === projectId)?.name || "Progetto";
      const cname = clients.find((c) => c.id === clientId)?.name;
      if (fields.length === 1) {
        const f = fields[0];
        const blob = await api.downloadReport(f.geom, paramsFrom(effSettings(f)),
          { project_name: pname, client_name: cname, notes, include_suitability: true, lang });
        saveBlob(blob, `scheda_${safe(pname)}.pdf`);
      } else {
        const zip = new JSZip();
        for (let i = 0; i < fields.length; i++) {
          const f = fields[i];
          setMsg(t("Genero campo {i}/{n}…", { i: i + 1, n: fields.length }));
          const blob = await api.downloadReport(f.geom, paramsFrom(effSettings(f)),
            { project_name: `${pname} — ${f.name}`, client_name: cname, notes, include_suitability: true, lang });
          zip.file(`scheda_${safe(f.name)}.pdf`, blob);
        }
        const zblob = await zip.generateAsync({ type: "blob" });
        saveBlob(zblob, `schede_${safe(pname)}.zip`);
        setMsg("");
      }
    } catch (e) { showErr(e); } finally { setBusy(""); }
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
      const sv = await api.createShareView(pid, name, { hiddenFields, hiddenPivots, hiddenPipes });
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
        pivots.map((p) => [Math.round(p.lat * 1e6), Math.round(p.lng * 1e6), p.r, p.field ?? 0, p.conn ?? ""]),
        pivotLines.map((l) => [l.kind, l.field ?? 0, l.coords.length]),
        [...hiddenPivotFields].sort((a, b) => a - b),
        [...hiddenPipeFields].sort((a, b) => a - b),
      ]);
    } catch { return ""; }
  }, [fields, canals, roads, watercourses, pivots, pivotLines, hiddenPivotFields, hiddenPipeFields]);
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
        <button className="flex-1 truncate text-left" title={t("Zoom · trascina su un campo per assegnarlo")} onClick={onZoom}>{label}</button>
        <button className="text-danger w-4" title={t("Rimuovi")} onClick={onRemove}>✕</button>
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

  // Riga dell'elenco Campi come albero: un campo con, annidati, i suoi
  // poligoni figli (famiglia) e le eventuali sotto-aree (macro).
  function renderFieldNode(f: Field, depth: number) {
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
            <span className="text-sage"> · {uHa(ringAreaHa(f.geom.coordinates))}</span>
            {f.level === "campo" && f.score != null && <span className="text-brand-light"> · {t("Idoneità")} {fmt(f.score)}</span>}
            {!!kids.length && <span className="text-brand-light"> · {kids.length} {t("figli")}</span>}
            {!!f.macros?.length && <span className="text-brand-light"> · {f.macros.length} {t("sotto-aree")}</span>}
            {ownedPivN > 0 && <span className="text-brand-light"> · {ownedPivN} pivot</span>}
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
            {ownedRoads.map(({ r, i }) => objRow("road", r.id, `r${r.id}`, !!r.hidden, () => toggleRoadHidden(i), <>{t("Strada")} {i + 1} · {uM(r.width_m)}</>, () => zoomToCoords(r.coords), () => removeRoad(i)))}
            {ownedWater.map(({ w, i }) => { const coords = w.geojson.type === "Polygon" ? w.geojson.coordinates[0] : w.geojson.coordinates; return objRow("water", i, `w${i}`, !!w.hidden, () => toggleWaterHidden(i), <>{w.kind} {i + 1}</>, () => zoomToCoords(coords), () => removeWater(i)); })}
            {ownedPivN > 0 && objRow("pivot", f.id, `pv${f.id}`, hiddenPivotFields.has(f.id), () => togglePivotFieldHidden(f.id), <>{t("Pivot")} · {ownedPivN}</>, () => zoomToCoords(f.geom.coordinates[0]), () => removePivotsOfField(f.id))}
            {ownedPipeN > 0 && objRow("pipe", f.id, `pi${f.id}`, hiddenPipeFields.has(f.id), () => togglePipeFieldHidden(f.id), <>{t("Tubazioni")} · {ownedPipeN}</>, () => zoomToPipesOfField(f.id), () => removePipesOfField(f.id))}
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
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[500] widget px-2 py-1.5 flex items-center gap-2 pointer-events-auto">
          <span className="text-[11px] text-sage-dark px-1 hidden sm:inline">{t("Disegno in corso — aggancia ai bordi/vertici")}</span>
          <button className="btn-ghost" title={t("Annulla ultimo punto")} onClick={() => mapApi.current?.drawUndo()}>↶ {t("Ultimo punto")}</button>
          <button className="btn-primary" title={t("Concludi il tracciato")} onClick={() => mapApi.current?.drawFinish()}>{t("Fine")}</button>
          <button className="btn-ghost text-danger" title={t("Esci dalla modalità disegno")} onClick={() => mapApi.current?.drawCancel()}>✕ {t("Chiudi")}</button>
        </div>
      )}

      <div className="overlay-layer">
        {/* Header stile Argus Smart: pillole flottanti (verde scuro / bianco) */}
        <div className="absolute top-3 left-3 right-3 z-30 flex items-center gap-2"
          style={{ fontFamily: '"IBM Plex Sans", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' }}>
          {/* Marchio */}
          <div className="flex items-center gap-2 px-3 rounded-xl shadow" style={{ background: "#123524", height: 44 }}>
            <div className="bg-white rounded-full p-1 flex items-center justify-center shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/argusmark.png" alt="Argus" className="h-6 w-6" />
            </div>
            <div className="leading-tight pr-1">
              <div className="font-semibold text-white text-[15px]">Argus Total</div>
              <div className="text-[9px] tracking-[0.22em]" style={{ color: "#b9d3c0" }}>NABU</div>
            </div>
          </div>

          {/* Strumenti (pillola bianca): annulla/ripristina · livelli · misura */}
          <div className="relative">
            <div className="flex items-center gap-1 px-1.5 rounded-xl shadow" style={{ background: "#fbfdfb", height: 44 }}>
              <button title={t("Annulla")} disabled={!canUndo} onClick={undo}
                className="p-1.5 rounded-[9px] text-brand-darker disabled:opacity-30 hover:bg-black/5"><IcoUndo /></button>
              <button title={t("Ripristina")} disabled={!canRedo} onClick={redo}
                className="p-1.5 rounded-[9px] text-brand-darker disabled:opacity-30 hover:bg-black/5"><IcoRedo /></button>
              <span className="w-px h-5 bg-black/10" />
              <button title={t("Misura distanze/aree")} onClick={toggleMeasure}
                className={"p-1.5 rounded-[9px] " + (measuring ? "text-white" : "text-brand-darker hover:bg-black/5")}
                style={measuring ? { background: "#3f8e4e" } : undefined}><IcoRuler /></button>
              <button title={t("Profilo altimetrico / dislivelli (polilinea)")} onClick={toggleElevation}
                className={"p-1.5 rounded-[9px] " + (elevOn ? "text-white" : "text-brand-darker hover:bg-black/5")}
                style={elevOn ? { background: "#b23b1e" } : undefined}><IcoElevation /></button>
              <span className="w-px h-5 bg-black/10" />
              <button title={t("Proprietà (livello / oggetto selezionato)")} onClick={() => setPropsOpen((o) => !o)}
                className={"p-1.5 rounded-[9px] font-semibold italic w-7 " + (propsOpen ? "bg-brand/10 text-brand" : "text-brand-darker hover:bg-black/5")}>i</button>
            </div>
          </div>
          {measuring && measureTxt && (
            <div className="px-3 rounded-xl text-sm text-white flex items-center shadow" style={{ background: "#123524", height: 44 }}>{measureTxt}</div>
          )}
          {elevOn && (
            <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 z-40 px-3 py-1.5 rounded-xl text-xs text-white shadow w-[280px]" style={{ background: "#123524" }}>
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

          <div className="flex-1" />

          {/* Ricerca (pillola bianca) */}
          <form onSubmit={geocode} className="flex items-center gap-1.5 px-1.5 rounded-xl shadow" style={{ background: "#fbfdfb", height: 44 }}>
            <button type="button" title={t("Usa la mia posizione (GPS)")} onClick={() => mapApi.current?.locate()}
              className="text-white rounded-[9px] p-1.5 flex items-center justify-center shrink-0" style={{ background: "#3f8e4e" }}><IcoCross /></button>
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={t("Indirizzo o coordinate GPS")}
              className="bg-transparent outline-none text-sm w-48" />
            <button type="submit" className="text-white text-[13px] font-semibold rounded-[9px] px-3.5 py-2 shrink-0" style={{ background: "#3f8e4e" }}>{t("Cerca")}</button>
          </form>

          {/* Metrico / Imperiale (pillola verde scuro) */}
          <div className="flex items-center gap-0.5 px-1 rounded-xl text-[13px] shadow" style={{ background: "#123524", height: 44 }}>
            <button onClick={() => setUnits("metric")}
              className="px-3 py-1.5 rounded-[9px] font-medium" style={!imperial ? { background: "#3f8e4e", color: "#fff" } : { color: "#b9d3c0" }}>{t("Metrico")}</button>
            <button onClick={() => setUnits("imperial")}
              className="px-3 py-1.5 rounded-[9px] font-medium" style={imperial ? { background: "#3f8e4e", color: "#fff" } : { color: "#b9d3c0" }}>{t("Imperiale")}</button>
          </div>

          {/* Lingua (pillola verde scuro) */}
          <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}
            className="rounded-xl px-3 text-[13px] outline-none border-none text-white shadow" style={{ background: "#123524", height: 44 }}>
            {LANGS.map((l) => <option key={l.code} value={l.code} className="text-black">{l.label}</option>)}
          </select>

          {/* Widget crediti: member → i propri; admin → totale organizzazione */}
          {usage && (
            <div className="rounded-xl px-3 text-[13px] text-white shadow flex flex-col justify-center leading-none" style={{ background: creditColor(usage), height: 44 }} title={t("Crediti")}>
              <span className="text-[9px] uppercase tracking-wide opacity-90">{usage.scope === "user" ? t("I tuoi crediti") : t("Totale")}</span>
              <b className="tabular-nums text-[13px]">{usage.requests_used}{usage.requests_limit != null ? ` / ${usage.requests_limit}` : ""}</b>
            </div>
          )}

          {/* Gestione utenti (solo admin) */}
          {me?.is_admin && (
            <button onClick={openUsers} title={t("Gestione utenti")}
              className="rounded-xl px-3 text-[18px] text-white shadow flex items-center" style={{ background: "#123524", height: 44 }}>👥</button>
          )}

          {/* Esci */}
          {me && (
            <button onClick={logout} title={t("Esci")}
              className="rounded-xl px-3 text-[13px] font-medium text-white shadow" style={{ background: "#123524", height: 44 }}>{t("Esci")}</button>
          )}
        </div>

        {/* Colonna sinistra: pannello Progetto + widget Proprietà (impilati) */}
        <div className="absolute top-[4.5rem] left-4 bottom-[6.5rem] w-[440px] max-w-[calc(100vw_-_2rem)] flex flex-col gap-3 z-30 pointer-events-none">
        {leftMin ? (
          <button onClick={() => setLeftMin(false)} title={t("Espandi il pannello Progetto")}
            className="pointer-events-auto self-start widget px-3 py-2 flex items-center gap-2 text-sm text-brand-darker hover:bg-black/5">
            <IcoExpand /> {t("Progetto")}
          </button>
        ) : (
        <div className="pointer-events-auto w-full max-h-[52vh] shrink-0 widget flex flex-col overflow-hidden">
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
                    {rItems.map(({ r, i }) => objRow("road", r.id, `r${r.id}`, !!r.hidden, () => toggleRoadHidden(i), <>{t("Strada")} {i + 1} · {uM(r.width_m)}</>, () => zoomToCoords(r.coords), () => removeRoad(i)))}
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
                  <div className="text-[11px] text-sage-dark mt-1">{t("Area")}: <b>{uHa(Math.PI * selPivot.r * selPivot.r / 10000, 1)}</b></div>
                  <button className="btn-ghost w-full text-danger mt-2" onClick={deleteSelPivot}>{t("Elimina pivot")}</button>
                </div>
              ) : pivots.length && pivotSel.mode === "group" ? (
                <div>
                  <b className="text-brand-darker text-sm">{t("Gruppo pivot")} · {pivots.length}</b>
                  <p className="text-[11px] text-sage-dark mt-1">{t("Sulla mappa: 2° clic su un pivot per modificarlo singolarmente.")}</p>
                  <button className="btn-ghost w-full mt-2" onClick={applyRadiusToAll}>{t("Applica raggio {r} m a tutti", { r: pivotR })}</button>
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
        {!rightMin && (
        <div className="absolute top-[4.5rem] right-[7rem] w-[440px] max-w-[calc(100vw_-_9rem)] max-h-[78vh] widget flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 pt-2 shrink-0">
            <span className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide">{t(TABS.find((x) => x.key === tab)?.label ?? "Strumenti")}</span>
            <button onClick={() => setRightMin(true)} title={t("Chiudi")}
              className="text-sage-dark hover:text-brand p-1 rounded hover:bg-black/5"><IcoMinimize /></button>
          </div>
          <div className="overflow-auto scroll-soft p-4 pt-2 space-y-4">
          {!sameRules && active && (
            <div className="text-[11px] text-brand-mid bg-brand/10 rounded-lg px-2 py-1">
              {t("Stai modificando: {name}", { name: active.name })}
            </div>
          )}

          <section className={secShow("analisi")}>
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

          <section className={secShow("analisi") + " border-t border-black/5 pt-3"}>
            <SectionHead title={t("Quota (DEM)")} help={t("Il rilievo ombreggiato mostra i sensi delle pendenze; le isoipse ravvicinate = terreno più ripido.")} />
            <div className="flex gap-2">
              <button className="btn-primary flex-1 basis-0" disabled={busy === "dem" || !activeGeom} onClick={showDem}>
                {busy === "dem" ? t("Ricompongo…") : t("Mostra DEM")}
              </button>
              <button className="btn-ghost flex-1 basis-0" onClick={clearDem}>{t("Rimuovi DEM")}</button>
            </div>
            <div className="flex gap-2 items-end mt-2">
              <label className="text-xs text-sage-dark flex-1 basis-0 min-w-0">{t("Isoipse ogni")}
                <select className="field-input mt-1 w-full" value={isoInterval} onChange={(e) => setIsoInterval(Number(e.target.value))}>
                  <option value={0}>{t("Automatico")}</option>
                  {[0.5, 1, 2, 2.5, 5, 10, 20, 25, 50].map((v) => <option key={v} value={v}>{v} m</option>)}
                </select>
              </label>
              <button className="btn-primary flex-1 basis-0 whitespace-nowrap" disabled={busy === "terrain" || !activeGeom} onClick={showTerrain}>
                {busy === "terrain" ? t("Ricompongo…") : t("Rilievo + isoipse")}
              </button>
            </div>
            {demInfo && (
              <div className="mt-2">
                <ScaleBar scale={demInfo.scale} unit=" m" />
                <p className="text-xs text-sage-dark mt-1">
                  {t("min")} {uM(demInfo.min)} · {t("max")} {uM(demInfo.max)}
                </p>
              </div>
            )}
            {terrainInfo && (
              <div className="mt-2 text-xs text-sage-dark bg-panel rounded-lg p-2 leading-relaxed">
                {t("Isoipse ogni")} <b>{uM(terrainInfo.interval, 1)}</b> · {t("quota")} {uM(terrainInfo.min)}–{uM(terrainInfo.max)}<br />
                {t("Le linee marcate riportano la quota; più sono fitte, più il versante è ripido.")}
              </div>
            )}
          </section>

          <section className={secShow("analisi") + " border-t border-black/5 pt-3"}>
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

          <section className={secShow("analisi") + " border-t border-black/5 pt-3"}>
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

          <section className={secShow("analisi") + " border-t border-black/5 pt-3"}>
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

          <section className={secShow("analisi") + " border-t border-black/5 pt-3"}>
            <SectionHead title={t("Dimensione pivot consigliata")} help={t("Dal tipo di suolo (infiltrazione) e dall'ET₀ di punta stima il raggio massimo del pivot perché l'intensità di pioggia al bordo non superi l'infiltrazione del terreno. Il valore è usato come raggio di default nella pagina Impianti.")} />
            <div className="flex gap-2 items-end">
              <label className="text-xs text-sage-dark flex-1 basis-0 min-w-0">{t("Tipo di suolo")}
                <select className="field-input mt-1 w-full px-2" value={soilKey}
                  onChange={(e) => { const so = SOILS.find((x) => x.key === e.target.value); setSoilKey(e.target.value); if (so) setInfiltration(so.inf); }}>
                  {SOILS.map((so) => <option key={so.key} value={so.key}>{t(so.label)}</option>)}
                </select>
              </label>
              <label className="text-xs text-sage-dark flex-1 basis-0 min-w-0">{t("Infiltrazione (mm/h)")}
                <input type="number" min={0.5} max={200} step={0.5} value={infiltration}
                  onChange={(e) => setInfiltration(Number(e.target.value))} className="field-input mt-1 w-full px-2" /></label>
              <label className="text-xs text-sage-dark flex-1 basis-0 min-w-0">{t("ET₀ di punta (mm/g)")}
                <input type="number" min={1} max={20} step={0.5} value={et0Peak}
                  onChange={(e) => setEt0Peak(Number(e.target.value))} className="field-input mt-1 w-full px-2" /></label>
            </div>
            <div className="flex items-center justify-between mt-2 text-xs">
              <span>{t("Raggio consigliato")}: <b>{recRadius} m</b></span>
              <button className="text-brand-mid" onClick={() => setPivotR(recRadius)}>{t("Usa raggio consigliato")}</button>
            </div>
          </section>

          <section className={secShow("rilievo")}>
            <SectionHead title={t("Dati agronomici")} help={t("Parametri per il dimensionamento idrico dei pivot: Kc di punta della coltura, efficienza dell'impianto e ore di irrigazione al giorno.")} />
            <div className="flex gap-2">
              <label className="text-xs text-sage-dark flex-1">{t("Kc di punta")}
                <input type="number" min={0.3} max={1.6} step={0.05} value={cur.kc}
                  onChange={(e) => patch({ kc: Number(e.target.value) })} className="field-input mt-1" /></label>
              <label className="text-xs text-sage-dark flex-1">{t("Efficienza impianto")}
                <input type="number" min={0.4} max={1} step={0.05} value={cur.eff}
                  onChange={(e) => patch({ eff: Number(e.target.value) })} className="field-input mt-1" /></label>
              <label className="text-xs text-sage-dark flex-1">{t("Ore/giorno")}
                <input type="number" min={1} max={24} step={1} value={cur.hours}
                  onChange={(e) => patch({ hours: Number(e.target.value) })} className="field-input mt-1" /></label>
            </div>
          </section>

          <section className={secShow("rilievo") + " border-t border-black/5 pt-3"}>
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

          <section className={secShow("impianti")}>
            <SectionHead title={t("Impianti")} help={t("«Inserisci impianti» dispone i pivot a reticolo SOLO sul poligono selezionato a sinistra — indifferentemente un'AREA o un CAMPO: puoi lavorare direttamente sull'area senza per forza generare i campi. Ripetendo su un altro poligono i pivot si aggiungono senza cancellare gli altri. Scegli la disposizione: «A quadrato» (pivot allineati) oppure «A triangolo» (file sfalsate di mezzo passo per incastrare i pivot e recuperare più spazio). Come alimentarli (canali o tubazioni) è indipendente e si definisce nell'adduzione. I pivot sono modificabili: 1° clic = gruppo, 2° clic = singolo (pannello «Proprietà», icona «i»). Strade e canali preesistenti si tracciano nella pagina Rilievo.")} />

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
              {designMode === "standard" ? (
                <div className="mb-2">
                  <div className="text-[10px] leading-tight text-sage-dark mb-1">{t("Raggio pivot")}</div>
                  <input type="number" min={30} max={1000} step={10} value={pivotR}
                    onChange={(e) => setPivotR(Number(e.target.value))} className="field-input px-2 py-1.5 text-sm" />
                </div>
              ) : (
                <div className="flex gap-2 mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] leading-tight text-sage-dark mb-1 truncate">{t("Raggio min")}</div>
                    <input type="number" min={30} max={1000} step={10} value={advMinR}
                      onChange={(e) => setAdvMinR(Number(e.target.value))} className="field-input px-2 py-1.5 text-sm" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] leading-tight text-sage-dark mb-1 truncate">{t("Raggio max")}</div>
                    <input type="number" min={30} max={1000} step={10} value={advMaxR}
                      onChange={(e) => setAdvMaxR(Number(e.target.value))} className="field-input px-2 py-1.5 text-sm" />
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] leading-tight text-sage-dark mb-1 truncate">{t("Tra i pivot")}</div>
                  <input type="number" min={0} max={500} step={5} value={safetyM}
                    onChange={(e) => setSafetyM(Number(e.target.value))} className="field-input px-2 py-1.5 text-sm" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] leading-tight text-sage-dark mb-1 truncate">{t("Da strade")}</div>
                  <input type="number" min={0} max={500} step={5} value={pivClearRoad}
                    onChange={(e) => setPivClearRoad(Number(e.target.value))} className="field-input px-2 py-1.5 text-sm" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] leading-tight text-sage-dark mb-1 truncate">{t("Da canali/invasi")}</div>
                  <input type="number" min={0} max={500} step={5} value={pivClearWater}
                    onChange={(e) => setPivClearWater(Number(e.target.value))} className="field-input px-2 py-1.5 text-sm" />
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
              </div>
            )}
          </section>



          <section className={secShow("rilievo") + " border-t border-black/5 pt-3"}>
            <SectionHead title={t("Strade")} help={t("Traccia o importa le strade preesistenti (con spessore). Gli impianti evitano il footprint reale secondo il franco «Da strade» impostato nella pagina Impianti.")} />

            {/* Livello Strade: linee disegnabili/importabili che i pivot rispettano */}
            <div className="bg-panel rounded-lg p-2">
              <div className="text-xs font-semibold text-sage-dark mb-2">{t("Strade")} · {roads.length}</div>
              <div className="flex gap-2">
                <button className="btn-primary flex-1 basis-0" onClick={drawRoad}>{t("Traccia strada")}</button>
                <button className="btn-ghost flex-1 basis-0" onClick={() => roadFileRef.current?.click()}>{t("Importa KMZ")}</button>
                <button className="btn-ghost flex-1 basis-0" disabled={!roads.length} onClick={clearRoads}>{t("Rimuovi tutte")}</button>
              </div>
              <input ref={roadFileRef} type="file" accept=".geojson,.json,.kml,.kmz" multiple className="hidden"
                onChange={(e) => { importRoads(e.target.files); if (e.target) e.target.value = ""; }} />
              <label className="flex items-center gap-2 text-[11px] text-sage-dark mt-1">
                {t("Spessore predefinito (m)")}
                <input type="number" min={1} max={200} step={1} value={roadWidth}
                  onChange={(e) => setRoadWidth(Number(e.target.value))} className="field-input w-20 py-0.5" />
              </label>
              {!roads.length
                ? <p className="text-[11px] text-sage-dark mt-1">{t("Nessuna strada. Tracciala sulla mappa o importa un file; gli impianti evitano il footprint reale (spessore) secondo il franco «Da strade».")}</p>
                : (
                  <ul className="space-y-1 mt-1">
                    {roads.map((r, i) => (
                      <li key={r.id} className="flex items-center justify-between gap-2 text-[11px] text-sage-dark">
                        <span className="truncate flex-1">{t("Strada")} {i + 1} · {uKm(lineLenKm(r.coords))}</span>
                        <input type="number" min={1} max={200} step={1} value={Math.round(r.width_m)} title={t("Spessore (m)")}
                          onChange={(e) => setRoadWidthAt(i, Number(e.target.value))} className="field-input w-16 py-0.5 shrink-0" />
                        <span className="flex gap-1 shrink-0">
                          <button className="text-brand-mid" title={t("Esporta KMZ")} onClick={() => exportKmz(safe(`strada_${i + 1}`), [{ name: `Strada ${i + 1}`, geom: { type: "LineString", coordinates: r.coords } }])}>⤓</button>
                          <button className="text-danger" title={t("Rimuovi")} onClick={() => removeRoad(i)}>✕</button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          </section>

          <section className={secShow("accessori")}>
            <SectionHead title={t("Accessori")} help={t("Infrastrutture accessorie del progetto. «Diramazioni da canale» posa in automatico una fila di pivot lungo il canale e traccia la tubazione più corta per alimentarli.")} />

            <div className="bg-panel rounded-lg p-2">
              <div className="text-xs font-semibold text-sage-dark mb-1">{t("Tubazioni di adduzione dal canale")}</div>
              <p className="text-[10px] text-sage-dark leading-snug mb-2">
                {t("Linee dritte lungo le file di pivot: ogni tubazione si dirama dal canale e passa per i centri dei pivot della stessa fila.")}
              </p>

              {canals.length > 1 && (
                <label className="block mb-2">
                  <span className="text-[10px] text-sage-dark block mb-1">{t("Canale")}</span>
                  <select className="field-input px-2 py-1.5 text-sm" value={pipeCanalIdx}
                    onChange={(e) => setPipeCanalIdx(Number(e.target.value))}>
                    {canals.map((c, i) => <option key={i} value={i}>{`${t("Canale")} ${i + 1}`}</option>)}
                  </select>
                </label>
              )}

              <div className="flex gap-2 items-end">
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] leading-tight text-sage-dark mb-1 truncate">{t("Pivot per linea (max)")}</div>
                  <input type="number" min={1} max={100} step={1} value={pipeMaxPerLine}
                    onChange={(e) => setPipeMaxPerLine(Math.max(1, Number(e.target.value)))} className="field-input px-2 py-1.5 text-sm" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] leading-tight text-sage-dark mb-1 truncate">{t("Direzione delle tubazioni")}</div>
                  <div className="seg">
                    <div className="seg-item" data-active={!pipeFlip} onClick={() => setPipeFlip(false)}>{t("Automatica")}</div>
                    <div className="seg-item" data-active={pipeFlip} onClick={() => setPipeFlip(true)}>{t("Ruota di 90°")}</div>
                  </div>
                </div>
              </div>

              <div className="text-[10px] text-sage-dark bg-white/40 rounded-md p-1.5 mt-2 leading-relaxed">
                {t("Una linea per fila di pivot, spezzata al massimo ogni {n} pivot; ogni linea si ferma sul suo lato del canale.", { n: pipeMaxPerLine })}
                {nPipes > 0 && <> · {t("Tubazioni attive")}: <b>{nPipes}</b></>}
              </div>

              <div className="flex gap-2 mt-2">
                <button className="btn-primary flex-1 basis-0" disabled={!active || !canals.length}
                  onClick={generatePipes}>
                  {active ? t("Traccia tubazioni su «{name}»", { name: active.name }) : t("Traccia tubazioni")}
                </button>
                <button className="btn-ghost flex-1 basis-0" disabled={!nPipes} onClick={removePipes}>{t("Rimuovi tubazioni")}</button>
              </div>
              {!canals.length && <p className="text-[10px] text-danger mt-1">{t("Traccia prima un canale nella pagina Rilievo.")}</p>}
            </div>

            <p className="hint mt-3">{t("Altre infrastrutture accessorie (invasi, stazioni di pompaggio, dati elettrici…) in arrivo.")}</p>
          </section>

          <section className={secShow("export")}>
            <SectionHead title={t("Esporta progetto")} help={t("La scheda include idoneità, layout, dimensionamento idrico, fasi e schema dell'impianto.")} />
            <label className="text-xs text-sage-dark">{t("Note (facoltative)")}
              <input className="field-input mt-1" value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder={t("es. coltura, cliente, fase")} />
            </label>
            <div className="flex gap-2 mt-2">
              <button className="btn-primary flex-1 basis-0" disabled={busy === "pdf" || !hasFields} onClick={downloadPdf}>
                {busy === "pdf" ? t("Preparo…") : (fields.length > 1 ? t("Scarica schede PDF (ZIP)") : t("Scarica scheda PDF"))}
              </button>
              <button className="btn-ghost flex-1 basis-0" disabled={!laid.length} onClick={downloadGeoJSON}>{t("Layout GeoJSON")}</button>
            </div>

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
          </section>

          <p className={"hint " + secShow("export")}>
            {t("Fonte: Sentinel-2 L2A / DEM Copernicus.")}
            {providerMode === "synthetic" && <><br />{t("Dati sintetici (demo) — nessun credito Copernicus consumato.")}</>}
          </p>
          </div>
        </div>
        )}

        {/* Messaggi */}
        {msg && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pill-dark px-4 py-2 text-sm max-w-[80vw]">
            {msg} <button className="ml-2 opacity-70" onClick={() => setMsg("")}>✕</button>
          </div>
        )}

        {/* Profilo altimetrico del canale */}
        {profileCanal != null && canals[profileCanal] && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40" onClick={() => setProfileCanal(null)}>
            <div className="widget p-4 w-[640px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
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
            <div className="w-full max-w-2xl max-h-[85vh] bg-white rounded-2xl shadow-xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
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
