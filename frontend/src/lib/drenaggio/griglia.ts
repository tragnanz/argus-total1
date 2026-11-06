/**
 * Drenaggio — griglia regolare di quote allineata alla mappa.
 *
 * Modulo portabile: TypeScript puro, nessuna dipendenza da React, Leaflet o
 * dall'app che lo ospita (Daedalus, Argus Smart, Argus Total).
 *
 * Le celle sono equispaziate in Web Mercator, come le tessere di Leaflet, e
 * hanno lato costante in metri sul terreno ('cell'). La riga 0 e' a nord.
 */

export const R_TERRA = 6378137

export interface Limiti {
  west: number
  south: number
  east: number
  north: number
}

export interface Griglia extends Limiti {
  nx: number
  ny: number
  /** quote in metri, riga per riga da nord; NaN dove manca il dato */
  z: Float32Array
  /** lato della cella sul terreno, in metri */
  cell: number
  /** descrizione della fonte delle quote, per l'interfaccia */
  fonte: string
  /** risoluzione nativa del dato, se diversa dalla cella (es. DEM 25 m ricampionato) */
  risoluzioneDato?: string
}

export const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
export const latDaMerc = (y: number) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI

/** Posizione frazionaria (colonna, riga) del punto, in coordinate di centro cella. */
export function cellaDi(g: Limiti & { nx: number; ny: number }, lat: number, lon: number) {
  const yn = mercY(g.north), ys = mercY(g.south)
  return {
    fx: ((lon - g.west) / (g.east - g.west)) * g.nx - 0.5,
    fy: ((yn - mercY(lat)) / (yn - ys)) * g.ny - 0.5,
  }
}

/** Centro della cella (col, riga) in [lat, lon]. */
export function latlngDi(g: Limiti & { nx: number; ny: number }, col: number, row: number): [number, number] {
  const yn = mercY(g.north), ys = mercY(g.south)
  const lon = g.west + ((col + 0.5) / g.nx) * (g.east - g.west)
  const lat = latDaMerc(yn - ((row + 0.5) / g.ny) * (yn - ys))
  return [lat, lon]
}

/** Valore bilineare di un campo della griglia nel punto; NaN fuori o senza dato. */
export function campiona(g: Griglia, campo: ArrayLike<number>, lat: number, lon: number): number {
  const { fx, fy } = cellaDi(g, lat, lon)
  return campionaCella(g, campo, fx, fy)
}

export function campionaCella(g: { nx: number; ny: number }, campo: ArrayLike<number>, fx: number, fy: number): number {
  const { nx, ny } = g
  if (fx < -0.5 || fy < -0.5 || fx > nx - 0.5 || fy > ny - 0.5) return NaN
  const x0 = Math.max(0, Math.min(nx - 1, Math.floor(fx)))
  const y0 = Math.max(0, Math.min(ny - 1, Math.floor(fy)))
  const x1 = Math.min(nx - 1, x0 + 1), y1 = Math.min(ny - 1, y0 + 1)
  const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0))
  const a = campo[y0 * nx + x0], b = campo[y0 * nx + x1]
  const c = campo[y1 * nx + x0], d = campo[y1 * nx + x1]
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) {
    // vicino a un buco: valore della cella piu' vicina
    return campo[Math.round(Math.max(0, Math.min(ny - 1, fy))) * nx + Math.round(Math.max(0, Math.min(nx - 1, fx)))]
  }
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
}

/** Distanza in metri fra due punti (formula equirettangolare, precisa a scala di campo). */
export function distanzaM(a: [number, number], b: [number, number]): number {
  const lat = ((a[0] + b[0]) / 2) * (Math.PI / 180)
  const dx = ((b[1] - a[1]) * Math.PI) / 180 * R_TERRA * Math.cos(lat)
  const dy = ((b[0] - a[0]) * Math.PI) / 180 * R_TERRA
  return Math.hypot(dx, dy)
}

/** Area in m² di un poligono [lat, lon] (proiezione locale). */
export function areaM2(poly: [number, number][]): number {
  if (poly.length < 3) return 0
  const lat0 = poly.reduce((s, p) => s + p[0], 0) / poly.length
  const k = Math.cos((lat0 * Math.PI) / 180)
  const pts = poly.map((p) => [((p[1] * Math.PI) / 180) * R_TERRA * k, ((p[0] * Math.PI) / 180) * R_TERRA])
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]
    s += x1 * y2 - x2 * y1
  }
  return Math.abs(s) / 2
}

/** Statistiche di base delle quote valide. */
export function statisticheZ(z: Float32Array) {
  let min = Infinity, max = -Infinity, n = 0, s = 0
  for (let i = 0; i < z.length; i++) {
    const v = z[i]
    if (Number.isNaN(v)) continue
    if (v < min) min = v
    if (v > max) max = v
    s += v; n++
  }
  return { min, max, media: n ? s / n : NaN, validi: n }
}

/** Percentili approssimati (su un campione) delle quote valide, per stirare i colori. */
export function percentili(z: ArrayLike<number>, ps: number[]): number[] {
  const passo = Math.max(1, Math.floor(z.length / 200000))
  const camp: number[] = []
  for (let i = 0; i < z.length; i += passo) { const v = z[i]; if (!Number.isNaN(v)) camp.push(v) }
  if (!camp.length) return ps.map(() => NaN)
  camp.sort((a, b) => a - b)
  return ps.map((p) => camp[Math.min(camp.length - 1, Math.max(0, Math.round((p / 100) * (camp.length - 1))))])
}

/** Decodifica una griglia arrivata dal server (Float32 little-endian in base64). */
export function grigliaDaBase64(d: {
  west: number; south: number; east: number; north: number; nx: number; ny: number; cell_m: number; z_b64: string
}, fonte: string): Griglia {
  const bin = atob(d.z_b64)
  const buf = new ArrayBuffer(bin.length)
  const u8 = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return {
    west: d.west, south: d.south, east: d.east, north: d.north,
    nx: d.nx, ny: d.ny, cell: d.cell_m, z: new Float32Array(buf), fonte,
  }
}
