"use client";
import { useEffect, useRef, type MutableRefObject } from "react";
import L from "leaflet";
import "@geoman-io/leaflet-geoman-free";
import type { Polygon, GeoJSONFC } from "@/lib/api";

export type OverlayKey = "index" | "dem" | "suitability";
export type FieldGeom = { id: number; name: string; geom: Polygon };
export type MapHandle = {
  draw: () => void;
  setFields: (fields: FieldGeom[], activeId: number | null) => void;
  clearAll: () => void;
  fitAll: () => void;
  flyTo: (lat: number, lon: number, zoom?: number) => void;
  showOverlay: (key: OverlayKey, url: string, bounds: [[number, number], [number, number]]) => void;
  clearOverlay: (key: OverlayKey) => void;
  showLayouts: (items: { id: number; fc: GeoJSONFC }[]) => void;
  clearLayout: () => void;
  showMacroareas: (items: { geom: Polygon; label: string }[]) => void;
  clearMacroareas: () => void;
  showCanal: (coords: number[][], start: number[], end: number[], startLabel: string, endLabel: string) => void;
  clearCanal: () => void;
};

const ESRI =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
// Campo attivo (in modifica): azzurro pieno. Campi inattivi: verde tratteggiato.
const ACTIVE_STYLE = { color: "#20aae2", weight: 2, fillColor: "#20aae2", fillOpacity: 0.12 };
const IDLE_STYLE = { color: "#038037", weight: 2, fillColor: "#038037", fillOpacity: 0.06, dashArray: "5,4" };
const PHASE = ["#038037", "#20aae2", "#87bf59", "#f0b429", "#b23b1e", "#6b21a8"];

