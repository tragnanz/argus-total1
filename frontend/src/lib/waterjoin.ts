// Unione dei corsi d'acqua spezzati: tratti dello stesso tipo (fiume con fiume, canale con canale,
// fosso con fosso) le cui estremità si toccano diventano un unico corso. Dove si incontrano tre o più
// estremità (confluenza) si uniscono i due tratti più allineati; l'affluente resta un corso a sé.
// Le misure si ricompongono pesando per la lunghezza; nomi, regime e impostazioni vengono dal tratto
// più lungo (o dal primo che le ha).

type Pt = number[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { geojson: { type: string; coordinates: any }; kind: string; [k: string]: any };

const CAT: Record<string, string> = { river: "river", stream: "river", canal: "canal", ditch: "drain", drain: "drain", drainage: "drainage" };
const catOf = (k: string) => CAT[k] ?? k;

function meters(lat0: number) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  return (a: Pt, b: Pt) => Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * ky);
}

const REGIME_RANK: Record<string, number> = { perennial: 3, seasonal: 2, ephemeral: 1 };

function lineLen(cs: Pt[], dist: (a: Pt, b: Pt) => number) {
  let L = 0; for (let i = 1; i < cs.length; i++) L += dist(cs[i - 1], cs[i]); return L;
}

/** Unisce a e b (a finisce dove b comincia, già orientati). */
function joinTwo(a: W, b: W, ca: Pt[], cb: Pt[], dist: (p: Pt, q: Pt) => number): W {
  const coords = [...ca, ...(dist(ca[ca.length - 1], cb[0]) < 0.5 ? cb.slice(1) : cb)];
  const La = Number(a.length_m) || lineLen(ca, dist), Lb = Number(b.length_m) || lineLen(cb, dist);
  const L = La + Lb || 1;
  const [main, other] = La >= Lb ? [a, b] : [b, a];
  const out: W = { ...main, geojson: { type: "LineString", coordinates: coords } };
  out.length_m = Math.round((La + Lb) * 10) / 10;
  const wavg = (k: string) => {
    const x = a[k], y = b[k];
    if (typeof x === "number" && typeof y === "number") out[k] = Math.round(((x * La + y * Lb) / L) * 10) / 10;
    else if (typeof x === "number" || typeof y === "number") out[k] = typeof x === "number" ? x : y;
  };
  wavg("mean_width_m"); wavg("width_wet_m"); wavg("sinuosity"); wavg("sat_cover");
  for (const [k, f] of [["width_min_m", Math.min], ["width_max_m", Math.max]] as const) {
    const v = [a[k], b[k]].filter((x) => typeof x === "number") as number[];
    if (v.length) out[k] = f(...v);
  }
  if (typeof a.area_ha === "number" || typeof b.area_ha === "number") out.area_ha = Math.round(((a.area_ha || 0) + (b.area_ha || 0)) * 100) / 100;
  // profilo larghezze: (distanza, larghezza), il secondo tratto prosegue dopo il primo
  if (Array.isArray(a.profile) || Array.isArray(b.profile)) {
    const pa = (a.profile ?? []) as [number, number][], pb = (b.profile ?? []) as [number, number][];
    // il profilo di un tratto girato si ribalta
    out.profile = [...pa, ...pb.map(([d, w]) => [Math.round(d + La), w])];
  }
  for (const k of ["months_wet", "months_seen"]) {
    const v = [...new Set([...(a[k] ?? []), ...(b[k] ?? [])])].sort((x, y) => x - y);
    if (a[k] || b[k]) out[k] = v;
  }
  const ra = REGIME_RANK[a.regime as string] ?? 0, rb = REGIME_RANK[b.regime as string] ?? 0;
  if (ra || rb) out.regime = ra >= rb ? a.regime : b.regime;
  if (a.bed !== undefined || b.bed !== undefined) out.bed = !!a.bed && !!b.bed;
  if (a.below_pixel !== undefined || b.below_pixel !== undefined) out.below_pixel = !!a.below_pixel && !!b.below_pixel;
  if (!out.name && other.name) out.name = other.name;
  if (a.edited || b.edited) out.edited = true;
  if (a.pending || b.pending) out.pending = true;
  if (a.source !== b.source && a.source && b.source) {
    const s = new Set([a.source, b.source]);
    out.source = s.has("osm+s2") || (s.has("osm") && s.has("s2")) ? "osm+s2" : main.source;
  }
  if (a.hidden !== b.hidden) out.hidden = false;
  return out;
}

