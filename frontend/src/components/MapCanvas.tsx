"use client";
import { useEffect, useRef, type MutableRefObject } from "react";
import L from "leaflet";
import "@geoman-io/leaflet-geoman-free";
import type { Polygon, GeoJSONFC } from "@/lib/api";

export type OverlayKey = "index" | "dem" | "suitability";
export type FieldStyle = { color?: string; fillColor?: string; fillOpacity?: number; weight?: number };
export type FieldGeom = { id: number; name: string; geom: Polygon; style?: FieldStyle; level?: "area" | "campo" };
// Modello pivot interattivo (gerarchia gruppo → singolo)
export type PivotItem = { lat: number; lng: number; r: number; conn?: string; field?: number; unconn?: boolean };
export type PivotModel = { pivots: PivotItem[]; lines: { kind: string; coords: number[][] }[] };
export type PivotSel = { mode: "none" | "group" | "single"; idx: number };
export type PivotCbs = {
  onClick: (idx: number) => void;
  onMove: (idx: number, lat: number, lng: number) => void;
  onBackground: () => void;
  onLineClick?: (idx: number) => void;   // clic su una tubazione (per modificarla)
};
export type MapHandle = {
  draw: () => void;
  setFields: (fields: FieldGeom[], activeId: number | null, hidden?: number[]) => void;
  setLayerVisible: (key: "fields" | "macro" | "canal" | "layout" | "water" | "strade", on: boolean) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  showWater: (items: { geom: { type: string; coordinates: any }; kind: string }[]) => void;
  clearWater: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  previewWater: (items: { geom: { type: string; coordinates: any }; kind: string }[]) => void;
  waterDraw: (kind: "river" | "basin") => void;
  waterRemoveMode: (on: boolean) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  confirmWater: () => { kind: string; geom: { type: string; coordinates: any } }[];
  cancelWater: () => void;
  clearAll: () => void;
  fitAll: () => void;
  flyTo: (lat: number, lon: number, zoom?: number) => void;
  showOverlay: (key: OverlayKey, url: string, bounds: [[number, number], [number, number]]) => void;
  clearOverlay: (key: OverlayKey) => void;
  showLayouts: (items: { id: number; fc: GeoJSONFC }[], opts?: { measures?: boolean }) => void;
  clearLayout: () => void;
  showPivots: (model: PivotModel, sel: PivotSel, cbs: PivotCbs, pipeSel?: PivotSel, waterLines?: number[][][]) => void;
  editPipe: (coords: number[][], cb: (coords: number[][]) => void, snap?: number[][], snapLines?: number[][][],
    labels?: { pivot: string; canal: string; free: string }) => void;
  endPipeEdit: () => void;
  clearPivots: () => void;
  showRoads: (roads: { coords: number[][]; width_m?: number }[], onRemove?: (i: number) => void) => void;
  drawRoadManual: (cb: (coords: number[][]) => void) => void;
  clearRoads: () => void;
  showMacroareas: (items: { geom: Polygon; label: string }[]) => void;
  clearMacroareas: () => void;
  showCanals: (canals: { coords: number[][]; start: number[]; end: number[]; width_m?: number }[], startLabel: string, endLabel: string) => void;
  showPending: (start: number[] | null, end: number[] | null, startLabel: string, endLabel: string) => void;
  clearCanal: () => void;
  showContours: (fc: GeoJSONFC) => void;
  clearContours: () => void;
  showReachable: (polys: { type: "Polygon"; coordinates: number[][][] }[], label: string) => void;
  clearReachable: () => void;
  locate: () => void;
  startMeasure: (cb: (text: string) => void) => void;
  stopMeasure: () => void;
  startElevation: (cb: (coords: number[][]) => void) => void;
  stopElevation: () => void;
  setElevationLabels: (labels: string[]) => void;
  setUnits: (imperial: boolean) => void;
  editCanal: (coords: number[][], start: number[], end: number[], waypoints: number[][],
    cb: (start: number[], end: number[], waypoints: number[][]) => void) => void;
  endCanalEdit: () => void;
  drawCanalManual: (cb: (coords: number[][]) => void) => void;
  drawPipeManual: (cb: (coords: number[][]) => void, snap?: number[][], snapLines?: number[][][]) => void;
  drawUndo: () => void;      // rimuove l'ultimo punto tracciato
  drawFinish: () => void;    // chiude/conclude il tracciato in corso
  drawCancel: () => void;    // annulla e chiude la modalità disegno
  armPick: (cb: (lon: number, lat: number) => void) => void;
  disarmPick: () => void;
  setBasemap: (kind: "sat" | "street" | "topo") => void;   // mappa di base
  setMapLabels: (on: boolean) => void;                      // etichette (confini e nomi)
};

