// Prova della lettura di fiumi e canali da Sentinel-2 (serve un backend con dati reali).
// Area: Chivasso (Po, Orco, Canale Cavour). Uso: ARGUS_URL=… ARGUS_API=… SHOTS=<cartella> node tests/e2e/water-check.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const JSZip = require("jszip");
import fs from "node:fs";
import path from "node:path";
const URL = process.env.ARGUS_URL || "http://localhost:3124";
const API = (process.env.ARGUS_API || "http://localhost:8011") + "/api";
const SH = process.env.SHOTS || "/tmp";
let fail = 0; const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fail++; };
async function post(p, body, tok, method = "POST") {
  const r = await fetch(API + p, { method, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`); return r.json();
}
const AREA = [[7.86, 45.165], [7.96, 45.165], [7.96, 45.215], [7.86, 45.215], [7.86, 45.165]];
const EMAIL = process.env.ARGUS_EMAIL || "water-check@argus.test", PASS = process.env.ARGUS_PASSWORD || "Password123!";
const tok = (await post("/auth/login", { email: EMAIL, password: PASS }).catch(() => post("/auth/register", { email: EMAIL, password: PASS, organization_name: "Water" }))).access_token;
const c = await post("/clients", { name: "Chivasso" }, tok);
const p = await post("/projects", { name: "Chivasso acque", client_id: c.id }, tok);
await post("/areas", { project_id: p.id, name: "Area Po", geojson: { type: "Polygon", coordinates: [AREA] }, area_ha: 3100 }, tok);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("dialog", (d) => d.accept());
const download = async (click) => { const [d] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), click()]); return d; };
try {
  await page.goto(URL); await page.evaluate((t) => localStorage.setItem("argus-total-token", t), tok);
  await page.goto(URL); await page.waitForTimeout(3500);
  await page.locator('select:has(option:text-is("Chivasso"))').selectOption({ label: "Chivasso" }); await page.waitForTimeout(1200);
  await page.locator('select:has(option:text-is("Chivasso acque"))').selectOption({ label: "Chivasso acque" }); await page.waitForTimeout(5000);
  const tabBtn = page.locator('button[title="Analisi"]').first();
  if (!(await page.locator('button:has-text("Rileva corsi d\'acqua")').first().isVisible().catch(() => false))) await tabBtn.click();
  await page.waitForTimeout(800);
  const t0 = Date.now();
  await page.locator('button:has-text("Rileva corsi d\'acqua")').first().click();
  await page.locator('button:has-text("Conferma")').first().waitFor({ timeout: 400000 });
  const tDet = (Date.now() - t0) / 1000;
  const msg = await page.locator("text=/Anteprima: .* tratti di fiume/").first().innerText().catch(() => "");
  console.log("messaggio:", msg);
  ok(/tratti di fiume/.test(msg), `Anteprima pronta in ${tDet.toFixed(0)} s`);
  await page.screenshot({ path: path.join(SH, "w1_anteprima.png") });
  await page.locator('button:has-text("Conferma")').first().click(); await page.waitForTimeout(1500);
  const tbl = page.locator("[data-water-table]").first();
  await tbl.waitFor({ timeout: 10000 });
  const txt = await tbl.innerText();
  console.log("---- pannello ----\n" + txt.slice(0, 900) + "\n------------------");
  const rows = await tbl.locator("tbody tr").count();
  ok(rows >= 10, `Tabella: ${rows} tratti`);
  // il tratto di canale più lungo è il Cavour: 5 km circa, 25-45 m
  const canals = await tbl.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => ({ kind: tr.querySelector("select")?.value, len: tr.children[2].textContent, w: tr.querySelector("input")?.value })));
  const cav = canals.filter((r) => r.kind === "canal").map((r) => ({ ...r, L: Number(String(r.len).replace(/[^\d,]/g, "").replace(",", ".")) })).sort((a, b) => b.L - a.L)[0];
  ok(cav && cav.L > 4500 && Number(cav.w) > 25 && Number(cav.w) < 45, `Canale Cavour: ${cav?.L} m, larghezza ${cav?.w} m`);
  await tbl.screenshot({ path: path.join(SH, "w2_tabella.png") });
  await page.screenshot({ path: path.join(SH, "w3_mappa.png") });
  // modifica a mano della larghezza → resta nel KMZ
  const firstInput = tbl.locator("tbody tr input").first();
  await firstInput.fill("33"); await page.waitForTimeout(400);
  // KMZ
  const kmz = await download(() => tbl.locator('button:has-text("KMZ")').click());
  fs.copyFileSync(await kmz.path(), path.join(SH, "corsi_dacqua.kmz"));
  const zip = await JSZip.loadAsync(fs.readFileSync(await kmz.path()));
  const kml = await zip.file("doc.kml").async("string");
  const nPm = (kml.match(/<Placemark>/g) || []).length;
  const folders = [...kml.matchAll(/<Folder><name>([^<]+)<\/name>/g)].map((m) => m[1]);
  ok(/Fiumi \(\d+\)/.test(folders.join("|")) && /Canali \(\d+\)/.test(folders.join("|")), `KMZ: cartelle ${folders.join(", ")}`);
  ok(/<Data name="larghezza_m"><value>33<\/value>/.test(kml), "KMZ: la larghezza modificata a mano (33 m) è nel file");
  ok(/<Data name="lunghezza_m">/.test(kml) && /Larghezza tipica/.test(kml) && /Sentinel-2/.test(kml), `KMZ: ${nPm} elementi con lunghezza, larghezza e fonte`);
  ok(/Superficie d'acqua \(satellite\)/.test(kml), "KMZ: superficie d'acqua del satellite");
  // CSV
  const csv = await download(() => tbl.locator('button:has-text("CSV")').click());
  const csvTxt = fs.readFileSync(await csv.path(), "utf8");
  ok(csvTxt.split("\n").length > 10 && /larghezza_m/.test(csvTxt), `CSV: ${csvTxt.split("\n").length - 1} righe`);
  // salvataggio e riapertura: misure conservate
  await page.waitForTimeout(6000);   // salvataggio automatico
  await page.reload(); await page.waitForTimeout(3500);
  await page.locator('select:has(option:text-is("Chivasso"))').selectOption({ label: "Chivasso" }); await page.waitForTimeout(1200);
  await page.locator('select:has(option:text-is("Chivasso acque"))').selectOption({ label: "Chivasso acque" }); await page.waitForTimeout(5000);
  if (!(await page.locator("[data-water-table]").first().isVisible().catch(() => false))) await page.locator('button[title="Analisi"]').first().click();
  await page.waitForTimeout(1000);
  const txt2 = await page.locator("[data-water-table]").first().innerText().catch(() => "");
  ok(/Sentinel-2, \d+ date/.test(txt2) && (await page.locator("[data-water-table] tbody tr").count()) === rows, "Dopo il salvataggio: tratti, misure e periodo ricaricati");
  ok(!errors.length, `Nessun errore JS (${errors.slice(0, 3).join(" | ")})`);
} catch (e) { console.log("ERRORE", e); fail++; await page.screenshot({ path: path.join(SH, "w_err.png") }).catch(() => {}); }
await browser.close();
console.log(fail ? `${fail} controlli falliti` : "Tutto ok");
process.exit(fail ? 1 : 0);
