import { SITE } from "@/config/site";
import { T } from "@/lib/i18n";
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
          <T
            en={`${SITE.name} is a free, open-source, read-only tool. It never asks you to connect a wallet or sign anything, and your address never leaves your browser except to query public blockchain data. Results are provided as is: always double-check in the official app before acting.`}
            fr={`${SITE.name} est un outil gratuit, open source et en lecture seule. Il ne demande jamais de connecter un wallet ni de signer quoi que ce soit, et votre adresse ne quitte votre navigateur que pour interroger des données publiques de la blockchain. Résultats fournis tels quels : vérifiez toujours dans l'app officielle avant d'agir.`}
          />
        </p>
        <p className="mt-3">
          <T en="Not affiliated with any project listed on this page." fr="Sans lien avec les projets cités sur cette page." />
        </p>
      </div>
    </footer>
  );
}
