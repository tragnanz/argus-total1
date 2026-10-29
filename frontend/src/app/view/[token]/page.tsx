"use client";
// Pagina pubblica di SOLA LETTURA di un progetto Argus Total.
// Il cliente vede mappa + informazioni; nessun controllo di modifica.
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { MapHandle } from "@/components/MapCanvas";
import * as api from "@/lib/api";
import { useI18n, LANGS, type Lang } from "@/lib/i18n";

const MapCanvas = dynamic(() => import("@/components/MapCanvas"), { ssr: false });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Area = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Layer = any;

export default function ViewPage({ params }: { params: { token: string } }) {
  const { t, lang, setLang, fmt } = useI18n();
  const mapApi = useRef<MapHandle | null>(null);
  const [data, setData] = useState<api.ShareData | null>(null);
  const [err, setErr] = useState("");
  const [infoOpen, setInfoOpen] = useState(true);   // pannello informazioni richiudibile
  // ---- Commenti del cliente su questo link ----
  const [comments, setComments] = useState<api.ShareComment[]>([]);
  const [cOpen, setCOpen] = useState(true);
  const [cAuthor, setCAuthor] = useState(() => { try { return window.localStorage.getItem("argus.commentAuthor") ?? ""; } catch { return ""; } });
  const [cBody, setCBody] = useState("");
  const [cPoint, setCPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const [cBusy, setCBusy] = useState(false);
  const [cMsg, setCMsg] = useState("");
  const loadComments = () => api.listLinkComments(params.token).then(setComments).catch(() => { /* link non valido: già segnalato */ });
  useEffect(() => { loadComments(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [params.token]);
  // segnaposto dei commenti (+ quello in preparazione) sulla mappa
  useEffect(() => {
    const pins = comments.map((c, i) => ({ c, n: i + 1 })).filter((x) => x.c.lat != null && x.c.lng != null)
      .map((x) => ({ lat: x.c.lat as number, lng: x.c.lng as number, n: x.n, text: x.c.body, done: x.c.resolved }));
    if (cPoint) pins.push({ lat: cPoint.lat, lng: cPoint.lng, n: comments.length + 1, text: cBody || "…", done: false });
    // la mappa si carica in modo asincrono: riprova finché è pronta
    let tries = 0;
    const iv = setInterval(() => {
      const m = mapApi.current;
      if (m || ++tries > 50) { clearInterval(iv); m?.setCommentPins?.(pins); }
    }, 100);
    return () => clearInterval(iv);
  }, [comments, cPoint, cBody, data]);
  // Esc annulla la scelta del punto
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { mapApi.current?.pickPoint(null); setPicking(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking]);
  function startPick() {
    setPicking(true);
    mapApi.current?.pickPoint((lat, lng) => { setCPoint({ lat, lng }); setPicking(false); });
  }
  async function sendComment() {
    const body = cBody.trim(); if (!body) return;
    setCBusy(true); setCMsg("");
    try {
      try { window.localStorage.setItem("argus.commentAuthor", cAuthor.trim()); } catch { /* */ }
      await api.addLinkComment(params.token, { author: cAuthor.trim(), body, lat: cPoint?.lat ?? null, lng: cPoint?.lng ?? null });
      setCBody(""); setCPoint(null); setCMsg(t("Commento inviato ✓"));
      await loadComments();
    } catch (e) { setCMsg(e instanceof Error ? e.message : String(e)); } finally { setCBusy(false); }
  }
  const fmtWhen = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
    return d.toLocaleString(lang, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  const fmtHa = (n?: number | null) => (n == null ? "?" : `${fmt(Math.round(n))} ha`);

  useEffect(() => {
    api.fetchShare(params.token)
      .then(setData)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [params.token]);

  // Disegna tutto sulla mappa appena i dati e la mappa sono pronti.
  useEffect(() => {
    if (!data) return;
    let done = false;
    const iv = setInterval(() => {
      const m = mapApi.current;
      if (!m || done) return;
      done = true;
      clearInterval(iv);
      try {
        const areas: Area[] = data.areas || [];
        const layers0: Layer[] = data.layers || [];
        const styleLayer = layers0.filter((x) => x.kind === "styles").map((x) => x.data).pop();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cfg: any = data.config || {};
        const styleFor = (areaId: number) => styleLayer?.byArea?.[areaId];
        const levelFor = (areaId: number) => styleLayer?.levels?.[areaId] ?? "area";
        // La visibilità del LINK (config) ha la precedenza; senza config, quella salvata del progetto.
        const hiddenField = (areaId: number) => cfg.hiddenFields ? !!cfg.hiddenFields[areaId] : !!styleLayer?.hiddenFields?.[areaId];
        const hiddenPivot = (areaId: number) => cfg.hiddenPivots ? !!cfg.hiddenPivots[areaId] : !!styleLayer?.hiddenPivots?.[areaId];
        const hiddenPipe = (areaId: number) => cfg.hiddenPipes ? !!cfg.hiddenPipes[areaId] : !!styleLayer?.hiddenPipes?.[areaId];
        // Rispetta la visibilità impostata: i livelli nascosti NON compaiono nel link.
        const polys = areas.filter((a) => a.kind !== "macro" && !hiddenField(a.id));
        m.setFields(polys.map((a) => ({ id: a.id, name: a.name, geom: a.geojson, style: styleFor(a.id), level: levelFor(a.id) })), null, []);
        const macros = areas.filter((a) => a.kind === "macro");
        if (macros.length) m.showMacroareas(macros.map((a) => ({ geom: a.geojson, label: a.name })));

        // I pivot con le misure (raggio · ha) su ogni cerchio.
        const layers: Layer[] = data.layers || [];
        const pv = layers.filter((x) => x.kind === "pivots").map((x) => x.data).pop();
        if (pv?.geojson) {
          // Pivot (con le misure) + tubazioni di adduzione, ognuno secondo la
          // propria visibilità: ciò che è nascosto non compare nel link.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const feats = (pv.geojson.features || []).filter((f: any) => {
            const k = f?.properties?.kind;
            if (k === "pivot") return !hiddenPivot(f?.properties?.field);
            if (k === "pipe") return !hiddenPipe(f?.properties?.field);
            return false;
          });
          m.showLayouts([{ id: 1, fc: { type: "FeatureCollection", features: feats } }], { measures: true });
        }

        // Rilievo: canali, corsi d'acqua/invasi e strade. Vengono salvati come
        // layer di progetto ("canals" / "waters" / "roads") e finora il link
        // pubblico li ignorava: il cliente vedeva i pivot senza l'adduzione.
        // Ogni oggetto porta il proprio flag «hidden»: va rispettato.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const itemsOf = (kind: string): any[] =>
          layers.filter((x) => x.kind === kind).flatMap((x) => x.data?.items ?? []);

        const cans = itemsOf("canals").filter((c) => !c.hidden && c?.geojson?.coordinates?.length);
        if (cans.length) {
          m.showCanals(
            cans.map((c) => {
              const cs: number[][] = c.geojson.coordinates;
              // I canali tracciati a mano possono non avere presa/sbocco:
              // ripiego sui capi del tracciato invece di far fallire il disegno.
              return { coords: cs, start: c.start ?? cs[0], end: c.end ?? cs[cs.length - 1], width_m: 6 };
            }),
            t("Presa"), t("Sbocco"),
          );
        }

        const wats = itemsOf("waters").filter((w) => !w.hidden && w?.geojson);
        if (wats.length) m.showWater(wats.map((w) => ({ geom: w.geojson, kind: w.kind })));

        const rds = itemsOf("roads").filter((r) => !r.hidden && r?.coords?.length);
        if (rds.length) m.showRoads?.(rds.map((r) => ({ coords: r.coords, width_m: r.width_m })));
      } catch { /* un livello malformato non deve far sparire tutti gli altri */ }
      try { setTimeout(() => m.fitAll(), 250); } catch { /* */ }
    }, 120);
    return () => clearInterval(iv);
  }, [data]);

  // Riepilogo per il pannello informazioni (esclude i livelli nascosti).
  const areas: Area[] = data?.areas || [];
  const layers: Layer[] = data?.layers || [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const styleData: any = layers.filter((l) => l.kind === "styles").map((l) => l.data).pop();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg: any = data?.config || {};
  const isHiddenField = (id: number) => (cfg.hiddenFields ? !!cfg.hiddenFields[id] : !!styleData?.hiddenFields?.[id]);
  const roots = areas.filter((a) => a.parent_area_id == null && a.kind !== "macro" && !isHiddenField(a.id));
  const childrenOf = (id: number) => areas.filter((a) => a.parent_area_id === id && a.kind !== "macro" && !isHiddenField(a.id));
  const totalHa = roots.reduce((s, a) => s + (a.area_ha || 0), 0);
  const pv = layers.filter((l) => l.kind === "pivots").map((l) => l.data).pop();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nPivots = pv?.geojson?.features?.filter((f: any) => f?.properties?.kind === "pivot").length || 0;
  const netHa = pv?.meta?.net_ha as number | undefined;

  const stat = (label: string, value: string | number) => (
    <div className="bg-panel rounded-lg px-3 py-2">
      <div className="text-[11px] text-sage-dark">{label}</div>
      <div className="text-sm font-semibold text-brand-darker tabular-nums">{value}</div>
    </div>
  );

  return (
    <main>
      <MapCanvas apiRef={mapApi} />

      <div className="overlay-layer">
        {/* Header adattivo: marchio compatto + nome progetto troncabile + selettore lingua */}
        <div className="absolute top-3 left-3 right-3 z-30 flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-2.5 rounded-xl shadow shrink-0" style={{ background: "#123524", height: 44 }}>
            <span className="text-white font-semibold tracking-tight whitespace-nowrap">Argus&nbsp;Total</span>
            <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-white/15 text-white whitespace-nowrap">{t("Sola lettura")}</span>
          </div>
          {data && (
            <div className="pill-light px-3 h-11 flex items-center text-sm font-medium min-w-0 flex-1">
              <span className="truncate">{data.project.name}{data.project.crop ? ` · ${data.project.crop}` : ""}</span>
            </div>
          )}
          <select className="pill-light h-11 px-2 text-sm shrink-0 max-w-[7.5rem]" value={lang}
            onChange={(e) => setLang(e.target.value as Lang)} aria-label="Lingua">
            {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>

        {/* Pannello informazioni (richiudibile) */}
        <div className="absolute top-[4.5rem] left-4 w-[360px] max-w-[calc(100vw/var(--ui-scale)_-_2rem)] max-h-[calc(80vh/var(--ui-scale))] widget flex flex-col overflow-hidden z-30">
          <div className="px-4 py-2.5 flex items-center justify-between border-b border-black/5">
            <div className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide truncate">{t("Informazioni progetto")}</div>
            <button onClick={() => setInfoOpen((o) => !o)} title={infoOpen ? "–" : "+"}
              className="text-sage-dark hover:text-brand px-2 -mr-2 text-xl leading-none shrink-0">{infoOpen ? "–" : "+"}</button>
          </div>
          {infoOpen && (
            <div className="overflow-auto scroll-soft p-4 space-y-3">
              {err && <p className="text-sm text-danger">{err}</p>}
              {!data && !err && <p className="text-sm text-sage-dark">…</p>}
              {data && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    {stat(t("Campi"), roots.length)}
                    {stat(t("Superficie totale"), fmtHa(totalHa))}
                    {stat(t("Pivot"), nPivots)}
                    {stat(t("Area irrigata"), netHa != null ? fmtHa(netHa) : "—")}
                  </div>

                  <div>
                    <div className="text-xs font-semibold text-brand-darker mb-1">{t("Campi")}</div>
                    <ul className="space-y-1">
                      {roots.map((a) => (
                        <li key={a.id} className="text-sm bg-panel rounded-lg px-2 py-1">
                          <button className="text-left w-full truncate"
                            onClick={() => { const c = a.geojson?.coordinates?.[0]?.[0]; if (c) mapApi.current?.flyTo(c[1], c[0], 13); }}>
                            <span className="font-medium text-brand-darker">{a.name}</span>
                            <span className="text-sage"> · {fmtHa(a.area_ha)}</span>
                          </button>
                          {childrenOf(a.id).length > 0 && (
                            <ul className="mt-1 ml-1 border-l-2 border-brand/20 pl-2 space-y-0.5">
                              {childrenOf(a.id).map((c) => (
                                <li key={c.id} className="text-[11px] text-sage-dark truncate">↳ {c.name} · {fmtHa(c.area_ha)}</li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Pannello commenti del cliente (destra) */}
        {data && (
          <div className="absolute top-[4.5rem] right-4 w-[340px] max-w-[calc(100vw/var(--ui-scale)_-_2rem)] max-h-[calc(80vh/var(--ui-scale))] widget flex flex-col overflow-hidden z-30">
            <div className="px-4 py-2.5 flex items-center justify-between border-b border-black/5">
              <div className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide truncate">{t("Commenti")} · {comments.length}</div>
              <button onClick={() => setCOpen((o) => !o)} className="text-sage-dark hover:text-brand px-2 -mr-2 text-xl leading-none shrink-0">{cOpen ? "–" : "+"}</button>
            </div>
            {cOpen && (
              <div className="overflow-auto scroll-soft p-4 space-y-3">
                {comments.length === 0 && <p className="text-[12px] text-sage-dark">{t("Nessun commento. Scrivi qui osservazioni o richieste: le riceverà chi ha preparato il progetto.")}</p>}
                <ul className="space-y-2">
                  {comments.map((c, i) => (
                    <li key={c.id} className={"bg-panel rounded-lg px-2.5 py-2 text-[12px] " + (c.resolved ? "opacity-70" : "")}>
                      <div className="flex items-center gap-1 text-[11px] text-sage-dark">
                        <span className="font-semibold text-brand-darker">#{i + 1}</span>
                        <span className="truncate">{c.author || t("Anonimo")} · {fmtWhen(c.created_at)}</span>
                        {c.resolved && <span className="ml-auto text-brand font-medium shrink-0">✓ {t("Risolto")}</span>}
                        {c.lat != null && c.lng != null && (
                          <button className={(c.resolved ? "" : "ml-auto ") + "text-brand-mid shrink-0"} title={t("Mostra sulla mappa")}
                            onClick={() => mapApi.current?.flyTo(c.lat as number, c.lng as number, 15)}>📍</button>
                        )}
                      </div>
                      <div className="text-brand-darker whitespace-pre-wrap break-words mt-0.5">{c.body}</div>
                    </li>
                  ))}
                </ul>
                <div className="border-t border-black/5 pt-3 space-y-2">
                  <input value={cAuthor} onChange={(e) => setCAuthor(e.target.value)} maxLength={80} placeholder={t("Il tuo nome")} className="field-input text-sm" />
                  <textarea value={cBody} onChange={(e) => setCBody(e.target.value)} maxLength={2000} rows={3}
                    placeholder={t("Scrivi un commento…")} className="field-input text-sm resize-y" />
                  <div className="flex items-center gap-2">
                    {cPoint ? (
                      <span className="text-[11px] text-sage-dark flex-1">📍 {t("Punto sulla mappa")} · <button className="text-danger" onClick={() => setCPoint(null)}>{t("togli")}</button></span>
                    ) : (
                      <button className="btn-ghost flex-1 text-[12px]" onClick={picking ? () => { mapApi.current?.pickPoint(null); setPicking(false); } : startPick}>
                        {picking ? t("Clicca sulla mappa… (Esc annulla)") : t("📍 Indica un punto (facoltativo)")}
                      </button>
                    )}
                    <button className="btn-primary shrink-0" disabled={cBusy || !cBody.trim()} onClick={sendComment}>{cBusy ? "…" : t("Invia")}</button>
                  </div>
                  {cMsg && <p className="text-[11px] text-sage-dark">{cMsg}</p>}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="absolute bottom-1 left-3 text-[11px] text-white/80 z-10 pointer-events-none">Argus Total · by Nabu srl — Agrostar Group srl</div>
      </div>
    </main>
  );
}
