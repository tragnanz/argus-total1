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
  // clic su un fiume sulla mappa → riga evidenziata a sinistra con tipo e nome modificabili; Canc lo elimina
  await page.waitForTimeout(1500);
  const pt = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll(".leaflet-overlay-pane path")].filter((p) => p.getAttribute("fill") && p.getAttribute("fill") !== "none").map((c) => c.getBoundingClientRect()).filter((b) => b.width < 300);
    for (const p of [...document.querySelectorAll(".leaflet-overlay-pane path")].filter((p) => p.getAttribute("stroke") === "#1d4ed8" && p.getAttribute("stroke-opacity") !== "0")) {
      const L = p.getTotalLength(); if (L < 80) continue;
      for (let f = 0.1; f < 0.95; f += 0.05) {
        const q = p.getPointAtLength(L * f), m = p.getScreenCTM(), x = m.a * q.x + m.c * q.y + m.e, y = m.b * q.x + m.d * q.y + m.f;
        if (x < 480 || x > 1180 || y < 120 || y > 900) continue;
        if (boxes.some((b) => x > b.left - 8 && x < b.right + 8 && y > b.top - 8 && y < b.bottom + 8)) continue;
        return { x, y };
      }
    }
    return null;
  });
  ok(!!pt, "Fiume visibile da cliccare");
  if (pt) await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(800);
  const ed = page.locator("[data-wl-edit]").first();
  const edOk = await ed.isVisible().catch(() => false);
  const idx = edOk ? await ed.getAttribute("data-wl-edit") : null;
  const rowTxt = idx ? await page.locator(`[data-wl-row="${idx}"]`).innerText() : "";
  ok(edOk && /Fiume/.test(rowTxt), `Selezionato sulla mappa e nell'elenco: ${rowTxt.replace(/\s+/g, " ")}`);
  if (idx) {
    await page.locator(`[data-wl-kind="${idx}"]`).selectOption("canal"); await page.waitForTimeout(500);
    const rowTxt2 = await page.locator(`[data-wl-row="${idx}"]`).innerText();
    ok(/Canale/.test(rowTxt2), `Tipo cambiato da fiume a canale: ${rowTxt2.replace(/\s+/g, " ")}`);
    const nb = await rows();
    // dividi in due nel punto cliccato, poi Canc toglie il secondo pezzo (accorciato)
    const L0 = Number((rowTxt2.match(/([\d.]+) m/) || [])[1]?.replace(/\./g, "") || 0);
    await page.locator(`[data-wl-split="${idx}"]`).click(); await page.waitForTimeout(300);
    await page.mouse.click(pt.x, pt.y); await page.waitForTimeout(800);
    const nSplit = await rows();
    const msgS = ((await page.locator("body").innerText()).match(/Diviso in due[^\n]*/) || [""])[0];
    ok(nSplit === nb + 1 && /Diviso in due/.test(msgS), `Dividi: ${nb} → ${nSplit} · ${msgS.slice(0, 90)}`);
    await page.keyboard.press("Delete"); await page.waitForTimeout(600);
    const L1 = Number(((await page.locator(`[data-wl-row="${idx}"]`).innerText()).match(/([\d.]+) m/) || [])[1]?.replace(/\./g, "") || 0);
    ok((await rows()) === nb && L1 > 0 && L1 < L0, `Canc toglie il secondo pezzo: ${await rows()} corsi, tratto accorciato da ${L0} a ${L1} m`);
    // Canc sul selezionato
    await page.locator(`[data-wl-row="${idx}"] button`).nth(1).click(); await page.waitForTimeout(400);
    await page.keyboard.press("Delete"); await page.waitForTimeout(600);
    ok((await rows()) === nb - 1, `Canc elimina il corso selezionato: ${nb} → ${await rows()}`);
  }
  const n0b = await rows();
  // tipo di gruppo
  await page.locator('[data-water-list="free"] [data-wl-check]').nth(0).click();
  await page.locator('[data-water-list="free"] [data-wl-check]').nth(1).click();
  await page.locator('[data-water-list="free"] [data-wl-bulkkind]').selectOption("drain"); await page.waitForTimeout(500);
  const t01 = (await page.locator('[data-water-list="free"] [data-wl-row]').nth(0).innerText()) + " | " + (await page.locator('[data-water-list="free"] [data-wl-row]').nth(1).innerText());
  ok((t01.match(/Dreno/g) || []).length === 2, `Tipo di gruppo: ${t01.replace(/\s+/g, " ")}`);
  await page.locator('[data-water-list="free"] [data-wl-check]').nth(0).click();
  await page.locator('[data-water-list="free"] [data-wl-check]').nth(1).click();
  // unisci due linee
  await page.locator('[data-water-list="free"] [data-wl-check]').nth(0).click();
  await page.locator('[data-water-list="free"] [data-wl-check]').nth(1).click();
  await page.locator('[data-water-list="free"] [data-wl-merge]').click(); await page.waitForTimeout(800);
  const n1 = await rows(), m1 = ((await page.locator("body").innerText()).match(/[^\n]*unite in una polilinea[^\n]*/) || [""])[0];
  ok(n1 === n0b - 1 && /unite in una polilinea/.test(m1), `Unione: ${n0b} → ${n1} · ${m1.slice(0, 120)}`);
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
