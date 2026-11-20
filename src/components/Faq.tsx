import { SITE } from "@/config/site";
import { T } from "@/lib/i18n";
import { Reveal } from "./Reveal";
import { Section } from "./Section";

const QUESTIONS: { q: [string, string]; a: [string, string] }[] = [
  {
    q: ["Is it safe to use?", "Est-ce que c'est sûr ?"],
    a: [
      `${SITE.name} only reads public blockchain data. It never asks you to connect a wallet, sign anything or share a seed phrase, and nobody legitimate ever will. If a site, an app or a person in your DMs asks for that to "recover" funds, it's a scam.`,
      `${SITE.name} lit seulement des données publiques de la blockchain. Il ne vous demande jamais de connecter un wallet, de signer quoi que ce soit ou de donner votre phrase secrète, et aucun service honnête ne le fera. Si un site, une app ou quelqu'un en DM vous le demande pour « récupérer » des fonds, c'est une arnaque.`,
    ],
  },
  {
    q: ["Something was found. How do I get it back?", "Quelque chose a été trouvé. Comment le récupérer ?"],
    a: [
      'Each result has a "How to claim" button with step-by-step instructions, and the official app or contract to use. Type that address yourself (don\'t click links people send you), connect the wallet that owns the funds, and confirm the claim. The funds can only go to your own address.',
      "Chaque résultat a un bouton « Comment réclamer » avec les étapes, et l'app ou le contrat officiel à utiliser. Tapez cette adresse vous-même (ne cliquez pas sur les liens qu'on vous envoie), connectez le wallet qui détient les fonds et confirmez. Les fonds ne peuvent aller qu'à votre propre adresse.",
    ],
  },
  {
    q: ["Why would money still be waiting for me?", "Pourquoi de l'argent m'attendrait encore ?"],
    a: [
      "Many actions in crypto take two steps and the second is easy to forget: finishing a bridge withdrawal, claiming an airdrop, withdrawing a lock that expired, claiming a finalized withdrawal or rewards, swapping an old token for its new version. Until you do it, the funds stay in the contract, often for years.",
      "Beaucoup d'actions en crypto se font en deux étapes, et la deuxième s'oublie facilement : terminer un retrait de bridge, réclamer un airdrop, retirer un verrou expiré, récupérer un retrait finalisé ou des récompenses, échanger un vieux token contre sa nouvelle version. Tant que ce n'est pas fait, les fonds restent dans le contrat, souvent pendant des années.",
    ],
  },
  {
    q: ["Does it cost anything?", "Est-ce payant ?"],
    a: [
      "No. The check is free and takes no cut. Claiming is a normal transaction, so you only pay the network fee (gas) to the blockchain.",
      "Non. La vérification est gratuite et sans commission. Réclamer est une transaction normale : vous ne payez que les frais de réseau (gas) à la blockchain.",
    ],
  },
  {
    q: ["Do you keep my address?", "Gardez-vous mon adresse ?"],
    a: [
      "No. Everything runs in your browser and goes straight to public blockchain nodes and the projects' own public APIs. Your last results are kept in your own browser for 10 minutes so a reload is instant, then they're deleted. We only count visits anonymously (Vercel Analytics, no cookies), and the address is removed before anything is counted.",
      "Non. Tout tourne dans votre navigateur et interroge directement les nœuds publics des blockchains et les API publiques des projets. Vos derniers résultats restent 10 minutes dans votre navigateur pour qu'un rechargement soit instantané, puis ils sont effacés. On compte seulement les visites, de façon anonyme (Vercel Analytics, sans cookies), et l'adresse est retirée avant tout comptage.",
    ],
  },
  {
    q: ["Some checks failed. What does that mean?", "Certaines vérifications ont échoué. Ça veut dire quoi ?"],
    a: [
      "The public data sources we read from were busy or slow. It doesn't mean anything is wrong with your wallet. The site retries automatically once; press Retry on the remaining ones a little later.",
      "Les sources de données publiques qu'on interroge étaient occupées ou lentes. Ça ne veut pas dire qu'il y a un problème avec votre wallet. Le site réessaie une fois automatiquement ; appuyez sur Réessayer un peu plus tard pour les autres.",
    ],
  },
  {
    q: ["Where do the unclaimed totals come from?", "D'où viennent les montants non réclamés affichés ?"],
    a: [
      "From the blockchains themselves. For each source in the list, we read what its contract still holds for its users (a claim contract, a refund pool, an old exchange's deposits…) and convert it at the day's market price. The date is shown with the figure. Only sources whose total can be read exactly are counted, so the real total is higher, and nothing in it is an estimate.",
      "Des blockchains elles-mêmes. Pour chaque source de la liste, on lit ce que son contrat détient encore pour ses utilisateurs (un contrat de réclamation, un fonds de remboursement, les dépôts d'un ancien exchange…) et on le convertit au prix du marché du jour. La date est affichée avec le chiffre. Seules les sources dont le total se lit exactement sont comptées : le vrai total est plus élevé, et rien n'y est estimé.",
    ],
  },
  {
    q: ["What do the labels on a result mean?", "Que veulent dire les étiquettes sur un résultat ?"],
    a: [
      "“Ready to claim”: you can take it now. “Needs prove”: a withdrawal from a layer 2 that first needs a proof transaction on Ethereum, then about 7 days, then a last one. “Waiting”: it is yours but inside a waiting period, and the date it opens is shown. “Check manually”: we found it, but couldn't confirm that the claim would go through, so the note says what to look at. “In progress”: started less than a week ago, probably not forgotten.",
      "« À réclamer » : vous pouvez le récupérer maintenant. « Preuve à faire » : un retrait depuis un layer 2 qui demande d'abord une transaction de preuve sur Ethereum, puis environ 7 jours, puis une dernière transaction. « En attente » : c'est à vous mais dans une période d'attente, et la date d'ouverture est indiquée. « À vérifier » : on l'a trouvé, mais on n'a pas pu confirmer que la réclamation passerait, et la note dit quoi regarder. « En cours » : commencé il y a moins d'une semaine, sans doute pas oublié.",
    ],
  },
  {
    q: ["A guide tells me to use Etherscan's “Write Contract”. How does that work?", "Un guide me dit d'utiliser « Write Contract » sur Etherscan. Comment ça marche ?"],
    a: [
      "Some old apps have no website left, so you talk to their contract directly. Type etherscan.io yourself and paste the contract address given in the result. Open the Contract tab, then Write Contract (or Write as Proxy when the guide says so). Click Connect to Web3 and choose the wallet that owns the funds. Find the function the guide names, fill in the values exactly as given, click Write and confirm in your wallet. It is an ordinary transaction: you pay the network fee, and the funds can only go where the contract sends them, your own address. If the address on Etherscan doesn't match the one in the result, stop.",
      "Certaines vieilles apps n'ont plus de site : on parle alors directement à leur contrat. Tapez etherscan.io vous-même et collez l'adresse du contrat donnée dans le résultat. Ouvrez l'onglet Contract, puis Write Contract (ou Write as Proxy quand le guide le précise). Cliquez sur Connect to Web3 et choisissez le wallet qui détient les fonds. Trouvez la fonction nommée dans le guide, remplissez les valeurs exactement comme indiqué, cliquez sur Write et confirmez dans votre wallet. C'est une transaction ordinaire : vous payez les frais de réseau, et les fonds ne peuvent aller que là où le contrat les envoie, votre propre adresse. Si l'adresse sur Etherscan ne correspond pas à celle du résultat, arrêtez-vous.",
    ],
  },
  {
    q: ["I have several wallets. Do I need to check each one?", "J'ai plusieurs wallets. Faut-il vérifier chacun ?"],
    a: [
      "Yes. Each address has its own history, so check every one you have used, old ones included, and your Solana addresses too. You can paste up to 10 addresses at once, separated by a space: they are checked one after the other, with a total for all of them and the details of each. Money you left on an exchange account (Binance, Coinbase, Kraken…) can't be seen here: it sits in the exchange's own wallets, so log in there to look.",
      "Oui. Chaque adresse a son propre historique : vérifiez toutes celles que vous avez utilisées, même anciennes, ainsi que vos adresses Solana. Vous pouvez coller jusqu'à 10 adresses d'un coup, séparées par un espace : elles sont vérifiées l'une après l'autre, avec un total pour l'ensemble et le détail de chacune. L'argent laissé sur un compte d'exchange (Binance, Coinbase, Kraken…) ne se voit pas ici : il est dans les wallets de l'exchange, connectez-vous là-bas pour regarder.",
    ],
  },
  {
    q: ["An app or a network I used has shut down. Is my money gone?", "Une app ou un réseau que j'utilisais a fermé. Mon argent est-il perdu ?"],
    a: [
      "Often not. When a network closes properly, what its users still had is set aside in a contract on Ethereum: that is the case for zkSync Lite, Blast and Kinto, which we check. Old exchanges like EtherDelta or IDEX v1 no longer have a site, but their contracts still let you withdraw. Check your address: if something is left, the result says where and how.",
      "Souvent non. Quand un réseau ferme proprement, ce que ses utilisateurs y avaient encore est mis de côté dans un contrat sur Ethereum : c'est le cas de zkSync Lite, Blast et Kinto, que nous vérifions. De vieux exchanges comme EtherDelta ou IDEX v1 n'ont plus de site, mais leurs contrats permettent toujours de retirer. Vérifiez votre adresse : s'il reste quelque chose, le résultat dit où et comment.",
    ],
  },
  {
    q: ["Will I receive exactly the amount shown?", "Vais-je recevoir exactement le montant affiché ?"],
    a: [
      "You receive the tokens shown (for example 0.5 ETH). The dollar value is an estimate at today's market price, and it moves. Each claim also costs a network fee, paid to the blockchain: a few cents on most networks, more on Ethereum. That is why very small amounts are hidden: claiming them would cost more than they are worth.",
      "Vous recevez les tokens affichés (par exemple 0,5 ETH). La valeur en dollars est une estimation au prix du marché du jour, et elle bouge. Chaque réclamation coûte aussi des frais de réseau, payés à la blockchain : quelques centimes sur la plupart des réseaux, davantage sur Ethereum. C'est pour ça que les très petits montants sont masqués : les réclamer coûterait plus qu'ils ne valent.",
    ],
  },
  {
    q: ["Do you check the permissions (approvals) my wallet has given?", "Vérifiez-vous les autorisations (approvals) que mon wallet a données ?"],
    a: [
      "No. An approval lets an app move one of your tokens, and old ones are worth reviewing, but listing them reliably takes a dedicated indexer, and a list with gaps would be worse than none. Use a specialised tool such as revoke.cash (type it yourself): it shows them from your address alone, and revoking one is a transaction you sign in your own wallet.",
      "Non. Une autorisation permet à une app de déplacer un de vos tokens, et les anciennes méritent d'être revues, mais les lister de façon fiable demande un indexeur dédié, et une liste incomplète serait pire que pas de liste. Utilisez un outil spécialisé comme revoke.cash (tapez-le vous-même) : il les affiche à partir de votre seule adresse, et en révoquer une est une transaction que vous signez dans votre propre wallet.",
    ],
  },
  {
    q: ["Is everything covered?", "Est-ce que tout est couvert ?"],
    a: [
      "No tool can see everything. We only show what we can verify on-chain right now. For bridges and apps we don't check automatically yet, the guides below explain how to look yourself.",
      "Aucun outil ne voit tout. On affiche seulement ce qu'on peut vérifier on-chain à l'instant. Pour les bridges et apps qu'on ne vérifie pas encore automatiquement, les guides plus bas expliquent comment regarder vous-même.",
    ],
  },
];

