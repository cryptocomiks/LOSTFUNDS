import { SITE } from "@/config/site";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const QUESTIONS: { q: string; a: string }[] = [
  {
    q: "Is it safe to use?",
    a: `${SITE.name} only reads public blockchain data. It never asks you to connect a wallet, sign anything or share a seed phrase — and nobody legitimate ever will. If a site, an app or a person in your DMs asks for that to "recover" funds, it's a scam.`,
  },
  {
    q: "Something was found. How do I get it back?",
    a: "Each result has a \"How to claim\" button with step-by-step instructions, and the official app or contract to use. Type that address yourself (don't click links people send you), connect the wallet that owns the funds, and confirm the claim. The funds can only go to your own address.",
  },
  {
    q: "Why would money still be waiting for me?",
    a: "Many actions in crypto take two steps and the second is easy to forget: finishing a bridge withdrawal, claiming an airdrop, withdrawing a lock that expired, claiming a finalized withdrawal or rewards. Until you do it, the funds stay in the contract — often for years.",
  },
  {
    q: "Does it cost anything?",
    a: "No. The check is free and takes no cut. Claiming is a normal transaction, so you only pay the network fee (gas) to the blockchain.",
  },
  {
    q: "Do you keep my address?",
    a: "No. Everything runs in your browser and goes straight to public blockchain nodes and the projects' own public APIs. Your last results are kept in your own browser for 10 minutes so a reload is instant, then they're deleted.",
  },
  {
    q: "Some checks failed. What does that mean?",
    a: "The public data sources we read from were busy or slow. It doesn't mean anything is wrong with your wallet. The site retries automatically once; press Retry on the remaining ones a little later.",
  },
  {
    q: "Is everything covered?",
    a: "No tool can see everything. We only show what we can verify on-chain right now. For bridges and apps we don't check automatically yet, the guides below explain how to look yourself.",
  },
];

export function Faq() {
  return (
    <Section id="faq" eyebrow="Questions" title="Good to know." intro="Short answers to what people ask most.">
      <div className="mx-auto max-w-[760px] divide-y divide-[var(--border)] overflow-hidden rounded-3xl border border-line bg-surface shadow-soft">
        {QUESTIONS.map((x, i) => (
          <Reveal key={x.q} delay={i * 40}>
            <details className="group px-5 py-4.5 sm:px-6">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[17px] font-semibold [&::-webkit-details-marker]:hidden">
                {x.q}
                <span className="shrink-0 text-[20px] font-normal text-text-3 transition-transform group-open:rotate-45" aria-hidden>
                  +
                </span>
              </summary>
              <p className="mt-3 text-[15px] leading-relaxed text-text-2">{x.a}</p>
            </details>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
