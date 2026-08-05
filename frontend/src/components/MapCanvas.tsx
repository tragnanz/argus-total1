"use client";
import { useEffect, useRef, type MutableRefObject } from "react";
import L from "leaflet";
import "@geoman-io/leaflet-geoman-free";
import type { Polygon, GeoJSONFC } from "@/lib/api";

export type OverlayKey = "index" | "dem" | "suitability";
export type FieldGeom = { id: number; name: string; geom: Polygon };
export type MapHandle = {
  draw: () => void;
  setFields: (fields: FieldGeom[], activeId: number | null, hidden?: number[]) => void;
  setLayerVisible: (key: "fields" | "macro" | "canal" | "layout" | "water", on: boolean) => void;
  showWater: (items: { geom: Polygon; kind: string }[]) => void;
  clearWater: () => void;
  clearAll: () => void;
  fitAll: () => void;
  flyTo: (lat: number, lon: number, zoom?: number) => void;
  showOverlay: (key: OverlayKey, url: string, bounds: [[number, number], [number, number]]) => void;
  clearOverlay: (key: OverlayKey) => void;
  showLayouts: (items: { id: number; fc: GeoJSONFC }[]) => void;
  clearLayout: () => void;
  showMacroareas: (items: { geom: Polygon; label: string }[]) => void;
  clearMacroareas: () => void;
  showCanals: (canals: { coords: number[][]; start: number[]; end: number[] }[], startLabel: string, endLabel: string) => void;
  showPending: (start: number[] | null, end: number[] | null, startLabel: string, endLabel: string) => void;
  clearCanal: () => void;
  showContours: (fc: GeoJSONFC) => void;
  clearContours: () => void;
  showReachable: (polys: { type: "Polygon"; coordinates: number[][][] }[], label: string) => void;
  clearReachable: () => void;
  locate: () => void;
  startMeasure: (cb: (text: string) => void) => void;
  stopMeasure: () => void;
  editCanal: (coords: number[][], start: number[], end: number[], waypoints: number[][],
    cb: (start: number[], end: number[], waypoints: number[][]) => void) => void;
  endCanalEdit: () => void;
  armPick: (cb: (lon: number, lat: number) => void) => void;
  disarmPick: () => void;
};