const toLatLng = (ring: number[][]) => ring.map((p) => [p[1], p[0]] as [number, number]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function layerToPolygon(layer: any): Polygon | null {
  const gj = layer.toGeoJSON();
  const g = gj?.geometry;
  if (g?.type === "Polygon") return g as Polygon;
  if (g?.type === "MultiPolygon") return { type: "Polygon", coordinates: g.coordinates[0] };
  return null;
}

type Props = {
  onCreate?: (geom: Polygon) => void;
  onEditActive?: (geom: Polygon) => void;
  onSelect?: (id: number) => void;
  apiRef?: MutableRefObject<MapHandle | null>;
};

export default function MapCanvas({ onCreate, onEditActive, onSelect, apiRef }: Props) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editLayerRef = useRef<any>(null);           // campo attivo (modificabile)
  const fieldsGroupRef = useRef<L.LayerGroup | null>(null); // campi inattivi
  const overlaysRef = useRef<Record<OverlayKey, L.ImageOverlay | null>>(
    { index: null, dem: null, suitability: null });
  const layoutRef = useRef<L.LayerGroup | null>(null);
  const macroRef = useRef<L.LayerGroup | null>(null);
  const canalRef = useRef<L.LayerGroup | null>(null);

  // Callback sempre aggiornate (la mappa viene creata una sola volta).
  const cbRef = useRef({ onCreate, onEditActive, onSelect });
  useEffect(() => { cbRef.current = { onCreate, onEditActive, onSelect }; });

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: false, attributionControl: true, keyboard: false })
      .setView([44.6646, 10.4736], 12);
    L.tileLayer(ESRI, { maxZoom: 20, attribution: "Imagery © Esri, Maxar, Earthstar" }).addTo(map);
    L.control.zoom({ position: "bottomleft" }).addTo(map);
    fieldsGroupRef.current = L.layerGroup().addTo(map);
    macroRef.current = L.layerGroup().addTo(map);
    canalRef.current = L.layerGroup().addTo(map);
    layoutRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (map as any).pm?.setGlobalOptions({
      snappable: true, snapDistance: 20, allowSelfIntersection: false,
      templineStyle: ACTIVE_STYLE, hintlineStyle: { color: "#20aae2", dashArray: "5,5" },
      pathOptions: ACTIVE_STYLE,
    });
    // Nuovo poligono disegnato: estraggo la geometria e lascio che la pagina
    // lo aggiunga come nuovo campo (poi ridisegna via setFields).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    map.on("pm:create", (e: any) => {
      const layer = e.layer;
      const poly = layerToPolygon(layer);
      try { map.removeLayer(layer); } catch { /* */ }
      if (poly) cbRef.current.onCreate?.(poly);
    });

    setTimeout(() => map.invalidateSize(), 50);
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function bindEdit(layer: any) {
    const sync = () => cbRef.current.onEditActive?.(layerToPolygon(layer)!);
    layer.on("pm:markerdragend", sync);
    layer.on("pm:vertexadded", sync);
    layer.on("pm:vertexremoved", sync);
    layer.on("pm:edit", sync);
  }
  function clearActive() {
    const map = mapRef.current;
    if (map && editLayerRef.current) {
      try { editLayerRef.current.pm?.disable(); } catch { /* */ }
      try { map.removeLayer(editLayerRef.current); } catch { /* */ }
    }
    editLayerRef.current = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { (map as any)?.pm?.disableDraw(); } catch { /* */ }
  }
  function placeActive(f: FieldGeom) {
    const map = mapRef.current; if (!map) return;
    const layer = L.polygon(toLatLng(f.geom.coordinates[0]), ACTIVE_STYLE).addTo(map);
    if (f.name) layer.bindTooltip(f.name, { permanent: true, direction: "center", className: "field-label" });
    editLayerRef.current = layer;
    layer.pm?.enable({ allowSelfIntersection: false });
    bindEdit(layer);
  }
  function allBounds(): L.LatLngBounds | null {
    let b: L.LatLngBounds | null = null;
    const add = (ly: L.Layer) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gb = (ly as any).getBounds?.();
      if (gb && gb.isValid()) b = b ? b.extend(gb) : L.latLngBounds(gb.getSouthWest(), gb.getNorthEast());
    };
    fieldsGroupRef.current?.eachLayer(add);
    if (editLayerRef.current) add(editLayerRef.current);
    return b;
  }

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      draw() {
        const map = mapRef.current; if (!map) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (map as any).pm.enableDraw("Polygon", { allowSelfIntersection: false });
      },
      setFields(fields, activeId) {
        const map = mapRef.current, grp = fieldsGroupRef.current;
        if (!map || !grp) return;
        clearActive(); grp.clearLayers();
        for (const f of fields) {
          if (f.id === activeId) { placeActive(f); continue; }
          const ly = L.polygon(toLatLng(f.geom.coordinates[0]), IDLE_STYLE);
          ly.on("click", () => cbRef.current.onSelect?.(f.id));
          if (f.name) ly.bindTooltip(f.name, { permanent: true, direction: "center", className: "field-label" });
          grp.addLayer(ly);
        }
      },
      clearAll() { clearActive(); fieldsGroupRef.current?.clearLayers(); },
      fitAll() {
        const b = allBounds();
        if (b) mapRef.current?.fitBounds(b, { padding: [60, 60], maxZoom: 15 });
      },
      flyTo(lat, lon, zoom = 13) { mapRef.current?.flyTo([lat, lon], zoom, { duration: 0.8 }); },
      showOverlay(key, url, bounds) {
        const map = mapRef.current; if (!map) return;
        const prev = overlaysRef.current[key];
        if (prev) { map.removeLayer(prev); }
        const b = L.latLngBounds(bounds);
        const ov = L.imageOverlay(url, b, { opacity: 0.82, interactive: false }).addTo(map);
        overlaysRef.current[key] = ov;
        if (b.isValid()) map.fitBounds(b, { padding: [40, 40] });
      },
      clearOverlay(key) {
        const map = mapRef.current; const ov = overlaysRef.current[key];
        if (map && ov) { map.removeLayer(ov); overlaysRef.current[key] = null; }
      },
      showLayouts(items) {
        const map = mapRef.current; const g = layoutRef.current;
        if (!map || !g) return;
        g.clearLayers();
        let lb: L.LatLngBounds | null = null;
        for (const it of items) {
          const gj = L.geoJSON(it.fc as never, {
            style: (f) => {
              const k = f?.properties?.kind;
              if (k === "pivot") {
                const ph = Number(f?.properties?.phase ?? 1);
                const col = PHASE[(ph - 1) % PHASE.length];
                return { color: "#0d3b26", weight: 1, fillColor: col, fillOpacity: 0.30 };
              }
              if (k === "pipe") return { color: "#20aae2", weight: 2 };
              if (k === "header") return { color: "#b23b1e", weight: 3 };
              if (k === "canal") return { color: "#0284c7", weight: 3, dashArray: "6,4" };
              return {};
            },
            pointToLayer: (f, latlng) =>
              L.circleMarker(latlng, { radius: 4, color: "#08341c", weight: 1.5, fillColor: "#ffffff", fillOpacity: 1 }),
          });
          g.addLayer(gj);
          try { const gb = gj.getBounds(); if (gb.isValid()) lb = lb ? lb.extend(gb) : L.latLngBounds(gb.getSouthWest(), gb.getNorthEast()); } catch { /* */ }
        }
        if (lb && lb.isValid()) map.fitBounds(lb, { padding: [40, 40] });
      },
      clearLayout() { layoutRef.current?.clearLayers(); },
      showMacroareas(items) {
        const map = mapRef.current, g = macroRef.current;
        if (!map || !g) return;
        g.clearLayers();
        let b: L.LatLngBounds | null = null;
        for (const it of items) {
          const ly = L.polygon(toLatLng(it.geom.coordinates[0]),
            { color: "#f0b429", weight: 2, fillColor: "#f0b429", fillOpacity: 0.18, dashArray: "6,4" });
          if (it.label) ly.bindTooltip(it.label, { permanent: true, direction: "center", className: "field-label" });
          g.addLayer(ly);
          const gb = ly.getBounds();
          if (gb.isValid()) b = b ? b.extend(gb) : L.latLngBounds(gb.getSouthWest(), gb.getNorthEast());
        }
        if (b && b.isValid()) map.fitBounds(b, { padding: [40, 40] });
      },
      clearMacroareas() { macroRef.current?.clearLayers(); },
      showCanal(coords, start, end, startLabel, endLabel) {
        const map = mapRef.current, g = canalRef.current;
        if (!map || !g) return;
        g.clearLayers();
        const latlngs = coords.map((p) => [p[1], p[0]] as [number, number]);
        const line = L.polyline(latlngs, { color: "#0284c7", weight: 4, opacity: 0.9 });
        g.addLayer(line);
        const mk = (p: number[], color: string, label: string) =>
          L.circleMarker([p[1], p[0]], { radius: 6, color: "#08341c", weight: 2, fillColor: color, fillOpacity: 1 })
            .bindTooltip(label, { permanent: true, direction: "top", className: "field-label" });
        g.addLayer(mk(start, "#038037", startLabel));   // presa (alto)
        g.addLayer(mk(end, "#b23b1e", endLabel));        // sbocco (basso)
        try { const b = line.getBounds(); if (b.isValid()) map.fitBounds(b, { padding: [50, 50] }); } catch { /* */ }
      },
      clearCanal() { canalRef.current?.clearLayers(); },
    };
  });

  return <div ref={elRef} className="map-root" aria-label="Mappa satellitare" />;
}
