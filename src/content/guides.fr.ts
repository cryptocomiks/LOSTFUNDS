import type { Guide } from "./guides";

/** French text of the guides, by guide id. Contract addresses and function names are kept as they are. */
export const GUIDES_FR: Record<string, Pick<Guide, "title" | "subtitle" | "steps" | "note" | "manual">> = {
  airdrops: {
    title: "Airdrops non réclamés",
    subtitle: "Uniswap, dYdX, COW pour GNO verrouillés, Curve, Safe, 1inch, Lido, Convex, Zora, Avantis, Lombard, Re, Doppler, Sonic, Kamino",
    steps: [
      "Uniswap, septembre 2020 : n'expire jamais, environ 12,5 millions d'UNI toujours non réclamés. Ouvrez l'app officielle Uniswap avec le wallet éligible ; si aucune invite « Claim UNI » n'apparaît, réclamez sur le MerkleDistributor (0x090D4613473dEE047c3f2706764f49E0821D256e) sur Etherscan, Write Contract → claim, avec votre index, montant et preuve tirés de la liste publiée par Uniswap (github.com/Uniswap/mrkl-drop-data-chunks).",
      "Récompenses dYdX (minage rétroactif 2021, récompenses de trading jusqu'en 2023) : pas de date limite, environ 5,9 millions de DYDX jamais réclamés. Ouvrez dydx.community avec le wallet éligible et utilisez Claim rewards ; le site lit votre montant et votre preuve dans la liste publiée par dYdX et réclame sur Ethereum.",
      "COW pour GNO verrouillés (GNO verrouillés en 2021, sur Ethereum ou Gnosis Chain) : entièrement débloqués depuis février 2026, pas de date limite. Ouvrez swap.cow.fi → Account avec le wallet éligible, sur le réseau où vous avez verrouillé, et réclamez dans la carte Locked GNO vesting.",
      "Zora, avril 2025 (Base) : pas de date limite. Ouvrez zora.co avec le wallet éligible, ou appelez claim(votre adresse) sur le contrat de réclamation (0x0000000002ba96c69b95e32caab8fc38bab8b3f8) sur Basescan, depuis le wallet éligible.",
      "Curve, août 2020 : CRV des premiers utilisateurs, entièrement débloqués. Sur le contrat de vesting (0x575CCD8e2D300e2377B43478339E364000318E2c) sur Etherscan, Write Contract → claim, avec votre adresse. N'importe qui peut l'envoyer pour vous ; les CRV vont toujours à l'adresse éligible.",
      "Safe, 2022 : seulement si vous aviez validé votre allocation à l'époque. Ouvrez app.safe.global avec le wallet éligible et réclamez les SAFE débloqués, ou appelez claimVestedTokens sur le contrat de vesting.",
      "1inch (déc. 2020), Lido (premiers stakers, janv. 2021, et LP 1inch, mars 2021) et Convex (mai 2021) : pas de date limite. Appelez claim sur le distributeur du projet sur Etherscan avec votre index, montant et preuve, issus de l'API de 1inch (governance.1inch.io), de github.com/lidofinance/airdrop-data ou de github.com/convex-eth/platform.",
      "Lombard BARD (vague 4, Ethereum) : réclamez sur claim.lombard.finance avec le wallet éligible avant le 29 octobre 2026. Re Protocol RE (Ethereum) : réclamez sur la page Hedgey (app.hedgey.finance/claim/431f05ff-38d0-4f86-a306-65d8d511d3c0) avant le 1er juillet 2027. Doppler Finance XDP (Base) : réclamez sur app.doppler.finance/airdrop avant le 28 novembre 2026, 12 h UTC.",
      "Avantis Saison 2 (Base) : la période officielle est terminée, mais le contrat paie toujours. Depuis le wallet éligible, appelez claimAirdrop() sur le contrat d'airdrop (0x7E221Ee3A68D5948c6C472A8FaC5ddeB894E2c1A) sur Basescan, Write as Proxy. Faites-le vite : Avantis peut reprendre le reste.",
      "Sonic (chaîne Sonic) : seulement si vous détenez encore des NFT d'airdrop Sonic. Débloquez-les sur my.soniclabs.com/airdrop avant le 15 octobre 2026 : ce qui sera encore verrouillé sera brûlé.",
      "Kamino Saison 3 (Solana) : la période officielle est terminée, mais les KMNO non réclamés restent on-chain jusqu'à ce que Kamino les récupère. Réclamez sur app.kamino.finance avec le wallet éligible, rapidement.",
    ],
    note: "Les tokens d'un airdrop ne peuvent aller qu'au wallet éligible. Ne signez jamais rien sur un site qui vous demande d'« approuver » des tokens pour recevoir un airdrop.",
  },
  "aave-merkl": {
    title: "Récompenses Aave et Merkl",
    subtitle: "Incitations Aave v2 et v3, récompenses Merkl sur plus de 50 chaînes",
    steps: [
      "Aave : ouvrez app.aave.com et connectez le wallet qui a gagné les récompenses. Dans le menu des marchés en haut, choisissez celui indiqué dans le résultat : le marché V3 de la chaîne (sur Ethereum, Core ou Prime), ou son marché V2 pour les récompenses Aave v2 (Ethereum, Polygon ou Avalanche).",
      "Sur le tableau de bord, cliquez sur Claim à côté de Available rewards. S'il y a plusieurs tokens, réclamez-les un par un ou tous ensemble, puis confirmez dans votre wallet. Il faut un peu de gas sur cette chaîne.",
      "Les récompenses Aave v2 sur Ethereum arrivent en stkAAVE (AAVE stakés). Gardez-les stakés, ou lancez le cooldown sur la page Staking de l'app et retirez vos AAVE une fois le cooldown terminé.",
      "Merkl : ouvrez app.merkl.xyz/users/ suivi de votre adresse, et connectez le même wallet. Vos récompenses sont listées chaîne par chaîne.",
      "Passez votre wallet sur la chaîne indiquée dans le résultat, cliquez sur Claim et confirmez. Les tokens arrivent directement sur votre adresse.",
    ],
    note: "Réclamer ne coûte que du gas : aucun frais à payer, et rien à approuver ou signer en dehors de la transaction de réclamation. Les récompenses gagnées via un smart wallet ou un vault appartiennent à l'adresse de ce contrat.",
    manual: [
      "Aave v3 : sur l'explorateur de la chaîne, ouvrez le RewardsController indiqué dans le résultat, puis Write Contract → claimRewards(assets, amount, to, reward) : les adresses des aTokens et tokens de dette détenus, 115792089237316195423570985008687907853269984665640564039457584007913129639935 (tout), votre adresse, et le token de récompense. Aave v2 fonctionne pareil sur son IncentivesController, avec claimRewards(assets, amount, to).",
      "Merkl : sur le Distributor de Merkl (0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae sur la plupart des chaînes), Write Contract → claim(users, tokens, amounts, proofs) avec votre adresse, le token, et le montant et la preuve que l'API de Merkl donne pour vous (api.merkl.xyz/v4/users/<votre adresse>/rewards?chainId=<id de chaîne>).",
    ],
  },
  rewards: {
    title: "Récompenses et retraits non réclamés",
    subtitle: "Lido, verrous expirés, frais Curve et Balancer, EigenLayer, Aave, Synthetix, Convex",
    steps: [
      "Retraits Lido : ouvrez stake.lido.fi/withdrawals/claim avec le wallet qui détient la demande de retrait (un NFT unstETH), sélectionnez les demandes prêtes et cliquez sur Claim. Une demande encore en attente devient réclamable quand Lido la finalise, en général sous 1 à 5 jours. L'ETH n'est jamais envoyé automatiquement.",
      "Verrous expirés : quand un verrou vote-escrow se termine, rien n'est renvoyé. Retirez depuis l'app du protocole, avec le wallet qui a verrouillé : curve.finance (DAO → Lock) pour veCRV, balancer.fi pour veBAL, app.frax.finance pour veFXS, stakedao.org pour veSDT, app.pendle.finance/vependle pour vePENDLE, convexfinance.com pour vlCVX. Sur Etherscan, c'est withdraw() sur le contrat de verrouillage (processExpiredLocks avec false pour vlCVX).",
      "N'attendez pas avec vlCVX : 4 semaines après la fin d'un verrou, n'importe qui peut le traiter à votre place et garder une commission prélevée dessus, qui augmente chaque semaine.",
      "Frais Curve : les détenteurs de veCRV touchent chaque semaine une part des frais de Curve, en 3CRV et, depuis mi-2024, en crvUSD. Réclamez-les sur la page DAO de curve.finance, ou appelez claim avec votre adresse sur le fee distributor sur Etherscan (3CRV : 0xA464e6DCda8AC41e03616F95f4BC98a13b8922Dc, crvUSD : 0xD16d5eC345Dd86Fb63C6a9C43c517210F1027914). Une réclamation couvre jusqu'à 50 semaines : recommencez jusqu'à ce qu'elle ne paie plus rien.",
      "Frais Balancer : les détenteurs de veBAL touchent des BAL et des USDC chaque semaine. Réclamez-les sur balancer.fi (veBAL), ou appelez claimTokens sur le fee distributor (0xD3cf852898b21fc233251427c2DC93d3d604F3BB). Une réclamation couvre jusqu'à 20 semaines.",
      "Retraits EigenLayer : environ 14 jours après la mise en file d'un retrait, terminez-le sur app.eigenlayer.xyz avec le wallet qui l'a demandé. Les EIGEN reviennent en bEIGEN, convertibles 1:1 en EIGEN.",
      "Récompenses EigenLayer : ouvrez app.eigenlayer.xyz avec le wallet qui les a gagnées (ou l'adresse de réclamation qu'il a définie) et réclamez. Les récompenses en tokens sans prix de marché ne sont pas affichées ici.",
      "Safety Module d'Aave : ouvrez app.aave.com, allez dans Staking avec le wallet qui a staké et réclamez les récompenses AAVE. Elles restent réclamables après le déstaking.",
      "Escrow Synthetix : ouvrez le contrat RewardEscrowV2 sur Etherscan (Ethereum : 0xFAd53Cc9480634563E8ec71E8e693Ffd07981d38) ou Optimistic Etherscan (OP Mainnet : 0x5Fc9B8d2B7766f061bD84a41255fD1A76Fd1FAa2), connectez le wallet qui a staké, puis Write Contract → vest avec vos identifiants d'entrées. Le résultat les liste quand il y en a peu ; sinon getAccountVestingEntryIDs (Read Contract : votre adresse, 0, 1000) les donne tous, et les passer tous fonctionne.",
      "Staking Convex : les CVX ou cvxCRV stakés dans les pools d'origine de Convex continuent de gagner des récompenses qui attendent d'être réclamées. Réclamez-les sur convexfinance.com avec le wallet qui a staké.",
    ],
    note: "Chaque réclamation est une transaction ordinaire depuis votre propre wallet, et les fonds vont toujours à votre adresse. Aucun service honnête ne vous demandera votre phrase secrète, ni d'« approuver » des tokens pour les recevoir.",
  },
  reclaim: {
    title: "SOL récupérable",
    subtitle: "Comptes de tokens vides, SOL wrappé, stake inactif, tickets Marinade",
    steps: [
      "Comptes de tokens vides : chaque token que votre wallet a détenu a son propre compte, qui bloque une caution d'environ 0,002 SOL (un peu plus pour certains tokens Token-2022). Une fois le solde à 0, fermer le compte vous rend la caution. Aucun token n'est touché, et le compte se rouvre simplement si vous recevez ce token plus tard.",
      "Dans Solflare, ouvrez le token qui affiche un solde de 0, touchez ⋯ → Close Account et validez : le SOL arrive tout de suite dans votre wallet. Pour en fermer beaucoup d'un coup, Sol Incinerator (tapez sol-incinerator.com vous-même) ferme tous les comptes vides en quelques transactions et garde environ 2 % de la caution comme commission.",
      "SOL wrappé (wSOL), souvent laissé après un swap : ouvrez Wrapped SOL dans Phantom ou Solflare, touchez ⋯ → Unwrap. Le compte est fermé et tout son solde, caution comprise, revient en SOL.",
      "Stake inactif : le SOL déstaké reste dans son compte de stake tant que vous ne le retirez pas. Dans Phantom, ouvrez le compte de stake marqué Inactive et touchez Withdraw Stake ; dans Solflare, ouvrez Staking et touchez Withdraw sur le compte. Tout le solde revient dans votre wallet et le compte de stake est fermé.",
      "Le stake encore Active ou Deactivating n'est pas perdu : déstakez-le d'abord si vous voulez le récupérer, attendez la fin de l'epoch (2 à 3 jours), puis retirez.",
      "Tickets de déstaking Marinade : un déstaking différé de mSOL vous a donné un ticket, et le SOL attend dans la réserve de Marinade jusqu'à ce qu'il soit réclamé. Ouvrez app.marinade.finance avec le même wallet et réclamez-le ; si l'app ne l'affiche pas, l'outil en ligne de commande de Marinade ci-dessous le peut.",
    ],
    note: "Ne fermez des comptes que depuis votre propre wallet ou un outil dont vous avez tapé l'adresse vous-même, et ne signez jamais une demande « close account », « burn » ou « claim SOL » venant d'un site trouvé via un DM, une pub ou un token reçu par airdrop : une transaction malveillante peut vider votre wallet. Fermer rend la caution sans rien brûler uniquement quand le solde est à 0 : les outils qui « brûlent et ferment » détruisent les tokens encore présents. Fermer un compte de stake efface son historique de récompenses de la blockchain : exportez-le d'abord si vous en avez besoin pour vos impôts.",
    manual: [
      "Avec les outils Solana en ligne de commande : spl-token close --address <COMPTE_DE_TOKEN_VIDE> ferme un compte de token vide (Token ou Token-2022), et spl-token unwrap <COMPTE_WSOL> unwrappe le SOL wrappé.",
      "solana withdraw-stake <COMPTE_DE_STAKE> <VOTRE_WALLET> ALL retire tout le solde d'un compte de stake inactif vers votre wallet.",
      "L'outil en ligne de commande de Marinade (paquet npm @marinade.finance/marinade-ts-cli) : marinade show-tickets liste vos tickets, marinade claim <TICKET> en réclame un. Le SOL va toujours au wallet qui a demandé le déstaking.",
    ],
  },
  legacy: {
    title: "Vieux tokens et migrations",
    subtitle: "The DAO, Maker SAI et PETH, MKR de 2016, DigixDAO, Golem GNT, Kyber KNCL, ancien ETH wrappé",
    steps: [
      "Aucun de ces vieux tokens n'a encore de vrai marché, mais le contrat officiel de chacun paie toujours, sans date limite. Vous envoyez les transactions vous-même, depuis le wallet qui détient les tokens, sur Etherscan (Write Contract, connecté à ce wallet). Les montants sont dans la plus petite unité du token : copiez votre solde exact depuis Read Contract → balanceOf.",
      "The DAO (2016) : 100 DAO = 1 ETH. Sur le token DAO (0xBB9bc244D798123fDe783fCc1C72d3Bb8C189413), approuvez le contrat WithdrawDAO (0xBf4eD7b27F1d666546E30D74d50d173d20bca754) pour votre solde, puis appelez withdraw() sur WithdrawDAO : il prend tous vos DAO et envoie l'ETH dans la même transaction. Le TheDAO Security Fund (thedao.fund) n'a aucun pouvoir sur ce contrat.",
      "Tokens TheDAO ExtraBalance (0x5c40eF6f527f4FbA68368774E6130cE6515123f2) : approuvez le contrat de retrait ExtraBalance (0x755cdba6AE4F479f7164792B318b2a06c759833B), puis appelez withdraw() dessus : 1 ETH par token. Le TheDAO Security Fund le garde approvisionné pour les réclamations.",
      "Maker SAI (Dai mono-collatéral, arrêté en mai 2020) : approuvez le SaiTap (0xBda109309f9FafA6Dd6A9CB9f1Df4085B27Ee8eF) sur le token SAI, puis appelez cash(votre solde) sur le SaiTap : environ 0,0053 ETH par SAI, payé en WETH. PETH : approuvez le SaiTub (0x448a5065aeBB8E423F0896E6c5D525C040f59af3) sur le token PETH, puis appelez exit(votre solde) sur le SaiTub : environ 1,05 ETH par PETH, en WETH. Unwrappez le WETH avec withdraw sur le contrat WETH (0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2).",
      "MKR de 2016 (0xC66eA802717bFb9833400264Dd12c2bCeAa34a6d, remplacé en décembre 2017) : approuvez le MKR Redeemer (0x642AE78FAfBB8032Da552D619aD43F1D81E4DD7C), puis appelez redeem() dessus : tous vos anciens MKR deviennent des MKR actuels, 1:1.",
      "DigixDAO (DGD) : approuvez le contrat Acid de DigixDAO (0x23Ea10CC1e6EBdB499D24E45369A35f43627062f) sur le token DGD, puis appelez burn() sur Acid : il prend tout votre solde de DGD et envoie 0,193 ETH par DGD.",
      "Golem (GNT → GLM, 1:1) : utilisez migrate.golem.network, ou appelez migrate(votre solde) sur le contrat GNT (0xa74476443119A942dE498590Fe1f2454d7D4aC0d). Aucune approbation nécessaire.",
      "Kyber (KNCL → KNC, 1:1) : utilisez Migrate sur kyberswap.com/kyberdao/stake-knc, ou approuvez le contrat KNC (0xdeFA4e8a7bcBA345F687a2f1456F5Edd9CE97202) sur KNCL, puis appelez mintWithOldKnc(votre solde) dessus.",
      "Ancien ETH wrappé, d'avant le WETH actuel (W-ETH 0xECF8F87f810EcF450940c9f60066b4a7a501d6A7, WETH de 0x de 2017 0x2956356cD2a2bf3202F771F50D3D14A367b48070, token ETH de Bancor de 2017 0xD76b5c2A23ef78368d8E34288B5b65D616B746aE) : appelez withdraw(votre solde) sur le contrat du token. L'ETH revient 1:1.",
    ],
    note: "N'approuvez que le contrat indiqué ici, pour votre solde exact, et jamais sur un site trouvé via un DM ou une pub. Absents de la liste parce que la voie officielle est fermée ou que le vieux token s'échange encore à pleine valeur : LEND → AAVE (fermé en mai 2026), REP v1 (fork d'Augur en 2026), Aragon ANT (rachat terminé en novembre 2024), AGIX → FET, MATIC → POL, MKR → SKY, OCEAN, RNDR.",
    manual: [
      "Certains contrats de 2016 (le token DAO, les contrats ExtraBalance, W-ETH) n'ont pas forcément d'onglet Write Contract. Envoyez plutôt une transaction de 0 ETH au contrat avec les données d'appel : withdraw() correspond à 0x3ccfd60b ; approve à 0x095ea7b3, suivi de l'adresse autorisée et du montant, chacun complété à 32 octets.",
      "Un assistant IA équipé d'outils Ethereum peut préparer ces transactions sous forme de données non signées, que vous vérifiez et signez dans votre propre wallet. Ne donnez jamais votre clé privée à personne.",
    ],
  },
  "legacy-deposits": {
    title: "Anciens exchanges, dépôts ENS et staking",
    subtitle: "EtherDelta, IDEX v1, Token.Store, SingularX, Switcheo, actes d'enchères ENS, staking Polygon, coffres Maker SCD",
    steps: [
      "EtherDelta et ForkDelta (2016–2022), Token.Store et SingularX : ce que vous avez laissé sur ces exchanges est toujours dans leurs contrats, et vous pouvez le retirer à tout moment, seul. Pour le contrat principal d'EtherDelta, la page de retrait de ForkDelta (forkdelta.app/shutdown/withdraw) liste vos soldes. Sinon, sur Etherscan : ouvrez le contrat indiqué dans le résultat, Write Contract, connectez votre wallet et appelez withdraw(amount) pour l'ETH ou withdrawToken(token, amount) pour un token, avec le montant donné dans le résultat.",
      "IDEX v1 (2017–2020) : IDEX ne traite plus les retraits, mais son contrat (0x2a0c0DBEcC7E4D658f48E01e3fA353F44050c208) vous laisse retirer seul dès que votre compte n'a eu aucune activité pendant 240 blocs (moins d'une heure). Sur Etherscan, Write Contract → withdraw(token, amount), avec le token 0x0000000000000000000000000000000000000000 pour l'ETH.",
      "Switcheo (contrat Ethereum 0x7ee7Ca6E75dE79e618e88bDf80d0B1DB136b22D0) : sa sortie de secours demande deux transactions sur Etherscan, Write Contract : announceWithdraw(assetId, amount), puis slowWithdraw(votre adresse, assetId, amount), avec l'assetId 0x0000000000000000000000000000000000000000 pour l'ETH. Le délai entre les deux est actuellement nul.",
      "Dépôts d'enchères ENS (2017–2019) : l'ETH payé pour un nom .eth est bloqué dans l'acte (deed) du nom. Sur Etherscan, ouvrez l'ancien registrar d'ENS (0x6090A6e47849629b7245Dfa1Ca21D94cd15878Ef), Write Contract → releaseDeed(hash), avec le hash donné dans le résultat, depuis le wallet propriétaire de l'acte. Tout l'ETH revient à ce wallet ; le propriétaire actuel du nom ne change pas.",
      "Staking Polygon : les récompenses, et les POL déstakés dont la période d'attente est finie, se réclament sur staking.polygon.technology avec le wallet qui a staké. Les POL encore délégués à un validateur qui a cessé de valider ne rapportent rien : déstakez-les là-bas, attendez 80 checkpoints (environ un jour), puis réclamez-les.",
      "Coffres Maker Single-Collateral Dai (CDP, arrêtés en 2020) : si le coffre a encore une dette, n'importe qui peut la solder avec bite(cup) sur le Tub (0x448a5065aeBB8E423F0896E6c5D525C040f59af3). Ensuite le propriétaire retire le reste : pour un coffre ouvert via le CDP Portal de Maker, appelez execute sur votre DSProxy avec la cible et les données données dans le résultat (l'ETH arrive directement dans votre wallet) ; pour un coffre détenu directement par votre wallet, appelez free sur le Tub, approuvez le Tub pour ces PETH, appelez exit, puis unwrappez le WETH.",
    ],
    note: "Chacune de ces actions est une transaction Ethereum ordinaire envoyée depuis votre propre wallet. Personne ne peut retirer à votre place, et vous n'avez jamais besoin de partager une clé ou de signer un message pour ça. Vérifiez l'adresse du contrat sur Etherscan avant d'envoyer quoi que ce soit.",
    manual: [
      "Etherscan attend les montants dans la plus petite unité du token (pour l'ETH, 1 ETH = 1000000000000000000). Le résultat donne le nombre exact à coller ; vous pouvez aussi le lire avec Read Contract → balanceOf(token, votre adresse), token 0x0000000000000000000000000000000000000000 pour l'ETH.",
      "Staking Polygon sur Etherscan : sur le contrat du validateur, Write as Proxy → withdrawRewardsPOL() pour les récompenses, unstakeClaimTokens_newPOL(nonce) pour un déstaking dont la période d'attente est finie, sellVoucher_newPOL(montant, nombre maximum de parts à brûler) pour déstaker.",
    ],
  },
  opstack: {
    title: "Chaînes OP Stack",
    subtitle: "Base, OP Mainnet, Mantle, World Chain, Blast, Celo, Unichain, Ink, Manta Pacific, Boba…",
    steps: [
      "Ouvrez le bridge officiel de la chaîne (la plupart des chaînes OP Stack utilisent Superbridge) et connectez le wallet qui a fait le retrait.",
      "Allez dans l'onglet activité ou historique et retrouvez le retrait.",
      "S'il indique Prove, cliquez et confirmez sur Ethereum. Attendez ensuite environ 7 jours (moins sur quelques chaînes, par exemple 12 heures sur Mantle).",
      "Quand il indique Finalize ou Claim, cliquez et confirmez sur Ethereum. Les fonds sont envoyés à votre adresse.",
    ],
    note: "Déjà prouvé ? Il ne reste que l'étape de finalisation. Les deux étapes sont des transactions Ethereum ordinaires depuis votre propre wallet. Les retraits OP Mainnet d'avant le 6 juin 2023 (mise à jour Bedrock) n'apparaissent souvent pas dans les apps de bridge : utilisez les étapes manuelles ci-dessous.",
    manual: [
      "Les retraits OP Mainnet d'avant Bedrock ont été convertis au nouveau format lors de la mise à jour. Ils se réclament toujours de la même façon : prouver sur Ethereum, attendre environ 7 jours, puis finaliser.",
      "Pour reconstruire le retrait converti, partez de votre ancienne transaction L2 : l'ancien SentMessage devient un retrait envoyé au L1CrossDomainMessenger d'OP (0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1). Appelez proveWithdrawalTransaction sur l'OptimismPortal (0xbEb5Fc579115071764c7423A4f12eDde41f106Ed) avec le dernier dispute game et une preuve de stockage du L2 message passer.",
      "Après environ 7 jours, appelez finalizeWithdrawalTransaction (ou finalizeWithdrawalTransactionExternalProof si quelqu'un d'autre l'a prouvé). Les fonds sont relayés vers votre adresse.",
      "Un assistant IA équipé d'outils Ethereum peut préparer ces transactions sous forme de données non signées, que vous vérifiez et signez dans votre propre wallet. Ne donnez jamais votre clé privée à personne.",
    ],
  },
  arbitrum: {
    title: "Arbitrum et chaînes Orbit",
    subtitle: "Arbitrum One, Nova, Robinhood Chain, Plume, Gravity…",
    steps: [
      "Ouvrez le bridge officiel d'Arbitrum (Arbitrum One, Nova) ou le bridge de votre chaîne Orbit (Robinhood Chain, Plume, Gravity) et connectez le wallet qui a fait le retrait.",
      "Ouvrez l'historique des transactions et cherchez les retraits marqués Claimable.",
      "Les retraits deviennent réclamables environ 7 jours après leur envoi (la période de contestation).",
      "Cliquez sur Claim et confirmez sur Ethereum (ou sur la chaîne parente de la chaîne Orbit). Les fonds sont libérés vers votre adresse.",
    ],
    note: "Les retraits d'avant la mise à jour Nitro (31 août 2022) sont toujours réclamables, mais certaines apps les masquent. Sur les chaînes qui ont leur propre token de gas, les retraits de ce token sont payés sur Ethereum dans ce même token (PLUME depuis Plume, G depuis Gravity), pas en ETH.",
    manual: [
      "Chaque retrait a une position dans l'Outbox. Obtenez la preuve en appelant constructOutboxProof sur le NodeInterface (0x00000000000000000000000000000000000000C8) de la chaîne d'où vous avez retiré.",
      "Appelez ensuite executeTransaction sur le contrat Outbox de cette chaîne sur Ethereum avec cette preuve et les champs de votre événement L2ToL1Tx. Outbox : Arbitrum One 0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840, Nova 0xD4B80C3D7240325D18E645B49e6535A3Bf95cc58, Robinhood Chain 0xf0ce991ea4A0d2400A4AB49b20ae333f6Dce3DE9, Plume 0x7e4627bC114Fcd12ba912103279FD2858E644E71, Gravity 0x1153a1e4B1523DFf36f77d696bd6eBF2B0e7DAbF.",
    ],
  },
  "polygon-pos": {
    title: "Polygon PoS",
    subtitle: "Retraits brûlés sur Polygon, jamais sortis sur Ethereum",
    steps: [
      "Ouvrez le Polygon Portal officiel et connectez le wallet qui a fait le retrait.",
      "Ouvrez l'historique des transactions et retrouvez le retrait.",
      "Après le checkpoint (en général 1 à 3 heures), le retrait affiche Claim.",
      "Cliquez sur Claim et confirmez sur Ethereum. Les fonds sont libérés du bridge vers votre adresse.",
    ],
    note: "La vérification en direct couvre les tokens et l'ETH (WETH) retirés via le bridge PoS. Les retraits de POL / MATIC natifs via l'ancien bridge Plasma ne sont pas vérifiés automatiquement : ils ont une attente supplémentaire de 7 jours et une dernière étape Process exit dans le Portal.",
    manual: [
      "Construisez les données de sortie de votre transaction de burn avec l'API de génération de preuves de Polygon (proof-generator.polygon.technology), puis appelez exit(bytes) sur le RootChainManager (0xA0c68C638235ee32657e8f720a23ceC1bFc77C77) sur Ethereum, depuis n'importe quel wallet : les fonds vont toujours à l'adresse qui les a brûlés.",
    ],
  },
  zksync: {
    title: "ZKsync Era et chaînes ZK Stack",
    subtitle: "ZKsync Era, Abstract, Sophon, Lens, Cronos zkEVM",
    steps: [
      "Un retrait peut être réclamé sur Ethereum une fois son batch exécuté là-bas : environ 4 heures sur ZKsync Era et Abstract, jusqu'à un jour ou deux sur Sophon, Lens et Cronos zkEVM. Pas d'attente de 7 jours.",
      "Personne ne le réclame pour vous. Ouvrez le bridge officiel de la chaîne (portal.zksync.io pour ZKsync Era) et connectez le wallet qui a fait le retrait.",
      "Retrouvez le retrait dans l'historique. S'il affiche Claim ou Finalize, cliquez et confirmez sur Ethereum.",
    ],
    note: "La réclamation est une transaction Ethereum ordinaire, qui peut être envoyée depuis n'importe quel wallet : les fonds vont toujours au destinataire défini lors du retrait. Les retraits du token de gas (SOPH, LGHO, zkCRO) arrivent dans ce token sur Ethereum. Utilisateurs d'Abstract Global Wallet : vérifiez l'adresse de votre smart account, pas celle du signataire.",
    manual: [
      "Obtenez la preuve avec zks_getL2ToL1LogProof(hash de votre transaction L2, index de son log L2→L1, en général 0) sur le RPC de la chaîne. Le reçu de la transaction donne le numéro de batch (l1BatchNumber) et l'index dans le batch (l1BatchTxIndex) ; le message est la donnée de son log L1MessageSent.",
      "Sur Ethereum, appelez finalizeDeposit sur le L1Nullifier (0xD7f9f54194C633F36CCD5F3da84ad4a1c38cB2cB) avec l'id de la chaîne, le numéro de batch, l'id de la preuve, le contrat L2 qui a envoyé le message (0x…800A pour l'ETH ou le token de gas), l'index dans le batch, le message et la preuve.",
      "Un assistant IA équipé d'outils Ethereum peut préparer cette transaction sous forme de données non signées, que vous vérifiez et signez dans votre propre wallet. Ne donnez jamais votre clé privée à personne.",
    ],
  },
  "zksync-lite": {
    title: "zkSync Lite (fermé)",
    subtitle: "zkSync 1.0 a été arrêté en mai 2026",
    steps: [
      "Les soldes restés sur zkSync Lite se récupèrent via la procédure de sortie officielle publiée par Matter Labs.",
      "Suivez les instructions de fermeture de zkSync Lite dans la documentation officielle de ZKsync. N'utilisez que les liens que vous y trouvez.",
    ],
  },
  sonic: {
    title: "Sonic Gateway",
    subtitle: "Retraits Sonic → Ethereum",
    steps: [
      "Ouvrez l'app officielle Gateway de Sonic et connectez le wallet qui a fait le retrait.",
      "Retrouvez le transfert dans l'historique. Une fois le prochain heartbeat passé, il affiche Claim.",
      "Cliquez sur Claim et confirmez sur Ethereum.",
    ],
  },
  debridge: {
    title: "deBridge (ordres DLN)",
    subtitle: "Ordres sur n'importe quelle route (plus de 30 chaînes, Solana, Tron) jamais exécutés",
    steps: [
      "Ouvrez l'app officielle deBridge et connectez votre wallet.",
      "Retrouvez l'ordre non exécuté dans votre historique d'ordres.",
      "Annulez-le. L'annulation part de la chaîne de destination, puis les fonds vous sont rendus sur la chaîne d'origine.",
    ],
  },
  celer: {
    title: "Celer cBridge",
    subtitle: "Transferts échoués dont le remboursement n'a jamais été récupéré",
    steps: [
      "Ouvrez l'app officielle cBridge (cbridge.celer.network) et connectez le wallet qui a envoyé le transfert.",
      "Ouvrez l'historique des transferts et retrouvez le transfert échoué. Il propose de confirmer le remboursement (les plus anciens peuvent d'abord demander de le solliciter).",
      "Confirmez la transaction sur la chaîne d'envoi. Le remboursement revient à l'adresse d'envoi ; le WETH est remboursé en ETH.",
    ],
    note: "Le remboursement est payé par le pool de cBridge sur la chaîne d'envoi : il vous faut un peu de gas sur cette chaîne.",
  },
  synapse: {
    title: "Synapse",
    subtitle: "Demandes de bridge jamais mintées par le validateur",
    steps: [
      "Cherchez la transaction d'origine sur l'explorateur Synapse pour voir son statut.",
      "Si elle ne s'est jamais terminée, contactez Synapse via le canal de support officiel indiqué sur leur site. Aucun service honnête ne vous écrira en premier.",
    ],
  },
  lighter: {
    title: "Lighter",
    subtitle: "Soldes de retrait en attente sur Ethereum",
    steps: [
      "Ouvrez l'app officielle Lighter et connectez votre wallet.",
      "Les retraits en attente restent dans le contrat Lighter sur Ethereum jusqu'à ce que vous les réclamiez.",
      "Utilisez l'action claim / withdraw et confirmez sur Ethereum.",
    ],
  },
  linea: {
    title: "Linea",
    subtitle: "Surtout les retraits envoyés sans frais de relais",
    steps: [
      "Ouvrez le bridge officiel de Linea et connectez le wallet qui a fait le retrait.",
      "Ouvrez l'historique des transactions. Les retraits deviennent réclamables une fois le bloc L2 finalisé sur Ethereum (en général 8 à 32 heures).",
      "Cliquez sur Claim et confirmez sur Ethereum.",
    ],
    note: "Les retraits envoyés sans frais ne sont jamais réclamés automatiquement : vous devez faire la dernière étape vous-même.",
    manual: [
      "Appelez claimMessageWithProof sur le contrat LineaRollup (0xd19d4B5d358258f05D7B411E21A1460D11B0876F) sur Ethereum avec les champs du message et la preuve de Merkle fournie par le SDK de Linea.",
    ],
  },
  scroll: {
    title: "Scroll",
    steps: [
      "Ouvrez le bridge officiel de Scroll et connectez le wallet qui a fait le retrait.",
      "Ouvrez l'historique des transactions. Les retraits deviennent réclamables une fois leur batch finalisé (en général en quelques heures).",
      "Cliquez sur Claim et confirmez sur Ethereum.",
    ],
    manual: [
      "Récupérez la preuve de retrait via l'API d'historique du bridge de Scroll, puis appelez relayMessageWithProof sur le L1ScrollMessenger (0x6774Bcbd5ceCeF1336b5300fb5186a12DDD8b367).",
    ],
  },
  starknet: {
    title: "Starknet (StarkGate)",
    steps: [
      "Ouvrez StarkGate et connectez vos wallets Starknet et Ethereum.",
      "Une fois le bloc L2 prouvé sur Ethereum (quelques heures), le retrait affiche Withdraw / Complete.",
      "Confirmez la transaction sur Ethereum pour recevoir les fonds.",
    ],
  },
  starkex: {
    title: "Apps StarkEx",
    subtitle: "dYdX v3, Immutable X, Sorare, rhino.fi, ApeX, Myria, tanX…",
    steps: [
      "Si l'app fonctionne encore, utilisez son parcours de retrait. La dernière étape est une transaction sur Ethereum.",
      "Si l'app a fermé, StarkEx a une sortie de secours : demandez un retrait forcé sur Ethereum ; si l'opérateur ne le traite pas, l'exchange peut être gelé et les fonds retirés avec une preuve.",
      "Suivez d'abord le guide officiel de fermeture ou de récupération de l'app.",
    ],
  },
  cctp: {
    title: "Circle CCTP (USDC)",
    subtitle: "USDC brûlés et attestés, jamais mintés sur la chaîne de destination",
    steps: [
      "Rouvrez l'app utilisée pour le transfert (Circle, Jupiter, Mayan, Portal…). Beaucoup ont une option Resume ou Redeem pour les transferts inachevés.",
      "Si l'app s'est désignée comme seul relayeur autorisé, seule cette app peut terminer le transfert.",
      "Sinon, n'importe qui peut le terminer : récupérez le message et l'attestation de votre transaction de burn via l'API d'attestation de Circle, puis soumettez-les au MessageTransmitter de la chaîne de destination (receiveMessage). Les USDC sont mintés pour le destinataire défini au moment du burn.",
      "Si l'attestation a expiré (transferts CCTP V2 rapides), demandez d'abord à l'API de Circle de réattester le message, puis soumettez la nouvelle attestation.",
    ],
    note: "Les USDC ne peuvent être mintés que pour le destinataire choisi au moment du burn. Personne d'autre ne peut les recevoir. Circle arrête CCTP V1 : ses contrats seront mis en pause le 1er décembre 2026, mintez donc vos transferts V1 avant cette date.",
  },
  layerzero: {
    title: "LayerZero",
    subtitle: "Messages arrivés sur Ethereum mais jamais exécutés",
    steps: [
      "Cherchez la transaction d'origine sur LayerZero Scan.",
      "Si le message est stocké ou en échec, relancez-le depuis l'app utilisée ou depuis LayerZero Scan.",
      "Confirmez la transaction sur la chaîne de destination.",
    ],
  },
  wormhole: {
    title: "Wormhole",
    subtitle: "Transferts Portal et NTT jamais récupérés à destination, sur toutes les routes",
    steps: [
      "Ouvrez le Wormhole Portal officiel et choisissez l'option redeem / resume transaction.",
      "Collez le hash de la transaction d'origine (ou ouvrez-la depuis Wormholescan). Le message signé (VAA) est récupéré automatiquement.",
      "Connectez votre wallet sur la chaîne de destination et récupérez les fonds. Pour les tokens NTT, utilisez l'app de bridge du token (ou Wormhole Connect).",
    ],
    note: "Récupérer demande un peu de gas sur la chaîne de destination (SOL sur Solana, ETH sur Ethereum…). Les transferts signés par un ancien ensemble de gardiens (avant fin juin 2026) ne peuvent pas être récupérés tant que les gardiens ne les ont pas signés à nouveau : demandez au support de Wormhole de réobserver le transfert.",
  },
  rainbow: {
    title: "NEAR Rainbow Bridge",
    steps: [
      "Ouvrez l'app officielle Rainbow Bridge et connectez les deux wallets.",
      "Ouvrez vos transferts. Les transferts NEAR → Ethereum peuvent être finalisés après la mise à jour du light client (quelques heures).",
      "Cliquez sur Finalize et confirmez la transaction.",
    ],
  },
  agglayer: {
    title: "Agglayer / Polygon zkEVM",
    subtitle: "Y compris la sortie liée à la fermeture de Polygon zkEVM",
    steps: [
      "Ouvrez le Polygon Portal officiel et connectez votre wallet.",
      "Retrouvez la transaction de bridge. Une fois prête, elle affiche Claim sur la chaîne de destination.",
      "Pour Polygon zkEVM, suivez les instructions officielles de fermeture pour sortir avant la date limite annoncée.",
    ],
  },
  gnosis: {
    title: "Gnosis Bridge",
    subtitle: "Transferts OmniBridge et bridge xDAI vers Ethereum jamais réclamés",
    steps: [
      "Ouvrez l'app officielle du bridge Gnosis (bridge.gnosischain.com) et connectez le wallet qui a envoyé le transfert (pour le bridge xDAI, le wallet qui reçoit les DAI).",
      "Retrouvez le transfert dans vos transactions, ou cherchez-le par son hash de transaction Gnosis. Une fois signé par les validateurs du bridge, il affiche Claim.",
      "Cliquez sur Claim et confirmez sur Ethereum. Les tokens (DAI ou USDS pour le bridge xDAI) vont à l'adresse choisie lors de l'envoi.",
    ],
    note: "Réclamez vite. Un transfert ne peut être réclamé qu'avec les signatures des validateurs actuels du bridge : après un changement de validateurs, les anciens transferts non réclamés sont refusés sur Ethereum et seule l'équipe du bridge Gnosis peut aider. Aucun service honnête ne vous écrira en premier.",
    manual: [
      "N'importe qui peut envoyer la réclamation pour vous : c'est executeSignatures(message, signatures) sur Ethereum, sur l'AMB (0x4C36d2919e407f0Cc2Ee3c993ccF8ac26d9CE64e) pour OmniBridge ou sur le bridge xDAI (0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016).",
      "Le message et les signatures des validateurs sont stockés sur Gnosis, sur l'AMB (0x75Df5AF045d91108662D8080fD1FEFAd6aA0bb59) ou le bridge xDAI (0x7301CFA0e1756B71869E93d4e4Dca5c7d0eb0AA6) : numMessagesSigned et signature, indexés par le keccak256 du message.",
    ],
  },
  ronin: {
    title: "Ronin",
    steps: [
      "Ouvrez le Ronin Bridge officiel et connectez votre wallet Ronin.",
      "Retrouvez le retrait en attente et réclamez-le sur Ethereum.",
      "Si les signatures ont expiré, l'app propose d'en demander de nouvelles.",
    ],
  },
  taiko: {
    title: "Taiko",
    steps: [
      "Ouvrez le bridge officiel de Taiko et connectez votre wallet.",
      "Retrouvez le transfert. Les transferts envoyés sans frais de traitement doivent être réclamés par vous.",
      "Cliquez sur Claim quand il est prêt et confirmez sur la chaîne de destination.",
    ],
  },
  morph: {
    title: "Morph",
    steps: [
      "Ouvrez le bridge officiel de Morph et connectez votre wallet.",
      "Une fois le batch finalisé sur Ethereum, le retrait affiche Claim.",
      "Cliquez sur Claim et confirmez sur Ethereum.",
    ],
  },
  sui: {
    title: "Sui Bridge",
    steps: [
      "Ouvrez l'app officielle Sui Bridge et connectez les deux wallets.",
      "Retrouvez le transfert. Une fois approuvé par les validateurs, il peut être réclamé sur la chaîne de destination.",
      "Cliquez sur Claim et confirmez la transaction.",
    ],
  },
};
