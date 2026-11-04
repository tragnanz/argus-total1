// Prova completa su una copia locale del progetto «Shendi Sudan» (35 pivot) con la presa sul Nilo.
// Uso: ARGUS_URL=… ARGUS_API=… SHOTS=<cartella> node tests/e2e/shendi-check.mjs
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
import cp from "node:child_process";
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
const PIV = [[33.66495,16.72285],[33.66476,16.71761],[33.66457,16.71237],[33.66437,16.70713],[33.66418,16.70189],[33.66398,16.69665],[33.66379,16.69141],[33.66981,16.70694],[33.66961,16.7017],[33.66942,16.69646],[33.66922,16.69122],[33.66903,16.68598],[33.66884,16.68075],[33.66864,16.67551],[33.66845,16.67027],[33.66825,16.66503],[33.67524,16.70676],[33.67505,16.70152],[33.67486,16.69628],[33.67466,16.69104],[33.67447,16.6858],[33.67388,16.67008],[33.6735,16.6596],[33.6733,16.65436],[33.67311,16.64912],[33.68049,16.70133],[33.68029,16.69609],[33.6801,16.69085],[33.68592,16.70114],[33.68573,16.6959],[33.69136,16.70095],[33.69116,16.69571],[33.69097,16.69047],[33.69641,16.69029],[33.69621,16.68505]];
const AREA = [[33.66123,16.72604],[33.65902,16.68545],[33.66554,16.68561],[33.66559,16.6592],[33.66702,16.65913],[33.66705,16.64415],[33.67447,16.64385],[33.67979,16.66464],[33.67447,16.6806],[33.68554,16.69153],[33.69824,16.67936],[33.7058,16.68693],[33.694,16.70205],[33.69005,16.70727],[33.68129,16.70884],[33.66795,16.71393],[33.6688,16.72586],[33.66123,16.72604]];
const PRESA = [33.5952, 16.7821];   // Nilo, ~13,6 km a ovest dei pivot (rete GEOGLOWS)
const circ = (lng, lat, r) => Array.from({ length: 33 }, (_, i) => { const t = (i * 2 * Math.PI) / 32; return [lng + (r * Math.sin(t)) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (r * Math.cos(t)) / 110540]; });
const EMAIL = process.env.ARGUS_EMAIL || "shendi-check@argus.test", PASS = process.env.ARGUS_PASSWORD || "Password123!";
const tok = (await post("/auth/login", { email: EMAIL, password: PASS }).catch(() => post("/auth/register", { email: EMAIL, password: PASS, organization_name: "Shendi" }))).access_token;
const c = await post("/clients", { name: "Shendi (copia)" }, tok);
const p = await post("/projects", { name: "Shendi Sudan (copia)", client_id: c.id }, tok);
const a = await post("/areas", { project_id: p.id, name: "Area 1", geojson: { type: "Polygon", coordinates: [AREA] }, area_ha: 1785 }, tok);
await post("/layers", { project_id: p.id, kind: "pivots", name: "Pivot", data: { geojson: { type: "FeatureCollection", features: PIV.map(([x, y]) => ({ type: "Feature",
  properties: { kind: "pivot", connection: "canal", phase: 1, field: a.id, center: [x, y], r: 281 }, geometry: { type: "Polygon", coordinates: [circ(x, y, 281)] } })) },
  meta: { n_pivots: 35, radius_m: 280, net_ha: 868.2, safety_m: 20 } } }, tok);
await post(`/projects/${p.id}`, { settings: { pivot_brand: "starpivot", span_vmax: 3, crops: { base: ["canna"], fields: {} }, solar_pv: { wp: 550, k: 1.6, batt: 0, off: 6 },
  fonte: { pt: PRESA, route: null, type: "fiume", qmax: 0, hours: 24, range: 4, sed: true, energy: "rete", drive: "el", monthly: null, sectors: 0 } } }, tok, "PATCH");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("dialog", (d) => d.accept());
