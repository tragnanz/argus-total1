// Prova del PROGETTO RAPIDO (barra a passi sulla mappa): aree → pivot → fonte → rete → computo.
// Area: Gorgol (Mauritania), fiumi cartografati. Serve un backend con dati reali (quote, tasselli topografici).
// Uso: ARGUS_URL=… ARGUS_API=… SHOTS=<cartella> node tests/e2e/quick-check.mjs
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
const EMAIL = process.env.ARGUS_EMAIL || "quick-check@argus.test", PASS = process.env.ARGUS_PASSWORD || "Password123!";
const tok = (await post("/auth/login", { email: EMAIL, password: PASS }).catch(() => post("/auth/register", { email: EMAIL, password: PASS, organization_name: "Quick" }))).access_token;
const AREA = [[-12.80, 16.10], [-12.74, 16.10], [-12.74, 16.16], [-12.80, 16.16], [-12.80, 16.10]];
const RUN = String(Date.now() % 100000), CN = `Rapido ${RUN}`, PN = `Gorgol rapido ${RUN}`;
const c = await post("/clients", { name: CN }, tok);
const p = await post("/projects", { name: PN, client_id: c.id }, tok);
await post("/areas", { project_id: p.id, name: "Area 1", geojson: { type: "Polygon", coordinates: [AREA] }, area_ha: 4300 }, tok);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1700, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("dialog", (d) => d.accept());
if (process.env.DEBUG_CANAL) page.on("response", async (r) => { if (r.url().includes("/canal/network") && r.request().method() === "POST") { const fs = await import("node:fs"); fs.writeFileSync(process.env.DEBUG_CANAL, JSON.stringify({ req: JSON.parse(r.request().postData() || "{}"), res: await r.json().catch(() => null) })); } });
const msgText = () => page.locator(".pill-dark").first().innerText().catch(() => "");
const stepInfo = (k) => page.locator(`[data-quick-step="${k}"]`).innerText().catch(() => "");
let clicks = 0;
const click = async (loc) => { clicks++; await loc.click(); };
try {
  await page.goto(URL); await page.evaluate((t) => localStorage.setItem("argus-total-token", t), tok);
  await page.goto(URL); await page.waitForTimeout(3500);
  await page.locator(`select:has(option:text-is("${CN}"))`).selectOption({ label: CN }); await page.waitForTimeout(1200);
  await page.locator(`select:has(option:text-is("${PN}"))`).selectOption({ label: PN }); await page.waitForTimeout(3000);
  // ricaricando la pagina restano aperti cliente e progetto
  await page.reload(); await page.waitForTimeout(5000);
  const selC = await page.locator(`select:has(option:text-is("${CN}"))`).evaluate((e) => e.options[e.selectedIndex]?.text);
  const selP = await page.locator(`select:has(option:text-is("${PN}"))`).evaluate((e) => e.options[e.selectedIndex]?.text);
  ok(selC === CN && selP === PN, `Dopo il ricaricamento: cliente «${selC}», progetto «${selP}»`);
  const bar = page.locator("[data-quick-bar]");
  ok(await bar.isVisible(), "Barra del progetto rapido visibile");
  ok(/✓/.test(await stepInfo("aree")), `Passo 1 aree: ${(await stepInfo("aree")).replace(/\n/g, " ")}`);
  await page.screenshot({ path: path.join(SH, "q1_barra.png") });
  const t0 = Date.now();
  // 2 · pivot
  await click(page.locator('[data-quick-step="pivot"]'));
  await page.locator("text=/pivot su \\d+ aree/").first().waitFor({ timeout: 180000 });
  const m2 = await msgText();
  const tPiv = (Date.now() - t0) / 1000;
  ok(/✓/.test(await stepInfo("pivot")), `Passo 2 pivot in ${tPiv.toFixed(0)} s: ${m2.slice(0, 160)}`);
  await page.screenshot({ path: path.join(SH, "q2_pivot.png") });
  // gruppo pivot nascosto e pivot posati di nuovo: tornano visibili
  const nCirc = () => page.evaluate(() => [...document.querySelectorAll(".leaflet-overlay-pane path")].filter((p) => p.getAttribute("fill") && p.getAttribute("fill") !== "none" && p.getBoundingClientRect().width < 300).length);
  const h0 = await nCirc();
  await page.evaluate(() => { const b = [...document.querySelectorAll('button[title="Mostra/Nascondi"]')].find((x) => /^Pivot ·/.test((x.parentElement?.innerText || "").replace(/^[○◉]\s*/, "").trim())); b?.click(); });
  await page.waitForTimeout(500);
  const h1 = await nCirc();
  await page.locator('[data-quick-step="pivot"]').click();
  await page.locator("text=/pivot su \\d+ aree/").first().waitFor({ timeout: 180000 }); await page.waitForTimeout(800);
  const h2 = await nCirc();
  ok(h0 > 0 && h1 < h0 && h2 >= h0, `Pivot nascosti e posati di nuovo: ${h0} cerchi → ${h1} nascosti → ${h2} dopo la posa`);
  // canali esistenti: «spiana» (default) → m³ di terra; «lascia» → i pivot li evitano
  const cTxt = async () => (await page.locator("[data-quick-canals]").innerText()).replace(/\n/g, " ");
  const nPiv = async () => Number(((await stepInfo("pivot")).match(/(\d+) ·/) || [])[1] || 0);
  const vol1 = Number(((await cTxt()).match(/([\d.]+) m³/) || [])[1]?.replace(/\./g, "") || 0), np1 = await nPiv();
  const fillLine = await page.locator("[data-water-fill]").first().innerText().catch(() => "");
  ok(vol1 > 0, `Canali spianati: ${await cTxt()} · ${np1} pivot · ${fillLine.trim()}`);
  await page.locator('[data-quick-canal="lascia"]').click(); await page.waitForTimeout(500);
  await click(page.locator('[data-quick-step="pivot"]'));
  await page.locator("text=/pivot su \\d+ aree/").first().waitFor({ timeout: 180000 }); await page.waitForTimeout(800);
  const np2 = await nPiv(), c2 = await cTxt();
  ok(np2 < np1 && !/m³/.test(c2), `Canali lasciati: ${np2} pivot (contro ${np1}), niente terra da spostare (${c2})`);
  await page.screenshot({ path: path.join(SH, "q2b_lascia.png") });
  await page.locator('[data-quick-canal="spiana"]').click(); await page.waitForTimeout(500);
  await click(page.locator('[data-quick-step="pivot"]'));
  await page.locator("text=/pivot su \\d+ aree/").first().waitFor({ timeout: 180000 }); await page.waitForTimeout(800);
  ok((await nPiv()) === np1, `Di nuovo «spiana»: ${await nPiv()} pivot`);
  // regole sui fiumi (pagina Impianti): passa sopra → più pivot; fascia di rispetto 150 m → meno pivot
  const rePiv = async () => { await page.locator('[data-quick-step="pivot"]').click(); await page.locator("text=/pivot su \\d+ aree/").first().waitFor({ timeout: 180000 }); await page.waitForTimeout(800); return nPiv(); };
  await page.locator('button[title="Impianti"]').first().click(); await page.waitForTimeout(600);
  ok(await page.locator("[data-water-rules]").isVisible(), `Regole corsi d'acqua: ${(await page.locator("[data-water-rules]").innerText()).split("\n").slice(0, 8).join(" ")}`);
  await page.locator('[data-water-rule-btn="river-on"]').click(); await page.waitForTimeout(300);
  const npOver = await rePiv();
  await page.locator('[data-water-rule-btn="river-off"]').click();
  await page.locator('[data-water-rule-buf="river"]').fill("150"); await page.waitForTimeout(300);
  const npBuf = await rePiv();
  ok(npOver > np1 && npBuf < np1, `Fiumi: evitati ${np1} pivot · passa sopra ${npOver} · fascia 150 m ${npBuf}`);
  // con la fascia di 150 m: zone escluse tratteggiate in rosso, con la superficie per motivo
  const exBox = (await page.locator("[data-excluded-box]").innerText().catch(() => "")).replace(/\n/g, " ");
  const exN = await page.locator(".leaflet-argusExcluded-pane path").count();
  ok(/Corsi d'acqua da evitare/.test(exBox) && exN > 0, `Zone escluse: ${exBox} · ${exN} poligoni tratteggiati`);
  await page.screenshot({ path: path.join(SH, "q_escluse.png") });
  await page.locator('[data-water-rule-buf="river"]').fill("0"); await page.waitForTimeout(300);
  ok((await rePiv()) === np1, "Di nuovo fiumi evitati senza fascia");
  // 3 · fonte: clic su un fiume
  await click(page.locator('[data-quick-step="fonte"]'));
  await page.waitForTimeout(2500);
  const pt = await page.evaluate(() => {
    const circles = [...document.querySelectorAll(".leaflet-overlay-pane path")].filter((p) => p.getAttribute("fill") && p.getAttribute("fill") !== "none");
    const boxes = circles.map((c) => c.getBoundingClientRect()).filter((b) => b.width < 300);   // i cerchi dei pivot, non l'area
    const ps = [...document.querySelectorAll(".leaflet-overlay-pane path")].filter((p) => p.getAttribute("stroke") === "#1d4ed8" && p.getAttribute("stroke-opacity") !== "0");
    for (const p of ps) {
      const L = p.getTotalLength(); if (L < 80) continue;
      for (let f = 0.1; f < 0.95; f += 0.05) {
        const q = p.getPointAtLength(L * f), m = p.getScreenCTM();
        const x = m.a * q.x + m.c * q.y + m.e, y = m.b * q.x + m.d * q.y + m.f;
        if (x < 480 || x > 1180 || y < 180 || y > 880) continue;
        if (boxes.some((b) => x > b.left - 8 && x < b.right + 8 && y > b.top - 8 && y < b.bottom + 8)) continue;
        return { x, y };
      }
    }
    return null;
  });
  ok(!!pt, "Fiume visibile fuori dai pivot su cui cliccare");
  if (pt) { clicks++; await page.mouse.click(pt.x, pt.y); }
  await page.waitForTimeout(1500);
  const m3 = await msgText();
  ok(/Presa sul corso|Portata del fiume stimata/.test(m3) && /✓/.test(await stepInfo("fonte")), `Passo 3 fonte: ${m3.slice(0, 140)} · ${(await stepInfo("fonte")).replace(/\n/g, " ")}`);
  await page.waitForTimeout(4000);                         // quote della presa
  // 4 · rete
  const t4 = Date.now();
  await click(page.locator('[data-quick-step="rete"]'));
  await page.locator("text=/Rete pronta/").first().waitFor({ timeout: 180000 });
  const m4 = await msgText();
  const s4 = await stepInfo("rete");
  ok(/✓/.test(s4) && !/da collegare/.test(s4), `Passo 4 rete in ${((Date.now() - t4) / 1000).toFixed(0)} s: ${m4.slice(0, 200)} · ${s4.replace(/\n/g, " ")}`);
  await page.screenshot({ path: path.join(SH, "q4_rete.png") });
  // settori di pompaggio: stazioni nel loro posto, rete principale e distribuzione
  if (!(await page.locator("[data-sectors-note]").first().isVisible().catch(() => false))) { await page.locator('button[title="Fonte d\'acqua"]').first().click(); await page.waitForTimeout(1200); }
  const secNote = (await page.locator("[data-sectors-note]").first().innerText().catch(() => "")).replace(/\n/g, " ");
  const tree = (await page.locator("[data-main-tree]").first().innerText().catch(() => "")).replace(/\n/g, " ");
  ok(/settori/.test(secNote) && /principali/.test(tree), `Settori: ${secNote.slice(0, 120)} · ${tree}`);
  await page.locator("[data-sectors-note]").first().scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: path.join(SH, "q5_settori.png") });
  const schemes = await page.locator("text=/^[ABCD] · /").allInnerTexts().catch(() => []);
  console.log("  schemi:", schemes.join(" | "));
  for (const k of ["A", "B", "C", "D"]) console.log("  " + (await page.locator(`div.rounded-lg:has(> div > b:text-matches("^${k} · "))`).first().innerText().catch(() => "-")).replace(/\n/g, " ¦ ").slice(0, 1400));
  // computo
  await click(page.locator('[data-quick-step="computo"]'));
  await page.waitForTimeout(1500);
  const exp = await page.locator("body").innerText();
  ok(/Esporta|Computo/.test(exp), "Computo: pagina Esporta aperta");
  console.log(`Tempo dal passo 2 alla rete pronta: ${((Date.now() - t0) / 1000).toFixed(0)} s, clic: ${clicks}`);
  // caselle numeriche: separatore delle migliaia e cancellazione libera (anche sotto il minimo)
  await page.locator('button[title="Fonte d\'acqua"]').first().click(); await page.waitForTimeout(800);
  const vals = await page.locator("input[inputmode]").evaluateAll((els) => els.map((e) => e.value));
  ok(vals.some((v) => /^\d{1,3}(\.\d{3})+$/.test(v)), `Separatore delle migliaia nelle caselle: ${vals.filter((v) => /\d\.\d{3}/.test(v)).slice(0, 4).join(" ")}`);
  await page.locator('button[title="Tubazioni"]').first().click(); await page.waitForTimeout(800);
  const opt = await page.locator('section:not([hidden]) select:has(option[value="-1"])').first().locator("option").first().innerText().catch(() => "");
  ok(/^Fonte idrica: /.test(opt), `Tubazioni: partono da «${opt}»`);
  const box = page.locator('section:not([hidden]) input[inputmode]').first();
  await box.click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("Backspace");
  const empty = await box.inputValue();
  await page.keyboard.type("7"); await page.waitForTimeout(200);
  const seven = await box.inputValue();
  ok(empty === "" && seven === "7", `Casella «Pivot per linea»: cancellata → «${empty}», poi 7 → «${seven}»`);
  await click(page.getByRole("button", { name: /Traccia tubazioni su/ }).first());
  await page.waitForTimeout(1500);
  const pm = await page.locator("body").innerText();
  ok(/rami dalla fonte/.test(pm), `Tubazioni dalla fonte: ${(pm.match(/Tubazioni tracciate[^\n]*/) || ["-"])[0]}`);
  await page.screenshot({ path: path.join(SH, "q6_tubazioni_fonte.png") });
  // selezione per famiglia nella lista dei corsi d'acqua
  const famBtn = page.locator('[data-wl-family="river"]').first();
  if (await famBtn.count()) {
    const lbl = await famBtn.innerText();
    await famBtn.click(); await page.waitForTimeout(300);
    const bar = await page.locator("[data-wl-bar]").first().innerText();
    const nf = Number((lbl.match(/\((\d+)\)/) || [])[1]);
    ok(bar.includes(`${nf} selezionati`), `Famiglie: «${lbl.trim()}» → «${bar.split("\n")[0]}»`);
    await famBtn.click();
  } else ok(false, "Famiglie: pulsanti assenti");
  // distribuzione dalla fonte: scelta tubazioni / canali / misto nella pagina Fonte d'acqua
  await page.locator('button[title="Fonte d\'acqua"]').first().click(); await page.waitForTimeout(800);
  ok(await page.locator("[data-dist]").count() > 0, "Fonte: scelta della distribuzione (tubazioni, canali, misto)");
  await page.locator('[data-dist-mode="mixed"]').click(); await page.waitForTimeout(300);
  const pl = page.locator("[data-dist-perline]"); await pl.click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.type("4");
  await page.locator("[data-dist-go]").click();
  await page.waitForFunction(() => /Misto: canale principale/.test(document.body.innerText), null, { timeout: 90000 }).catch(() => {});
  const mm = await page.locator("body").innerText();
  ok(/Misto: canale principale/.test(mm), `Misto: ${(mm.match(/Misto: canale principale[^\n]*/) || ["-"])[0]}`);
  await page.screenshot({ path: path.join(SH, "q7_misto.png") });
  // tutti i fiumi come un'unica fonte: le tubazioni si allacciano al tratto più vicino
  const riverTab = page.locator("[data-water-kinds] button", { hasText: /Fiume/ }).first();
  if (await riverTab.count()) {
    await riverTab.click(); await page.waitForTimeout(400);
    await page.locator("[data-water-family-source]").click(); await page.waitForTimeout(600);
    const gm = await page.locator("body").innerText();
    ok(/Fonte idrica: tutti i fiumi/.test(gm), `Gruppo fonte: ${(gm.match(/Fonte idrica: tutti i fiumi[^\n]*/) || ["-"])[0].slice(0, 120)}`);
    await page.locator('[data-dist-mode="pipes"]').click(); await page.waitForTimeout(300);
    await page.locator("[data-dist-go]").click(); await page.waitForTimeout(1500);
    const gp = await page.locator("body").innerText();
    // il messaggio può essere già sostituito (es. portata del fiume stimata): vale anche il livello «Tubazioni · n rami»
    ok(/rami dalla fonte «Fiumi \(/.test(gp) || /Tubazioni · \d+ rami/.test(gp), `Tubazioni dal gruppo: ${(gp.match(/Tubazioni tracciate[^\n]*|Tubazioni · \d+ rami[^\n]*/) || ["-"])[0]}`);
    await page.screenshot({ path: path.join(SH, "q8_gruppo.png") });
    const sch = await page.locator("body").innerText();
    const eLine = (sch.match(/E · Prelievo diretto dal fiume[^\n]*(\n[^\n]*){0,2}/) || [""])[0].replace(/\n/g, " ¦ ");
    ok(/E · Prelievo diretto dal fiume/.test(sch) && /consigliato/.test(eLine), `Schema E: ${eLine.slice(0, 160)}`);
  } else ok(false, "Gruppo fonte: scheda Fiumi assente");
  // scelta dalla lista: il tracciato si ricalcola da solo
  await page.locator("[data-src-list]").selectOption({ index: 3 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.waitForFunction(() => /rami dalla fonte «(?!Fiumi)/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  const al = await page.locator("body").innerText();
  ok(/Tubazioni tracciate: \d+ rami dalla fonte «(?!Fiumi)/.test(al), `Lista → automatico: ${(al.match(/Tubazioni tracciate[^\n]*/) || ["-"])[0]}`);
  // stazioni di pompaggio sulle prese: elenco nella pagina Pompaggio e scheda al clic
  await page.locator('button[title="Pompaggio"]').first().click(); await page.waitForTimeout(800);
  const nRows = await page.locator("[data-tap-row]:visible").count();
  const nTaps = await page.locator("div[data-tap]").count();
  if (nRows) { await page.locator("[data-tap-row]:visible").first().click(); await page.waitForTimeout(800); }
  const card = (await page.locator("[data-tap-card]").count()) ? await page.locator("[data-tap-card]").innerText() : "";
  const nBr = await page.locator("[data-tap-branches] tbody tr").count(), nFt = await page.locator("[data-tap-feet] tbody tr").count();
  ok(nBr > 0 && nFt > 0, `Rami calcolati: ${nBr} tratti, ${nFt} pivot · ${(await page.locator("[data-tap-branches] tbody tr").first().innerText().catch(() => "")).replace(/\s+/g, " ")}`);
  ok(nRows > 0 && /Pivot serviti/.test(card), `Stazioni sulle prese: ${nRows} in elenco, ${nTaps} sulla mappa · ${card.split("\n").slice(0, 6).join(" | ").slice(0, 160)}`);
  await page.screenshot({ path: path.join(SH, "q10_stazione.png") });
  if (await page.locator("[data-tap-card] button").count()) await page.locator("[data-tap-card] button").first().click();
  // clic su una tubazione che passa dentro un pivot: si seleziona la tubazione, non il pivot
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  const ptOnPipe = await page.evaluate(() => {
    const ps = [...document.querySelectorAll(".leaflet-argusPipeHit-pane path")];
    for (const p of ps) {
      const L = p.getTotalLength(); if (L < 60) continue;
      const q = p.getPointAtLength(L * 0.6), m = p.getScreenCTM(); if (!m) continue;
      const x = q.x * m.a + q.y * m.c + m.e, y = q.x * m.b + q.y * m.d + m.f;
      if (x > 420 && x < 1250 && y > 120 && y < 880) return { x, y };
    }
    return null;
  });
  if (ptOnPipe) { await page.mouse.click(ptOnPipe.x, ptOnPipe.y); await page.waitForTimeout(600); }
  const selTxt = await page.locator("body").innerText();
  const cardP = (await page.locator("[data-comp-card]").count()) ? await page.locator("[data-comp-card]").innerText() : "";
  ok(/DN \d+ · [\d.,]+ l\/s/.test(cardP) && !/DN – /.test(cardP), `DN dalla portata dei pivot: ${(cardP.match(/DN [^\n]*/) || ["-"])[0]}`);
  // diametro scelto a mano: velocità e perdite si ricalcolano; «Automatico» torna al DN della portata
  if (await page.locator("[data-pipe-dn]").count()) {
    const hfOf = (x) => Number(((x.match(/perdite ([\d.,]+) m/) || [])[1] || "0").replace(/\./g, "").replace(",", "."));
    const i0 = await page.locator("[data-pipe-info]").innerText();
    const dn0 = Number((i0.match(/DN (\d+)/) || [])[1] || 0);
    const big = [110, 125, 140, 160, 180, 200, 225, 250, 280, 315, 355, 400, 450, 500].find((d) => d >= dn0 * 1.4) || 500;
    await page.locator("[data-pipe-dn]").selectOption(String(big)); await page.waitForTimeout(900);
    const i1 = await page.locator("[data-pipe-info]").innerText();
    await page.locator("[data-pipe-dn]").selectOption(""); await page.waitForTimeout(900);
    const i2 = await page.locator("[data-pipe-info]").innerText();
    ok(new RegExp(`DN ${big} `).test(i1) && hfOf(i1) < hfOf(i0) && new RegExp(`DN ${dn0} `).test(i2), `DN a mano: ${i0.split(" · v")[0]} perdite ${hfOf(i0)} m → DN ${big} perdite ${hfOf(i1)} m → automatico DN ${(i2.match(/DN (\d+)/) || [])[1]}`);
  } else ok(false, "Scelta del diametro assente nella scheda della tubazione");
  ok(!!ptOnPipe && /Tubazione · selezionato/.test(selTxt), `Clic sul tubo: ${(selTxt.match(/(Tubazione|Pivot P\d+) · selezionato/) || ["nessuna selezione"])[0]}`);
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  // pivot selezionato: maniglie del raggio, Ctrl+C / Ctrl+V
  await page.locator('button[title="Impianti"]').first().click(); await page.waitForTimeout(800);
  // la simulazione delle disposizioni gira all'apertura della pagina: si aspetta che finisca (carica la macchina)
  await page.waitForFunction(() => { const e = document.querySelector("[data-lay-sim]"); return !!e && !/…/.test(e.textContent || ""); }, null, { timeout: 240000 }).catch(() => {});
  // primo clic sul pivot: gruppo; secondo: il singolo (si clicca sull'etichetta, che lascia passare il clic al cerchio)
  const lab = page.locator(".pivot-label").nth(10);
  const lb = (await lab.count()) ? await lab.boundingBox() : null;
  if (lb) {
    // si clicca dentro il cerchio ma lontano dal centro (dove arrivano le tubazioni): si prova qualche punto
    const offs = [[28, -28], [-28, -28], [28, 18], [-28, 18], [0, -36], [36, 0], [-36, 0], [40, -40], [-40, -40], [40, 30], [-40, 30], [0, 45], [50, 0], [-50, 0]];
    let off = offs[0];
    for (const o of offs) {
      await page.keyboard.press("Escape"); await page.waitForTimeout(200);
      await page.mouse.click(lb.x + lb.width / 2 + o[0], lb.y - 6 + o[1]); await page.waitForTimeout(500);
      if (await page.locator("[data-grp-gun-apply]").count()) { off = o; break; }
    }
    // gruppo: irrigatore finale e settore su tutti
    if (await page.locator("[data-grp-gun-apply]").count()) {
      await page.locator("[data-grp-gun-apply]").click(); await page.waitForTimeout(400);
      const gm = await page.locator("body").innerText();
      ok(/Irrigatore finale applicato a \d+ pivot/.test(gm), `Gruppo: ${(gm.match(/Irrigatore finale applicato[^\n]*/) || ["-"])[0]}`);
    } else ok(false, "Strumenti di gruppo assenti");
    await page.mouse.click(lb.x + lb.width / 2 + off[0], lb.y - 6 + off[1]); await page.waitForTimeout(600);
    // singolo: rendi settoriale → due rombi; triangolo della gittata
    if (await page.locator("[data-make-sector]").count()) { await page.locator("[data-make-sector]").click(); await page.waitForTimeout(600); }
    const nS = await page.locator("div[data-sector-h]").count(), gh = page.locator("div[data-gun-h]").first();
    const gb = (await gh.count()) ? await gh.boundingBox() : null;
    if (gb) {
      await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2); await page.mouse.down();
      await page.mouse.move(gb.x + gb.width / 2 + 4, gb.y + gb.height / 2 + 4, { steps: 4 }); await page.mouse.up(); await page.waitForTimeout(500);
    }
    const sm = await page.locator("body").innerText();
    ok(nS === 2 && !!gb && /Pivot P\d+: (irrigatore finale|settore)/.test(sm), `Settore e gittata sul singolo: rombi ${nS}, triangolo ${gb ? "sì" : "no"} · ${(sm.match(/Pivot P\d+: (irrigatore|settore)[^\n]*/) || ["-"])[0]}`);
    const hs = page.locator('div[style*="nwse-resize"]');
    const nh = await hs.count();
    const hb = nh ? await hs.first().boundingBox() : null;
    if (hb) {
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
      await page.mouse.move(hb.x + hb.width / 2, hb.y - 30, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(500);
    }
    const rm = await page.locator("body").innerText();
    ok(nh === 4 && /Raggio del pivot P\d+: [\d.,]+ m/.test(rm), `Maniglie raggio: ${nh} · ${(rm.match(/Raggio del pivot P[^\n]*/) || ["-"])[0]}`);
    const box = await page.locator(".leaflet-container").boundingBox();
    await page.keyboard.press("ControlOrMeta+c"); await page.waitForTimeout(300);
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5); await page.waitForTimeout(200);
    await page.keyboard.press("ControlOrMeta+v"); await page.waitForTimeout(600);
    const pm2 = await page.locator("body").innerText();
    ok(/Pivot incollato \(P\d+\)/.test(pm2), `Copia/incolla: ${(pm2.match(/Pivot incollato[^\n]*/) || ["-"])[0].slice(0, 60)}`);
    await page.screenshot({ path: path.join(SH, "q9_maniglie.png") });
    // Esc toglie la selezione, anche con il cursore in una casella della scheda
    const hBefore = await page.locator('div[style*="nwse-resize"]').count();
    const inp = page.locator("input:visible").first();
    if (await inp.count()) await inp.focus().catch(() => {});
    await page.keyboard.press("Escape"); await page.waitForTimeout(400);
    const hAfter = await page.locator('div[style*="nwse-resize"]').count();
    ok(hBefore > 0 && hAfter === 0, `Esc toglie la selezione: maniglie ${hBefore} → ${hAfter}`);
  } else ok(false, "Etichette dei pivot assenti");
  // simulazione delle tre disposizioni nella pagina Impianti: pivot e ettari per ognuna
  if (!(await page.locator("[data-free-layout]").isVisible())) await page.locator('button[title="Impianti"]').first().click();
  await page.waitForTimeout(500);
  if (!(await page.locator("[data-free-layout]").isVisible())) await page.locator('button[title="Impianti"]').first().click();
  const simOk = await page.waitForFunction(() => { const rs = [...document.querySelectorAll("[data-lay-sim-row]")]; return rs.length === 3 && rs.every((r) => /pivot/.test(r.textContent || "") || /non calcolata/.test(r.textContent || "")); }, null, { timeout: 300000 }).then(() => true).catch(() => false);
  const simRows = (await page.locator("[data-lay-sim-row]").allInnerTexts()).map((x) => x.replace(/\s+/g, " "));
  ok(simOk && simRows.every((x) => /\d+ pivot/.test(x)), `Simulazione disposizioni: ${simRows.join(" | ")}`);
  // computo: tubazioni per diametro dai DN automatici, PVC con +4% per i bicchieri
  await click(page.locator('[data-quick-step="computo"]')); await page.waitForTimeout(1500);
  const cBtn = page.getByRole("button", { name: /▸ Computo metrico/ }).first();
  if (await cBtn.count()) { await cBtn.click(); await page.waitForTimeout(800); }
  const cmp = await page.locator("body").innerText();
  const pvcRow = (cmp.match(/Tubazione PVC-U PN10 DN \d+[^\n]*(\n[^\n]*){0,3}/) || [""])[0].replace(/\n/g, " ¦ ");
  ok(/Tubazione PVC-U PN10 DN \d+/.test(cmp) && /4% per i bicchieri/.test(cmp), `Computo tubazioni: ${pvcRow.slice(0, 140)}`);
  // soglia di ruscellamento proposta dal suolo del campo e dalla pendenza (letta da sola all'apertura del progetto)
  await page.locator('button[title="Analisi"]').first().click(); await page.waitForTimeout(500);
  const runTxt = await page.waitForFunction(() => { const e = document.querySelector("[data-runoff]"); return e && /ruscellare oltre/.test(e.textContent || "") ? e.textContent : null; }, null, { timeout: 90000 }).then((h) => h.jsonValue()).catch(() => "");
  ok(/ruscellare oltre [\d,]+ mm\/h/.test(String(runTxt)), `Ruscellamento: ${String(runTxt).replace(/\s+/g, " ").slice(0, 160)}`);
  const dmg = (await page.locator("[data-damage]").innerText()).replace(/\s+/g, " ");
  const dmgV = Number((dmg.match(/oltre ([\d,]+) mm\/h/) || [])[1]?.replace(",", ".") || 0), runV = Number((String(runTxt).match(/oltre ([\d,]+) mm\/h/) || [])[1]?.replace(",", ".") || 0);
  ok(dmgV > runV && /trattengono 12,7 mm/.test(dmg), `Soglia di danno: ${dmg.slice(0, 200)}`);
  // pagina Finanziamento: cinque strumenti, i più adatti all'area in alto, e il dossier tecnico
  await page.locator('button[title="Finanziamento"]').first().click(); await page.waitForTimeout(600);
  const finItems = await page.locator("[data-fin-item]").evaluateAll((es) => es.map((e) => e.getAttribute("data-fin-item") + (e.hasAttribute("open") ? "*" : "")));
  const finArea = await page.locator("[data-fin-area]").inputValue();
  const dossier = (await page.locator("[data-fin-dossier]").innerText()).replace(/\s+/g, " ");
  ok(finItems.length === 6 && /✓ Pivot posati/.test(dossier), `Finanziamento (${finArea}): ${finItems.join(", ")} · ${dossier.slice(0, 120)}`);
  await page.locator("[data-finance] select").nth(1).selectOption("pub"); await page.waitForTimeout(300);
  const finPub = await page.locator("[data-fin-item]").evaluateAll((es) => es.map((e) => e.getAttribute("data-fin-item") + (e.hasAttribute("open") ? "*" : "")));
  ok(/^eca\*/.test(finPub.join(",")) && finPub.includes("dfi*") && finPub.includes("pe"), `Acquirente pubblico: ${finPub.join(", ")}`);
  await page.locator("[data-finance] select").nth(1).selectOption("ppp"); await page.waitForTimeout(300);
  const finPpp = await page.locator("[data-fin-item]").evaluateAll((es) => es.map((e) => e.getAttribute("data-fin-item") + (e.hasAttribute("open") ? "*" : "")));
  ok(finPpp[0] === "ppp*" && finPpp.includes("pe*") && finPpp.includes("fornitore"), `Partenariato pubblico-privato: ${finPpp.join(", ")}`);
  await page.screenshot({ path: path.join(SH, "q99_finanza.png") });
  ok(errors.length === 0, `Nessun errore JavaScript${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
} catch (e) { console.log("ERRORE", e, "\nJS:", errors.join(" || ")); fail++; await page.screenshot({ path: path.join(SH, "q_err.png") }).catch(() => {}); }
await browser.close();
console.log(fail ? `${fail} controlli falliti` : "Tutto ok");
process.exit(fail ? 1 : 0);
