"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import JSZip from "jszip";
import type { MapHandle } from "@/components/MapCanvas";
import { useI18n, LANGS, type Lang } from "@/lib/i18n";
import { parseFieldsFromFile } from "@/lib/importGeo";
import * as api from "@/lib/api";
import type {
  Area, Client, Polygon, Project, Scene, ColorScale, SuitMeta, SuitWeights,
  LayoutMeta, LayoutConfig, Transport, PhaseOrder, LayoutParams, GeoJSONFC, MacroArea, Canal, GuidedResult,
} from "@/lib/api";

// Revisione software: aggiornare a ogni versione consegnata.
const REV = "v0.6.6";

const MapCanvas = dynamic(() => import("@/components/MapCanvas"), { ssr: false });

const INDICES: { id: string; label: string }[] = [
  { id: "ndvi", label: "vegetazione" },
  { id: "ndmi", label: "umidità" },
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
  { key: "canal", label: "Canale" },
  { key: "guided", label: "Pivot" },
  { key: "layout", label: "Layout" },
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
};

// ---- KMZ (KML zippato) lato client per l'export delle geometrie ----
function kmlForPolys(items: { name: string; geom: Polygon }[]): string {
  const esc = (s: string) => s.replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" }[c] || c));
  const pm = items.map((it) => {
    const ring = (it.geom.coordinates?.[0] || []).map(([lo, la]) => `${lo},${la},0`).join(" ");
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

export default function Page() {
  const { t, lang, setLang, fmt, fmtDate } = useI18n();
  const mapApi = useRef<MapHandle | null>(null);

  const [providerMode, setProviderMode] = useState<string>("");
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [clientId, setClientId] = useState<number | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);

  // ---- campi (multi-poligono) ----
  const [fields, setFields] = useState<Field[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [sameRules, setSameRules] = useState(true);
  const [gset, setGset] = useState<Settings>(DEFAULTS);
  const nextId = useRef(1);
  // visibilità dei livelli sulla mappa (accendi/spegni dal widget sinistro)
  const [layerVis, setLayerVis] = useState({ fields: true, macro: true, canal: true, layout: true });

  const active = useMemo(() => fields.find((f) => f.id === activeId) ?? null, [fields, activeId]);
  const activeGeom = active?.geom ?? null;
  const totalHa = useMemo(() => fields.reduce((s, f) => s + ringAreaHa(f.geom.coordinates), 0), [fields]);
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
  const suit = active?.suit ?? null;

  // macro-aree (M6, fase 1)
  const [macroAreas, setMacroAreas] = useState<MacroArea[]>([]);
  const [macroThr, setMacroThr] = useState(60);
  const [macroMinHa, setMacroMinHa] = useState(10);
  // canale principale (M6, fase 2) — più canali, presa/finale manuali
  const [canals, setCanals] = useState<Canal[]>([]);
  const [canalPermille, setCanalPermille] = useState(1);
  const [canalStart, setCanalStart] = useState<number[] | null>(null);
  const [canalEnd, setCanalEnd] = useState<number[] | null>(null);
  const [pickMode, setPickMode] = useState<"start" | "end" | null>(null);
  // pivot lungo il canale (M6, fase 3)
  const [guided, setGuided] = useState<GuidedResult | null>(null);
  const [perSide, setPerSide] = useState(2);
  const [fillEmpty, setFillEmpty] = useState(true);
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

  // ---- caricamenti iniziali ----
  useEffect(() => { api.getHealth().then((h) => setProviderMode(h.provider_mode)).catch(() => {}); }, []);
  useEffect(() => { refreshClients(); }, []);
  useEffect(() => { refreshProjects(clientId); setProjectId(null); }, [clientId]);
  useEffect(() => { if (projectId) refreshAreas(projectId); else setAreas([]); }, [projectId]);

  async function refreshClients() { try { setClients(await api.listClients()); } catch (e) { showErr(e); } }
  async function refreshProjects(cid: number | null) { try { setProjects(await api.listProjects(cid)); } catch (e) { showErr(e); } }
  async function refreshAreas(pid: number) { try { setAreas(await api.listAreas(pid)); } catch (e) { showErr(e); } }
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
  // Visibilità: campo singolo (occhio) e livelli interi.
  function toggleFieldHidden(id: number) {
    setFields((fs) => {
      const arr = fs.map((f) => f.id === id ? { ...f, hidden: !f.hidden } : f);
      renderFields(arr, activeId);
      return arr;
    });
  }
  function toggleLayer(key: "fields" | "macro" | "canal" | "layout") {
    setLayerVis((v) => {
      const nv = { ...v, [key]: !v[key] };
      mapApi.current?.setLayerVisible(key, nv[key]);
      return nv;
    });
  }
  async function exportKmz(filename: string, items: { name: string; geom: Polygon }[]) {
    if (!items.length) return;
    const zip = new JSZip();
    zip.file("doc.kml", kmlForPolys(items));
    const blob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.google-earth.kmz" });
    saveBlob(blob, filename.toLowerCase().endsWith(".kmz") ? filename : `${filename}.kmz`);
  }
  function draw() { setMsg(""); mapApi.current?.draw(); }
  function addField(geom: Polygon, name?: string, focus = true) {
    const id = nextId.current++;
    const f: Field = { id, name: name || `${t("Campo")} ${id}`, geom };
    setFields((prev) => {
      const arr = [...prev, f];
      const aId = focus ? id : activeId;
      renderFields(arr, aId);
      if (focus) setActiveId(id);
      return arr;
    });
  }
  function addDrawnField(geom: Polygon) { setMsg(""); addField(geom); setTimeout(() => mapApi.current?.fitAll(), 30); }
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
    setFields((fs) => {
      const arr = fs.filter((x) => x.id !== f.id);
      const aId = activeId === f.id ? (arr[0]?.id ?? null) : activeId;
      renderFields(arr, aId);
      if (activeId === f.id) { setActiveId(aId); clearViewOverlays(); }
      return arr;
    });
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
  function loadArea(a: Area) { addField(a.geojson, a.name); setMsg(""); setTimeout(() => mapApi.current?.fitAll(), 30); }
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
  function clearDem() { mapApi.current?.clearOverlay("dem"); setDemInfo(null); }

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
  // Salva un campo e le sue sotto-aree nel progetto (le macro come figlie).
  async function saveFieldTree(f: Field) {
    if (!projectId) { setMsg(t("Serve un progetto selezionato per salvare l'area.")); return; }
    setBusy("save");
    try {
      const fa = await api.createArea({
        project_id: projectId, name: f.name, geojson: f.geom,
        area_ha: Math.round(ringAreaHa(f.geom.coordinates)), kind: "field",
      });
      for (const mm of f.macros ?? []) {
        await api.createArea({
          project_id: projectId, name: mm.name, geojson: mm.geom,
          area_ha: Math.round(mm.area_ha), parent_area_id: fa.id, kind: "macro",
        });
      }
      setFields((fs) => fs.map((x) => x.id === f.id ? { ...x, savedId: fa.id } : x));
      await refreshAreas(projectId);
      setMsg(t("Campo e {n} sotto-aree salvati ✓", { n: (f.macros ?? []).length }));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }

  // ---- canale principale (M6, fase 2) ----
  function armPick(kind: "start" | "end") {
    setPickMode(kind);
    setMsg(kind === "start" ? t("Clicca sulla mappa per posizionare la presa.")
                            : t("Clicca sulla mappa per posizionare il finale."));
    mapApi.current?.armPick((lon, lat) => {
      const pt = [lon, lat];
      if (kind === "start") setCanalStart(pt); else setCanalEnd(pt);
      setPickMode(null); setMsg("");
      mapApi.current?.showPending(
        kind === "start" ? pt : canalStart,
        kind === "end" ? pt : canalEnd,
        t("Presa"), t("Finale"));
    });
  }
  function cancelPick() { setPickMode(null); setMsg(""); mapApi.current?.disarmPick(); }
  function resetPicks() {
    setCanalStart(null); setCanalEnd(null);
    mapApi.current?.showPending(null, null, t("Presa"), t("Finale"));
  }
  async function traceCanal() {
    if (!activeGeom) return needField();
    setBusy("canal"); setMsg("");
    try {
      const cc = await api.fetchCanal(activeGeom, canalPermille, canalStart, canalEnd);
      const next = [...canals, cc];
      setCanals(next);
      setCanalStart(null); setCanalEnd(null);
      mapApi.current?.showPending(null, null, t("Presa"), t("Finale"));
      mapApi.current?.showCanals(
        next.map((c) => ({ coords: c.geojson.coordinates, start: c.start, end: c.end })),
        t("Presa"), t("Sbocco"));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function removeCanal(i: number) {
    const next = canals.filter((_, k) => k !== i);
    setCanals(next);
    mapApi.current?.showCanals(
      next.map((c) => ({ coords: c.geojson.coordinates, start: c.start, end: c.end })),
      t("Presa"), t("Sbocco"));
  }
  function clearCanalUI() {
    setCanals([]); setCanalStart(null); setCanalEnd(null); setPickMode(null);
    mapApi.current?.disarmPick(); mapApi.current?.clearCanal();
  }

  // ---- pivot lungo il canale (M6, fase 3) ----
  async function designGuided() {
    if (!activeGeom) return needField();
    setBusy("guided"); setMsg("");
    try {
      const g = await api.fetchGuided(activeGeom, {
        target_permille: canalPermille, radius_m: cur.radius, gap_m: cur.gap,
        per_side: perSide, conn_max_permille: 5, fill: fillEmpty,
      });
      setGuided(g);
      mapApi.current?.showLayouts([{ id: -1, fc: g.geojson }]);
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function clearGuided() { setGuided(null); mapApi.current?.clearLayout(); }

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

  return (
    <main>
      <MapCanvas apiRef={mapApi} onCreate={addDrawnField} onEditActive={updateActiveGeom} onSelect={selectField} />

      <div className="overlay-layer">
        {/* Testata */}
        <div className="absolute top-4 left-4 flex items-center gap-3">
          <div className="pill-light flex items-center gap-2 px-3 py-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/nabu-logo-color.png" alt="Nabu" className="h-6 w-auto" />
            <div className="leading-tight">
              <div className="font-semibold text-brand">Argus <span className="text-brand-light">Total</span></div>
              <div className="text-[11px] text-sage-dark">{t("Progettazione di grandi progetti agroindustriali")}</div>
            </div>
          </div>
        </div>

        {/* Ricerca + lingua */}
        <div className="absolute top-4 right-4 flex items-center gap-2">
          <form onSubmit={geocode} className="pill-light flex items-center px-3 py-1.5">
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={t("Cerca indirizzo o coordinate (lat, lon)")}
              className="bg-transparent outline-none text-sm w-64" />
          </form>
          <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}
            className="pill-light px-3 py-2 text-sm outline-none">
            {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>

        {/* Pannello sinistro: flusso di progetto */}
        <div className="absolute top-24 left-4 w-[440px] max-w-[calc(100vw_-_2rem)] max-h-[78vh] overflow-auto scroll-soft widget p-4 space-y-4">
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
              {hasFields && <span className="text-[11px] text-sage-dark">{fields.length} {t("campi")} · {fmt(totalHa, { maximumFractionDigits: 0 })} ha</span>}
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
                  {fields.map((f) => (
                    <li key={f.id}
                      className={`text-sm rounded-lg px-2 py-1 ${f.id === activeId ? "bg-brand/10 ring-1 ring-brand/40" : "bg-panel"} ${f.hidden ? "opacity-50" : ""}`}>
                      <div className="flex items-center justify-between">
                        <button className="truncate text-left flex-1" title={t("Seleziona campo")} onClick={() => selectField(f.id)}>
                          <span className={f.id === activeId ? "font-semibold text-brand" : ""}>{f.name}</span>
                          <span className="text-sage"> · {fmt(ringAreaHa(f.geom.coordinates), { maximumFractionDigits: 0 })} ha</span>
                          {!!f.macros?.length && <span className="text-brand-light"> · {f.macros.length} {t("sotto-aree")}</span>}
                          {f.lay && <span className="text-brand-light"> · {f.lay.n_pivots} pivot</span>}
                        </button>
                        <span className="flex gap-1 shrink-0 items-center">
                          <button className="text-xs text-brand-mid w-4" title={f.hidden ? t("Mostra sulla mappa") : t("Nascondi dalla mappa")} onClick={() => toggleFieldHidden(f.id)}>{f.hidden ? "○" : "◉"}</button>
                          <button className="text-xs text-brand-mid" title={t("Esporta KMZ")} onClick={() => exportKmz(safe(f.name), [{ name: f.name, geom: f.geom }, ...(f.macros ?? []).map((mm) => ({ name: mm.name, geom: mm.geom }))])}>⤓</button>
                          <button className="text-xs text-brand-mid" title={t("Nome campo")} onClick={() => renameField(f)}>✎</button>
                          <button className="text-xs text-danger" title={t("Rimuovi")} onClick={() => removeField(f)}>✕</button>
                        </span>
                      </div>
                      {!!f.macros?.length && (
                        <ul className="mt-1 ml-1 space-y-0.5 border-l-2 border-brand/20 pl-2">
                          {f.macros.map((mm) => (
                            <li key={mm.id} className="flex items-center justify-between text-[11px] text-sage-dark">
                              <span className="truncate flex-1">↳ {mm.name} · {fmt(mm.area_ha, { maximumFractionDigits: 0 })} ha · {t("Idoneità")} {fmt(mm.mean_score)}{mm.savedId ? " ✓" : ""}</span>
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
                  ))}
                </ul>
              )}

            {/* Livelli: accendi/spegni ciò che è disegnato sulla mappa */}
            {hasFields && (
              <div className="mt-3">
                <label className="text-xs text-sage-dark block mb-1">{t("Livelli sulla mappa")}</label>
                <div className="flex flex-wrap gap-1">
                  {([
                    ["fields", t("Campi")],
                    ["macro", t("Macro-aree")],
                    ["canal", t("Canali")],
                    ["layout", t("Layout pivot")],
                  ] as const).map(([k, lbl]) => (
                    <button key={k} onClick={() => toggleLayer(k)}
                      className={"text-[11px] px-2 py-1 rounded-lg transition flex items-center gap-1 " +
                        (layerVis[k] ? "bg-brand text-white" : "bg-panel text-sage-dark line-through opacity-70")}>
                      <span>{layerVis[k] ? "◉" : "○"}</span>{lbl}
                    </button>
                  ))}
                </div>
              </div>
            )}

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
            {!!areas.length && (
              <div className="mt-3">
                <div className="text-xs font-semibold text-sage-dark mb-1">{t("Aree salvate")}</div>
                <ul className="space-y-1">
                  {areas.filter((a) => a.parent_area_id == null).map((a) => (
                    <li key={a.id} className="text-sm bg-panel rounded-lg px-2 py-1">
                      <div className="flex items-center justify-between">
                        <button className="truncate text-left flex-1" title={t("Carica")} onClick={() => loadArea(a)}>
                          {a.name} <span className="text-sage">· {a.area_ha ?? "?"} ha</span>
                        </button>
                        <span className="flex gap-1 shrink-0">
                          <button className="text-xs text-brand-mid" title={t("Nome area")} onClick={() => renameArea(a)}>✎</button>
                          <button className="text-xs text-danger" title={t("Rimuovi")} onClick={() => delArea(a)}>✕</button>
                        </span>
                      </div>
                      {areas.filter((c) => c.parent_area_id === a.id).map((c) => (
                        <div key={c.id} className="flex items-center justify-between text-[11px] text-sage-dark ml-1 mt-0.5 border-l-2 border-brand/20 pl-2">
                          <button className="truncate text-left flex-1" title={t("Carica")} onClick={() => loadArea(c)}>↳ {c.name} · {c.area_ha ?? "?"} ha</button>
                          <span className="flex gap-1 shrink-0">
                            <button className="text-brand-mid" title={t("Esporta KMZ")} onClick={() => exportKmz(safe(c.name), [{ name: c.name, geom: c.geojson }])}>⤓</button>
                            <button className="text-danger" title={t("Rimuovi")} onClick={() => delArea(c)}>✕</button>
                          </span>
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>

        {/* Pannello destro: anteprima / idoneità / layout */}
        <div className="absolute top-24 right-4 w-[440px] max-w-[calc(100vw_-_2rem)] max-h-[78vh] overflow-auto scroll-soft widget p-4 space-y-4">
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
            <label className="text-xs text-sage-dark">{t("Indice")}</label>
            <select className="field-input mt-1" value={index} onChange={(e) => setIndex(e.target.value)}>
              {INDICES.map((i) => <option key={i.id} value={i.id}>{i.id.toUpperCase()} — {t(i.label)}</option>)}
            </select>

            <button className="btn-ghost w-full mt-2" disabled={busy === "scenes" || !activeGeom} onClick={searchScenes}>
              {busy === "scenes" ? t("Cerco…") : t("Cerca date disponibili")}
            </button>

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
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Quota (DEM)")}</h3>
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
                  {t("min")} {fmt(demInfo.min)} m · {t("max")} {fmt(demInfo.max)} m
                </p>
              </div>
            )}
          </section>

          <section className={secShow("analisi") + " border-t border-black/5 pt-3"}>
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Idoneità del terreno")}</h3>
            <div className="text-xs text-sage-dark mb-1">{t("Pesi dei fattori")}</div>
            <WeightRow label={t("Pendenza")} v={cur.weights.slope} onChange={(v) => setW("slope", v)} />
            <WeightRow label={t("Vigore")} v={cur.weights.vigor} onChange={(v) => setW("vigor", v)} />
            <WeightRow label={t("Umidità")} v={cur.weights.moisture} onChange={(v) => setW("moisture", v)} />
            <WeightRow label={t("Clima")} v={cur.weights.climate} onChange={(v) => setW("climate", v)} />
            <div className="flex gap-2 mt-2">
              <label className="text-xs text-sage-dark flex-1">
                {t("Pendenza ideale (‰)")}
                <input type="number" min={0} max={100} step={0.5} value={cur.slopeIdeal}
                  onChange={(e) => patch({ slopeIdeal: Number(e.target.value) })} className="field-input mt-1" />
              </label>
              <label className="text-xs text-sage-dark flex-1">
                {t("Pendenza massima (‰)")}
                <input type="number" min={0} max={200} step={0.5} value={cur.slopeMax}
                  onChange={(e) => patch({ slopeMax: Number(e.target.value) })} className="field-input mt-1" />
              </label>
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
                      {fmt(suit.suitable_ha, { maximumFractionDigits: 0 })}</div>
                    <div className="text-[11px] text-sage-dark">{t("Superficie idonea")} (ha)</div>
                  </div>
                  <div className="bg-panel rounded-lg p-2">
                    <div className="text-lg font-semibold text-brand">{fmt(suit.mean_score)}/100</div>
                    <div className="text-[11px] text-sage-dark">{t("Idoneità media")}</div>
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold text-sage-dark mb-1">{t("Ripartizione classi")}</div>
                  {suit.classes.map((c) => (
                    <div key={c.key} className="flex items-center text-xs py-0.5">
                      <span className="inline-block w-3 h-3 rounded-sm mr-2" style={{ background: c.color }} />
                      <span className="flex-1">{t(c.label)}</span>
                      <span className="text-sage-dark">
                        {fmt(c.ha, { maximumFractionDigits: 0 })} ha · {fmt(c.pct)}%
                      </span>
                    </div>
                  ))}
                </div>
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
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Macro-aree")}</h3>
            <p className="hint mb-2">{t("Individua le zone idonee nell'area attiva; usale come campi o rifinisci.")}</p>
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
                      <span className="flex-1 truncate">{t("Macro-area")} {i + 1} · {fmt(m.area_ha, { maximumFractionDigits: 0 })} ha · {t("Idoneità")} {fmt(m.mean_score)}</span>
                      <button className="text-xs text-brand-mid shrink-0 disabled:opacity-40" disabled={activeId == null} onClick={() => addMacroToField(m)}>+ {t("Sotto-area")}</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className={secShow("canal")}>
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Canale principale")}</h3>
            <p className="hint mb-2">{t("Traccia uno o più canali a gravità a pendenza costante. Definisci presa e finale, oppure lascia automatico.")}</p>
            <label className="text-xs text-sage-dark block">{t("Pendenza target (‰)")}
              <input type="number" min={0.1} max={100} step={0.5} value={canalPermille}
                onChange={(e) => setCanalPermille(Number(e.target.value))} className="field-input mt-1" />
            </label>

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
              <p className="hint mt-1">{t("Se non impostati: presa nel punto più alto, finale sul bordo più basso.")}</p>
            </div>

            <div className="flex gap-2 mt-2">
              <button className="btn-primary flex-1 basis-0" disabled={busy === "canal" || !activeGeom} onClick={traceCanal}>
                {busy === "canal" ? t("Calcolo…") : t("Aggiungi canale")}
              </button>
              <button className="btn-ghost flex-1 basis-0" disabled={!canals.length && !canalStart && !canalEnd} onClick={clearCanalUI}>{t("Rimuovi tutti")}</button>
            </div>

            {canals.length > 0 && (
              <ul className="mt-3 space-y-2">
                {canals.map((c, i) => (
                  <li key={i} className="text-xs text-sage-dark bg-panel rounded-lg p-2 leading-relaxed">
                    <div className="flex items-center justify-between mb-1">
                      <b className="text-brand-darker">{t("Canale")} {i + 1}</b>
                      <button className="text-xs text-danger shrink-0" onClick={() => removeCanal(i)}>{t("Rimuovi")}</button>
                    </div>
                    {t("Lunghezza")}: <b>{fmt(c.length_m / 1000, { maximumFractionDigits: 2 })} km</b> · {t("Dislivello")}: {fmt(c.drop_m, { maximumFractionDigits: 1 })} m<br />
                    {t("Pendenza media")}: <b>{fmt(c.mean_permille)}‰</b> · {t("Pendenza target (‰)")}: {fmt(c.target_permille)}‰
                    {c.mean_permille > c.target_permille * 1.5 && (
                      <><br /><span className="text-danger">{t("Pendenza reale oltre il target: terreno acclive.")}</span></>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={secShow("guided")}>
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Pivot lungo il canale")}</h3>
            <p className="hint mb-2">{t("Usa raggio e spaziatura dalle impostazioni Layout.")}</p>

            <div className="bg-panel rounded-lg p-2 mb-2">
              <div className="text-xs font-semibold text-sage-dark mb-1">{t("Dimensione pivot consigliata")}</div>
              <label className="text-xs text-sage-dark block">{t("Tipo di suolo")}
                <select className="field-input mt-1" value={soilKey}
                  onChange={(e) => { const so = SOILS.find((x) => x.key === e.target.value); setSoilKey(e.target.value); if (so) setInfiltration(so.inf); }}>
                  {SOILS.map((so) => <option key={so.key} value={so.key}>{t(so.label)}</option>)}
                </select>
              </label>
              <div className="flex gap-2 mt-2">
                <label className="text-xs text-sage-dark flex-1">{t("Infiltrazione (mm/h)")}
                  <input type="number" min={0.5} max={200} step={0.5} value={infiltration}
                    onChange={(e) => setInfiltration(Number(e.target.value))} className="field-input mt-1" /></label>
                <label className="text-xs text-sage-dark flex-1">{t("ET₀ di punta")} (mm/g)
                  <input type="number" min={1} max={20} step={0.5} value={et0Peak}
                    onChange={(e) => setEt0Peak(Number(e.target.value))} className="field-input mt-1" /></label>
              </div>
              <div className="flex items-center justify-between mt-2 text-xs">
                <span>{t("Raggio consigliato")}: <b>{recRadius} m</b></span>
                <button className="text-brand-mid" onClick={() => patch({ radius: recRadius })}>{t("Usa raggio consigliato")}</button>
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-sage-dark mb-2">
              <input type="checkbox" checked={fillEmpty} onChange={(e) => setFillEmpty(e.target.checked)} />
              {t("Riempi spazi vuoti")}
            </label>

            <label className="text-xs text-sage-dark block">{t("Pivot per lato")}
              <select className="field-input mt-1" value={perSide} onChange={(e) => setPerSide(Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <div className="flex gap-2 mt-2">
              <button className="btn-primary flex-1 basis-0" disabled={busy === "guided" || !activeGeom} onClick={designGuided}>
                {busy === "guided" ? t("Calcolo…") : t("Disponi pivot sul canale")}
              </button>
              <button className="btn-ghost flex-1 basis-0" onClick={clearGuided}>{t("Rimuovi")}</button>
            </div>
            {guided && (
              <div className="mt-3 space-y-2">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="bg-panel rounded-lg p-2">
                    <div className="text-lg font-semibold text-brand">{guided.meta.n_pivots}</div>
                    <div className="text-[11px] text-sage-dark">pivot</div>
                  </div>
                  <div className="bg-panel rounded-lg p-2">
                    <div className="text-lg font-semibold text-brand">{guided.meta.n_canal_conn}</div>
                    <div className="text-[11px] text-sage-dark">{t("a gravità (canaletta)")}</div>
                  </div>
                  <div className="bg-panel rounded-lg p-2">
                    <div className="text-lg font-semibold text-brand">{guided.meta.n_pipe_conn}</div>
                    <div className="text-[11px] text-sage-dark">{t("in tubazione")}</div>
                  </div>
                </div>
                <div className="text-xs text-sage-dark bg-panel rounded-lg p-2">
                  {t("Superficie netta")}: <b>{fmt(guided.meta.net_ha, { maximumFractionDigits: 0 })} ha</b><br />
                  {guided.meta.n_along_canal} {t("lungo il canale")} · {guided.meta.n_fill} {t("riempimento")}
                </div>
              </div>
            )}
          </section>

          <section className={secShow("layout")}>
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Layout pivot")}</h3>

            <label className="text-xs text-sage-dark">{t("Configurazione")}</label>
            <div className="seg mt-1">
              <div className="seg-item" data-active={cur.layoutCfg === "square"} onClick={() => patch({ layoutCfg: "square" })}>{t("Maglia quadrata")}</div>
              <div className="seg-item" data-active={cur.layoutCfg === "staggered"} onClick={() => patch({ layoutCfg: "staggered" })}>{t("Maglia triangolare")}</div>
            </div>

            <label className="text-xs text-sage-dark mt-2 block">{t("Trasporto acqua")}</label>
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

            <div className="flex gap-2 mt-2">
              <label className="text-xs text-sage-dark flex-1">{t("Raggio pivot (m)")}
                <input type="number" min={30} max={1000} step={10} value={cur.radius}
                  onChange={(e) => patch({ radius: Number(e.target.value) })} className="field-input mt-1" /></label>
              <label className="text-xs text-sage-dark flex-1">{t("Spaziatura tra pivot (m)")}
                <input type="number" min={0} max={2000} step={10} value={cur.gap}
                  onChange={(e) => patch({ gap: Number(e.target.value) })} className="field-input mt-1" /></label>
            </div>

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

            <div className="flex gap-2 mt-2">
              <button className="btn-primary flex-1 basis-0" disabled={busy === "layout" || !hasFields} onClick={genLayout}>
                {busy === "layout" ? t("Genero…") : t("Genera layout")}
              </button>
              <button className="btn-ghost flex-1 basis-0" onClick={clearLayout}>{t("Rimuovi layout")}</button>
            </div>

            {agg.count > 0 && (
              <div className="mt-3 space-y-2">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="bg-panel rounded-lg p-2">
                    <div className="text-lg font-semibold text-brand">{agg.pivots}</div>
                    <div className="text-[11px] text-sage-dark">{t("Totale pivot")}</div>
                  </div>
                  <div className="bg-panel rounded-lg p-2">
                    <div className="text-lg font-semibold text-brand">{fmt(agg.net, { maximumFractionDigits: 0 })}</div>
                    <div className="text-[11px] text-sage-dark">{t("Totale superficie netta (ha)")}</div>
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
                          {f.lay!.n_pivots} pivot · {fmt(f.lay!.net_ha, { maximumFractionDigits: 0 })} ha · {fmt(f.lay!.water.q_total_ls, { maximumFractionDigits: 0 })} l/s
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-xs text-sage-dark bg-panel rounded-lg p-2 leading-relaxed">
                  {t("Rete totale")}: <b>{fmt(agg.pipe / 1000, { maximumFractionDigits: 1 })} km</b>
                </div>
              </div>
            )}
          </section>

          <section className={secShow("export")}>
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Esporta progetto")}</h3>
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
            <p className="hint mt-2">{t("La scheda include idoneità, layout, dimensionamento idrico, fasi e schema dell'impianto.")}</p>
          </section>

          <p className={"hint " + secShow("export")}>
            {t("Fonte: Sentinel-2 L2A / DEM Copernicus.")}
            {providerMode === "synthetic" && <><br />{t("Dati sintetici (demo) — nessun credito Copernicus consumato.")}</>}
          </p>
        </div>

        {/* Messaggi */}
        {msg && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pill-dark px-4 py-2 text-sm max-w-[80vw]">
            {msg} <button className="ml-2 opacity-70" onClick={() => setMsg("")}>✕</button>
          </div>
        )}

        {/* Revisione software */}
        <div className="absolute bottom-2 left-3 text-[11px] text-white/80">Argus Total {REV}</div>
      </div>
    </main>
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
