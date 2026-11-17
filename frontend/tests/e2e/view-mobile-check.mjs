// Link di sola lettura sul telefono: niente pannelli accavallati, menu a scomparsa con Informazioni e Commenti.
// Uso: ARGUS_URL=… ARGUS_API=… SHOTS=<cartella> node tests/e2e/view-mobile-check.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");
import path from "node:path";
const URL = process.env.ARGUS_URL || "http://localhost:3124";
const API = (process.env.ARGUS_API || "http://localhost:8000") + "/api";
const SH = process.env.SHOTS || "/tmp";
let fail = 0; const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fail++; };
async function post(p, body, tok) {
  const r = await fetch(API + p, { method: "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`); return r.json();
}
const EMAIL = process.env.ARGUS_EMAIL || "view-check@argus.test", PASS = process.env.ARGUS_PASSWORD || "Password123!";
const tok = (await post("/auth/login", { email: EMAIL, password: PASS }).catch(() => post("/auth/register", { email: EMAIL, password: PASS, organization_name: "View" }))).access_token;
const RUN = String(Date.now() % 100000);
const c = await post("/clients", { name: `View ${RUN}` }, tok);
const p = await post("/projects", { name: `Shendi Sudan ${RUN}`, client_id: c.id }, tok);
await post("/areas", { project_id: p.id, name: "Area 1", geojson: { type: "Polygon", coordinates: [[[33.40, 16.70], [33.44, 16.70], [33.44, 16.74], [33.40, 16.74], [33.40, 16.70]]] }, area_ha: 1785 }, tok);
const sv = await post(`/projects/${p.id}/shares`, { name: "Cliente", config: {} }, tok);

const browser = await chromium.launch();
const errors = [];
try {
  // telefono
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${URL}/view/${sv.token}`); await page.waitForTimeout(3000);
  const panels = await page.locator(".widget:visible").count();
  ok(panels === 0 && await page.locator("[data-view-menu]").isVisible(), `Telefono: pannelli sulla mappa ${panels}, tasto menu visibile`);
  await page.screenshot({ path: path.join(SH, "v1_mappa.png") });
  await page.locator("[data-view-menu]").click(); await page.waitForTimeout(400);
  const dr = await page.locator("[data-view-drawer]").boundingBox();
  const info = await page.locator("[data-view-drawer]").innerText();
  ok(dr && dr.x >= -1 && /1\.785 ha|1,785 ha/.test(info), `Menu aperto (x=${dr?.x}) con le informazioni: ${info.replace(/\s+/g, " ").slice(0, 90)}`);
  await page.screenshot({ path: path.join(SH, "v2_menu.png") });
  await page.locator('[data-view-tab="comm"]').click(); await page.waitForTimeout(300);
  ok(await page.locator("[data-view-drawer] textarea").isVisible(), "Scheda Commenti con il modulo");
  await page.screenshot({ path: path.join(SH, "v3_commenti.png") });
  await page.mouse.click(dr.width + 20, 400); await page.waitForTimeout(400);
  const dr2 = await page.locator("[data-view-drawer]").boundingBox();
  ok(dr2 && dr2.x < -100, `Menu richiuso toccando la mappa (x=${dr2?.x})`);
  // computer: i due pannelli come prima
  const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const pg2 = await ctx2.newPage(); pg2.on("pageerror", (e) => errors.push(e.message));
  await pg2.goto(`${URL}/view/${sv.token}`); await pg2.waitForTimeout(3000);
  const w2 = await pg2.locator(".widget:visible").count();
  ok(w2 === 2 && !(await pg2.locator("[data-view-menu]").count()), `Computer: ${w2} pannelli, nessun menu`);
  ok(errors.length === 0, `Nessun errore JavaScript${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
} catch (e) { console.log("ERRORE", e); fail++; }
await browser.close();
console.log(fail ? `${fail} controlli falliti` : "Tutto ok");
process.exit(fail ? 1 : 0);
