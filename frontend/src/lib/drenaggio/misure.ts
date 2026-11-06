/**
 * Drenaggio — misure sulla griglia: profilo altimetrico, statistiche di
 * un'area, punti quotati ed esportazione CSV.
 *
 * Modulo portabile: TypeScript puro.
 */
import { areaM2, campiona, cellaDi, distanzaM, latlngDi, type Griglia } from './griglia'
import type { Idrologia } from './idrologia'

export interface PuntoProfilo { d: number; z: number; lat: number; lon: number }

/** Campiona la quota lungo la polilinea, a passo pari alla cella. */
export function profilo(g: Griglia, linea: [number, number][]): PuntoProfilo[] {
  const out: PuntoProfilo[] = []
  let base = 0
  for (let i = 0; i < linea.length - 1; i++) {
    const a = linea[i], b = linea[i + 1]
    const L = distanzaM(a, b)
    const n = Math.max(1, Math.ceil(L / g.cell))
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const t = k / n
      const lat = a[0] + (b[0] - a[0]) * t, lon = a[1] + (b[1] - a[1]) * t
      out.push({ d: base + L * t, z: campiona(g, g.z, lat, lon), lat, lon })
    }
    base += L
  }
  return out
}

export function riepilogoProfilo(p: PuntoProfilo[]) {
  const v = p.filter((q) => !Number.isNaN(q.z))
  if (v.length < 2) return null
  let min = Infinity, max = -Infinity, salita = 0, discesa = 0
  for (let i = 0; i < v.length; i++) {
    min = Math.min(min, v[i].z); max = Math.max(max, v[i].z)
    if (i) { const dz = v[i].z - v[i - 1].z; if (dz > 0) salita += dz; else discesa -= dz }
  }
  const L = p[p.length - 1].d
  return {
    lunghezza: L, min, max, salita, discesa,
    pendenzaMedia: ((v[v.length - 1].z - v[0].z) / Math.max(1e-9, v[v.length - 1].d - v[0].d)) * 100,
  }
}

function dentro(lat: number, lon: number, poly: [number, number][]) {
  let ok = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j]
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) ok = !ok
  }
  return ok
}

/** Maschera delle celle il cui centro cade nel poligono [lat, lon]. */
export function mascheraPoligono(g: Griglia, poly: [number, number][]) {
  const m = new Uint8Array(g.nx * g.ny)
  if (poly.length < 3) return m
  const lats = poly.map((p) => p[0]), lons = poly.map((p) => p[1])
  const a = cellaDi(g, Math.max(...lats), Math.min(...lons))
  const b = cellaDi(g, Math.min(...lats), Math.max(...lons))
  const c0 = Math.max(0, Math.floor(a.fx)), c1 = Math.min(g.nx - 1, Math.ceil(b.fx))
  const r0 = Math.max(0, Math.floor(a.fy)), r1 = Math.min(g.ny - 1, Math.ceil(b.fy))
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const [lat, lon] = latlngDi(g, c, r)
      if (dentro(lat, lon, poly)) m[r * g.nx + c] = 1
    }
  }
  return m
}

export interface StatisticheArea {
  areaM2: number
  celle: number
  zMin: number; zMax: number; zMedia: number
  pendenzaMedia: number
  /** quota della superficie piana di compenso (media) e movimento terra per spianarla */
  piattoPct: number
  ristagnoAreaM2: number
  ristagnoVolumeM3: number
}

export function statisticheArea(
  g: Griglia, poly: [number, number][], pend: Float32Array, idro: Idrologia | null, sogliaM: number,
): StatisticheArea {
  const m = mascheraPoligono(g, poly)
  let n = 0, zs = 0, zMin = Infinity, zMax = -Infinity, ps = 0, piatte = 0, rA = 0, rV = 0
  const cA = g.cell * g.cell
  for (let k = 0; k < m.length; k++) {
    if (!m[k]) continue
    const z = g.z[k]
    if (Number.isNaN(z)) continue
    n++; zs += z; zMin = Math.min(zMin, z); zMax = Math.max(zMax, z)
    ps += pend[k]; if (pend[k] < 0.1) piatte++
    if (idro && idro.profondita[k] > sogliaM) { rA += cA; rV += idro.profondita[k] * cA }
  }
  return {
    areaM2: areaM2(poly), celle: n,
    zMin, zMax, zMedia: n ? zs / n : NaN,
    pendenzaMedia: n ? ps / n : NaN,
    piattoPct: n ? (piatte / n) * 100 : NaN,
    ristagnoAreaM2: rA, ristagnoVolumeM3: rV,
  }
}

export interface PuntoQuotato {
  nome: string
  lat: number
  lon: number
  z: number
  pendenza: number
  areaDrenataM2: number
  ristagnoM: number
}

export function puntoQuotato(
  g: Griglia, nome: string, lat: number, lon: number, pend: Float32Array | null, idro: Idrologia | null,
): PuntoQuotato {
  const { fx, fy } = cellaDi(g, lat, lon)
  const k = Math.round(Math.max(0, Math.min(g.ny - 1, fy))) * g.nx + Math.round(Math.max(0, Math.min(g.nx - 1, fx)))
  return {
    nome, lat, lon,
    z: campiona(g, g.z, lat, lon),
    pendenza: pend ? pend[k] : NaN,
    areaDrenataM2: idro ? idro.accumulo[k] * g.cell * g.cell : NaN,
    ristagnoM: idro ? idro.profondita[k] : NaN,
  }
}

/** Numero con la virgola, per Excel in italiano. */
const it = (v: number, dec: number) => (Number.isFinite(v) ? v.toFixed(dec).replace('.', ',') : '')

export function csvPunti(pts: PuntoQuotato[]): string {
  const righe = ['nome;latitudine;longitudine;quota_m;pendenza_pct;area_drenata_m2;ristagno_cm']
  for (const p of pts) {
    righe.push([p.nome, it(p.lat, 7), it(p.lon, 7), it(p.z, 2), it(p.pendenza, 2),
      it(p.areaDrenataM2, 0), it(p.ristagnoM * 100, 1)].join(';'))
  }
  return righe.join('\r\n')
}

export function csvProfilo(p: PuntoProfilo[]): string {
  const righe = ['progressiva_m;quota_m;latitudine;longitudine']
  for (const q of p) righe.push([it(q.d, 2), it(q.z, 3), it(q.lat, 7), it(q.lon, 7)].join(';'))
  return righe.join('\r\n')
}

/** Scarica un testo come file (con BOM, cosi' Excel legge gli accenti). */
export function scaricaTesto(nome: string, testo: string, tipo = 'text/csv;charset=utf-8') {
  const blob = new Blob(['﻿' + testo], { type: tipo })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = nome
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
