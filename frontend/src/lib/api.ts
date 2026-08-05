// Client API di Argus Total: tipi + chiamate al backend FastAPI.
// L'URL del backend arriva da NEXT_PUBLIC_API_BASE (default: localhost:8000).

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, "") || "http://localhost:8000";

// ---- Geometria ----
export type Polygon = {
  type: "Polygon";
  coordinates: number[][][]; // [ [ [lon,lat], ... ] ]
};

// Compat: alcuni componenti riutilizzati dal motore importano questo tipo.
export type AnalysisMap = Record<string, unknown>;

// ---- Entità ----
export type Client = { id: number; name: string; notes?: string | null; created_at: string };
export type Project = {
  id: number; client_id: number | null; name: string;
  description?: string | null; crop?: string | null; created_at: string;
};
export type Area = {
  id: number; project_id: number; name: string;
  parent_area_id?: number | null; kind?: string;
  geojson: Polygon; area_ha?: number | null; created_at: string;
};

// ---- Satellite ----
export type Scene = { date: string; cloud?: number | null };
export type ColorScale = { cmap: string; vmin: number; vmax: number; colors: string[] };
export type Preview = {
  image: string;
  bounds: [[number, number], [number, number]];
  meta: Record<string, unknown> & { scale?: ColorScale };
};

// ---- Idoneità del terreno (M2) ----
export type SuitClass = { key: string; label: string; color: string; ha: number; pct: number };
export type SuitWeights = { slope: number; vigor: number; moisture: number; climate: number };
export type SuitMeta = {
  date: string; res_m: number; cached: boolean; calls: number;
  total_ha: number; suitable_ha: number; mean_score: number; wetland_ha?: number;
  classes: SuitClass[];
  slope: { mean_pct: number; max_pct: number; ideal_pct: number; max_allowed_pct: number };
  climate: {
    eto_year_mm: number; rain_year_mm: number; deficit_year_mm: number;
    aridity_index: number | null; score: number; elev_m: number; source: string;
  };
  weights: SuitWeights;
};
export type Suitability = {
  image: string; bounds: [[number, number], [number, number]]; meta: SuitMeta;
};
export type SuitParams = {
  weights: SuitWeights; slope_ideal_pct: number; slope_max_pct: number;
};

// ---- Layout pivot + dimensionamento idrico (M3) ----
export type LayoutConfig = "square" | "staggered";
export type Transport = "canal" | "buried";
export type CanalSide = "N" | "S" | "E" | "W";
export type LayoutWater = {
  et0_peak_mm: number; kc_peak: number; etc_peak_mm: number; efficiency: number;
  gross_mm_day: number; hours_day: number;
  q_pivot_ls: number; q_pivot_m3h: number; q_total_ls: number; q_total_m3h: number;
  vol_pivot_day_m3: number; vol_total_day_m3: number; climate_source: string;
};
export type PhaseOrder = "canal_distance" | "suitability" | "rows";
export type LayoutPhase = { phase: number; n_pivots: number; net_ha: number; q_ls: number; q_m3h: number };
export type LayoutMeta = {
  config: LayoutConfig; radius_m: number; gap_m: number; transport: Transport;
  slope_max_pct: number; orientation_deg: number; auto_orient: boolean; canal_flip: boolean;
  only_suitable: boolean; min_suitability: number | null; overhang_pct: number;
  n_phases: number; phase_order: PhaseOrder; phases: LayoutPhase[];
  n_pivots: number; n_pumps: number; net_ha: number; field_ha: number;
  coverage_pct: number; gross_block_ha: number; packing_pct: number; pivot_ha: number;
  pipe_total_m: number; pipe_max_m: number; header_m: number; network_total_m: number;
  water: LayoutWater;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GeoJSONFC = { type: "FeatureCollection"; features: any[] };
export type LayoutResult = { geojson: GeoJSONFC; bounds: [[number, number], [number, number]]; meta: LayoutMeta };
export type LayoutParams = {
  config: LayoutConfig; radius_m: number; gap_m: number; transport: Transport;
  slope_max_pct?: number | null; slope_ideal_pct?: number | null;
  auto_orient: boolean; canal_azimuth_deg?: number | null; canal_flip: boolean;
  only_suitable: boolean; min_suitability: number; date?: string | null;
  overhang_pct: number; n_phases: number; phase_order: PhaseOrder;
  kc_peak: number; efficiency: number; hours_per_day: number;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json())?.detail ?? detail; } catch { /* */ }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---- Meta ----
export const getHealth = () =>
  req<{ status: string; provider_mode: string; rev: string }>("/api/health");

// ---- Clienti ----
export const listClients = () => req<Client[]>("/api/clients");
export const createClient = (name: string, notes?: string) =>
  req<Client>("/api/clients", { method: "POST", body: JSON.stringify({ name, notes }) });
