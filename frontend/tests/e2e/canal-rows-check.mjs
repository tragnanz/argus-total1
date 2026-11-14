// Prova: alimentazione a canali con N pivot per lato → corridoi liberi per i canali; pivot già disegnati
// in tubo → avviso, e «Inserisci» li riposa fuori dai canali. Uso: ARGUS_URL=… ARGUS_API=… node tests/e2e/canal-rows-check.mjs
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
const EMAIL = process.env.ARGUS_EMAIL || "canal@argus.test", PASS = process.env.ARGUS_PASSWORD || "Password123!";
const tok = (await post("/auth/login", { email: EMAIL, password: PASS }).catch(() => post("/auth/register", { email: EMAIL, password: PASS, organization_name: "C" }))).access_token;
const RUN = String(Date.now() % 100000), CN = `Canali ${RUN}`, PN = `Canali p ${RUN}`;
const c = await post("/clients", { name: CN }, tok), p = await post("/projects", { name: PN, client_id: c.id }, tok);
await post("/areas", { project_id: p.id, name: "Piana", geojson: { type: "Polygon", coordinates: [[[-12.80, 16.13], [-12.74, 16.13], [-12.74, 16.17], [-12.80, 16.17], [-12.80, 16.13]]] }, area_ha: 2840 }, tok);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1700, height: 1000 } })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("dialog", (d) => d.accept());
try {
  await page.goto(URL); await page.evaluate((t) => localStorage.setItem("argus-total-token", t), tok);
  await page.goto(URL); await page.waitForTimeout(3500);
  await page.locator(`select:has(option:text-is("${CN}"))`).selectOption({ label: CN }); await page.waitForTimeout(1200);
  await page.locator(`select:has(option:text-is("${PN}"))`).selectOption({ label: PN }); await page.waitForTimeout(4000);
  await page.locator('button[title="Impianti"]').first().click(); await page.waitForTimeout(800);
  await page.locator('text=/^Piana$/').first().click().catch(() => {});
  const ins = page.locator('button:has-text("Inserisci su «Piana»")').first();
  await ins.click(); await page.locator("text=/Impianti inseriti|pivot su/").first().waitFor({ timeout: 300000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const n0 = await page.locator(".leaflet-overlay-pane path").count();
  // passa ai canali: avviso sui pivot già disegnati
  await page.locator('select:has(option[value="canal"])').first().selectOption("canal"); await page.waitForTimeout(600);
  ok(await page.locator("[data-canal-rows]").isVisible(), "Scelta dei pivot per lato con i canali");
  await page.locator('[data-canal-rows] .seg-item:has-text("3 per lato")').click(); await page.waitForTimeout(300);
  const warn = (await page.locator("[data-canal-warning]").innerText().catch(() => "")).replace(/\n/g, " ");
  ok(/corridoi dei canali/.test(warn), `Avviso: ${warn.slice(0, 140)}`);
  await page.screenshot({ path: path.join(SH, "c1_avviso.png") });
  await ins.click(); await page.waitForTimeout(1000);
  await page.locator("[data-canal-warning]").waitFor({ state: "detached", timeout: 300000 }).catch(() => {});
  ok(!(await page.locator("[data-canal-warning]").count()), "Dopo «Inserisci» l'avviso sparisce (pivot riposati fuori dai canali)");
  await page.waitForTimeout(1500);
  const tab = (await page.locator("[data-canal-table]").innerText().catch(() => "")).replace(/\n/g, " ");
  ok(/dimensionamento/.test(tab) && /DN \d+/.test(tab), `Canali dimensionati: ${tab.slice(0, 260)}`);
  await page.screenshot({ path: path.join(SH, "c2_corridoi.png") });
  // clic sul canale: scheda con dimensioni modificabili, profilo con i salti e tavola PDF
  const hitBox = await page.evaluate(() => { const el = [...document.querySelectorAll("path.leaflet-interactive")].find((p) => p.getAttribute("stroke-width") === "16");
    if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width * 0.3, y: b.y + b.height / 2 }; });
  ok(!!hitBox, "Canale cliccabile sulla mappa");
  if (hitBox) {
    await page.mouse.click(hitBox.x, hitBox.y); await page.waitForTimeout(800);
    ok(await page.locator("[data-comp-card]").isVisible(), "Scheda del canale aperta");
    await page.locator("[data-comp-info]").filter({ hasText: /salt/ }).waitFor({ timeout: 120000 }).catch(() => {});
    const info0 = (await page.locator("[data-comp-info]").innerText()).replace(/\n/g, " ");
    await page.locator('[data-comp-in="b"]').fill("2"); await page.waitForTimeout(800);
    const info1 = (await page.locator("[data-comp-info]").innerText()).replace(/\n/g, " ");
    ok(info0 !== info1 && /tirante/.test(info1), `Base a mano 2 m: ${info0.slice(0, 120)} → ${info1.slice(0, 120)}`);
    await page.locator("[data-comp-info]").filter({ hasText: /salt/ }).waitFor({ timeout: 120000 }).catch(() => {});
    console.log("  profilo:", (await page.locator("[data-comp-info]").innerText()).replace(/\n/g, " ").slice(0, 200));
    await page.screenshot({ path: path.join(SH, "c4_scheda.png") });
    const pair = page.locator("[data-comp-pdf-pair]");
    const btn = (await pair.count()) ? pair : page.locator("[data-comp-pdf]");
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 180000 }), btn.click()]);
    const fp = path.join(SH, "tavola_canale.pdf"); await dl.saveAs(fp);
    const fs = await import("node:fs"); const sz = fs.statSync(fp).size;
    ok(sz > 20000, `Tavola PDF scaricata (${Math.round(sz / 1024)} kB, ${(await pair.count()) ? "canale + strada" : "canale"})`);
    await page.keyboard.press("Escape");
  }
  // strade: a fianco dei canali e raccordi ortogonali fino ai centri dei pivot
  await page.locator('button[title="Strade"]').first().click(); await page.waitForTimeout(800);
  const nR = Number(((await page.locator("text=/^Strade · \\d+/").first().innerText().catch(() => "")).match(/(\d+)/) || [])[1] || 0);
  await page.locator('button:has-text("Genera strade di servizio")').click(); await page.waitForTimeout(800);
  const rmsg = await page.locator("text=/Strade lungo \\d+ canali/").first().innerText().catch(() => "");
  ok(nR > 10 && /raccordi ortogonali/.test(rmsg), `Strade dopo la posa: ${nR} · ${rmsg}`);
  await page.screenshot({ path: path.join(SH, "c3_strade.png") });
  console.log("  tracciati sulla mappa prima/dopo:", n0, await page.locator(".leaflet-overlay-pane path").count());
  ok(errors.length === 0, `Nessun errore JavaScript${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
} catch (e) { console.log("ERRORE", e, "\nJS:", errors.join(" || ")); fail++; await page.screenshot({ path: path.join(SH, "c_err.png") }).catch(() => {}); }
await browser.close();
console.log(fail ? `${fail} controlli falliti` : "Tutto ok");
process.exit(fail ? 1 : 0);
