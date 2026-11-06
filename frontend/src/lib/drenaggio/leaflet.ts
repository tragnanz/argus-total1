/**
 * Drenaggio — collegamento con Leaflet: strati raster su canvas e ricerca
 * del luogo. Unico file del modulo che dipende da Leaflet.
 */
import L from 'leaflet'
import type { Griglia } from './griglia'

export interface StratoRaster {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  img: ImageData
  layer: L.Layer
  /** ricopia l'ImageData sul canvas (dopo averlo ridisegnato) */
  aggiorna: () => void
}

/**
 * Strato raster della griglia: un canvas nx × ny stirato sui limiti della
 * griglia. Si usa SVGOverlay di Leaflet, che accetta un elemento qualsiasi,
 * cosi' ridisegnare costa una putImageData e non una codifica PNG.
 */
export function stratoRaster(g: Griglia, pane: string, opacita = 1, nitido = false): StratoRaster {
  const canvas = document.createElement('canvas')
  canvas.width = g.nx; canvas.height = g.ny
  canvas.style.pointerEvents = 'none'
  if (nitido) canvas.style.imageRendering = 'pixelated'
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(g.nx, g.ny)
  const bounds = L.latLngBounds([g.south, g.west], [g.north, g.east])
  const layer = L.svgOverlay(canvas as unknown as SVGElement, bounds, { pane, interactive: false, opacity: opacita })
  return { canvas, ctx, img, layer, aggiorna: () => ctx.putImageData(img, 0, 0) }
}

/** Crea (se manca) un pane della mappa con lo z-index dato. */
export function assicuraPane(map: L.Map, nome: string, zIndex: number) {
  const p = map.getPane(nome) || map.createPane(nome)
  p.style.zIndex = String(zIndex)
  p.style.pointerEvents = 'none'
  return nome
}

/**
 * "Vai a": accetta coordinate ("44.39, 7.54") oppure un indirizzo/luogo,
 * cercato su OpenStreetMap Nominatim.
 */
export async function cercaLuogo(testo: string): Promise<{ lat: number; lon: number; nome: string; bbox?: [number, number, number, number] } | null> {
  const t = testo.trim()
  const m = t.match(/^\s*(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)\s*$/)
  if (m) {
    const a = Number(m[1].replace(',', '.')), b = Number(m[2].replace(',', '.'))
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b, nome: `${a}, ${b}` }
  }
  if (!t) return null
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=it&q=${encodeURIComponent(t)}`)
  if (!r.ok) throw new Error('Ricerca del luogo non riuscita')
  const j = await r.json()
  if (!j.length) return null
  const bb = j[0].boundingbox?.map(Number) as number[] | undefined
  return {
    lat: Number(j[0].lat), lon: Number(j[0].lon), nome: j[0].display_name,
    bbox: bb && bb.length === 4 ? [bb[0], bb[1], bb[2], bb[3]] : undefined,
  }
}
