import { T } from "@/lib/i18n";
import { Bolt, Eye, Wallet } from "./icons";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const STEPS = [
  {
    icon: Eye,
    title: <T en="Paste an address" fr="Collez une adresse" />,
    text: (
      <T
        en="Ethereum or Solana, or an ENS name. No wallet connection: we only read public blockchain data."
        fr="Ethereum ou Solana, ou un nom ENS. Aucune connexion de wallet : on lit seulement les données publiques de la blockchain."
      />
    ),
  },
  {
    icon: Bolt,
    title: <T en="We check everywhere at once" fr="On vérifie partout à la fois" />,
    text: (
      <T
        en="Bridges, airdrops, staking and reward contracts, old exchanges: for each one we ask the chain directly whether something is still waiting for you."
        fr="Bridges, airdrops, staking, récompenses, anciens exchanges : pour chacun, on demande directement à la blockchain si quelque chose vous attend encore."
      />
    ),
  },
  {
    icon: Wallet,
    title: <T en="You claim it yourself" fr="Vous réclamez vous-même" />,
    text: (
      <T
        en="Through the project's official app, with your own wallet, following our step-by-step guide. The funds can only go to your address."
        fr="Sur l'app officielle du projet, avec votre propre wallet, en suivant notre guide pas à pas. Les fonds ne peuvent aller qu'à votre adresse."
      />
    ),
  },
];

export function HowItWorks() {
  return (
    <Section
      id="how"
      eyebrow={<T en="How it works" fr="Comment ça marche" />}
      title={<T en="Forgotten money, found in seconds." fr="L'argent oublié, retrouvé en quelques secondes." />}
      intro={
        <T
          en="Crypto leaves money behind in a lot of places: a withdrawal you never finished, an airdrop you never claimed, a lock that expired. It's easy to close the tab and never come back for the last step."
          fr="La crypto laisse de l'argent derrière elle à plein d'endroits : un retrait jamais terminé, un airdrop jamais réclamé, un verrou expiré. On ferme l'onglet, et on ne revient jamais pour la dernière étape."
        />
      }
    >
      <div className="grid gap-4 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <Reveal key={i} delay={i * 100}>
            <div className="h-full rounded-3xl border border-line bg-surface p-7 shadow-soft">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <s.icon width={22} height={22} />
              </span>
              <p className="mt-5 text-[13px] font-semibold text-text-3 tabular-nums"><T en="Step" fr="Étape" /> {i + 1}</p>
              <h3 className="mt-1 text-[21px] font-semibold tracking-tight">{s.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-text-2">{s.text}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
