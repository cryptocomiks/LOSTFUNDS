import { Bolt, Eye, Wallet } from "./icons";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const STEPS = [
  {
    icon: Eye,
    title: "Paste an address",
    text: "Ethereum or Solana, or an ENS name. No wallet connection: we only read public blockchain data.",
  },
  {
    icon: Bolt,
    title: "We check everywhere at once",
    text: "Bridges, airdrops, staking and reward contracts, old exchanges: for each one we ask the chain directly whether something is still waiting for you.",
  },
  {
    icon: Wallet,
    title: "You claim it yourself",
    text: "Through the project's official app, with your own wallet, following our step-by-step guide. The funds can only go to your address.",
  },
];

export function HowItWorks() {
  return (
    <Section
      id="how"
      eyebrow="How it works"
      title="Forgotten money, found in seconds."
      intro="Crypto leaves money behind in a lot of places: a withdrawal you never finished, an airdrop you never claimed, a lock that expired. It's easy to close the tab and never come back for the last step."
    >
      <div className="grid gap-4 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <Reveal key={s.title} delay={i * 100}>
            <div className="h-full rounded-3xl border border-line bg-surface p-7 shadow-soft">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <s.icon width={22} height={22} />
              </span>
              <p className="mt-5 text-[13px] font-semibold text-text-3 tabular-nums">Step {i + 1}</p>
              <h3 className="mt-1 text-[21px] font-semibold tracking-tight">{s.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-text-2">{s.text}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
