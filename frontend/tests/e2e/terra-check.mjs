// Prova del TERRAFORMING: termitai da Sentinel-2 (Mkushi, Zambia), carreggiate dal DEM, totali e computo.
// Serve un backend con dati reali. Uso: ARGUS_URL=… ARGUS_API=… SHOTS=<cartella> node tests/e2e/terra-check.mjs
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
const EMAIL = process.env.ARGUS_EMAIL || "terra-check@argus.test", PASS = process.env.ARGUS_PASSWORD || "Password123!";
const tok = (await post("/auth/login", { email: EMAIL, password: PASS }).catch(() => post("/auth/register", { email: EMAIL, password: PASS, organization_name: "Terra" }))).access_token;
const AREA = [[29.38, -13.62], [29.42, -13.62], [29.42, -13.58], [29.38, -13.58], [29.38, -13.62]];
const RUN = String(Date.now() % 100000), CN = `Terra ${RUN}`, PN = `Mkushi ${RUN}`;
const c = await post("/clients", { name: CN }, tok);
const p = await post("/projects", { name: PN, client_id: c.id }, tok);
await post("/areas", { project_id: p.id, name: "Mkushi", geojson: { type: "Polygon", coordinates: [AREA] }, area_ha: 1900 }, tok);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1700, height: 950 } });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error" && !/401/.test(m.text())) errors.push("console: " + m.text().slice(0, 500)); }); page.on("dialog", (d) => d.accept());
const txt = (sel) => page.locator(sel).first().innerText().catch(() => "");
try {
  await page.goto(URL); await page.evaluate((t) => localStorage.setItem("argus-total-token", t), tok);
  await page.goto(URL); await page.waitForTimeout(3500);
  await page.locator(`select:has(option:text-is("${CN}"))`).selectOption({ label: CN }); await page.waitForTimeout(1200);
  await page.locator(`select:has(option:text-is("${PN}"))`).selectOption({ label: PN }); await page.waitForTimeout(5000);
  await page.locator('[data-quick-step="pivot"]').click();
  await page.locator("text=/pivot su \\d+ aree/").first().waitFor({ timeout: 180000 });
  await page.locator('button[title="Terraforming"]').first().click(); await page.waitForTimeout(800);
  ok(await page.locator("[data-terra-section]").isVisible(), "Pagina Terraforming aperta");
  const t0 = Date.now();
  await page.locator("[data-terra-detect]").click();
  await page.locator("text=/Termitai rilevati: [\\d.]+/").first().waitFor({ timeout: 600000 });
  const sum = await txt("[data-terra-mound-sum]");
  const nAll = Number((sum.match(/^([\d.]+) termitai/) || [])[1]?.replace(/\./g, "") || 0);
  const nIn = Number((sum.match(/([\d.]+) sotto i pivot/) || [])[1]?.replace(/\./g, "") || 0);
  ok(nAll > 100 && nIn > 0 && /m³ di cumuli/.test(sum), `Termitai in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${sum.split("\n").slice(0, 2).join(" ")}`);
  await page.screenshot({ path: path.join(SH, "t1_termitai.png") });
  // a mano: aggiungi e togli
  await page.locator("[data-terra-add]").click(); await page.waitForTimeout(300);
  await page.mouse.click(900, 500); await page.waitForTimeout(500);
  await page.locator("[data-terra-add]").click(); await page.waitForTimeout(300);
  const sum2 = await txt("[data-terra-mound-sum]");
  ok(/\(1 a mano\)/.test(sum2), `Termitaio aggiunto a mano: ${sum2.split("\n")[0]}`);
  // percentuale di superficie: totale, per pivot e per campo; la fascia di bonifica la fa crescere
  const pct = async () => Number(((await txt("[data-terra-pct]")).match(/([\d,]+)% della superficie/) || [])[1]?.replace(",", ".") || 0);
  const p0 = await pct();
  const fRow = (await txt("[data-terra-fields] tbody tr")).replace(/\s+/g, " ");
  const pRow = (await txt("[data-terra-table] tbody tr")).replace(/\s+/g, " ");
  ok(p0 > 0 && p0 < 100 && /%/.test(fRow) && /%/.test(pRow), `Superficie con termitai: ${await txt("[data-terra-pct]")} · campo: ${fRow} · pivot: ${pRow}`);
  const bufIn = page.locator('label:has-text("Fascia di bonifica") input');
  await bufIn.fill("5"); await page.waitForTimeout(500);
  const p5 = await pct();
  ok(p5 > p0, `Con 5 m di fascia: ${p5}% (contro ${p0}%)`);
  await page.screenshot({ path: path.join(SH, "t1b_percentuale.png") });
  await bufIn.fill("0"); await page.waitForTimeout(300);
  // carreggiate
  await page.locator("[data-terra-check]").click();
  await page.locator("[data-terra-track-sum]").waitFor({ timeout: 180000 });
  const tr = await txt("[data-terra-track-sum]");
  ok(/Pendenza massima trovata: [\d,]+%/.test(tr), `Carreggiate: ${tr.split("\n")[0]}`);
  const tot = await txt("[data-terra-total]");
  const vt = Number((tot.match(/Movimenti di terra: ([\d.]+) m³/) || [])[1]?.replace(/\./g, "") || 0);
  ok(vt > 0 && (await page.locator("[data-terra-table] tbody tr").count()) > 0, `Totale: ${tot.replace(/\n/g, " · ")}`);
  await page.screenshot({ path: path.join(SH, "t2_totale.png") });
  ok(errors.length === 0, `Nessun errore JavaScript${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
} catch (e) { console.log("ERRORE", e, "\nJS:", errors.join(" || ")); fail++; await page.screenshot({ path: path.join(SH, "t_err.png") }).catch(() => {}); }
await browser.close();
console.log(fail ? `${fail} controlli falliti` : "Tutto ok");
process.exit(fail ? 1 : 0);