/**
 * Restituisce l'elenco con i tratti uniti. `tol` = distanza massima (m) fra due estremità perché si
 * considerino toccanti. I poligoni (bacini, zone umide) restano come sono.
 */
export function joinTouchingWater<T extends W>(list: T[], tol = 25): { list: T[]; joined: number } {
  const lines = list.filter((w) => w.geojson?.type === "LineString" && (w.geojson.coordinates?.length ?? 0) >= 2);
  if (lines.length < 2) return { list, joined: 0 };
  const lat0 = lines[0].geojson.coordinates[0][1] as number;
  const dist = meters(lat0);
  let cur: W[] = list.slice();
  let joined = 0;
  for (let guard = 0; guard < 5000; guard++) {
    // estremità di tutte le linee: (indice, 0 = inizio | 1 = fine)
    const ends: { i: number; e: 0 | 1; p: Pt; dir: Pt; cat: string }[] = [];
    cur.forEach((w, i) => {
      if (w.geojson?.type !== "LineString") return;
      const cs = w.geojson.coordinates as Pt[]; if (cs.length < 2) return;
      const cat = catOf(w.kind);
      // direzione uscente dall'estremità (verso l'interno della linea), su ~5 vertici
      const head = cs[Math.min(cs.length - 1, 5)], tail = cs[Math.max(0, cs.length - 6)];
      ends.push({ i, e: 0, p: cs[0], dir: [head[0] - cs[0][0], head[1] - cs[0][1]], cat });
      ends.push({ i, e: 1, p: cs[cs.length - 1], dir: [tail[0] - cs[cs.length - 1][0], tail[1] - cs[cs.length - 1][1]], cat });
    });
    // miglior coppia di estremità toccanti dello stesso tipo: le più allineate (direzioni opposte)
    let best: { a: (typeof ends)[number]; b: (typeof ends)[number]; score: number } | null = null;
    for (let x = 0; x < ends.length; x++) for (let y = x + 1; y < ends.length; y++) {
      const A = ends[x], B = ends[y];
      if (A.i === B.i || A.cat !== B.cat) continue;
      const d = dist(A.p, B.p); if (d > tol) continue;
      const na = Math.hypot(A.dir[0], A.dir[1]) || 1, nb = Math.hypot(B.dir[0], B.dir[1]) || 1;
      const cos = (A.dir[0] * B.dir[0] + A.dir[1] * B.dir[1]) / (na * nb);   // -1 = perfettamente in fila
      const score = cos + d / tol * 0.2;
      if (!best || score < best.score) best = { a: A, b: B, score };
    }
    if (!best) break;
    const { a, b } = best;
    const wa = cur[a.i], wb = cur[b.i];
    let ca = (wa.geojson.coordinates as Pt[]).slice(), cb = (wb.geojson.coordinates as Pt[]).slice();
    let pa = wa.profile as [number, number][] | undefined, pb = wb.profile as [number, number][] | undefined;
    const La = Number(wa.length_m) || lineLen(ca, dist), Lb = Number(wb.length_m) || lineLen(cb, dist);
    const flip = (p: [number, number][] | undefined, L: number) => p ? p.map(([d, w]) => [Math.round(L - d), w] as [number, number]).reverse() : p;
    // orienta: a deve finire nel punto d'incontro, b deve cominciarci
    if (a.e === 0) { ca = ca.reverse(); pa = flip(pa, La); }
    if (b.e === 1) { cb = cb.reverse(); pb = flip(pb, Lb); }
    const merged = joinTwo({ ...wa, profile: pa }, { ...wb, profile: pb }, ca, cb, dist);
    if (pa === undefined && pb === undefined) delete merged.profile;
    const keep = Math.min(a.i, b.i), drop = Math.max(a.i, b.i);
    cur = cur.map((w, k) => (k === keep ? merged : w)).filter((_, k) => k !== drop);
    joined++;
  }
  return { list: cur as T[], joined };
}
