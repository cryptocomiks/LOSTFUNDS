import type { ReactNode } from "react";
import { Reveal } from "./Reveal";

export function Section({
  id,
  eyebrow,
  title,
  intro,
  children,
  alt = false,
}: {
  id: string;
  eyebrow?: string;
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  alt?: boolean;
}) {
  return (
    <section id={id} className={alt ? "bg-bg-alt" : ""}>
      <div className="mx-auto max-w-[980px] px-4 py-20 sm:px-6 sm:py-28">
        <Reveal>
          {eyebrow && <p className="mb-3 text-[15px] font-semibold text-accent">{eyebrow}</p>}
          <h2 className="text-[34px] leading-[1.08] font-semibold tracking-[-0.022em] sm:text-[48px]">{title}</h2>
          {intro && <p className="mt-4 max-w-[640px] text-[17px] leading-relaxed text-text-2 sm:text-[19px]">{intro}</p>}
        </Reveal>
        <div className="mt-10 sm:mt-14">{children}</div>
      </div>
    </section>
  );
}
