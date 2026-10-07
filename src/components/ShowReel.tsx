"use client";

import { useEffect, useRef, useState } from "react";
import { T } from "@/lib/i18n";
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

/** 15-second product film. Plays muted while on screen; the button turns the sound on. */
export function ShowReel() {
  const ref = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);

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
  }, []);

  const toggleSound = () => {
    const v = ref.current;
    if (!v) return;
    const next = !muted;
    v.muted = next;
    if (!next) {
      v.currentTime = 0; // start from the top so the sound design lines up
      v.play().catch(() => {});
    }
    setMuted(next);
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
              ref={ref}
              className="block aspect-video w-full"
              src="/video/lostfunds-film.mp4"
              poster="/video/lostfunds-film-poster.jpg"
              muted
              loop
              playsInline
              preload="metadata"
              aria-label="lostfunds: a 15-second film showing how the checker finds unclaimed bridge withdrawals"
            />
            <button
              type="button"
              onClick={toggleSound}
              className="absolute right-4 bottom-4 flex items-center gap-2 rounded-full bg-black/55 px-4 py-2 text-[13px] font-medium text-white backdrop-blur-md transition hover:bg-black/70 active:scale-[0.97]"
              aria-label={muted ? "Turn sound on" : "Mute"}
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
