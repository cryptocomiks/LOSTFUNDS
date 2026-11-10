import type { ReactNode } from "react";
import { SITE } from "@/config/site";
import { T } from "@/lib/i18n";
import { SOURCE_META as SOURCES } from "@/lib/sourceMeta";
import { Check, Eye, Logo, Search, Shield } from "./icons";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const STRENGTHS = [
  {
    icon: Search,
    tone: "bg-accent-soft text-accent",
    title: <T en="Wider" fr="Plus large" />,
    text: (
      <T
        en={`${SOURCES.length} checks in one pass: bridges, airdrops, rewards, old contracts and Solana. Most tools cover only one of these.`}
        fr={`${SOURCES.length} vérifications en un seul passage : bridges, airdrops, récompenses, anciens contrats et Solana. La plupart des outils n'en couvrent qu'un.`}
      />
    ),
  },
  {
    icon: Shield,
    tone: "bg-green-soft text-green",
    title: <T en="Verified" fr="Vérifié" />,
    text: (
      <T
        en="Every result is checked against the live chain and, wherever a claim can be simulated from your address, it is. If the contract would refuse it, you don't see it."
        fr="Chaque résultat est vérifié sur la blockchain en direct et, partout où la réclamation peut être simulée depuis votre adresse, elle l'est. Si le contrat la refuserait, vous ne la voyez pas."
      />
    ),
  },
  {
    icon: Eye,
    tone: "bg-purple-soft text-purple",
    title: <T en="Read-only" fr="En lecture seule" />,
    text: (
      <T
        en="You paste a public address. Nothing to connect, nothing to sign, no account and no fee: there is nothing here a scammer could use."
        fr="Vous collez une adresse publique. Rien à connecter, rien à signer, ni compte ni frais : il n'y a rien ici qu'un arnaqueur pourrait utiliser."
      />
    ),
  },
];

type Cell = "yes" | "no";
/** One line of the comparison: us, airdrop checkers, SOL cleanup tools. */
const ROWS: { label: ReactNode; cells: [Cell, Cell, Cell] }[] = [
  { label: <T en="Bridge withdrawals never finished" fr="Retraits de bridge jamais terminés" />, cells: ["yes", "no", "no"] },
  { label: <T en="Unclaimed airdrops" fr="Airdrops non réclamés" />, cells: ["yes", "yes", "no"] },
  { label: <T en="Rewards, vesting and expired locks" fr="Récompenses, vesting et verrous expirés" />, cells: ["yes", "no", "no"] },
  { label: <T en="Old contracts and token migrations" fr="Anciens contrats et migrations de tokens" />, cells: ["yes", "no", "no"] },
  { label: <T en="Reclaimable SOL" fr="SOL récupérable" />, cells: ["yes", "no", "yes"] },
  { label: <T en="Works without connecting a wallet" fr="Fonctionne sans connecter de wallet" />, cells: ["yes", "yes", "no"] },
  { label: <T en="No fee on what you recover" fr="Aucuns frais sur ce que vous récupérez" />, cells: ["yes", "yes", "no"] },
];

function Mark({ cell, strong }: { cell: Cell; strong?: boolean }) {
  if (cell === "yes")
    return (
      <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full ${strong ? "bg-accent text-white" : "bg-green-soft text-green"}`}>
        <Check width={14} height={14} />
        <span className="sr-only">
          <T en="Yes" fr="Oui" />
        </span>
      </span>
    );
  return (
    <span className="text-text-3">
      <span aria-hidden>—</span>
      <span className="sr-only">
        <T en="No" fr="Non" />
      </span>
    </span>
  );
}

export function Compare() {
  return (
    <Section
      id="why"
      eyebrow={<T en={`Why ${SITE.name}`} fr={`Pourquoi ${SITE.name}`} />}
      title={<T en="Wider, verified, read-only." fr="Plus large, vérifié, en lecture seule." />}
      intro={
        <T
          en="Most tools look in one place. We look everywhere a wallet can leave money behind, and only show what can really be claimed."
          fr="La plupart des outils cherchent à un seul endroit. Nous cherchons partout où un wallet peut laisser de l'argent, et n'affichons que ce qui peut vraiment être réclamé."
        />
      }
    >
      <div className="grid gap-4 md:grid-cols-3">
        {STRENGTHS.map((s, i) => (
          <Reveal key={i} delay={i * 100}>
            <div className="h-full rounded-3xl border border-line bg-surface p-7 shadow-soft">
              <span className={`flex h-11 w-11 items-center justify-center rounded-2xl ${s.tone}`}>
                <s.icon width={22} height={22} />
              </span>
              <h3 className="mt-5 text-[21px] font-semibold tracking-tight">{s.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-text-2">{s.text}</p>
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal className="mt-10">
        <div className="overflow-hidden rounded-3xl border border-line bg-surface shadow-soft">
          <table className="w-full table-fixed border-collapse text-left">
            <thead>
              <tr className="text-[11px] leading-tight text-text-2 sm:text-[13px]">
                <th scope="col" className="w-[43%] px-4 py-4 font-medium sm:w-[40%] sm:px-7">
                  <T en="What a tool can do" fr="Ce que fait l'outil" />
                </th>
                <th scope="col" className="bg-accent-soft px-1 py-4 text-center font-semibold text-text sm:px-3 sm:text-[14px]">
                  {/* The name doesn't fit a phone's column: the logo stands for it there. */}
                  <Logo className="mx-auto sm:hidden" width={26} height={26} aria-hidden />
                  <span className="sr-only sm:not-sr-only">{SITE.name}</span>
                </th>
                <th scope="col" className="px-1 py-4 text-center font-medium sm:px-3">
                  <T en="Airdrop checkers" fr="Outils d'airdrops" />
                </th>
                <th scope="col" className="px-1 py-4 text-center font-medium sm:px-3">
                  <T en="SOL cleanup tools" fr="Nettoyeurs SOL" />
                </th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r, i) => (
                <tr key={i} className="border-t border-line">
                  <th scope="row" className="px-4 py-3.5 text-[14px] leading-snug font-medium sm:px-7 sm:py-4 sm:text-[15px]">
                    {r.label}
                  </th>
                  {r.cells.map((cell, k) => (
                    <td key={k} className={`px-1 py-3.5 text-center sm:px-3 sm:py-4 ${k === 0 ? "bg-accent-soft" : ""}`}>
                      <Mark cell={cell} strong={k === 0} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-5 max-w-[720px] text-[14px] leading-relaxed text-text-3">
          <T
            en="To be fair: dedicated airdrop checkers follow hundreds of airdrops, many more than we do, and SOL cleanup tools close the accounts for you, which is why they need your wallet connected and usually keep a share of what comes back. They complement this check; whenever a site asks you to connect, make sure you know who it is."
            fr="Pour être honnête : les outils d'airdrops suivent des centaines d'airdrops, bien plus que nous, et les nettoyeurs SOL ferment les comptes à votre place, d'où la connexion du wallet et, souvent, une part prélevée sur ce qui revient. Ils complètent cette vérification ; chaque fois qu'un site vous demande de vous connecter, assurez-vous de savoir à qui vous avez affaire."
          />
        </p>
      </Reveal>
    </Section>
  );
}
