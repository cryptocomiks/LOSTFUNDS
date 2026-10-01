import { SOURCES, type Group } from "@/lib/sources";
import { Bolt, Book, Shield, Wallet } from "./icons";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

/** What the checker looks for, one card per group of checks (counts come from the live list of checks). */
const CARDS: { group: Group; title: string; text: string; guide: string; icon: typeof Bolt }[] = [
  {
    group: "l2",
    title: "Unfinished bridge withdrawals",
    text: "Leaving a rollup (Base, Arbitrum, OP, zkSync, Polygon…) takes a last step on Ethereum. If it never happened, the funds are still in the bridge.",
    guide: "opstack",
    icon: Bolt,
  },
  {
    group: "solana",
    title: "Stuck cross-chain transfers",
    text: "Transfers sent with Wormhole, Circle CCTP, deBridge, Gnosis or Celer that were never redeemed, minted or refunded on the other side.",
    guide: "wormhole",
    icon: Bolt,
  },
  {
    group: "airdrops",
    title: "Airdrops you never claimed",
    text: "Airdrops that are still open years later — Uniswap, Curve, Safe, 1inch, Lido, Zora and more — checked against each project's own list.",
    guide: "airdrops",
    icon: Wallet,
  },
  {
    group: "rewards",
    title: "Rewards & withdrawals left behind",
    text: "Finalized Lido withdrawals never claimed, expired locks never withdrawn, staking and lending rewards that piled up.",
    guide: "rewards",
    icon: Wallet,
  },
  {
    group: "legacy",
    title: "Old contracts & migrations",
    text: "Deposits forgotten in old contracts, and old tokens that are only worth something once migrated or redeemed.",
    guide: "legacy",
    icon: Book,
  },
  {
    group: "reclaim",
    title: "SOL you can reclaim",
    text: "Solana keeps a deposit in every token account. Empty accounts and inactive stake can give that SOL back.",
    guide: "reclaim",
    icon: Shield,
  },
];

export function Categories() {
  const cards = CARDS.map((c) => ({ ...c, count: SOURCES.filter((s) => s.group === c.group).length })).filter((c) => c.count > 0);
  return (
    <Section
      id="what"
      eyebrow="What we look for"
      title="Money gets left behind in many places."
      intro={`One address, ${SOURCES.length} checks, all live on-chain. Here is where crypto most often gets forgotten.`}
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
                  {c.count} check{c.count > 1 ? "s" : ""}
                </span>
              </span>
              <h3 className="mt-5 text-[20px] font-semibold tracking-tight">{c.title}</h3>
              <p className="mt-2 flex-1 text-[15px] leading-relaxed text-text-2">{c.text}</p>
              <span className="mt-4 text-[14px] font-medium text-link group-hover:underline">How to claim →</span>
            </a>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
