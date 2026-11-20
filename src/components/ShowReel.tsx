"use client";

import { useEffect, useRef, useState } from "react";
import { SITE } from "@/config/site";
import { T, useLang, type Lang } from "@/lib/i18n";
import { Reveal } from "./Reveal";

const SoundOn = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
);
const SoundOff = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    <path d="m16 9 5 6M21 9l-5 6" />
  </svg>
);

/**
 * 15-second product film, in the visitor's language (film/ renders both versions). Nothing is
 * downloaded but the poster until it comes on screen; it then plays muted, and the button turns
 * the sound on.
 */
export function ShowReel() {
  const lang = useLang();
  const ref = useRef<HTMLVideoElement>(null);
  /** The language whose film has its sound on: switching language loads the other film, muted again. */
  const [soundOn, setSoundOn] = useState<Lang | null>(null);
  const muted = soundOn !== lang;

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) v.play().catch(() => {});
        else v.pause();
      },
      { threshold: 0.35 },
    );
    io.observe(v);
    return () => io.disconnect();
  }, [lang]);

  const toggleSound = () => {
    const v = ref.current;
    if (!v) return;
    v.muted = !muted;
    if (muted) {
      v.currentTime = 0; // start from the top so the sound design lines up
      v.play().catch(() => {});
    }
    setSoundOn(muted ? lang : null);
  };

  return (
    <section id="film" className="overflow-hidden">
      <div className="mx-auto max-w-[1180px] px-4 py-16 sm:px-6 sm:py-24">
        <Reveal>
          <p className="mb-3 text-center text-[15px] font-semibold text-accent"><T en="See it in action" fr="En action" /></p>
          <h2 className="mx-auto max-w-[720px] text-center text-[34px] leading-[1.08] font-semibold tracking-[-0.022em] sm:text-[48px]">
            <T en="What you left behind, in fifteen seconds." fr="Ce que vous avez oublié, en quinze secondes." />
          </h2>
        </Reveal>
        <Reveal delay={120}>
          <div className="relative mx-auto mt-10 overflow-hidden rounded-[28px] border border-line bg-black shadow-float sm:mt-14">
            <video
              key={lang}
              ref={ref}
              className="block aspect-video w-full"
              src={`/video/fundscheckers-film-${lang}.mp4`}
              poster={`/video/fundscheckers-film-${lang}.jpg`}
              muted
              loop
              playsInline
              preload="none"
              aria-label={
                lang === "fr"
                  ? `${SITE.name} : un film de 15 secondes qui montre comment le site retrouve la crypto jamais réclamée (retraits, airdrops, staking, récompenses)`
                  : `${SITE.name}: a 15-second film showing how the checker finds crypto that was never claimed (withdrawals, airdrops, staking, rewards)`
              }
            />
            <button
              type="button"
              onClick={toggleSound}
              className="absolute right-4 bottom-4 flex items-center gap-2 rounded-full bg-black/55 px-4 py-2 text-[13px] font-medium text-white backdrop-blur-md transition hover:bg-black/70 active:scale-[0.97]"
              aria-label={muted ? (lang === "fr" ? "Activer le son" : "Turn sound on") : lang === "fr" ? "Couper le son" : "Mute"}
            >
              {muted ? <SoundOff /> : <SoundOn />}
              {muted ? <T en="Sound on" fr="Son" /> : <T en="Mute" fr="Couper" />}
            </button>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
