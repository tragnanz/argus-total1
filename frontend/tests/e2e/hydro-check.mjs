// Verifica idraulica di stazioni accorpate e tee: continuità delle portate, DN non crescenti verso valle,
// pivot serviti una volta sola, effetto della soglia di accorpamento e tee disegnato a mano.
// Uso: ARGUS_URL=… ARGUS_API=… SHOTS=<cartella> node tests/e2e/hydro-check.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
import path from "node:path";
const URL = process.env.ARGUS_URL || "http://localhost:3124";
const API = (process.env.ARGUS_API || "http://localhost:8011") + "/api";
const SH = process.env.SHOTS || "/tmp";
let fail = 0; const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fail++; };
async function post(p, body, tok) {
  const r = await fetch(API + p, { method: "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`); return r.json();
}
const EMAIL = process.env.ARGUS_EMAIL || "quick-check@argus.test", PASS = process.env.ARGUS_PASSWORD || "Password123!";
const tok = (await post("/auth/login", { email: EMAIL, password: PASS }).catch(() => post("/auth/register", { email: EMAIL, password: PASS, organization_name: "Quick" }))).access_token;
const AREA = [[-12.80, 16.10], [-12.74, 16.10], [-12.74, 16.16], [-12.80, 16.16], [-12.80, 16.10]];
const RUN = String(Date.now() % 100000), CN = `Idro ${RUN}`, PN = `Gorgol idro ${RUN}`;
const c = await post("/clients", { name: CN }, tok);
const p = await post("/projects", { name: PN, client_id: c.id }, tok);
await post("/areas", { project_id: p.id, name: "Area 1", geojson: { type: "Polygon", coordinates: [AREA] }, area_ha: 4300 }, tok);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1700, height: 950 } });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("dialog", (d) => d.accept());
const H = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__argusHydro)));
const K = (q) => `${q[0].toFixed(6)},${q[1].toFixed(6)}`;
const DN_LIST = [110, 125, 140, 160, 180, 200, 225, 250, 280, 315, 355, 400, 450, 500, 560, 630, 710, 800, 900, 1000];
// controllo indipendente dal codice dell'app: grafo dai vertici, albero dalla presa, portate sommate verso monte
function audit(h) {
  const pipes = h.lines.filter((l) => l.kind === "pipe" && l.coords.length >= 2);
  const adj = new Map(); const dnFix = new Map();
  for (const l of pipes) for (let i = 0; i + 1 < l.coords.length; i++) {
    const a = K(l.coords[i]), b = K(l.coords[i + 1]);
    (adj.get(a) ?? adj.set(a, []).get(a)).push(b); (adj.get(b) ?? adj.set(b, []).get(b)).push(a);
    if (l.dnFix) dnFix.set(a < b ? `${a}|${b}` : `${b}|${a}`, l.dnFix);
  }
  const pivAt = new Map(h.pivots.map((q, i) => [K(q), i]));
  const tapKeys = new Set(h.taps.map((s) => K(s.pt)));
  const r = { flowErr: 0, qErr: 0, dnUp: 0, dnUpList: [], double: [], served: new Set(), joints: 0, edges: 0 };
  const seen2 = new Map();
  for (const st of h.taps) {
    const k = K(st.pt), par = new Map(), order = [k], seen = new Set([k]);
    for (let i = 0; i < order.length; i++) for (const n of adj.get(order[i]) ?? []) { if (seen.has(n) || tapKeys.has(n)) continue; seen.add(n); par.set(n, order[i]); order.push(n); }
    const flow = new Map(order.map((n) => [n, pivAt.has(n) ? h.flows[pivAt.get(n)] : 0]));
    for (let i = order.length - 1; i > 0; i--) flow.set(par.get(order[i]), flow.get(par.get(order[i])) + flow.get(order[i]));
    const piv = order.filter((n) => pivAt.has(n)).map((n) => pivAt.get(n));
    const sumQ = piv.reduce((a, i) => a + h.flows[i], 0);
    if (Math.abs(sumQ - st.qLs) > 0.5) r.qErr++;
    for (const i of piv) { seen2.set(i, (seen2.get(i) ?? 0) + 1); r.served.add(i); }
    const seg = new Map(st.segs);
    const kids = new Map();
    for (let i = 1; i < order.length; i++) { const n = order[i], pr = par.get(n); (kids.get(pr) ?? kids.set(pr, []).get(pr)).push(n); }
    for (const [n, ch] of kids) if (n !== k && !pivAt.has(n) && ch.length >= 2) r.joints++;
    for (let i = 1; i < order.length; i++) {
      const n = order[i], pr = par.get(n), ek = pr < n ? `${pr}|${n}` : `${n}|${pr}`, s = seg.get(ek); r.edges++;
      if (!s || Math.abs(s.q - Math.round(flow.get(n) * 10) / 10) > 0.2) r.flowErr++;
      // il DN di un tratto non deve essere minore di quello dei tratti subito a valle (se automatici)
      if (s && !dnFix.has(ek)) for (const c2 of kids.get(n) ?? []) {
        const e2 = n < c2 ? `${n}|${c2}` : `${c2}|${n}`, s2 = seg.get(e2);
        if (s2 && !dnFix.has(e2) && s2.dn > s.dn) { r.dnUp++; if (r.dnUpList.length < 5) r.dnUpList.push(`DN ${s.dn} (${s.q} l/s) → ${s2.dn} (${s2.q} l/s)`); }
      }
    }
  }
  // tubi che partono dalle stazioni: il primo tratto non deve attraversare fiumi o canali, e tutti i pivot
  // di una stazione devono stare sulla stessa sponda (rispetto al corso nel punto della presa)
  const lat0 = h.pivots[0]?.[1] ?? 0, kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const T = (q) => [q[0] * kx, q[1] * ky];
  const wsegs = []; for (const l of h.water ?? []) for (let i = 0; i + 1 < l.length; i++) wsegs.push([T(l[i]), T(l[i + 1])]);
  const cr = (p1, p2, p3, p4) => { const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4); return d1 * d2 < 0 && d3 * d4 < 0; };
  const dseg = (p, a, b) => { const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy || 1e-9; let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - a[0] - vx * t, p[1] - a[1] - vy * t); };
  r.crossFirst = 0; r.mixedSide = 0; r.crossList = [];
  for (const st of h.taps) {
    const s0 = T(st.pt); let near = null, nd = Infinity;
    for (const g of wsegs) { const d = dseg(s0, g[0], g[1]); if (d < nd) { nd = d; near = g; } }
    const sides = new Set();
    for (const l of pipes) {
      const c = K(l.coords[0]) === K(st.pt) ? l.coords : K(l.coords[l.coords.length - 1]) === K(st.pt) ? [...l.coords].reverse() : null; if (!c) continue;
      const a = T(c[0]), b = T(c[1]), len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, a3 = [a[0] + (b[0] - a[0]) / len * 3, a[1] + (b[1] - a[1]) / len * 3];
      if (wsegs.some((g) => cr(a3, b, g[0], g[1]))) { r.crossFirst++; if (r.crossList.length < 4) r.crossList.push(`S@${st.pt.map((x) => x.toFixed(4)).join(",")}`); }
      if (near) sides.add(Math.sign((near[1][0] - near[0][0]) * (b[1] - a[1]) - (near[1][1] - near[0][1]) * (b[0] - a[0])));
    }
    if (sides.size > 1) r.mixedSide++;
  }
  r.double = [...seen2].filter(([, n]) => n > 1).map(([i]) => i);
  return r;
}
const pipeKm = (h) => h.lines.filter((l) => l.kind === "pipe").reduce((a, l) => { let s = 0; for (let i = 0; i + 1 < l.coords.length; i++) { const [x1, y1] = l.coords[i], [x2, y2] = l.coords[i + 1]; s += Math.hypot((x2 - x1) * 111320 * Math.cos(y1 * Math.PI / 180), (y2 - y1) * 110540); } return a + s; }, 0) / 1000;
try {
  await page.goto(URL); await page.evaluate((t) => localStorage.setItem("argus-total-token", t), tok);
  await page.goto(URL); await page.waitForTimeout(3500);
  await page.locator(`select:has(option:text-is("${CN}"))`).selectOption({ label: CN }); await page.waitForTimeout(1200);
  await page.locator(`select:has(option:text-is("${PN}"))`).selectOption({ label: PN }); await page.waitForTimeout(3000);
  await page.locator('[data-quick-step="pivot"]').click();
  await page.locator("text=/pivot su \\d+ aree/").first().waitFor({ timeout: 180000 }); await page.waitForTimeout(800);
  await page.locator('[data-quick-step="fonte"]').click(); await page.waitForTimeout(2500);
  const pt = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll(".leaflet-overlay-pane path")].filter((p) => p.getAttribute("fill") && p.getAttribute("fill") !== "none").map((c) => c.getBoundingClientRect()).filter((b) => b.width < 300);
    for (const p of [...document.querySelectorAll(".leaflet-overlay-pane path")].filter((p) => p.getAttribute("stroke") === "#1d4ed8" && p.getAttribute("stroke-opacity") !== "0")) {
      const L = p.getTotalLength(); if (L < 80) continue;
      for (let f = 0.1; f < 0.95; f += 0.05) {
        const q = p.getPointAtLength(L * f), m = p.getScreenCTM(); const x = m.a * q.x + m.c * q.y + m.e, y = m.b * q.x + m.d * q.y + m.f;
        if (x < 480 || x > 1180 || y < 180 || y > 880) continue;
        if (boxes.some((b) => x > b.left - 8 && x < b.right + 8 && y > b.top - 8 && y < b.bottom + 8)) continue;
        return { x, y };
      }
    }
    return null;
  });
  if (pt) await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(5500);
  await page.locator('[data-quick-step="rete"]').click();
  await page.locator("text=/Rete pronta/").first().waitFor({ timeout: 180000 }); await page.waitForTimeout(3000);
  // tutti i fiumi come un'unica fonte, solo tubazioni: ogni ramo ha la sua presa sul fiume
  if (!(await page.locator("[data-water-kinds]").first().isVisible().catch(() => false))) { await page.locator('button[title="Fonte d\'acqua"]').first().click(); await page.waitForTimeout(800); }
  await page.locator("[data-water-kinds] button", { hasText: /Fiume/ }).first().click(); await page.waitForTimeout(400);
  await page.locator("[data-water-family-source]").click(); await page.waitForTimeout(600);
  await page.locator('[data-dist-mode="pipes"]').click(); await page.waitForTimeout(300);
  await page.locator("[data-dist-go]").click(); await page.waitForTimeout(6000);
  if (!(await page.locator("[data-dist-merge]").first().isVisible().catch(() => false))) { await page.locator('button[title="Pompaggio"]').first().click(); await page.waitForTimeout(800); }
  const mergeL = () => page.locator("[data-dist-merge]:visible").first(); const merge = mergeL();
  // 4 · soglia di accorpamento: stazioni, km di tubo, kW totali
  const sweep = []; let s0x = null;
  for (const m of (process.env.SWEEP || "0,250,500,750,1000,1500,2000").split(",").map(Number)) {
    await merge.fill(String(m)); await merge.blur(); await page.waitForTimeout(4500);
    const h = await H(); const a = audit(h);
    const kW = h.taps.reduce((s, x) => s + x.kW, 0), q = h.taps.reduce((s, x) => s + x.qLs, 0);
    sweep.push({ m, st: h.taps.length, km: pipeKm(h), kW, q, a });
    console.log(`  soglia ${m} m: ${h.taps.length} stazioni · ${pipeKm(h).toFixed(1)} km di tubo · ${Math.round(kW)} kW · ${Math.round(q)} l/s · pivot serviti ${a.served.size}/${h.pivots.length} · giunti ${a.joints}`);
    // 1-2 · coerenza idraulica a ogni soglia
    ok(a.qErr === 0 && a.flowErr === 0, `Soglia ${m} m: portate coerenti (stazione = somma pivot; ${a.edges} tratti, ${a.flowErr} incoerenti)`);
    ok(a.double.length === 0, `Soglia ${m} m: nessun pivot servito da due stazioni${a.double.length ? " — doppi: " + a.double.map((i) => "P" + (i + 1)).join(", ") : ""}`);
    console.log(`  soglia ${m} m: primi tratti dalle stazioni che attraversano fiumi/canali ${a.crossFirst}${a.crossList.length ? " (" + a.crossList.join(" ") + ")" : ""} · stazioni con pivot su due sponde ${a.mixedSide}`);
    if (m > 0 && s0x) ok(a.crossFirst <= s0x.crossFirst && a.mixedSide <= s0x.mixedSide, `Soglia ${m} m: l'accorpamento non aggiunge attraversamenti (${s0x.crossFirst} → ${a.crossFirst}) né stazioni a cavallo del corso (${s0x.mixedSide} → ${a.mixedSide})`);
    else s0x = a;
    ok(a.dnUp === 0, `Soglia ${m} m: DN mai crescente verso valle${a.dnUp ? ` — ${a.dnUp} casi: ${a.dnUpList.join("; ")}` : ""}`);
  }
  const s0 = sweep[0];
  ok(sweep.every((s) => Math.abs(s.q - s0.q) < 1), `Portata totale invariata con l'accorpamento: ${sweep.map((s) => Math.round(s.q)).join(" / ")} l/s`);
  // 3 · tee disegnato a mano (soglia 500)
  await merge.fill("500"); await merge.blur(); await page.waitForTimeout(4500);
  let h = await H();
  // pivot servito da una tubazione sua (presa → pivot) e un tratto lungo di un'altra tubazione vicina
  const px = (q) => page.evaluate((q) => { const p = window.__argusMap.latLngToContainerPoint([q[1], q[0]]); return { x: p.x, y: p.y }; }, q);
  const M = (a, b) => Math.hypot((a[0] - b[0]) * 106000, (a[1] - b[1]) * 110540);
  let best = null;
  h.lines.forEach((F, fi) => {
    if (F.kind !== "pipe" || F.coords.length < 2) return;
    const e = F.coords[F.coords.length - 1]; const pi = h.pivots.findIndex((q) => K(q) === K(e)); if (pi < 0) return;
    if (h.lines.some((l, k) => k !== fi && l.kind === "pipe" && l.coords.some((q) => K(q) === K(e)))) return;   // pivot di passaggio
    h.lines.forEach((L, li) => {
      if (li === fi || L.kind !== "pipe") return;
      for (let i = 0; i + 1 < L.coords.length; i++) {
        const A = L.coords[i], B = L.coords[i + 1], mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], seg = M(A, B), d = M(mid, e);
        if (seg < 300 || d < 150 || d > 1500) continue;
        if (!best || d < best.d) best = { fi, li, i, mid, pivot: e, pi, d };
      }
    });
  });
  ok(!!best, best ? `Caso di tee: P${best.pi + 1}, tubazione ${best.li + 1} a ${Math.round(best.d)} m` : "Nessun caso di tee trovato");
  if (best) {
    const st0 = h.taps.length, tapOfPiv = h.taps.findIndex((s) => s.piv.includes(best.pi));
    const endsL = [h.lines[best.li].coords[0], h.lines[best.li].coords.at(-1)].map(K);
    const pivL = h.pivots.findIndex((q) => endsL.includes(K(q)));
    const stL = h.taps.find((s) => s.piv.includes(pivL));
    const q0L = stL?.qLs ?? 0;
    await page.evaluate((m) => window.__argusMap.setView([m[1], m[0]], 15), [(best.pivot[0] + best.mid[0]) / 2, (best.pivot[1] + best.mid[1]) / 2]);
    await page.waitForTimeout(1200);
    if (!(await page.locator('button:text-is("Disegna tubazione")').first().isVisible().catch(() => false))) { await page.locator('button[title="Tubazioni"]').first().click(); await page.waitForTimeout(800); }
    await page.locator('button:text-is("Disegna tubazione")').first().click();
    await page.waitForTimeout(600);
    const a = await px(best.pivot), b = await px(best.mid); console.log('  T draw', a, b, Date.now() % 100000);
    await page.mouse.click(a.x, a.y); await page.waitForTimeout(300);
    await page.mouse.click(b.x + 2, b.y + 2); await page.waitForTimeout(300);
    await page.mouse.dblclick(b.x + 2, b.y + 2); await page.waitForTimeout(2500);
    console.log('  T dbl', Date.now() % 100000); await page.keyboard.press("Escape"); await page.waitForTimeout(800);
    h = await H(); console.log('  T H', Date.now() % 100000);
    const L2 = h.lines[best.li], NEW = h.lines[h.lines.length - 1];
    const teeK = K(NEW.coords[NEW.coords.length - 1]);
    const inserted = L2.coords.some((q) => K(q) === teeK) && NEW.coords.some((q) => K(q) === K(best.pivot));
    ok(inserted, `Tee: il punto d'arrivo è diventato un vertice della tubazione ${best.li + 1} (${L2.coords.length} vertici)`);
    // si toglie la vecchia tubazione dedicata del pivot: ora è servito solo dal tee
    const F = h.lines[best.fi]; const fm = F.coords[Math.floor(F.coords.length / 2) - (F.coords.length % 2 ? 0 : 1)], fn = F.coords[Math.floor(F.coords.length / 2) + (F.coords.length % 2 ? 0 : 0)];
    const midF = F.coords.length === 2 ? [(F.coords[0][0] + F.coords[1][0]) / 2, (F.coords[0][1] + F.coords[1][1]) / 2] : [(fm[0] + fn[0]) / 2, (fm[1] + fn[1]) / 2];
    const nBefore = h.lines.filter((l) => l.kind === "pipe").length;
    const c2 = await px(midF); await page.mouse.click(c2.x, c2.y); await page.waitForTimeout(800);
    await page.keyboard.press("Delete"); await page.waitForTimeout(3000);
    h = await H();
    const nAfter = h.lines.filter((l) => l.kind === "pipe").length;
    ok(nAfter === nBefore - 1, `Vecchia tubazione del pivot eliminata: ${nBefore} → ${nAfter}`);
    const a2 = audit(h);
    const stN = h.taps.find((s) => s.piv.includes(best.pi));
    ok(!!stN && a2.double.length === 0, `P${best.pi + 1} ora servito da una stazione sola (${stN ? stN.piv.length + " pivot, " + Math.round(stN.qLs) + " l/s" : "nessuna"})`);
    ok(a2.qErr === 0 && a2.flowErr === 0, `Dopo il tee: portate coerenti (${a2.edges} tratti, ${a2.flowErr} incoerenti)`);
    ok(a2.dnUp === 0, `Dopo il tee: DN mai crescente verso valle${a2.dnUp ? " — " + a2.dnUpList.join("; ") : ""}`);
    // tratto a monte del tee: portata cresciuta della portata del pivot
    const ekOf = (A, B) => { const x = K(A), y = K(B); return x < y ? `${x}|${y}` : `${y}|${x}`; };
    const up = stN?.segs.find(([k]) => k === ekOf(L2.coords[best.i], [Number(teeK.split(",")[0]), Number(teeK.split(",")[1])]) ) ?? stN?.segs.find(([k]) => k.includes(teeK));
    ok(!!stN && stN.qLs > q0L - 0.5, `Stazione del tee: ${Math.round(q0L)} → ${Math.round(stN?.qLs ?? 0)} l/s (+${Math.round(h.flows[best.pi])} l/s del pivot) · stazioni ${st0} → ${h.taps.length}`);
    const card = (stN?.branches ?? []).filter((b2) => /giunto/.test(b2.a) || /giunto/.test(b2.b)).map((b2) => `${b2.a}→${b2.b} ${Math.round(b2.q)} l/s DN ${b2.dn}`).slice(0, 4);
    console.log("  rami dal tee:", card.join(" · "), up ? `· tratto a monte ${up[1].q} l/s DN ${up[1].dn}` : "");
    await page.screenshot({ path: path.join(SH, "h_tee.png") });
  }
} catch (e) { ok(false, "ERRORE " + e.message.slice(0, 300)); await page.screenshot({ path: path.join(SH, "h_err.png") }).catch(() => {}); }
ok(!errors.length, `Nessun errore JS${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
await browser.close();
console.log(fail ? `${fail} controlli falliti` : "Tutto ok");
process.exit(fail ? 1 : 0);
