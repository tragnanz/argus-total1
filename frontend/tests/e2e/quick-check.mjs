// Prova del PROGETTO RAPIDO (barra a passi sulla mappa): aree → pivot → fonte → rete → computo.
// Area: Gorgol (Mauritania), fiumi cartografati. Serve un backend con dati reali (quote, tasselli topografici).
// Uso: ARGUS_URL=… ARGUS_API=… SHOTS=<cartella> node tests/e2e/quick-check.mjs
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
const RUN = String(Date.now() % 100000), CN = `Rapido ${RUN}`, PN = `Gorgol rapido ${RUN}`;
const c = await post("/clients", { name: CN }, tok);
const p = await post("/projects", { name: PN, client_id: c.id }, tok);
await post("/areas", { project_id: p.id, name: "Area 1", geojson: { type: "Polygon", coordinates: [AREA] }, area_ha: 4300 }, tok);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1700, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("dialog", (d) => d.accept());
const msgText = () => page.locator(".pill-dark").first().innerText().catch(() => "");
const stepInfo = (k) => page.locator(`[data-quick-step="${k}"]`).innerText().catch(() => "");
let clicks = 0;
const click = async (loc) => { clicks++; await loc.click(); };
try {
  await page.goto(URL); await page.evaluate((t) => localStorage.setItem("argus-total-token", t), tok);
  await page.goto(URL); await page.waitForTimeout(3500);
  await page.locator(`select:has(option:text-is("${CN}"))`).selectOption({ label: CN }); await page.waitForTimeout(1200);
  await page.locator(`select:has(option:text-is("${PN}"))`).selectOption({ label: PN }); await page.waitForTimeout(5000);
  const bar = page.locator("[data-quick-bar]");
  ok(await bar.isVisible(), "Barra del progetto rapido visibile");
  ok(/✓/.test(await stepInfo("aree")), `Passo 1 aree: ${(await stepInfo("aree")).replace(/\n/g, " ")}`);
  await page.screenshot({ path: path.join(SH, "q1_barra.png") });
  const t0 = Date.now();
  // 2 · pivot
  await click(page.locator('[data-quick-step="pivot"]'));
  await page.locator("text=/pivot su \\d+ aree/").first().waitFor({ timeout: 180000 });
  const m2 = await msgText();
  const tPiv = (Date.now() - t0) / 1000;
  ok(/✓/.test(await stepInfo("pivot")), `Passo 2 pivot in ${tPiv.toFixed(0)} s: ${m2.slice(0, 160)}`);
  await page.screenshot({ path: path.join(SH, "q2_pivot.png") });
  // gruppo pivot nascosto e pivot posati di nuovo: tornano visibili
  const nCirc = () => page.evaluate(() => [...document.querySelectorAll(".leaflet-overlay-pane path")].filter((p) => p.getAttribute("fill") && p.getAttribute("fill") !== "none" && p.getBoundingClientRect().width < 300).length);
  const h0 = await nCirc();
  await page.evaluate(() => { const b = [...document.querySelectorAll('button[title="Mostra/Nascondi"]')].find((x) => /^Pivot ·/.test((x.parentElement?.innerText || "").replace(/^[○◉]\s*/, "").trim())); b?.click(); });
  await page.waitForTimeout(500);
  const h1 = await nCirc();
  await page.locator('[data-quick-step="pivot"]').click();
  await page.locator("text=/pivot su \\d+ aree/").first().waitFor({ timeout: 180000 }); await page.waitForTimeout(800);
  const h2 = await nCirc();
  ok(h0 > 0 && h1 < h0 && h2 >= h0, `Pivot nascosti e posati di nuovo: ${h0} cerchi → ${h1} nascosti → ${h2} dopo la posa`);
  // canali esistenti: «spiana» (default) → m³ di terra; «lascia» → i pivot li evitano
  const cTxt = async () => (await page.locator("[data-quick-canals]").innerText()).replace(/\n/g, " ");
  const nPiv = async () => Number(((await stepInfo("pivot")).match(/(\d+) ·/) || [])[1] || 0);
  const vol1 = Number(((await cTxt()).match(/([\d.]+) m³/) || [])[1]?.replace(/\./g, "") || 0), np1 = await nPiv();
  const fillLine = await page.locator("[data-water-fill]").first().innerText().catch(() => "");
  ok(vol1 > 0, `Canali spianati: ${await cTxt()} · ${np1} pivot · ${fillLine.trim()}`);
  await page.locator('[data-quick-canal="lascia"]').click(); await page.waitForTimeout(500);
  await click(page.locator('[data-quick-step="pivot"]'));
  await page.locator("text=/pivot su \\d+ aree/").first().waitFor({ timeout: 180000 }); await page.waitForTimeout(800);
  const np2 = await nPiv(), c2 = await cTxt();
  ok(np2 < np1 && !/m³/.test(c2), `Canali lasciati: ${np2} pivot (contro ${np1}), niente terra da spostare (${c2})`);
  await page.screenshot({ path: path.join(SH, "q2b_lascia.png") });
  await page.locator('[data-quick-canal="spiana"]').click(); await page.waitForTimeout(500);
  await click(page.locator('[data-quick-step="pivot"]'));
  await page.locator("text=/pivot su \\d+ aree/").first().waitFor({ timeout: 180000 }); await page.waitForTimeout(800);
  ok((await nPiv()) === np1, `Di nuovo «spiana»: ${await nPiv()} pivot`);
  // regole sui fiumi (pagina Impianti): passa sopra → più pivot; fascia di rispetto 150 m → meno pivot
  const rePiv = async () => { await page.locator('[data-quick-step="pivot"]').click(); await page.locator("text=/pivot su \\d+ aree/").first().waitFor({ timeout: 180000 }); await page.waitForTimeout(800); return nPiv(); };
  await page.locator('button[title="Impianti"]').first().click(); await page.waitForTimeout(600);
  ok(await page.locator("[data-water-rules]").isVisible(), `Regole corsi d'acqua: ${(await page.locator("[data-water-rules]").innerText()).split("\n").slice(0, 8).join(" ")}`);
  await page.locator('[data-water-rule-btn="river-on"]').click(); await page.waitForTimeout(300);
  const npOver = await rePiv();
  await page.locator('[data-water-rule-btn="river-off"]').click();
  await page.locator('[data-water-rule-buf="river"]').fill("150"); await page.waitForTimeout(300);
  const npBuf = await rePiv();
  ok(npOver > np1 && npBuf < np1, `Fiumi: evitati ${np1} pivot · passa sopra ${npOver} · fascia 150 m ${npBuf}`);
  // con la fascia di 150 m: zone escluse tratteggiate in rosso, con la superficie per motivo
  const exBox = (await page.locator("[data-excluded-box]").innerText().catch(() => "")).replace(/\n/g, " ");
  const exN = await page.locator(".leaflet-argusExcluded-pane path").count();
  ok(/Corsi d'acqua da evitare/.test(exBox) && exN > 0, `Zone escluse: ${exBox} · ${exN} poligoni tratteggiati`);
  await page.screenshot({ path: path.join(SH, "q_escluse.png") });
  await page.locator('[data-water-rule-buf="river"]').fill("0"); await page.waitForTimeout(300);
  ok((await rePiv()) === np1, "Di nuovo fiumi evitati senza fascia");
  // 3 · fonte: clic su un fiume
  await click(page.locator('[data-quick-step="fonte"]'));
  await page.waitForTimeout(2500);
  const pt = await page.evaluate(() => {
    const circles = [...document.querySelectorAll(".leaflet-overlay-pane path")].filter((p) => p.getAttribute("fill") && p.getAttribute("fill") !== "none");
    const boxes = circles.map((c) => c.getBoundingClientRect()).filter((b) => b.width < 300);   // i cerchi dei pivot, non l'area
    const ps = [...document.querySelectorAll(".leaflet-overlay-pane path")].filter((p) => p.getAttribute("stroke") === "#1d4ed8" && p.getAttribute("stroke-opacity") !== "0");
    for (const p of ps) {
      const L = p.getTotalLength(); if (L < 80) continue;
      for (let f = 0.1; f < 0.95; f += 0.05) {
        const q = p.getPointAtLength(L * f), m = p.getScreenCTM();
        const x = m.a * q.x + m.c * q.y + m.e, y = m.b * q.x + m.d * q.y + m.f;
        if (x < 480 || x > 1180 || y < 180 || y > 880) continue;
        if (boxes.some((b) => x > b.left - 8 && x < b.right + 8 && y > b.top - 8 && y < b.bottom + 8)) continue;
        return { x, y };
      }
    }
    return null;
  });
  ok(!!pt, "Fiume visibile fuori dai pivot su cui cliccare");
  if (pt) { clicks++; await page.mouse.click(pt.x, pt.y); }
  await page.waitForTimeout(1500);
  const m3 = await msgText();
  ok(/Presa sul corso|Portata del fiume stimata/.test(m3) && /✓/.test(await stepInfo("fonte")), `Passo 3 fonte: ${m3.slice(0, 140)} · ${(await stepInfo("fonte")).replace(/\n/g, " ")}`);
  await page.waitForTimeout(4000);                         // quote della presa
  // 4 · rete
  const t4 = Date.now();
  await click(page.locator('[data-quick-step="rete"]'));
  await page.locator("text=/Rete pronta/").first().waitFor({ timeout: 180000 });
  const m4 = await msgText();
  const s4 = await stepInfo("rete");
  ok(/✓/.test(s4) && !/da collegare/.test(s4), `Passo 4 rete in ${((Date.now() - t4) / 1000).toFixed(0)} s: ${m4.slice(0, 200)} · ${s4.replace(/\n/g, " ")}`);
  await page.screenshot({ path: path.join(SH, "q4_rete.png") });
  // settori di pompaggio: stazioni nel loro posto, rete principale e distribuzione
  if (!(await page.locator("[data-sectors-note]").first().isVisible().catch(() => false))) { await page.locator('button[title="Fonte d\'acqua"]').first().click(); await page.waitForTimeout(1200); }
  const secNote = (await page.locator("[data-sectors-note]").first().innerText().catch(() => "")).replace(/\n/g, " ");
  const tree = (await page.locator("[data-main-tree]").first().innerText().catch(() => "")).replace(/\n/g, " ");
  ok(/settori/.test(secNote) && /principali/.test(tree), `Settori: ${secNote.slice(0, 120)} · ${tree}`);
  await page.locator("[data-sectors-note]").first().scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: path.join(SH, "q5_settori.png") });
  const schemes = await page.locator("text=/^[ABCD] · /").allInnerTexts().catch(() => []);
  console.log("  schemi:", schemes.join(" | "));
  for (const k of ["A", "B", "C", "D"]) console.log("  " + (await page.locator(`div.rounded-lg:has(> div > b:text-matches("^${k} · "))`).first().innerText().catch(() => "-")).replace(/\n/g, " ¦ ").slice(0, 600));
  // computo
  await click(page.locator('[data-quick-step="computo"]'));
  await page.waitForTimeout(1500);
  const exp = await page.locator("body").innerText();
  ok(/Esporta|Computo/.test(exp), "Computo: pagina Esporta aperta");
  console.log(`Tempo dal passo 2 alla rete pronta: ${((Date.now() - t0) / 1000).toFixed(0)} s, clic: ${clicks}`);
  ok(errors.length === 0, `Nessun errore JavaScript${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
} catch (e) { console.log("ERRORE", e, "\nJS:", errors.join(" || ")); fail++; await page.screenshot({ path: path.join(SH, "q_err.png") }).catch(() => {}); }
await browser.close();
console.log(fail ? `${fail} controlli falliti` : "Tutto ok");
process.exit(fail ? 1 : 0);
