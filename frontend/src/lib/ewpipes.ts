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
export function shortestPipes(lines: LL[][], piv: P[], K: number, mergeM = 0): { pipes: LL[][]; lengthM: number; groups: number; stations: number } {
  const n = piv.length;
  if (!n || !lines.length) return { pipes: [], lengthM: 0, groups: 0, stations: 0 };
  const lat0 = piv.reduce((a, p) => a + p.lat, 0) / n, lon0 = piv.reduce((a, p) => a + p.lng, 0) / n;
  const { kx, ky } = frame(lat0);
  const to = (lng: number, lat: number) => [(lng - lon0) * kx, (lat - lat0) * ky];
  const from = (x: number, y: number) => [lon0 + x / kx, lat0 + y / ky];
  const segs: number[][] = [];
  for (const l of lines) for (let i = 0; i + 1 < l.length; i++) { const a = to(l[i][0], l[i][1]), b = to(l[i + 1][0], l[i + 1][1]); segs.push([a[0], a[1], b[0], b[1]]); }
  if (!segs.length) return { pipes: [], lengthM: 0, groups: 0, stations: 0 };
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
  const roots = [...new Set(X.map((_, i) => find(i)))];
  // Accorpamento delle prese: tratte che si allacciano al corso a meno di mergeM metri l'una dall'altra
  // prendono l'acqua dallo stesso punto (una stazione sola), se il tubo in più non supera mergeM e non
  // si attraversa il corso. Si uniscono prima le coppie che costano meno tubo in più.
  type Cl = { m: number[]; s: number[]; cost: number };
  const heads = roots.map((r) => X[gateNode[r]]);
  const crossesRiver = (h: number[], st: number[]) => {
    const dx = h[0] - st[0], dy = h[1] - st[1], l = Math.hypot(dx, dy) || 1;
    const a = [st[0] + (dx / l) * 3, st[1] + (dy / l) * 3];                     // 3 m dentro, per non toccare la sponda
    for (const sg of segs) {
      if (Math.max(sg[0], sg[2]) < Math.min(a[0], h[0]) || Math.min(sg[0], sg[2]) > Math.max(a[0], h[0]) ||
          Math.max(sg[1], sg[3]) < Math.min(a[1], h[1]) || Math.min(sg[1], sg[3]) > Math.max(a[1], h[1])) continue;
      if (segCross(a, h, [sg[0], sg[1]], [sg[2], sg[3]])) return true;
    }
    return false;
  };
  let cls: Cl[] = roots.map((r, k) => { const q = gate[gateNode[r]]; return { m: [k], s: [q.x, q.y], cost: q.d }; });
  if (mergeM > 0) {
    for (;;) {
      let best: { a: number; b: number; c: Cl; extra: number } | null = null;
      for (let a = 0; a < cls.length; a++) for (let b = a + 1; b < cls.length; b++) {
        if (Math.hypot(cls[a].s[0] - cls[b].s[0], cls[a].s[1] - cls[b].s[1]) > mergeM) continue;
        const m = [...cls[a].m, ...cls[b].m];
        for (const st of [cls[a].s, cls[b].s]) {
          let cost = 0, ok = true;
          for (const k of m) { cost += Math.hypot(heads[k][0] - st[0], heads[k][1] - st[1]); if (crossesRiver(heads[k], st)) { ok = false; break; } }
          if (!ok) continue;
          const extra = cost - cls[a].cost - cls[b].cost;
          if (extra <= mergeM && (!best || extra < best.extra)) best = { a, b, c: { m, s: st, cost }, extra };
        }
      }
      if (!best) break;
      cls = cls.filter((_, k) => k !== best!.a && k !== best!.b); cls.push(best.c);
    }
  }
  for (const c of cls) for (const k of c.m) {
    const g = gateNode[roots[k]], d = Math.hypot(heads[k][0] - c.s[0], heads[k][1] - c.s[1]);
    if (d > 0.5) { pipes.push([from(c.s[0], c.s[1]), [piv[g].lng, piv[g].lat]]); L += d; }
  }
  for (const [a, b] of edges) { pipes.push([[piv[a].lng, piv[a].lat], [piv[b].lng, piv[b].lat]]); L += Math.hypot(X[a][0] - X[b][0], X[a][1] - X[b][1]); }
  return { pipes, lengthM: L, groups: roots.length, stations: cls.length };
}

/**
 * Accorpa le prese: le tubazioni che partono dal corso (primo punto a meno di 2 m da una linea d'acqua) a meno
 * di mergeM metri l'una dall'altra si spostano su un punto di presa comune (una stazione sola), se il tubo in
 * più non supera mergeM e il nuovo primo tratto non attraversa il corso. Vale per qualsiasi rete (albero o file).
 */
