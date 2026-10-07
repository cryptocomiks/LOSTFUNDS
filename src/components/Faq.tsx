import { SITE } from "@/config/site";
import { T } from "@/lib/i18n";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const QUESTIONS: { q: [string, string]; a: [string, string] }[] = [
  {
    q: ["Is it safe to use?", "Est-ce que c'est sûr ?"],
    a: [
      `${SITE.name} only reads public blockchain data. It never asks you to connect a wallet, sign anything or share a seed phrase — and nobody legitimate ever will. If a site, an app or a person in your DMs asks for that to "recover" funds, it's a scam.`,
      `${SITE.name} lit seulement des données publiques de la blockchain. Il ne vous demande jamais de connecter un wallet, de signer quoi que ce soit ou de donner votre phrase secrète — et aucun service honnête ne le fera. Si un site, une app ou quelqu'un en DM vous le demande pour « récupérer » des fonds, c'est une arnaque.`,
    ],
  },
  {
    q: ["Something was found. How do I get it back?", "Quelque chose a été trouvé. Comment le récupérer ?"],
    a: [
      'Each result has a "How to claim" button with step-by-step instructions, and the official app or contract to use. Type that address yourself (don\'t click links people send you), connect the wallet that owns the funds, and confirm the claim. The funds can only go to your own address.',
      "Chaque résultat a un bouton « Comment réclamer » avec les étapes, et l'app ou le contrat officiel à utiliser. Tapez cette adresse vous-même (ne cliquez pas sur les liens qu'on vous envoie), connectez le wallet qui détient les fonds et confirmez. Les fonds ne peuvent aller qu'à votre propre adresse.",
    ],
  },
  {
    q: ["Why would money still be waiting for me?", "Pourquoi de l'argent m'attendrait encore ?"],
    a: [
      "Many actions in crypto take two steps and the second is easy to forget: finishing a bridge withdrawal, claiming an airdrop, withdrawing a lock that expired, claiming a finalized withdrawal or rewards, swapping an old token for its new version. Until you do it, the funds stay in the contract — often for years.",
      "Beaucoup d'actions en crypto se font en deux étapes, et la deuxième s'oublie facilement : terminer un retrait de bridge, réclamer un airdrop, retirer un verrou expiré, récupérer un retrait finalisé ou des récompenses, échanger un vieux token contre sa nouvelle version. Tant que ce n'est pas fait, les fonds restent dans le contrat — souvent pendant des années.",
    ],
  },
  {
    q: ["Does it cost anything?", "Est-ce payant ?"],
    a: [
      "No. The check is free and takes no cut. Claiming is a normal transaction, so you only pay the network fee (gas) to the blockchain.",
      "Non. La vérification est gratuite et sans commission. Réclamer est une transaction normale : vous ne payez que les frais de réseau (gas) à la blockchain.",
    ],
  },
  {
    q: ["Do you keep my address?", "Gardez-vous mon adresse ?"],
    a: [
      "No. Everything runs in your browser and goes straight to public blockchain nodes and the projects' own public APIs. Your last results are kept in your own browser for 10 minutes so a reload is instant, then they're deleted.",
      "Non. Tout tourne dans votre navigateur et interroge directement les nœuds publics des blockchains et les API publiques des projets. Vos derniers résultats restent 10 minutes dans votre navigateur pour qu'un rechargement soit instantané, puis ils sont effacés.",
    ],
  },
  {
    q: ["Some checks failed. What does that mean?", "Certaines vérifications ont échoué. Ça veut dire quoi ?"],
    a: [
      "The public data sources we read from were busy or slow. It doesn't mean anything is wrong with your wallet. The site retries automatically once; press Retry on the remaining ones a little later.",
      "Les sources de données publiques qu'on interroge étaient occupées ou lentes. Ça ne veut pas dire qu'il y a un problème avec votre wallet. Le site réessaie une fois automatiquement ; appuyez sur Réessayer un peu plus tard pour les autres.",
    ],
  },
  {
    q: ["Is everything covered?", "Est-ce que tout est couvert ?"],
    a: [
      "No tool can see everything. We only show what we can verify on-chain right now. For bridges and apps we don't check automatically yet, the guides below explain how to look yourself.",
      "Aucun outil ne voit tout. On affiche seulement ce qu'on peut vérifier on-chain à l'instant. Pour les bridges et apps qu'on ne vérifie pas encore automatiquement, les guides plus bas expliquent comment regarder vous-même.",
    ],
  },
];

export function Faq() {
  return (
    <Section
      id="faq"
      eyebrow={<T en="Questions" fr="Questions" />}
      title={<T en="Good to know." fr="Bon à savoir." />}
      intro={<T en="Short answers to what people ask most." fr="Des réponses courtes aux questions les plus fréquentes." />}
    >
      <div className="mx-auto max-w-[760px] divide-y divide-[var(--border)] overflow-hidden rounded-3xl border border-line bg-surface shadow-soft">
        {QUESTIONS.map((x, i) => (
          <Reveal key={x.q[0]} delay={i * 40}>
            <details className="group px-5 py-4.5 sm:px-6">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[17px] font-semibold [&::-webkit-details-marker]:hidden">
                <span>
                  <T en={x.q[0]} fr={x.q[1]} />
                </span>
                <span className="shrink-0 text-[20px] font-normal text-text-3 transition-transform group-open:rotate-45" aria-hidden>
                  +
                </span>
              </summary>
              <p className="mt-3 text-[15px] leading-relaxed text-text-2">
                <T en={x.a[0]} fr={x.a[1]} />
              </p>
            </details>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
