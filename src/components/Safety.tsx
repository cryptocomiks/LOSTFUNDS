import { SITE } from "@/config/site";
import { Alert, Lock, Shield } from "./icons";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const RULES = [
  {
    icon: Lock,
    tone: "bg-red-soft text-red",
    title: "Never share your keys",
    text: 'Never share a seed phrase or private key, and never sign a token approval to "unlock" funds.',
  },
  {
    icon: Alert,
    tone: "bg-orange-soft text-orange",
    title: "Ignore DMs",
    text: `We don't DM links. Anyone claiming to be ${SITE.name} who does is a scammer.`,
  },
  {
    icon: Shield,
    tone: "bg-green-soft text-green",
    title: "Only official bridges",
    text: "Claims go through the official bridge contract and can only pay out to your own address.",
  },
];

export function Safety() {
  return (
    <Section id="safety" eyebrow="Safety" title="Stay safe." intro="Stuck funds attract scammers. The rules are simple." alt>
      <div className="grid gap-4 md:grid-cols-3">
        {RULES.map((r, i) => (
          <Reveal key={r.title} delay={i * 100}>
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
