// Rete di tubazioni più corta possibile dai corsi d'acqua (o canali) ai pivot, con al massimo K pivot
// sulla stessa tratta: albero ricoprente minimo con vincolo di capacità (euristica di Esau-Williams).
// Ogni tratta si allaccia al corso nel punto più vicino del suo pivot di testa; i pivot si collegano fra
// loro centro-centro. I collegamenti fra pivot che attraversano il corso d'acqua non si usano (ogni lato
// prende l'acqua dalla sua sponda).

type LL = number[];
type P = { lng: number; lat: number };

function frame(lat0: number) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  return { kx, ky };
}

function nearestOnSegs(px: number, py: number, segs: number[][]): { d: number; x: number; y: number } {
  let best = { d: Infinity, x: px, y: py };
  for (const [ax, ay, bx, by] of segs) {
    const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1e-9;
    let t = ((px - ax) * vx + (py - ay) * vy) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const x = ax + vx * t, y = ay + vy * t, d = Math.hypot(px - x, py - y);
    if (d < best.d) best = { d, x, y };
  }
  return best;
}

function segCross(a: number[], b: number[], c: number[], d: number[]) {
  const o = (p: number[], q: number[], r: number[]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/**
 * lines: linee d'acqua (lon/lat) a cui ci si può allacciare; piv: pivot; K: pivot massimi per tratta.
 * Restituisce le tubazioni (polilinee lon/lat): un allacciamento al corso per tratta e i tratti fra pivot.
 */
export function shortestPipes(lines: LL[][], piv: P[], K: number): { pipes: LL[][]; lengthM: number; groups: number } {
  const n = piv.length;
  if (!n || !lines.length) return { pipes: [], lengthM: 0, groups: 0 };
  const lat0 = piv.reduce((a, p) => a + p.lat, 0) / n, lon0 = piv.reduce((a, p) => a + p.lng, 0) / n;
  const { kx, ky } = frame(lat0);
  const to = (lng: number, lat: number) => [(lng - lon0) * kx, (lat - lat0) * ky];
  const from = (x: number, y: number) => [lon0 + x / kx, lat0 + y / ky];
  const segs: number[][] = [];
  for (const l of lines) for (let i = 0; i + 1 < l.length; i++) { const a = to(l[i][0], l[i][1]), b = to(l[i + 1][0], l[i + 1][1]); segs.push([a[0], a[1], b[0], b[1]]); }
  if (!segs.length) return { pipes: [], lengthM: 0, groups: 0 };
  const X = piv.map((p) => to(p.lng, p.lat));
  const gate = X.map(([x, y]) => nearestOnSegs(x, y, segs));
  // coppie candidate (vicine) che non attraversano il corso d'acqua
  const near = (() => {
    const ds: number[] = [];
    for (let i = 0; i < n; i++) { let m = Infinity; for (let j = 0; j < n; j++) if (j !== i) m = Math.min(m, Math.hypot(X[i][0] - X[j][0], X[i][1] - X[j][1])); if (Number.isFinite(m)) ds.push(m); }
    ds.sort((a, b) => a - b);
    return (ds[Math.floor(ds.length / 2)] ?? 800) * 3;
  })();
  const pairs: { i: number; j: number; d: number }[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = Math.hypot(X[i][0] - X[j][0], X[i][1] - X[j][1]);
    if (d > near) continue;
    let cross = false;
    for (const s of segs) {
      if (Math.max(s[0], s[2]) < Math.min(X[i][0], X[j][0]) || Math.min(s[0], s[2]) > Math.max(X[i][0], X[j][0]) ||
          Math.max(s[1], s[3]) < Math.min(X[i][1], X[j][1]) || Math.min(s[1], s[3]) > Math.max(X[i][1], X[j][1])) continue;
      if (segCross(X[i], X[j], [s[0], s[1]], [s[2], s[3]])) { cross = true; break; }
    }
    if (!cross) pairs.push({ i, j, d });
  }
  // Esau-Williams: ogni componente ha un nodo di allacciamento (gate) al corso; si unisce la coppia con il
  // risparmio maggiore g(comp i) - d(i,j), se la tratta unita resta entro K pivot
  const comp = X.map((_, i) => i), size = X.map(() => 1), gateNode = X.map((_, i) => i);
  const find = (i: number): number => (comp[i] === i ? i : (comp[i] = find(comp[i])));
  const edges: [number, number][] = [];
  const Kmax = Math.max(1, Math.round(K));
  for (;;) {
    let best: { i: number; j: number; s: number } | null = null;
    for (const { i, j, d } of pairs) {
      const ci = find(i), cj = find(j); if (ci === cj || size[ci] + size[cj] > Kmax) continue;
      const si = gate[gateNode[ci]].d - d, sj = gate[gateNode[cj]].d - d;
      // si toglie l'allacciamento più lungo dei due
      if (si >= sj && si > 0 && (!best || si > best.s)) best = { i, j, s: si };
      else if (sj > si && sj > 0 && (!best || sj > best.s)) best = { i: j, j: i, s: sj };
    }
    if (!best) break;
    const ci = find(best.i), cj = find(best.j);
    edges.push([best.i, best.j]);
    comp[ci] = cj; size[cj] += size[ci];          // la componente di i perde il suo allacciamento e passa da j
  }
  const pipes: LL[][] = [];
  let L = 0;
  const roots = new Set(X.map((_, i) => find(i)));
  for (const r of roots) {
    const g = gateNode[r], q = gate[g];
    if (q.d > 0.5) { pipes.push([from(q.x, q.y), [piv[g].lng, piv[g].lat]]); L += q.d; }
  }
  for (const [a, b] of edges) { pipes.push([[piv[a].lng, piv[a].lat], [piv[b].lng, piv[b].lat]]); L += Math.hypot(X[a][0] - X[b][0], X[a][1] - X[b][1]); }
  return { pipes, lengthM: L, groups: roots.size };
}