const GLOSSARY: { term: [string, string]; text: [string, string] }[] = [
  {
    term: ["Address", "Adresse"],
    text: [
      "The public identifier of a wallet (0x… on Ethereum, a string of letters and digits on Solana). Sharing it is safe: it only lets people look, never spend.",
      "L'identifiant public d'un wallet (0x… sur Ethereum, une suite de lettres et de chiffres sur Solana). Le partager est sans risque : il permet de regarder, jamais de dépenser.",
    ],
  },
  {
    term: ["Claim", "Réclamer (claim)"],
    text: [
      "The transaction that moves funds an app holds for you into your wallet. Until you send it, they stay where they are.",
      "La transaction qui fait passer dans votre wallet des fonds qu'une app garde pour vous. Tant que vous ne l'envoyez pas, ils restent où ils sont.",
    ],
  },
  {
    term: ["Network fee (gas)", "Frais de réseau (gas)"],
    text: [
      "What the blockchain charges to process a transaction. It goes to the network, not to us or to the app.",
      "Ce que la blockchain facture pour traiter une transaction. Ils vont au réseau, ni à nous ni à l'app.",
    ],
  },
  {
    term: ["Bridge", "Bridge"],
    text: [
      "An app that moves funds from one blockchain to another. The transfer often needs a second step on the arrival side.",
      "Une app qui déplace des fonds d'une blockchain à une autre. Le transfert demande souvent une deuxième étape du côté de l'arrivée.",
    ],
  },
  {
    term: ["Layer 2 (L2)", "Layer 2 (L2)"],
    text: [
      "A cheaper network built on top of Ethereum (Base, Arbitrum, Optimism…). Getting funds back to Ethereum through its official bridge takes several steps and up to a week.",
      "Un réseau moins cher construit au-dessus d'Ethereum (Base, Arbitrum, Optimism…). Ramener des fonds sur Ethereum par son bridge officiel prend plusieurs étapes et jusqu'à une semaine.",
    ],
  },
  {
    term: ["Airdrop", "Airdrop"],
    text: [
      "Tokens a project gives to its early users. Most must be claimed, some before a deadline.",
      "Des tokens qu'un projet donne à ses premiers utilisateurs. La plupart doivent être réclamés, certains avant une date limite.",
    ],
  },
  {
    term: ["Staking, locks", "Staking, verrous"],
    text: [
      "Depositing tokens in an app to earn rewards, sometimes for a fixed time. Rewards, and tokens whose lock has ended, wait until you withdraw them.",
      "Déposer des tokens dans une app pour gagner des récompenses, parfois pour une durée fixe. Les récompenses, et les tokens dont le verrou est terminé, attendent que vous les retiriez.",
    ],
  },
  {
    term: ["Smart contract", "Smart contract"],
    text: [
      "A program on the blockchain that holds funds and follows fixed rules. It keeps working even when the company behind it is gone.",
      "Un programme sur la blockchain qui détient des fonds et suit des règles fixes. Il continue de fonctionner même quand l'entreprise derrière a disparu.",
    ],
  },
  {
    term: ["Explorer (Etherscan, Solscan)", "Explorateur (Etherscan, Solscan)"],
    text: [
      "A website that shows everything recorded on a blockchain, and lets you call a contract directly from your wallet.",
      "Un site qui affiche tout ce qui est enregistré sur une blockchain, et permet d'appeler un contrat directement depuis votre wallet.",
    ],
  },
  {
    term: ["Seed phrase", "Phrase secrète (seed phrase)"],
    text: [
      "The 12 or 24 words that control a wallet. Nobody ever needs them to help you: never type them on a website.",
      "Les 12 ou 24 mots qui contrôlent un wallet. Personne n'en a jamais besoin pour vous aider : ne les tapez jamais sur un site.",
    ],
  },
];