// barriers: tutti i corsi d'acqua e i canali che il tubo nuovo non deve attraversare (oltre a `lines`).
// Si accorpano solo prese sulla STESSA SPONDA: i pivot serviti devono stare dalla stessa parte del corso
// rispetto alla stazione scelta, e il tratto nuovo non deve attraversare né fiumi né canali.
function dSegXY(p: number[], g: number[]) {
  const vx = g[2] - g[0], vy = g[3] - g[1], l2 = vx * vx + vy * vy || 1e-9;
  let t = ((p[0] - g[0]) * vx + (p[1] - g[1]) * vy) / l2; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - g[0] - vx * t, p[1] - g[1] - vy * t);
}
export function mergeIntakes(lines: LL[][], pipes: LL[][], mergeM: number, barriers: LL[][] = []): { pipes: LL[][]; stations: number; before: number } {
  const all = pipes.flat(); if (!all.length || !lines.length || mergeM <= 0) return { pipes, stations: 0, before: 0 };
  const lat0 = all.reduce((a, p) => a + p[1], 0) / all.length, lon0 = all.reduce((a, p) => a + p[0], 0) / all.length;
  const { kx, ky } = frame(lat0);
  const to = (q: LL) => [(q[0] - lon0) * kx, (q[1] - lat0) * ky];
  const from = (x: number, y: number) => [lon0 + x / kx, lat0 + y / ky];
  const segs: number[][] = [];
  for (const l of lines) for (let i = 0; i + 1 < l.length; i++) { const a = to(l[i]), b = to(l[i + 1]); segs.push([a[0], a[1], b[0], b[1]]); }
  const bar: number[][] = segs.slice();
  for (const l of barriers) for (let i = 0; i + 1 < l.length; i++) { const a = to(l[i]), b = to(l[i + 1]); bar.push([a[0], a[1], b[0], b[1]]); }
  // sponda: segno del punto rispetto alla tangente del corso nel punto della presa
  const side = (st: number[], q: number[]) => {
    let bd = Infinity, sg = segs[0];
    for (const g of segs) { const d = dSegXY(st, g); if (d < bd) { bd = d; sg = g; } }
    const v = (sg[2] - sg[0]) * (q[1] - st[1]) - (sg[3] - sg[1]) * (q[0] - st[0]);
    return v >= 0 ? 1 : -1;
  };
  // prese: tubazioni il cui primo (o ultimo) punto tocca il corso; si orientano dalla presa verso il campo
  type In = { k: number; s: number[]; next: number[] };
  const ins: In[] = [];
  const out = pipes.map((c) => c.slice());
  out.forEach((c, k) => {
    if (c.length < 2) return;
    const a = to(c[0]), b = to(c[c.length - 1]);
    const da = nearestOnSegs(a[0], a[1], segs).d, db = nearestOnSegs(b[0], b[1], segs).d;
    if (Math.min(da, db) > 2) return;
    if (db < da) { c.reverse(); }
    ins.push({ k, s: to(c[0]), next: to(c[1]) });
  });
  const crosses = (h: number[], st: number[]) => {
    const dx = h[0] - st[0], dy = h[1] - st[1], l = Math.hypot(dx, dy) || 1;
    const a = [st[0] + (dx / l) * 3, st[1] + (dy / l) * 3];
    for (const sg of bar) {
      if (Math.max(sg[0], sg[2]) < Math.min(a[0], h[0]) || Math.min(sg[0], sg[2]) > Math.max(a[0], h[0]) ||
          Math.max(sg[1], sg[3]) < Math.min(a[1], h[1]) || Math.min(sg[1], sg[3]) > Math.max(a[1], h[1])) continue;
      if (segCross(a, h, [sg[0], sg[1]], [sg[2], sg[3]])) return true;
    }
    return false;
  };
  // prese già coincidenti (stessa stazione) partono insieme
  type Cl = { m: number[]; s: number[]; cost: number };
  let cls: Cl[] = [];
  for (let i = 0; i < ins.length; i++) {
    const c = cls.find((x) => Math.hypot(x.s[0] - ins[i].s[0], x.s[1] - ins[i].s[1]) < 5);
    const d = Math.hypot(ins[i].next[0] - ins[i].s[0], ins[i].next[1] - ins[i].s[1]);
    if (c) { c.m.push(i); c.cost += d; } else cls.push({ m: [i], s: ins[i].s, cost: d });
  }
  const before = cls.length;
  for (;;) {
    let best: { a: number; b: number; c: Cl; extra: number } | null = null;
    for (let a = 0; a < cls.length; a++) for (let b = a + 1; b < cls.length; b++) {
      if (Math.hypot(cls[a].s[0] - cls[b].s[0], cls[a].s[1] - cls[b].s[1]) > mergeM) continue;
      const m = [...cls[a].m, ...cls[b].m];
      for (const st of [cls[a].s, cls[b].s]) {
        let cost = 0, ok = true;
        const sd = side(st, ins[m[0]].next);
        for (const i of m) { if (side(st, ins[i].next) !== sd) { ok = false; break; } }
        if (!ok) continue;
        for (const i of m) { cost += Math.hypot(ins[i].next[0] - st[0], ins[i].next[1] - st[1]); if (crosses(ins[i].next, st)) { ok = false; break; } }
        if (!ok) continue;
        const extra = cost - cls[a].cost - cls[b].cost;
        if (extra <= mergeM && (!best || extra < best.extra)) best = { a, b, c: { m, s: st, cost }, extra };
      }
    }
    if (!best) break;
    cls = cls.filter((_, k) => k !== best!.a && k !== best!.b); cls.push(best.c);
  }
  for (const c of cls) for (const i of c.m) out[ins[i].k][0] = from(c.s[0], c.s[1]);
  return { pipes: out, stations: cls.length, before };
}
