// Rete elettrica di un progetto: dai punti di consegna (AT, MT o BT) ai carichi (pivot e stazioni di pompaggio).
// - I carichi si raggruppano in cabine MT/BT: ogni cabina serve i carichi entro la distanza massima in bassa
//   tensione e fino alla potenza massima del trasformatore.
// - La media tensione va dai punti di consegna AT/MT alle cabine con un albero di lunghezza minima; un punto AT
//   porta con sé una stazione AT/MT.
// - Un punto di consegna BT alimenta direttamente i carichi vicini (entro la distanza BT e fino alla sua potenza).
// - I cavi seguono le strade e le trincee dei tubi: si va al punto più vicino della rete, si segue la rete e si
//   esce verso il carico; dove la rete non c'è si va in linea retta.

export type Level = "AT" | "MT" | "BT";
export type Supply = { pt: number[]; level: Level };
export type Load = { pt: number[]; kW: number; name: string };
export type Cabin = { pt: number[]; kW: number; kVA: number; loads: number[]; bt?: number };   // bt: indice del punto BT (senza trasformatore)
export type MtLine = { coords: number[][]; L: number; kVA: number; sec: number };
export type LvRun = { load: number; cabin: number; coords: number[][]; L: number; kW: number; name: string };
export type PowerNet = { cabins: Cabin[]; mt: MtLine[]; lv: LvRun[]; atStations: number; unserved: number[] };

const KVA = [100, 160, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500];
const kvaFor = (kW: number) => KVA.find((k) => k >= kW / 0.85 / 0.8) ?? Math.ceil(kW / 0.85 / 0.8);

function frame(lat0: number) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  return { kx, ky };
}

/** Grafo delle linee (strade, tubi) con instradamento fra due punti qualsiasi. */
export function lineRouter(lines: number[][][], lat0: number) {
  const { kx, ky } = frame(lat0);
  const d = (a: number[], b: number[]) => Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * ky);
  const key = (q: number[]) => `${q[0].toFixed(6)},${q[1].toFixed(6)}`;
  const pos = new Map<string, number[]>(), adj = new Map<string, [string, number][]>();
  const segs: [string, string][] = [];
  for (const l of lines) for (let i = 0; i + 1 < l.length; i++) {
    const a = key(l[i]), b = key(l[i + 1]); if (a === b) continue;
    pos.set(a, l[i]); pos.set(b, l[i + 1]);
    const w = d(l[i], l[i + 1]);
    (adj.get(a) ?? adj.set(a, []).get(a)!).push([b, w]); (adj.get(b) ?? adj.set(b, []).get(b)!).push([a, w]);
    segs.push([a, b]);
  }
  // nodi vicini (meno di 3 m) uniti: strade e tubi che si toccano diventano una rete sola
  const ks = [...pos.keys()];
  const cell = new Map<string, string[]>();
  const ck = (q: number[]) => `${Math.floor((q[0] * kx) / 5)},${Math.floor((q[1] * ky) / 5)}`;
  for (const k of ks) { const c = ck(pos.get(k)!); (cell.get(c) ?? cell.set(c, []).get(c)!).push(k); }
  for (const k of ks) {
    const p = pos.get(k)!, cx = Math.floor((p[0] * kx) / 5), cy = Math.floor((p[1] * ky) / 5);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const o of cell.get(`${cx + dx},${cy + dy}`) ?? []) {
      if (o <= k) continue;
      const w = d(p, pos.get(o)!); if (w > 3) continue;
      (adj.get(k) ?? adj.set(k, []).get(k)!).push([o, w]); (adj.get(o) ?? adj.set(o, []).get(o)!).push([k, w]);
    }
  }
  const snap = (p: number[]) => {
    let best: { a: string; b: string; q: number[]; d: number } | null = null;
    for (const [a, b] of segs) {
      const A = pos.get(a)!, B = pos.get(b)!;
      const vx = (B[0] - A[0]) * kx, vy = (B[1] - A[1]) * ky, l2 = vx * vx + vy * vy || 1e-9;
      const t = Math.max(0, Math.min(1, (((p[0] - A[0]) * kx) * vx + ((p[1] - A[1]) * ky) * vy) / l2));
      const q = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t], dd = d(p, q);
      if (!best || dd < best.d) best = { a, b, q, d: dd };
    }
    return best;
  };
  const trees = new Map<string, { dist: Map<string, number>; prev: Map<string, string> }>();
  const tree = (src: string) => {
    const c = trees.get(src); if (c) return c;
    const dist = new Map<string, number>([[src, 0]]), prev = new Map<string, string>(), done = new Set<string>();
    const heap: [number, string][] = [[0, src]];
    while (heap.length) {
      let bi = 0; for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[bi][0]) bi = i;
      const [du, u] = heap[bi]; heap[bi] = heap[heap.length - 1]; heap.pop();
      if (done.has(u)) continue; done.add(u);
      for (const [v, w] of adj.get(u) ?? []) if (du + w < (dist.get(v) ?? Infinity)) { dist.set(v, du + w); prev.set(v, u); heap.push([du + w, v]); }
    }
    const r = { dist, prev }; trees.set(src, r); return r;
  };
  const snapCache = new Map<string, ReturnType<typeof snap>>();
  const snapC = (p: number[]) => { const k = key(p); if (!snapCache.has(k)) snapCache.set(k, snap(p)); return snapCache.get(k)!; };
  /** Percorso da a a b: lungo la rete se conviene, altrimenti in linea retta. */
  const route = (a: number[], b: number[]): { coords: number[][]; L: number } => {
    const straight = { coords: [a, b], L: d(a, b) };
    if (!segs.length) return straight;
    const sa = snapC(a), sb = snapC(b); if (!sa || !sb) return straight;
    let best: { L: number; coords: number[][] } | null = null;
    for (const na of [sa.a, sa.b]) {
      const T = tree(na);
      for (const nb of [sb.a, sb.b]) {
        const dn = T.dist.get(nb); if (dn == null) continue;
        const L = sa.d + d(sa.q, pos.get(na)!) + dn + d(pos.get(nb)!, sb.q) + sb.d;
        if (!best || L < best.L) {
          const path: number[][] = []; let k: string | undefined = nb;
          while (k) { path.push(pos.get(k)!); if (k === na) break; k = T.prev.get(k); }
          path.reverse();
          best = { L, coords: [a, sa.q, ...path, sb.q, b] };
        }
      }
    }
    // la rete conviene solo se non allunga troppo il percorso (meno del 60% in più della linea retta)
    if (!best || best.L > straight.L * 1.6 + 50) return straight;
    const out: number[][] = [];
    for (const q of best.coords) if (!out.length || d(out[out.length - 1], q) > 0.5) out.push(q);
    return { coords: out, L: best.L };
  };
  return { route, dist: d };
}

