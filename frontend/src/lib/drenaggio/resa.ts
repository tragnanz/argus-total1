/**
 * Drenaggio — resa grafica della griglia: rilievo ombreggiato, quote a
 * colori, pendenze, ristagni, reticolo di scolo, curve di livello.
 *
 * Tutte le funzioni scrivono in un ImageData nx × ny (un pixel per cella),
 * che l'app stira sulla mappa. Modulo portabile: TypeScript puro.
 */
import { latlngDi, percentili, type Griglia } from './griglia'
import type { Idrologia } from './idrologia'

export type Stile = 'rilievo' | 'quote_rilievo' | 'quote' | 'pendenze' | 'nessuno'

export interface Luce {
  /** direzione del sole, gradi da nord in senso orario */
  azimut: number
  /** altezza del sole sull'orizzonte, gradi */
  altezza: number
  /** intensita' delle ombre 0..1 */
  ombre: number
  /** luminosita' 0.5..1.5 */
  luminosita: number
  /** esagerazione verticale */
  esagerazione: number
}

export const LUCE_DEFAULT: Luce = { azimut: 315, altezza: 45, ombre: 0.7, luminosita: 1, esagerazione: 1 }

export const PRESET_LUCE: { nome: string; luce: Luce }[] = [
  { nome: 'Luce morbida', luce: { azimut: 315, altezza: 50, ombre: 0.5, luminosita: 1.05, esagerazione: 1 } },
  { nome: 'Leggera', luce: { azimut: 315, altezza: 55, ombre: 0.3, luminosita: 1.1, esagerazione: 1 } },
  { nome: 'Dettaglio campo', luce: { azimut: 315, altezza: 35, ombre: 0.9, luminosita: 1, esagerazione: 5 } },
  { nome: 'Sole basso', luce: { azimut: 290, altezza: 12, ombre: 1, luminosita: 1, esagerazione: 2 } },
]

/** Gradienti di Horn (dz/dx verso est, dz/dy verso sud), per cella. */
export function gradienti(g: Griglia) {
  const { nx, ny, z, cell } = g
  const gx = new Float32Array(nx * ny), gy = new Float32Array(nx * ny)
  const val = (r: number, c: number, centro: number) => {
    r = r < 0 ? 0 : r >= ny ? ny - 1 : r
    c = c < 0 ? 0 : c >= nx ? nx - 1 : c
    const v = z[r * nx + c]
    return Number.isNaN(v) ? centro : v
  }
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const k = r * nx + c, e = z[k]
      if (Number.isNaN(e)) { gx[k] = NaN; gy[k] = NaN; continue }
      const a = val(r - 1, c - 1, e), b = val(r - 1, c, e), cc = val(r - 1, c + 1, e)
      const d = val(r, c - 1, e), f = val(r, c + 1, e)
      const gg = val(r + 1, c - 1, e), h = val(r + 1, c, e), i = val(r + 1, c + 1, e)
      gx[k] = ((cc + 2 * f + i) - (a + 2 * d + gg)) / (8 * cell)
      gy[k] = ((gg + 2 * h + i) - (a + 2 * b + cc)) / (8 * cell)
    }
  }
  return { gx, gy }
}

/** Pendenza in percentuale. */
export function pendenze(gr: { gx: Float32Array; gy: Float32Array }) {
  const out = new Float32Array(gr.gx.length)
  for (let k = 0; k < out.length; k++) out[k] = Math.hypot(gr.gx[k], gr.gy[k]) * 100
  return out
}

/** Ombreggiatura 0..1 (formula classica di Burrough/ESRI). */
export function ombreggiatura(gr: { gx: Float32Array; gy: Float32Array }, luce: Luce) {
  const zen = ((90 - luce.altezza) * Math.PI) / 180
  const az = (((360 - luce.azimut + 90) % 360) * Math.PI) / 180
  const cz = Math.cos(zen), sz = Math.sin(zen)
  const out = new Float32Array(gr.gx.length)
  const ex = luce.esagerazione
  for (let k = 0; k < out.length; k++) {
    const dx = gr.gx[k] * ex, dy = gr.gy[k] * ex
    if (Number.isNaN(dx)) { out[k] = NaN; continue }
    const slope = Math.atan(Math.hypot(dx, dy))
    let aspect: number
    if (dx !== 0) { aspect = Math.atan2(dy, -dx); if (aspect < 0) aspect += 2 * Math.PI }
    else aspect = dy > 0 ? Math.PI / 2 : dy < 0 ? 1.5 * Math.PI : 0
    const v = cz * Math.cos(slope) + sz * Math.sin(slope) * Math.cos(az - aspect)
    out[k] = v < 0 ? 0 : v
  }
  return { hs: out, piano: cz }
}

