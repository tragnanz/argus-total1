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
