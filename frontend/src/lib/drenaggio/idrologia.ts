/**
 * Drenaggio — analisi dei deflussi superficiali su griglia.
 *
 *  1. Riempimento delle depressioni con Priority-Flood + ε (Barnes et al.,
 *     2014): le depressioni si riempiono fino alla quota di sfioro e le zone
 *     piatte ricevono una pendenza infinitesima verso l'uscita, cosi' ogni
 *     cella ha una via di scolo.
 *  2. Ristagni = quota riempita − quota del terreno (acqua che resta in campo).
 *  3. Direzioni di scorrimento D8 (pendenza massima sugli 8 vicini).
 *  4. Accumulo di flusso: numero di celle che drenano in ciascuna cella.
 *  5. Bacino a monte di un punto e raggruppamento dei ristagni.
 *
 * Modulo portabile: TypeScript puro.
 */
import type { Griglia } from './griglia'

const DX = [-1, 0, 1, -1, 1, -1, 0, 1]
const DY = [-1, -1, -1, 0, 0, 1, 1, 1]
const DIST = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2]
/** incremento ε sulle celle piatte o riempite, in metri (1/1000 di mm) */
const EPS = 1e-6

/** Heap binario minimo su (quota, indice cella). */
class Heap {
  private v = new Float64Array(1024)
  private i = new Int32Array(1024)
  size = 0
  push(val: number, idx: number) {
    if (this.size === this.v.length) {
      const v = new Float64Array(this.size * 2); v.set(this.v); this.v = v
      const i = new Int32Array(this.size * 2); i.set(this.i); this.i = i
    }
    let k = this.size++
    while (k > 0) {
      const p = (k - 1) >> 1
      if (this.v[p] <= val) break
      this.v[k] = this.v[p]; this.i[k] = this.i[p]; k = p
    }
    this.v[k] = val; this.i[k] = idx
  }
  topVal() { return this.v[0] }
  pop(): number {
    const out = this.i[0]
    const n = --this.size
    if (n > 0) {
      const val = this.v[n], idx = this.i[n]
      let k = 0
      for (;;) {
        let c = 2 * k + 1
        if (c >= n) break
        if (c + 1 < n && this.v[c + 1] < this.v[c]) c++
        if (this.v[c] >= val) break
        this.v[k] = this.v[c]; this.i[k] = this.i[c]; k = c
      }
      this.v[k] = val; this.i[k] = idx
    }
    return out
  }
}

export interface Idrologia {
  /** quote dopo il riempimento (con ε), metri */
  riempito: Float64Array
  /** profondita' dell'acqua di ristagno, metri (0 dove scola) */
  profondita: Float32Array
  /** cella verso cui scola ogni cella (-1 = uscita dalla griglia o senza dato) */
  ricevente: Int32Array
  /** celle che drenano in ciascuna cella, compresa se stessa */
  accumulo: Float32Array
  /** millisecondi impiegati */
  ms: number
}

export function analizzaIdrologia(g: Griglia): Idrologia {
  const t0 = performance.now()
  const { nx, ny, z } = g
  const N = nx * ny
  const f = new Float64Array(N)
  const chiuso = new Uint8Array(N)
  for (let k = 0; k < N; k++) {
    f[k] = z[k]
    if (Number.isNaN(z[k])) chiuso[k] = 1
  }

  // --- 1. Priority-Flood + ε -------------------------------------------
  const heap = new Heap()
  const pit = new Int32Array(N)
  let pTesta = 0, pCoda = 0
  // semi: celle di bordo e celle accanto a un buco nel dato
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const k = r * nx + c
      if (chiuso[k]) continue
      let bordo = r === 0 || c === 0 || r === ny - 1 || c === nx - 1
      if (!bordo) {
        for (let d = 0; d < 8; d++) if (Number.isNaN(z[(r + DY[d]) * nx + c + DX[d]])) { bordo = true; break }
      }
      if (bordo) { chiuso[k] = 1; heap.push(f[k], k) }
    }
  }
  while (pTesta < pCoda || heap.size > 0) {
    let k: number
    if (pTesta < pCoda && heap.size > 0 && heap.topVal() === f[pit[pTesta]]) k = heap.pop()
    else if (pTesta < pCoda) k = pit[pTesta++]
    else k = heap.pop()
    const r = (k / nx) | 0, c = k - r * nx
    const soglia = f[k] + EPS
    for (let d = 0; d < 8; d++) {
      const rr = r + DY[d], cc = c + DX[d]
      if (rr < 0 || cc < 0 || rr >= ny || cc >= nx) continue
      const n = rr * nx + cc
      if (chiuso[n]) continue
      chiuso[n] = 1
      if (f[n] <= soglia) { f[n] = soglia; pit[pCoda++] = n }
      else heap.push(f[n], n)
    }
  }

  // --- 2. profondita' di ristagno --------------------------------------
  const prof = new Float32Array(N)
  for (let k = 0; k < N; k++) {
    const v = f[k] - z[k]
    prof[k] = Number.isNaN(v) ? NaN : v > 0 ? v : 0
  }

  // --- 3. direzioni D8 sul terreno riempito ------------------------------
  const rcv = new Int32Array(N).fill(-1)
  const ingresso = new Int32Array(N)
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const k = r * nx + c
      if (Number.isNaN(z[k])) continue
      let best = 0, bn = -1
      for (let d = 0; d < 8; d++) {
        const rr = r + DY[d], cc = c + DX[d]
        if (rr < 0 || cc < 0 || rr >= ny || cc >= nx) continue
        const n = rr * nx + cc
        if (Number.isNaN(z[n])) continue
        const s = (f[k] - f[n]) / DIST[d]
        if (s > best) { best = s; bn = n }
      }
      rcv[k] = bn
      if (bn >= 0) ingresso[bn]++
    }
  }

  // --- 4. accumulo (ordine topologico) -----------------------------------
  const acc = new Float32Array(N)
  const coda = new Int32Array(N)
  let qT = 0, qC = 0
  for (let k = 0; k < N; k++) {
    if (Number.isNaN(z[k])) { acc[k] = NaN; continue }
    acc[k] = 1
    if (ingresso[k] === 0) coda[qC++] = k
  }
  while (qT < qC) {
    const k = coda[qT++]
    const n = rcv[k]
    if (n < 0) continue
    acc[n] += acc[k]
    if (--ingresso[n] === 0) coda[qC++] = n
  }

  return { riempito: f, profondita: prof, ricevente: rcv, accumulo: acc, ms: performance.now() - t0 }
}

