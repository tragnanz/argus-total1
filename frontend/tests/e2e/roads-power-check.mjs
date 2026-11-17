// Strade dagli ingressi sul confine e rete elettrica (AT/MT/BT, cabine, linee) con computo.
// Uso: ARGUS_URL=… ARGUS_API=… SHOTS=<cartella> node tests/e2e/roads-power-check.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
import path from "node:path";
const URL = process.env.ARGUS_URL || "http://localhost:3124";
const API = (process.env.ARGUS_API || "http://localhost:8000") + "/api";
const SH = process.env.SHOTS || "/tmp";
let fail = 0; const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fail++; };
async function post(p, body, tok) {
  const r = await fetch(API + p, { method: "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`); return r.json();
}
const EMAIL = process.env.ARGUS_EMAIL || "wcheck@argus.test", PASS = process.env.ARGUS_PASSWORD || "Password123!";
const tok = (await post("/auth/login", { email: EMAIL, password: PASS }).catch(() => post("/auth/register", { email: EMAIL, password: PASS, organization_name: "Roads" }))).access_token;
const AREA = [[-12.80, 16.10], [-12.76, 16.10], [-12.76, 16.13], [-12.80, 16.13], [-12.80, 16.10]];
const RUN = String(Date.now() % 100000), CN = `Strade ${RUN}`, PN = `Rete ${RUN}`;
const c = await post("/clients", { name: CN }, tok);
const p = await post("/projects", { name: PN, client_id: c.id }, tok);
await post("/areas", { project_id: p.id, name: "Area 1", geojson: { type: "Polygon", coordinates: [AREA] }, area_ha: 1430 }, tok);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1700, height: 950 } })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("dialog", (d) => d.accept());
try {
  await page.goto(URL); await page.evaluate((t) => localStorage.setItem("argus-total-token", t), tok);
  await page.goto(URL); await page.waitForTimeout(3500);
  await page.locator(`select:has(option:text-is("${CN}"))`).selectOption({ label: CN }); await page.waitForTimeout(1200);
  await page.locator(`select:has(option:text-is("${PN}"))`).selectOption({ label: PN }); await page.waitForTimeout(4000);
  await page.locator('[data-quick-step="pivot"]').click();
  await page.locator("text=/pivot su \\d+ aree/").first().waitFor({ timeout: 180000 });
  // bordo del campo sullo schermo: il poligono più grande sulla mappa
  const box = await page.evaluate(() => { let b = null; for (const p of document.querySelectorAll(".leaflet-overlay-pane path")) { const r = p.getBoundingClientRect(); if (!b || r.width * r.height > b.width * b.height) b = { x: r.x, y: r.y, width: r.width, height: r.height }; } return b; });
  await page.locator('button[title="Strade"]').first().click(); await page.waitForTimeout(800);
  // 1 · strade dagli ingressi
  await page.locator('[data-road-mode-k="auto"]').click();
  await page.locator("[data-road-gate-pick]").click();
  await page.mouse.click(box.x + 8, box.y + box.height * 0.36); await page.waitForTimeout(300);
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height - 8); await page.waitForTimeout(300);
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  const nG = await page.locator("[data-road-gate]").count();
  await page.locator("[data-road-auto-go]").click(); await page.waitForTimeout(1500);
  const rm = (await page.locator("body").innerText()).match(/Strade dagli ingressi:[^\n]*/)?.[0] ?? "";
  ok(nG === 2 && /\d+ tratti/.test(rm), `Ingressi ${nG} · ${rm}`);
  await page.screenshot({ path: path.join(SH, "r1_strade.png") });
  // 2 · rete elettrica: un punto MT sul bordo
  await page.locator('[data-road-mode-k="power"]').click();
  await page.locator("[data-power-pick]").click();
  await page.mouse.click(box.x + box.width * 0.37, box.y + 8); await page.waitForTimeout(300);
  await page.keyboard.press("Escape"); await page.waitForTimeout(2500);
  const sum = (await page.locator("[data-power-sum]").innerText().catch(() => "")).replace(/\s+/g, " ");
  const nCab = await page.locator("[data-pw-cab]").count(), nMt = await page.locator("path.pw-mt").count(), nLv = await page.locator("path.pw-lv").count();
  ok(/\d+ cabine MT\/BT/.test(sum) && nCab > 0 && nMt > 0 && nLv > 0, `Rete: ${sum} · mappa: cabine ${nCab}, tratti MT ${nMt}, BT ${nLv}`);
  await page.screenshot({ path: path.join(SH, "r2_rete.png") });
  // AT: si aggiunge la stazione AT/MT
  await page.locator("[data-power-row] select").first().selectOption("AT"); await page.waitForTimeout(1500);
  const sumAt = (await page.locator("[data-power-sum]").innerText().catch(() => "")).replace(/\s+/g, " ");
  ok(/1 stazioni AT\/MT/.test(sumAt), `Consegna in AT: ${sumAt}`);
  // computo: cabine, linea MT e cavi BT
  await page.locator('[data-quick-step="computo"]').click(); await page.waitForTimeout(1500);
  const cBtn = page.getByRole("button", { name: /▸ Computo metrico/ }).first();
  if (await cBtn.count()) { await cBtn.click(); await page.waitForTimeout(800); }
  const cmp = await page.locator("body").innerText();
  const rows = ["Cabina di trasformazione MT/BT da", "Linea MT interrata 20 kV", "Stazione di trasformazione AT/MT", "Cavo interrato"].map((k) => [k, (cmp.match(new RegExp(`${k}[^\\n]*(\\n[^\\n]*){0,2}`)) || [""])[0].replace(/\n/g, " ¦ ")]);
  ok(rows.every(([, v]) => v), `Computo: ${rows.map(([k, v]) => v ? v.slice(0, 80) : `manca «${k}»`).join(" | ")}`);
  ok(errors.length === 0, `Nessun errore JavaScript${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
} catch (e) { console.log("ERRORE", e, "\nJS:", errors.join(" || ")); fail++; await page.screenshot({ path: path.join(SH, "r_err.png") }).catch(() => {}); }
await browser.close();
console.log(fail ? `${fail} controlli falliti` : "Tutto ok");
process.exit(fail ? 1 : 0);
