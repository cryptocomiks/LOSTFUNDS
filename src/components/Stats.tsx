import { GUIDES } from "@/content/guides";
import { SOURCES } from "@/lib/sources";
import { Reveal } from "./Reveal";

const STATS = [
  {
    value: String(SOURCES.length),
    label: "checks run live",
    detail: "Bridges, airdrops, rewards and old contracts, verified on-chain.",
  },
  { value: String(GUIDES.length), label: "step-by-step claim guides", detail: "For everything we check, and the apps we can't check yet." },
  { value: "0", label: "addresses stored", detail: "Everything runs in your browser. No accounts, no tracking." },
  { value: "100%", label: "of the funds go to you", detail: "Claims pay out to your own address. No fees, no cut, no sign-up." },
];

export function Stats() {
  return (
    <section className="border-y border-line">
      <div className="mx-auto grid max-w-[980px] grid-cols-2 px-4 sm:px-6 md:grid-cols-4">
        {STATS.map((s, i) => (
          <Reveal
            key={s.label}
            delay={i * 80}
            className={`py-8 pr-4 md:py-12 md:pl-6 ${i % 2 ? "pl-4 md:pl-6" : ""} ${
              i > 0 ? "md:border-l md:border-line" : "md:pl-0"
            } ${i > 1 ? "border-t border-line md:border-t-0" : ""} ${i % 2 ? "border-l border-line" : ""}`}
          >
            <p className="text-[40px] leading-none font-semibold tracking-[-0.03em] tabular-nums sm:text-[48px]">{s.value}</p>
            <p className="mt-3 text-[15px] font-semibold">{s.label}</p>
            <p className="mt-1 text-[14px] leading-snug text-text-2">{s.detail}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
