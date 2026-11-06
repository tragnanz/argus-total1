/**
 * Drenaggio — DEM pubblico scaricato dal browser.
 *
 * Fonte: "Terrain Tiles" su AWS Open Data (formato Terrarium, PNG a 256 px,
 * accesso libero con CORS). In Europa il dato di origine e' EU-DEM (25 m,
 * Copernicus); altrove SRTM/NED/GMTED secondo la zona. La quota si ricava da
 * ogni pixel come  (R * 256 + G + B / 256) - 32768  metri.
 *
 * Modulo portabile: nessuna dipendenza dall'app che lo ospita.
 */
import { R_TERRA, latDaMerc, mercY, type Griglia, type Limiti } from './griglia'

export const URL_TESSERE_DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
export const DESCRIZIONE_DEM =
  'DEM pubblico (AWS Terrain Tiles: EU-DEM 25 m in Europa, SRTM 30 m altrove)'

const TILE = 256

function lonPx(lon: number, z: number) { return ((lon + 180) / 360) * TILE * 2 ** z }
function latPx(lat: number, z: number) { return ((1 - mercY(lat) / Math.PI) / 2) * TILE * 2 ** z }
function pxLon(px: number, z: number) { return (px / (TILE * 2 ** z)) * 360 - 180 }
function pxLat(py: number, z: number) { return latDaMerc((1 - (2 * py) / (TILE * 2 ** z)) * Math.PI) }

async function leggiTessera(z: number, x: number, y: number, segnale?: AbortSignal): Promise<Float32Array | null> {
  const n = 2 ** z
  if (y < 0 || y >= n) return null
  const xx = ((x % n) + n) % n
  const url = URL_TESSERE_DEM.replace('{z}', String(z)).replace('{x}', String(xx)).replace('{y}', String(y))
  const r = await fetch(url, { signal: segnale, mode: 'cors' })
  if (!r.ok) return null
  // niente conversione di colore: i canali RGB sono numeri, non colori
  const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const c = document.createElement('canvas')
  c.width = TILE; c.height = TILE
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0)
  const d = ctx.getImageData(0, 0, TILE, TILE).data
  const out = new Float32Array(TILE * TILE)
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768
  return out
}

export interface OpzioniDEM {
  /** lato massimo della griglia in celle (default 1024) */
  maxLato?: number
  /** zoom massimo delle tessere (default 15, cella ~3-4 m alle nostre latitudini) */
  zoomMax?: number
  onAvanzamento?: (fatte: number, totali: number) => void
  segnale?: AbortSignal
}

/** Scarica il DEM pubblico sull'area richiesta e lo restituisce come griglia. */
export async function caricaDEM(b: Limiti, opz: OpzioniDEM = {}): Promise<Griglia> {
  const maxLato = opz.maxLato ?? 1024
  let z = Math.min(15, opz.zoomMax ?? 15)
  for (; z > 1; z--) {
    const w = lonPx(b.east, z) - lonPx(b.west, z)
    const h = latPx(b.south, z) - latPx(b.north, z)
    if (w <= maxLato && h <= maxLato) break
  }
  const px0 = Math.floor(lonPx(b.west, z)), px1 = Math.ceil(lonPx(b.east, z))
  const py0 = Math.floor(latPx(b.north, z)), py1 = Math.ceil(latPx(b.south, z))
  const nx = Math.max(2, px1 - px0), ny = Math.max(2, py1 - py0)
  const tx0 = Math.floor(px0 / TILE), tx1 = Math.floor((px0 + nx - 1) / TILE)
  const ty0 = Math.floor(py0 / TILE), ty1 = Math.floor((py0 + ny - 1) / TILE)

  const zArr = new Float32Array(nx * ny).fill(NaN)
  const lavori: [number, number][] = []
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) lavori.push([tx, ty])
  let fatte = 0, mancate = 0
  opz.onAvanzamento?.(0, lavori.length)

  const copia = (tx: number, ty: number, t: Float32Array) => {
    const ox = tx * TILE - px0, oy = ty * TILE - py0
    for (let r = 0; r < TILE; r++) {
      const gy = oy + r
      if (gy < 0 || gy >= ny) continue
      for (let c = 0; c < TILE; c++) {
        const gx = ox + c
        if (gx < 0 || gx >= nx) continue
        zArr[gy * nx + gx] = t[r * TILE + c]
      }
    }
  }

  // 6 richieste in parallelo
  let prossimo = 0
  async function operaio() {
    while (prossimo < lavori.length) {
      const [tx, ty] = lavori[prossimo++]
      try {
        const t = await leggiTessera(z, tx, ty, opz.segnale)
        if (t) copia(tx, ty, t); else mancate++
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e
        mancate++
      }
      opz.onAvanzamento?.(++fatte, lavori.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, lavori.length) }, operaio))
  if (mancate === lavori.length) {
    throw new Error('DEM pubblico non raggiungibile da questa rete (s3.amazonaws.com bloccato?).')
  }

  const north = pxLat(py0, z), south = pxLat(py0 + ny, z)
  const latc = (north + south) / 2
  const cell = ((2 * Math.PI * R_TERRA) / (TILE * 2 ** z)) * Math.cos((latc * Math.PI) / 180)
  return {
    west: pxLon(px0, z), east: pxLon(px0 + nx, z), north, south,
    nx, ny, z: zArr, cell, fonte: DESCRIZIONE_DEM,
    risoluzioneDato: cell < 20 ? 'dato ~25-30 m ricampionato' : undefined,
  }
}
