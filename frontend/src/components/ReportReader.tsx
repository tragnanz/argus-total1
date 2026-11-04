"use client";
// Relazione tecnica interattiva nel link di sola lettura: indice, capitoli, tabelle,
// grafici con i valori al passaggio del mouse e figure su mappa. Stessi contenuti del PDF.
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "@/lib/api";
import { useI18n, LANGS, RTL_LANGS, type Lang } from "@/lib/i18n";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const PAL = ["#009FE3", "#009640", "#F59E0B", "#E11D48", "#001A33", "#8B5CF6"];

function Chart({ spec }: { spec: Any }) {
  const [hov, setHov] = useState<number | null>(null);
  const x: string[] = spec.x ?? [];
  const bars: Any[] = spec.bars ?? [], lines: Any[] = spec.lines ?? [];
  const W = 720, H = 300, L = 46, R = lines.some((l) => l.axis === "y2") ? 46 : 14, T = 14, B = 34;
  const vals1 = [...bars.flatMap((b) => b.values ?? []), ...lines.filter((l) => l.axis !== "y2").flatMap((l) => l.values ?? [])].filter((v) => Number.isFinite(v));
  const vals2 = lines.filter((l) => l.axis === "y2").flatMap((l) => l.values ?? []).filter((v: number) => Number.isFinite(v));
  const max1 = Math.max(1e-9, ...vals1, 0), min1 = Math.min(0, ...vals1);
  const max2 = vals2.length ? Math.max(...vals2) : 1, min2 = vals2.length ? Math.min(0, ...vals2) : 0;
  const n = Math.max(1, x.length), cw = (W - L - R) / n;
  const y1 = (v: number) => T + (H - T - B) * (1 - (v - min1) / (max1 - min1 || 1));
  const y2 = (v: number) => T + (H - T - B) * (1 - (v - min2) / (max2 - min2 || 1));
  const bw = (cw * 0.8) / Math.max(1, bars.length);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min1 + (max1 - min1) * f);
  const fmtN = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toLocaleString());
  return (
    <div className="rr-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" onMouseLeave={() => setHov(null)}>
        {ticks.map((v, i) => <g key={i}><line x1={L} x2={W - R} y1={y1(v)} y2={y1(v)} stroke="#E5E8EE" /><text x={L - 6} y={y1(v) + 4} fontSize="11" textAnchor="end" fill="#5C636A">{fmtN(v)}</text></g>)}
        {spec.y && <text x={6} y={T + 4} fontSize="11" fill="#5C636A">{spec.y}</text>}
        {spec.y2 && <text x={W - 6} y={T + 4} fontSize="11" fill="#5C636A" textAnchor="end">{spec.y2}</text>}
        {x.map((lab, i) => (
          <g key={i} onMouseEnter={() => setHov(i)}>
            <rect x={L + i * cw} y={T} width={cw} height={H - T - B} fill={hov === i ? "#F0F4FA" : "transparent"} />
            {bars.map((b, k) => { const v = b.values?.[i] ?? 0; const yy = y1(Math.max(0, v)), h = Math.abs(y1(v) - y1(0));
              return <rect key={k} x={L + i * cw + cw * 0.1 + k * bw} y={yy} width={bw * 0.92} height={h} rx={2} fill={b.color ?? PAL[k % PAL.length]} opacity={0.88} />; })}
            <text x={L + i * cw + cw / 2} y={H - B + 16} fontSize="11" textAnchor="middle" fill="#5C636A">{lab}</text>
          </g>
        ))}
        {lines.map((ln, k) => {
          const yf = ln.axis === "y2" ? y2 : y1, col = ln.color ?? PAL[(bars.length + k) % PAL.length];
          const pts = (ln.values ?? []).map((v: number, i: number) => `${L + i * cw + cw / 2},${yf(v)}`).join(" ");
          return <g key={k}><polyline points={pts} fill="none" stroke={col} strokeWidth={2.4} strokeDasharray={ln.dash ? "6 4" : undefined} />
            {(ln.values ?? []).map((v: number, i: number) => <circle key={i} cx={L + i * cw + cw / 2} cy={yf(v)} r={hov === i ? 4.5 : 3} fill={col} />)}</g>;
        })}
      </svg>
      <div className="rr-legend">
        {[...bars.map((b, k) => ({ n: b.name, c: b.color ?? PAL[k % PAL.length] })), ...lines.map((l, k) => ({ n: l.name, c: l.color ?? PAL[(bars.length + k) % PAL.length] }))].map((e, i) =>
          <span key={i}><i style={{ background: e.c }} />{e.n}</span>)}
      </div>
      {hov != null && (
        <div className="rr-tip"><b>{x[hov]}</b>
          {bars.map((b, k) => <span key={"b" + k}> · {b.name}: {fmtN(b.values?.[hov] ?? 0)}</span>)}
          {lines.map((l, k) => <span key={"l" + k}> · {l.name}: {fmtN(l.values?.[hov] ?? 0)}</span>)}</div>
      )}
    </div>
  );
}

