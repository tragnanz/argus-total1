// Import di campi da file: GeoJSON, KML e KMZ (KML zippato).
// Estrae TUTTI i poligoni (uno per campo), con il nome del segnaposto se presente.
import { kml as kmlToGeojson } from "@tmcw/togeojson";
import JSZip from "jszip";
import type { Polygon } from "./api";

export type ImportedField = { name?: string; geom: Polygon; radius_m?: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function featuresToFields(gj: any): ImportedField[] {
  const feats = gj?.type === "FeatureCollection"
    ? gj.features
    : [gj?.type === "Feature" ? gj : { geometry: gj, properties: {} }];
  const out: ImportedField[] = [];
  for (const f of feats || []) {
    const g = f?.geometry || f;
    const nm: string | undefined = f?.properties?.name || f?.properties?.Name || f?.properties?.NAME || undefined;
    if (g?.type === "Polygon" && Array.isArray(g.coordinates?.[0])) {
      out.push({ name: nm, geom: { type: "Polygon", coordinates: g.coordinates } });
    } else if (g?.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
      g.coordinates.forEach((poly: number[][][], i: number) => {
        if (Array.isArray(poly?.[0]))
          out.push({ name: nm && g.coordinates.length > 1 ? `${nm} ${i + 1}` : nm, geom: { type: "Polygon", coordinates: poly } });
      });
    }
  }
  return out;
}

function parseKml(text: string): ImportedField[] {
  const dom = new DOMParser().parseFromString(text, "text/xml");
  return featuresToFields(kmlToGeojson(dom));
}

// ---- Linee (canali) da GeoJSON/KML/KMZ ----
export type ImportedLine = { name?: string; coords: number[][] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function featuresToLines(gj: any): ImportedLine[] {
  const feats = gj?.type === "FeatureCollection"
    ? gj.features
    : [gj?.type === "Feature" ? gj : { geometry: gj, properties: {} }];
  const out: ImportedLine[] = [];
  const xy = (c: number[]) => [c[0], c[1]];        // scarta la quota (evita coord 3D)
  for (const f of feats || []) {
    const g = f?.geometry || f;
    const nm: string | undefined = f?.properties?.name || f?.properties?.Name || f?.properties?.NAME || undefined;
    if (g?.type === "LineString" && Array.isArray(g.coordinates?.[0])) {
      out.push({ name: nm, coords: g.coordinates.map(xy) });
    } else if (g?.type === "MultiLineString" && Array.isArray(g.coordinates)) {
      g.coordinates.forEach((ln: number[][], i: number) => {
        if (Array.isArray(ln?.[0]))
          out.push({ name: nm && g.coordinates.length > 1 ? `${nm} ${i + 1}` : nm, coords: ln.map(xy) });
      });
    }
  }
  return out;
}

/** Estrae le polilinee (canali) da un file GeoJSON/KML/KMZ. */
export async function parseLinesFromFile(file: File): Promise<ImportedLine[]> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".kmz")) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entry = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith(".kml"));
    if (!entry) return [];
    const dom = new DOMParser().parseFromString(await zip.files[entry].async("text"), "text/xml");
    return featuresToLines(kmlToGeojson(dom));
  }
  const text = await file.text();
  if (name.endsWith(".kml")) {
    const dom = new DOMParser().parseFromString(text, "text/xml");
    return featuresToLines(kmlToGeojson(dom));
  }
  try { return featuresToLines(JSON.parse(text)); } catch { return []; }
}

/** Estrae la lista di campi (poligoni + nome) da un file GeoJSON/KML/KMZ. */
export async function parseFieldsFromFile(file: File): Promise<ImportedField[]> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".kmz")) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entry = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith(".kml"));
    if (!entry) return [];
    return parseKml(await zip.files[entry].async("text"));
  }
  const text = await file.text();
  if (name.endsWith(".kml")) return parseKml(text);
  try {
    return featuresToFields(JSON.parse(text));
  } catch {
    return [];
  }
}