export interface Ristagno {
  id: number
  celle: number
  areaM2: number
  volumeM3: number
  profMax: number
  /** cella piu' profonda */
  col: number
  row: number
}

/** Raggruppa le celle con ristagno oltre la soglia (metri) in zone connesse. */
export function ristagni(g: Griglia, idro: Idrologia, sogliaM: number): { zone: Ristagno[]; etichette: Int32Array } {
  const { nx, ny } = g
  const N = nx * ny
  const p = idro.profondita
  const et = new Int32Array(N)
  const cellaA = g.cell * g.cell
  const zone: Ristagno[] = []
  const pila = new Int32Array(N)
  let id = 0
  for (let k0 = 0; k0 < N; k0++) {
    if (et[k0] || !(p[k0] > sogliaM)) continue
    id++
    let top = 0
    pila[top++] = k0; et[k0] = id
    const z: Ristagno = { id, celle: 0, areaM2: 0, volumeM3: 0, profMax: 0, col: 0, row: 0 }
    while (top) {
      const k = pila[--top]
      z.celle++
      z.volumeM3 += p[k] * cellaA
      if (p[k] > z.profMax) { z.profMax = p[k]; z.row = (k / nx) | 0; z.col = k - z.row * nx }
      const r = (k / nx) | 0, c = k - r * nx
      for (let d = 0; d < 8; d++) {
        const rr = r + DY[d], cc = c + DX[d]
        if (rr < 0 || cc < 0 || rr >= ny || cc >= nx) continue
        const n = rr * nx + cc
        if (!et[n] && p[n] > sogliaM) { et[n] = id; pila[top++] = n }
      }
    }
    z.areaM2 = z.celle * cellaA
    zone.push(z)
  }
  zone.sort((a, b) => b.volumeM3 - a.volumeM3)
  return { zone, etichette: et }
}

/**
 * Bacino a monte di una cella. Il punto viene prima spostato sulla cella con
 * l'accumulo massimo entro 'raggio' celle, cosi' un clic vicino a un fosso
 * prende il fosso e non il campo accanto.
 */
export function bacino(g: Griglia, idro: Idrologia, col: number, row: number, raggio = 3) {
  const { nx, ny } = g
  let best = -1, bk = -1
  for (let r = Math.max(0, row - raggio); r <= Math.min(ny - 1, row + raggio); r++) {
    for (let c = Math.max(0, col - raggio); c <= Math.min(nx - 1, col + raggio); c++) {
      const k = r * nx + c
      if (idro.accumulo[k] > best) { best = idro.accumulo[k]; bk = k }
    }
  }
  const maschera = new Uint8Array(nx * ny)
  if (bk < 0) return { maschera, celle: 0, areaM2: 0, uscita: -1 }
  const coda = new Int32Array(nx * ny)
  let t = 0, cnt = 0
  coda[cnt++] = bk; maschera[bk] = 1
  while (t < cnt) {
    const k = coda[t++]
    const r = (k / nx) | 0, c = k - r * nx
    for (let d = 0; d < 8; d++) {
      const rr = r + DY[d], cc = c + DX[d]
      if (rr < 0 || cc < 0 || rr >= ny || cc >= nx) continue
      const n = rr * nx + cc
      if (!maschera[n] && idro.ricevente[n] === k) { maschera[n] = 1; coda[cnt++] = n }
    }
  }
  return { maschera, celle: cnt, areaM2: cnt * g.cell * g.cell, uscita: bk }
}

/** Percorso dell'acqua da una cella fino all'uscita (indici di cella). */
export function percorsoAValle(idro: Idrologia, k0: number, max = 100000): number[] {
  const out: number[] = []
  let k = k0
  while (k >= 0 && out.length < max) { out.push(k); k = idro.ricevente[k] }
  return out
}