const ESRI =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
// Mappe di base alternative + strato di sole etichette (confini e nomi) da
// sovrapporre al satellite, che di suo non ne ha.
const BASEMAPS: Record<string, { url: string; attr: string; max: number }> = {
  sat: { url: ESRI, attr: "Imagery © Esri, Maxar, Earthstar", max: 20 },
  street: { url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", attr: "© OpenStreetMap", max: 19 },
  topo: { url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", attr: "© OpenTopoMap, © OpenStreetMap", max: 17 },
};
const LABELS_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
// Campo attivo (in modifica): azzurro pieno. Campi inattivi: verde tratteggiato.
const ACTIVE_STYLE = { color: "#20aae2", weight: 3, fillColor: "#20aae2", fillOpacity: 0.15 };
const IDLE_STYLE = { color: "#03a047", weight: 3, fillColor: "#038037", fillOpacity: 0.14, dashArray: "6,4" };
// Stili predefiniti per LIVELLO della piramide: AREA (utente, ambra tratteggiata,
// è il contenitore) vs CAMPO (generato dal sistema, verde pieno, è l'operativo).
const AREA_STYLE = { color: "#e8973d", weight: 3, fillColor: "#e8973d", fillOpacity: 0.08, dashArray: "6,5" };
const CAMPO_STYLE = { color: "#03a047", weight: 3, fillColor: "#038037", fillOpacity: 0.16 };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveFieldStyle(f: FieldGeom): any {
  const base = f.level === "campo" ? CAMPO_STYLE : AREA_STYLE;
  return { ...base, ...(f.style || {}) };
}
const PHASE = ["#038037", "#20aae2", "#87bf59", "#f0b429", "#b23b1e", "#6b21a8"];

const toLatLng = (ring: number[][]) => ring.map((p) => [p[1], p[0]] as [number, number]);
// Rettangoli (per-segmento) che rappresentano lo SPESSORE reale di una polilinea
// [lon,lat] larga width_m: la banda scala con lo zoom come ogni poligono.
function _bandRects(coords: number[][], widthM: number): [number, number][][] {
  const rects: [number, number][][] = [];
  if (!(widthM > 0) || coords.length < 2) return rects;
  const hw = widthM / 2;
  for (let i = 1; i < coords.length; i++) {
    const [lo0, la0] = coords[i - 1], [lo1, la1] = coords[i];
    const latm = (la0 + la1) / 2;
    const mLat = 111320, mLng = 111320 * Math.cos((latm * Math.PI) / 180) || 1e-9;
    const vx = (lo1 - lo0) * mLng, vy = (la1 - la0) * mLat;
    const L2 = Math.hypot(vx, vy) || 1e-9;
    const px = -vy / L2, py = vx / L2;                 // perpendicolare (metri)
    const oLng = (px * hw) / mLng, oLat = (py * hw) / mLat;
    rects.push([
      [la0 + oLat, lo0 + oLng], [la1 + oLat, lo1 + oLng],
      [la1 - oLat, lo1 - oLng], [la0 - oLat, lo0 - oLng],
    ]);
  }
  return rects;
}
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
  onCanalProfile?: (index: number) => void;
  onDrawChange?: (active: boolean) => void;   // disegno geoman avviato/terminato → mostra il pannellino
  apiRef?: MutableRefObject<MapHandle | null>;
};

export default function MapCanvas({ onCreate, onEditActive, onSelect, onCanalProfile, onDrawChange, apiRef }: Props) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editLayerRef = useRef<any>(null);           // campo attivo (modificabile)
  const fieldsGroupRef = useRef<L.LayerGroup | null>(null); // campi inattivi
  const overlaysRef = useRef<Record<OverlayKey, L.ImageOverlay | null>>(
    { index: null, dem: null, suitability: null });
  const layoutRef = useRef<L.LayerGroup | null>(null);
  const pivotsRef = useRef<L.LayerGroup | null>(null);
  const pivotBgRef = useRef<(() => void) | null>(null);
  const macroRef = useRef<L.LayerGroup | null>(null);
  const canalRef = useRef<L.LayerGroup | null>(null);
  const pendingRef = useRef<L.LayerGroup | null>(null);
  const contourRef = useRef<L.LayerGroup | null>(null);
  const reachRef = useRef<L.LayerGroup | null>(null);
  const canalEditRef = useRef<L.LayerGroup | null>(null);
  const waterRef = useRef<L.LayerGroup | null>(null);
  const waterPreviewRef = useRef<L.FeatureGroup | null>(null);
  const drawModeRef = useRef<"river" | "basin" | "canal-manual" | "road-manual" | "pipe-manual" | null>(null);
  const roadsRef = useRef<L.LayerGroup | null>(null);
  const roadManualCbRef = useRef<((coords: number[][]) => void) | null>(null);
  const waterRemoveRef = useRef(false);
  const canalManualCbRef = useRef<((coords: number[][]) => void) | null>(null);
  const pipeManualCbRef = useRef<((coords: number[][]) => void) | null>(null);
  const pipeSnapRef = useRef<{ pts: number[][]; lines: number[][][] }>({ pts: [], lines: [] });
  const pickCbRef = useRef<((lon: number, lat: number) => void) | null>(null);
  const measureRef = useRef<L.LayerGroup | null>(null);
  const measuringRef = useRef(false);
  const mptsRef = useRef<L.LatLng[]>([]);
  const mcbRef = useRef<((text: string) => void) | null>(null);
  const elevRef = useRef<L.LayerGroup | null>(null);
  const elevingRef = useRef(false);
  const eptsRef = useRef<L.LatLng[]>([]);
  const ecbRef = useRef<((coords: number[][]) => void) | null>(null);
  const elabelsRef = useRef<string[]>([]);
  const imperialRef = useRef(false);

  // Callback sempre aggiornate (la mappa viene creata una sola volta).
  const baseRef = useRef<L.TileLayer | null>(null);
  const labelsRef = useRef<L.TileLayer | null>(null);
  const cbRef = useRef({ onCreate, onEditActive, onSelect, onCanalProfile, onDrawChange });
  useEffect(() => { cbRef.current = { onCreate, onEditActive, onSelect, onCanalProfile, onDrawChange }; });

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: false, attributionControl: true, keyboard: false })
      .setView([44.6646, 10.4736], 12);
    baseRef.current = L.tileLayer(BASEMAPS.sat.url, { maxZoom: BASEMAPS.sat.max, attribution: BASEMAPS.sat.attr }).addTo(map);
    L.control.zoom({ position: "bottomleft" }).addTo(map);
    fieldsGroupRef.current = L.layerGroup().addTo(map);
    macroRef.current = L.layerGroup().addTo(map);
    waterRef.current = L.layerGroup().addTo(map);
    waterPreviewRef.current = L.featureGroup().addTo(map);
    contourRef.current = L.layerGroup().addTo(map);
    reachRef.current = L.layerGroup().addTo(map);
    canalRef.current = L.layerGroup().addTo(map);
    canalEditRef.current = L.layerGroup().addTo(map);
    pendingRef.current = L.layerGroup().addTo(map);
    layoutRef.current = L.layerGroup().addTo(map);
    roadsRef.current = L.layerGroup().addTo(map);
    pivotsRef.current = L.layerGroup().addTo(map);
    measureRef.current = L.layerGroup().addTo(map);
    elevRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // Clic sulla mappa: misura (se attiva) oppure selezione punto (presa/finale).
    map.on("click", (e: L.LeafletMouseEvent) => {
      if (measuringRef.current) { mptsRef.current.push(e.latlng); _redrawMeasure(); return; }
      if (elevingRef.current) {
        eptsRef.current.push(e.latlng);
        elabelsRef.current = [];
        _redrawElev();
        ecbRef.current?.(eptsRef.current.map((p) => [p.lng, p.lat]));
        return;
      }
      const cb = pickCbRef.current;
      if (!cb) {
        // Clic sullo sfondo: deseleziona il gruppo/pivot corrente.
        if (pivotBgRef.current) pivotBgRef.current();
        return;
      }
      pickCbRef.current = null;
      try { map.getContainer().style.cursor = ""; } catch { /* */ }
      cb(e.latlng.lng, e.latlng.lat);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (map as any).pm?.setGlobalOptions({
      snappable: true, snapDistance: 22, snapSegment: true, allowSelfIntersection: false,
      templineStyle: ACTIVE_STYLE, hintlineStyle: { color: "#20aae2", dashArray: "5,5" },
      pathOptions: ACTIVE_STYLE,
    });
    // Segnala alla pagina l'inizio/fine di un disegno geoman (per il pannellino).
    map.on("pm:drawstart", () => { try { cbRef.current.onDrawChange?.(true); } catch { /* */ } });
    map.on("pm:drawend", () => { try { cbRef.current.onDrawChange?.(false); } catch { /* */ } });
    // Nuovo poligono disegnato: estraggo la geometria e lascio che la pagina
    // lo aggiunga come nuovo campo (poi ridisegna via setFields).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    map.on("pm:create", (e: any) => {
      const layer = e.layer;
      const dm = drawModeRef.current;
      if (dm === "canal-manual") {                     // canale tracciato a mano
        const lls = (layer.getLatLngs?.() || []) as any[];
        const coords = lls.map((p: any) => [p.lng, p.lat]);
        try { map.removeLayer(layer); } catch { /* */ }
        drawModeRef.current = null;
        try { (map as any).pm.disableDraw(); } catch { /* */ }
        const cb = canalManualCbRef.current; canalManualCbRef.current = null;
        if (coords.length >= 2) cb?.(coords);
        return;
      }
      if (dm === "pipe-manual") {                       // tubazione tracciata a mano
        const lls = (layer.getLatLngs?.() || []) as any[];
        // I punti cliccati si agganciano ai centri dei pivot e al canale, come
        // in modifica: una tubazione disegnata a mano nasce già collegata.
        const snapOne = (lng: number, lat: number): [number, number] => {
          const here = map.latLngToContainerPoint([lat, lng]);
          let best: [number, number] = [lng, lat], bd = 22, kind = 0;
          for (const q of pipeSnapRef.current.pts) {
            const c = map.latLngToContainerPoint([q[1], q[0]]);
            const d = Math.hypot(c.x - here.x, c.y - here.y);
            if (d < bd) { bd = d; best = [q[0], q[1]]; kind = 1; }
          }
          if (kind === 1) return best;
          for (const ln of pipeSnapRef.current.lines) {
            for (let i = 0; i < ln.length - 1; i++) {
              const a = map.latLngToContainerPoint([ln[i][1], ln[i][0]]);
              const b = map.latLngToContainerPoint([ln[i + 1][1], ln[i + 1][0]]);
              const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-9;
              let t = ((here.x - a.x) * dx + (here.y - a.y) * dy) / l2; t = Math.max(0, Math.min(1, t));
              const qx = a.x + dx * t, qy = a.y + dy * t;
              const d = Math.hypot(qx - here.x, qy - here.y);
              if (d < bd) { bd = d; const ll = map.containerPointToLatLng([qx, qy] as unknown as L.PointExpression); best = [ll.lng, ll.lat]; }
            }
          }
          return best;
        };
        const coords = lls.map((p: any) => snapOne(p.lng, p.lat));
        try { map.removeLayer(layer); } catch { /* */ }
        drawModeRef.current = null;
        try { (map as any).pm.disableDraw(); } catch { /* */ }
        const cb = pipeManualCbRef.current; pipeManualCbRef.current = null;
        if (coords.length >= 2) cb?.(coords);
        return;
      }
      if (dm === "road-manual") {                       // strada tracciata a mano
        const lls = (layer.getLatLngs?.() || []) as any[];
        const coords = lls.map((p: any) => [p.lng, p.lat]);
        try { map.removeLayer(layer); } catch { /* */ }
        drawModeRef.current = null;
        try { (map as any).pm.disableDraw(); } catch { /* */ }
        const cb = roadManualCbRef.current; roadManualCbRef.current = null;
        if (coords.length >= 2) cb?.(coords);
        return;
      }
      if (dm === "river" || dm === "basin") {         // nuovo corso d'acqua (anteprima)
        (layer as any)._wcKind = dm;
        try { layer.setStyle?.({ color: "#0369a1", weight: 3, dashArray: "4,3", fillOpacity: 0.2 }); } catch { /* */ }
        layer.on("click", () => { if (waterRemoveRef.current) waterPreviewRef.current?.removeLayer(layer); });
        waterPreviewRef.current?.addLayer(layer);
        try { (layer as any).pm?.enable({ allowSelfIntersection: false }); } catch { /* */ }
        drawModeRef.current = null;
        try { (map as any).pm.disableDraw(); } catch { /* */ }
        return;
      }
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
    // Selezionato: mantiene il colore del livello/personalizzato, con perimetro più marcato.
    const st = resolveFieldStyle(f);
    const layer = L.polygon(toLatLng(f.geom.coordinates[0]), { ...st, weight: (st.weight || 3) + 2, fillOpacity: Math.min(0.4, (st.fillOpacity ?? 0.14) + 0.08) }).addTo(map);
    if (f.name) layer.bindTooltip(f.name, { permanent: true, direction: "center", className: "field-label" });
    editLayerRef.current = layer;
    layer.pm?.enable({ allowSelfIntersection: false });
    bindEdit(layer);
  }
  // ---- misura distanze/aree ----
  function _fmtLen(m: number): string {
    if (imperialRef.current) {
      const ft = m * 3.28084;
      return ft >= 5280 ? `${(ft / 5280).toFixed(2)} mi` : `${Math.round(ft)} ft`;
    }
    return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
  }
  function _fmtArea(ha: number): string {
    return imperialRef.current ? `${(ha * 2.47105).toFixed(1)} ac` : `${ha.toFixed(1)} ha`;
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
    if (pts.length >= 3) text += ` · ${_fmtArea(_areaHa(pts))}`;
    if (text && pts.length) {
      L.marker(pts[pts.length - 1], { opacity: 0, interactive: false })
        .bindTooltip(text, { permanent: true, direction: "top", className: "field-label" })
        .addTo(g).openTooltip();
    }
    mcbRef.current?.(text);
  }

  function _redrawElev() {
    const g = elevRef.current; if (!g) return;
    g.clearLayers();
    const pts = eptsRef.current;
    if (pts.length >= 2) L.polyline(pts, { color: "#b23b1e", weight: 3 }).addTo(g);
    pts.forEach((p, i) => {
      L.circleMarker(p, { radius: 5, color: "#ffffff", weight: 2, fillColor: "#b23b1e", fillOpacity: 1 }).addTo(g);
      const lbl = elabelsRef.current[i];
      L.marker(p, { opacity: 0, interactive: false })
        .bindTooltip(lbl || `${i + 1}`, { permanent: true, direction: "top", className: "field-label" })
        .addTo(g).openTooltip();
    });
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
          const ly = L.polygon(toLatLng(f.geom.coordinates[0]), resolveFieldStyle(f));
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
          layout: [layoutRef.current, pivotsRef.current],
          water: [waterRef.current],
          strade: [roadsRef.current],
        };
        for (const g of groups[key] || []) {
          if (!g) continue;
          if (on) { if (!map.hasLayer(g)) g.addTo(map); }
          else { if (map.hasLayer(g)) map.removeLayer(g); }
        }
      },
      clearAll() { clearActive(); fieldsGroupRef.current?.clearLayers(); pivotsRef.current?.clearLayers(); pivotBgRef.current = null; },
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
      showLayouts(items, opts) {
        const map = mapRef.current; const g = layoutRef.current;
        if (!map || !g) return;
        g.clearLayers();
        const measures = !!opts?.measures;
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onEachFeature: measures ? (feat: any, layer: any) => {
              if (feat?.properties?.kind !== "pivot") return;
              try {
                const ring = feat.geometry?.coordinates?.[0] || [];
                const pts = ring.slice(0, -1);
                if (pts.length < 3) return;
                let sx = 0, sy = 0; for (const p of pts) { sx += p[0]; sy += p[1]; }
                const lon = sx / pts.length, lat = sy / pts.length;
                const mLat = 111320, mLng = 111320 * Math.cos((lat * Math.PI) / 180) || 1e-9;
                let sr = 0; for (const p of pts) { const dx = (p[0] - lon) * mLng, dy = (p[1] - lat) * mLat; sr += Math.hypot(dx, dy); }
                const r = Math.round(sr / pts.length);
                const ha = Math.PI * r * r / 10000;
                layer.bindTooltip(`R ${r} m · ${ha.toFixed(0)} ha`, { permanent: true, direction: "center", className: "pivot-measure" });
              } catch { /* */ }
            } : undefined,
          });
          g.addLayer(gj);
          try { const gb = gj.getBounds(); if (gb.isValid()) lb = lb ? lb.extend(gb) : L.latLngBounds(gb.getSouthWest(), gb.getNorthEast()); } catch { /* */ }
        }
        if (lb && lb.isValid()) map.fitBounds(lb, { padding: [40, 40] });
      },
      clearLayout() { layoutRef.current?.clearLayers(); pivotsRef.current?.clearLayers(); pivotBgRef.current = null; },
      showPivots(model, sel, cbs, pipeSel, waterLines) {
        const map = mapRef.current; const g = pivotsRef.current;
        if (!map || !g) return;
        g.clearLayers();
        pivotBgRef.current = cbs.onBackground;
        // Adduzione: le TUBAZIONI sono cliccabili (si possono modificare una per
        // una); le altre linee restano di sfondo, non interattive.
        // Tubazioni: selezione a due tempi come i pivot — primo clic = gruppo
        // (tutte evidenziate), secondo clic = la singola, che entra in modifica.
        const pipeGroup = pipeSel && (pipeSel.mode === "group" || pipeSel.mode === "single");

        // ---- Chi è ALIMENTATO ----------------------------------------------
        // Una tubazione ha acqua se tocca il canale OPPURE se tocca un'altra
        // tubazione che ce l'ha: l'alimentazione si propaga lungo la rete. Il
        // calcolo è in METRI, così non dipende dallo zoom.
        const lat0 = model.pivots.length ? model.pivots[0].lat : (model.lines[0]?.coords[0]?.[1] ?? 0);
        const mLat = 111320, mLng = 111320 * Math.cos((lat0 * Math.PI) / 180) || 1e-9;
        const toM = (q: number[]): [number, number] => [q[0] * mLng, q[1] * mLat];
        const TOUCH = 15;   // metri
        const dPtSeg = (p: [number, number], a: [number, number], b: [number, number]) => {
          const vx = b[0] - a[0], vy = b[1] - a[1]; const l2 = vx * vx + vy * vy || 1e-9;
          let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2; t = Math.max(0, Math.min(1, t));
          return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
        };
        const touchesLine = (pts: [number, number][], ln2: [number, number][]) => {
          for (const p of pts) for (let i = 0; i < ln2.length - 1; i++) if (dPtSeg(p, ln2[i], ln2[i + 1]) < TOUCH) return true;
          return false;
        };
        const pipeIdx = model.lines.map((l, i) => ({ l, i })).filter((x) => x.l.kind === "pipe").map((x) => x.i);
        const pipeM = new Map<number, [number, number][]>();
        for (const i of pipeIdx) pipeM.set(i, model.lines[i].coords.map(toM));
        const waterM = (waterLines ?? []).map((ln2) => ln2.map(toM));
        const fedPipe = new Set<number>();
        for (const i of pipeIdx) {
          const pm = pipeM.get(i) as [number, number][];
          if (waterM.some((w) => touchesLine(pm, w))) fedPipe.add(i);
        }
        for (let pass = 0; pass < 8; pass++) {
          let grew = false;
          for (const i of pipeIdx) {
            if (fedPipe.has(i)) continue;
            const pm = pipeM.get(i) as [number, number][];
            for (const j of fedPipe) {
              const qm = pipeM.get(j) as [number, number][];
              if (touchesLine(pm, qm) || touchesLine(qm, pm)) { fedPipe.add(i); grew = true; break; }
            }
          }
          if (!grew) break;
        }
        model.lines.forEach((ln, li) => {
          const latlngs = ln.coords.map((p) => [p[1], p[0]] as [number, number]);
          const isSinglePipe = ln.kind === "pipe" && pipeSel?.mode === "single" && pipeSel.idx === li;
          const st = ln.kind === "pipe"
            ? (isSinglePipe ? { color: "#f0b429", weight: 5, opacity: 0.95 }
              : pipeGroup ? { color: "#20aae2", weight: 4, opacity: 1 }
                : { color: "#20aae2", weight: 2 })
            : ln.kind === "header" ? { color: "#b23b1e", weight: 3 }
              : { color: "#0284c7", weight: 3, dashArray: "6,4" };
          if (ln.kind === "pipe" && cbs.onLineClick) {
            const pl = L.polyline(latlngs, { ...st, interactive: false, weight: (st.weight ?? 2) + 1 });
            g.addLayer(pl);
            // Fascia di presa INVISIBILE sopra la linea: il tubo è sottile, ma il
            // clic viene raccolto entro ~9 px per lato, così non serve centrarlo.
            const hit = L.polyline(latlngs, { color: "#000", weight: 18, opacity: 0, interactive: true });
            hit.on("click", (e) => { L.DomEvent.stop(e); cbs.onLineClick?.(li); });
            hit.bindTooltip(String(li + 1), { direction: "top", sticky: true });
            g.addLayer(hit);
            // Simbolo della PRESA: si mette dove la tubazione TOCCA DAVVERO il
            // canale, non sul primo punto per convenzione. Se sposti l'attacco
            // su un pivot, il quadratino si sposta o sparisce di conseguenza.
            const onWater = (q: number[]) => {
              if (!waterM.length) return false;
              const a0 = toM(q);
              for (const w of waterM) for (let i = 0; i < w.length - 1; i++) if (dPtSeg(a0, w[i], w[i + 1]) < TOUCH) return true;
              return false;
            };
            const taps = waterM.length ? ln.coords.filter(onWater) : (ln.coords[0] ? [ln.coords[0]] : []);
            const size = isSinglePipe || pipeGroup ? 11 : 9;
            for (const q of taps) {
              g.addLayer(L.marker([q[1], q[0]], {
                interactive: false, zIndexOffset: 900,
                icon: L.divIcon({ className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2],
                  html: '<div style="width:' + size + 'px;height:' + size + 'px;background:#b23b1e;border:2px solid #fff;'
                    + 'box-shadow:0 0 0 1px rgba(13,59,38,.5);border-radius:2px"></div>' }),
              }));
            }
            // Tratteggiata SOLO se davvero senz'acqua: se è servita da un'altra
            // tubazione collegata al canale, è alimentata anche lei.
            if (!fedPipe.has(li)) pl.setStyle({ dashArray: "8,6" });
          } else {
            g.addLayer(L.polyline(latlngs, { ...st, interactive: false }));
          }
        });
        const groupSel = sel.mode === "group" || sel.mode === "single";
        model.pivots.forEach((pv, i) => {
          const isSingle = sel.mode === "single" && sel.idx === i;
          const base = pv.conn === "pipe" ? "#20aae2" : "#038037";
          const style = isSingle
            ? { color: "#b23b1e", weight: 3, fillColor: "#f0b429", fillOpacity: 0.40 }
            : groupSel
              ? { color: "#0d3b26", weight: 2.5, fillColor: base, fillOpacity: 0.30 }
              : { color: "#0d3b26", weight: 1, fillColor: base, fillOpacity: 0.22 };
          const c = L.circle([pv.lat, pv.lng], { radius: pv.r, ...style });
          // Punto del CENTRO: è il punto da alimentare, utile come riferimento
          // per le tubazioni (e come aggancio quando si modificano).
          // Centro del pivot. In ROSSO se non è alimentato da nessuna tubazione:
          // si individua a colpo d'occhio quale va ancora collegato.
          g.addLayer(L.circleMarker([pv.lat, pv.lng], {
            radius: pv.unconn ? 4 : 2.5, color: pv.unconn ? "#b23b1e" : "#0d3b26", weight: pv.unconn ? 2 : 1,
            fillColor: pv.unconn ? "#fff" : "#0d3b26", fillOpacity: 1, interactive: false,
          }));
          c.on("click", (e) => { L.DomEvent.stop(e); cbs.onClick(i); });
          c.bindTooltip(`#${i + 1} · r ${Math.round(pv.r)} m`, { direction: "top", sticky: true });
          g.addLayer(c);
          if (isSingle) {
            const handle = L.marker([pv.lat, pv.lng], {
              draggable: true,
              icon: L.divIcon({ className: "", iconSize: [16, 16], iconAnchor: [8, 8],
                html: '<div style="width:16px;height:16px;border-radius:50%;background:#f0b429;border:2px solid #b23b1e;box-shadow:0 0 0 2px #fff"></div>' }),
            });
            handle.on("drag", (e) => { const ll = (e.target as L.Marker).getLatLng(); c.setLatLng(ll); });
            handle.on("dragend", (e) => { const ll = (e.target as L.Marker).getLatLng(); cbs.onMove(i, ll.lat, ll.lng); });
            g.addLayer(handle);
          }
        });
      },
      clearPivots() { pivotsRef.current?.clearLayers(); pivotBgRef.current = null; },
      showRoads(roads, onRemove) {
        const g = roadsRef.current; if (!g) return;
        g.clearLayers();
        roads.forEach((rd, i) => {
          const latlngs = rd.coords.map((p) => [p[1], p[0]] as [number, number]);
          // Banda di spessore reale (footprint), scala con lo zoom.
          for (const rect of _bandRects(rd.coords, rd.width_m ?? 0)) {
            g.addLayer(L.polygon(rect, { color: "#374151", weight: 0, fillColor: "#374151", fillOpacity: 0.35, interactive: false }));
          }
          // Casing bianco + asse grigio scuro: leggibile sul satellitare.
          g.addLayer(L.polyline(latlngs, { color: "#ffffff", weight: 4, opacity: 0.9, interactive: false }));
          const ly = L.polyline(latlngs, { color: "#374151", weight: 2, opacity: 0.95 });
          ly.bindTooltip(`Strada ${i + 1}${rd.width_m ? ` · ${Math.round(rd.width_m)} m` : ""}`, { direction: "top", sticky: true });
          if (onRemove) ly.on("click", (e) => { L.DomEvent.stop(e); onRemove(i); });
          g.addLayer(ly);
        });
      },
      drawRoadManual(cb) {
        const map = mapRef.current; if (!map) return;
        roadManualCbRef.current = cb;
        drawModeRef.current = "road-manual";
        try { (map as any).pm.enableDraw("Line", { allowSelfIntersection: true }); } catch { /* */ }
      },
      clearRoads() { roadsRef.current?.clearLayers(); },
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
          if (it.geom.type === "LineString") {           // asse fiume/canale
            const latlngs = (it.geom.coordinates as number[][]).map((p) => [p[1], p[0]] as [number, number]);
            const ly = L.polyline(latlngs, { color: "#0369a1", weight: 3, opacity: 0.95 });
            ly.bindTooltip("Fiume/canale", { direction: "center" });
            g.addLayer(ly);
            continue;
          }
          const isBasin = it.kind === "basin";
          const ly = L.polygon(toLatLng((it.geom.coordinates as number[][][])[0]), {
            color: isBasin ? "#0369a1" : "#0891b2",
            weight: 2, fillColor: isBasin ? "#0ea5e9" : "#22d3ee",
            fillOpacity: isBasin ? 0.45 : 0.3, dashArray: isBasin ? undefined : "5,4",
          });
          ly.bindTooltip(isBasin ? "Bacino/lago" : "Palude", { direction: "center" });
          g.addLayer(ly);
        }
      },
      clearWater() { waterRef.current?.clearLayers(); },
      previewWater(items) {
        const map = mapRef.current, g = waterPreviewRef.current;
        if (!map || !g) return;
        waterRef.current?.clearLayers();          // nasconde i confermati durante l'anteprima
        g.clearLayers();
        waterRemoveRef.current = false; drawModeRef.current = null;
        for (const it of items) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let layer: any;
          if (it.geom.type === "LineString") {
            layer = L.polyline((it.geom.coordinates as number[][]).map((p) => [p[1], p[0]] as [number, number]),
              { color: "#0369a1", weight: 3, dashArray: "4,3", opacity: 0.95 });
          } else {
            const isBasin = it.kind === "basin";
            layer = L.polygon((it.geom.coordinates as number[][][])[0].map((p) => [p[1], p[0]] as [number, number]),
              { color: isBasin ? "#0369a1" : "#0891b2", weight: 2, fillColor: isBasin ? "#0ea5e9" : "#22d3ee", fillOpacity: 0.25, dashArray: "4,3" });
          }
          (layer as any)._wcKind = it.kind;
          layer.on("click", () => { if (waterRemoveRef.current) g.removeLayer(layer); });
          g.addLayer(layer);
          try { (layer as any).pm?.enable({ allowSelfIntersection: false }); } catch { /* */ }
        }
        try { const b = g.getBounds(); if (b.isValid()) map.fitBounds(b, { padding: [50, 50] }); } catch { /* */ }
      },
      waterDraw(kind) {
        const map = mapRef.current; if (!map) return;
        drawModeRef.current = kind;
        try { (map as any).pm.enableDraw(kind === "river" ? "Line" : "Polygon", { allowSelfIntersection: false }); } catch { /* */ }
      },
      waterRemoveMode(on) {
        waterRemoveRef.current = on;
        const map = mapRef.current;
        try { if (map) map.getContainer().style.cursor = on ? "not-allowed" : ""; } catch { /* */ }
      },
      confirmWater() {
        const map = mapRef.current, g = waterPreviewRef.current;
        const out: { kind: string; geom: { type: string; coordinates: any } }[] = [];  // eslint-disable-line @typescript-eslint/no-explicit-any
        if (g) {
          g.eachLayer((layer: any) => {
            const kind = layer._wcKind || "basin";
            const isPolygon = layer instanceof L.Polygon;   // Polygon estende Polyline
            if (!isPolygon) {
              const lls = layer.getLatLngs() as any[];
              const coords = lls.map((p: any) => [p.lng, p.lat]);
              if (coords.length >= 2) out.push({ kind, geom: { type: "LineString", coordinates: coords } });
            } else {
              let ring = layer.getLatLngs() as any;
              if (Array.isArray(ring[0])) ring = ring[0];
              const coords = ring.map((p: any) => [p.lng, p.lat]);
              if (coords.length >= 3) { coords.push(coords[0]); out.push({ kind, geom: { type: "Polygon", coordinates: [coords] } }); }
            }
          });
        }
        g?.clearLayers();
        drawModeRef.current = null; waterRemoveRef.current = false;
        try { if (map) { (map as any).pm.disableDraw(); map.getContainer().style.cursor = ""; } } catch { /* */ }
        return out;
      },
      cancelWater() {
        const map = mapRef.current;
        waterPreviewRef.current?.clearLayers();
        drawModeRef.current = null; waterRemoveRef.current = false;
        try { if (map) { (map as any).pm.disableDraw(); map.getContainer().style.cursor = ""; } } catch { /* */ }
      },
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
          for (const rect of _bandRects(cc.coords, cc.width_m ?? 0)) {
            g.addLayer(L.polygon(rect, { color: "#0284c7", weight: 0, fillColor: "#0284c7", fillOpacity: 0.30, interactive: false }));
          }
          const line = L.polyline(latlngs, { color: "#0284c7", weight: 4, opacity: 0.9 });
          line.bindTooltip(`${startLabel.charAt(0)}${i + 1}`, { permanent: false, direction: "center" });
          // clic sul canale → finestrella con il tasto per il profilo altimetrico
          const box = L.DomUtil.create("div");
          box.style.cssText = "min-width:150px";
          const ttl = L.DomUtil.create("div", "", box);
          ttl.textContent = `Canale ${i + 1}`;
          ttl.style.cssText = "font-weight:600;margin-bottom:6px;color:#08341c";
          const btn = L.DomUtil.create("button", "", box);
          btn.textContent = "📈 Vedi profilo elevazione";
          btn.style.cssText = "background:#038037;color:#fff;border:none;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:12px;width:100%";
          L.DomEvent.on(btn, "click", (e) => { L.DomEvent.stop(e); cbRef.current.onCanalProfile?.(i); });
          line.bindPopup(box);
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
            return { color: "#b5502a", weight: p ? 2 : 1, opacity: p ? 1 : 0.75 };
          },
          onEachFeature: (f, layer) => {
            // niente riquadri fissi: la quota compare solo al passaggio del mouse
            layer.bindTooltip(`${f?.properties?.elev} m`, { sticky: true, direction: "top", opacity: 0.9 });
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
      setUnits(imp) { imperialRef.current = imp; if (measuringRef.current) _redrawMeasure(); },
      stopMeasure() {
        const map = mapRef.current;
        measuringRef.current = false;
        mptsRef.current = [];
        mcbRef.current = null;
        measureRef.current?.clearLayers();
        try { if (map) map.getContainer().style.cursor = ""; } catch { /* */ }
      },
      startElevation(cb) {
        const map = mapRef.current; if (!map) return;
        ecbRef.current = cb;
        elevingRef.current = true;
        eptsRef.current = [];
        elabelsRef.current = [];
        elevRef.current?.clearLayers();
        try { map.getContainer().style.cursor = "crosshair"; } catch { /* */ }
      },
      stopElevation() {
        const map = mapRef.current;
        elevingRef.current = false;
        eptsRef.current = [];
        ecbRef.current = null;
        elabelsRef.current = [];
        elevRef.current?.clearLayers();
        try { if (map) map.getContainer().style.cursor = ""; } catch { /* */ }
      },
      setElevationLabels(labels) { elabelsRef.current = labels; _redrawElev(); },
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
      // Modifica di UNA tubazione: maniglie trascinabili su ogni vertice, clic
      // sulla linea per inserire un punto, doppio clic su una maniglia per
      // toglierlo. Ogni modifica richiama cb con il nuovo tracciato.
      editPipe(coords, cb, snap, snapLines, labels) {
        const map = mapRef.current, g = canalEditRef.current;
        if (!map || !g) return;
        g.clearLayers();
        let pts = coords.map((p) => [...p]);
        const redraw = () => { this.editPipe(pts, cb, snap, snapLines, labels); };
        const SNAP_PX = 22;     // distanza di aggancio
        const ON_PX = 7;        // "sta già sopra": crea il vertice automaticamente
        const px = (lng: number, lat: number) => map.latLngToContainerPoint([lat, lng]);
        // Aggancio: prima i CENTRI dei pivot (bersaglio esatto), poi il canale o
        // il fiume (punto qualsiasi lungo la linea, non solo i suoi vertici).
        const snapTo = (lng: number, lat: number): { p: [number, number]; kind: "free" | "pivot" | "canal" } => {
          const here = px(lng, lat);
          let bestP: [number, number] = [lng, lat], bd = SNAP_PX, kind: "free" | "pivot" | "canal" = "free";
          for (const s of snap || []) {
            const q = px(s[0], s[1]);
            const d = Math.hypot(q.x - here.x, q.y - here.y);
            if (d < bd) { bd = d; bestP = [s[0], s[1]]; kind = "pivot"; }
          }
          if (kind === "pivot") return { p: bestP, kind };
          for (const ln of snapLines || []) {
            for (let i = 0; i < ln.length - 1; i++) {
              const a = px(ln[i][0], ln[i][1]), b = px(ln[i + 1][0], ln[i + 1][1]);
              const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-9;
              let tt = ((here.x - a.x) * dx + (here.y - a.y) * dy) / l2; tt = Math.max(0, Math.min(1, tt));
              const qx = a.x + dx * tt, qy = a.y + dy * tt;
              const d = Math.hypot(qx - here.x, qy - here.y);
              if (d < bd) {
                bd = d; kind = "canal";
                const ll = map.containerPointToLatLng([qx, qy] as unknown as L.PointExpression);
                bestP = [ll.lng, ll.lat];
              }
            }
          }
          return { p: bestP, kind };
        };
        // Che cosa c'è sotto un vertice: serve solo a colorare la maniglia.
        const kindOf = (p: number[]): "free" | "pivot" | "canal" => {
          const here = px(p[0], p[1]);
          for (const s of snap || []) { const q = px(s[0], s[1]); if (Math.hypot(q.x - here.x, q.y - here.y) < 3) return "pivot"; }
          for (const ln of snapLines || []) for (let i = 0; i < ln.length - 1; i++) {
            const a = px(ln[i][0], ln[i][1]), b = px(ln[i + 1][0], ln[i + 1][1]);
            const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-9;
            let tt = ((here.x - a.x) * dx + (here.y - a.y) * dy) / l2; tt = Math.max(0, Math.min(1, tt));
            if (Math.hypot(a.x + dx * tt - here.x, a.y + dy * tt - here.y) < 3) return "canal";
          }
          return "free";
        };
        // Dove la tubazione PASSA su un centro pivot o incrocia il canale senza
        // avere lì un vertice, il vertice viene creato: così ogni aggancio è un
        // estremo di segmento, spostabile ed eliminabile da solo.
        const addJoints = () => {
          const out: number[][] = [];
          for (let i = 0; i < pts.length - 1; i++) {
            const A = pts[i], B = pts[i + 1];
            const a = px(A[0], A[1]), b = px(B[0], B[1]);
            const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-9;
            const mid: { t: number; p: number[] }[] = [];
            for (const s of snap || []) {
              const q = px(s[0], s[1]);
              let tt = ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2;
              if (tt <= 0.02 || tt >= 0.98) continue;
              if (Math.hypot(a.x + dx * tt - q.x, a.y + dy * tt - q.y) > ON_PX) continue;
              mid.push({ t: tt, p: [s[0], s[1]] });
            }
            for (const ln of snapLines || []) for (let k = 0; k < ln.length - 1; k++) {
              const c = px(ln[k][0], ln[k][1]), d = px(ln[k + 1][0], ln[k + 1][1]);
              const rx = dx, ry = dy, sx = d.x - c.x, sy = d.y - c.y;
              const den = rx * sy - ry * sx; if (Math.abs(den) < 1e-9) continue;
              const tt = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
              const uu = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
              if (tt <= 0.02 || tt >= 0.98 || uu < 0 || uu > 1) continue;
              const ll = map.containerPointToLatLng([a.x + rx * tt, a.y + ry * tt] as unknown as L.PointExpression);
              mid.push({ t: tt, p: [ll.lng, ll.lat] });
            }
            mid.sort((x, y) => x.t - y.t);
            out.push(A);
            let last = -1;
            for (const m2 of mid) { if (m2.t - last < 0.02) continue; last = m2.t; out.push(m2.p); }
          }
          out.push(pts[pts.length - 1]);
          const changed = out.length !== pts.length;
          pts = out;
          return changed;
        };
        const fire = () => cb(pts.map((q) => [...q]));
        const line = L.polyline(pts.map((p) => [p[1], p[0]] as [number, number]),
          { color: "#f0b429", weight: 5, opacity: 0.85 });
        g.addLayer(line);
        const dot = (kind: "free" | "pivot" | "canal") => {
          const bg = kind === "pivot" ? "#0d3b26" : kind === "canal" ? "#2f6fd0" : "#f0b429";
          const shape = kind === "canal" ? "border-radius:3px" : "border-radius:50%";
          return '<div style="width:14px;height:14px;' + shape + ';background:' + bg +
            ';border:2px solid #fff;box-shadow:0 0 0 2px rgba(13,59,38,.55);cursor:grab"></div>';
        };
        pts.forEach((pt, i) => {
          const k0 = kindOf(pt);
          const m = L.marker([pt[1], pt[0]], {
            draggable: true, zIndexOffset: 1200,
            icon: L.divIcon({ className: "", iconSize: [14, 14], iconAnchor: [7, 7], html: dot(k0) }),
          });
          const lab = labels || { pivot: "Agganciato al centro del pivot", canal: "Agganciato al canale", free: "Punto libero" };
          m.bindTooltip(k0 === "pivot" ? lab.pivot : k0 === "canal" ? lab.canal : lab.free,
            { direction: "top", offset: [0, -10] });
          m.on("drag", (e) => {
            const ll = (e.target as L.Marker).getLatLng();
            pts[i] = snapTo(ll.lng, ll.lat).p;
            line.setLatLngs(pts.map((q) => [q[1], q[0]] as [number, number]));
          });
          m.on("dragend", (e) => {
            const ll = (e.target as L.Marker).getLatLng();
            const r = snapTo(ll.lng, ll.lat);
            pts[i] = r.p;
            (e.target as L.Marker).setLatLng([r.p[1], r.p[0]]);
            addJoints(); fire(); redraw();
          });
          // Doppio clic o tasto destro: elimina il punto (restano almeno 2 punti).
          const kill = (e: L.LeafletMouseEvent) => {
            L.DomEvent.stop(e);
            if (pts.length <= 2) return;
            pts.splice(i, 1); fire(); redraw();
          };
          m.on("dblclick", kill);
          m.on("contextmenu", kill);
          g.addLayer(m);
        });
        line.on("click", (ev: L.LeafletMouseEvent) => {
          const cl = ev.latlng; let best = 0, bd = Infinity;
          for (let i = 0; i < pts.length - 1; i++) {
            const ax = pts[i][0], ay = pts[i][1], bx = pts[i + 1][0], by = pts[i + 1][1];
            const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
            let tt = ((cl.lng - ax) * dx + (cl.lat - ay) * dy) / L2; tt = Math.max(0, Math.min(1, tt));
            const d = (cl.lng - (ax + tt * dx)) ** 2 + (cl.lat - (ay + tt * dy)) ** 2;
            if (d < bd) { bd = d; best = i; }
          }
          pts.splice(best + 1, 0, snapTo(cl.lng, cl.lat).p); fire(); redraw();
        });
        // All'apertura: crea subito i vertici sugli agganci già esistenti.
        if (addJoints()) { fire(); redraw(); }
      },
      endPipeEdit() { canalEditRef.current?.clearLayers(); },
      drawCanalManual(cb) {
        const map = mapRef.current; if (!map) return;
        canalManualCbRef.current = cb;
        drawModeRef.current = "canal-manual";
        try { (map as any).pm.enableDraw("Line", { allowSelfIntersection: true }); } catch { /* */ }
      },
      drawPipeManual(cb, snap, snapLines) {
        const map = mapRef.current; if (!map) return;
        pipeManualCbRef.current = cb;
        pipeSnapRef.current = { pts: snap ?? [], lines: snapLines ?? [] };
        drawModeRef.current = "pipe-manual";
        try { (map as any).pm.enableDraw("Line", { allowSelfIntersection: true }); } catch { /* */ }
      },
      drawUndo() {
        const map = mapRef.current; if (!map) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (map as any).pm?.Draw;
        for (const name of ["Line", "Polygon", "Rectangle"]) {
          const inst = d?.[name];
          if (inst?._enabled) { try { inst._removeLastVertex?.(); } catch { /* */ } return; }
        }
      },
      drawFinish() {
        const map = mapRef.current; if (!map) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (map as any).pm?.Draw;
        for (const name of ["Line", "Polygon", "Rectangle"]) {
          const inst = d?.[name];
          if (inst?._enabled) { try { inst._finishShape?.(); } catch { /* */ } return; }
        }
      },
      drawCancel() {
        const map = mapRef.current; if (!map) return;
        drawModeRef.current = null;
        canalManualCbRef.current = null; roadManualCbRef.current = null; pipeManualCbRef.current = null;
        try { (map as any).pm.disableDraw(); } catch { /* */ }
        try { map.getContainer().style.cursor = ""; } catch { /* */ }
      },
      armPick(cb) {
        pickCbRef.current = cb;
        try { if (mapRef.current) mapRef.current.getContainer().style.cursor = "crosshair"; } catch { /* */ }
      },
      disarmPick() {
        pickCbRef.current = null;
        try { if (mapRef.current) mapRef.current.getContainer().style.cursor = ""; } catch { /* */ }
      },
      setBasemap(kind) {
        const map = mapRef.current; if (!map) return;
        const cfg = BASEMAPS[kind] || BASEMAPS.sat;
        try { if (baseRef.current) map.removeLayer(baseRef.current); } catch { /* */ }
        baseRef.current = L.tileLayer(cfg.url, { maxZoom: cfg.max, attribution: cfg.attr }).addTo(map);
        try { baseRef.current.bringToBack(); } catch { /* */ }
      },
      setMapLabels(on) {
        const map = mapRef.current; if (!map) return;
        if (on && !labelsRef.current) {
          labelsRef.current = L.tileLayer(LABELS_URL, { maxZoom: 20, opacity: 0.9 }).addTo(map);
        } else if (!on && labelsRef.current) {
          try { map.removeLayer(labelsRef.current); } catch { /* */ }
          labelsRef.current = null;
        }
      },
    };
  });

  return <div ref={elRef} className="map-root" aria-label="Mappa satellitare" />;
}
