// Settori di pompaggio: gruppi di pivot serviti da una stazione, con la stazione nel punto giusto
// e le reti ad albero (principale dalla presa alle stazioni, distribuzione dalla stazione ai pivot).
// Coordinate locali in metri (x verso est, y verso nord) attorno a un punto di riferimento.

export type XY = { x: number; y: number };
export type SPivot = XY & { q: number; r: number; f: number };   // portata l/s, raggio m, campo

/** Conversione lon/lat ↔ metri locali (equirettangolare attorno a lat0). */
export function localFrame(lon0: number, lat0: number) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  return {
    to: (lon: number, lat: number): XY => ({ x: (lon - lon0) * kx, y: (lat - lat0) * ky }),
    from: (p: XY): number[] => [lon0 + p.x / kx, lat0 + p.y / ky],
  };
}

const d2 = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Settori con portata massima per stazione: per ogni campo k = ⌈Q / qMax⌉ gruppi, k-medie con
 * assegnazione a capacità (ogni pivot va al centro più vicino che ha ancora portata libera).
 * Se un settore resta più largo di dMax (m dal baricentro al pivot più lontano) si aggiunge un gruppo.
 */
export function capSectors(P: SPivot[], qMax: number, dMax = 4000, kMin = 0): number[] {
  const lab = P.map(() => -1);
  const fields = [...new Set(P.map((p) => p.f))];
  let base = 0;
  const qTot = P.reduce((a, p) => a + p.q, 0);
  for (const f of fields) {
    const idx = P.map((_, i) => i).filter((i) => P[i].f === f);
    const Qf = idx.reduce((a, i) => a + P[i].q, 0);
    // settori minimi richiesti (kMin si ripartisce sui campi in proporzione alla portata)
    let k = Math.max(1, Math.ceil(Qf / Math.max(1, qMax) - 1e-9), kMin > 0 ? Math.round((kMin * Qf) / Math.max(1e-9, qTot)) : 1);
    k = Math.min(k, idx.length);
    let best: number[] = [];
    for (;;) {
      best = kmeansCap(idx.map((i) => P[i]), k, (Qf / k) * 1.0001 + 1e-6);
      const wide = Array.from({ length: k }, (_, j) => {
        const m = idx.filter((_, t) => best[t] === j).map((i) => P[i]); if (!m.length) return 0;
        const c = { x: m.reduce((a, p) => a + p.x, 0) / m.length, y: m.reduce((a, p) => a + p.y, 0) / m.length };
        return Math.max(...m.map((p) => d2(p, c)));
      });
      if (k >= idx.length || Math.max(...wide) <= dMax) break;
      k++;
    }
    idx.forEach((i, t) => { lab[i] = base + best[t]; });
    base += k;
  }
  return lab;
}

function kmeansCap(P: SPivot[], k: number, cap: number): number[] {
  const n = P.length; if (k <= 1) return P.map(() => 0);
  // semi: il più a ovest, poi il più lontano dai semi già scelti
  const seeds = [P.reduce((a, p, i) => (p.x < P[a].x ? i : a), 0)];
  while (seeds.length < k) {
    let bi = 0, bd = -1;
    P.forEach((p, i) => { const d = Math.min(...seeds.map((s) => d2(p, P[s]))); if (d > bd) { bd = d; bi = i; } });
    seeds.push(bi);
  }
  let C: XY[] = seeds.map((s) => ({ x: P[s].x, y: P[s].y }));
  let lab = P.map(() => 0);
  for (let it = 0; it < 25; it++) {
    // assegnazione a capacità: coppie (pivot, centro) dalla più vicina
    const pairs: [number, number, number][] = [];
    P.forEach((p, i) => C.forEach((c, j) => pairs.push([d2(p, c), i, j])));
    pairs.sort((a, b) => a[0] - b[0]);
    const load = C.map(() => 0), done = P.map(() => false), nl = P.map(() => 0);
    let left = n;
    for (const [, i, j] of pairs) {
      if (done[i] || load[j] + P[i].q > cap) continue;
      done[i] = true; nl[i] = j; load[j] += P[i].q; if (--left === 0) break;
    }
    // chi è rimasto (capacità esaurita per arrotondamenti) va al centro più vicino
    P.forEach((p, i) => { if (!done[i]) nl[i] = C.reduce((a, c, j) => (d2(p, c) < d2(p, C[a]) ? j : a), 0); });
    const same = nl.every((v, i) => v === lab[i]);
    lab = nl;
    C = C.map((c, j) => {
      const m = P.filter((_, i) => lab[i] === j); if (!m.length) return c;
      const w = m.reduce((a, p) => a + p.q, 0) || 1;
      return { x: m.reduce((a, p) => a + p.x * p.q, 0) / w, y: m.reduce((a, p) => a + p.y * p.q, 0) / w };
    });
    if (same && it > 0) break;
  }
  return lab;
}

/**
 * Posto della stazione di un settore: il punto che rende minima la somma portata × distanza dai suoi
 * pivot (meno tubo grosso), fuori da tutti i cerchi dei pivot (margine `clear`) e, se possibile,
 * dentro il campo. Ricerca su griglia di passo `step` nel riquadro del settore allargato.
 */