const download = async (click) => { const [d] = await Promise.all([page.waitForEvent("download", { timeout: 240000 }), click()]); return d; };
try {
  await page.goto(URL); await page.evaluate((t) => localStorage.setItem("argus-total-token", t), tok);
  await page.goto(URL); await page.waitForTimeout(3500);
  await page.locator('select:has(option:text-is("Shendi (copia)"))').selectOption({ label: "Shendi (copia)" }); await page.waitForTimeout(1200);
  await page.locator('select:has(option:text-is("Shendi Sudan (copia)"))').selectOption({ label: "Shendi Sudan (copia)" }); await page.waitForTimeout(6000);
  await page.locator('button[title="Fonte d\'acqua"]').first().click(); await page.waitForTimeout(1500);
  const t0 = Date.now();
  await page.locator("[data-river-table]").first().waitFor({ timeout: 120000 });
  const tRiver = (Date.now() - t0) / 1000;
  await page.locator("[data-river-forecast]").first().waitFor({ timeout: 90000 }).catch(() => {});
  const tExtra = (Date.now() - t0) / 1000;
  await page.waitForTimeout(1500);
  const rv = await page.locator("[data-river]").first().innerText();
  console.log("---- pannello fiume ----\n" + rv + "\n------------------------");
  ok(/GEOGLOWS/.test(rv) && /Dongola/.test(rv), `Pannello: GEOGLOWS sul Nilo corretto con Dongola (tabella in ${tRiver.toFixed(1)} s)`);
  ok(/rete idrografica GEOGLOWS/.test(rv) && /1\.9\d\d\.\d{3} km²/.test(rv), "Pannello: bacino dalla rete (≈1,95 milioni di km²)");
  ok(/Oggi il fiume porta/.test(rv), `Pannello: previsione di oggi (dopo ${tExtra.toFixed(1)} s)`);
  ok(/Livello dell'acqua/.test(rv), "Pannello: livelli dall'altimetria");
  ok(/Piogge medie sul bacino a monte/.test(rv), "Pannello: piogge medie sul bacino");
  ok(/misure 1912–1984, modello 1994–2023/.test(rv) && /più vecchie/.test(rv), "Pannello: periodi e avviso sulle misure vecchie");
  const pm = /Portata media ([\d.,]+) m³\/s/.exec(rv); const q = pm ? Number(pm[1].replace(/\./g, "").replace(",", ".")) : 0;
  ok(q > 1500 && q < 3500, `Pannello: portata media corretta ${q} m³/s`);
  await page.locator("[data-river]").first().screenshot({ path: path.join(SH, "1_pannello_fiume.png") });
  // rischio di progetto
  const prel = async () => (await page.locator("[data-river-table] tbody tr").nth(1).innerText());
  const before = await prel();
  await page.locator("[data-river-risk] select").selectOption("p10"); await page.waitForTimeout(800);
  const after = await prel();
  ok(before !== after, "Rischio di progetto: con «anno secco 1 su 10» cambia il prelevabile");
  await page.locator("[data-river-risk] select").selectOption("q80"); await page.waitForTimeout(500);
  // mappa: fiume e stazione
  const hy = await page.evaluate(() => ({ st: document.querySelectorAll(".hy-station").length, rv: document.querySelectorAll(".hy-river").length }));
  ok(hy.st >= 1 && hy.rv >= 2, `Mappa: stazione (${hy.st}) e tracciato del fiume (${hy.rv} elementi)`);
  await page.screenshot({ path: path.join(SH, "2_mappa.png") });
  console.log("elemento a (760,150):", await page.evaluate(() => { const e = document.elementFromPoint(760, 150); return e ? `${e.tagName}.${e.getAttribute("class")} ${e.getAttribute("src")?.slice(0, 80) ?? ""}` : "-"; }));
  // CSV
  const csv = await download(() => page.locator("[data-river-csv]").click());
  const csvTxt = fs.readFileSync(await csv.path(), "utf8");
  fs.copyFileSync(await csv.path(), path.join(SH, "fiume.csv"));
  ok(/Dongola/.test(csvTxt) && /GEOGLOWS/.test(csvTxt) && csvTxt.split("\n").length >= 15, `CSV: ${csvTxt.split("\n").length} righe con stazione e fonte`);
  // relazione
  await page.locator('[title="Esporta"], button:has-text("Esporta")').first().click(); await page.waitForTimeout(1000);
  const rel = await download(() => page.locator('button:has-text("Relazione tecnica per il cliente")').click());
  fs.copyFileSync(await rel.path(), path.join(SH, "relazione.pdf"));
  const relTxt = cp.execFileSync("pdftotext", ["-layout", await rel.path(), "-"]).toString();
  const sec = relTxt.slice(Math.max(0, relTxt.indexOf("Portata del fiume alla presa")), relTxt.indexOf("Portata del fiume alla presa") + 3500);
  console.log("---- relazione, fiume ----\n" + sec + "\n--------------------------");
  ok(/GEOGLOWS v2/.test(sec) && /Dongola/.test(sec) && /Fonti dei dati/.test(sec), "Relazione: fiume con GEOGLOWS, Dongola e fonti");
  ok(/rete idrografica GEOGLOWS/.test(sec), "Relazione: bacino dalla rete");
  ok(/altimetria satellitare/.test(sec), "Relazione: livelli");
  // .ceres e ZIP
  const ce = await download(() => page.locator('button:has-text("Esporta per Ceres")').click());
  const ceres = JSON.parse(fs.readFileSync(await ce.path(), "utf8"));
  ok(ceres.app === "ceres" && (ceres.sezioni ?? []).flatMap((s) => s.righe).length > 10, `.ceres: ${(ceres.sezioni ?? []).flatMap((s) => s.righe).length} righe di computo`);
  const zp = await download(() => page.locator('button:has-text("Progetto esecutivo completo")').click());
  const zl = cp.execFileSync("unzip", ["-l", await zp.path()]).toString();
  ok(/\.pdf/.test(zl) && /\.ceres/.test(zl) && /\.xlsx/.test(zl), "ZIP: PDF, .ceres e computo");
  // link per il cliente con la relazione in tutte le lingue
  await page.locator('input[placeholder*="Nome del link"]').fill("Cliente Shendi");
  const tl = Date.now();
  await page.locator('button:has-text("Crea link")').click();
  await page.waitForFunction(() => /Relazione allegata al link/.test(document.body.innerText), null, { timeout: 300000 });
  const tAtt = (Date.now() - tl) / 1000;
  const shares = await fetch(`${API}/projects/${p.id}/shares`, { headers: { Authorization: `Bearer ${tok}` } }).then((r) => r.json());
  const sh = shares[0];
  ok((sh?.report_langs?.length ?? 0) >= 18, `Link: relazione allegata in ${sh?.report_langs?.length ?? 0} lingue (${tAtt.toFixed(0)} s)`);
  const vp = await ctx.newPage(); vp.on("pageerror", (e) => errors.push("view: " + e.message));
  await vp.goto(`${URL}/view/${sh.token}`); await vp.waitForTimeout(3000);
  await vp.locator("[data-open-report]").click();
  await vp.locator("[data-report-reader] .rr-ch").first().waitFor({ timeout: 60000 });
  const it = await vp.locator("[data-report-reader]").innerText();
  ok(/Portata del fiume alla presa/.test(it) && /Dongola/.test(it) && (await vp.locator(".rr-ch").count()) >= 5, `Link: relazione interattiva in italiano (${await vp.locator(".rr-ch").count()} capitoli)`);
  await vp.waitForTimeout(1500);
  await vp.screenshot({ path: path.join(SH, "3_link_relazione_it.png") });
  ok((await vp.locator(".rr-chart svg").count()) >= 1 && (await vp.locator(".rr-map").count()) >= 1, "Link: grafici e mappe nella relazione");
  for (const [lg, re] of [["en", /Technical|technical|report/i], ["ru", /[А-Яа-я]{4,}/], ["ar", /[\u0600-\u06FF]{3,}/], ["zh", /[\u4e00-\u9fff]{2,}/]]) {
    await vp.locator("[data-report-reader] select").selectOption(lg); await vp.waitForTimeout(2500);
    const tx = await vp.locator("[data-report-reader] .rr-body").innerText();
    ok(re.test(tx) && /Dongola/.test(tx), `Link: relazione in ${lg}`);
    if (lg === "ar") ok((await vp.locator("[data-report-reader]").getAttribute("dir")) === "rtl", "Link: arabo da destra a sinistra");
  }
  await vp.screenshot({ path: path.join(SH, "4_link_relazione_zh.png") });
  const pdfR = await fetch(`${API}/share/${sh.token}/report.pdf?lang=en`);
  const pdfB = Buffer.from(await pdfR.arrayBuffer());
  ok(pdfR.ok && pdfB.subarray(0, 4).toString() === "%PDF", `Link: PDF della relazione in inglese (${Math.round(pdfB.length / 1024)} kB)`);
  await vp.setViewportSize({ width: 390, height: 844 }); await vp.locator("[data-report-reader] select").selectOption("it"); await vp.waitForTimeout(2000);
  await vp.screenshot({ path: path.join(SH, "5_link_mobile.png") });
  ok(errors.length === 0, `Nessun errore nella pagina${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
} catch (e) { console.log("✗ ERRORE", e.message); fail++; await page.screenshot({ path: path.join(SH, "errore.png") }).catch(() => {}); }
await browser.close();
console.log(fail ? `${fail} controlli falliti` : "Tutti i controlli superati");
process.exit(fail ? 1 : 0);
