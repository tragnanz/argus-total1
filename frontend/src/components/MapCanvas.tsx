"use client";
import { useEffect, useRef, type MutableRefObject } from "react";
import L from "leaflet";
import "@geoman-io/leaflet-geoman-free";
import type { Polygon } from "@/lib/api";
import { parseFieldsFromFile } from "@/lib/importGeo";
import type { GeoJSONFC } from "@/lib/api";

export type OverlayKey = "index" | "dem" | "suitability";
export type MapHandle = {
  draw: () => void;
  edit: (geom: Polygon) => void;
  clear: () => void;
  importFile: (file: File) => Promise<void>;
  fitTo: (geom: Polygon) => void;
  flyTo: (lat: number, lon: number, zoom?: number) => void;
  showOverlay: (key: OverlayKey, url: string, bounds: [[number, number], [number, number]]) => void;
  clearOverlay: (key: OverlayKey) => void;
  showLayout: (fc: GeoJSONFC) => void;
  clearLayout: () => void;
};

const ESRI =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const DRAFT_STYLE = { color: "#20aae2", weight: 2, fillColor: "#20aae2", fillOpacity: 0.12 };

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
  onGeom?: (g: Polygon | null) => void;
  apiRef?: MutableRefObject<MapHandle | null>;
};

export default function MapCanvas({ onGeom, apiRef }: Props) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editLayerRef = useRef<any>(null);
  const overlaysRef = useRef<Record<OverlayKey, L.ImageOverlay | null>>(
    { index: null, dem: null, suitability: null });
  const layoutRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: false, attributionControl: true, keyboard: false })
      .setView([44.6646, 10.4736], 12);
    L.tileLayer(ESRI, { maxZoom: 20, attribution: "Imagery © Esri, Maxar, Earthstar" }).addTo(map);
    L.control.zoom({ position: "bottomleft" }).addTo(map);
    layoutRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (map as any).pm?.setGlobalOptions({
      snappable: true, snapDistance: 20, allowSelfIntersection: false,
      templineStyle: DRAFT_STYLE, hintlineStyle: { color: "#20aae2", dashArray: "5,5" },
      pathOptions: DRAFT_STYLE,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    map.on("pm:create", (e: any) => {
      if (editLayerRef.current) { try { map.removeLayer(editLayerRef.current); } catch { /* */ } }
      const layer = e.layer;
      editLayerRef.current = layer;
      layer.setStyle?.(DRAFT_STYLE);
      layer.pm?.enable({ allowSelfIntersection: false });
      bindEdit(layer);
      onGeom?.(layerToPolygon(layer));
    });

    setTimeout(() => map.invalidateSize(), 50);
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function bindEdit(layer: any) {
    const sync = () => onGeom?.(layerToPolygon(layer));
    layer.on("pm:markerdragend", sync);
    layer.on("pm:vertexadded", sync);
    layer.on("pm:vertexremoved", sync);
    layer.on("pm:edit", sync);
  }
  function clearEdit() {
    const map = mapRef.current;
    if (map && editLayerRef.current) {
      try { editLayerRef.current.pm?.disable(); } catch { /* */ }
      try { map.removeLayer(editLayerRef.current); } catch { /* */ }
    }
    editLayerRef.current = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { (map as any)?.pm?.disableDraw(); } catch { /* */ }
  }
  function placeLayer(geom: Polygon) {
    const map = mapRef.current; if (!map) return;
    clearEdit();
    const layer = L.polygon(toLatLng(geom.coordinates[0]), DRAFT_STYLE).addTo(map);
    editLayerRef.current = layer;
    layer.pm?.enable({ allowSelfIntersection: false });
    bindEdit(layer);
    map.fitBounds(layer.getBounds(), { padding: [60, 60], maxZoom: 15 });
    onGeom?.(layerToPolygon(layer));
  }

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      draw() {
        const map = mapRef.current; if (!map) return;
        clearEdit(); onGeom?.(null);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (map as any).pm.enableDraw("Polygon", { allowSelfIntersection: false });
      },
      edit(geom) { placeLayer(geom); },
      clear() { clearEdit(); onGeom?.(null); },
      async importFile(f: File) {
        const fields = await parseFieldsFromFile(f);
        if (!fields.length) { alert("Nessun poligono valido nel file (GeoJSON/KML/KMZ)."); return; }
        placeLayer(fields[0].geom);
      },
      fitTo(geom) {
        mapRef.current?.fitBounds(L.latLngBounds(toLatLng(geom.coordinates[0])),
          { padding: [60, 60], maxZoom: 15 });
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
      showLayout(fc: GeoJSONFC) {
        const map = mapRef.current; const g = layoutRef.current;
        if (!map || !g) return;
        g.clearLayers();
        const PHASE = ["#038037", "#20aae2", "#87bf59", "#f0b429", "#b23b1e", "#6b21a8"];
        const gj = L.geoJSON(fc as never, {
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
        gj.addTo(g);
        try { const b = gj.getBounds(); if (b.isValid()) map.fitBounds(b, { padding: [40, 40] }); } catch { /* */ }
      },
      clearLayout() { layoutRef.current?.clearLayers(); },
    };
  });

  return <div ref={elRef} className="map-root" aria-label="Mappa satellitare" />;
}
