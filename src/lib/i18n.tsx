"use client";

import { useSyncExternalStore, type ReactNode } from "react";

/**
 * Two languages, chosen before the first paint by an inline script in the layout (saved choice,
 * else the browser's language) and stored on <html data-lang>. Static text renders both versions
 * and CSS hides the other one (no flash); client components read the language with useLang().
 */
export type Lang = "en" | "fr";
export const LANG_KEY = "lostfunds:lang";

/** Runs in <head> before the page paints. Kept tiny and dependency-free. */
export const LANG_SCRIPT = `(function(){var l;try{l=localStorage.getItem("${LANG_KEY}")}catch(e){}if(l!=="fr"&&l!=="en"){var n=((navigator.languages&&navigator.languages[0])||navigator.language||"en").toLowerCase();l=n.indexOf("fr")===0?"fr":"en"}document.documentElement.setAttribute("data-lang",l);document.documentElement.lang=l})()`;

const listeners = new Set<() => void>();
const read = (): Lang => (typeof document !== "undefined" && document.documentElement.dataset.lang === "fr" ? "fr" : "en");
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, read, () => "en");
}

export function setLang(l: Lang) {
  document.documentElement.setAttribute("data-lang", l);
  document.documentElement.lang = l;
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {}
  listeners.forEach((fn) => fn());
}

/** Inline text in both languages; the stylesheet shows the right one. */
export function T({ en, fr }: { en: ReactNode; fr: ReactNode }) {
  return (
    <>
      <span className="l-en">{en}</span>
      <span className="l-fr">{fr}</span>
    </>
  );
}