export function Faq() {
  return (
    <Section
      id="faq"
      eyebrow={<T en="Questions" fr="Questions" />}
      title={<T en="Good to know." fr="Bon à savoir." />}
      intro={<T en="Short answers to what people ask most." fr="Des réponses courtes aux questions les plus fréquentes." />}
    >
      <div className="mx-auto max-w-[760px] divide-y divide-[var(--border)] overflow-hidden rounded-3xl border border-line bg-surface shadow-soft">
        {QUESTIONS.map((x, i) => (
          <Reveal key={x.q[0]} delay={i * 40}>
            <details className="group px-5 py-4.5 sm:px-6">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[17px] font-semibold [&::-webkit-details-marker]:hidden">
                <span>
                  <T en={x.q[0]} fr={x.q[1]} />
                </span>
                <span className="shrink-0 text-[20px] font-normal text-text-3 transition-transform group-open:rotate-45" aria-hidden>
                  +
                </span>
              </summary>
              <p className="mt-3 text-[15px] leading-relaxed text-text-2">
                <T en={x.a[0]} fr={x.a[1]} />
              </p>
            </details>
          </Reveal>
        ))}
      </div>

      {/* The words the results and guides use, for people new to this. */}
      <Reveal className="mx-auto mt-12 max-w-[760px]">
        <h3 className="text-[21px] font-semibold tracking-tight">
          <T en="The words you will see" fr="Les mots que vous allez croiser" />
        </h3>
        <dl className="mt-5 grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {GLOSSARY.map((g) => (
            <div key={g.term[0]}>
              <dt className="text-[15px] font-semibold">
                <T en={g.term[0]} fr={g.term[1]} />
              </dt>
              <dd className="mt-1 text-[14px] leading-relaxed text-text-2">
                <T en={g.text[0]} fr={g.text[1]} />
              </dd>
            </div>
          ))}
        </dl>
      </Reveal>
    </Section>
  );
}