export const updateClient = (id: number, patch: Partial<Pick<Client, "name" | "notes">>) =>
  req<Client>(`/api/clients/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteClient = (id: number) =>
  req<void>(`/api/clients/${id}`, { method: "DELETE" });

// ---- Progetti ----
export const listProjects = (clientId?: number | null) =>
  req<Project[]>(`/api/projects${clientId != null ? `?client_id=${clientId}` : ""}`);
export const createProject = (body: {
  name: string; client_id?: number | null; description?: string; crop?: string;
}) => req<Project>("/api/projects", { method: "POST", body: JSON.stringify(body) });
export const updateProject = (id: number, patch: Partial<Project>) =>
  req<Project>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteProject = (id: number) =>
  req<void>(`/api/projects/${id}`, { method: "DELETE" });

// ---- Aree di progetto ----
export const listAreas = (projectId: number) =>
  req<Area[]>(`/api/projects/${projectId}/areas`);
export const createArea = (body: {
  project_id: number; name: string; geojson: Polygon; area_ha?: number | null;
  parent_area_id?: number | null; kind?: string;
}) => req<Area>("/api/areas", { method: "POST", body: JSON.stringify(body) });
export const updateArea = (id: number, patch: {
  name?: string; geojson?: Polygon; area_ha?: number | null;
}) => req<Area>(`/api/areas/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteArea = (id: number) =>
  req<void>(`/api/areas/${id}`, { method: "DELETE" });

// ---- Livelli salvati (canali, pivot, …) ----
export type ProjectLayer = {
  id: number; project_id: number; kind: string; name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>; created_at: string;
};
export const listLayers = (projectId: number) =>
  req<ProjectLayer[]>(`/api/projects/${projectId}/layers`);
export const createLayer = (body: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  project_id: number; kind: string; name: string; data: Record<string, any>;
}) => req<ProjectLayer>("/api/layers", { method: "POST", body: JSON.stringify(body) });
export const deleteLayer = (id: number) =>
  req<void>(`/api/layers/${id}`, { method: "DELETE" });

// ---- Satellite ----
export const fetchScenes = (geom: Polygon, months_back = 12, max_cloud = 95) =>
  req<Scene[]>("/api/satellite/scenes", {
    method: "POST", body: JSON.stringify({ geom, months_back, max_cloud }),
  });
export const fetchPreview = (geom: Polygon, index: string, date: string, normalized = false) =>
  req<Preview>("/api/satellite/preview", {
    method: "POST", body: JSON.stringify({ geom, index, date, normalized }),
  });
export const fetchDem = (geom: Polygon) =>
  req<Preview>("/api/satellite/dem", { method: "POST", body: JSON.stringify({ geom }) });

// ---- Idoneità ----
export type MacroArea = { geojson: Polygon; area_ha: number; mean_score: number };
export const fetchMacroareas = (geom: Polygon, date: string, p: SuitParams & { min_suitability: number; min_area_ha: number }) =>
  req<MacroArea[]>("/api/macroareas", {
    method: "POST", body: JSON.stringify({ geom, date, ...p }),
  });

export type Canal = {
  geojson: { type: "LineString"; coordinates: number[][] };
  length_m: number; drop_m: number; mean_permille: number; target_permille: number;
  start: number[]; end: number[]; elev_start_m: number; elev_end_m: number;
  profile: number[][]; waypoints: number[][];
};
export const fetchCanal = (
  geom: Polygon, target_permille: number,
  start?: number[] | null, end?: number[] | null, waypoints?: number[][] | null,
) =>
  req<Canal>("/api/canal", {
    method: "POST",
    body: JSON.stringify({ geom, target_permille, start: start ?? null, end: end ?? null, waypoints: waypoints ?? null }),
  });

// ---- Leggibilità terreno: rilievo + isoipse, zona a valle della presa ----
export type Terrain = {
  image: string; bounds: [[number, number], [number, number]];
  contours: GeoJSONFC; interval_m: number; elev_min: number; elev_max: number;
};
export const fetchTerrain = (geom: Polygon, vert_exag = 2) =>
  req<Terrain>("/api/terrain", { method: "POST", body: JSON.stringify({ geom, vert_exag }) });

export type Reach = { polygons: Polygon[]; elev_start_m: number; elev_min_m: number; area_ha: number };
export const fetchReachable = (geom: Polygon, start: number[]) =>
  req<Reach>("/api/canal/reachable", { method: "POST", body: JSON.stringify({ geom, start }) });

// ---- Corsi d'acqua esistenti (NDWI) ----
export type Watercourse = { geojson: Polygon; kind: string; area_ha: number };
export type WaterResult = { features: Watercourse[]; water_ha: number; n_water: number; n_wetland: number };
export const fetchWatercourses = (geom: Polygon, date: string, min_area_ha = 0.3) =>
  req<WaterResult>("/api/watercourses", { method: "POST", body: JSON.stringify({ geom, date, min_area_ha }) });

export type GuidedResult = { geojson: GeoJSONFC; meta: Record<string, number> };
export const fetchGuided = (geom: Polygon, p: {
  target_permille: number; radius_m: number; gap_m: number; safety_m: number; per_side: number;
  conn_max_permille: number; fill: boolean; date?: string | null; exclude_water?: boolean;
}) => req<GuidedResult>("/api/guided", { method: "POST", body: JSON.stringify({ geom, ...p }) });

export const fetchSuitability = (geom: Polygon, date: string, p: SuitParams) =>
  req<Suitability>("/api/suitability", {
    method: "POST",
    body: JSON.stringify({ geom, date, ...p }),
  });

// ---- Layout pivot ----
export const fetchLayout = (geom: Polygon, p: LayoutParams) =>
  req<LayoutResult>("/api/layout", { method: "POST", body: JSON.stringify({ geom, ...p }) });

// ---- Scheda progetto PDF (M4) ----
export type ReportInfo = { project_name: string; client_name?: string; notes?: string; include_suitability: boolean; lang?: string };
export async function downloadReport(geom: Polygon, p: LayoutParams, info: ReportInfo): Promise<Blob> {
  const res = await fetch(`${API_BASE}/api/project/report`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ geom, ...p, ...info }),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json())?.detail ?? detail; } catch { /* */ }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.blob();
}
