// Client API di Argus Total: tipi + chiamate al backend FastAPI.
// L'URL del backend arriva da NEXT_PUBLIC_API_BASE (default: localhost:8000).

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, "") || "http://localhost:8000";

// ---- Autenticazione: token in localStorage + header su ogni richiesta ----
const TOKEN_KEY = "argus-total-token";
export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(tok: string) {
  try { localStorage.setItem(TOKEN_KEY, tok); } catch { /* */ }
}
export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* */ }
}
// Errore con codice HTTP, per distinguere 401 (login) e 402 (crediti esauriti).
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

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
  settings?: Record<string, unknown>;   // impostazioni di progetto (produttore pivot, fonte d'acqua…)
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
  elevation?: { min_m: number | null; max_m: number | null; median_m: number | null };
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
  min_pivot_pct?: number;   // dimensione minima dei pivot di riempimento bordi (% del raggio)
  fill_full?: boolean;      // riempie i vuoti anche con pivot interi fuori griglia
  free_layout?: boolean;    // disposizione libera (niente maglia fissa)
  canal_rows?: number;      // canali: file di pivot per lato (0 = solo il canale sul bordo)
  canal_corridor_m?: number;
  dem?: "COPERNICUS_30" | "COPERNICUS_90";   // modello del terreno
  dem_smooth_m?: number;    // base di levigatura della pendenza (m)
  pivot_slope_max_pct?: number; pivot_slope_tol_pct?: number;   // scarpate: pendenza massima sotto il pivot (0 = spento)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  roads?: any[] | null; clear_road_m?: number;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const tok = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json())?.detail ?? detail; } catch { /* */ }
    // Sessione scaduta/assente: torna al login (se non è già una pagina pubblica).
    if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth")) {
      clearToken();
      if (!location.pathname.startsWith("/login") && !location.pathname.startsWith("/view")) location.href = "/login";
    }
    throw new ApiError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---- Meta ----
export const getHealth = () =>
  req<{ status: string; provider_mode: string; rev: string }>("/api/health");

