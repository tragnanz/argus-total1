// Esri World Imagery non ha lo stesso dettaglio ovunque (es. Mauritania fino allo zoom 17): oltre il suo
// livello risponde con la piastrella «Map data not yet available». Il servizio tilemap dice fin dove
// arrivano le immagini; oltre si ingrandisce l'ultimo livello disponibile (mappa, tavole, rapporto).
const ESRI_TILEMAP = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tilemap";
const esriNativeCache = new Map<string, Promise<number>>();
export function esriMaxNative(lat: number, lng: number): Promise<number> {
  const tile = (z: number) => {
    const n = 2 ** z, r = (lat * Math.PI) / 180;
    return [Math.floor(((lng + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)];
  };
  const [cx, cy] = tile(11), key = `${cx},${cy}`;
  let p = esriNativeCache.get(key);
  if (!p) {
    const zs = [20, 19, 18, 17, 16, 15, 14, 13];
    p = Promise.all(zs.map((z) => {
      const [x, y] = tile(z);
      return fetch(`${ESRI_TILEMAP}/${z}/${y}/${x}/1/1`).then((r) => r.json()).then((j) => (j?.data?.[0] === 1 ? z : 0)).catch(() => -1);
    })).then((ok) => (ok.some((v) => v < 0) && !ok.some((v) => v > 0) ? 20 : Math.max(13, ...ok)));
    esriNativeCache.set(key, p);
  }
  return p;
}
