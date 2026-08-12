"use client";
import { useEffect, useMemo, useRef, useState } from "react";
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
const REV = "v0.6.73";

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
};

// Wrapper front-end con visibilità per-oggetto (pannello Livelli stile Photoshop).
type CanalL = Canal & { hidden?: boolean; uid?: number };
type WaterL = Watercourse & { hidden?: boolean; uid?: number };
type RoadL = { id: string; coords: number[][]; width_m: number; hidden?: boolean };

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

export default function Page() {
  const { t, lang, setLang, fmt, fmtDate } = useI18n();
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
  const dragFieldRef = useRef<number | null>(null);       // riga trascinata nell'elenco Campi
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
  // Gerarchia pivot: modello modificabile (gruppo → singolo) derivato dal risultato.
  const [pivots, setPivots] = useState<PivotItem[]>([]);
  const [pivotLines, setPivotLines] = useState<{ kind: string; coords: number[][]; field?: number }[]>([]);
  const [dragOverField, setDragOverField] = useState<number | "root" | null>(null);   // evidenzia il bersaglio del trascinamento
  const [hiddenPivotFields, setHiddenPivotFields] = useState<Set<number>>(new Set()); // gruppi pivot (per campo) nascosti
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

  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [msg, setMsg] = useState<string>("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const roadFileRef = useRef<HTMLInputElement | null>(null);

  // ---- caricamenti iniziali ----
  useEffect(() => { mapApi.current?.setUnits(imperial); }, [imperial]);
  useEffect(() => { api.getHealth().then((h) => setProviderMode(h.provider_mode)).catch(() => {}); }, []);
  useEffect(() => { refreshClients(); }, []);
  useEffect(() => { refreshProjects(clientId); setProjectId(null); }, [clientId]);
  useEffect(() => {
    if (projectId) openProject(projectId);
    else { setAreas([]); setLayers([]); }
  }, [projectId]);

  async function refreshClients() { try { setClients(await api.listClients()); } catch (e) { showErr(e); } }
  async function refreshProjects(cid: number | null) { try { setProjects(await api.listProjects(cid)); } catch (e) { showErr(e); } }
  async function refreshAreas(pid: number) { try { setAreas(await api.listAreas(pid)); } catch (e) { showErr(e); } }
  async function refreshLayers(pid: number) { try { setLayers(await api.listLayers(pid)); } catch (e) { showErr(e); } }
  // Apertura progetto → LISTA UNICA: le aree salvate diventano subito «Campi»
  // sulla mappa; gli eventuali livelli salvati (canali/pivot) vengono ripristinati.
  async function openProject(pid: number) {
    clearAllFields();
    setCanals([]); setGuided(null);
    try {
      const [areasList, layersList] = await Promise.all([api.listAreas(pid), api.listLayers(pid)]);
      setAreas(areasList); setLayers(layersList);
      // Ricostruisci l'albero: aree radice → campi; figlie «field-child» → poligoni
      // figli (famiglia, ricorsivo); figlie «macro» → sotto-aree del campo.
      const childrenOfArea = (aid: number) => areasList.filter((a) => a.parent_area_id === aid);
      const nf: Field[] = [];
      const build = (a: typeof areasList[number], parentFieldId?: number) => {
        const fid = nextId.current++;
        const macros = childrenOfArea(a.id).filter((c) => c.kind === "macro")
          .map((c) => ({ id: nextId.current++, name: c.name, geom: c.geojson, area_ha: c.area_ha ?? 0, mean_score: 0, savedId: c.id } as FieldMacro));
        nf.push({ id: fid, name: a.name, geom: a.geojson, savedId: a.id, parentId: parentFieldId, macros: macros.length ? macros : undefined });
        for (const c of childrenOfArea(a.id)) if (c.kind !== "macro") build(c, fid);
      };
      areasList.filter((a) => a.parent_area_id == null).forEach((a) => build(a));
      if (nf.length) {
        const firstRoot = nf.find((f) => f.parentId == null) ?? nf[0];
        setFields(nf);
        setActiveId(firstRoot.id);
        renderFields(nf, firstRoot.id);
        setTimeout(() => mapApi.current?.fitAll(), 40);
      }
      const cs = layersList.filter((l) => l.kind === "canal").map((l) => l.data as unknown as Canal);
      if (cs.length) {
        setCanals(cs);
        renderCanals(cs);
      }
      const pv = layersList.filter((l) => l.kind === "pivots").map((l) => l.data as unknown as GuidedResult).pop();
      if (pv) { setGuided(pv); setModelFromGuided(pv); }
    } catch (e) { showErr(e); }
  }
  function showErr(e: unknown) { setMsg(e instanceof Error ? e.message : String(e)); }

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
    mapApi.current?.setFields(fs.map((f) => ({ id: f.id, name: f.name, geom: f.geom })), aId, hidden);
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
  function addField(geom: Polygon, name?: string, focus = true, savedId?: number, parentId?: number) {
    const id = nextId.current++;
    const f: Field = { id, name: name || `${t("Campo")} ${id}`, geom, savedId, parentId };
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
  function updateActiveGeom(geom: Polygon) {
    setFields((fs) => fs.map((f) => f.id === activeId ? { ...f, geom, lay: null, layGeo: null, suit: null } : f));
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
        return { id, name: im.name || `${t("Campo")} ${id}`, geom: im.geom };
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
  function addMacroToField(m: MacroArea) {
    if (activeId == null) { needField(); return; }
    setFields((fs) => {
      const arr = fs.map((f) => {
        if (f.id !== activeId) return f;
        const n = (f.macros?.length ?? 0) + 1;
        const mm: FieldMacro = {
          id: nextId.current++, name: `${f.name} · M${n}`,
          geom: m.geojson, area_ha: m.area_ha, mean_score: m.mean_score,
        };
        return { ...f, macros: [...(f.macros ?? []), mm] };
      });
      const rest = macroAreas.filter((x) => x !== m);
      setMacroAreas(rest);
      renderMacrosOnMap(arr, rest);
      return arr;
    });
  }
  function addAllMacroToField() {
    if (activeId == null) { needField(); return; }
    setFields((fs) => {
      const arr = fs.map((f) => {
        if (f.id !== activeId) return f;
        let n = f.macros?.length ?? 0;
        const add = macroAreas.map((m) => {
          n += 1;
          return { id: nextId.current++, name: `${f.name} · M${n}`, geom: m.geojson, area_ha: m.area_ha, mean_score: m.mean_score } as FieldMacro;
        });
        return { ...f, macros: [...(f.macros ?? []), ...add] };
      });
      setMacroAreas([]);
      renderMacrosOnMap(arr, []);
      return arr;
    });
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
      setTab("rilievo");
    } else if (l.kind === "pivots") {
      const g = l.data as unknown as GuidedResult;
      setGuided(g);
      setModelFromGuided(g);
      setTab("impianti");
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
    const visL = pivotLines.filter((l) => !hiddenPivotFields.has(l.field ?? -1));
    if (!visP.length && !visL.length) { api2.clearPivots?.(); return; }
    let selForShow = pivotSel;
    if (pivotSel.mode === "single") { const vpos = visIdx.indexOf(pivotSel.idx); selForShow = vpos >= 0 ? { mode: "single", idx: vpos } : { mode: "none", idx: -1 }; }
    api2.showPivots?.({ pivots: visP, lines: visL }, selForShow, {
      onClick: (i) => { const real = visIdx[i]; setPivotSel((s) => (s.mode === "none" ? { mode: "group", idx: -1 } : { mode: "single", idx: real })); },
      onMove: (i, lat, lng) => { const real = visIdx[i]; commitPivots(pivots.map((p, k) => (k === real ? { ...p, lat, lng } : p))); },
      onBackground: () => setPivotSel({ mode: "none", idx: -1 }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pivots, pivotLines, pivotSel, hiddenPivotFields]);

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
    const items = [
      ...roads.map((r) => ({ geojson: { type: "LineString", coordinates: r.coords }, width_m: r.width_m, clear_m: pivClearRoad })),
      ...canals.map((c) => ({ geojson: { type: "LineString", coordinates: c.geojson.coordinates }, width_m: canalWidth, clear_m: pivClearWater })),
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
  async function insertImpiantiActive() {
    if (!active) return needField();
    const fid = active.id;
    setBusy("layout"); setMsg("");
    try {
      const p: LayoutParams = { ...paramsFrom(effSettings(active)), radius_m: pivotR, gap_m: safetyM, roads: obstacleLines(), clear_road_m: pivClearRoad };
      const r = await api.fetchLayout(active.geom, p);
      const { pivots: np, lines: nl } = pivotsFromFC(r.geojson, pivotR);
      const taggedP = np.map((x) => ({ ...x, field: fid }));
      const taggedL = nl.map((x) => ({ ...x, field: fid }));
      const mergedP = [...pivots.filter((x) => x.field !== fid), ...taggedP];
      const mergedL = [...pivotLines.filter((x) => x.field !== fid), ...taggedL];
      setFields((fs) => fs.map((f) => f.id === fid ? { ...f, lay: r.meta, layGeo: r.geojson } : f));
      setPivots(mergedP); setPivotLines(mergedL); setPivotSel({ mode: "none", idx: -1 });
      const netHa = mergedP.reduce((s, x) => s + (Math.PI * x.r * x.r) / 10000, 0);
      setGuided({ geojson: fcFromModel(mergedP, mergedL), meta: { n_pivots: mergedP.length, radius_m: pivotR, net_ha: Math.round(netHa * 10) / 10, safety_m: safetyM } });
      setMsg(t("Impianti inseriti su «{name}» ✓", { name: active.name }));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  // Comando unico: instrada al motore giusto secondo la disposizione scelta.
  function insertImpianti() { return insertImpiantiActive(); }
  function clearImpianti() {
    clearGuided();
    setFields((fs) => fs.map((f) => ({ ...f, lay: null, layGeo: null })));
  }
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

        <div className="flex gap-2 mt-2">
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

        <div className="mt-2">
          <label className="text-xs text-sage-dark">{t("Sbordo consentito")}: {cur.overhang}%</label>
          <input type="range" min={0} max={30} step={5} value={cur.overhang}
            onChange={(e) => patch({ overhang: Number(e.target.value) })} className="w-full accent-brand" />
        </div>

        <div className="flex gap-2 mt-1">
          <label className="text-xs text-sage-dark flex-1">{t("Fasi di sviluppo")}
            <select className="field-input mt-1" value={cur.nPhases} onChange={(e) => patch({ nPhases: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          {cur.nPhases > 1 && (
            <label className="text-xs text-sage-dark flex-1">{t("Ordine fasi")}
              <select className="field-input mt-1" value={cur.phaseOrder} onChange={(e) => patch({ phaseOrder: e.target.value as PhaseOrder })}>
                <option value="canal_distance">{t("Vicinanza al canale")}</option>
                <option value="suitability">{t("Idoneità")}</option>
                <option value="rows">{t("Per file")}</option>
              </select>
            </label>
          )}
        </div>
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

  const hasFields = fields.length > 0;
  const rootFields = fields.filter((f) => f.parentId == null);
  // Gruppi pivot per campo (un «livello» pivot per campo nel pannello Livelli).
  const pivotGroups = (() => {
    const m = new Map<number, number>();
    for (const p of pivots) { const k = p.field ?? -1; m.set(k, (m.get(k) ?? 0) + 1); }
    return Array.from(m.entries()).map(([fid, n]) => ({ fid, n, name: fid < 0 ? t("Senza campo") : (fields.find((f) => f.id === fid)?.name ?? t("Campo")) }));
  })();

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
    return (
      <li key={f.id}
        draggable
        onDragStart={(e) => { e.stopPropagation(); dragFieldRef.current = f.id; e.dataTransfer.effectAllowed = "move"; }}
        onDragOver={(e) => { if (dragFieldRef.current != null && dragFieldRef.current !== f.id) { e.preventDefault(); e.stopPropagation(); if (dragOverField !== f.id) setDragOverField(f.id); } }}
        onDragLeave={(e) => { e.stopPropagation(); setDragOverField((d) => (d === f.id ? null : d)); }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); reparent(dragFieldRef.current, f.id); dragFieldRef.current = null; setDragOverField(null); }}
        onDragEnd={() => { dragFieldRef.current = null; setDragOverField(null); }}
        className={`text-sm rounded-lg px-2 py-1 cursor-move ${dragOverField === f.id ? "ring-2 ring-brand" : f.id === activeId ? "bg-brand/10 ring-1 ring-brand/40" : "bg-panel"} ${f.hidden ? "opacity-50" : ""}`}>
        <div className="flex items-center justify-between">
          <button className="truncate text-left flex-1" title={t("Seleziona campo · trascina per annidare")} onClick={() => selectField(f.id)}>
            {depth > 0 && <span className="text-brand-light">↳ </span>}
            <span className={f.id === activeId ? "font-semibold text-brand" : ""}>{f.name}</span>
            <span className="text-sage"> · {uHa(ringAreaHa(f.geom.coordinates))}</span>
            {!!kids.length && <span className="text-brand-light"> · {kids.length} {t("figli")}</span>}
            {!!f.macros?.length && <span className="text-brand-light"> · {f.macros.length} {t("sotto-aree")}</span>}
            {f.lay && <span className="text-brand-light"> · {f.lay.n_pivots} pivot</span>}
          </button>
          <span className="flex gap-1 shrink-0 items-center">
            <button className="text-sm text-brand w-4 font-semibold" title={t("Aggiungi poligono figlio")} onClick={() => addChild(f.id)}>＋</button>
            <button className="text-xs text-brand-mid w-4" title={f.hidden ? t("Mostra sulla mappa") : t("Nascondi dalla mappa")} onClick={() => toggleFieldHidden(f.id)}>{f.hidden ? "○" : "◉"}</button>
            <button className="text-xs text-brand-mid" title={t("Esporta KMZ")} onClick={() => exportKmz(safe(f.name), [{ name: f.name, geom: f.geom }, ...(f.macros ?? []).map((mm) => ({ name: mm.name, geom: mm.geom }))])}>⤓</button>
            <button className="text-xs text-brand-mid" title={t("Nome campo")} onClick={() => renameField(f)}>✎</button>
            <button className="text-xs text-danger" title={t("Rimuovi")} onClick={() => removeField(f)}>✕</button>
          </span>
        </div>
        {(!!kids.length || !!f.macros?.length) && (
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
          </ul>
        )}
      </li>
    );
  }

  return (
    <main>
      <MapCanvas apiRef={mapApi} onCreate={addDrawnField} onEditActive={updateActiveGeom} onSelect={selectField}
        onCanalProfile={(i) => setProfileCanal(i)} />

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
            {!clients.length && <p className="hint mt-2">{t("Nessun cliente. Creane uno.")}</p>}
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
            {!projects.length && <p className="hint mt-2">{t("Nessun progetto. Creane uno.")}</p>}
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

            {!hasFields
              ? <p className="hint mt-2">{t("Nessun campo. Disegna o importa un'area.")}</p>
              : (
                <ul className="space-y-1 mt-2">
                  {rootFields.map((f) => renderFieldNode(f, 0))}
                </ul>
              )}
            {hasFields && fields.some((f) => f.parentId != null) && (
              <div
                onDragOver={(e) => { if (dragFieldRef.current != null) { e.preventDefault(); if (dragOverField !== "root") setDragOverField("root"); } }}
                onDragLeave={() => setDragOverField((d) => (d === "root" ? null : d))}
                onDrop={(e) => { e.preventDefault(); reparent(dragFieldRef.current, null); dragFieldRef.current = null; setDragOverField(null); }}
                className={`text-[11px] text-center rounded-lg border border-dashed mt-1 py-1 ${dragOverField === "root" ? "border-brand text-brand bg-brand/5" : "border-black/15 text-sage-dark"}`}>
                {t("Trascina qui per portare a livello principale")}
              </div>
            )}
            <p className="text-[11px] text-sage-dark mt-1">{t("«＋» disegna un poligono figlio; trascina una riga su un'altra per annidarla (famiglia).")}</p>

            {/* --- Pannello Livelli: altri tipi di oggetto come cartelle (stile Photoshop) --- */}
            <div className="mt-3 border-t border-brand/15 pt-2">
              <div className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide mb-1">{t("Livelli")}</div>
              {renderLayerFolder("canali", t("Canali"), canals.length, canals.some((c) => !c.hidden), () => setAllCanalsHidden(canals.some((c) => !c.hidden)),
                canals.map((c, i) => (
                  <li key={c.uid ?? i} className="flex items-center gap-1 text-[11px] bg-panel rounded px-1.5 py-0.5">
                    <button className="text-brand-mid w-4" title={t("Mostra/Nascondi")} onClick={() => toggleCanalHidden(i)}>{c.hidden ? "○" : "◉"}</button>
                    <button className="flex-1 truncate text-left" title={t("Zoom")} onClick={() => zoomToCoords(c.geojson.coordinates)}>{t("Canale")} {i + 1} · {uM(c.length_m)}</button>
                    <button className="text-danger w-4" title={t("Rimuovi")} onClick={() => removeCanal(i)}>✕</button>
                  </li>
                )))}
              {renderLayerFolder("strade", t("Strade"), roads.length, roads.some((r) => !r.hidden), () => setAllRoadsHidden(roads.some((r) => !r.hidden)),
                roads.map((r, i) => (
                  <li key={r.id} className="flex items-center gap-1 text-[11px] bg-panel rounded px-1.5 py-0.5">
                    <button className="text-brand-mid w-4" title={t("Mostra/Nascondi")} onClick={() => toggleRoadHidden(i)}>{r.hidden ? "○" : "◉"}</button>
                    <button className="flex-1 truncate text-left" title={t("Zoom")} onClick={() => zoomToCoords(r.coords)}>{t("Strada")} {i + 1} · {uM(r.width_m)}</button>
                    <button className="text-danger w-4" title={t("Rimuovi")} onClick={() => removeRoad(i)}>✕</button>
                  </li>
                )))}
              {renderLayerFolder("invasi", t("Invasi/corsi d'acqua"), watercourses.length, watercourses.some((w) => !w.hidden), () => setAllWaterHidden(watercourses.some((w) => !w.hidden)),
                watercourses.map((w, i) => {
                  const coords = w.geojson.type === "Polygon" ? w.geojson.coordinates[0] : w.geojson.coordinates;
                  return (
                    <li key={i} className="flex items-center gap-1 text-[11px] bg-panel rounded px-1.5 py-0.5">
                      <button className="text-brand-mid w-4" title={t("Mostra/Nascondi")} onClick={() => toggleWaterHidden(i)}>{w.hidden ? "○" : "◉"}</button>
                      <button className="flex-1 truncate text-left" title={t("Zoom")} onClick={() => zoomToCoords(coords)}>{w.kind} {i + 1}</button>
                      <button className="text-danger w-4" title={t("Rimuovi")} onClick={() => removeWater(i)}>✕</button>
                    </li>
                  );
                }))}
              {renderLayerFolder("pivot", t("Pivot"), pivots.length, pivotGroups.some((g) => !hiddenPivotFields.has(g.fid)), () => setAllPivotsHidden(pivotGroups.some((g) => !hiddenPivotFields.has(g.fid))),
                pivotGroups.map((g) => (
                  <li key={g.fid} className="flex items-center gap-1 text-[11px] bg-panel rounded px-1.5 py-0.5">
                    <button className="text-brand-mid w-4" title={t("Mostra/Nascondi")} onClick={() => togglePivotFieldHidden(g.fid)}>{hiddenPivotFields.has(g.fid) ? "○" : "◉"}</button>
                    <button className="flex-1 truncate text-left" title={t("Zoom")} onClick={() => { const f = fields.find((x) => x.id === g.fid); if (f) zoomToCoords(f.geom.coordinates[0]); }}>{g.name} · {g.n} pivot</button>
                    <button className="text-danger w-4" title={t("Rimuovi")} onClick={() => removePivotsOfField(g.fid)}>✕</button>
                  </li>
                )))}
            </div>

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

            <button className="btn-primary w-full mt-3" disabled={busy === "save" || !active || !projectId} onClick={() => active && saveFieldTree(active)}>
              {busy === "save" ? t("Salvo…") : t("Salva campo e sotto-aree nel progetto")}
            </button>
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
              ) : (
                <div>
                  <p className="text-[11px] text-sage-dark">{t("Clicca un oggetto sulla mappa per modificarlo. I campi del progetto sono nell'elenco «Campi» del pannello Progetto.")}</p>
                </div>
              )}
            </div>
          </div>
        )}
        </div>

        {/* Pannello destro: schede (riducibile a icona) */}
        {rightMin ? (
          <button onClick={() => setRightMin(false)} title={t("Espandi il pannello schede")}
            className="absolute top-[4.5rem] right-4 z-30 widget px-3 py-2 flex items-center gap-2 text-sm text-brand-darker hover:bg-black/5">
            <IcoExpand /> {t("Strumenti")}
          </button>
        ) : (
        <div className="absolute top-[4.5rem] right-4 w-[440px] max-w-[calc(100vw_-_2rem)] max-h-[78vh] widget flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 pt-2 shrink-0">
            <span className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide">{t("Strumenti")}</span>
            <button onClick={() => setRightMin(true)} title={t("Riduci a icona")}
              className="text-sage-dark hover:text-brand p-1 rounded hover:bg-black/5"><IcoMinimize /></button>
          </div>
          <div className="overflow-auto scroll-soft p-4 pt-2 space-y-4">
          {!sameRules && active && (
            <div className="text-[11px] text-brand-mid bg-brand/10 rounded-lg px-2 py-1">
              {t("Stai modificando: {name}", { name: active.name })}
            </div>
          )}

          {/* Schede progressive del flusso */}
          <div className="flex flex-wrap gap-1 sticky top-0 z-10 bg-white/95 backdrop-blur -mx-4 px-4 py-2 -mt-1">
            {TABS.map((tb, i) => (
              <button key={tb.key} onClick={() => setTab(tb.key)}
                className={"text-xs px-2 py-1 rounded-lg transition " +
                  (tab === tb.key ? "bg-brand text-white font-semibold" : "bg-panel text-sage-dark")}>
                <span className="opacity-60 mr-1">{i + 1}</span>{t(tb.label)}
              </button>
            ))}
          </div>

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
            <SectionHead title={t("Macro-aree")} help={t("Individua le zone idonee nell'area attiva; usale come campi o rifinisci.")} />
            <div className="flex gap-2">
              <label className="text-xs text-sage-dark flex-1">{t("Soglia idoneità")}: {macroThr}/100
                <input type="range" min={40} max={90} step={5} value={macroThr}
                  onChange={(e) => setMacroThr(Number(e.target.value))} className="w-full accent-brand" />
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
                  <div className="text-xs font-semibold text-sage-dark">{macroAreas.length} {t("Macro-aree")}</div>
                  <button className="text-xs text-brand-mid disabled:opacity-40" disabled={activeId == null} onClick={addAllMacroToField}>{t("Aggiungi tutte al campo")}</button>
                </div>
                <p className="hint mb-1">{active ? t("Verranno aggiunte come sotto-aree di: {name}", { name: active.name }) : t("Seleziona un campo a sinistra per aggiungerle.")}</p>
                <ul className="space-y-1">
                  {macroAreas.map((m, i) => (
                    <li key={i} className="flex items-center justify-between text-sm bg-panel rounded-lg px-2 py-1">
                      <span className="flex-1 truncate">{t("Macro-area")} {i + 1} · {uHa(m.area_ha)} · {t("Idoneità")} {fmt(m.mean_score)}</span>
                      <button className="text-xs text-brand-mid shrink-0 disabled:opacity-40" disabled={activeId == null} onClick={() => addMacroToField(m)}>+ {t("Sotto-area")}</button>
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
                {busy === "canal" ? t("Calcolo…") : t("Canale automatico")}
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
            <SectionHead title={t("Impianti")} help={t("«Inserisci impianti» dispone i pivot a reticolo SOLO sul poligono selezionato nell'elenco Campi (seleziona un campo o un poligono figlio a sinistra). Ripetendo su un altro poligono i pivot si aggiungono senza cancellare gli altri. Scegli la disposizione: «A quadrato» (pivot allineati) oppure «A triangolo» (file sfalsate di mezzo passo per incastrare i pivot e recuperare più spazio). Come alimentarli (canali o tubazioni) è indipendente e si definisce nell'adduzione. I pivot sono modificabili: 1° clic = gruppo, 2° clic = singolo (pannello «Proprietà», icona «i»). Strade e canali preesistenti si tracciano nella pagina Rilievo.")} />

            <label className="text-xs text-sage-dark block mb-1">{t("Disposizione")}</label>
            <div className="seg mb-1">
              <div className="seg-item" data-active={cur.layoutCfg === "square"} onClick={() => patch({ layoutCfg: "square" })}>{t("A quadrato")}</div>
              <div className="seg-item" data-active={cur.layoutCfg === "staggered"} onClick={() => patch({ layoutCfg: "staggered" })}>{t("A triangolo")}</div>
            </div>
            <div className="mb-2" />

            <div className="bg-panel rounded-lg p-2 mt-2">
              <div className="text-xs font-semibold text-sage-dark mb-1">{t("Raggio e distanze di rispetto (m)")}</div>
              <div className="flex gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] leading-tight text-sage-dark mb-1 truncate">{t("Raggio pivot")}</div>
                  <input type="number" min={30} max={1000} step={10} value={pivotR}
                    onChange={(e) => setPivotR(Number(e.target.value))} className="field-input px-2 py-1.5 text-sm" />
                </div>
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

            <div className="text-xs text-sage-dark bg-panel rounded-lg p-2 mt-2 leading-relaxed">
              {t("Raggio")}: <b>{uM(pivotR)}</b> · {t("Area per pivot")}: <b>{uHa(Math.PI * pivotR * pivotR / 10000, 1)}</b><br />
              {t("Interasse (centro-centro)")}: <b>{uM(2 * pivotR + safetyM)}</b>
            </div>
            <div className="flex gap-2 mt-2">
              <button className="btn-primary flex-1 basis-0"
                disabled={busy === "layout" || !active}
                onClick={insertImpianti}>
                {busy === "layout" ? t("Calcolo…") : active ? t("Inserisci su «{name}»", { name: active.name }) : t("Inserisci impianti")}
              </button>
              <button className="btn-ghost flex-1 basis-0" onClick={clearImpianti}>{t("Rimuovi")}</button>
            </div>

            {/* La modifica di gruppo/singolo pivot è nel pannello «Proprietà» a sinistra. */}
            {!!pivots.length && (
              <p className="hint mt-3 border-t border-brand/15 pt-2">
                {t("Seleziona i pivot sulla mappa (1° clic = gruppo, 2° clic = singolo): apri il pannello «Proprietà» con l'icona «i» in basso a sinistra per modificarli.")}
              </p>
            )}

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
                <button className="btn-primary w-full" disabled={!projectId} onClick={savePivotsLayer}>{t("Salva pivot nel progetto")}</button>
              </div>
            )}
          </section>



          <section className={secShow("rilievo") + " border-t border-black/5 pt-3"}>
            <SectionHead title={t("Strade")} help={t("Traccia o importa le strade preesistenti (con spessore). Gli impianti evitano il footprint reale secondo il franco «Da strade» impostato nella pagina Impianti.")} />

            {/* Livello Strade: linee disegnabili/importabili che i pivot rispettano */}
            <div className="bg-panel rounded-lg p-2">
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs font-semibold text-sage-dark">{t("Strade")} · {roads.length}</div>
                <span className="flex gap-2 text-[11px]">
                  <button className="text-brand-mid" onClick={drawRoad}>{t("Traccia")}</button>
                  <button className="text-brand-mid" onClick={() => roadFileRef.current?.click()}>{t("Importa")}</button>
                  {!!roads.length && <button className="text-danger" onClick={clearRoads}>{t("Svuota")}</button>}
                </span>
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
            <SectionHead title={t("Accessori")} help={t("Infrastrutture accessorie del progetto (invasi, stazioni di pompaggio, dati elettrici…). In arrivo.")} />
            <p className="hint">{t("Nessun accessorio per ora. Questa sezione verrà popolata prossimamente.")}</p>
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
