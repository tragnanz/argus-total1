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
        // Rispetta la visibilità impostata: i livelli nascosti NON compaiono nel link.
        const polys = areas.filter((a) => a.kind !== "macro" && !hiddenField(a.id));
        m.setFields(polys.map((a) => ({ id: a.id, name: a.name, geom: a.geojson, style: styleFor(a.id), level: levelFor(a.id) })), null, []);
        const macros = areas.filter((a) => a.kind === "macro");
        if (macros.length) m.showMacroareas(macros.map((a) => ({ geom: a.geojson, label: a.name })));

        // I pivot con le misure (raggio · ha) su ogni cerchio.
        const layers: Layer[] = data.layers || [];
        const pv = layers.filter((x) => x.kind === "pivots").map((x) => x.data).pop();
        if (pv?.geojson) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const feats = (pv.geojson.features || []).filter((f: any) => f?.properties?.kind === "pivot" && !hiddenPivot(f?.properties?.field));
          m.showLayouts([{ id: 1, fc: { type: "FeatureCollection", features: feats } }], { measures: true });
        }

        setTimeout(() => m.fitAll(), 250);
      } catch { /* ignora errori di disegno */ }
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
        <div className="absolute top-[4.5rem] left-4 w-[360px] max-w-[calc(100vw_-_2rem)] max-h-[80vh] widget flex flex-col overflow-hidden z-30">
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

        <div className="absolute bottom-1 left-3 text-[11px] text-white/80 z-10 pointer-events-none">Argus Total · by Nabu srl — Agrostar Group srl</div>
      </div>
    </main>
  );
}
