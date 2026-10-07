"use client";

import { setLang, useLang } from "@/lib/i18n";

/** FR / EN switch in the header. */
export function LangToggle() {
  const lang = useLang();
  const next = lang === "fr" ? "en" : "fr";
  return (
    <button
      type="button"
      onClick={() => setLang(next)}
      className="rounded-full px-3 py-1.5 text-[13px] font-semibold text-text-2 transition-colors hover:bg-fill hover:text-text"
      aria-label={lang === "fr" ? "Switch to English" : "Passer en français"}
      title={lang === "fr" ? "English" : "Français"}
    >
      {next.toUpperCase()}
    </button>
  );
}
