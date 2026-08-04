"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { MapHandle } from "@/components/MapCanvas";
import { useI18n, LANGS, type Lang } from "@/lib/i18n";
import * as api from "@/lib/api";
import type {
  Area, Client, Polygon, Project, Scene, ColorScale, SuitMeta, SuitWeights,
  LayoutMeta, LayoutConfig, Transport, PhaseOrder, LayoutParams, GeoJSONFC,
} from "@/lib/api";

// Revisione software: aggiornare a ogni versione consegnata.
const REV = "v0.4.5";

const MapCanvas = dynamic(() => import("@/components/MapCanvas"), { ssr: false });

const INDICES: { id: string; label: string }[] = [
  { id: "ndvi", label: "vegetazione" },
  { id: "ndmi", label: "umidità" },
  { id: "ndre", label: "clorofilla" },
  { id: "msi", label: "stress idrico" },
  { id: "rgb", label: "Colore reale (RGB)" },
];

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

export default function Page() {
  const { t, lang, setLang, fmt, fmtDate } = useI18n();
  const mapApi = useRef<MapHandle | null>(null);

  const [providerMode, setProviderMode] = useState<string>("");
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [clientId, setClientId] = useState<number | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);

  const [geom, setGeom] = useState<Polygon | null>(null);
  const areaHa = useMemo(() => (geom ? ringAreaHa(geom.coordinates) : 0), [geom]);

  const [index, setIndex] = useState("ndvi");
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [date, setDate] = useState<string>("");
  const [normalized, setNormalized] = useState(false);
  const [scale, setScale] = useState<ColorScale | null>(null);
  const [demInfo, setDemInfo] = useState<{ min: number; max: number; scale: ColorScale } | null>(null);

  // idoneità (M2)
  const [weights, setWeights] = useState<SuitWeights>({ slope: 0.45, vigor: 0.25, moisture: 0.15, climate: 0.15 });
  const [slopeIdeal, setSlopeIdeal] = useState(3);
  const [slopeMax, setSlopeMax] = useState(12);
  const [suit, setSuit] = useState<SuitMeta | null>(null);

  // layout pivot (M3)
  const [layoutCfg, setLayoutCfg] = useState<LayoutConfig>("staggered");
  const [radius, setRadius] = useState(400);
  const [gap, setGap] = useState(0);
  const [transport, setTransport] = useState<Transport>("buried");
  const [orientMode, setOrientMode] = useState<"auto" | "manual">("auto");
  const [azimuth, setAzimuth] = useState(0);
  const [canalFlip, setCanalFlip] = useState(false);
  const [onlySuitable, setOnlySuitable] = useState(false);
  const [minSuit, setMinSuit] = useState(60);
  const [overhang, setOverhang] = useState(0);
  const [nPhases, setNPhases] = useState(1);
  const [phaseOrder, setPhaseOrder] = useState<PhaseOrder>("canal_distance");
  const [kc, setKc] = useState(1.15);
  const [eff, setEff] = useState(0.85);
  const [hours, setHours] = useState(20);
  const [lay, setLay] = useState<LayoutMeta | null>(null);
  const [layGeo, setLayGeo] = useState<GeoJSONFC | null>(null);
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

  // ---- area ----
  function draw() { setMsg(""); mapApi.current?.draw(); }
  function clearArea() {
    mapApi.current?.clear(); mapApi.current?.clearOverlay("index"); mapApi.current?.clearOverlay("dem");
    setScenes([]); setDate(""); setScale(null); setDemInfo(null);
  }
  async function importFile(f?: File) {
    if (!f) return; setMsg("");
    try { await mapApi.current?.importFile(f); } catch (e) { showErr(e); }
  }
  async function saveArea() {
    if (!projectId) { setMsg(t("Serve un progetto selezionato per salvare l'area.")); return; }
    if (!geom) { setMsg(t("Disegna o importa prima un'area.")); return; }
    const name = prompt(t("Nome area")); if (!name) return;
    setBusy("save");
    try {
      await api.createArea({ project_id: projectId, name, geojson: geom, area_ha: Math.round(areaHa) });
      await refreshAreas(projectId); setMsg(t("Area salvata ✓"));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function loadArea(a: Area) { mapApi.current?.edit(a.geojson); setGeom(a.geojson); setMsg(""); }
  async function renameArea(a: Area) {
    const name = prompt(t("Nome area"), a.name); if (!name || name === a.name) return;
    try { await api.updateArea(a.id, { name }); if (projectId) refreshAreas(projectId); } catch (e) { showErr(e); }
  }
  async function delArea(a: Area) {
    if (!confirm(t("Eliminare \"{name}\"?", { name: a.name }))) return;
    try { await api.deleteArea(a.id); if (projectId) refreshAreas(projectId); } catch (e) { showErr(e); }
  }

  // ---- satellite ----
  async function searchScenes() {
    if (!geom) { setMsg(t("Disegna o importa prima un'area.")); return; }
    setBusy("scenes"); setMsg("");
    try {
      const s = await api.fetchScenes(geom, 12, 95);
      setScenes(s); setDate(s[0]?.date ?? "");
      if (!s.length) setMsg(t("Nessuna scena disponibile."));
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  async function showPreview() {
    if (!geom) { setMsg(t("Disegna o importa prima un'area.")); return; }
    if (!date) { setMsg(t("Cerca prima le date e selezionane una.")); return; }
    setBusy("preview"); setMsg("");
    try {
      const p = await api.fetchPreview(geom, index, date, normalized);
      mapApi.current?.showOverlay("index", p.image, p.bounds);
      setScale((p.meta.scale as ColorScale) ?? null);
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function clearPreview() { mapApi.current?.clearOverlay("index"); setScale(null); }
  async function showDem() {
    if (!geom) { setMsg(t("Disegna o importa prima un'area.")); return; }
    setBusy("dem"); setMsg("");
    try {
      const d = await api.fetchDem(geom);
      mapApi.current?.showOverlay("dem", d.image, d.bounds);
      setDemInfo({ min: Number(d.meta.elev_min), max: Number(d.meta.elev_max), scale: d.meta.scale as ColorScale });
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function clearDem() { mapApi.current?.clearOverlay("dem"); setDemInfo(null); }

  // ---- idoneità del terreno (M2) ----
  async function computeSuit() {
    if (!geom) { setMsg(t("Disegna o importa prima un'area.")); return; }
    if (!date) { setMsg(t("Cerca e scegli prima una data.")); return; }
    setBusy("suit"); setMsg("");
    try {
      const s = await api.fetchSuitability(geom, date, {
        weights, slope_ideal_pct: slopeIdeal, slope_max_pct: slopeMax,
      });
      mapApi.current?.showOverlay("suitability", s.image, s.bounds);
      setSuit(s.meta);
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function clearSuit() { mapApi.current?.clearOverlay("suitability"); setSuit(null); }
  const setW = (k: keyof SuitWeights, v: number) => setWeights((w) => ({ ...w, [k]: v }));

  // ---- layout pivot (M3) ----
  function layoutParams(): LayoutParams {
    return {
      config: layoutCfg, radius_m: radius, gap_m: gap, transport,
      auto_orient: orientMode === "auto",
      canal_azimuth_deg: orientMode === "manual" ? azimuth : null,
      canal_flip: canalFlip,
      only_suitable: onlySuitable, min_suitability: minSuit, date: date || null,
      overhang_pct: overhang, n_phases: nPhases, phase_order: phaseOrder,
      kc_peak: kc, efficiency: eff, hours_per_day: hours,
    };
  }
  async function genLayout() {
    if (!geom) { setMsg(t("Disegna o importa prima un'area.")); return; }
    setBusy("layout"); setMsg("");
    try {
      const r = await api.fetchLayout(geom, layoutParams());
      mapApi.current?.showLayout(r.geojson);
      setLay(r.meta); setLayGeo(r.geojson);
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function clearLayout() { mapApi.current?.clearLayout(); setLay(null); setLayGeo(null); }

  // ---- export progetto (M4) ----
  function saveBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function downloadPdf() {
    if (!geom) { setMsg(t("Disegna o importa prima un'area.")); return; }
    setBusy("pdf"); setMsg("");
    try {
      const pname = projects.find((p) => p.id === projectId)?.name || "Progetto";
      const cname = clients.find((c) => c.id === clientId)?.name;
      const blob = await api.downloadReport(geom, layoutParams(),
        { project_name: pname, client_name: cname, notes, include_suitability: true, lang });
      saveBlob(blob, `scheda_${pname.replace(/[^a-z0-9]+/gi, "_")}.pdf`);
    } catch (e) { showErr(e); } finally { setBusy(""); }
  }
  function downloadGeoJSON() {
    if (!layGeo) { setMsg(t("Genera prima il layout.")); return; }
    saveBlob(new Blob([JSON.stringify(layGeo)], { type: "application/geo+json" }), "layout_pivot.geojson");
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

  return (
    <main>
      <MapCanvas apiRef={mapApi} onGeom={setGeom} />

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
            <h3 className="text-sm font-semibold text-brand-darker mb-1">{t("Area di progetto")}</h3>
            <div className="flex gap-2">
              <button className="btn-primary flex-1" onClick={draw}>{t("Disegna area")}</button>
              <button className="btn-ghost" onClick={() => fileRef.current?.click()}>{t("Importa")}</button>
              <button className="btn-ghost" onClick={clearArea}>{t("Cancella area")}</button>
            </div>
            <input ref={fileRef} type="file" accept=".geojson,.json,.kml,.kmz" className="hidden"
              onChange={(e) => importFile(e.target.files?.[0] ?? undefined)} />
            <p className="hint mt-2">
              {geom ? `${t("Area acquisita ✓")} · ${fmt(areaHa, { maximumFractionDigits: 0 })} ha`
                : t("Disegna sulla mappa un'area ampia, oppure importa GeoJSON/KML/KMZ.")}
            </p>
            <button className="btn-primary w-full mt-2" disabled={busy === "save" || !geom || !projectId} onClick={saveArea}>
              {busy === "save" ? t("Salvo…") : t("Salva area nel progetto")}
            </button>
            {!!areas.length && (
              <div className="mt-3">
                <div className="text-xs font-semibold text-sage-dark mb-1">{t("Aree salvate")}</div>
                <ul className="space-y-1">
                  {areas.map((a) => (
                    <li key={a.id} className="flex items-center justify-between text-sm bg-panel rounded-lg px-2 py-1">
                      <button className="truncate text-left flex-1" title={t("Carica")} onClick={() => loadArea(a)}>
                        {a.name} <span className="text-sage">· {a.area_ha ?? "?"} ha</span>
                      </button>
                      <span className="flex gap-1 shrink-0">
                        <button className="text-xs text-brand-mid" onClick={() => renameArea(a)}>✎</button>
                        <button className="text-xs text-danger" onClick={() => delArea(a)}>✕</button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>

        {/* Pannello destro: anteprima satellitare */}
        <div className="absolute top-24 right-4 w-[440px] max-w-[calc(100vw_-_2rem)] max-h-[78vh] overflow-auto scroll-soft widget p-4 space-y-4">
          <section>
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Anteprima satellitare")}</h3>
            <label className="text-xs text-sage-dark">{t("Indice")}</label>
            <select className="field-input mt-1" value={index} onChange={(e) => setIndex(e.target.value)}>
              {INDICES.map((i) => <option key={i.id} value={i.id}>{i.id.toUpperCase()} — {t(i.label)}</option>)}
            </select>

            <button className="btn-ghost w-full mt-2" disabled={busy === "scenes" || !geom} onClick={searchScenes}>
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
                  <button className="btn-primary flex-1" disabled={busy === "preview"} onClick={showPreview}>
                    {busy === "preview" ? t("Ricompongo…") : t("Anteprima sulla mappa")}
                  </button>
                  <button className="btn-ghost" onClick={clearPreview}>{t("Rimuovi anteprima")}</button>
                </div>
                {scale && index !== "rgb" && <ScaleBar scale={scale} />}
              </>
            )}
          </section>

          <section className="border-t border-black/5 pt-3">
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Quota (DEM)")}</h3>
            <div className="flex gap-2">
              <button className="btn-primary flex-1" disabled={busy === "dem" || !geom} onClick={showDem}>
                {busy === "dem" ? t("Ricompongo…") : t("Mostra DEM")}
              </button>
              <button className="btn-ghost" onClick={clearDem}>{t("Rimuovi DEM")}</button>
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

          <section className="border-t border-black/5 pt-3">
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Idoneità del terreno")}</h3>
            <div className="text-xs text-sage-dark mb-1">{t("Pesi dei fattori")}</div>
            <WeightRow label={t("Pendenza")} v={weights.slope} onChange={(v) => setW("slope", v)} />
            <WeightRow label={t("Vigore")} v={weights.vigor} onChange={(v) => setW("vigor", v)} />
            <WeightRow label={t("Umidità")} v={weights.moisture} onChange={(v) => setW("moisture", v)} />
            <WeightRow label={t("Clima")} v={weights.climate} onChange={(v) => setW("climate", v)} />
            <div className="flex gap-2 mt-2">
              <label className="text-xs text-sage-dark flex-1">
                {t("Pendenza ideale (%)")}
                <input type="number" min={0} max={45} step={0.5} value={slopeIdeal}
                  onChange={(e) => setSlopeIdeal(Number(e.target.value))} className="field-input mt-1" />
              </label>
              <label className="text-xs text-sage-dark flex-1">
                {t("Pendenza massima (%)")}
                <input type="number" min={1} max={60} step={0.5} value={slopeMax}
                  onChange={(e) => setSlopeMax(Number(e.target.value))} className="field-input mt-1" />
              </label>
            </div>
            <div className="flex gap-2 mt-2">
              <button className="btn-primary flex-1" disabled={busy === "suit" || !geom || !date} onClick={computeSuit}>
                {busy === "suit" ? t("Calcolo…") : t("Calcola idoneità")}
              </button>
              <button className="btn-ghost" onClick={clearSuit}>{t("Rimuovi idoneità")}</button>
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
                  {t("Pendenza")}: {fmt(suit.slope.mean_pct)}% ({t("max")} {fmt(suit.slope.max_pct)}%)<br />
                  {t("ET₀ annua")}: {fmt(suit.climate.eto_year_mm)} mm · {t("Pioggia annua")}: {fmt(suit.climate.rain_year_mm)} mm<br />
                  {t("Deficit idrico")}: {fmt(suit.climate.deficit_year_mm)} mm · {t("Indice di aridità")}: {suit.climate.aridity_index != null ? fmt(suit.climate.aridity_index) : "—"}
                </div>
                {suit.cached && <p className="text-[11px] text-brand-light">↻ {t("Ricalcolo dai dati in cache: nessun consumo di quota.")}</p>}
              </div>
            )}
          </section>

          <section className="border-t border-black/5 pt-3">
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Layout pivot")}</h3>

            <label className="text-xs text-sage-dark">{t("Configurazione")}</label>
            <div className="seg mt-1">
              <div className="seg-item" data-active={layoutCfg === "square"} onClick={() => setLayoutCfg("square")}>{t("Maglia quadrata")}</div>
              <div className="seg-item" data-active={layoutCfg === "staggered"} onClick={() => setLayoutCfg("staggered")}>{t("Maglia rettangolare (sfalsata)")}</div>
            </div>

            <label className="text-xs text-sage-dark mt-2 block">{t("Trasporto acqua")}</label>
            <select className="field-input mt-1" value={transport} onChange={(e) => setTransport(e.target.value as Transport)}>
              <option value="buried">{t("Tubazioni interrate (pressione)")}</option>
              <option value="canal">{t("Canali (gravità)")}</option>
            </select>
            <p className="text-[11px] text-sage-dark mt-1">
              {transport === "canal"
                ? t("Con i canali il vincolo di pendenza è severo (max {p}%): serve terreno pianeggiante.", { p: 2 })
                : t("Con tubazioni in pressione la pendenza tollerata è maggiore (max {p}%).", { p: 12 })}
            </p>

            <div className="flex gap-2 mt-2">
              <label className="text-xs text-sage-dark flex-1">{t("Raggio pivot (m)")}
                <input type="number" min={30} max={1000} step={10} value={radius}
                  onChange={(e) => setRadius(Number(e.target.value))} className="field-input mt-1" /></label>
              <label className="text-xs text-sage-dark flex-1">{t("Spaziatura tra pivot (m)")}
                <input type="number" min={0} max={2000} step={10} value={gap}
                  onChange={(e) => setGap(Number(e.target.value))} className="field-input mt-1" /></label>
            </div>

            <label className="text-xs text-sage-dark mt-2 block">{t("Orientamento reticolo")}</label>
            <div className="seg mt-1">
              <div className="seg-item" data-active={orientMode === "auto"} onClick={() => setOrientMode("auto")}>{t("Auto (bordo più lungo)")}</div>
              <div className="seg-item" data-active={orientMode === "manual"} onClick={() => setOrientMode("manual")}>{t("Manuale (azimut)")}</div>
            </div>
            {orientMode === "manual" && (
              <label className="text-xs text-sage-dark mt-1 block">{t("Azimut canale (°)")}
                <input type="number" min={-360} max={360} step={1} value={azimuth}
                  onChange={(e) => setAzimuth(Number(e.target.value))} className="field-input mt-1" /></label>
            )}
            <label className="flex items-center gap-2 text-xs text-sage-dark mt-2">
              <input type="checkbox" checked={canalFlip} onChange={(e) => setCanalFlip(e.target.checked)} />
              {t("Canale sul bordo opposto")}
            </label>
            <label className="flex items-center gap-2 text-xs text-sage-dark mt-1">
              <input type="checkbox" checked={onlySuitable} onChange={(e) => setOnlySuitable(e.target.checked)} />
              {t("Solo su aree idonee (M2)")}
            </label>
            {onlySuitable && (
              <div className="text-[11px] text-sage-dark mt-1">
                {t("Soglia idoneità")}: {minSuit}/100
                <input type="range" min={40} max={90} step={5} value={minSuit}
                  onChange={(e) => setMinSuit(Number(e.target.value))} className="w-full accent-brand" />
                {!date && <span className="text-danger">{t("Cerca e scegli prima una data.")}</span>}
              </div>
            )}

            <div className="flex gap-2 mt-2">
              <label className="text-xs text-sage-dark flex-1">{t("Kc di punta")}
                <input type="number" min={0.3} max={1.6} step={0.05} value={kc}
                  onChange={(e) => setKc(Number(e.target.value))} className="field-input mt-1" /></label>
              <label className="text-xs text-sage-dark flex-1">{t("Efficienza impianto")}
                <input type="number" min={0.4} max={1} step={0.05} value={eff}
                  onChange={(e) => setEff(Number(e.target.value))} className="field-input mt-1" /></label>
              <label className="text-xs text-sage-dark flex-1">{t("Ore/giorno")}
                <input type="number" min={1} max={24} step={1} value={hours}
                  onChange={(e) => setHours(Number(e.target.value))} className="field-input mt-1" /></label>
            </div>

            <div className="mt-2">
              <label className="text-xs text-sage-dark">{t("Sbordo consentito")}: {overhang}%</label>
              <input type="range" min={0} max={30} step={5} value={overhang}
                onChange={(e) => setOverhang(Number(e.target.value))} className="w-full accent-brand" />
            </div>

            <div className="flex gap-2 mt-1">
              <label className="text-xs text-sage-dark flex-1">{t("Fasi di sviluppo")}
                <select className="field-input mt-1" value={nPhases} onChange={(e) => setNPhases(Number(e.target.value))}>
                  {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              {nPhases > 1 && (
                <label className="text-xs text-sage-dark flex-1">{t("Ordine fasi")}
                  <select className="field-input mt-1" value={phaseOrder} onChange={(e) => setPhaseOrder(e.target.value as PhaseOrder)}>
                    <option value="canal_distance">{t("Vicinanza al canale")}</option>
                    <option value="suitability">{t("Idoneità")}</option>
                    <option value="rows">{t("Per file")}</option>
                  </select>
                </label>
              )}
            </div>

            <div className="flex gap-2 mt-2">
              <button className="btn-primary flex-1" disabled={busy === "layout" || !geom} onClick={genLayout}>
                {busy === "layout" ? t("Genero…") : t("Genera layout")}
              </button>
              <button className="btn-ghost" onClick={clearLayout}>{t("Rimuovi layout")}</button>
            </div>

            {lay && (
              <div className="mt-3 space-y-2">
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div className="bg-panel rounded-lg p-2">
                    <div className="text-lg font-semibold text-brand">{lay.n_pivots}</div>
                    <div className="text-[11px] text-sage-dark">{t("Numero pivot")} · {lay.n_pumps} {t("Pompe")}</div>
                  </div>
                  <div className="bg-panel rounded-lg p-2">
                    <div className="text-lg font-semibold text-brand">
                      {fmt(lay.net_ha, { maximumFractionDigits: 0 })}</div>
                    <div className="text-[11px] text-sage-dark">{t("Superficie netta")} (ha)</div>
                  </div>
                </div>
                <div className="text-xs text-sage-dark bg-panel rounded-lg p-2 leading-relaxed">
                  {t("Efficienza impacchettamento")}: <b>{fmt(lay.packing_pct)}%</b> · {t("Copertura campo")}: {fmt(lay.coverage_pct)}%<br />
                  {t("Tubazione totale")}: {fmt(lay.pipe_total_m / 1000, { maximumFractionDigits: 1 })} km ({t("max")} {fmt(lay.pipe_max_m)} m)<br />
                  {t("Collettore")}: {fmt(lay.header_m / 1000, { maximumFractionDigits: 1 })} km · {t("Rete totale")}: <b>{fmt(lay.network_total_m / 1000, { maximumFractionDigits: 1 })} km</b>
                </div>
                {lay.phases.length > 1 && (
                  <div>
                    <div className="text-xs font-semibold text-sage-dark mb-1">{t("Fasi di sviluppo")}</div>
                    {lay.phases.map((p) => (
                      <div key={p.phase} className="flex items-center text-xs py-0.5">
                        <span className="inline-block w-3 h-3 rounded-sm mr-2"
                          style={{ background: ["#038037", "#20aae2", "#87bf59", "#f0b429", "#b23b1e", "#6b21a8"][(p.phase - 1) % 6] }} />
                        <span className="flex-1">{t("Fase")} {p.phase}</span>
                        <span className="text-sage-dark">{p.n_pivots} pivot · {fmt(p.net_ha, { maximumFractionDigits: 0 })} ha · {fmt(p.q_ls, { maximumFractionDigits: 0 })} l/s</span>
                      </div>
                    ))}
                  </div>
                )}
                <div>
                  <div className="text-xs font-semibold text-sage-dark mb-1">{t("Dimensionamento idrico")}</div>
                  <div className="text-xs text-sage-dark bg-panel rounded-lg p-2 leading-relaxed">
                    {t("ET₀ di punta")}: {fmt(lay.water.et0_peak_mm)} mm/g · ETc {fmt(lay.water.etc_peak_mm)} mm/g<br />
                    {t("Portata per pivot")}: {fmt(lay.water.q_pivot_ls)} l/s ({fmt(lay.water.q_pivot_m3h)} m³/h)<br />
                    {t("Portata totale")}: <b>{fmt(lay.water.q_total_ls, { maximumFractionDigits: 0 })} l/s</b> ({fmt(lay.water.q_total_m3h, { maximumFractionDigits: 0 })} m³/h)<br />
                    {t("Volume giornaliero")}: {fmt(lay.water.vol_total_day_m3, { maximumFractionDigits: 0 })} m³
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="border-t border-black/5 pt-3">
            <h3 className="text-sm font-semibold text-brand-darker mb-2">{t("Esporta progetto")}</h3>
            <label className="text-xs text-sage-dark">{t("Note (facoltative)")}
              <input className="field-input mt-1" value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder={t("es. coltura, cliente, fase")} />
            </label>
            <div className="flex gap-2 mt-2">
              <button className="btn-primary flex-1" disabled={busy === "pdf" || !geom} onClick={downloadPdf}>
                {busy === "pdf" ? t("Preparo…") : t("Scarica scheda PDF")}
              </button>
              <button className="btn-ghost" disabled={!layGeo} onClick={downloadGeoJSON}>{t("Layout GeoJSON")}</button>
            </div>
            <p className="hint mt-2">{t("La scheda include idoneità, layout, dimensionamento idrico, fasi e schema dell'impianto.")}</p>
          </section>

          <p className="hint">
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
