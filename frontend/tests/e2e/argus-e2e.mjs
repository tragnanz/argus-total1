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
  // secondo campo della stessa azienda, a est, con un pivot e un'altra coltura
  const ring2 = ring.map(([x, y]) => [x + dx, y]);
  const a2 = await post("/areas", { project_id: p.id, name: "Campo 2", geojson: { type: "Polygon", coordinates: [ring2] }, area_ha: 90 }, tok);
  const circ = (lng, lat, r) => Array.from({ length: 33 }, (_, i) => { const t = (i * 2 * Math.PI) / 32; return [lng + (r * Math.sin(t)) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (r * Math.cos(t)) / 110540]; });
  const feats = [];
  const centers = [0.2, 0.5, 0.8].map((f) => [lon0 + dx * f, lat0 + dy * 0.5]);
  const c2 = [lon0 + dx * 1.5, lat0 + dy * 0.5];
  feats.push({ type: "Feature", properties: { kind: "pivot", center: c2, r: 280, field: a2.id }, geometry: { type: "Polygon", coordinates: [circ(c2[0], c2[1], 280)] } });
  centers.forEach(([lng, lat], i) => feats.push({ type: "Feature", properties: { kind: "pivot", center: [lng, lat], r: 280, field: a.id, ...(i === 2 ? { deg: 180, az: 0, gun: 20 } : {}) },
    geometry: { type: "Polygon", coordinates: [circ(lng, lat, 280)] } }));
  // tubazione che passa dai centri dei pivot (ogni centro è un vertice: la rete li alimenta)
  feats.push({ type: "Feature", properties: { kind: "pipe", field: a.id }, geometry: { type: "LineString", coordinates: [[lon0 - 0.002, lat0 + dy * 0.5], ...centers, c2] } });
  await post("/layers", { project_id: p.id, kind: "pivots", name: "Pivot", data: { geojson: { type: "FeatureCollection", features: feats }, meta: { radius_m: 280 } } }, tok);
  // fonte d'acqua: presa su un fiume a ovest dei campi, portata limitata e livelli mese per mese
  await post(`/projects/${p.id}`, { settings: { fonte: { pt: [lon0 - 0.004, lat0 + dy * 0.5], type: "fiume", qmax: 400, hours: 22, range: 3,
    monthly: [1.0, 1.0, 0.8, 0.6, 0.8, 1.4, 2.2, 2.6, 2.0, 1.4, 1.0, 1.0], sed: true },
    crops: { base: "canna", fields: { [a2.id]: ["mais", "cereali"] } } } }, tok, "PATCH");
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

  const rel = await download(() => page.locator('button:has-text("Relazione tecnica per il cliente")').click());
  const relPdf = await readBytes(rel);
  ok(relPdf.subarray(0, 4).toString() === "%PDF" && relPdf.length > 200000, "Relazione tecnica per il cliente: PDF con copertina e planimetria");
  if (process.env.ARGUS_SAVE) await rel.saveAs(process.env.ARGUS_SAVE);
  const relTxt = (await import("node:child_process")).execFileSync("pdftotext", ["-layout", await rel.path(), "-"]).toString();
  ok(/Dati della fonte d'acqua/.test(relTxt) && /Livelli della fonte mese per mese/.test(relTxt) && /400 l\/s/.test(relTxt), "Relazione: fonte d'acqua con portata disponibile e livelli mese per mese");
  ok(/Campo 1\s+[\d,]+\s+Canna da zucchero/.test(relTxt) && /Campo 2\s+[\d,]+\s+Mais, Cereali/.test(relTxt) && /Mais: ETc/.test(relTxt) && /Cereali: ETc/.test(relTxt),
    "Relazione: più colture per campo nella stessa azienda");
  ok(/Opera di presa e trattamento dell'acqua/.test(relTxt) && /Dissabbiatore/.test(relTxt), "Relazione: opera di presa e dissabbiatore dalla fonte d'acqua");
  ok(!/€|EUR\b/.test(relTxt.split("\n").filter((l) => !/Capitale Sociale/.test(l)).join("\n")), "Relazione: nessun prezzo");
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
  // motopompe diesel: pompe di superficie col motore termico, niente linea elettrica della stazione
  await page.locator('button:has-text("Pompaggio")').first().click(); await page.waitForTimeout(1500);
  await page.locator('.seg-item:has-text("Motore diesel")').first().click(); await page.waitForTimeout(2500);
  const pd = await section();
  ok(/motore diesel [\d.,]+ kW · [\d.,]+ giri\/min/.test(pd), "Pompaggio: motopompa diesel con potenza e giri");
  ok(!/alimentazione · (?!P\d)/.test(pd) && /alimentazione · P1/.test(pd), "Pompaggio: linee elettriche solo per i pivot, non per le motopompe");
  await page.locator('[title="Esporta"], button:has-text("Esporta")').first().click(); await page.waitForTimeout(800);
  const cd = await readJson(await download(() => page.locator('button:has-text("Esporta per Ceres")').click()));
  const pumpF = (cd.planimetria?.elementi?.features ?? []).find((f) => f.properties?.sottotipo === "pump");
  ok(pumpF?.properties?.azionamento === "diesel" && (cd.sezioni ?? []).flatMap((x) => x.righe).some((r) => r.codice === "ARGUS-MOTORE-DIESEL"),
    ".ceres: motopompa diesel con il motore da prezzare");
  await page.locator('button:has-text("Pompaggio")').first().click(); await page.waitForTimeout(1000);
  await page.locator('.seg-item:has-text("Motore elettrico")').first().click(); await page.waitForTimeout(1500);
  ok(errors.length === 0, `nessun errore nella pagina${errors.length ? ": " + errors.join(" | ") : ""}`);
} catch (e) {
  fails.push(String(e)); console.log("✕", e);
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} controlli falliti` : "\nTutti i controlli superati");
process.exit(fails.length ? 1 : 0);
