import { SITE } from "@/config/site";
import { T } from "@/lib/i18n";
import { CopyButton } from "./CopyButton";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

export function Tip() {
  const { evm, solana } = SITE.tips;
  if (!evm.address && !solana.address) return null;
  const rows = [
    evm.address && { chain: "Ethereum, Base, Arbitrum and any EVM chain", address: evm.address, label: evm.label },
    solana.address && { chain: "Solana", address: solana.address, label: "" },
  ].filter(Boolean) as { chain: string; address: string; label: string }[];

  return (
    <Section
      id="tip"
      eyebrow={<T en="Support" fr="Soutenir" />}
      title={<T en="Found something? Leave a tip." fr="Vous avez retrouvé quelque chose ? Laissez un pourboire." />}
      intro={
        <T
          en="This checker is free, and claiming always sends 100% of the funds to your own wallet. We never take a cut. If it helped you recover funds, a tip is appreciated, but it's entirely up to you."
          fr="Cet outil est gratuit, et une réclamation envoie toujours 100 % des fonds sur votre wallet. Nous ne prenons aucune commission. S'il vous a aidé, un pourboire fait plaisir, mais c'est entièrement libre."
        />
      }
    >
      <div className="grid gap-4">
        {rows.map((r, i) => (
          <Reveal key={r.address} delay={i * 80}>
            <div className="flex flex-col gap-4 rounded-3xl border border-line bg-surface p-6 shadow-soft sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-[15px] font-semibold">{r.chain}</p>
                <p className="mt-2 font-mono text-[14px] break-all text-text-2">{r.address}</p>
                {r.label && <p className="mt-1 text-[13px] text-text-3">{r.label}</p>}
              </div>
              <CopyButton value={r.address} />
            </div>
          </Reveal>
        ))}
      </div>
      <p className="mt-6 text-[14px] text-text-3">
        <T
          en="We will never DM you first or ask for a seed phrase, and we never send claim links."
          fr="Nous ne vous écrirons jamais en premier, ne demanderons jamais de phrase secrète et n'envoyons jamais de liens de réclamation."
        />
      </p>
    </Section>
  );
}