const STY: Record<string, { color: string; weight?: number; fill?: string; dash?: string }> = {
  campo: { color: "#FFED00", weight: 2, fill: "transparent" }, impianto: { color: "#009640", weight: 1.5, fill: "#009640" },
  tubazione: { color: "#009FE3", weight: 2.5 }, cavo: { color: "#F59E0B", weight: 1.5, dash: "4 3" }, strada: { color: "#BEC7D2", weight: 3 },
  fotovoltaico: { color: "#001A33", weight: 1, fill: "#1e3a8a" }, tara: { color: "#E11D48", weight: 1, dash: "4 3", fill: "transparent" },
  attrezzatura: { color: "#E11D48", weight: 2, fill: "#E11D48" },
};
function FigureMap({ fc }: { fc: Any }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let map: Any = null; let dead = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (dead || !ref.current) return;
      map = L.map(ref.current, { scrollWheelZoom: false, attributionControl: true });
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imagery © Esri" }).addTo(map);
      const g = L.geoJSON(fc, {
        style: (f: Any) => { const s = STY[f?.properties?.tipo] ?? { color: "#ffffff", weight: 1.5 }; return { color: s.color, weight: s.weight ?? 1.5, dashArray: s.dash, fillColor: s.fill ?? s.color, fillOpacity: s.fill && s.fill !== "transparent" ? 0.25 : 0 }; },
        pointToLayer: (_f: Any, ll: Any) => L.circleMarker(ll, { radius: 6, color: "#fff", weight: 2, fillColor: "#E11D48", fillOpacity: 1 }),
        onEachFeature: (f: Any, ly: Any) => {
          const p = f?.properties ?? {};
          const lab = [p.nome ?? p.impianto ?? p.tipo, p.portata_ls ? `${p.portata_ls} l/s` : "", p.DN ? `DN ${p.DN}` : "", p.raggio_m ? `R ${p.raggio_m} m` : "", p.kwp ? `${p.kwp} kWp` : ""].filter(Boolean).join(" · ");
          if (lab) ly.bindTooltip(lab, { sticky: true });
        },
      }).addTo(map);
      try { map.fitBounds(g.getBounds(), { padding: [16, 16] }); } catch { map.setView([0, 0], 2); }
    })();
    return () => { dead = true; try { map?.remove(); } catch { /* */ } };
  }, [fc]);
  return <div ref={ref} className="rr-map" />;
}

