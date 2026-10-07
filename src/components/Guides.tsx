"use client";

import { useEffect, useState } from "react";
import { GUIDES, type Guide } from "@/content/guides";
import { GUIDES_FR } from "@/content/guides.fr";
import { T, useLang } from "@/lib/i18n";
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
          {/* min-w-0: lets long addresses wrap instead of pushing the text out of the box on phones. */}
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{s}</span>
        </li>
      ))}
    </ol>
  );
}

function Item({ g: base, open, onToggle }: { g: Guide; open: boolean; onToggle: () => void }) {
  const lang = useLang();
  const g = lang === "fr" && GUIDES_FR[base.id] ? { ...base, ...GUIDES_FR[base.id] } : base;
  return (
    <li id={`guide-${g.id}`} className="scroll-mt-20">
      <h4>
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
                  <T en="LIVE CHECK" fr="VÉRIFIÉ EN DIRECT" />
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
      </h4>
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
                  <T en="No app? Do it yourself" fr="Pas d'app ? Faites-le vous-même" />
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

/** Guide sections, in display order. Guides for things we can't check automatically come last. */
const CATEGORIES = [
  "Bridge withdrawals (L2 → Ethereum)",
  "Cross-chain transfers",
  "Airdrops",
  "Rewards & withdrawals",
  "Old contracts & migrations",
  "Solana",
  "Not checked automatically yet",
] as const;
const CATEGORY_FR: Record<(typeof CATEGORIES)[number], string> = {
  "Bridge withdrawals (L2 → Ethereum)": "Retraits de bridge (L2 → Ethereum)",
  "Cross-chain transfers": "Transferts cross-chain",
  Airdrops: "Airdrops",
  "Rewards & withdrawals": "Récompenses et retraits",
  "Old contracts & migrations": "Anciens contrats et migrations",
  Solana: "Solana",
  "Not checked automatically yet": "Pas encore vérifié automatiquement",
};
type Category = (typeof CATEGORIES)[number];

const L2 = new Set(["opstack", "arbitrum", "polygon-pos", "zksync", "linea", "scroll"]);
const CROSS_CHAIN = new Set(["debridge", "celer", "cctp", "wormhole", "gnosis"]);

function categoryOf(g: Guide): Category {
  if (!g.live) return "Not checked automatically yet";
  if (g.id === "airdrops") return "Airdrops";
  if (L2.has(g.id)) return "Bridge withdrawals (L2 → Ethereum)";
  if (CROSS_CHAIN.has(g.id)) return "Cross-chain transfers";
  if (/^(rewards|lido|aave|merkl|eigen|curve|synthetix|locks)/.test(g.id)) return "Rewards & withdrawals";
  if (/^(legacy|migrat|ens|etherdelta|dao)/.test(g.id)) return "Old contracts & migrations";
  if (/^(reclaim|solana|rent|stake)/.test(g.id)) return "Solana";
  return "Cross-chain transfers";
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
      title={<T en="How to claim." fr="Comment réclamer." />}
      intro={
        <T
          en="You always claim with your own wallet, through the project's official app or contract. Type those addresses yourself: never follow links from DMs or ads."
          fr="Vous réclamez toujours avec votre propre wallet, via l'app ou le contrat officiel du projet. Tapez ces adresses vous-même : ne suivez jamais un lien reçu en DM ou dans une pub."
        />
      }
      alt
    >
      <div className="space-y-8">
        {CATEGORIES.map((c) => {
          const list = GUIDES.filter((g) => categoryOf(g) === c);
          if (!list.length) return null;
          return (
            <Reveal key={c}>
              <h3 className="mb-3 px-1 text-[13px] font-semibold tracking-wide text-text-3 uppercase">
                <T en={c} fr={CATEGORY_FR[c]} />
              </h3>
              <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-3xl border border-line bg-surface shadow-soft">
                {list.map((g) => (
                  <Item key={g.id} g={g} open={open === g.id} onToggle={() => setOpen(open === g.id ? null : g.id)} />
                ))}
              </ul>
            </Reveal>
          );
        })}
      </div>
    </Section>
  );
}
