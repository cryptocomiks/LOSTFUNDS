"use client";

import { useEffect, useRef, useState } from "react";
import { T } from "@/lib/i18n";

const format = (n: number, kind: "usd" | "number", lang: "en" | "fr") => {
  const s = Math.round(n).toLocaleString(lang === "fr" ? "fr-FR" : "en-US");
  return kind === "usd" ? (lang === "fr" ? `${s} $` : `$${s}`) : s;
};

/**
 * A number that counts up to its value when it scrolls into view. The page is rendered with the
 * final value (no JavaScript, search engines, reduced motion: that's what shows).
 */
export function CountUp({ value, kind = "number", suffix = "", duration = 1800 }: { value: number; kind?: "usd" | "number"; suffix?: string; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [n, setN] = useState(value);
  useEffect(() => {
    const el = ref.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    setN(0);
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        const start = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / duration);
          setN(value * (1 - Math.pow(1 - t, 4)));
          if (t < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [value, duration]);
  return (
    <span ref={ref} className="tabular-nums">
      <T en={format(n, kind, "en") + suffix} fr={format(n, kind, "fr") + suffix} />
    </span>
  );
}
