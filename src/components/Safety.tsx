import { SITE } from "@/config/site";
import { T } from "@/lib/i18n";
import { Alert, Lock, Shield } from "./icons";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const RULES = [
  {
    icon: Lock,
    tone: "bg-red-soft text-red",
    title: <T en="Never share your keys" fr="Ne partagez jamais vos clés" />,
    text: (
      <T
        en='Never share a seed phrase or private key, and never sign a token approval to "unlock" funds.'
        fr="Ne donnez jamais votre phrase secrète ni votre clé privée, et ne signez jamais d'approbation de token pour « débloquer » des fonds."
      />
    ),
  },
  {
    icon: Alert,
    tone: "bg-orange-soft text-orange",
    title: <T en={'Ignore DMs and "recovery" services'} fr="Ignorez les DM et les services de « récupération »" />,
    text: (
      <T
        en={`We never DM anyone. Nobody needs your wallet to recover funds for you: people offering it, or claiming to be ${SITE.name}, are scammers.`}
        fr={`Nous n'envoyons jamais de DM. Personne n'a besoin de votre wallet pour récupérer vos fonds : ceux qui le proposent, ou qui se font passer pour ${SITE.name}, sont des arnaqueurs.`}
      />
    ),
  },
  {
    icon: Shield,
    tone: "bg-green-soft text-green",
    title: <T en="Only official apps" fr="Uniquement les apps officielles" />,
    text: (
      <T
        en="Type the official app's address yourself, never from a link someone sent you. Real claims only ever pay out to your own address."
        fr="Tapez vous-même l'adresse de l'app officielle, jamais depuis un lien qu'on vous envoie. Une vraie réclamation paie toujours votre propre adresse."
      />
    ),
  },
];

export function Safety() {
  return (
    <Section
      id="safety"
      eyebrow={<T en="Safety" fr="Sécurité" />}
      title={<T en="Stay safe." fr="Restez prudent." />}
      intro={<T en="Forgotten funds attract scammers. The rules are simple." fr="L'argent oublié attire les arnaqueurs. Les règles sont simples." />}
      alt
    >
      <div className="grid gap-4 md:grid-cols-3">
        {RULES.map((r, i) => (
          <Reveal key={i} delay={i * 100}>
            <div className="h-full rounded-3xl border border-line bg-surface p-7 shadow-soft">
              <span className={`flex h-11 w-11 items-center justify-center rounded-2xl ${r.tone}`}>
                <r.icon width={22} height={22} />
              </span>
              <h3 className="mt-5 text-[21px] font-semibold tracking-tight">{r.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-text-2">{r.text}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
