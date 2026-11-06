"use client";
/**
 * Drenaggio — pannello portabile (Argus Smart, Argus Total, Helios).
 *
 * Si aggancia a una mappa Leaflet gia' esistente nell'app ospite e ci
 * aggiunge i propri strati: resa del terreno (rilievo ombreggiato, quote a
 * colori, pendenze, curve), ristagni, reticolo di scolo e bacino a monte di
 * un punto, piu' profilo, area e punti quotati con CSV. Le quote vengono dal
 * DEM pubblico (EU-DEM 25 m in Europa) scaricato dal browser.
 *
 * Dipende solo da React, Leaflet e dal modulo ../lib/drenaggio/. Lo stile usa
 * classi Tailwind neutre e un colore d'accento passato dall'app.
 * Nelle app Next va importato con dynamic(..., { ssr: false }).
 *
 * Copia canonica: Daedalus (src/lib/drenaggio/) per il modulo di calcolo.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import { campiona, cellaDi, latlngDi, statisticheZ, type Griglia } from "../lib/drenaggio/griglia";
import { caricaDEM, DESCRIZIONE_DEM } from "../lib/drenaggio/dem";
import { analizzaIdrologia, bacino, ristagni, type Idrologia, type Ristagno } from "../lib/drenaggio/idrologia";
import {
  CLASSI_PENDENZA, LUCE_DEFAULT, PRESET_LUCE, coloreQuota, curveDiLivello, disegnaBase, disegnaMaschera,
  disegnaReticolo, disegnaRistagni, gradienti, intervalloColori, intervalloSuggerito, pendenze,
  type Luce, type Stile,
} from "../lib/drenaggio/resa";
import {
  csvProfilo, csvPunti, profilo, puntoQuotato, riepilogoProfilo, scaricaTesto, statisticheArea,
  type PuntoProfilo, type PuntoQuotato, type StatisticheArea,
} from "../lib/drenaggio/misure";
import { assicuraPane, cercaLuogo, stratoRaster, type StratoRaster } from "../lib/drenaggio/leaflet";

type Strumento = null | "profilo" | "area" | "punti" | "bacino";
type Livello = "raster" | "curve" | "ristagni" | "reticolo" | "bacino" | "disegni";

export type DrenaggioProps = {
  /** mappa Leaflet dell'app ospite (null finche' non e' pronta) */
  map: L.Map | null;
  /** true quando il pannello e' aperto: strati visibili e clic catturati */
  attivo: boolean;
  /** confine del campo/sito attivo, anello [lat, lon] (facoltativo) */
  campo?: [number, number][] | null;
  /** "campo": drenaggio di un appezzamento; "sito": valutazione di un sito (Helios) */
  contesto?: "campo" | "sito";
  /** traduzione delle stringhe italiane (default: identita') */
  t?: (s: string) => string;
  /** colore d'accento dei pulsanti */
  accento?: string;
};

const STILI: { k: Stile; nome: string }[] = [
  { k: "rilievo", nome: "Rilievo ombreggiato" },
  { k: "quote_rilievo", nome: "Quote a colori + rilievo" },
  { k: "quote", nome: "Quote a colori" },
  { k: "pendenze", nome: "Pendenze" },
  { k: "nessuno", nome: "Nessuna" },
];
const INTERVALLI = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20];
const NOMI_LIVELLI: Record<Livello, string> = {
  raster: "Resa del terreno", curve: "Curve di livello", ristagni: "Ristagni",
  reticolo: "Reticolo di scolo", bacino: "Bacino", disegni: "Profili, aree, punti",
};
const PASSI_HA = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];

