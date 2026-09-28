import { SITE } from "@/config/site";
import { Logo } from "./icons";

export function Footer() {
  return (
    <footer className="border-t border-line bg-bg-alt">
      <div className="mx-auto max-w-[980px] px-4 py-10 text-[12px] leading-relaxed text-text-3 sm:px-6">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-text-2">
          <Logo width={20} height={20} />
          {SITE.name}
        </div>
        <p className="mt-4 max-w-2xl">
          {SITE.name} is a free, open-source, read-only tool. It never asks you to connect a wallet or sign anything, and
          your address never leaves your browser except to query public blockchain data. Results are provided as is: always
          double-check in the bridge&apos;s official app before acting.
        </p>
        <p className="mt-3">Not affiliated with any bridge or chain listed on this page.</p>
      </div>
    </footer>
  );
}
