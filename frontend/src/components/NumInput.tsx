"use client";
// Casella numerica: separatore delle migliaia mentre si scrive (nel formato della lingua dell'interfaccia)
// e testo libero durante la modifica. Il valore si può cancellare e riscrivere: i limiti (min, clamp nei
// gestori) agiscono sul valore salvato, ma la casella mostra quello che si sta scrivendo finché non si esce.
// Stessa interfaccia di <input type="number">: onChange/onBlur ricevono e.target.value come numero in
// formato JS ("1234.5"), o "" se la casella è vuota.
import { useMemo, useRef, useState, type InputHTMLAttributes, type ChangeEvent, type FocusEvent, type KeyboardEvent } from "react";
import { useI18n } from "@/lib/i18n";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue"> & {
  type?: "number";
  value?: number | string | null;
  defaultValue?: number | string | null;
};

function seps(locale: string) {
  try {
    const parts = new Intl.NumberFormat(locale, { useGrouping: "always" } as Intl.NumberFormatOptions).formatToParts(1234567.5);
    return { g: parts.find((p) => p.type === "group")?.value ?? ",", d: parts.find((p) => p.type === "decimal")?.value ?? "." };
  } catch { return { g: ",", d: "." }; }
}

const DIG = /[0-9]/;

export default function NumInput({ value, defaultValue, onChange, onBlur, onFocus, onKeyDown, min, max, step, ...rest }: Props) {
  const { locale } = useI18n();
  const { g, d } = useMemo(() => seps(locale), [locale]);
  const [draft, setDraft] = useState<string | null>(null);          // testo mentre si scrive
  const [own, setOwn] = useState<string>(defaultValue == null ? "" : String(defaultValue));   // caselle non controllate
  const ref = useRef<HTMLInputElement>(null);
  const controlled = value !== undefined;
  const cur = controlled ? (value == null ? "" : String(value)) : own;

  // "1234.5" → "1.234,5" (it) / "1,234.5" (en); la parte decimale resta com'è scritta
  const show = (js: string) => {
    if (js === "" || js === "-") return js;
    const neg = js.startsWith("-"), body = neg ? js.slice(1) : js;
    const [ip, fp] = body.split(".");
    const ig = (ip || "").replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, g);
    return (neg ? "-" : "") + ig + (fp !== undefined ? d + fp : "");
  };
  // testo dell'utente → numero in formato JS (senza separatori delle migliaia)
  const parse = (txt: string) => {
    let s = txt.replace(/[\s  ]/g, "");
    if (g !== d) s = s.split(g).join("");
    if (d !== ".") s = s.replace(d, ".");
    // il punto del tastierino in lingue con la virgola decimale: un solo "." come decimale se non c'è altro
    s = s.replace(/[^0-9.\-]/g, "");
    const neg = s.startsWith("-"); s = s.replace(/-/g, "");
    const i = s.indexOf(".");
    if (i >= 0) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, "");
    return (neg ? "-" : "") + s;
  };
  const num = (js: number) => {
    const p = typeof step === "number" || typeof step === "string" ? String(step) : "";
    const dec = p.includes(".") ? p.split(".")[1].length : 0;
    return String(Number(js.toFixed(Math.max(dec, 6))));
  };
  const emit = (js: string, kind: "change" | "blur", e: ChangeEvent<HTMLInputElement> | FocusEvent<HTMLInputElement>) => {
    // e.target con value già convertito (defineProperty: l'assegnazione passerebbe dal setter del DOM)
    const target = Object.create(e.target, {
      value: { value: js, enumerable: true },
      valueAsNumber: { value: js === "" ? NaN : Number(js), enumerable: true },
    });
    const ev = { ...e, target, currentTarget: target };
    if (kind === "change") onChange?.(ev as ChangeEvent<HTMLInputElement>);
    else onBlur?.(ev as FocusEvent<HTMLInputElement>);
  };

  const handle = (e: ChangeEvent<HTMLInputElement>) => {
    const el = e.target, raw = el.value, caret = el.selectionStart ?? raw.length;
    // quanti caratteri "utili" (cifre, decimale, segno) ci sono prima del cursore
    const before = parse(raw.slice(0, caret)).length;
    const js = parse(raw);
    const txt = show(js);
    setDraft(txt);
    if (!controlled) setOwn(js);
    // rimette il cursore dopo lo stesso numero di caratteri utili
    requestAnimationFrame(() => {
      const inp = ref.current; if (!inp) return;
      let n = 0, pos = 0;
      while (pos < txt.length && n < before) { if (DIG.test(txt[pos]) || txt[pos] === d || txt[pos] === "-") n++; pos++; }
      try { inp.setSelectionRange(pos, pos); } catch { /* */ }
    });
    if (js === "" || (js !== "-" && Number.isFinite(Number(js)))) emit(js === "" ? "" : num(Number(js)), "change", e);
  };

  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const st = Number(step) > 0 ? Number(step) : 1;
    let v = (Number(parse(draft ?? show(cur))) || 0) + (e.key === "ArrowUp" ? st : -st);
    if (min !== undefined && min !== "" && v < Number(min)) v = Number(min);
    if (max !== undefined && max !== "" && v > Number(max)) v = Number(max);
    const js = num(v);
    setDraft(show(js));
    if (!controlled) setOwn(js);
    emit(js, "change", e as unknown as ChangeEvent<HTMLInputElement>);
  };

  return (
    <input
      {...rest}
      ref={ref}
      type="text"
      inputMode={step !== undefined && Number(step) % 1 === 0 && !(min !== undefined && Number(min) < 0) ? "numeric" : "decimal"}
      value={draft ?? show(cur)}
      onFocus={(e) => { setDraft(show(cur)); onFocus?.(e); }}
      onChange={handle}
      onKeyDown={key}
      onBlur={(e) => { const js = parse(draft ?? show(cur)); setDraft(null); emit(js === "-" ? "" : js, "blur", e); }}
    />
  );
}
