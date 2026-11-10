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
const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error" && /Error|error/.test(m.text())) errors.push("console: " + m.text().slice(0, 400)); }); page.on("dialog", (d) => d.accept());
// i corsi d'acqua stanno nella pagina Fonte d'acqua
const goFonte = async () => {
  if (!(await page.locator('button:has-text("Rileva corsi d\'acqua")').first().isVisible().catch(() => false))) await page.locator('button[title="Fonte d\'acqua"]').first().click();
  await page.waitForTimeout(600);
};
const download = async (click) => { const [d] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), click()]); return d; };
try {
  await page.goto(URL); await page.evaluate((t) => localStorage.setItem("argus-total-token", t), tok);
  await page.goto(URL); await page.waitForTimeout(3500);
  await page.locator('select:has(option:text-is("Chivasso"))').selectOption({ label: "Chivasso" }); await page.waitForTimeout(1200);
  await page.locator('select:has(option:text-is("Chivasso acque"))').selectOption({ label: "Chivasso acque" }); await page.waitForTimeout(5000);
  await goFonte();
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
  const canals = await tbl.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => ({ name: tr.children[0].textContent, kind: tr.querySelector("select")?.value, reg: tr.children[2].textContent, len: tr.children[3].textContent, w: tr.querySelector("input")?.value })));
  const cav = canals.filter((r) => r.kind === "canal" && /Cavour/.test(r.name || "")).map((r) => ({ ...r, L: Number(String(r.len).replace(/[^\d,]/g, "").replace(",", ".")) })).sort((a, b) => b.L - a.L)[0];
  ok(cav && cav.L > 3500 && Number(cav.w) > 25 && Number(cav.w) < 45 && /perenne/.test(cav.reg), `Canale Cavour: ${cav?.L} m, larghezza ${cav?.w} m, ${cav?.reg}`);
  // dettaglio del Cavour: larghezze nell'anno con le date, scarpa ed escursione stimata
  const cavIdx = await tbl.locator("tbody tr").evaluateAll((trs) => {
    let best = -1, bl = 0;
    trs.forEach((tr, k) => { if (tr.querySelector("select")?.value !== "canal" || !/Cavour/.test(tr.children[0].textContent || "")) return; const L = Number(String(tr.children[3]?.textContent).replace(/[^\d,]/g, "").replace(",", ".")); if (L > bl) { bl = L; best = k; } });
    return best;
  });
  await tbl.locator("tbody tr").nth(cavIdx).locator("button").first().click(); await page.waitForTimeout(400);
  const det = await tbl.locator("[data-water-detail]").first().innerText().catch(() => "");
  console.log("dettaglio Cavour:", det.replace(/\n/g, " | "));
  const scarpa = tbl.locator("[data-water-flow] input").nth(3);
  ok(/Larghezza nell'anno: .*\d.*–.*\d/.test(det) && /Escursione di livello stimata/.test(det) && /1,5|1.5/.test(await scarpa.inputValue()),
    "Scheda del canale: larghezze minima e massima con le date, scarpa 1:1,5, escursione stimata");
  // registrazione: OpenStreetMap canal; nome forzato a mano anche sugli altri tratti con lo stesso nome
  const card = tbl.locator("[data-water-card]").first();
  const reg = await card.locator("[data-water-reg]").innerText();
  ok(/Registrato come: OpenStreetMap: waterway=canal/.test(reg) && /Cavour/.test(reg), `Registrazione: ${reg.split("\n")[0]}`);
  await card.locator("[data-water-name]").fill("Cavour forzato"); await page.waitForTimeout(300);
  const reg2 = await card.locator("[data-water-reg]").innerText();
  const nSame = Number((reg2.match(/altri (\d+) tratti/) || [])[1] || 0);
  if (nSame) await card.locator("[data-water-same]").click();
  await page.waitForTimeout(400);
  const nForced = await tbl.locator("tbody tr").evaluateAll((trs) => trs.filter((tr) => /Cavour forzato/.test(tr.children[0].textContent || "")).length);
  ok(/Forzato a mano/.test(reg2) && /nome registrato «[^»]*Cavour[^»]*»/.test(reg2) && nForced === nSame + 1, `Nome forzato «Cavour forzato» su ${nForced} tratti (registrato: ${reg2.match(/nome registrato «[^»]*»/)?.[0]})`);
  // portata: pendenza letta dal DEM, poi Manning
  for (let k = 0; k < 40 && !(await card.locator("[data-water-slope]").inputValue()); k++) await page.waitForTimeout(1000);
  const flow = await card.locator("[data-water-flow]").innerText();
  console.log("portata Cavour:", flow.replace(/\n/g, " | "));
  const qTyp = Number((flow.match(/Tipica[^:]*: ([\d.]+) l\/s/) || [])[1]?.replace(/\./g, ""));
  ok(qTyp > 0 && /Pendenza dal DEM: quota/.test(flow) && /Magra/.test(flow), `Portata stimata del Cavour: ${qTyp} l/s, pendenza ${await card.locator("[data-water-slope]").inputValue()}‰`);
  await card.locator("[data-water-depth]").fill(String(Number(await card.locator("[data-water-depth]").inputValue()) * 2)); await page.waitForTimeout(300);
  const qTyp2 = Number(((await card.locator("[data-water-flow]").innerText()).match(/Tipica[^:]*: ([\d.]+) l\/s/) || [])[1]?.replace(/\./g, ""));
  ok(qTyp2 > qTyp * 1.5, `Profondità raddoppiata → portata ${qTyp} → ${qTyp2} l/s`);
  await scarpa.fill("1"); await page.waitForTimeout(400);
  const det2 = await tbl.locator("[data-water-detail]").first().innerText();
  const dh = (x) => Number((x.match(/stimata: ([\d,]+) m/) || [])[1]?.replace(",", "."));
  ok(dh(det2) > dh(det) * 1.3, `Scarpa 1:1 → escursione ricalcolata (${dh(det)} → ${dh(det2)} m)`);
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
  ok(/Canale Cavour/.test(kml) && /OpenStreetMap \(canal\) \+ Sentinel-2/.test(kml), "KMZ: nomi e fonte OpenStreetMap + Sentinel-2");
  ok(/<Data name="larghezza_m"><value>33<\/value>/.test(kml), "KMZ: la larghezza modificata a mano (33 m) è nel file");
  ok(/<Data name="lunghezza_m">/.test(kml) && /Larghezza tipica/.test(kml) && /Sentinel-2/.test(kml), `KMZ: ${nPm} elementi con lunghezza, larghezza e fonte`);
  ok(/Superficie d'acqua \(satellite\)/.test(kml), "KMZ: superficie d'acqua del satellite");
  ok(/<Data name="portata_ls">/.test(kml) && /<Data name="nome_registrato">/.test(kml) && /Portata stimata/.test(kml), "KMZ: portata stimata e nome registrato");
  ok(/<Data name="larghezza_min_oss_m">/.test(kml) && /<Data name="escursione_stimata_m">/.test(kml) && /Larghezza massima osservata/.test(kml), "KMZ: larghezze minima/massima osservate ed escursione stimata");
  // CSV
  const csv = await download(() => tbl.locator('button:has-text("CSV")').click());
  const csvTxt = fs.readFileSync(await csv.path(), "utf8");
  ok(csvTxt.split("\n").length > 10 && /larghezza_m/.test(csvTxt), `CSV: ${csvTxt.split("\n").length - 1} righe`);
  // salvataggio e riapertura: misure conservate
  await page.waitForTimeout(6000);   // salvataggio automatico
  await page.reload(); await page.waitForTimeout(3500);
  await page.locator('select:has(option:text-is("Chivasso"))').selectOption({ label: "Chivasso" }); await page.waitForTimeout(1200);
  await page.locator('select:has(option:text-is("Chivasso acque"))').selectOption({ label: "Chivasso acque" }); await page.waitForTimeout(5000);
  await goFonte();
  await page.waitForTimeout(1000);
  const txt2 = await page.locator("[data-water-table]").first().innerText().catch(() => "");
  ok(/Sentinel-2, \d+ date/.test(txt2) && (await page.locator("[data-water-table] tbody tr").count()) === rows, "Dopo il salvataggio: tratti, misure e periodo ricaricati");
  ok(/Cavour forzato/.test(txt2), "Dopo il salvataggio: il nome forzato resta");
  // fiumara Amendolea (Calabria): greto asciutto quasi tutto l'anno → alveo effimero
  const AM = [[15.82, 37.92], [15.90, 37.92], [15.90, 37.99], [15.82, 37.99], [15.82, 37.92]];
  const p2 = await post("/projects", { name: "Amendolea", client_id: c.id }, tok);
  await post("/areas", { project_id: p2.id, name: "Fiumara", geojson: { type: "Polygon", coordinates: [AM] }, area_ha: 5500 }, tok);
  await page.reload(); await page.waitForTimeout(3500);
  await page.locator('select:has(option:text-is("Chivasso"))').selectOption({ label: "Chivasso" }); await page.waitForTimeout(1200);
  await page.locator('select:has(option:text-is("Amendolea"))').selectOption({ label: "Amendolea" }); await page.waitForTimeout(5000);
  await goFonte();
  await page.locator('button:has-text("Rileva corsi d\'acqua")').first().click();
  await page.locator('button:has-text("Conferma")').first().waitFor({ timeout: 400000 });
  await page.locator('button:has-text("Conferma")').first().click(); await page.waitForTimeout(1500);
  const t3 = page.locator("[data-water-table]").first();
  const am = await t3.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => ({ reg: tr.children[2].textContent, len: tr.children[3].textContent, w: tr.querySelector("input")?.value })));
  const beds = am.filter((r) => /alveo/.test(r.reg || "")).map((r) => ({ ...r, L: Number(String(r.len).replace(/[^\d,]/g, "").replace(",", ".")) })).sort((a, b) => b.L - a.L);
  console.log("Amendolea:", JSON.stringify(am.slice(0, 6)));
  const totBed = beds.reduce((a, r) => a + r.L, 0);
  ok(totBed > 4500 && beds.every((r) => /effimero/.test(r.reg) && Number(r.w) >= 120 && Number(r.w) <= 400),
    `Fiumara Amendolea: ${beds.length} tratti di alveo effimero, ${totBed} m in tutto, larghi ${beds.map((r) => r.w).join(" / ")} m`);
  ok(!am.some((r) => Number(r.w) > 500), "Amendolea: niente mare preso per un fiume");
  await page.screenshot({ path: path.join(SH, "w4_amendolea.png") });
  const kmz2 = await download(() => t3.locator('button:has-text("KMZ")').click());
  const kml2 = await (await JSZip.loadAsync(fs.readFileSync(await kmz2.path()))).file("doc.kml").async("string");
  ok(/<Data name="regime"><value>ephemeral<\/value>/.test(kml2) && /Larghezza dell'alveo/.test(kml2), "KMZ Amendolea: regime effimero e larghezza dell'alveo");
  // Gorgol Noir (Mauritania): fiume stretto a meandri, asciutto quasi tutto l'anno. Il tracciato
  // completo viene da OpenStreetMap (tasselli OpenFreeMap scaricati dal backend)
  const GG = [[-12.84, 16.07], [-12.70, 16.07], [-12.70, 16.20], [-12.84, 16.20], [-12.84, 16.07]];
  const p3 = await post("/projects", { name: "Gorgol", client_id: c.id }, tok);
  await post("/areas", { project_id: p3.id, name: "Perimetro", geojson: { type: "Polygon", coordinates: [GG] }, area_ha: 21000 }, tok);
  await page.reload(); await page.waitForTimeout(3500);
  for (let k = 0; k < 3 && !(await page.locator('select option:text-is("Gorgol")').count()); k++) {
    const cs = page.locator('select:has(option:text-is("Chivasso"))').first();
    await cs.selectOption({ index: 0 }).catch(() => {}); await page.waitForTimeout(800);
    await cs.selectOption({ label: "Chivasso" }); await page.waitForTimeout(2000);
  }
  await page.locator('select:has(option:text-is("Gorgol"))').selectOption({ label: "Gorgol" }); await page.waitForTimeout(5000);
  await goFonte();
  await page.locator('button:has-text("Rileva corsi d\'acqua")').first().click();
  await page.locator('button:has-text("Conferma")').first().waitFor({ timeout: 600000 });
  const msgG = await page.locator("text=/tracciati completi da OpenStreetMap/").first().innerText().catch(() => "");
  ok(/\d+ tracciati completi da OpenStreetMap/.test(msgG), `Gorgol: ${msgG.match(/\d+ tracciati completi da OpenStreetMap/)?.[0] ?? "nessun tracciato OSM"}`);
  await page.locator('button:has-text("Conferma")').first().click(); await page.waitForTimeout(1500);
  const t4 = page.locator("[data-water-table]").first();
  const gg = await t4.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => ({ name: tr.children[0].textContent, len: tr.children[3]?.textContent, w: tr.querySelector("input")?.value })));
  const gor = gg.filter((r) => /Gorgol/i.test(r.name || "")).map((r) => Number(String(r.len).replace(/[^\d,]/g, "").replace(",", ".")));
  ok(gor.reduce((a, b) => a + b, 0) > 20000, `Gorgol Noir intero: ${gor.length} tratti, ${gor.reduce((a, b) => a + b, 0)} m in tutto`);
  await page.screenshot({ path: path.join(SH, "w5_gorgol.png") });
  const kmz3 = await download(() => t4.locator('button:has-text("KMZ")').click());
  const kml3 = await (await JSZip.loadAsync(fs.readFileSync(await kmz3.path()))).file("doc.kml").async("string");
  const pts = [...kml3.matchAll(/<coordinates>([^<]+)<\/coordinates>/g)].flatMap((m) => m[1].trim().split(/\s+/).map((q) => q.split(",").map(Number)));
  const outside = pts.filter(([lo, la]) => lo < -12.8405 || lo > -12.6995 || la < 16.0695 || la > 16.2005).length;
  ok(pts.length > 100 && outside === 0, `KMZ Gorgol: ${pts.length} vertici, ${outside} fuori dall'area`);
  ok(/OpenStreetMap \(river\)/.test(kml3) && /Gorgol/.test(kml3), "KMZ Gorgol: nome e fonte OpenStreetMap");
  // fiumi non spostabili, canali e dreni spostabili (casella ⇄), cartelle separate nel KMZ
  const mv = await t4.locator("tbody tr").evaluateAll((trs) => trs.filter((tr) => tr.querySelector("select")).map((tr) => ({ k: tr.querySelector("select").value, m: tr.querySelector('input[type="checkbox"]')?.checked })));
  const bad = mv.filter((r) => (r.k === "river" && r.m) || ((r.k === "canal" || r.k === "drain") && !r.m));
  ok(mv.some((r) => r.k === "drain") && mv.some((r) => r.k === "canal") && !bad.length,
    `Gorgol: ${mv.filter((r) => r.k === "river").length} fiumi fissi, ${mv.filter((r) => r.k === "canal").length} canali e ${mv.filter((r) => r.k === "drain").length} dreni spostabili`);
  // selezione dalla mappa: primo clic su un fiume = tutti i fiumi; clic su un altro fiume = quel tratto
  const clickLine = (col, skip) => page.evaluate(([col, skip]) => {
    const ps = [...document.querySelectorAll(".leaflet-overlay-pane path")].filter((p) => p.getAttribute("stroke") === col && p.getAttribute("stroke-opacity") !== "0");
    let n = 0;
    for (const p of ps) {
      const L = p.getTotalLength(); if (L < 80) continue;
      const q = p.getPointAtLength(L / 2), m = p.getScreenCTM();
      const x = m.a * q.x + m.c * q.y + m.e, y = m.b * q.x + m.d * q.y + m.f;
      if (x > 380 && x < 1060 && y > 140 && y < 880 && n++ >= skip) return { x, y };
    }
    return null;
  }, [col, skip]);
  await page.locator('[data-water-kinds] button').first().click(); await page.waitForTimeout(500);
  const c1 = await clickLine("#1d4ed8", 0);
  if (c1) await page.mouse.click(c1.x, c1.y);
  await page.waitForTimeout(800);
  const chip = await page.locator("[data-water-kinds] button.font-semibold").first().innerText().catch(() => "");
  const kindsShown = await t4.locator("tbody tr select").evaluateAll((ss) => [...new Set(ss.map((x) => x.value))]);
  ok(!!c1 && /Fiume/.test(chip) && kindsShown.length === 1 && kindsShown[0] === "river", `Primo clic su un fiume: selezionati i fiumi (${chip}; righe: ${kindsShown.join(",")})`);
  const c2 = await clickLine("#1d4ed8", 2);
  if (c2) await page.mouse.click(c2.x, c2.y);
  await page.waitForTimeout(800);
  const selRow = await t4.locator("tbody tr.bg-amber-100").count();
  const detail = await t4.locator("[data-water-detail]").count();
  ok(!!c2 && selRow === 1 && detail === 1, `Secondo clic: selezionata la singola diramazione (${selRow} riga evidenziata, dettaglio aperto)`);
  await page.screenshot({ path: path.join(SH, "w6_selezione.png") });
  const gc = t4.locator("[data-water-card]").first();
  const greg = await gc.locator("[data-water-reg]").innerText().catch(() => "");
  ok(/Registrato come: OpenStreetMap: waterway=river/.test(greg), `Scheda del fiume: ${greg.split("\n")[0]}`);
  // modifica dei punti: inserimento sulla linea, prolungamento dall'estremo, annulla
  await gc.locator("button:has-text('⌖')").click(); await page.waitForTimeout(1500);
  await gc.locator("[data-water-edit]").click(); await page.waitForTimeout(600);
  const nPts = async () => Number(((await gc.innerText()).match(/(\d+) punti/) || [])[1]);
  const lenOf = async () => Number(((await gc.innerText()).match(/punti · ([\d.]+) m/) || [])[1]?.replace(/\./g, ""));
  const n0 = await nPts(), l0 = await lenOf();
  const nv = await page.locator("[data-we-vertex]").count();
  ok(n0 > 2 && nv > 0, `Modifica punti: ${n0} punti, ${nv} maniglie nella vista`);
  await gc.locator("[data-water-modes] .seg-item").nth(1).click(); await page.waitForTimeout(300);
  const ends = await page.locator('[data-we-vertex="end"]').evaluateAll((es) => es.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
  const inMap = (q) => q.x > 380 && q.x < 1060 && q.y > 140 && q.y < 880;
  let ext = null;
  if (ends.length === 2) for (const [a, b] of [[ends[0], ends[1]], [ends[1], ends[0]]]) {
    const dx = a.x - b.x, dy = a.y - b.y, L = Math.hypot(dx, dy) || 1, q = { x: a.x + 45 * dx / L, y: a.y + 45 * dy / L };
    if (inMap(q)) { ext = q; break; }
  }
  if (ext) { await page.mouse.click(ext.x, ext.y); await page.waitForTimeout(600); }
  const n1 = await nPts(), l1 = await lenOf();
  ok(!!ext && n1 === n0 + 1 && l1 > l0, `Prolungamento dall'estremo: ${n0} → ${n1} punti, ${l0} → ${l1} m`);
  await page.screenshot({ path: path.join(SH, "w7_modifica.png") });
  await gc.locator("button:has-text('Annulla modifiche')").click(); await page.waitForTimeout(500);
  ok((await nPts()) === n0 && (await lenOf()) === l0, `Annulla modifiche: di nuovo ${await nPts()} punti`);
  await gc.locator("[data-water-done]").click(); await page.waitForTimeout(400);
  ok((await page.locator("[data-we-vertex]").count()) === 0, "Fine modifica: maniglie tolte");
  const c3 = await clickLine("#059669", 0);
  if (c3) { await page.mouse.click(c3.x, c3.y); await page.waitForTimeout(800); }
  const chip3 = await page.locator("[data-water-kinds] button.font-semibold").first().innerText().catch(() => "");
  ok(!!c3 && /Canale/.test(chip3), `Clic su un canale: si passa ai canali (${chip3})`);
  // collegamento: un canale si prolunga fino al fiume
  const c4 = await clickLine("#059669", 1);
  if (c4) { await page.mouse.click(c4.x, c4.y); await page.waitForTimeout(800); }
  const cc = t4.locator("[data-water-card]").first();
  const ccode = (await cc.locator("b").first().innerText().catch(() => "")).trim();
  await cc.locator("[data-water-connect]").click(); await page.waitForTimeout(300);
  const c5 = await clickLine("#1d4ed8", 0);
  if (c5) { await page.mouse.click(c5.x, c5.y); await page.waitForTimeout(900); }
  const cmsg = await page.locator("text=/collegato a F\\d+/").first().innerText().catch(() => "");
  const links = await cc.locator("[data-water-links]").innerText().catch(() => "");
  ok(/collegato a F\d+/.test(cmsg) && /F\d+/.test(links), `Collegamento: ${cmsg.trim()} · scheda: ${links.replace(/\n/g, " ")}`);
  await page.screenshot({ path: path.join(SH, "w8_collegamento.png") });
  // il corso diventa la fonte: presa sul canale, portata impostata
  for (let k = 0; k < 30 && !(await cc.locator("[data-water-slope]").inputValue().catch(() => "x")); k++) await page.waitForTimeout(1000);
  await cc.locator("[data-water-use]").click(); await page.waitForTimeout(800);
  const srcW = await page.locator("[data-src-water]").first().innerText().catch(() => "");
  ok(new RegExp("Presa sul corso " + ccode).test(srcW), `Fonte: ${srcW.replace(/\n/g, " ")}`);
  ok(/Dreni e fossi \(\d+\)/.test(kml3) && /<Data name="spostabile"><value>0<\/value>/.test(kml3) && /<Data name="spostabile"><value>1<\/value>/.test(kml3), "KMZ Gorgol: cartella dei dreni e campo «spostabile»");
  ok(!errors.length, `Nessun errore JS (${errors.slice(0, 3).join(" | ")})`);
} catch (e) { console.log("ERRORE", e, "\nJS:", errors.join(" || ")); fail++; await page.screenshot({ path: path.join(SH, "w_err.png") }).catch(() => {}); }
await browser.close();
console.log(fail ? `${fail} controlli falliti` : "Tutto ok");
process.exit(fail ? 1 : 0);
