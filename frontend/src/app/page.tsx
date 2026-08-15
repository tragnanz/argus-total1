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
const REV = "v0.6.143";

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
  { key: "irrigazione", label: "Irrigazione" },
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
      pivots.push({ lat, lng, r: Math.round(r), conn: f?.properties?.connection, field: f?.properties?.field,
        q: f?.properties?.q, p: f?.properties?.p });
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
      ...(pv.q != null ? { q: pv.q } : {}), ...(pv.p != null ? { p: pv.p } : {}) },
    geometry: { type: "Polygon", coordinates: [circleRing(pv.lat, pv.lng, pv.r)] },
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
const IcoNavAccessori = () => (<svg {...navProps}><path d="M4 7h16M4 12h16M4 17h16" /><circle cx="9" cy="7" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="8" cy="17" r="2" /></svg>);
const IcoNavExport = () => (<svg {...navProps}><path d="M12 3v11" /><path d="m7 10 5 5 5-5" /><path d="M4 20h16" /></svg>);
const IcoNavIrrigazione = () => (<svg {...navProps}><path d="M12 3s5 5.5 5 9a5 5 0 0 1-10 0c0-3.5 5-9 5-9Z" /><path d="M10 13a2 2 0 0 0 4 0" /></svg>);
const TAB_ICONS = {
  analisi: IcoNavAnalisi, rilievo: IcoNavRilievo, impianti: IcoNavImpianti,
  accessori: IcoNavAccessori, irrigazione: IcoNavIrrigazione, export: IcoNavExport,
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

// Colore del testo del chip crediti secondo la % usata: ≥80% rosso, ≥50% ruggine.
function creditClass(u: api.Usage): string {
  if (u.requests_limit == null || u.requests_limit === 0) return "text-sage-dark";
  const pct = u.pct_used ?? (100 * u.requests_used / u.requests_limit);
  return pct >= 80 ? "text-danger" : pct >= 50 ? "text-rust" : "text-sage-dark";
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
  // Gerarchia pivot: modello modificabile (gruppo → singolo) derivato dal risultato.
  const [pivots, setPivots] = useState<PivotItem[]>([]);
  const [pivotLines, setPivotLines] = useState<PipeLine[]>([]);
  // Parametri idraulici di progetto (il singolo pivot può avere i suoi).
  // ---- Irrigazione: il fabbisogno decide la portata di OGNI pivot ----
  const [cropKey, setCropKey] = useState("canna");   // coltura → coefficiente Kc
  const [mm24, setMm24] = useState(8);               // fabbisogno lordo (mm/24h)
  const [rainMm, setRainMm] = useState(0);           // piovosità utile (mm/24h)
  const [effPct, setEffPct] = useState(85);          // efficienza dell'impianto (%)
  const [hoursDay, setHoursDay] = useState(20);      // ore di esercizio al giorno
  const [soakMmH, setSoakMmH] = useState(12);        // assorbimento del terreno (mm/h)
  const [wetW, setWetW] = useState(20);              // larghezza bagnata degli irrigatori (m)
  const [pattern, setPattern] = useState("ellittica");  // forma del profilo di bagnatura
  const [surfStore, setSurfStore] = useState(2);     // invaso superficiale del terreno (mm)
  const [turnsDay, setTurnsDay] = useState(1);       // giri del pivot al giorno
  const [sprinkBar, setSprinkBar] = useState(1.4);   // pressione richiesta agli irrigatori
  const [latDN, setLatDN] = useState(168);           // diametro della condotta del pivot (mm)
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
      const netHa = next.reduce((s, p) => s + (Math.PI * p.r * p.r) / 10000, 0);
      return { ...prev, geojson, meta: { ...prev.meta, n_pivots: next.length, n_canal_conn: nCanal, n_pipe_conn: nPipe, net_ha: Math.round(netHa * 10) / 10 } };
    });
  }
  // Ridisegna i pivot sulla mappa a ogni cambio di modello/selezione.
  useEffect(() => {
    const api2 = mapApi.current; if (!api2) return;
    // Filtra i gruppi pivot nascosti (per campo) e rimappa gli indici visibili → reali.
    const visIdx = pivots.map((_, k) => k).filter((k) => !hiddenPivotFields.has(pivots[k].field ?? -1));
    const fed = fedPivotKeys(pivotLines);
    const visP = visIdx.map((k) => ({ ...pivots[k], unconn: pivotLines.some((l) => l.kind === "pipe") && !fed.has(pKey(pivots[k])) }));
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
  }, [pivots, pivotLines, pivotSel, pipeSel, hiddenPivotFields, hiddenPipeFields, canals, watercourses]);

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
  // Coefficienti colturali (Kc di punta) e assorbimento tipico per suolo.
  const CROPS: Record<string, number> = { canna: 1.25, mais: 1.2, medica: 1.15, cereali: 1.15, ortive: 1.05, altro: 1.1 };
  const SOAK: Record<string, number> = { sabbioso: 25, "franco-sabbioso": 18, franco: 12, "franco-argilloso": 8, argilloso: 5 };
  // Fabbisogno consigliato: ET₀ di punta × Kc, meno la pioggia utile, diviso
  // l'efficienza dell'impianto.
  const mm24Suggested = Math.max(0, (et0Peak * (CROPS[cropKey] ?? 1.1) - rainMm)) / Math.max(0.3, effPct / 100);
  // Portata di UN pivot: 1 mm su 1 m² = 1 litro, quindi basta l'area del cerchio.
  const pivotFlow = (pv: { r: number; q?: number }) => {
    if (pv.q && pv.q > 0) return pv.q;                       // valore imposto a mano
    const area = Math.PI * pv.r * pv.r;                      // m²
    return (area * mm24) / (Math.max(1, hoursDay) * 3600);   // l/s (mm24 è già lordo)
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
  const runoffMm = (r: number) => Math.max(0, depthPass() - (soakMmH * wetHours(r) + surfStore));
  // Giri/giorno minimi perché non ci sia ruscellamento al bordo esterno.
  const turnsNeeded = (r: number) => {
    for (let n = 1; n <= 24; n++) {
      const d = mm24 / n, th = Math.max(0.05, hoursDay / n);
      const tw = (Math.max(1, wetW) * th) / (2 * Math.PI * Math.max(1, r));
      if (d <= soakMmH * tw + surfStore) return n;
    }
    return 0;
  };
  // Pressione richiesta al centro del pivot: irrigatori + perdita nella condotta
  // del pivot (Hazen-Williams con fattore 0,36 per le uscite multiple).
  const pivotPressure = (pv: { r: number; q?: number; p?: number }) => {
    if (pv.p && pv.p > 0) return pv.p;
    const Q = pivotFlow(pv) / 1000;                          // m³/s
    const D = latDN / 1000;
    const hf = 0.36 * (10.67 * pv.r * Math.pow(Q, 1.852)) / (Math.pow(130, 1.852) * Math.pow(D, 4.87));
    return sprinkBar + hf / 10.2;                            // bar
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
        <button className="flex-1 text-left leading-tight" title={t("Zoom · trascina su un campo per assegnarlo")} onClick={onZoom}>{label}</button>
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

  // Statistiche di un poligono per il pannello Livelli: superficie irrigata
  // (somma dei cerchi dei pivot che gli appartengono), medie per macchina e
  // sviluppo complessivo delle tubazioni del gruppo.
  function fieldStats(fid: number) {
    const pv = pivots.filter((p) => p.field === fid);
    const irrHa = pv.reduce((s, p) => s + (Math.PI * p.r * p.r) / 10000, 0);
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
            {ownedRoads.map(({ r, i }) => objRow("road", r.id, `r${r.id}`, !!r.hidden, () => toggleRoadHidden(i), <>{t("Strada")} {i + 1} · {uM(r.width_m)}</>, () => zoomToCoords(r.coords), () => removeRoad(i)))}
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
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[500] widget px-2 py-1.5 flex items-center gap-2 pointer-events-auto">
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
              </div>
            </>)}
          </div>

          {measuring && measureTxt && (
            <div className="nabu-bar px-3 py-2.5 text-sm text-white">{measureTxt}</div>
          )}
          </div>

          {/* 3 — ricerca: colonna centrale della griglia, quindi centrata sullo schermo */}
          <form onSubmit={geocode} className="nabu-cluster gap-2 pl-1.5 pr-1.5 py-1.5 w-[min(28rem,42vw)] min-w-[220px] justify-self-center">
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
          {/* Intestazione minima: la pagina attiva è già indicata dal menu
              verticale, qui resta solo il comando per chiudere la finestra. */}
          <div className="flex items-center justify-end px-2 pt-2 shrink-0">
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

          <section className={secShow("irrigazione")}>
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Fabbisogno e portate")}</h3>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] text-sage-dark">{t("Coltura")}
                <select className="field-input mt-0.5 px-2 py-1.5 text-sm" value={cropKey} onChange={(e) => setCropKey(e.target.value)}>
                  <option value="canna">{t("Canna da zucchero")}</option>
                  <option value="mais">{t("Mais")}</option>
                  <option value="medica">{t("Erba medica")}</option>
                  <option value="cereali">{t("Cereali")}</option>
                  <option value="ortive">{t("Ortive")}</option>
                  <option value="altro">{t("Altro")}</option>
                </select></label>
              <label className="text-[11px] text-sage-dark">{t("Tipo di suolo")}
                <select className="field-input mt-0.5 px-2 py-1.5 text-sm" value={soilKey}
                  onChange={(e) => { setSoilKey(e.target.value); const v = SOAK[e.target.value]; if (v) setSoakMmH(v); }}>
                  <option value="sabbioso">{t("Sabbioso")}</option>
                  <option value="franco-sabbioso">{t("Franco-sabbioso")}</option>
                  <option value="franco">{t("Franco")}</option>
                  <option value="franco-argilloso">{t("Franco-argilloso")}</option>
                  <option value="argilloso">{t("Argilloso")}</option>
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

            <h3 className="text-sm font-semibold text-brand-darker mt-3 mb-2">{t("Assorbimento del terreno")}</h3>
            <div className="grid grid-cols-3 gap-2">
              <label className="text-[11px] text-sage-dark">{t("Assorbimento (mm/h)")}
                <input type="number" min={1} step={1} value={soakMmH}
                  onChange={(e) => setSoakMmH(Math.max(1, Number(e.target.value)))} className="field-input mt-0.5 px-2 py-1.5 text-sm" /></label>
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
              <label className="text-[11px] text-sage-dark">{t("Condotta del pivot (mm)")}
                <input type="number" min={100} step={1} value={latDN}
                  onChange={(e) => setLatDN(Math.max(100, Number(e.target.value)))} className="field-input mt-0.5 px-2 py-1.5 text-sm" /></label>
            </div>

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
                  <div className={rate > soakMmH ? "text-danger font-semibold" : ""}>
                    {t("Intensità istantanea di picco")}: {fmt(rate, { maximumFractionDigits: 1 })} mm/h — {t("assorbimento")} {soakMmH} mm/h
                    {rate > soakMmH ? " ⚠" : " ✓"}
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
