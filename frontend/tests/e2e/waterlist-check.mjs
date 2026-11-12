// Prova: anteprima topografica non confermata → la posa dei pivot la conferma; elenco corsi d'acqua con
// selezione multipla, cartelle, unione in polilinea ed eliminazione di gruppo. Area: Gorgol (Mauritania).
// Uso: ARGUS_URL=… ARGUS_API=… SHOTS=<cartella> node tests/e2e/waterlist-check.mjs
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
const EMAIL = process.env.ARGUS_EMAIL || "wl-check@argus.test", PASS = process.env.ARGUS_PASSWORD || "Password123!";
const tok = (await post("/auth/login", { email: EMAIL, password: PASS }).catch(() => post("/auth/register", { email: EMAIL, password: PASS, organization_name: "WL" }))).access_token;
const AREA = [[-12.80, 16.10], [-12.74, 16.10], [-12.74, 16.16], [-12.80, 16.16], [-12.80, 16.10]];
const RUN = String(Date.now() % 100000), CN = `Elenco ${RUN}`, PN = `Gorgol elenco ${RUN}`;
const c = await post("/clients", { name: CN }, tok);
const p = await post("/projects", { name: PN, client_id: c.id }, tok);
await post("/areas", { project_id: p.id, name: "Area 1", geojson: { type: "Polygon", coordinates: [AREA] }, area_ha: 4300 }, tok);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1700, height: 1000 } })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
let promptAns = "Fiumi nord"; page.on("dialog", (d) => d.accept(d.type() === "prompt" ? promptAns : undefined));
const rows = () => page.locator('[data-water-list="free"] [data-wl-row]').count();
try {
  await page.goto(URL); await page.evaluate((t) => localStorage.setItem("argus-total-token", t), tok);
  await page.goto(URL); await page.waitForTimeout(3500);
  await page.locator(`select:has(option:text-is("${CN}"))`).selectOption({ label: CN }); await page.waitForTimeout(1200);
  await page.locator(`select:has(option:text-is("${PN}"))`).selectOption({ label: PN }); await page.waitForTimeout(4000);
  await page.locator('li:has-text("Area 1") button').filter({ hasText: "Area 1" }).first().click().catch(() => {});
  await page.locator('button[title="Fonte d\'acqua"]').first().click(); await page.waitForTimeout(600);
  await page.locator("[data-water-topo]").click();
  await page.locator("text=/Importazione topografica in \\d+ s/").first().waitFor({ timeout: 60000 });
  ok((await rows()) === 0, "Anteprima topografica aperta, non ancora confermata (elenco vuoto)");
  await page.locator('button[title="Impianti"]').first().click(); await page.waitForTimeout(600);
  await page.locator('button:has-text("Inserisci su «")').first().click();
  await page.locator("text=/Impianti inseriti|pivot/i").first().waitFor({ timeout: 180000 }); await page.waitForTimeout(1500);
  const nRules = await page.locator('[data-water-rule="river"]').innerText();
  const n0 = await rows();
  ok(n0 > 10 && /\(\d+\)/.test(nRules) && !/\(0\)/.test(nRules), `Posa dei pivot: anteprima confermata da sola · ${n0} corsi nell'elenco · regole: ${nRules}`);
  // unisci due linee
  await page.locator('[data-water-list="free"] [data-wl-check]').nth(0).click();
  await page.locator('[data-water-list="free"] [data-wl-check]').nth(1).click();
  await page.locator('[data-water-list="free"] [data-wl-merge]').click(); await page.waitForTimeout(800);
  const n1 = await rows(), m1 = ((await page.locator("body").innerText()).match(/[^\n]*unite in una polilinea[^\n]*/) || [""])[0];
  ok(n1 === n0 - 1 && /unite in una polilinea/.test(m1), `Unione: ${n0} → ${n1} · ${m1.slice(0, 120)}`);
  // cartella con 3 elementi (selezione con Maiusc)
  await page.locator('[data-water-list="free"] [data-wl-check]').nth(0).click();
  await page.locator('[data-water-list="free"] [data-wl-check]').nth(2).click({ modifiers: ["Shift"] });
  await page.locator('[data-water-list="free"] [data-wl-folder]').click(); await page.waitForTimeout(600);
  const fo = page.locator('[data-wl-folder-row="Fiumi nord"]');
  ok(await fo.isVisible() && /\(3\)/.test(await fo.innerText()), `Cartella: ${(await fo.innerText()).replace(/\n/g, " ")}`);
  await page.screenshot({ path: path.join(SH, "wl1_cartella.png") });
  // elimina la cartella con il contenuto
  await fo.locator('button[title="Elimina la cartella e il suo contenuto"]').click(); await page.waitForTimeout(600);
  const n2 = await rows();
  ok(n2 === n1 - 3 && !(await fo.isVisible().catch(() => false)), `Cartella eliminata: ${n1} → ${n2}`);
  // seleziona tutti e elimina
  await page.locator('[data-wl-all="free"]').check(); await page.waitForTimeout(200);
  await page.locator('[data-water-list="free"] [data-wl-del]').click(); await page.waitForTimeout(800);
  ok((await rows()) === 0, "Tutti eliminati in gruppo");
  ok(errors.length === 0, `Nessun errore JavaScript${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
} catch (e) { console.log("ERRORE", e, "\nJS:", errors.join(" || ")); fail++; await page.screenshot({ path: path.join(SH, "wl_err.png") }).catch(() => {}); }
await browser.close();
console.log(fail ? `${fail} controlli falliti` : "Tutto ok");
process.exit(fail ? 1 : 0);
