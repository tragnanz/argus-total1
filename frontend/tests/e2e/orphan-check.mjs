// Prova: pivot salvati senza campo → assegnati al poligono che li contiene; quelli fuori restano «Senza campo»
// e la ✕ del gruppo li elimina. Uso: ARGUS_URL=… ARGUS_API=… node tests/e2e/orphan-check.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const URL = process.env.ARGUS_URL || "http://localhost:3124";
const API = (process.env.ARGUS_API || "http://localhost:8011") + "/api";
let fail = 0; const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fail++; };
async function post(p, body, tok) {
  const r = await fetch(API + p, { method: "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`); return r.json();
}
const EMAIL = process.env.ARGUS_EMAIL || "orph@argus.test", PASS = process.env.ARGUS_PASSWORD || "Password123!";
const tok = (await post("/auth/login", { email: EMAIL, password: PASS }).catch(() => post("/auth/register", { email: EMAIL, password: PASS, organization_name: "O" }))).access_token;
const RUN = String(Date.now() % 100000), CN = `Orfani ${RUN}`, PN = `Orfani p ${RUN}`;
const c = await post("/clients", { name: CN }, tok), p = await post("/projects", { name: PN, client_id: c.id }, tok);
await post("/areas", { project_id: p.id, name: "Poligono A", geojson: { type: "Polygon", coordinates: [[[10, 45], [10.03, 45], [10.03, 45.02], [10, 45.02], [10, 45]]] }, area_ha: 470 }, tok);
const piv = (lng, lat) => ({ type: "Feature", properties: { kind: "pivot", center: [lng, lat], r: 300 }, geometry: { type: "Polygon", coordinates: [[[lng - 0.003, lat], [lng, lat + 0.003], [lng + 0.003, lat], [lng, lat - 0.003], [lng - 0.003, lat]]] } });
const feats = [piv(10.008, 45.008), piv(10.016, 45.008), piv(10.024, 45.008), piv(10.10, 45.10), piv(10.11, 45.10)];
await post("/layers", { project_id: p.id, kind: "pivots", name: "Pivot", data: { geojson: { type: "FeatureCollection", features: feats }, meta: { radius_m: 300 } } }, tok);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1700, height: 1000 } })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("dialog", (d) => d.accept());
try {
  await page.goto(URL); await page.evaluate((t) => localStorage.setItem("argus-total-token", t), tok);
  await page.goto(URL); await page.waitForTimeout(3500);
  await page.locator(`select:has(option:text-is("${CN}"))`).selectOption({ label: CN }); await page.waitForTimeout(1200);
  await page.locator(`select:has(option:text-is("${PN}"))`).selectOption({ label: PN }); await page.waitForTimeout(4000);
  const body = await page.locator("body").innerText();
  ok(/Pivot · 3/.test(body), `Pivot dentro il poligono assegnati: ${(body.match(/Pivot · 3[^\n]*/) || ["–"])[0]}`);
  ok(/Senza campo · 2 pivot/.test(body), "I 2 pivot fuori restano senza campo");
  await page.locator('li:has-text("Senza campo · 2 pivot") button[title="Rimuovi"]').click(); await page.waitForTimeout(800);
  const body2 = await page.locator("body").innerText();
  ok(!/Senza campo · 2 pivot/.test(body2) && /Pivot · 3/.test(body2), "✕ sul gruppo senza campo: eliminati, restano i 3 del poligono");
  ok(errors.length === 0, `Nessun errore JavaScript${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
} catch (e) { console.log("ERRORE", e, "\nJS:", errors.join(" || ")); fail++; }
await browser.close();
console.log(fail ? `${fail} controlli falliti` : "Tutto ok");
process.exit(fail ? 1 : 0);
