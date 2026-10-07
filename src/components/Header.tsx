import { SITE } from "@/config/site";
import { T } from "@/lib/i18n";
import { Book, Heart, Logo, Shield, XLogo } from "./icons";
import { LangToggle } from "./LangToggle";

const hasTips = Boolean(SITE.tips.evm.address || SITE.tips.solana.address);

export function Header() {
  const link =
    "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-text-2 transition-colors hover:bg-fill hover:text-text";
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-[var(--nav)] backdrop-blur-xl backdrop-saturate-[1.8]">
      <nav className="mx-auto flex h-13 max-w-[980px] items-center justify-between px-4 sm:px-6">
        <a href="#top" className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight">
          <Logo />
          {SITE.name}
        </a>
        <div className="flex items-center gap-0.5">
          <a href="#guides" className={link} aria-label="Guides">
            <Book width={16} height={16} />
            <span className="hidden sm:inline">Guides</span>
          </a>
          <a href="#faq" className={link} aria-label="Questions">
            <span className="text-[15px] leading-none font-semibold" aria-hidden>
              ?
            </span>
            <span className="hidden sm:inline">FAQ</span>
          </a>
          {hasTips && (
            <a href="#tip" className={link} aria-label="Tip">
              <Heart width={16} height={16} />
              <span className="hidden sm:inline"><T en="Tip" fr="Soutenir" /></span>
            </a>
          )}
          <a href="#safety" className={link} aria-label="Safety">
            <Shield width={16} height={16} />
            <span className="hidden sm:inline"><T en="Safety" fr="Sécurité" /></span>
          </a>
          {SITE.twitter && (
            <a href={SITE.twitter} target="_blank" rel="noopener noreferrer" className={link} aria-label="X (Twitter)">
              <XLogo width={15} height={15} />
            </a>
          )}
          <LangToggle />
        </div>
      </nav>
    </header>
  );
}