function fmt(v: number | null | undefined, dec = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("it-IT", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export default function DrenaggioPanel({ map, attivo, campo, contesto = "campo", t = (s) => s, accento = "#0E7C7B" }: DrenaggioProps) {
  const sito = contesto === "sito";
  const gruppi = useRef<Record<"curve" | "disegni" | "bozza", L.LayerGroup> | null>(null);
  const raster = useRef<Record<"base" | "ristagni" | "reticolo" | "bacino", StratoRaster> | null>(null);
  const gRef = useRef<Griglia | null>(null);
  const idroRef = useRef<Idrologia | null>(null);
  const grRef = useRef<{ gx: Float32Array; gy: Float32Array } | null>(null);
  const pendRef = useRef<Float32Array | null>(null);
  const scalaRef = useRef<[number, number]>([0, 1]);
  const [versione, setVersione] = useState(0);

  const [occupato, setOccupato] = useState<string | null>(null);
  const [vaiA, setVaiA] = useState("");
  const [stile, setStile] = useState<Stile>(sito ? "pendenze" : "quote_rilievo");
  const [opacita, setOpacita] = useState(0.8);
  const [luce, setLuce] = useState<Luce>({ ...LUCE_DEFAULT });
  const [curveOn, setCurveOn] = useState(false);
  const [intervallo, setIntervallo] = useState(1);
  const [sogliaCm, setSogliaCm] = useState(sito ? 10 : 3);
  const sogliaRef = useRef(sogliaCm); sogliaRef.current = sogliaCm;
  const [sogliaHa, setSogliaHa] = useState(1);
  const [livelli, setLivelli] = useState<Record<Livello, boolean>>({
    raster: true, curve: true, ristagni: true, reticolo: true, bacino: true, disegni: true,
  });
  const [mostraLuce, setMostraLuce] = useState(false);
  const [aiuto, setAiuto] = useState(false);

  const [strumento, setStrumento] = useState<Strumento>(null);
  const strumentoRef = useRef<Strumento>(null);
  const bozzaRef = useRef<L.LatLng[]>([]);
  const [nBozza, setNBozza] = useState(0);
  const [prof, setProf] = useState<PuntoProfilo[] | null>(null);
  const [area, setArea] = useState<StatisticheArea | null>(null);
  const [punti, setPunti] = useState<PuntoQuotato[]>([]);
  const [infoBacino, setInfoBacino] = useState<{ areaM2: number } | null>(null);
  const [zone, setZone] = useState<Ristagno[]>([]);
  const [lettura, setLettura] = useState<{ z: number; p: number; a: number; r: number } | null>(null);
  const segnaProfilo = useRef<L.CircleMarker | null>(null);
  const [ctrlDiv, setCtrlDiv] = useState<{ lettura: HTMLElement; legenda: HTMLElement } | null>(null);
  const campoRef = useRef(campo); campoRef.current = campo;

  const g = gRef.current;

  // ---------------------------------------------------- aggancio alla mappa
  useEffect(() => {
    if (!map) return;
    assicuraPane(map, "dren-raster", 350);
    assicuraPane(map, "dren-acqua", 360);
    assicuraPane(map, "dren-curve", 370);
    gruppi.current = { curve: L.layerGroup(), disegni: L.layerGroup(), bozza: L.layerGroup() };
    // riquadri sulla mappa: lettura al cursore e legenda
    const mk = (pos: L.ControlPosition) => {
      const C = L.Control.extend({ onAdd: () => { const d = L.DomUtil.create("div"); L.DomEvent.disableClickPropagation(d); return d; } });
      const c = new C({ position: pos });
      return c;
    };
    const cR = mk("bottomright"), cL = mk("bottomright");
    cL.addTo(map); cR.addTo(map);
    setCtrlDiv({ lettura: cL.getContainer()!, legenda: cR.getContainer()! });
    return () => {
      try { cL.remove(); cR.remove(); } catch { /* mappa chiusa */ }
      if (raster.current) for (const s of Object.values(raster.current)) { try { map.removeLayer(s.layer); } catch { /* */ } }
      if (gruppi.current) for (const gg of Object.values(gruppi.current)) { try { map.removeLayer(gg); } catch { /* */ } }
      raster.current = null; gruppi.current = null; setCtrlDiv(null);
    };
  }, [map]);

  // clic, doppio clic e cursore: solo a pannello aperto. I clic si catturano
  // sul contenitore prima che arrivino agli strati dell'app (campi, pivot...).
  useEffect(() => {
    if (!map || !attivo) return;
    const el = map.getContainer();
    let giu: { x: number; y: number } | null = null;
    const down = (e: MouseEvent) => { giu = { x: e.clientX, y: e.clientY }; };
    const click = (e: MouseEvent) => {
      if (!strumentoRef.current) return;
      if ((e.target as HTMLElement)?.closest?.(".leaflet-control")) return;
      if (giu && Math.hypot(e.clientX - giu.x, e.clientY - giu.y) > 5) return;   // era un trascinamento
      e.stopPropagation(); e.preventDefault();
      clicMappa(map.mouseEventToLatLng(e));
    };
    const dbl = (e: MouseEvent) => {
      const s = strumentoRef.current;
      if (s === "profilo" || s === "area") { e.stopPropagation(); e.preventDefault(); concludi(); }
    };
    let rq = 0;
    const move = (e: L.LeafletMouseEvent) => {
      if (rq) return;
      rq = requestAnimationFrame(() => { rq = 0; leggi(e.latlng); });
    };
    const out = () => setLettura(null);
    el.addEventListener("mousedown", down, true);
    el.addEventListener("click", click, true);
    el.addEventListener("dblclick", dbl, true);
    map.on("mousemove", move);
    map.on("mouseout", out);
    return () => {
      el.removeEventListener("mousedown", down, true);
      el.removeEventListener("click", click, true);
      el.removeEventListener("dblclick", dbl, true);
      map.off("mousemove", move); map.off("mouseout", out);
      if (rq) cancelAnimationFrame(rq);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, attivo]);

  // chiudendo il pannello si chiude anche lo strumento in corso
  useEffect(() => { if (!attivo && strumentoRef.current) avvia(null); /* eslint-disable-line */ }, [attivo]);

  // --------------------------------------------------------------- analisi
  async function analizza(soloVista = false) {
    if (!map) return;
    let b = map.getBounds();
    const c = campoRef.current;
    if (!soloVista && c && c.length >= 3) {
      const cb = L.latLngBounds(c);
      const lato = Math.max(sito ? 3000 : 1500, cb.getNorthWest().distanceTo(cb.getSouthEast()) * 2);
      b = cb.getCenter().toBounds(lato);
    }
    try {
      setOccupato(t("Scarico il DEM pubblico…"));
      const griglia = await caricaDEM(
        { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
        { onAvanzamento: (a, n) => setOccupato(`${t("Scarico il DEM pubblico…")} ${a}/${n}`) },
      );
      setOccupato(t("Calcolo pendenze e deflussi…"));
      await new Promise((r) => setTimeout(r, 20));
      gRef.current = griglia;
      grRef.current = gradienti(griglia);
      pendRef.current = pendenze(grRef.current);
      scalaRef.current = intervalloColori(griglia.z);
      idroRef.current = analizzaIdrologia(griglia);
      setInfoBacino(null);
      const st = statisticheZ(griglia.z);
      setIntervallo(intervalloSuggerito(st.max - st.min));
      const haTot = (st.validi * griglia.cell * griglia.cell) / 10000;
      setSogliaHa(PASSI_HA.reduce((a, p) => (Math.abs(p - haTot * 0.03) < Math.abs(a - haTot * 0.03) ? p : a), PASSI_HA[0]));
      montaRaster(griglia);
      setVersione((v) => v + 1);
      if (!soloVista) map.fitBounds([[griglia.south, griglia.west], [griglia.north, griglia.east]], { padding: [20, 20], animate: false });
    } catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      alert(e?.message || t("Analisi non riuscita"));
    } finally { setOccupato(null); }
  }

  function montaRaster(gr: Griglia) {
    if (!map) return;
    if (raster.current) for (const s of Object.values(raster.current)) { try { map.removeLayer(s.layer); } catch { /* */ } }
    raster.current = {
      base: stratoRaster(gr, "dren-raster", opacita),
      ristagni: stratoRaster(gr, "dren-acqua", 1),
      reticolo: stratoRaster(gr, "dren-acqua", 1, true),
      bacino: stratoRaster(gr, "dren-acqua", 1, true),
    };
  }

  // ------------------------------------------------------------------ resa
  useEffect(() => {
    const gr = gRef.current, r = raster.current;
    if (!gr || !r || !grRef.current || !pendRef.current) return;
    const id = requestAnimationFrame(() => {
      disegnaBase(r.base.img, gr, stile, luce, grRef.current!, pendRef.current!, scalaRef.current);
      r.base.aggiorna();
    });
    return () => cancelAnimationFrame(id);
  }, [versione, stile, luce]);

  useEffect(() => { (raster.current?.base.layer as L.SVGOverlay | undefined)?.setOpacity(opacita); }, [opacita, versione]);

  useEffect(() => {
    const gr = gRef.current, r = raster.current, idro = idroRef.current;
    if (!gr || !r || !idro) return;
    const s = sogliaCm / 100;
    disegnaRistagni(r.ristagni.img, idro, s, Math.max(s + 0.05, 0.3));
    r.ristagni.aggiorna();
    setZone(ristagni(gr, idro, s).zone);
  }, [versione, sogliaCm]);

  useEffect(() => {
    const gr = gRef.current, r = raster.current, idro = idroRef.current;
    if (!gr || !r || !idro) return;
    disegnaReticolo(r.reticolo.img, gr, idro, sogliaHa * 10000);
    r.reticolo.aggiorna();
  }, [versione, sogliaHa]);

  useEffect(() => {
    const gc = gruppi.current?.curve, gr = gRef.current;
    if (!gc) return;
    gc.clearLayers();
    if (!curveOn || !gr) return;
    const cv = curveDiLivello(gr, intervallo);
    const rend = L.canvas({ pane: "dren-curve" });
    L.polyline(cv.ordinarie, { renderer: rend, color: "#4a2f0f", weight: 0.8, opacity: 0.8, interactive: false }).addTo(gc);
    L.polyline(cv.direttrici, { renderer: rend, color: "#2b1906", weight: 1.8, opacity: 0.95, interactive: false }).addTo(gc);
  }, [versione, curveOn, intervallo]);

  // visibilita': a pannello chiuso gli strati si tolgono (i dati restano)
  useEffect(() => {
    const r = raster.current, gg = gruppi.current;
    if (!map) return;
    const mostra = (l: L.Layer | undefined, on: boolean) => {
      if (!l) return;
      if (on && !map.hasLayer(l)) l.addTo(map);
      if (!on && map.hasLayer(l)) map.removeLayer(l);
    };
    mostra(r?.base.layer, attivo && livelli.raster);
    mostra(r?.ristagni.layer, attivo && livelli.ristagni);
    mostra(r?.reticolo.layer, attivo && livelli.reticolo);
    mostra(r?.bacino.layer, attivo && livelli.bacino);
    mostra(gg?.curve, attivo && livelli.curve);
    mostra(gg?.disegni, attivo && livelli.disegni);
    mostra(gg?.bozza, attivo);
  }, [map, attivo, livelli, versione]);

  // ------------------------------------------------------------- lettura
  function leggi(ll: L.LatLng) {
    const gr = gRef.current;
    if (!gr) return;
    const z = campiona(gr, gr.z, ll.lat, ll.lng);
    if (Number.isNaN(z)) { setLettura(null); return; }
    const { fx, fy } = cellaDi(gr, ll.lat, ll.lng);
    const k = Math.round(fy) * gr.nx + Math.round(fx);
    const idro = idroRef.current;
    setLettura({
      z, p: pendRef.current ? pendRef.current[k] : NaN,
      a: idro ? idro.accumulo[k] * gr.cell * gr.cell : NaN,
      r: idro ? idro.profondita[k] : NaN,
    });
  }

  // ----------------------------------------------------------- strumenti
  function avvia(s: Strumento) {
    bozzaRef.current = []; setNBozza(0); gruppi.current?.bozza.clearLayers();
    strumentoRef.current = s; setStrumento(s);
    if (map) {
      if (s === "profilo" || s === "area") map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
      map.getContainer().style.cursor = s ? "crosshair" : "";
    }
  }

  function disegnaBozza() {
    const gb = gruppi.current?.bozza;
    if (!gb) return;
    gb.clearLayers();
    const pts = bozzaRef.current;
    const col = strumentoRef.current === "area" ? "#0E7C7B" : "#E4772E";
    if (pts.length >= 2) {
      if (strumentoRef.current === "area") L.polygon(pts, { color: col, weight: 2, dashArray: "5 4", fillOpacity: 0.08, interactive: false }).addTo(gb);
      else L.polyline(pts, { color: col, weight: 2.5, dashArray: "5 4", interactive: false }).addTo(gb);
    }
    pts.forEach((p) => L.circleMarker(p, { radius: 4, color: col, fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(gb));
  }

  function clicMappa(ll: L.LatLng) {
    const s = strumentoRef.current, gr = gRef.current;
    if (!s) return;
    if (!gr) { alert(t("Prima analizza un'area.")); return; }
    if (s === "profilo" || s === "area") {
      const pts = bozzaRef.current, ult = pts[pts.length - 1];
      if (ult && map && map.latLngToContainerPoint(ult).distanceTo(map.latLngToContainerPoint(ll)) < 4) return;
      pts.push(ll); setNBozza(pts.length); disegnaBozza();
      return;
    }
    if (s === "punti") {
      setPunti((p) => {
        const q = puntoQuotato(gr, `P${p.length + 1}`, ll.lat, ll.lng, pendRef.current, idroRef.current);
        const m = L.circleMarker(ll, { radius: 5, color: "#1B3A5B", weight: 2, fillColor: "#fff", fillOpacity: 1, interactive: false });
        m.bindTooltip(`${q.nome} · ${fmt(q.z, 2)} m`, { permanent: true, direction: "right", offset: [6, 0] });
        gruppi.current?.disegni.addLayer(m);
        return [...p, q];
      });
      return;
    }
    if (s === "bacino") {
      const idro = idroRef.current, r = raster.current;
      if (!idro || !r) return;
      const { fx, fy } = cellaDi(gr, ll.lat, ll.lng);
      const b = bacino(gr, idro, Math.round(fx), Math.round(fy), Math.max(2, Math.min(25, Math.round(30 / gr.cell))));
      disegnaMaschera(r.bacino.img, gr, b.maschera);
      r.bacino.aggiorna();
      setInfoBacino({ areaM2: b.areaM2 });
    }
  }

  function concludi() {
    const s = strumentoRef.current, gr = gRef.current;
    const pts = bozzaRef.current.map((p) => [p.lat, p.lng] as [number, number]);
    if (!gr) return;
    if (s === "profilo") {
      if (pts.length < 2) return;
      setProf(profilo(gr, pts));
      gruppi.current?.disegni.addLayer(L.polyline(pts, { color: "#E4772E", weight: 3, interactive: false }));
    }
    if (s === "area") {
      if (pts.length < 3) return;
      setArea(statisticheArea(gr, pts, pendRef.current!, idroRef.current, sogliaRef.current / 100));
      gruppi.current?.disegni.addLayer(L.polygon(pts, { color: "#0E7C7B", weight: 2, fillOpacity: 0.1, interactive: false }));
    }
    avvia(null);
  }

  function pulisci() {
    gruppi.current?.disegni.clearLayers();
    setProf(null); setArea(null); setPunti([]); setInfoBacino(null);
    const r = raster.current;
    if (r) { r.bacino.img.data.fill(0); r.bacino.aggiorna(); }
  }

  async function vai() {
    if (!map) return;
    try {
      const r = await cercaLuogo(vaiA);
      if (!r) return alert(t("Luogo non trovato."));
      if (r.bbox) map.fitBounds([[r.bbox[0], r.bbox[2]], [r.bbox[1], r.bbox[3]]], { maxZoom: 16 });
      else map.setView([r.lat, r.lon], 16);
    } catch (e: any) { alert(e.message); } // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  function zoomRistagno(z: Ristagno) {
    const gr = gRef.current;
    if (!gr || !map) return;
    const [lat, lon] = latlngDi(gr, z.col, z.row);
    map.fitBounds(L.latLng(lat, lon).toBounds(Math.max(60, Math.sqrt(z.areaM2) * 3)), { maxZoom: 18 });
  }

  const st = useMemo(() => (g ? statisticheZ(g.z) : null), [versione]); // eslint-disable-line
  const tot = zone.reduce((s, z) => ({ a: s.a + z.areaM2, v: s.v + z.volumeM3 }), { a: 0, v: 0 });
  const rp = prof ? riepilogoProfilo(prof) : null;
  const btn = "px-2 py-1 rounded-md border border-gray-300 text-xs hover:bg-black/5 disabled:opacity-50";
  const btnPieno = "px-2 py-1 rounded-md text-xs text-white disabled:opacity-50";
  const box = "rounded-lg border border-gray-200 bg-white/70 p-2 text-[11px] text-gray-600 space-y-0.5";
  const tit = "text-[10px] font-semibold uppercase tracking-wide text-gray-500";

  return (
    <div className="space-y-3 text-xs text-gray-700">
      <p className="text-[11px] text-gray-500">
        {sito
          ? t("Pendenze, scolo dell'acqua e bacino a monte del sito, dal modello del terreno pubblico.")
          : t("Terreno e scolo dell'acqua sul campo: ristagni, linee di scolo e bacino a monte.")}
      </p>

      <div className="flex gap-1">
        <input className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-xs" placeholder={t("Vai a: luogo o coordinate")}
               value={vaiA} onChange={(e) => setVaiA(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") vai(); }} />
        <button className={btn} onClick={vai}>{t("Vai")}</button>
      </div>

      <div className="space-y-1.5">
        <div className="flex gap-1">
          <button className={btnPieno + " flex-1"} style={{ background: accento }} disabled={!!occupato || !map} onClick={() => analizza(false)}>
            {campo && campo.length >= 3 ? (sito ? t("Analizza il sito") : t("Analizza il campo")) : t("Analizza l'area visibile")}
          </button>
          {campo && campo.length >= 3 && (
            <button className={btn + " flex-1"} disabled={!!occupato || !map} onClick={() => analizza(true)}>{t("Area visibile")}</button>
          )}
        </div>
        {occupato && <p className="text-[11px]" style={{ color: accento }}>{occupato}</p>}
        {g && st && (
          <div className={box}>
            <div className="text-gray-800">{t(DESCRIZIONE_DEM)}</div>
            <div>{t("Cella")} <b>{fmt(g.cell, 1)} m</b> · {g.nx}×{g.ny} · {t("quote")} <b>{fmt(st.min, 1)}–{fmt(st.max, 1)} m</b></div>
          </div>
        )}
      </div>

      <div className="space-y-1">
        <div className={tit}>{t("Resa del terreno")}</div>
        <div className="flex flex-wrap gap-1">
          {STILI.map((s) => (
            <button key={s.k} className={stile === s.k ? btnPieno : btn} style={stile === s.k ? { background: accento } : undefined}
                    onClick={() => setStile(s.k)}>{t(s.nome)}</button>
          ))}
        </div>
        <label className="block">
          <div className="flex justify-between text-[11px] text-gray-500"><span>{t("Opacità")}</span><b>{Math.round(opacita * 100)} %</b></div>
          <input type="range" className="w-full" min={0.1} max={1} step={0.05} value={opacita} onChange={(e) => setOpacita(Number(e.target.value))} />
        </label>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 flex-1"><input type="checkbox" checked={curveOn} onChange={(e) => setCurveOn(e.target.checked)} /> {t("curve di livello")}</label>
          <select className="rounded-md border border-gray-300 px-1 py-0.5 text-xs" value={intervallo} onChange={(e) => setIntervallo(Number(e.target.value))}>
            {INTERVALLI.map((i) => <option key={i} value={i}>{String(i).replace(".", ",")} m</option>)}
          </select>
        </div>
        <button className="text-[11px]" style={{ color: accento }} onClick={() => setMostraLuce(!mostraLuce)}>{mostraLuce ? "▾" : "▸"} {t("Luce e ombre")}</button>
        {mostraLuce && (
          <div className="space-y-0.5">
            <Cursore nome={t("Direzione del sole")} val={luce.azimut} min={0} max={360} step={5} u="°" set={(v) => setLuce({ ...luce, azimut: v })} />
            <Cursore nome={t("Altezza del sole")} val={luce.altezza} min={5} max={85} step={1} u="°" set={(v) => setLuce({ ...luce, altezza: v })} />
            <Cursore nome={t("Intensità ombre")} val={luce.ombre} min={0} max={1} step={0.05} set={(v) => setLuce({ ...luce, ombre: v })} />
            <Cursore nome={t("Luminosità")} val={luce.luminosita} min={0.5} max={1.5} step={0.05} set={(v) => setLuce({ ...luce, luminosita: v })} />
            <Cursore nome={t("Esagerazione verticale")} val={luce.esagerazione} min={1} max={20} step={0.5} u="×" set={(v) => setLuce({ ...luce, esagerazione: v })} />
            <div className="flex flex-wrap gap-1 pt-1">
              {PRESET_LUCE.map((p) => <button key={p.nome} className={btn} onClick={() => setLuce({ ...p.luce })}>{t(p.nome)}</button>)}
              <button className={btn} onClick={() => setLuce({ ...LUCE_DEFAULT })}>{t("Reset")}</button>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1">
        <div className={tit}>{t("Scolo dell'acqua")}</div>
        <Cursore nome={t("Ristagni da")} val={sogliaCm} min={0.5} max={50} step={0.5} u=" cm" set={setSogliaCm} />
        <Cursore nome={t("Reticolo: area drenata da")} val={sogliaHa} min={0.01} max={100} step={0.01} u=" ha" set={setSogliaHa} />
        {g && (
          <div className={box}>
            <div><b>{zone.length}</b> {t("zone di ristagno")} · {fmt(tot.a / 10000, 2)} ha · <b>{fmt(tot.v, 0)} m³</b></div>
            {zone.slice(0, 6).map((z, i) => (
              <button key={z.id} className="block w-full text-left hover:text-gray-900" onClick={() => zoomRistagno(z)}>
                {i + 1}. {fmt(z.volumeM3, 0)} m³ · {fmt(z.areaM2 / 10000, 2)} ha · max {fmt(z.profMax * 100, 0)} cm
              </button>
            ))}
            <div className="text-amber-700 pt-0.5">{t("DEM a 25 m: indica le conche e le linee di scolo principali, non i ristagni di pochi centimetri.")}</div>
          </div>
        )}
      </div>

      <div className="space-y-1">
        <div className={tit}>{t("Strumenti")}</div>
        {!strumento ? (
          <div className="grid grid-cols-4 gap-1">
            <button className={btn} onClick={() => avvia("profilo")}>{t("Profilo")}</button>
            <button className={btn} onClick={() => avvia("area")}>{t("Area")}</button>
            <button className={btn} onClick={() => avvia("punti")}>{t("Punti")}</button>
            <button className={btn} onClick={() => avvia("bacino")}>{t("Bacino")}</button>
          </div>
        ) : (
          <div className={box}>
            <div>
              {strumento === "profilo" && `${t("Clicca i punti della linea, doppio clic per chiudere")} (${nBozza})`}
              {strumento === "area" && `${t("Clicca i vertici dell'area, doppio clic per chiudere")} (${nBozza})`}
              {strumento === "punti" && t("Clicca sulla mappa per aggiungere punti quotati")}
              {strumento === "bacino" && t("Clicca il punto di uscita: si colora tutta la superficie che scola lì")}
            </div>
            <div className="flex gap-1 pt-1">
              {(strumento === "profilo" || strumento === "area") && (
                <button className={btnPieno + " flex-1"} style={{ background: accento }} onClick={concludi}>{t("Fine")}</button>
              )}
              <button className={btn + " flex-1"} onClick={() => avvia(null)}>{t("Chiudi")}</button>
            </div>
          </div>
        )}
        {(prof || area || punti.length > 0 || infoBacino) && <button className={btn + " w-full"} onClick={pulisci}>{t("Cancella profili, aree, punti e bacino")}</button>}
      </div>

      {prof && rp && (
        <div className={box}>
          <div className="flex justify-between"><b className="text-gray-800">{t("Profilo altimetrico")}</b>
            <button style={{ color: accento }} onClick={() => scaricaTesto("profilo.csv", csvProfilo(prof))}>CSV</button></div>
          <GraficoProfilo punti={prof} onPunto={(p) => {
            if (!map) return;
            if (!p) { segnaProfilo.current?.remove(); segnaProfilo.current = null; return; }
            if (!segnaProfilo.current) segnaProfilo.current = L.circleMarker([p.lat, p.lon], { radius: 6, color: "#E4772E", fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(map);
            else segnaProfilo.current.setLatLng([p.lat, p.lon]);
          }} />
          <div>{t("Lunghezza")} <b>{fmt(rp.lunghezza, 0)} m</b> · {t("pendenza media")} <b>{fmt(rp.pendenzaMedia, 2)} %</b></div>
          <div>{t("Quote")} <b>{fmt(rp.min, 1)}–{fmt(rp.max, 1)} m</b> · {t("salita/discesa")} <b>{fmt(rp.salita, 1)}/{fmt(rp.discesa, 1)} m</b></div>
        </div>
      )}
      {area && (
        <div className={box}>
          <b className="text-gray-800">{t("Area disegnata")}</b>
          <div>{t("Superficie")} <b>{fmt(area.areaM2 / 10000, 2)} ha</b> · {t("quote")} <b>{fmt(area.zMin, 1)}–{fmt(area.zMax, 1)} m</b></div>
          <div>{t("Pendenza media")} <b>{fmt(area.pendenzaMedia, 2)} %</b> · {t("piatto (<0,1 %)")} <b>{fmt(area.piattoPct, 0)} %</b></div>
          <div>{t("Ristagni")} <b>{fmt(area.ristagnoAreaM2 / 10000, 2)} ha · {fmt(area.ristagnoVolumeM3, 0)} m³</b></div>
        </div>
      )}
      {infoBacino && (
        <div className={box}><b className="text-gray-800">{t("Bacino")}</b> — {t("superficie che scola nel punto")}: <b>{fmt(infoBacino.areaM2 / 10000, 2)} ha</b></div>
      )}
      {punti.length > 0 && (
        <div className={box}>
          <div className="flex justify-between"><b className="text-gray-800">{t("Punti quotati")}</b>
            <button style={{ color: accento }} onClick={() => scaricaTesto("punti_drenaggio.csv", csvPunti(punti))}>{t("Salva CSV")}</button></div>
          {punti.map((p) => <div key={p.nome}>{p.nome}: <b>{fmt(p.z, 2)} m</b> · {fmt(p.pendenza, 2)} % · {t("drena")} {fmt(p.areaDrenataM2 / 10000, 2)} ha</div>)}
        </div>
      )}

      <div className="space-y-0.5">
        <div className={tit}>{t("Livelli")}</div>
        <div className="grid grid-cols-2 gap-x-2">
          {(Object.keys(NOMI_LIVELLI) as Livello[]).map((k) => (
            <label key={k} className="flex items-center gap-1.5">
              <input type="checkbox" checked={livelli[k]} onChange={() => setLivelli((s) => ({ ...s, [k]: !s[k] }))} /> {t(NOMI_LIVELLI[k])}
            </label>
          ))}
        </div>
      </div>

      <div>
        <button className="text-[11px]" style={{ color: accento }} onClick={() => setAiuto(!aiuto)}>{aiuto ? "▾" : "▸"} {t("Aiuto e fonti dei dati")}</button>
        {aiuto && (
          <div className="text-[11px] text-gray-500 space-y-1 mt-1">
            <p>{t("Quote: AWS Terrain Tiles — EU-DEM 25 m (Copernicus) in Europa, SRTM 30 m altrove — scaricate dal browser e ricampionate sulla griglia.")}</p>
            <p>{t("Ristagni: le conche vengono riempite fino alla quota di sfioro (Priority-Flood); la differenza col terreno è l'acqua che resta ferma.")}</p>
            <p>{t("Reticolo e bacino: ogni cella scola verso la vicina più bassa fra le 8 (D8). Il reticolo mostra dove si concentra l'acqua di almeno la superficie indicata; «Bacino» colora tutta l'area che scola nel punto cliccato.")}</p>
            <p>{t("Pendenze: sotto 0,1 % l'acqua non si muove; sopra il 5 % servono attenzioni contro l'erosione.")}</p>
          </div>
        )}
      </div>

      {/* riquadri sulla mappa */}
      {ctrlDiv && attivo && createPortal(
        <div className="bg-white/95 border border-gray-200 rounded-lg px-2.5 py-1.5 text-[11px] text-gray-600 shadow min-w-[170px]">
          {g ? (lettura ? (
            <div>
              <div>{t("Quota")} <b className="font-mono text-gray-900">{fmt(lettura.z, 2)} m</b></div>
              <div>{t("Pendenza")} <b className="font-mono text-gray-900">{fmt(lettura.p, 2)} %</b></div>
              <div>{t("Area drenata")} <b className="font-mono text-gray-900">{lettura.a >= 10000 ? `${fmt(lettura.a / 10000, 2)} ha` : `${fmt(lettura.a, 0)} m²`}</b></div>
              {lettura.r > 0.01 && <div>{t("Ristagno")} <b className="font-mono text-gray-900">{fmt(lettura.r * 100, 0)} cm</b></div>}
            </div>
          ) : t("Passa sulla mappa per leggere quota e pendenza")) : t("Drenaggio: analizza un'area")}
        </div>, ctrlDiv.lettura)}
      {ctrlDiv && attivo && g && livelli.raster && (stile === "pendenze" || stile === "quote" || stile === "quote_rilievo") && createPortal(
        <div className="bg-white/95 border border-gray-200 rounded-lg px-2.5 py-1.5 text-[11px] text-gray-600 shadow">
          {stile === "pendenze" ? CLASSI_PENDENZA.map((c) => (
            <div key={c.nome} className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm" style={{ background: `rgb(${c.rgb.join(",")})` }} />{t(c.nome)}
            </div>
          )) : (
            <div>
              <div className="h-2.5 w-36 rounded" style={{ background: `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map((x) => `rgb(${coloreQuota(x).map(Math.round).join(",")})`).join(",")})` }} />
              <div className="flex justify-between font-mono"><span>{fmt(scalaRef.current[0], 1)}</span><span>{fmt(scalaRef.current[1], 1)} m</span></div>
            </div>
          )}
        </div>, ctrlDiv.legenda)}
    </div>
  );
}

function Cursore({ nome, val, min, max, step, u = "", set }: { nome: string; val: number; min: number; max: number; step: number; u?: string; set: (v: number) => void }) {
  return (
    <label className="block">
      <div className="flex justify-between text-[11px] text-gray-500"><span>{nome}</span><b className="font-mono text-gray-800">{String(Number(val.toFixed(2))).replace(".", ",")}{u}</b></div>
      <input type="range" className="w-full" min={min} max={max} step={step} value={val} onChange={(e) => set(Number(e.target.value))} />
    </label>
  );
}

function GraficoProfilo({ punti, onPunto }: { punti: PuntoProfilo[]; onPunto: (p: PuntoProfilo | null) => void }) {
  const [hov, setHov] = useState<PuntoProfilo | null>(null);
  const W = 300, H = 120, ml = 36, mb = 16, mt = 6, mr = 6;
  const v = punti.filter((p) => !Number.isNaN(p.z));
  if (v.length < 2) return <div>—</div>;
  const Lt = punti[punti.length - 1].d;
  let zmin = Math.min(...v.map((p) => p.z)), zmax = Math.max(...v.map((p) => p.z));
  if (zmax - zmin < 0.1) { zmin -= 0.05; zmax += 0.05; }
  const X = (d: number) => ml + (d / Lt) * (W - ml - mr);
  const Y = (z: number) => mt + (1 - (z - zmin) / (zmax - zmin)) * (H - mt - mb);
  const path = v.map((p, i) => `${i ? "L" : "M"}${X(p.d).toFixed(1)},${Y(p.z).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full bg-gray-50 rounded"
         onMouseLeave={() => { setHov(null); onPunto(null); }}
         onMouseMove={(e) => {
           const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
           const d = ((((e.clientX - r.left) / r.width) * W - ml) / (W - ml - mr)) * Lt;
           let best = v[0];
           for (const p of v) if (Math.abs(p.d - d) < Math.abs(best.d - d)) best = p;
           setHov(best); onPunto(best);
         }}>
      <path d={`${path}L${X(v[v.length - 1].d)},${H - mb}L${X(v[0].d)},${H - mb}Z`} fill="#0E7C7B22" />
      <path d={path} fill="none" stroke="#0E7C7B" strokeWidth={1.5} />
      <line x1={ml} x2={ml} y1={mt} y2={H - mb} stroke="#9aa" strokeWidth={0.5} />
      <line x1={ml} x2={W - mr} y1={H - mb} y2={H - mb} stroke="#9aa" strokeWidth={0.5} />
      <text x={ml - 3} y={mt + 8} fontSize={8} textAnchor="end" fill="#667">{zmax.toFixed(1)}</text>
      <text x={ml - 3} y={H - mb} fontSize={8} textAnchor="end" fill="#667">{zmin.toFixed(1)}</text>
      <text x={W - mr} y={H - 4} fontSize={8} textAnchor="end" fill="#667">{Lt.toFixed(0)} m</text>
      {hov && (
        <g>
          <line x1={X(hov.d)} x2={X(hov.d)} y1={mt} y2={H - mb} stroke="#E4772E" strokeWidth={0.8} />
          <circle cx={X(hov.d)} cy={Y(hov.z)} r={2.5} fill="#E4772E" />
          <text x={Math.min(X(hov.d) + 4, W - 70)} y={mt + 10} fontSize={9} fill="#1B3A5B">{hov.d.toFixed(0)} m · {hov.z.toFixed(2)} m</text>
        </g>
      )}
    </svg>
  );
}
