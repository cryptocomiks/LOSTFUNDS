import { SITE } from "@/config/site";
import { T } from "@/lib/i18n";
import { CopyButton } from "./CopyButton";
import { QrCode } from "./QrCode";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

export function Tip() {
  const { evm, solana, bitcoin } = SITE.tips;
  if (!evm.address && !solana.address && !bitcoin.address) return null;
  const rows = [
    evm.address && { chain: "Ethereum, Base, Arbitrum and any EVM chain", address: evm.address, label: evm.label },
    solana.address && { chain: "Solana", address: solana.address, label: "" },
    bitcoin.address && { chain: "Bitcoin", address: bitcoin.address, label: "" },
  ].filter(Boolean) as { chain: string; address: string; label: string }[];

  return (
    <Section
      id="tip"
      eyebrow={<T en="Support the project" fr="Soutenir le projet" />}
      title={<T en="☕ Buy me a coffee" fr="☕ Offrez-moi un café" />}
      intro={
        <T
          en="This checker is free, and claiming always sends 100% of the funds to your own wallet. We never take a cut. Keeping it running and adding new sources takes time, so if it helped you, a coffee in crypto is greatly appreciated. Entirely up to you."
          fr="Cet outil est gratuit, et une réclamation envoie toujours 100 % des fonds sur votre wallet. Nous ne prenons aucune commission. Le maintenir et ajouter de nouvelles sources prend du temps : s'il vous a aidé, un café en crypto fait vraiment plaisir. Entièrement libre."
        />
      }
    >
      <div className="grid gap-4">
        {rows.map((r, i) => (
          <Reveal key={r.address} delay={i * 80}>
            <div className="flex flex-col gap-4 rounded-3xl border border-line bg-surface p-6 shadow-soft sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-5">
                <QrCode value={r.address} label={`QR code: ${r.chain} ${r.address}`} />
                <div className="min-w-0">
                  <p className="text-[15px] font-semibold">{r.chain}</p>
                  <p className="mt-2 font-mono text-[14px] break-all text-text-2">{r.address}</p>
                  {r.label && <p className="mt-1 text-[13px] text-text-3">{r.label}</p>}
                </div>
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
