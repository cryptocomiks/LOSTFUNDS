"use client";

import { useEffect, useRef, useState } from "react";
import { SITE } from "@/config/site";
import { T } from "@/lib/i18n";
import { Logo, XLogo } from "./icons";
import { LangToggle } from "./LangToggle";

const hasTips = Boolean(SITE.tips.evm.address || SITE.tips.solana.address);

/** The page's sections, in order. */
const LINKS: { id: string; en: string; fr: string }[] = [
  { id: "top", en: "Check", fr: "Vérifier" },
  { id: "what", en: "What we find", fr: "Ce qu'on trouve" },
  { id: "how", en: "How it works", fr: "Comment ça marche" },
  { id: "guides", en: "Guides", fr: "Guides" },
  { id: "faq", en: "FAQ", fr: "FAQ" },
  ...(hasTips ? [{ id: "tip", en: "Tip", fr: "Soutenir" }] : []),
  { id: "safety", en: "Safety", fr: "Sécurité" },
];

/** "Check" brings the address field back into focus once the page has scrolled up. */
function focusAddressSoon(id: string) {
  if (id !== "top") return;
  // Wait for the smooth scroll to reach the top, then focus without scrolling again.
  const started = Date.now();
  const tick = () => {
    if (scrollY < 4 || Date.now() - started > 2500) document.getElementById("address")?.focus({ preventScroll: true });
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function Header() {
  const [active, setActive] = useState("top");
  const [open, setOpen] = useState(false);
  const bar = useRef<HTMLDivElement>(null);

  // Highlight the section in the middle of the screen.
  useEffect(() => {
    const els = LINKS.map((l) => document.getElementById(l.id)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);

  // Reading progress, drawn without re-rendering.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const max = document.documentElement.scrollHeight - innerHeight;
      if (bar.current) bar.current.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);
    return () => {
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  // The mobile menu closes with Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open]);

  const link = (on: boolean) =>
    `rounded-full px-3 py-1.5 text-[13px] transition-colors ${on ? "bg-fill text-text" : "text-text-2 hover:bg-fill hover:text-text"}`;

  return (
    <header className="sticky top-0 z-50 border-b border-line bg-[var(--nav)] backdrop-blur-xl backdrop-saturate-[1.8]">
      <nav className="mx-auto flex h-13 max-w-[980px] items-center justify-between gap-3 px-4 sm:px-6">
        <a href="#top" onClick={() => setOpen(false)} className="flex shrink-0 items-center gap-2.5 text-[17px] font-semibold tracking-tight">
          <Logo />
          {SITE.name}
        </a>

        {/* Desktop: every section, the current one highlighted */}
        <div className="hidden items-center gap-0.5 lg:flex">
          {LINKS.map((l) => (
            <a key={l.id} href={`#${l.id}`} onClick={() => focusAddressSoon(l.id)} className={link(active === l.id)} aria-current={active === l.id ? "true" : undefined}>
              <T en={l.en} fr={l.fr} />
            </a>
          ))}
        </div>

        <div className="flex items-center gap-0.5">
          {SITE.twitter && (
            <a href={SITE.twitter} target="_blank" rel="noopener noreferrer" className={link(false)} aria-label="X (Twitter)">
              <XLogo width={15} height={15} />
            </a>
          )}
          <LangToggle />
          {/* Mobile: a menu */}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls="site-menu"
            aria-label="Menu"
            className="flex h-9 w-9 items-center justify-center rounded-full text-text-2 transition-colors hover:bg-fill hover:text-text lg:hidden"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d={open ? "M6 6l12 12" : "M4 7h16"} className="transition-all duration-300" />
              <path d="M4 12h16" className={`transition-opacity duration-200 ${open ? "opacity-0" : "opacity-100"}`} />
              <path d={open ? "M6 18L18 6" : "M4 17h16"} className="transition-all duration-300" />
            </svg>
          </button>
        </div>
      </nav>

      {/* Mobile menu panel */}
      <div
        id="site-menu"
        className={`absolute inset-x-0 top-full grid overflow-hidden border-line bg-surface shadow-float transition-[grid-template-rows,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] lg:hidden ${
          open ? "grid-rows-[1fr] border-b" : "grid-rows-[0fr] border-transparent"
        }`}
      >
        <div className="min-h-0">
          <ul className="mx-auto max-w-[980px] px-3 py-2">
            {LINKS.map((l) => (
              <li key={l.id}>
                <a
                  href={`#${l.id}`}
                  tabIndex={open ? 0 : -1}
                  onClick={() => {
                    setOpen(false);
                    focusAddressSoon(l.id);
                  }}
                  className={`flex items-center justify-between rounded-2xl px-4 py-3 text-[16px] font-medium transition-colors ${
                    active === l.id ? "bg-fill text-text" : "text-text-2 hover:bg-fill hover:text-text"
                  }`}
                >
                  <T en={l.en} fr={l.fr} />
                  {active === l.id && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Reading progress */}
      <div
        ref={bar}
        className="absolute inset-x-0 -bottom-px h-[2px] origin-left bg-[linear-gradient(90deg,#0A84FF,#7B61FF_55%,#E5487D)]"
        style={{ transform: "scaleX(0)" }}
        aria-hidden
      />
    </header>
  );
}