// --- scale di colore -------------------------------------------------------

type RGB = [number, number, number]
const RAMPA_QUOTE: RGB[] = [
  [43, 131, 186], [100, 180, 180], [171, 221, 164], [230, 245, 152],
  [255, 255, 191], [254, 224, 139], [253, 174, 97], [244, 109, 67], [215, 25, 28],
]

function rampa(t: number, cols: RGB[]): RGB {
  if (!(t > 0)) return cols[0]
  if (t >= 1) return cols[cols.length - 1]
  const x = t * (cols.length - 1), i = Math.floor(x), f = x - i
  const a = cols[i], b = cols[i + 1]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/** Classi di pendenza pensate per lo scolo superficiale dei campi. */
export const CLASSI_PENDENZA: { max: number; nome: string; rgb: RGB }[] = [
  { max: 0.1, nome: '< 0,1 % (piatto: ristagna)', rgb: [178, 24, 43] },
  { max: 0.3, nome: '0,1–0,3 %', rgb: [239, 138, 98] },
  { max: 0.5, nome: '0,3–0,5 %', rgb: [253, 219, 199] },
  { max: 1, nome: '0,5–1 %', rgb: [209, 229, 240] },
  { max: 2, nome: '1–2 %', rgb: [103, 169, 207] },
  { max: 5, nome: '2–5 %', rgb: [33, 102, 172] },
  { max: 10, nome: '5–10 %', rgb: [5, 48, 97] },
  { max: 20, nome: '10–20 %', rgb: [118, 42, 131] },
  { max: Infinity, nome: '> 20 %', rgb: [64, 0, 75] },
]

export function coloreQuota(t: number): RGB { return rampa(t, RAMPA_QUOTE) }
export function colorePendenza(p: number): RGB {
  for (const c of CLASSI_PENDENZA) if (p < c.max) return c.rgb
  return CLASSI_PENDENZA[CLASSI_PENDENZA.length - 1].rgb
}

/** Intervallo di quote usato per i colori: 2°–98° percentile, per far leggere i campi piatti. */
export function intervalloColori(z: Float32Array): [number, number] {
  const [a, b] = percentili(z, [2, 98])
  return b - a > 1e-3 ? [a, b] : [a - 0.5, b + 0.5]
}

/** Disegna lo stile scelto nell'ImageData (stesse dimensioni della griglia). */
export function disegnaBase(
  out: ImageData, g: Griglia, stile: Stile, luce: Luce,
  gr: { gx: Float32Array; gy: Float32Array }, pend: Float32Array, scala: [number, number],
) {
  const d = out.data
  const N = g.nx * g.ny
  if (stile === 'nessuno') { d.fill(0); return }
  const { hs, piano } = ombreggiatura(gr, luce)
  const [z0, z1] = scala
  const L = luce.luminosita, S = luce.ombre
  for (let k = 0, j = 0; k < N; k++, j += 4) {
    const h = hs[k]
    if (Number.isNaN(h)) { d[j + 3] = 0; continue }
    let rgb: RGB
    if (stile === 'rilievo') {
      // grigio: piano = grigio medio-chiaro, versanti al sole piu' chiari
      const v = 255 * L * ((1 - S) * 0.82 + S * h)
      rgb = [v, v, v]
    } else {
      const base = stile === 'pendenze' ? colorePendenza(pend[k]) : coloreQuota((g.z[k] - z0) / (z1 - z0))
      const om = stile === 'quote' ? L : L * (1 + S * 1.4 * (h - piano))
      rgb = [base[0] * om, base[1] * om, base[2] * om]
    }
    d[j] = rgb[0] > 255 ? 255 : rgb[0] < 0 ? 0 : rgb[0]
    d[j + 1] = rgb[1] > 255 ? 255 : rgb[1] < 0 ? 0 : rgb[1]
    d[j + 2] = rgb[2] > 255 ? 255 : rgb[2] < 0 ? 0 : rgb[2]
    d[j + 3] = 255
  }
}

/** Ristagni in blu, piu' scuri dove l'acqua e' piu' profonda. */
export function disegnaRistagni(out: ImageData, idro: Idrologia, sogliaM: number, fondoM = 0.3) {
  const d = out.data, p = idro.profondita
  for (let k = 0, j = 0; k < p.length; k++, j += 4) {
    const v = p[k]
    if (!(v > sogliaM)) { d[j + 3] = 0; continue }
    const t = Math.min(1, (v - sogliaM) / Math.max(1e-3, fondoM - sogliaM))
    d[j] = 30 - 20 * t; d[j + 1] = 120 - 70 * t; d[j + 2] = 255 - 60 * t
    d[j + 3] = 130 + 110 * t
  }
}

/** Reticolo di scolo: celle che drenano almeno 'sogliaM2' di superficie. */
export function disegnaReticolo(out: ImageData, g: Griglia, idro: Idrologia, sogliaM2: number) {
  const d = out.data, a = idro.accumulo
  const cA = g.cell * g.cell
  const soglia = sogliaM2 / cA
  const lmax = Math.log(Math.max(soglia * 2, maxFinito(a)) / soglia)
  for (let k = 0, j = 0; k < a.length; k++, j += 4) {
    const v = a[k]
    if (!(v >= soglia)) { d[j + 3] = 0; continue }
    const t = Math.min(1, Math.log(v / soglia) / (lmax || 1))
    d[j] = 0; d[j + 1] = 200 - 140 * t; d[j + 2] = 255
    d[j + 3] = 170 + 85 * t
  }
}

function maxFinito(a: Float32Array) {
  let m = 0
  for (let k = 0; k < a.length; k++) if (a[k] > m) m = a[k]
  return m
}

/** Maschera del bacino in arancione trasparente, bordo pieno. */
export function disegnaMaschera(out: ImageData, g: Griglia, m: Uint8Array) {
  const d = out.data, { nx, ny } = g
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const k = r * nx + c, j = k * 4
      if (!m[k]) { d[j + 3] = 0; continue }
      const bordo = r === 0 || c === 0 || r === ny - 1 || c === nx - 1 ||
        !m[k - 1] || !m[k + 1] || !m[k - nx] || !m[k + nx]
      d[j] = 228; d[j + 1] = 119; d[j + 2] = 46; d[j + 3] = bordo ? 255 : 70
    }
  }
}