export default function ReportReader({ token, info, onClose }: { token: string; info: { langs: string[]; default_lang: string }; onClose: () => void }) {
  const { t, lang, setLang } = useI18n();
  const want = info.langs.includes(lang) ? lang : info.default_lang;
  const [rep, setRep] = useState<api.ShareReport | null>(null);
  const [err, setErr] = useState("");
  const [active, setActive] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  const body = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setRep(null); setErr(""); api.fetchShareReport(token, want).then(setRep).catch((e) => setErr(String(e?.message ?? e))); }, [token, want]);
  const doc = rep?.doc ?? {};
  const chapters: Any[] = useMemo(() => doc.chapters ?? [], [doc]);
  const rtl = RTL_LANGS.includes((rep?.lang ?? want) as Lang);
  useEffect(() => {
    const el = body.current; if (!el) return;
    const onScroll = () => {
      const hs = Array.from(el.querySelectorAll("[data-ch]")) as HTMLElement[];
      let k = 0; for (const h of hs) if (h.offsetTop - el.scrollTop < 120) k = Number(h.dataset.ch);
      setActive(k);
    };
    el.addEventListener("scroll", onScroll); return () => el.removeEventListener("scroll", onScroll);
  }, [rep]);
  const go = (i: number) => { const el = body.current?.querySelector(`[data-ch="${i}"]`) as HTMLElement | null; if (el && body.current) body.current.scrollTo({ top: el.offsetTop - 12, behavior: "smooth" }); setTocOpen(false); };
  let fig = 0;
  const block = (b: Any, i: number) => {
    if (b.p != null) return <p key={i} className="rr-p">{String(b.p)}</p>;
    if (b.h != null) return <h3 key={i} className="rr-h">{String(b.h)}</h3>;
    if (b.bullets || b.numbered) { const it: string[] = b.bullets ?? b.numbered; return b.numbered ? <ol key={i} className="rr-ol">{it.map((x, k) => <li key={k}>{x}</li>)}</ol> : <ul key={i} className="rr-ul">{it.map((x, k) => <li key={k}>{x}</li>)}</ul>; }
    if (b.table) {
      const tb = b.table;
      return (<figure key={i} className="rr-tab">
        {b.caption && <figcaption>{b.caption}</figcaption>}
        <div className="rr-tabwrap"><table><thead><tr>{(tb.header ?? []).map((h: string, k: number) => <th key={k}>{h}</th>)}</tr></thead>
          <tbody>{(tb.rows ?? []).map((r: string[], k: number) => <tr key={k}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>
      </figure>);
    }
    if (b.chart) { fig++; return <figure key={i} className="rr-fig"><Chart spec={b.chart} /><figcaption>{doc.figure_label ?? t("Figura")} {fig} – {b.caption ?? ""}</figcaption></figure>; }
    if (b.figure) {
      const fc = b.figure === "site" ? doc.site : doc.plan;
      if (!fc?.features?.length) return null;
      fig++;
      return <figure key={i} className="rr-fig"><FigureMap fc={{ type: "FeatureCollection", features: fc.features }} /><figcaption>{doc.figure_label ?? t("Figura")} {fig} – {b.caption ?? ""}</figcaption></figure>;
    }
    return null;
  };
  const logo = doc.brand === "nabu" ? "/nabu-logo-color.png" : "/agrostar-logo.png";
  return (
    <div className="rr-root" dir={rtl ? "rtl" : "ltr"} data-report-reader>
      <header className="rr-head">
        <img src={logo} alt="" className="rr-logo" />
        <div className="min-w-0 flex-1">
          <div className="rr-kicker">{doc.revision ?? ""}{doc.date ? ` · ${doc.date}` : ""}</div>
          <div className="rr-title">{doc.title ?? t("Relazione tecnica")}{doc.client ? ` – ${doc.client}` : ""}</div>
        </div>
        <select className="rr-btn" value={rep?.lang ?? want} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t("Lingua")}>
          {info.langs.map((c) => <option key={c} value={c}>{LANGS.find((l) => l.code === c)?.label ?? c}</option>)}
        </select>
        <a className="rr-btn rr-primary" href={api.shareReportPdfUrl(token, rep?.lang ?? want)} target="_blank" rel="noreferrer">{t("Scarica il PDF")}</a>
        <button className="rr-btn" onClick={onClose}>{t("Torna alla mappa")}</button>
      </header>
      {!info.langs.includes(lang) && <div className="rr-note">{t("La relazione non è disponibile in questa lingua: è mostrata in {l}.", { l: LANGS.find((l) => l.code === want)?.label ?? want })}</div>}
      <div className="rr-main">
        <nav className={"rr-toc" + (tocOpen ? " open" : "")}>
          <button className="rr-tocbtn" onClick={() => setTocOpen((o) => !o)}>☰ {doc.toc_title ?? t("Indice")}</button>
          <ol>{chapters.map((c, i) => <li key={i} className={active === i ? "on" : ""}><button onClick={() => go(i)}><span>{i + 1}</span>{c.title}</button></li>)}</ol>
        </nav>
        <div className="rr-body" ref={body}>
          {err && <p className="rr-p" style={{ color: "#BA1A1A" }}>{err}</p>}
          {!rep && !err && <p className="rr-p">…</p>}
          {rep && (doc.cover_title ? <div className="rr-cover"><div className="rr-kicker">{doc.title}</div><h1>{String(doc.cover_title).split("\n").map((l: string, k: number) => <span key={k}>{l}<br /></span>)}</h1>
            {doc.recipient?.length ? <div className="rr-rec">{doc.recipient_label} {doc.recipient.join(", ")}</div> : null}</div> : null)}
          {rep && chapters.map((c, i) => (
            <section key={i} className="rr-ch" data-ch={i}>
              <h2><span>{doc.chapter_label ?? ""} {i + 1}</span>{c.title}</h2>
              {(c.blocks ?? []).map(block)}
            </section>
          ))}
          {rep && <div className="rr-foot">Argus Total · {doc.header ?? ""}</div>}
        </div>
      </div>
    </div>
  );
}