export function stationSpot(sec: SPivot[], all: SPivot[], inField?: (p: XY) => boolean, clear = 15, step = 20): XY {
  const xs = sec.map((p) => p.x), ys = sec.map((p) => p.y), pad = 300;
  const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
  const near = all.filter((p) => p.x + p.r > x0 - clear && p.x - p.r < x1 + clear && p.y + p.r > y0 - clear && p.y - p.r < y1 + clear);
  let best: XY | null = null, bc = Infinity, bestOut: XY | null = null, bco = Infinity;
  const st = Math.max(step, Math.sqrt(((x1 - x0) * (y1 - y0)) / 40000));   // al massimo ~40 000 posti
  for (let y = y0; y <= y1; y += st) for (let x = x0; x <= x1; x += st) {
    const q = { x, y };
    let free = true;
    for (const p of near) if (Math.hypot(x - p.x, y - p.y) < p.r + clear) { free = false; break; }
    if (!free) continue;
    let c = 0; for (const p of sec) c += p.q * Math.hypot(x - p.x, y - p.y);
    if (!inField || inField(q)) { if (c < bc) { bc = c; best = q; } }
    else if (c < bco) { bco = c; bestOut = q; }
  }
  if (best && (!bestOut || bc <= bco * 1.15)) return best;           // dentro il campo, se non costa troppo di più
  if (bestOut) return bestOut;
  const w = sec.reduce((a, p) => a + p.q, 0) || 1;
  return { x: sec.reduce((a, p) => a + p.x * p.q, 0) / w, y: sec.reduce((a, p) => a + p.y * p.q, 0) / w };
}

/** Albero di Prim dal nodo 0 (radice) sugli altri: parent[i] per i ≥ 1 (parent[0] = -1). */
export function primTree(nodes: XY[]): number[] {
  const n = nodes.length, par = nodes.map(() => -1), inT = nodes.map(() => false), dist = nodes.map(() => Infinity);
  if (!n) return par;
  inT[0] = true;
  for (let i = 1; i < n; i++) { dist[i] = d2(nodes[0], nodes[i]); par[i] = 0; }
  for (let it = 1; it < n; it++) {
    let bi = -1; for (let i = 1; i < n; i++) if (!inT[i] && (bi < 0 || dist[i] < dist[bi])) bi = i;
    if (bi < 0) break;
    inT[bi] = true;
    for (let i = 1; i < n; i++) if (!inT[i]) { const d = d2(nodes[bi], nodes[i]); if (d < dist[i]) { dist[i] = d; par[i] = bi; } }
  }
  return par;
}

/** Portata di ogni arco (nodo i → parent[i]) = domanda del nodo e di tutto ciò che sta a valle. */
export function treeFlows(par: number[], demand: number[]): number[] {
  const n = par.length, acc = demand.slice();
  // ordine: dalle foglie verso la radice (profondità decrescente)
  const depth = par.map((_, i) => { let d = 0, k = i; while (par[k] >= 0 && d <= n) { k = par[k]; d++; } return d; });
  const order = par.map((_, i) => i).sort((a, b) => depth[b] - depth[a]);
  for (const i of order) if (par[i] >= 0) acc[par[i]] += acc[i];
  return acc;           // acc[i] = portata dell'arco che entra in i
}

/** Diametro commerciale (mm) per la velocità massima, e perdite Hazen-Williams (m) su L metri. */
export function pipeSize(qLs: number, L: number, dns: number[], vMax: number, C: number) {
  const Q = qLs / 1000;
  let n = 1, dn = dns[dns.length - 1];
  for (;;) {
    const fit = dns.find((d) => (Q / n) / (Math.PI * Math.pow(d / 1000, 2) / 4) <= vMax);
    if (fit) { dn = fit; break; }
    n++;
  }
  const D = dn / 1000, q1 = Q / n;
  const hf = Q > 0 ? (10.67 * L * Math.pow(q1, 1.852)) / (Math.pow(Math.max(60, C), 1.852) * Math.pow(D, 4.87)) : 0;
  return { dn, n, hf };
}

/**
 * Rete di distribuzione di un settore: albero di Prim dalla stazione ai pivot, diametri per tratto,
 * perdite fino a ogni pivot. Restituisce i tratti (indici: 0 = stazione, 1.. = pivot del settore).
 */
export function sectorNet(st: XY, piv: SPivot[], dns: number[], vMax: number, C: number) {
  const nodes: XY[] = [st, ...piv];
  const par = primTree(nodes);
  const q = treeFlows(par, [0, ...piv.map((p) => p.q)]);
  const edges = nodes.map((_, i) => i).filter((i) => par[i] >= 0).map((i) => {
    const L = d2(nodes[i], nodes[par[i]]);
    return { a: par[i], b: i, L, q: q[i], ...pipeSize(q[i], L, dns, vMax, C) };
  });
  const hfTo = nodes.map(() => 0);
  const byB = new Map(edges.map((e) => [e.b, e]));
  for (let i = 1; i < nodes.length; i++) { let k = i, h = 0, g = 0; while (k > 0 && g++ <= nodes.length) { const e = byB.get(k)!; h += e.hf; k = e.a; } hfTo[i] = h; }
  return { nodes, par, edges, hfTo: hfTo.slice(1), L: edges.reduce((a, e) => a + e.L, 0) };
}