/**
 * Curve di livello con marching squares sui centri cella.
 * Ritorna segmenti [lat, lon] separati in curve ordinarie e direttrici.
 */
export function curveDiLivello(g: Griglia, intervallo: number, ogniDirettrice = 5, maxSegmenti = 400000) {
  const { nx, ny, z } = g
  const ordinarie: [number, number][][] = [], direttrici: [number, number][][] = []
  const { min, max } = (() => {
    let a = Infinity, b = -Infinity
    for (let k = 0; k < z.length; k++) { const v = z[k]; if (v < a) a = v; if (v > b) b = v }
    return { min: a, max: b }
  })()
  if (!(intervallo > 0) || !Number.isFinite(min)) return { ordinarie, direttrici, troncate: false }
  const livelli: number[] = []
  for (let l = Math.ceil(min / intervallo) * intervallo; l <= max; l += intervallo) livelli.push(l)
  const ll = (c: number, r: number) => latlngDi(g, c, r)
  let n = 0, troncate = false
  for (const lv of livelli) {
    const dir = Math.abs(Math.round(lv / intervallo) % ogniDirettrice) === 0
    const dest = dir ? direttrici : ordinarie
    for (let r = 0; r < ny - 1; r++) {
      for (let c = 0; c < nx - 1; c++) {
        const a = z[r * nx + c], b = z[r * nx + c + 1], cc = z[(r + 1) * nx + c + 1], d = z[(r + 1) * nx + c]
        if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(cc) || Number.isNaN(d)) continue
        const idx = (a > lv ? 8 : 0) | (b > lv ? 4 : 0) | (cc > lv ? 2 : 0) | (d > lv ? 1 : 0)
        if (idx === 0 || idx === 15) continue
        // punti sui lati: alto (a-b), destra (b-c), basso (d-c), sinistra (a-d)
        const top = () => ll(c + (lv - a) / (b - a), r)
        const right = () => ll(c + 1, r + (lv - b) / (cc - b))
        const bottom = () => ll(c + (lv - d) / (cc - d), r + 1)
        const left = () => ll(c, r + (lv - a) / (d - a))
        const seg = (p: () => [number, number], q: () => [number, number]) => { dest.push([p(), q()]); n++ }
        switch (idx) {
          case 1: case 14: seg(left, bottom); break
          case 2: case 13: seg(bottom, right); break
          case 3: case 12: seg(left, right); break
          case 4: case 11: seg(top, right); break
          case 6: case 9: seg(top, bottom); break
          case 7: case 8: seg(left, top); break
          case 5: seg(left, top); seg(bottom, right); break
          case 10: seg(top, right); seg(left, bottom); break
        }
        if (n >= maxSegmenti) { troncate = true; return { ordinarie, direttrici, troncate } }
      }
    }
  }
  return { ordinarie, direttrici, troncate }
}

/** Intervallo di curve "ragionevole" per il dislivello dato. */
export function intervalloSuggerito(dislivello: number): number {
  const passi = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50]
  for (const p of passi) if (dislivello / p <= 40) return p
  return 100
}