// ---- Autenticazione / utenti / crediti ----
export type Me = {
  id: number; email: string; full_name?: string | null; role: string; is_admin: boolean;
  organization_id: number; credits: number | null; credits_used: number; credits_remaining: number | null;
};
export type Usage = {
  scope: "org" | "user"; requests_used: number; requests_limit: number | null;
  requests_remaining: number | null; pct_used: number;
};
export type AdminUser = {
  id: number; email: string; full_name?: string | null; role: string; is_active: boolean;
  credits: number | null; credits_used: number; credits_remaining: number | null; created_at?: string | null;
};
export const authRegister = (email: string, password: string, organization_name: string, full_name?: string) =>
  req<{ access_token: string }>("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password, organization_name, full_name }) });
export const authLogin = (email: string, password: string) =>
  req<{ access_token: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
export const authMe = () => req<Me>("/api/auth/me");
export const fetchUsage = () => req<Usage>("/api/usage");
export const adminListUsers = () => req<AdminUser[]>("/api/admin/users");
export const adminCreateUser = (body: { email: string; password: string; full_name?: string; credits?: number | null }) =>
  req<AdminUser>("/api/admin/users", { method: "POST", body: JSON.stringify(body) });
export const adminUpdateUser = (id: number, body: { credits?: number | null; reset_used?: boolean; is_active?: boolean; password?: string; full_name?: string }) =>
  req<AdminUser>(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const adminDeleteUser = (id: number) =>
  req<{ ok: boolean }>(`/api/admin/users/${id}`, { method: "DELETE" });

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
// Tracciato automatico presa → vasca (condotta o canale a gravità).
export type AutoRoute = { coords: number[][]; length_m: number; profile: number[][]; z_max: number | null; z_min: number | null;
  cut_max_m: number; fill_max_m: number; res_m: number };
export type CanalNet = { head_m: number; res_m: number; unreached: number[];
  branches: { station: number; parent: number; attach_m: number; coords: number[][]; length_m: number; profile: number[][]; in_circles: number }[] };
export const canalNetwork = (body: { head: number[]; stations: number[][]; circles?: number[][]; target_permille?: number; head_m?: number }) =>
  req<CanalNet>("/api/canal/network", { method: "POST", body: JSON.stringify(body) });
export const autoRoute = (body: { src: number[]; dst: number[]; mode: "pipe" | "canal"; roads?: number[][][]; edges?: number[][][];
  circles?: number[][]; target_permille?: number }) =>
  req<AutoRoute>("/api/canal/route", { method: "POST", body: JSON.stringify(body) });
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

// ---- Link pubblici di sola lettura (multipli per progetto) ----
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ShareData = { project: { name: string; crop?: string | null }; areas: any[]; layers: any[]; config?: any;
  report?: { langs: string[]; default_lang: string; revision?: string; updated_at?: string | null } | null };
// Relazione tecnica allegata al link (tutte le lingue)
export type ShareReport = { lang: string; langs: string[]; default_lang: string; revision?: string; updated_at?: string | null; doc: any };
export const putShareReport = (token: string, docs: Record<string, unknown>, default_lang: string, bbox: number[] | null, revision: string) =>
  req<{ langs: string[]; default_lang: string }>(`/api/shares/${encodeURIComponent(token)}/report`, { method: "PUT", body: JSON.stringify({ docs, default_lang, bbox, revision }) });
export const fetchShareReport = (token: string, lang: string) =>
  req<ShareReport>(`/api/share/${encodeURIComponent(token)}/report?lang=${encodeURIComponent(lang)}`);
export const shareReportPdfUrl = (token: string, lang: string) =>
  `${API_BASE}/api/share/${encodeURIComponent(token)}/report.pdf?lang=${encodeURIComponent(lang)}`;
export type ShareView = { token: string; name: string; created_at?: string | null; report_langs?: string[] | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const createShareView = (projectId: number, name: string, config: any) =>
  req<ShareView>(`/api/projects/${projectId}/shares`, { method: "POST", body: JSON.stringify({ name, config }) });
export const listShares = (projectId: number) =>
  req<ShareView[]>(`/api/projects/${projectId}/shares`);
export const deleteShare = (token: string) =>
  req<void>(`/api/shares/${encodeURIComponent(token)}`, { method: "DELETE" });
export const fetchShare = (token: string) =>
  req<ShareData>(`/api/share/${encodeURIComponent(token)}`);

// ---- Commenti dei clienti sul link di sola lettura ----
export type ShareComment = { id: number; author: string; body: string; lat: number | null; lng: number | null;
  resolved: boolean; created_at: string | null; token?: string; share_name?: string; seen?: boolean };
export const listLinkComments = (token: string) =>
  req<ShareComment[]>(`/api/share/${encodeURIComponent(token)}/comments`);
export const addLinkComment = (token: string, c: { author: string; body: string; lat?: number | null; lng?: number | null }) =>
  req<ShareComment>(`/api/share/${encodeURIComponent(token)}/comments`, { method: "POST", body: JSON.stringify(c) });
export const listProjectComments = (projectId: number) =>
  req<ShareComment[]>(`/api/projects/${projectId}/comments`);
export const markCommentsSeen = (projectId: number) =>
  req<void>(`/api/projects/${projectId}/comments/seen`, { method: "POST" });
export const updateComment = (id: number, patch: { seen?: boolean; resolved?: boolean }) =>
  req<ShareComment>(`/api/comments/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteComment = (id: number) =>
  req<void>(`/api/comments/${id}`, { method: "DELETE" });

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
  manual?: number[][] | null, snap = false,
) =>
  req<Canal>("/api/canal", {
    method: "POST",
    body: JSON.stringify({ geom, target_permille, start: start ?? null, end: end ?? null, waypoints: waypoints ?? null, manual: manual ?? null, snap }),
  });

// ---- Diramazioni pivot da canale (Accessori) ----
export type BranchResult = {
  pivots: { lat: number; lng: number; r: number }[];
  pipes: number[][][];
  meta: { n: number; radius_m?: number };
};
export const fetchBranch = (body: {
  geom: Polygon; canal: number[][]; radius_m: number; gap_m: number;
  clear_m?: number; canal_width_m?: number; max_pivots: number;
  side?: "auto" | "both" | "left" | "right";
  existing?: { lat: number; lng: number; r: number }[] | null;
}) => req<BranchResult>("/api/canal/branch", { method: "POST", body: JSON.stringify(body) });

// ---- Leggibilità terreno: rilievo + isoipse, zona a valle della presa ----
export type Terrain = {
  image: string; bounds: [[number, number], [number, number]];
  contours: GeoJSONFC; interval_m: number; elev_min: number; elev_max: number;
};
export const fetchTerrain = (geom: Polygon, vert_exag = 2, interval_m = 0) =>
  req<Terrain>("/api/terrain", { method: "POST", body: JSON.stringify({ geom, vert_exag, interval_m }) });

export type Reach = { polygons: Polygon[]; elev_start_m: number; elev_min_m: number; area_ha: number };
export const fetchReachable = (geom: Polygon, start: number[]) =>
  req<Reach>("/api/canal/reachable", { method: "POST", body: JSON.stringify({ geom, start }) });

// ---- Corsi d'acqua esistenti (NDWI) ----
// geojson: Polygon (bacino/palude) oppure LineString (asse di fiume/canale).
export type Watercourse = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  geojson: { type: "Polygon" | "LineString"; coordinates: any };
  // kind: river | canal | drainage (impluvio dal DEM) | basin | wetland
  kind: string; area_ha: number; length_m?: number; mean_width_m?: number;
  // misure del satellite (Sentinel-2, composito di più date): larghezza tipica = mean_width_m
  source?: "s2" | "dem" | "manual" | "osm" | "osm+s2"; width_min_m?: number; width_max_m?: number; width_wet_m?: number | null;
  below_pixel?: boolean; sinuosity?: number; profile?: [number, number][]; name?: string;
  edited?: boolean;          // geometria o larghezza modificata a mano
  osm_type?: string; sat_cover?: number;   // corso da OpenStreetMap (river, stream, canal, drain…) e quota confermata dal satellite
  // spostabile: i pivot possono coprirlo e il tratto si devia (default: canali e dreni sì, fiumi no)
  movable?: boolean;
  // regime dai 12 mesi: perenne / stagionale / effimero (fiumara, wadi); mesi 1-12
  regime?: "perennial" | "seasonal" | "ephemeral" | null; months_wet?: number[]; months_seen?: number[];
  bed?: boolean;             // alveo asciutto (greto): la larghezza è quella dell'alveo
  // larghezza data per data (minima e massima osservate con la data)
  width_low_m?: number; date_low?: string; width_high_m?: number; date_high?: string; widths_by_date?: [string, number][];
  // escursione di livello STIMATA = (B max − B min) / (2·scarpa); scarpa: 1,5 per i canali, dal DEM per i fiumi
  bank_m?: number; bank_from?: "canal" | "dem" | "manual"; level_range_m?: number;
  // quote MISURATE dagli altimetri (Hydroweb) per i fiumi grandi, m s.l.m.
  level_abs?: { min: number; max: number; low: number; high: number; median: number[]; dist_km: number; source: string };
};
export type WaterResult = {
  features: Watercourse[]; water_ha: number; n_river: number; n_canal?: number; n_drain?: number; n_seasonal?: number; n_osm?: number; osm_error?: boolean; n_basin: number; n_wetland: number; n_drainage: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  surface?: { type: "Polygon"; coordinates: any }[]; dates?: string[]; res_m?: number; length_m?: number;
};
// TERRAFORMING: termitai su terreno aperto dalla scena Sentinel-2 più secca degli ultimi 12 mesi
// classi del terreno per origine (bit nella griglia lon/lat): 1 sale, 2 ristagni, 4 alberi e arbusti, 8 acqua permanente
export type GroundLayer = { w: number; h: number; bbox: [number, number, number, number]; b64: string; date_dry: string; date_wet: string | null; ha: Record<string, number>; area_ha: number };
export type TermiteResult = { date: string; ndvi_median: number; res_m: number; n_total: number; mounds: { lon: number; lat: number; d_m: number; score: number }[]; layers?: GroundLayer; termites_skipped?: boolean };
export const fetchTermites = (geom: Polygon, date: string | null, sens: number) =>
  req<TermiteResult>("/api/terraform/termites", { method: "POST", body: JSON.stringify({ geom, date, sens }) });
// anteprima rapida: i corsi OSM ritagliati sull'area, senza misure dal satellite (pochi secondi)
export const fetchOsmCourses = (geom: Polygon) =>
  req<{ features: Watercourse[]; n_river: number; n_canal: number; n_drain: number; n_osm: number }>("/api/watercourses/osm", { method: "POST", body: JSON.stringify({ geom }) });
export type OsmWaterway = { id: number; waterway: string; name?: string; width?: string; intermittent?: string; coords: number[][] };
export const fetchWatercourses = (geom: Polygon, date: string | null, sens = 3, months = 12, use_dem = true, dem_channel_ha = 25, dem_depth_m = 1.2, min_area_ha = 0.2,
  osm: OsmWaterway[] = []) =>
  req<WaterResult>("/api/watercourses", { method: "POST", body: JSON.stringify({ geom, date, sens, months, min_area_ha, use_dem, dem_channel_ha, dem_depth_m, osm }) });
// Corsi d'acqua OpenStreetMap nel riquadro (fiumi, torrenti, wadi, canali, dreni): il tracciato
// completo dei corsi che il satellite vede solo a tratti. Dal browser, con un server di riserva.
export async function fetchOsmWaterways(s: number, w: number, n: number, e: number): Promise<OsmWaterway[]> {
  const q = `[out:json][timeout:40];way["waterway"~"^(river|stream|canal|drain|ditch|wadi)$"](${s},${w},${n},${e});out tags geom;`;
  const servers = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
  let last: unknown = null;
  for (const url of servers) {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 45000);
    try {
      const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ac.signal });
      if (!r.ok) { last = new Error(`OpenStreetMap ${r.status}`); continue; }
      const js = await r.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((js.elements || []) as any[]).filter((el) => el.type === "way" && Array.isArray(el.geometry) && el.geometry.length >= 2)
        .map((el) => ({ id: el.id, waterway: el.tags?.waterway, name: el.tags?.name, width: el.tags?.width, intermittent: el.tags?.intermittent,
          coords: el.geometry.map((g: { lon: number; lat: number }) => [Math.round(g.lon * 1e6) / 1e6, Math.round(g.lat * 1e6) / 1e6]) }));
    } catch (err) { last = err; } finally { clearTimeout(tm); }
  }
  throw last ?? new Error("OpenStreetMap");
}

export type GuidedResult = { geojson: GeoJSONFC; meta: Record<string, number> };
export const fetchGuided = (geom: Polygon, p: {
  target_permille: number; radius_m: number; gap_m: number; safety_m: number; per_side: number;
  conn_max_permille: number; fill: boolean; date?: string | null; exclude_water?: boolean;
  clear_road_m?: number; clear_water_m?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  avoid?: any[] | null; roads?: any[] | null;
}) => req<GuidedResult>("/api/guided", { method: "POST", body: JSON.stringify({ geom, ...p }) });

export type ElevPoint = { lon: number; lat: number; elev_m: number | null; dist_m: number; drop_prev_m: number | null };
export type ElevationResult = { points: ElevPoint[]; total_drop_m: number | null; length_m: number; min_m: number | null; max_m: number | null };
export const fetchElevation = (coords: number[][]) =>
  req<ElevationResult>("/api/elevation", { method: "POST", body: JSON.stringify({ coords }) });
export type ElevationStats = { min_m: number | null; max_m: number | null; median_m: number | null; mean_m: number | null };
export const fetchElevationStats = (geom: Polygon) =>
  req<ElevationStats>("/api/elevation/stats", { method: "POST", body: JSON.stringify({ geom }) });

export const fetchSuitability = (geom: Polygon, date: string, p: SuitParams) =>
  req<Suitability>("/api/suitability", {
    method: "POST",
    body: JSON.stringify({ geom, date, ...p }),
  });

// ---- Layout pivot ----
export const fetchLayout = (geom: Polygon, p: LayoutParams) =>
  req<LayoutResult>("/api/layout", { method: "POST", body: JSON.stringify({ geom, ...p }) });

// ---- Scheda progetto PDF (M4) ----
export type ReportInfo = {
  project_name: string; client_name?: string; notes?: string;
  include_suitability: boolean; lang?: string;
  include_sheet?: boolean;   // stampa le sezioni con i dati di progetto
  include_plan?: boolean;    // stampa la tavola della planimetria
  // Progetto realmente disegnato: pivot e tubazioni come stanno sulla mappa.
  plan_fc?: GeoJSONFC;
  plan_canals?: number[][][];
  plan_rings?: number[][][];
  plan_format?: "a3" | "a4";   // formato della tavola
  project_id?: number | null;  // per numerare le revisioni
  area_id?: number | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plan_source?: any;           // fonte d'acqua da disegnare sulla tavola
  extra_sections?: { title: string; header?: string[]; widths?: number[]; rows: string[][] }[] | null;
};
// ---- Revisioni degli export (numerazione automatica, storico per campo) ----
export type ExportRevision = {
  n: number; area_id: number | null; label: string; fmt: string; lang: string;
  sections: string; summary: { pivots?: number; cells?: Record<string, string> };
  created_at: string | null;
};
export const listRevisions = (project_id: number, area_id?: number | null) =>
  req<ExportRevision[]>(`/api/project/revisions?project_id=${project_id}` +
    (area_id != null ? `&area_id=${area_id}` : ""));

export async function downloadReport(geom: Polygon, p: LayoutParams, info: ReportInfo): Promise<Blob> {
  // Come req(): il token va spedito, altrimenti il middleware di login risponde
  // 401 e il browser mostra solo un generico «Failed to fetch».
  const tok = getToken();
  const res = await fetch(`${API_BASE}/api/project/report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    body: JSON.stringify({ geom, ...p, ...info }),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json())?.detail ?? detail; } catch { /* */ }
    if (res.status === 401 && typeof window !== "undefined") {
      clearToken();
      if (!location.pathname.startsWith("/login") && !location.pathname.startsWith("/view")) location.href = "/login";
    }
    throw new ApiError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.blob();
}

// ---- Ortofoto per la planimetria del .ceres e PDF di confronto varianti ----
export type Ortho = { riquadro: { ovest: number; sud: number; est: number; nord: number }; immagine: string; attribuzione: string; px: number[] };
export const ortho = (bbox: number[], ratio = 1.387) =>
  req<Ortho>("/api/project/ortho", { method: "POST", body: JSON.stringify({ bbox, ratio }) });
export type VariantsPdfBody = {
  title: string; subtitle?: string; date?: string; note?: string; columns: string[];
  rows: { label: string; cells: { v: string; d?: string; s?: number }[] }[];
  qty_title?: string; qty_rows?: { label: string; head?: boolean; values?: string[] }[]; lang?: string; footer?: string;
};
export async function variantsPdf(body: VariantsPdfBody): Promise<Blob> {
  const tok = getToken();
  const res = await fetch(`${API_BASE}/api/project/variants-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json())?.detail ?? detail; } catch { /* */ }
    throw new ApiError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.blob();
}

// ---- Olympus · Mercurius (chiamate dirette dal browser, come fa Ceres) ----
// L'accesso è quello dell'utente in Olympus (email e password → token): la
// password non si salva, i token restano solo nella sessione del browser.
export class OlympusError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }
export function olympusBase(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u.replace(/\/api\/v1$/i, "") + "/api/v1";
}
export async function olympusCall<T>(url: string, tok: { a: string; r: string } | null, path: string,
  init?: { method?: string; body?: unknown }, onTokens?: (t: { a: string; r: string } | null) => void): Promise<T> {
  const base = olympusBase(url);
  const go = (a?: string) => fetch(base + path, {
    method: init?.method || "GET",
    headers: { "Content-Type": "application/json", ...(a ? { Authorization: `Bearer ${a}` } : {}) },
    body: init?.body != null ? JSON.stringify(init.body) : undefined,
  });
  let res = await go(tok?.a);
  if (res.status === 401 && tok?.r) {
    const rf = await fetch(base + "/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: tok.r }) });
    if (rf.ok) { const j = await rf.json(); const nt = { a: j.access_token, r: j.refresh_token }; onTokens?.(nt); res = await go(nt.a); }
    else onTokens?.(null);
  }
  let data: unknown = null;
  try { data = await res.json(); } catch { /* */ }
  if (!res.ok) {
    const d = (data as { detail?: unknown })?.detail;
    const msg = typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => (x as { msg?: string }).msg || JSON.stringify(x)).join(" · ") : `HTTP ${res.status}`;
    throw new OlympusError(res.status, msg);
  }
  return data as T;
}
export const updateLayer = (id: number, body: { name?: string; data?: Record<string, unknown> }) =>
  req<ProjectLayer>(`/api/layers/${id}`, { method: "PATCH", body: JSON.stringify(body) });
// Allegato tecnico dell'impianto (PDF, senza prezzi)
export async function techAnnex(doc: Record<string, unknown>): Promise<Blob> {
  const tok = getToken();
  const res = await fetch(`${API_BASE}/api/project/tech-annex`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify({ doc }),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json())?.detail ?? detail; } catch { /* */ }
    throw new ApiError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.blob();
}
// Relazione tecnica generale per il cliente (PDF, senza prezzi); bbox = foto di copertina
export async function relazione(doc: Record<string, unknown>, bbox: number[] | null): Promise<Blob> {
  const tok = getToken();
  const res = await fetch(`${API_BASE}/api/project/relazione`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify({ doc, bbox }),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json())?.detail ?? detail; } catch { /* */ }
    throw new ApiError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.blob();
}
// Dati meteorologici mensili del sito (NASA POWER) con ET₀ FAO-56 Penman-Monteith
export type SiteClimate = { tmax: number[]; tmin: number[]; rh: number[]; wind: number[]; rs: number[]; eto_day: number[]; eto_month_mm: number[];
  rain_month_mm: number[]; eto_year_mm: number; rain_year_mm: number; deficit_year_mm: number; aridity_index: number | null; source: string; elev: number };
export async function siteClimate(lat: number, lon: number): Promise<SiteClimate> {
  const tok = getToken();
  const res = await fetch(`${API_BASE}/api/project/climate?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.json();
}
// NDVI per pivot (Sentinel-2): media, uniformità, zone deboli, anelli dal centro alla punta
export type PivotNdvi = { i: number; ok: boolean; mean?: number; cv?: number; weak_pct?: number; p10?: number; p90?: number; rings?: (number | null)[]; valid_pct: number };
export type NdviOut = { date: string; cloud: number | null; res_m: number; pivots: PivotNdvi[]; source: string };
export const pivotNdvi = (pivots: { lat: number; lng: number; r: number; deg?: number; az?: number }[]) =>
  req<NdviOut>("/api/project/pivot-ndvi", { method: "POST", body: JSON.stringify({ pivots }) });
// Suolo del sito (SoilGrids 0-30 cm): tessitura, classe USDA, acqua disponibile, infiltrazione di base
export type SoilOut = { sand: number; silt: number; clay: number; soc_gkg: number; usda: string; key: string; inf_mmh: number; fc: number; wp: number; taw_mm_m: number; source: string };
export async function siteSoil(lat: number, lon: number): Promise<SoilOut> {
  const tok = getToken();
  const res = await fetch(`${API_BASE}/api/project/soil?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
  if (!res.ok) { let m = res.statusText; try { m = (await res.json()).detail ?? m; } catch { /* */ } throw new ApiError(res.status, m); }
  return res.json();
}
// Portata del fiume alla presa: celle GloFAS vicine e bacino dal DEM
export type RiverCell = { lat: number; lon: number; dist_km: number; mean: number; q347: number; min: number; max: number;
  month_mean: number[]; month_q80: number[]; month_p10?: number[]; month_min: number[]; years: string[]; n_days: number };
// Correzione di GloFAS con una stazione misurata sullo stesso fiume (fattori osservato/simulato)
export type RiverCorr = { station: { id: string; name: string; river: string; country: string; lat: number; lon: number; area_km2?: number; years: number[]; dist_km: number; source: string; downstream?: boolean; weight?: number; path?: number[][] };
  stations?: RiverCorr["station"][];
  obs_mean: number; obs_month: number[]; sim_mean: number; sim_month: number[]; sim_cell: number[]; ref_mean: number; f_year: number; f_month: number[] };
export type RiverOut = { lat: number; lon: number;
  glofas: { source?: string; period?: string[]; cells: RiverCell[]; pick: number; error?: string };
  geoglows?: { source?: string; period?: string[]; cells: (RiverCell & { area_km2: number; reach: number })[]; pick: number; corr?: RiverCorr | null; error?: string };
  basin?: { area_km2?: number; truncated?: boolean; outlet?: number[]; res_m?: number; z_outlet?: number; z_max?: number; z_mean?: number; ring?: number[][]; rain_month_mm?: number[]; error?: string } };
export async function riverFlow(lat: number, lon: number): Promise<RiverOut> {
  const tok = getToken();
  const res = await fetch(`${API_BASE}/api/project/river?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.json();
}
// Fiume della presa (rete GEOGLOWS): piogge sul bacino, previsione a 15 giorni, livelli dall'altimetria
export type RiverExtra = { reach: number | null; area_km2?: number;
  basin_rain?: { rain_month_mm: number[]; cells: number; samples: number; reaches: number; error?: string } | null;
  forecast?: { river_id: number; gen?: string; days: { date: string; q: number; lo: number; hi: number }[]; error?: string } | null;
  levels?: { dist_km: number; pt: number[]; area_km2: number; high: number[]; median: number[]; low: number[]; min: number[]; max: number[]; source: string; error?: string } | null };
export async function riverExtra(lat: number, lon: number): Promise<RiverExtra> {
  const tok = getToken();
  const res = await fetch(`${API_BASE}/api/project/river-extra?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.json();
}
// Scheda in scala del campo FV di un pivot solare (PDF A3)
export async function solarSheet(doc: Record<string, unknown>): Promise<Blob> {
  const tok = getToken();
  const res = await fetch(`${API_BASE}/api/project/solar-sheet`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify({ doc }),
  });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.blob();
}
