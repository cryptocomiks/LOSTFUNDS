"use client";

import { useEffect, useState } from "react";
import { useLang } from "@/lib/i18n";

/** A round "back to top" button that shows up once the page has been scrolled a fair way. */
export function BackToTop() {
  const [show, setShow] = useState(false);
  const fr = useLang() === "fr";
  useEffect(() => {
    const onScroll = () => setShow(scrollY > 900);
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, []);
  return (
    <button
      type="button"
      onClick={() => scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}
      aria-label={fr ? "Revenir en haut" : "Back to top"}
      tabIndex={show ? 0 : -1}
      className={`fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface/85 text-text shadow-float backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5 sm:right-6 sm:bottom-6 ${
        show ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"
      }`}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 19V5M5 12l7-7 7 7" />
      </svg>
    </button>
  );
}
