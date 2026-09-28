"use client";

import { useEffect, useState } from "react";
import { GUIDES, type Guide } from "@/content/guides";
import { Chevron } from "./icons";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

function Steps({ items, start = 1 }: { items: string[]; start?: number }) {
  return (
    <ol className="space-y-3">
      {items.map((s, i) => (
        <li key={i} className="flex gap-3.5 text-[16px] leading-relaxed">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-fill-strong text-[12px] font-semibold text-text-2 tabular-nums">
            {start + i}
          </span>
          <span className="break-words [overflow-wrap:anywhere]">{s}</span>
        </li>
      ))}
    </ol>
  );
}

function Item({ g, open, onToggle }: { g: Guide; open: boolean; onToggle: () => void }) {
  return (
    <li id={`guide-${g.id}`} className="scroll-mt-20">
      <h3>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={`guide-body-${g.id}`}
          className="flex w-full items-center gap-4 px-5 py-4.5 text-left transition-colors hover:bg-fill sm:px-6"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
            <span className={`flex items-center gap-2 text-[17px] font-semibold ${open ? "text-accent" : ""}`}>
              {g.title}
              {g.live && (
                <span className="rounded-full bg-green-soft px-2 py-0.5 text-[11px] font-semibold tracking-wide text-green">
                  LIVE CHECK
                </span>
              )}
            </span>
            {g.subtitle && <span className="truncate text-[14px] text-text-3">{g.subtitle}</span>}
          </span>
          <Chevron
            width={18}
            height={18}
            className={`shrink-0 text-text-3 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
          />
        </button>
      </h3>
      <div
        id={`guide-body-${g.id}`}
        className={`grid transition-[grid-template-rows] duration-400 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="px-5 pt-1 pb-7 sm:px-6">
            <Steps items={g.steps} />
            {g.note && <p className="mt-5 pl-[38px] text-[15px] leading-relaxed text-text-2">{g.note}</p>}
            {g.manual && (
              <div className="mt-6 rounded-2xl bg-fill p-5 sm:p-6">
                <p className="mb-4 text-[12px] font-semibold tracking-[0.1em] text-text-3 uppercase">
                  No app? Do it yourself
                </p>
                <Steps items={g.manual} start={g.steps.length + 1} />
              </div>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

export function Guides() {
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => {
      const m = location.hash.match(/^#guide-(.+)$/);
      if (m) setOpen(m[1]);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  return (
    <Section
      id="guides"
      eyebrow="Guides"
      title="How to claim."
      intro="You always claim with your own wallet, through the bridge's official app or contract. Type bridge URLs yourself: never follow links from DMs or ads."
      alt
    >
      <Reveal>
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-3xl border border-line bg-surface shadow-soft">
          {GUIDES.map((g) => (
            <Item key={g.id} g={g} open={open === g.id} onToggle={() => setOpen(open === g.id ? null : g.id)} />
          ))}
        </ul>
      </Reveal>
    </Section>
  );
}
