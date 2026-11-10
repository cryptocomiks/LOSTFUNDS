import { GUIDES } from "@/content/guides";
import { SOURCE_META as SOURCES } from "@/lib/sourceMeta";
import { T } from "@/lib/i18n";
import { CountUp } from "./CountUp";
import { Reveal } from "./Reveal";

const STATS = [
  {
    value: SOURCES.length,
    suffix: "",
    label: <T en="checks run live" fr="vérifications en direct" />,
    detail: <T en="Bridges, airdrops, rewards and old contracts, verified on-chain." fr="Bridges, airdrops, récompenses et anciens contrats, vérifiés on-chain." />,
  },
  {
    value: GUIDES.length,
    suffix: "",
    label: <T en="step-by-step claim guides" fr="guides de réclamation pas à pas" />,
    detail: <T en="For everything we check, and the apps we can't check yet." fr="Pour tout ce qu'on vérifie, et les apps qu'on ne vérifie pas encore." />,
  },
  {
    value: 0,
    suffix: "",
    label: <T en="addresses stored" fr="adresse enregistrée" />,
    detail: <T en="Everything runs in your browser. No accounts, no tracking." fr="Tout tourne dans votre navigateur. Pas de compte, pas de pistage." />,
  },
  {
    value: 100,
    suffix: "%",
    label: <T en="of the funds go to you" fr="des fonds pour vous" />,
    detail: <T en="Claims pay out to your own address. No fees, no cut, no sign-up." fr="Les réclamations paient votre propre adresse. Sans frais, sans commission, sans inscription." />,
  },
];

export function Stats() {
  return (
    <section className="border-y border-line">
      <div className="mx-auto grid max-w-[980px] grid-cols-2 px-4 sm:px-6 md:grid-cols-4">
        {STATS.map((s, i) => (
          <Reveal
            key={i}
            delay={i * 80}
            className={`py-8 pr-4 md:py-12 md:pl-6 ${i % 2 ? "pl-4 md:pl-6" : ""} ${
              i > 0 ? "md:border-l md:border-line" : "md:pl-0"
            } ${i > 1 ? "border-t border-line md:border-t-0" : ""} ${i % 2 ? "border-l border-line" : ""}`}
          >
            <p className="text-[40px] leading-none font-semibold tracking-[-0.03em] tabular-nums sm:text-[48px]">
              {s.value ? <CountUp value={s.value} suffix={s.suffix} duration={1400} /> : "0"}
            </p>
            <p className="mt-3 text-[15px] font-semibold">{s.label}</p>
            <p className="mt-1 text-[14px] leading-snug text-text-2">{s.detail}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
