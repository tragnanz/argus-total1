"use client";
// Pagina pubblica di SOLA LETTURA di un progetto Argus Total.
// Il cliente vede mappa + informazioni; nessun controllo di modifica.
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { MapHandle } from "@/components/MapCanvas";
import * as api from "@/lib/api";

const MapCanvas = dynamic(() => import("@/components/MapCanvas"), { ssr: false });

const fmtHa = (n?: number | null) =>
  n == null ? "?" : `${Math.round(n).toLocaleString("it-IT")} ha`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Area = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Layer = any;

export default function ViewPage({ params }: { params: { token: string } }) {
  const mapApi = useRef<MapHandle | null>(null);
  const [data, setData] = useState<api.ShareData | null>(null);
  const [err, setErr] = useState("");

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
        const styleFor = (areaId: number) => styleLayer?.byArea?.[areaId];
        const levelFor = (areaId: number) => styleLayer?.levels?.[areaId] ?? "area";
        const hiddenField = (areaId: number) => !!styleLayer?.hiddenFields?.[areaId];
        const hiddenPivot = (areaId: number) => !!styleLayer?.hiddenPivots?.[areaId];
        // Rispetta la visibilità impostata: i livelli nascosti NON compaiono nel link.
        const polys = areas.filter((a) => a.kind !== "macro" && !hiddenField(a.id));
        m.setFields(polys.map((a) => ({ id: a.id, name: a.name, geom: a.geojson, style: styleFor(a.id), level: levelFor(a.id) })), null, []);
        const macros = areas.filter((a) => a.kind === "macro");
        if (macros.length) m.showMacroareas(macros.map((a) => ({ geom: a.geojson, label: a.name })));

        const layers: Layer[] = data.layers || [];
        const canals: Layer[] = [];
        for (const l of layers.filter((x) => x.kind === "canals")) for (const it of (l.data?.items ?? [])) if (!it.hidden) canals.push(it);
        for (const l of layers.filter((x) => x.kind === "canal")) canals.push(l.data);
        if (canals.length) m.showCanals(canals.map((c) => ({ coords: c.geojson.coordinates, start: c.start, end: c.end, width_m: c.width_m || 6 })), "Presa", "Sbocco");

        const roads: Layer[] = [];
        for (const l of layers.filter((x) => x.kind === "roads")) for (const it of (l.data?.items ?? [])) if (!it.hidden) roads.push(it);
        if (roads.length) m.showRoads(roads.map((r) => ({ coords: r.coords, width_m: r.width_m })));

        const waters: Layer[] = [];
        for (const l of layers.filter((x) => x.kind === "waters")) for (const it of (l.data?.items ?? [])) if (!it.hidden) waters.push(it);
        if (waters.length) m.showWater(waters.map((w) => ({ geom: w.geojson, kind: w.kind })));

        const pv = layers.filter((x) => x.kind === "pivots").map((x) => x.data).pop();
        if (pv?.geojson) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const feats = (pv.geojson.features || []).filter((f: any) => !hiddenPivot(f?.properties?.field));
          m.showLayouts([{ id: 1, fc: { type: "FeatureCollection", features: feats } }]);
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
  const isHiddenField = (id: number) => !!styleData?.hiddenFields?.[id];
  const roots = areas.filter((a) => a.parent_area_id == null && a.kind !== "macro" && !isHiddenField(a.id));
  const childrenOf = (id: number) => areas.filter((a) => a.parent_area_id === id && a.kind !== "macro" && !isHiddenField(a.id));
  const totalHa = roots.reduce((s, a) => s + (a.area_ha || 0), 0);
  const countItems = (kind: string) => layers.filter((l) => l.kind === kind).reduce((s, l) => s + ((l.data?.items ?? []).length || 0), 0);
  const nCanals = countItems("canals") + layers.filter((l) => l.kind === "canal").length;
  const nRoads = countItems("roads");
  const nWaters = countItems("waters");
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
        {/* Header */}
        <div className="absolute top-3 left-3 right-3 z-30 flex items-center gap-2">
          <div className="flex items-center gap-2 px-3 rounded-xl shadow" style={{ background: "#123524", height: 44 }}>
            <span className="text-white font-semibold tracking-tight">Argus Total</span>
            <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-white/15 text-white">Sola lettura</span>
          </div>
          {data && (
            <div className="pill-light px-3 h-11 flex items-center text-sm font-medium truncate">
              {data.project.name}{data.project.crop ? ` · ${data.project.crop}` : ""}
            </div>
          )}
        </div>

        {/* Pannello informazioni (sinistra) */}
        <div className="absolute top-[4.5rem] left-4 w-[360px] max-w-[calc(100vw_-_2rem)] max-h-[80vh] widget flex flex-col overflow-hidden z-30">
          <div className="px-4 pt-3 pb-2 border-b border-black/5">
            <div className="text-[11px] font-semibold text-sage-dark uppercase tracking-wide">Informazioni progetto</div>
          </div>
          <div className="overflow-auto scroll-soft p-4 space-y-3">
            {err && <p className="text-sm text-danger">Impossibile caricare il progetto: {err}</p>}
            {!data && !err && <p className="text-sm text-sage-dark">Carico il progetto…</p>}
            {data && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {stat("Campi", roots.length)}
                  {stat("Superficie totale", fmtHa(totalHa))}
                  {stat("Pivot", nPivots)}
                  {stat("Area irrigata", netHa != null ? fmtHa(netHa) : "—")}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {stat("Canali", nCanals)}
                  {stat("Strade", nRoads)}
                  {stat("Invasi", nWaters)}
                </div>

                <div>
                  <div className="text-xs font-semibold text-brand-darker mb-1">Campi</div>
                  <ul className="space-y-1">
                    {roots.map((a) => (
                      <li key={a.id} className="text-sm bg-panel rounded-lg px-2 py-1">
                        <button className="text-left w-full truncate" title="Zoom"
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

                <p className="text-[11px] text-sage-dark">Visualizzazione di sola lettura. Fonte: Sentinel-2 L2A / DEM Copernicus.</p>
              </>
            )}
          </div>
        </div>

        <div className="absolute bottom-1 left-3 text-[11px] text-white/80 z-10 pointer-events-none">Argus Total · sola lettura · by Nabu srl — Agrostar Group srl</div>
      </div>
    </main>
  );
}
