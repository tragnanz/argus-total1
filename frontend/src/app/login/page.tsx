"use client";
// Pagina di accesso ad Argus Total. La PRIMA registrazione crea l'owner
// (super-admin); dopo, l'accesso è solo via login (utenti creati dall'admin).
import { useState } from "react";
import { useRouter } from "next/navigation";
import * as api from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export default function LoginPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [org, setOrg] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const r = mode === "register"
        ? await api.authRegister(email.trim(), password, org.trim() || "La mia organizzazione")
        : await api.authLogin(email.trim(), password);
      api.setToken(r.access_token);
      router.replace("/");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4" style={{ background: "#0f2a1c" }}>
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-6">
        <div className="flex items-center gap-2 mb-5">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold" style={{ background: "#123524" }}>A</div>
          <div>
            <div className="font-semibold text-brand-darker leading-tight">Argus Total</div>
            <div className="text-[11px] text-sage-dark">by Nabu srl — Agrostar Group</div>
          </div>
        </div>

        <h1 className="text-lg font-semibold text-brand-darker mb-3">
          {mode === "register" ? t("Crea l'organizzazione") : t("Accedi")}
        </h1>

        <form onSubmit={submit} className="space-y-3">
          {mode === "register" && (
            <div>
              <label className="text-xs text-sage-dark">{t("Nome organizzazione")}</label>
              <input className="field-input mt-1" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Nabu" />
            </div>
          )}
          <div>
            <label className="text-xs text-sage-dark">{t("Email")}</label>
            <input type="email" required autoComplete="username" className="field-input mt-1"
              value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nome@azienda.it" />
          </div>
          <div>
            <label className="text-xs text-sage-dark">{t("Password")}</label>
            <input type="password" required autoComplete={mode === "register" ? "new-password" : "current-password"}
              className="field-input mt-1" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </div>

          {err && <p className="text-sm text-danger">{err}</p>}

          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy ? "…" : mode === "register" ? t("Crea e accedi") : t("Accedi")}
          </button>
        </form>

        <div className="mt-4 flex items-center justify-between text-[12px]">
          <button type="button" className="text-brand hover:underline"
            onClick={() => { setErr(""); setMode(mode === "login" ? "register" : "login"); }}>
            {mode === "login" ? t("Prima volta? Crea l'organizzazione") : t("Hai già un accesso? Accedi")}
          </button>
          {mode === "login" && (
            <button type="button" className="text-sage-dark hover:underline" onClick={() => setErr(t("Contatta l'amministratore per reimpostare la password."))}>
              {t("Password dimenticata?")}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
