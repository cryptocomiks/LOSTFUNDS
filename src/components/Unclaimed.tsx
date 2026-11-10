import { T } from "@/lib/i18n";
import { SOURCE_META as SOURCES } from "@/lib/sourceMeta";
import { UNCLAIMED, UNCLAIMED_LABELS } from "@/lib/unclaimed";
import { CountUp } from "./CountUp";
import { ArrowRight } from "./icons";
import { Reveal } from "./Reveal";

const date = (lang: "en" | "fr") =>
  new Date(UNCLAIMED.measuredAt * 1000).toLocaleDateString(lang === "fr" ? "fr-FR" : "en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
const number = (n: number, lang: "en" | "fr") => n.toLocaleString(lang === "fr" ? "fr-FR" : "en-US", { maximumFractionDigits: n >= 100 ? 0 : 2 });

/** The measured sources with a label, largest first. */
const ROWS = UNCLAIMED.sources.filter((s) => UNCLAIMED_LABELS[s.id]);
const TOTAL = ROWS.reduce((sum, s) => sum + s.usd, 0);
const largest = ROWS[0]?.usd ?? 1;
/** Rows shown on a phone; the others appear from the tablet layout up. */
const MOBILE_ROWS = 8;

export function Unclaimed() {
  return (
    <section id="unclaimed" className="bg-bg-alt">
      <div className="mx-auto max-w-[980px] px-4 py-20 sm:px-6 sm:py-28">
        <Reveal className="text-center">
          <p className="mb-3 text-[15px] font-semibold text-accent">
            <T en="Measured on-chain" fr="Mesuré on-chain" />
          </p>
          <p className="text-gradient text-[42px] leading-none font-semibold tracking-[-0.035em] sm:text-[84px]">
            <CountUp value={TOTAL} kind="usd" duration={2400} />
          </p>
          <h2 className="mx-auto mt-5 max-w-[720px] text-[24px] leading-[1.15] font-semibold tracking-[-0.02em] sm:text-[34px]">
            <T en="still waiting for their owners." fr="attendent toujours leurs propriétaires." />
          </h2>
          <p className="mx-auto mt-4 max-w-[640px] text-[17px] leading-relaxed text-text-2">
            <T
              en={`Read from the contracts themselves on ${date("en")}, in ${ROWS.length} of the ${SOURCES.length} places we check: the only ones whose total can be read exactly. The real figure is higher.`}
              fr={`Lu dans les contrats eux-mêmes le ${date("fr")}, dans ${ROWS.length} des ${SOURCES.length} endroits que nous vérifions : les seuls dont le total se lit exactement. Le vrai chiffre est plus élevé.`}
            />
          </p>
        </Reveal>

        <div className="mt-12 grid gap-x-10 sm:mt-16 md:grid-cols-2">
          {ROWS.map((s, i) => {
            const label = UNCLAIMED_LABELS[s.id];
            const main = s.parts[0];
            const text = (lang: "en" | "fr") => label[lang].replace("{n}", number(s.count ?? 0, lang));
            return (
              <Reveal key={s.id} delay={(i % 2) * 80} className={`border-t border-line py-5 ${i >= MOBILE_ROWS ? "hidden md:block" : ""}`}>
                <div className="flex items-baseline justify-between gap-4">
                  <h3 className="text-[17px] font-semibold tracking-tight">{label.name}</h3>
                  <p className="shrink-0 text-[17px] font-semibold">
                    <CountUp value={s.usd} kind="usd" />
                  </p>
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-4 text-[14px] text-text-2">
                  <p className="leading-snug">
                    <T en={text("en")} fr={text("fr")} />
                  </p>
                  <p className="shrink-0 tabular-nums">
                    <T en={`${number(main.amount, "en")} ${main.symbol}`} fr={`${number(main.amount, "fr")} ${main.symbol}`} />
                    {s.parts.length > 1 && <T en=" + more" fr=" + autres" />}
                  </p>
                </div>
                {/* Size against the largest source, on a square-root scale so small ones stay visible. */}
                <div className="mt-3 h-1 overflow-hidden rounded-full bg-fill" aria-hidden>
                  <div className="h-full rounded-full bg-[linear-gradient(90deg,#0A84FF,#7B61FF_55%,#E5487D)]" style={{ width: `${Math.max(2, Math.sqrt(s.usd / largest) * 100)}%` }} />
                </div>
              </Reveal>
            );
          })}
        </div>
        {ROWS.length > MOBILE_ROWS && (
          <p className="border-t border-line pt-5 text-[14px] text-text-2 md:hidden">
            <T en={`And ${ROWS.length - MOBILE_ROWS} more measured sources.`} fr={`Et ${ROWS.length - MOBILE_ROWS} autres sources mesurées.`} />
          </p>
        )}

        <Reveal className="mt-12 flex flex-col items-center gap-5 text-center">
          <p className="max-w-[640px] text-[15px] leading-relaxed text-text-2">
            <T
              en="These amounts belong to thousands of different addresses. Only a check of your own address tells you whether any of it is yours: it takes a few seconds and costs nothing."
              fr="Ces montants appartiennent à des milliers d'adresses différentes. Seule une vérification de votre propre adresse vous dit si une part est à vous : ça prend quelques secondes et c'est gratuit."
            />
          </p>
          <a
            href="#top"
            className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-[16px] font-medium text-white transition hover:bg-accent-hover active:scale-[0.98]"
          >
            <T en="Check my address" fr="Vérifier mon adresse" />
            <ArrowRight width={17} height={17} />
          </a>
        </Reveal>
      </div>
    </section>
  );
}