/**
 * Progetta la rete. lvMax: distanza massima (m) in bassa tensione dalla cabina al carico; trafoMaxKVA: taglia
 * massima di una cabina; btMaxKW: potenza massima di un punto di consegna BT.
 */
export function designPower(supplies: Supply[], loads: Load[], lines: number[][][],
  opt: { lvMax?: number; trafoMaxKVA?: number; btMaxKW?: number } = {}): PowerNet {
  const lvMax = opt.lvMax ?? 1000, trafoMax = opt.trafoMaxKVA ?? 1000, btMax = opt.btMaxKW ?? 100;
  const empty: PowerNet = { cabins: [], mt: [], lv: [], atStations: 0, unserved: loads.map((_, i) => i) };
  if (!supplies.length || !loads.length) return empty;
  const lat0 = loads.reduce((a, l) => a + l.pt[1], 0) / loads.length;
  const R = lineRouter(lines, lat0);
  const cabins: Cabin[] = [];
  const free = new Set(loads.map((_, i) => i));
  // 1) punti BT: i carichi più vicini, entro la distanza BT e fino alla potenza del punto
  supplies.forEach((s, si) => {
    if (s.level !== "BT") return;
    const near = [...free].map((i) => ({ i, L: R.route(s.pt, loads[i].pt).L })).filter((x) => x.L <= lvMax).sort((a, b) => a.L - b.L);
    const c: Cabin = { pt: s.pt, kW: 0, kVA: 0, loads: [], bt: si };
    for (const x of near) if (c.kW + loads[x.i].kW <= btMax) { c.loads.push(x.i); c.kW += loads[x.i].kW; free.delete(x.i); }
    if (c.loads.length) cabins.push(c);
  });
  const hasMt = supplies.some((s) => s.level !== "BT");
  // 2) cabine MT/BT: raggruppamento dei carichi rimasti (unione dei gruppi più vicini finché il gruppo resta
  //    entro la distanza BT dal suo baricentro e sotto la taglia massima del trasformatore)
  if (hasMt && free.size) {
    const { kx, ky } = frame(lat0);
    const dd = (a: number[], b: number[]) => Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * ky);
    type G = { m: number[]; c: number[]; kW: number };
    let gs: G[] = [...free].map((i) => ({ m: [i], c: loads[i].pt, kW: loads[i].kW }));
    const centroid = (m: number[]) => {
      const w = m.reduce((a, i) => a + Math.max(0.1, loads[i].kW), 0);
      return [m.reduce((a, i) => a + loads[i].pt[0] * Math.max(0.1, loads[i].kW), 0) / w, m.reduce((a, i) => a + loads[i].pt[1] * Math.max(0.1, loads[i].kW), 0) / w];
    };
    for (;;) {
      let best: { a: number; b: number; d: number; g: G } | null = null;
      for (let a = 0; a < gs.length; a++) for (let b = a + 1; b < gs.length; b++) {
        const dab = dd(gs[a].c, gs[b].c);
        if (dab > 2 * lvMax || (best && dab >= best.d)) continue;
        const kW = gs[a].kW + gs[b].kW; if (kvaFor(kW) > trafoMax) continue;
        const m = [...gs[a].m, ...gs[b].m], c = centroid(m);
        if (m.some((i) => dd(c, loads[i].pt) * 1.15 > lvMax)) continue;     // +15%: i cavi non vanno in linea retta
        best = { a, b, d: dab, g: { m, c, kW } };
      }
      if (!best) break;
      gs = gs.filter((_, k) => k !== best!.a && k !== best!.b); gs.push(best.g);
    }
    for (const g of gs) {
      cabins.push({ pt: g.c, kW: g.kW, kVA: kvaFor(g.kW), loads: g.m });
      g.m.forEach((i) => free.delete(i));
    }
  }
  // 3) bassa tensione: ogni carico dalla sua cabina
  const lv: LvRun[] = [];
  cabins.forEach((c, ci) => { for (const i of c.loads) { const r = R.route(c.pt, loads[i].pt); lv.push({ load: i, cabin: ci, coords: r.coords, L: r.L, kW: loads[i].kW, name: loads[i].name }); } });
  // 4) media tensione: albero di lunghezza minima dai punti AT/MT alle cabine (Prim con più radici)
  const roots = supplies.map((s, i) => ({ s, i })).filter((x) => x.s.level !== "BT");
  const mtCab = cabins.map((c, i) => ({ c, i })).filter((x) => x.c.bt == null);
  const mt: MtLine[] = [];
  if (roots.length && mtCab.length) {
    type N = { pt: number[]; cab?: number };
    const inTree: N[] = roots.map((r) => ({ pt: r.s.pt }));
    const parentOf = new Map<number, { to: number; coords: number[][]; L: number }>();   // cabina → nodo a monte (indice in inTree)
    const left = new Set(mtCab.map((x) => x.i));
    const cache = new Map<string, { coords: number[][]; L: number }>();
    const rt = (a: number[], b: number[]) => { const k = `${a}|${b}`; if (!cache.has(k)) cache.set(k, R.route(a, b)); return cache.get(k)!; };
    while (left.size) {
      let best: { ci: number; to: number; r: { coords: number[][]; L: number } } | null = null;
      for (const ci of left) for (let t = 0; t < inTree.length; t++) {
        const r = rt(inTree[t].pt, cabins[ci].pt);
        if (!best || r.L < best.r.L) best = { ci, to: t, r };
      }
      if (!best) break;
      parentOf.set(best.ci, { to: best.to, coords: best.r.coords, L: best.r.L });
      inTree.push({ pt: cabins[best.ci].pt, cab: best.ci });
      left.delete(best.ci);
    }
    // potenza a valle di ogni tratto: la cabina più tutte quelle appese a lei
    const nodeOfCab = new Map<number, number>(); inTree.forEach((n, k) => { if (n.cab != null) nodeOfCab.set(n.cab, k); });
    const down = new Map<number, number>();
    const order = [...parentOf.keys()].sort((a, b) => (nodeOfCab.get(b)! - nodeOfCab.get(a)!));
    for (const ci of order) down.set(ci, (down.get(ci) ?? 0) + cabins[ci].kVA);
    for (const ci of order) {
      const up = inTree[parentOf.get(ci)!.to].cab;
      if (up != null) down.set(up, (down.get(up) ?? 0) + (down.get(ci) ?? 0));
    }
    for (const [ci, p] of parentOf) {
      const kVA = down.get(ci) ?? cabins[ci].kVA;
      mt.push({ coords: p.coords, L: p.L, kVA, sec: kVA <= 2500 ? 95 : kVA <= 6000 ? 185 : 240 });
    }
  }
  return { cabins, mt, lv, atStations: supplies.filter((s) => s.level === "AT").length, unserved: [...free] };
}
