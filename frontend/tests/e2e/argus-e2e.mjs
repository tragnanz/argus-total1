// Prova completa di Argus Total nel browser (Playwright), contro un backend e
// un frontend già avviati:
//
//   backend:  DATABASE_URL=sqlite:///./e2e.db uvicorn app.main:app --port 8011
//   frontend: NEXT_PUBLIC_API_BASE=http://localhost:8011 npx next build && npx next start -p 3124
//   prova:    ARGUS_URL=http://localhost:3124 ARGUS_API=http://localhost:8011 npm run test:e2e
//             (su un database già usato: ARGUS_EMAIL=… ARGUS_PASSWORD=… per entrare)
//
// Crea un utente e un progetto nuovi (3 pivot, una tubazione), poi controlla:
// pompe Caprari e cavi in Pompaggio, file .ceres con il computo per Mercurius,
// varianti generate con costi e indicatori, Excel e PDF del confronto.
// Esce con codice 1 al primo controllo fallito.
// Playwright: quello del progetto (npm i -D playwright) o quello installato nel sistema
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const URL = process.env.ARGUS_URL || "http://localhost:3124";
const API = (process.env.ARGUS_API || "http://localhost:8011") + "/api";
const fails = [];
const CLIENT = `Cliente E2E ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;
const ok = (cond, what) => { console.log(`${cond ? "✓" : "✕"} ${what}`); if (!cond) fails.push(what); };

async function post(path, body, tok, method = "POST") {
  const r = await fetch(API + path, { method, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

async function seed() {
  // database vuoto: ci si registra; altrimenti si entra con ARGUS_EMAIL / ARGUS_PASSWORD
  let tok;
  if (process.env.ARGUS_EMAIL) tok = (await post("/auth/login", { email: process.env.ARGUS_EMAIL, password: process.env.ARGUS_PASSWORD })).access_token;
  else tok = (await post("/auth/register", { email: `e2e-${Date.now()}@argus.test`, password: "Password123!", organization_name: "E2E" })).access_token;
  const c = await post("/clients", { name: CLIENT }, tok);
  const p = await post("/projects", { name: "Progetto E2E", client_id: c.id }, tok);
  const lon0 = 9.0, lat0 = 45.0, dx = 1500 / (111320 * Math.cos((lat0 * Math.PI) / 180)), dy = 600 / 110540;
  const ring = [[lon0, lat0], [lon0 + dx, lat0], [lon0 + dx, lat0 + dy], [lon0, lat0 + dy], [lon0, lat0]];
  const a = await post("/areas", { project_id: p.id, name: "Campo 1", geojson: { type: "Polygon", coordinates: [ring] }, area_ha: 90 }, tok);
  const circ = (lng, lat, r) => Array.from({ length: 33 }, (_, i) => { const t = (i * 2 * Math.PI) / 32; return [lng + (r * Math.sin(t)) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (r * Math.cos(t)) / 110540]; });
  const feats = [];
  const centers = [0.2, 0.5, 0.8].map((f) => [lon0 + dx * f, lat0 + dy * 0.5]);
  centers.forEach(([lng, lat], i) => feats.push({ type: "Feature", properties: { kind: "pivot", center: [lng, lat], r: 280, field: a.id, ...(i === 2 ? { deg: 180, az: 0, gun: 20 } : {}) },
    geometry: { type: "Polygon", coordinates: [circ(lng, lat, 280)] } }));
  // tubazione che passa dai centri dei pivot (ogni centro è un vertice: la rete li alimenta)
  feats.push({ type: "Feature", properties: { kind: "pipe", field: a.id }, geometry: { type: "LineString", coordinates: [[lon0 - 0.002, lat0 + dy * 0.5], ...centers] } });
  await post("/layers", { project_id: p.id, kind: "pivots", name: "Pivot", data: { geojson: { type: "FeatureCollection", features: feats }, meta: { radius_m: 280 } } }, tok);
  return { tok };
}

const { tok } = await seed();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("dialog", (d) => d.accept());
const section = async () => (await page.locator("section:not([hidden])").allInnerTexts()).pop() ?? "";
const download = async (click) => { const [d] = await Promise.all([page.waitForEvent("download", { timeout: 90000 }), click()]); return d; };
const readJson = async (d) => JSON.parse(await (await import("node:fs/promises")).readFile(await d.path(), "utf8"));
const readBytes = async (d) => (await import("node:fs/promises")).readFile(await d.path());
try {
  await page.goto(URL); await page.evaluate((t) => localStorage.setItem("argus-total-token", t), tok);
  await page.goto(URL); await page.waitForTimeout(3500);
  await page.locator(`select:has(option:text-is("${CLIENT}"))`).selectOption({ label: CLIENT }); await page.waitForTimeout(1200);
  await page.locator('select:has(option:text-is("Progetto E2E"))').selectOption({ label: "Progetto E2E" }); await page.waitForTimeout(5000);

  await page.locator('button:has-text("Pompaggio")').first().click(); await page.waitForTimeout(2500);
  const pump = await section();
  ok(/Caprari \S+/.test(pump), "Pompaggio: pompa Caprari scelta dalle curve");
  ok(/ΔV \d/.test(pump), "Pompaggio: linee elettriche con caduta di tensione");

  await page.locator('[title="Esporta"], button:has-text("Esporta")').first().click(); await page.waitForTimeout(800);
  const ceres = await readJson(await download(() => page.locator('button:has-text("Esporta per Ceres")').click()));
  ok(ceres.app === "ceres" && typeof ceres.m === "string" && ceres.m.length > 10, ".ceres: progetto Ceres in «m»");
  ok(ceres.tracciato === "ceres/computo-metrico" && ceres.versione === 1, ".ceres: tracciato del computo Mercurius");
  ok(/^ARGUS-\d+$/.test(ceres.progetto?.riferimento ?? "") && ceres.progetto?.revisione >= 1, ".ceres: riferimento e revisione");
  const rows = (ceres.sezioni ?? []).flatMap((s) => s.righe);
  ok(rows.length > 10 && rows.every((r) => r.codice && Number(r.quantita) > 0), ".ceres: righe con codice e quantità > 0");
  const codes = rows.map((r) => r.codice);
  ok(codes.some((c) => /^P-PIPE-U-PE-100-PN-10-\d+$/.test(c)), ".ceres: tubi della rete con diametro calcolato all'esportazione");
  ok(codes.some((c) => /^V-AIR-\d+$/.test(c)) && codes.includes("V-DRAIN"), ".ceres: sfiati e scarichi");
  ok(codes.some((c) => /^MVALVE-\d+$/.test(c)), ".ceres: idrovalvola all'attacco dei pivot");
  ok(codes.some((c) => /^E-(CU|AL)-/.test(c)), ".ceres: linee elettriche a codice");
  ok(codes.includes("ARGUS-QUADRO-POMPE"), ".ceres: quadro delle pompe");
  ok(rows.some((r) => /SPAN-STARPIVOT/.test(r.codice) && r.peso_kg > 0), ".ceres: campate con peso");
  const feats = ceres.planimetria?.elementi?.features ?? [];
  ok(feats.some((f) => f.properties?.tipo === "attrezzatura" && f.properties?.pompa_modello), ".ceres: planimetria con la pompa consigliata");
  ok(feats.filter((f) => f.properties?.tipo === "cavo").every((f) => f.geometry.coordinates.length >= 3), ".ceres: cavi dei pivot lungo le tubazioni");

  await page.locator('button:has-text("Varianti del progetto")').click(); await page.waitForTimeout(600);
  await page.locator('button:has-text("Genera le varianti")').click(); await page.waitForTimeout(15000);
  const vt = await section();
  ok((vt.match(/(Rete \/ generatore|FV \+ generatore|FV \+ batterie)\n[^\n]*↺/g) ?? []).length >= 3, "Varianti: tre varianti generate");
  ok(/Costo di esercizio \(€\/anno\)/.test(vt) && /Energia per ettaro/.test(vt), "Varianti: costi di esercizio e indicatori");
  await page.locator('button:has-text("Genera le varianti")').click(); await page.waitForTimeout(15000);
  const vt2 = await section();
  ok((vt2.match(/FV \+ batterie\n[^\n]*↺/g) ?? []).length === 1, "Varianti: rigenerare non duplica");
  // variante scelta e rinomina
  await page.locator('button[title="Variante scelta"]').first().click(); await page.waitForTimeout(1500);
  ok(/★ /.test(await section()), "Varianti: variante scelta segnata con ★");
  page.removeAllListeners("dialog"); page.once("dialog", (d) => d.accept("Proposta E2E"));
  await page.locator('button[title="Rinomina"]').first().click(); await page.waitForTimeout(1500);
  ok(/Proposta E2E/.test(await section()), "Varianti: rinomina");
  page.on("dialog", (d) => d.accept());
  const xlsx = await readBytes(await download(() => page.locator('button:has-text("Scarica Excel")').first().click()));
  ok(xlsx.subarray(0, 2).toString() === "PK", "Varianti: Excel");
  const pdf = await readBytes(await download(() => page.locator('button:has-text("Scarica PDF")').last().click()));
  ok(pdf.subarray(0, 4).toString() === "%PDF", "Varianti: PDF di confronto");
  ok(errors.length === 0, `nessun errore nella pagina${errors.length ? ": " + errors.join(" | ") : ""}`);
} catch (e) {
  fails.push(String(e)); console.log("✕", e);
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} controlli falliti` : "\nTutti i controlli superati");
process.exit(fails.length ? 1 : 0);