const ESRI =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
// Campo attivo (in modifica): azzurro pieno. Campi inattivi: verde tratteggiato.
const ACTIVE_STYLE = { color: "#20aae2", weight: 3, fillColor: "#20aae2", fillOpacity: 0.15 };
const IDLE_STYLE = { color: "#03a047", weight: 3, fillColor: "#038037", fillOpacity: 0.14, dashArray: "6,4" };
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
  const pendingRef = useRef<L.LayerGroup | null>(null);
  const contourRef = useRef<L.LayerGroup | null>(null);
  const reachRef = useRef<L.LayerGroup | null>(null);
  const canalEditRef = useRef<L.LayerGroup | null>(null);
  const waterRef = useRef<L.LayerGroup | null>(null);
  const pickCbRef = useRef<((lon: number, lat: number) => void) | null>(null);
  const measureRef = useRef<L.LayerGroup | null>(null);
  const measuringRef = useRef(false);
  const mptsRef = useRef<L.LatLng[]>([]);
  const mcbRef = useRef<((text: string) => void) | null>(null);

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
    waterRef.current = L.layerGroup().addTo(map);
    contourRef.current = L.layerGroup().addTo(map);
    reachRef.current = L.layerGroup().addTo(map);
    canalRef.current = L.layerGroup().addTo(map);
    canalEditRef.current = L.layerGroup().addTo(map);
    pendingRef.current = L.layerGroup().addTo(map);
    layoutRef.current = L.layerGroup().addTo(map);
    measureRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // Clic sulla mappa: misura (se attiva) oppure selezione punto (presa/finale).
    map.on("click", (e: L.LeafletMouseEvent) => {
      if (measuringRef.current) { mptsRef.current.push(e.latlng); _redrawMeasure(); return; }
      const cb = pickCbRef.current;
      if (!cb) return;
      pickCbRef.current = null;
      try { map.getContainer().style.cursor = ""; } catch { /* */ }
      cb(e.latlng.lng, e.latlng.lat);
    });

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
  // ---- misura distanze/aree ----
  function _fmtLen(m: number): string {
    return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
  }
  function _areaHa(pts: L.LatLng[]): number {
    const R = 6378137, n = pts.length;
    if (n < 3) return 0;
    let a = 0;
    for (let i = 0; i < n; i++) {
      const p1 = pts[i], p2 = pts[(i + 1) % n];
      a += ((p2.lng - p1.lng) * Math.PI / 180) *
        (2 + Math.sin(p1.lat * Math.PI / 180) + Math.sin(p2.lat * Math.PI / 180));
    }
    return Math.abs((a * R * R) / 2) / 10000;
  }
  function _redrawMeasure() {
    const map = mapRef.current, g = measureRef.current;
    if (!map || !g) return;
    g.clearLayers();
    const pts = mptsRef.current;
    if (pts.length) {
      L.polyline(pts, { color: "#f0b429", weight: 3, dashArray: "6,4" }).addTo(g);
      pts.forEach((p) => L.circleMarker(p, { radius: 4, color: "#08341c", weight: 1.5, fillColor: "#f0b429", fillOpacity: 1 }).addTo(g));
    }
    let dist = 0;
    for (let i = 1; i < pts.length; i++) dist += map.distance(pts[i - 1], pts[i]);
    let text = pts.length < 2 ? "" : _fmtLen(dist);
    if (pts.length >= 3) text += ` · ${_areaHa(pts).toFixed(1)} ha`;
    if (text && pts.length) {
      L.marker(pts[pts.length - 1], { opacity: 0, interactive: false })
        .bindTooltip(text, { permanent: true, direction: "top", className: "field-label" })
        .addTo(g).openTooltip();
    }
    mcbRef.current?.(text);
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
      setFields(fields, activeId, hidden = []) {
        const map = mapRef.current, grp = fieldsGroupRef.current;
        if (!map || !grp) return;
        const hide = new Set(hidden);
        clearActive(); grp.clearLayers();
        for (const f of fields) {
          if (hide.has(f.id)) continue;                 // campo spento: non disegnare
          if (f.id === activeId) { placeActive(f); continue; }
          const ly = L.polygon(toLatLng(f.geom.coordinates[0]), IDLE_STYLE);
          ly.on("click", () => cbRef.current.onSelect?.(f.id));
          if (f.name) ly.bindTooltip(f.name, { permanent: true, direction: "center", className: "field-label" });
          grp.addLayer(ly);
        }
      },
      setLayerVisible(key, on) {
        const map = mapRef.current; if (!map) return;
        const groups: Record<string, (L.LayerGroup | null)[]> = {
          fields: [fieldsGroupRef.current],
          macro: [macroRef.current],
          canal: [canalRef.current, pendingRef.current, canalEditRef.current],
          layout: [layoutRef.current],
          water: [waterRef.current],
        };
        for (const g of groups[key] || []) {
          if (!g) continue;
          if (on) { if (!map.hasLayer(g)) g.addTo(map); }
          else { if (map.hasLayer(g)) map.removeLayer(g); }
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
      showWater(items) {
        const map = mapRef.current, g = waterRef.current;
        if (!map || !g) return;
        g.clearLayers();
        for (const it of items) {
          const isWater = it.kind === "water";
          const ly = L.polygon(toLatLng(it.geom.coordinates[0]), {
            color: isWater ? "#0369a1" : "#0891b2",
            weight: 2, fillColor: isWater ? "#0ea5e9" : "#22d3ee",
            fillOpacity: isWater ? 0.45 : 0.3, dashArray: isWater ? undefined : "5,4",
          });
          ly.bindTooltip(isWater ? "Acqua" : "Palude", { direction: "center" });
          g.addLayer(ly);
        }
      },
      clearWater() { waterRef.current?.clearLayers(); },
      showCanals(canals, startLabel, endLabel) {
        const map = mapRef.current, g = canalRef.current;
        if (!map || !g) return;
        g.clearLayers();
        let b: L.LatLngBounds | null = null;
        const mk = (p: number[], color: string, label: string) =>
          L.circleMarker([p[1], p[0]], { radius: 6, color: "#08341c", weight: 2, fillColor: color, fillOpacity: 1 })
            .bindTooltip(label, { permanent: true, direction: "top", className: "field-label" });
        for (let i = 0; i < canals.length; i++) {
          const cc = canals[i];
          const latlngs = cc.coords.map((p) => [p[1], p[0]] as [number, number]);
          const line = L.polyline(latlngs, { color: "#0284c7", weight: 4, opacity: 0.9 });
          line.bindTooltip(`${startLabel.charAt(0)}${i + 1}`, { permanent: false, direction: "center" });
          g.addLayer(line);
          g.addLayer(mk(cc.start, "#038037", `${startLabel} ${i + 1}`));  // presa (alto)
          g.addLayer(mk(cc.end, "#b23b1e", `${endLabel} ${i + 1}`));      // sbocco (basso)
          try { const lb = line.getBounds(); if (lb.isValid()) b = b ? b.extend(lb) : L.latLngBounds(lb.getSouthWest(), lb.getNorthEast()); } catch { /* */ }
        }
        if (b && b.isValid()) map.fitBounds(b, { padding: [50, 50] });
      },
      showPending(start, end, startLabel, endLabel) {
        const g = pendingRef.current;
        if (!g) return;
        g.clearLayers();
        const mk = (p: number[], color: string, label: string) =>
          L.marker([p[1], p[0]], {
            icon: L.divIcon({
              className: "canal-pin",
              html: `<div style="background:${color};border:2px solid #fff;border-radius:50%;width:16px;height:16px;box-shadow:0 0 0 2px ${color}"></div>`,
              iconSize: [16, 16], iconAnchor: [8, 8],
            }),
          }).bindTooltip(label, { permanent: true, direction: "top", className: "field-label" });
        if (start) g.addLayer(mk(start, "#038037", startLabel));
        if (end) g.addLayer(mk(end, "#b23b1e", endLabel));
      },
      clearCanal() { canalRef.current?.clearLayers(); pendingRef.current?.clearLayers(); },
      showContours(fc) {
        const g = contourRef.current; if (!g) return;
        g.clearLayers();
        const gj = L.geoJSON(fc as never, {
          style: (f) => {
            const p = f?.properties?.principal;
            return { color: "#5a3410", weight: p ? 1.8 : 0.7, opacity: p ? 0.95 : 0.7 };
          },
          onEachFeature: (f, layer) => {
            if (f?.properties?.principal) {
              layer.bindTooltip(`${f.properties.elev} m`,
                { permanent: true, direction: "center", className: "field-label" });
            }
          },
        });
        g.addLayer(gj);
      },
      clearContours() { contourRef.current?.clearLayers(); },
      showReachable(polys, label) {
        const map = mapRef.current, g = reachRef.current;
        if (!map || !g) return;
        g.clearLayers();
        let b: L.LatLngBounds | null = null;
        for (let i = 0; i < polys.length; i++) {
          const ly = L.polygon(toLatLng(polys[i].coordinates[0]),
            { color: "#0a7d34", weight: 2, fillColor: "#22c55e", fillOpacity: 0.28, dashArray: "5,4" });
          if (i === 0 && label) ly.bindTooltip(label, { permanent: true, direction: "center", className: "field-label" });
          g.addLayer(ly);
          const gb = ly.getBounds();
          if (gb.isValid()) b = b ? b.extend(gb) : L.latLngBounds(gb.getSouthWest(), gb.getNorthEast());
        }
        if (b && b.isValid()) map.fitBounds(b, { padding: [50, 50] });
      },
      clearReachable() { reachRef.current?.clearLayers(); },
      locate() {
        const map = mapRef.current; if (!map) return;
        map.locate({ setView: true, maxZoom: 15, enableHighAccuracy: true });
        map.once("locationfound", (e: L.LocationEvent) => {
          L.circleMarker(e.latlng, { radius: 7, color: "#1d4ed8", weight: 2, fillColor: "#3b82f6", fillOpacity: 0.9 })
            .bindTooltip("GPS", { permanent: false, direction: "top" }).addTo(map);
        });
      },
      startMeasure(cb) {
        const map = mapRef.current; if (!map) return;
        mcbRef.current = cb;
        measuringRef.current = true;
        mptsRef.current = [];
        measureRef.current?.clearLayers();
        try { map.getContainer().style.cursor = "crosshair"; } catch { /* */ }
      },
      stopMeasure() {
        const map = mapRef.current;
        measuringRef.current = false;
        mptsRef.current = [];
        mcbRef.current = null;
        measureRef.current?.clearLayers();
        try { if (map) map.getContainer().style.cursor = ""; } catch { /* */ }
      },
      editCanal(coords, start, end, waypoints, cb) {
        const map = mapRef.current, g = canalEditRef.current;
        if (!map || !g) return;
        g.clearLayers();
        let s = [...start], e = [...end];
        const wps = waypoints.map((w) => [...w]);
        const fire = () => cb([...s], [...e], wps.map((w) => [...w]));
        // linea di riferimento (percorso attuale) + clic per inserire un punto
        const line = L.polyline(coords.map((p) => [p[1], p[0]] as [number, number]),
          { color: "#0284c7", weight: 4, opacity: 0.55, dashArray: "5,5" });
        g.addLayer(line);
        const pin = (color: string) => L.divIcon({
          className: "canal-handle",
          html: `<div style="background:${color};border:2px solid #fff;border-radius:50%;width:16px;height:16px;box-shadow:0 0 0 2px ${color},0 1px 3px rgba(0,0,0,.4);cursor:grab"></div>`,
          iconSize: [16, 16], iconAnchor: [8, 8],
        });
        const handle = (pt: number[], color: string, label: string, onDrag: (p: number[]) => void) => {
          const m = L.marker([pt[1], pt[0]], { draggable: true, icon: pin(color), zIndexOffset: 1000 });
          m.bindTooltip(label, { permanent: false, direction: "top" });
          m.on("dragend", () => { const ll = m.getLatLng(); onDrag([ll.lng, ll.lat]); fire(); });
          g.addLayer(m);
        };
        handle(s, "#038037", "Presa", (p) => { s = p; });
        handle(e, "#b23b1e", "Finale", (p) => { e = p; });
        wps.forEach((w, i) => handle(w, "#f0b429", `Waypoint ${i + 1}`, (p) => { wps[i] = p; }));
        // clic sulla linea: inserisci un waypoint mantenendo l'ordine presa→finale
        line.on("click", (ev: L.LeafletMouseEvent) => {
          const cl = ev.latlng;
          const ctrl = [s, ...wps, e];
          let best = 0, bestD = Infinity;
          for (let i = 0; i < ctrl.length - 1; i++) {
            const a = L.latLng(ctrl[i][1], ctrl[i][0]);
            const b = L.latLng(ctrl[i + 1][1], ctrl[i + 1][0]);
            // distanza punto-segmento in gradi (area piccola: sufficiente)
            const ax = a.lng, ay = a.lat, bx = b.lng, by = b.lat, px = cl.lng, py = cl.lat;
            const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
            let tt = ((px - ax) * dx + (py - ay) * dy) / L2; tt = Math.max(0, Math.min(1, tt));
            const qx = ax + tt * dx, qy = ay + tt * dy;
            const d = (px - qx) ** 2 + (py - qy) ** 2;
            if (d < bestD) { bestD = d; best = i; }
          }
          wps.splice(best, 0, [cl.lng, cl.lat]);
          fire();
        });
      },
      endCanalEdit() { canalEditRef.current?.clearLayers(); },
      armPick(cb) {
        pickCbRef.current = cb;
        try { if (mapRef.current) mapRef.current.getContainer().style.cursor = "crosshair"; } catch { /* */ }
      },
      disarmPick() {
        pickCbRef.current = null;
        try { if (mapRef.current) mapRef.current.getContainer().style.cursor = ""; } catch { /* */ }
      },
    };
  });

  return <div ref={elRef} className="map-root" aria-label="Mappa satellitare" />;
}
