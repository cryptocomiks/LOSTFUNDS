import { SOURCES, type Group } from "@/lib/sources";
import { Bolt, Book, Shield, Wallet } from "./icons";
import { T } from "@/lib/i18n";
import type { ReactNode } from "react";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

/** What the checker looks for, one card per group of checks (counts come from the live list of checks). */
const CARDS: { group: Group; title: ReactNode; text: ReactNode; guide: string; icon: typeof Bolt }[] = [
  {
    group: "l2",
    title: <T en="Unfinished bridge withdrawals" fr="Retraits de bridge inachevés" />,
    text: (
      <T
        en="Leaving a rollup (Base, Arbitrum, OP, zkSync, Polygon…) takes a last step on Ethereum. If it never happened, the funds are still in the bridge."
        fr="Quitter un rollup (Base, Arbitrum, OP, zkSync, Polygon…) demande une dernière étape sur Ethereum. Si elle n'a jamais été faite, les fonds sont encore dans le bridge."
      />
    ),
    guide: "opstack",
    icon: Bolt,
  },
  {
    group: "solana",
    title: <T en="Stuck cross-chain transfers" fr="Transferts cross-chain bloqués" />,
    text: (
      <T
        en="Transfers sent with Wormhole, Circle CCTP, deBridge, Gnosis or Celer that were never redeemed, minted or refunded on the other side."
        fr="Des transferts via Wormhole, Circle CCTP, deBridge, Gnosis ou Celer jamais récupérés, mintés ou remboursés de l'autre côté."
      />
    ),
    guide: "wormhole",
    icon: Bolt,
  },
  {
    group: "airdrops",
    title: <T en="Airdrops you never claimed" fr="Airdrops jamais réclamés" />,
    text: (
      <T
        en="Airdrops that are still open years later — Uniswap, Curve, Safe, 1inch, Lido, Zora and more — checked against each project's own list."
        fr="Des airdrops encore ouverts des années après — Uniswap, Curve, Safe, 1inch, Lido, Zora et d'autres — vérifiés sur la liste de chaque projet."
      />
    ),
    guide: "airdrops",
    icon: Wallet,
  },
  {
    group: "rewards",
    title: <T en="Rewards & withdrawals left behind" fr="Récompenses et retraits oubliés" />,
    text: (
      <T
        en="Finalized Lido withdrawals never claimed, expired locks never withdrawn, staking and lending rewards that piled up."
        fr="Des retraits Lido finalisés jamais réclamés, des verrous expirés jamais retirés, des récompenses de staking et de prêt qui se sont accumulées."
      />
    ),
    guide: "rewards",
    icon: Wallet,
  },
  {
    group: "legacy",
    title: <T en="Old contracts & migrations" fr="Anciens contrats et migrations" />,
    text: (
      <T
        en="Deposits forgotten in old contracts, and old tokens that are only worth something once migrated or redeemed."
        fr="Des dépôts oubliés dans d'anciens contrats, et de vieux tokens qui ne valent quelque chose qu'une fois migrés ou échangés."
      />
    ),
    guide: "legacy",
    icon: Book,
  },
  {
    group: "reclaim",
    title: <T en="SOL you can reclaim" fr="Du SOL à récupérer" />,
    text: (
      <T
        en="Solana keeps a deposit in every token account. Empty accounts and inactive stake can give that SOL back."
        fr="Solana bloque une caution dans chaque compte de token. Les comptes vides et le stake inactif peuvent vous rendre ce SOL."
      />
    ),
    guide: "reclaim",
    icon: Shield,
  },
];

export function Categories() {
  const cards = CARDS.map((c) => ({ ...c, count: SOURCES.filter((s) => s.group === c.group).length })).filter((c) => c.count > 0);
  return (
    <Section
      id="what"
      eyebrow={<T en="What we look for" fr="Ce qu'on cherche" />}
      title={<T en="Money gets left behind in many places." fr="L'argent s'oublie à plein d'endroits." />}
      intro={
        <T
          en={`One address, ${SOURCES.length} checks, all live on-chain. Here is where crypto most often gets forgotten.`}
          fr={`Une adresse, ${SOURCES.length} vérifications, toutes en direct on-chain. Voici où la crypto se perd le plus souvent.`}
        />
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c, i) => (
          <Reveal key={c.group} delay={i * 70}>
            <a
              href={`#guide-${c.guide}`}
              className="group flex h-full flex-col rounded-3xl border border-line bg-surface p-7 shadow-soft transition hover:-translate-y-0.5 hover:shadow-float"
            >
              <span className="flex items-center justify-between">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                  <c.icon width={22} height={22} />
                </span>
                <span className="rounded-full bg-fill px-2.5 py-1 text-[12px] font-semibold text-text-2 tabular-nums">
                  {c.count} <T en={c.count > 1 ? "checks" : "check"} fr={c.count > 1 ? "vérifications" : "vérification"} />
                </span>
              </span>
              <h3 className="mt-5 text-[20px] font-semibold tracking-tight">{c.title}</h3>
              <p className="mt-2 flex-1 text-[15px] leading-relaxed text-text-2">{c.text}</p>
              <span className="mt-4 text-[14px] font-medium text-link group-hover:underline"><T en="How to claim →" fr="Comment réclamer →" /></span>
            </a>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
