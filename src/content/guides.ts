export interface Guide {
  id: string;
  title: string;
  /** Short line shown next to the title. */
  subtitle?: string;
  /** Checked automatically by the checker. */
  live?: boolean;
  steps: string[];
  note?: string;
  /** Optional "do it yourself" steps for when the app doesn't show the withdrawal. */
  manual?: string[];
}

export const GUIDES: Guide[] = [
  {
    id: "airdrops",
    title: "Unclaimed airdrops",
    subtitle: "Uniswap, Curve, Safe, 1inch, Lido, Convex, Zora, Sonic, Kamino",
    live: true,
    steps: [
      "Uniswap, September 2020: never expires, around 12.5 million UNI still unclaimed. Open the official Uniswap app with the eligible wallet; if no Claim UNI prompt shows, claim on the MerkleDistributor (0x090D4613473dEE047c3f2706764f49E0821D256e) on Etherscan, Write Contract → claim, with your index, amount and proof from Uniswap's published list (github.com/Uniswap/mrkl-drop-data-chunks).",
      "Zora, April 2025 (Base): no deadline. Open zora.co with the eligible wallet, or call claim(your address) on the claim contract (0x0000000002ba96c69b95e32caab8fc38bab8b3f8) on Basescan, from the eligible wallet.",
      "Curve, August 2020: early-user CRV, fully vested. On the vesting contract (0x575CCD8e2D300e2377B43478339E364000318E2c) on Etherscan, Write Contract → claim, with your address. Anyone can send it for you; the CRV always goes to the eligible address.",
      "Safe, 2022: only if you redeemed your allocation back then. Open app.safe.global with the eligible wallet and claim the vested SAFE, or call claimVestedTokens on the vesting contract.",
      "1inch (Dec 2020), Lido (early stakers, Jan 2021, and 1inch LPs, Mar 2021) and Convex (May 2021): no deadline. Call claim on the project's distributor on Etherscan with your index, amount and proof, from 1inch's API (governance.1inch.io), github.com/lidofinance/airdrop-data or github.com/convex-eth/platform.",
      "Sonic (Sonic chain): only if you still hold Sonic airdrop NFTs. Unlock them at my.soniclabs.com/airdrop before October 15, 2026: whatever is still locked then is burned.",
      "Kamino Season 3 (Solana): the official claim period is over, but unclaimed KMNO are still on-chain until Kamino claws them back. Claim at app.kamino.finance with the eligible wallet, soon.",
    ],
    note: "Airdropped tokens can only go to the eligible wallet. Never sign anything on a site that asks you to \"approve\" tokens to receive an airdrop.",
  },
  {
    id: "opstack",
    title: "OP Stack chains",
    subtitle: "Base, OP Mainnet, Mantle, World Chain, Blast, Celo, Unichain, Ink, Manta Pacific, Boba…",
    live: true,
    steps: [
      "Open the chain's official bridge (most OP Stack chains use Superbridge) and connect the wallet that made the withdrawal.",
      "Go to the activity or history tab and find the withdrawal.",
      "If it says Prove, click it and confirm on Ethereum. Then wait about 7 days (less on a few chains, e.g. 12 hours on Mantle).",
      "When it says Finalize or Claim, click it and confirm on Ethereum. The funds are sent to your address.",
    ],
    note: "Already proven? Only the finalize step is left. Both steps are ordinary Ethereum transactions from your own wallet. OP Mainnet withdrawals from before June 6, 2023 (the Bedrock upgrade) usually don't show up in bridge apps: use the manual steps below.",
    manual: [
      "Pre-Bedrock OP Mainnet withdrawals were converted to the new format at the Bedrock upgrade. They can still be claimed the same way: prove on Ethereum, wait about 7 days, then finalize.",
      "To rebuild the converted withdrawal, take your old L2 transaction: the legacy SentMessage becomes a withdrawal sent to OP's L1CrossDomainMessenger (0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1). Call proveWithdrawalTransaction on the OptimismPortal (0xbEb5Fc579115071764c7423A4f12eDde41f106Ed) with the latest dispute game and a storage proof from the L2 message passer.",
      "After about 7 days, call finalizeWithdrawalTransaction (or finalizeWithdrawalTransactionExternalProof if someone else proved it). The funds are relayed to your address.",
      "An AI assistant with Ethereum tooling can prepare these transactions as unsigned data for you to review and sign in your own wallet. Never give anyone your private key.",
    ],
  },
  {
    id: "arbitrum",
    title: "Arbitrum and Orbit chains",
    subtitle: "Arbitrum One, Nova, Robinhood Chain, Plume, Gravity…",
    live: true,
    steps: [
      "Open the official Arbitrum bridge (Arbitrum One, Nova) or your Orbit chain's own bridge (Robinhood Chain, Plume, Gravity) and connect the wallet that made the withdrawal.",
      "Open the transaction history and look for withdrawals marked Claimable.",
      "Withdrawals become claimable about 7 days after they were sent (the challenge period).",
      "Click Claim and confirm on Ethereum (or the Orbit chain's parent chain). The funds are released to your address.",
    ],
    note: "Withdrawals from before the Nitro upgrade (August 31, 2022) are still claimable, but some apps hide them. On chains with their own gas token, withdrawals of that token are paid out on Ethereum in the same token (PLUME from Plume, G from Gravity), not in ETH.",
    manual: [
      "Every withdrawal has a position in the Outbox. Get the proof by calling constructOutboxProof on the NodeInterface (0x00000000000000000000000000000000000000C8) on the chain you withdrew from.",
      "Then call executeTransaction on that chain's Outbox contract on Ethereum with that proof and the fields of your L2ToL1Tx event. Outboxes: Arbitrum One 0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840, Nova 0xD4B80C3D7240325D18E645B49e6535A3Bf95cc58, Robinhood Chain 0xf0ce991ea4A0d2400A4AB49b20ae333f6Dce3DE9, Plume 0x7e4627bC114Fcd12ba912103279FD2858E644E71, Gravity 0x1153a1e4B1523DFf36f77d696bd6eBF2B0e7DAbF.",
    ],
  },
  {
    id: "polygon-pos",
    title: "Polygon PoS",
    subtitle: "Withdrawals burned on Polygon, never exited on Ethereum",
    live: true,
    steps: [
      "Open the official Polygon Portal and connect the wallet that made the withdrawal.",
      "Open the transaction history and find the withdrawal.",
      "After the checkpoint (usually 1–3 hours) the withdrawal shows Claim.",
      "Click Claim and confirm on Ethereum. The funds are released from the bridge to your address.",
    ],
    note: "The live check covers tokens and ETH (WETH) withdrawn through the PoS bridge. Native POL / MATIC withdrawals through the older Plasma bridge aren't checked automatically: they have an extra 7-day wait and a final Process exit step in the Portal.",
    manual: [
      "Build the exit payload for your burn transaction with Polygon's proof generator API (proof-generator.polygon.technology), then call exit(bytes) on the RootChainManager (0xA0c68C638235ee32657e8f720a23ceC1bFc77C77) on Ethereum, from any wallet: the funds always go to the address that burned them.",
    ],
  },
  {
    id: "zksync",
    title: "ZKsync Era and ZK Stack chains",
    subtitle: "ZKsync Era, Abstract, Sophon, Lens, Cronos zkEVM",
    live: true,
    steps: [
      "A withdrawal can be claimed on Ethereum once its batch has been executed there: about 4 hours on ZKsync Era and Abstract, up to a day or two on Sophon, Lens and Cronos zkEVM. There is no 7-day wait.",
      "Nobody claims it for you. Open the chain's official bridge (portal.zksync.io for ZKsync Era) and connect the wallet that made the withdrawal.",
      "Find the withdrawal in the history. If it shows Claim or Finalize, click it and confirm on Ethereum.",
    ],
    note: "The claim is an ordinary Ethereum transaction, and it can be sent from any wallet: the funds always go to the receiver set when the withdrawal was made. Gas-token withdrawals (SOPH, LGHO, zkCRO) arrive as that token on Ethereum. Abstract Global Wallet users: check your smart-account address, not the signer's.",
    manual: [
      "Get the proof with zks_getL2ToL1LogProof(your L2 transaction hash, index of its L2→L1 log, usually 0) on the chain's RPC. The transaction receipt gives the batch number (l1BatchNumber) and the index in the batch (l1BatchTxIndex); the message is the data of its L1MessageSent log.",
      "On Ethereum, call finalizeDeposit on the L1Nullifier (0xD7f9f54194C633F36CCD5F3da84ad4a1c38cB2cB) with the chain id, the batch number, the proof's id, the L2 contract that sent the message (0x…800A for ETH or the gas token), the index in the batch, the message and the proof.",
      "An AI assistant with Ethereum tooling can prepare this transaction as unsigned data for you to review and sign in your own wallet. Never give anyone your private key.",
    ],
  },
  {
    id: "zksync-lite",
    title: "zkSync Lite (sunset)",
    subtitle: "zkSync 1.0 was shut down in May 2026",
    steps: [
      "Balances left on zkSync Lite are recovered through the official exit procedure published by Matter Labs.",
      "Follow the zkSync Lite shutdown instructions in the official ZKsync docs. Only use links you find there.",
    ],
  },
  {
    id: "sonic",
    title: "Sonic Gateway",
    subtitle: "Sonic → Ethereum withdrawals",
    steps: [
      "Open Sonic's official Gateway app and connect the wallet that made the withdrawal.",
      "Find the transfer in the history. Once the next heartbeat has passed, it shows Claim.",
      "Click Claim and confirm on Ethereum.",
    ],
  },
  {
    id: "debridge",
    title: "deBridge (DLN orders)",
    subtitle: "Orders on any route (30+ chains, Solana, Tron) that were never filled",
    live: true,
    steps: [
      "Open the official deBridge app and connect your wallet.",
      "Find the unfilled order in your order history.",
      "Cancel it. The cancellation is sent from the destination chain, then the funds are unlocked back to you on the source chain.",
    ],
  },
  {
    id: "celer",
    title: "Celer cBridge",
    subtitle: "Failed transfers whose refund was never collected",
    live: true,
    steps: [
      "Open the official cBridge app (cbridge.celer.network) and connect the wallet that sent the transfer.",
      "Open the transfer history and find the failed transfer. It offers to confirm the refund (older ones may first ask you to request it).",
      "Confirm the transaction on the chain you sent from. The refund goes back to the sending address; WETH is refunded as ETH.",
    ],
    note: "The refund is paid by cBridge's pool on the chain you sent from, so you need a little gas there.",
  },
  {
    id: "synapse",
    title: "Synapse",
    subtitle: "Bridge requests the validator never minted",
    steps: [
      "Look up the source transaction on the Synapse explorer to see its status.",
      "If it never completed, contact Synapse through the official support channel listed on their website. Nobody legitimate will DM you first.",
    ],
  },
  {
    id: "lighter",
    title: "Lighter",
    subtitle: "Pending withdrawal balances on Ethereum",
    steps: [
      "Open the official Lighter app and connect your wallet.",
      "Pending withdrawals sit in the Lighter contract on Ethereum until you claim them.",
      "Use the claim / withdraw action and confirm on Ethereum.",
    ],
  },
  {
    id: "linea",
    title: "Linea",
    subtitle: "Mostly withdrawals sent without a relay fee",
    live: true,
    steps: [
      "Open the official Linea bridge and connect the wallet that made the withdrawal.",
      "Open the transaction history. Withdrawals become claimable once the L2 block is finalized on Ethereum (usually 8–32 hours).",
      "Click Claim and confirm on Ethereum.",
    ],
    note: "Withdrawals sent without a fee are never claimed automatically: you have to do the last step yourself.",
    manual: [
      "Call claimMessageWithProof on the LineaRollup contract (0xd19d4B5d358258f05D7B411E21A1460D11B0876F) on Ethereum with the message fields and the Merkle proof from Linea's SDK.",
    ],
  },
  {
    id: "scroll",
    title: "Scroll",
    live: true,
    steps: [
      "Open the official Scroll bridge and connect the wallet that made the withdrawal.",
      "Open the transaction history. Withdrawals become claimable once their batch is finalized (usually within hours).",
      "Click Claim and confirm on Ethereum.",
    ],
    manual: [
      "Get the withdrawal proof from Scroll's bridge history API, then call relayMessageWithProof on the L1ScrollMessenger (0x6774Bcbd5ceCeF1336b5300fb5186a12DDD8b367).",
    ],
  },
  {
    id: "starknet",
    title: "Starknet (StarkGate)",
    steps: [
      "Open StarkGate and connect both your Starknet and Ethereum wallets.",
      "Once the L2 block is proven on Ethereum (a few hours), the withdrawal shows Withdraw / Complete.",
      "Confirm the transaction on Ethereum to receive the funds.",
    ],
  },
  {
    id: "starkex",
    title: "StarkEx apps",
    subtitle: "dYdX v3, Immutable X, Sorare, rhino.fi, ApeX, Myria, tanX…",
    steps: [
      "If the app still runs, use its withdrawal flow. The last step is a transaction on Ethereum.",
      "If the app has shut down, StarkEx has an escape hatch: request a forced withdrawal on Ethereum, and if the operator doesn't serve it, the exchange can be frozen and funds withdrawn with a proof.",
      "Follow the app's own official shutdown or recovery guide first.",
    ],
  },
  {
    id: "cctp",
    title: "Circle CCTP (USDC)",
    subtitle: "USDC burned and attested, never minted on the destination chain",
    live: true,
    steps: [
      "Reopen the app you used for the transfer (Circle, Jupiter, Mayan, Portal…). Many have a Resume or Redeem option for unfinished transfers.",
      "If the app set itself as the only allowed relayer, only that app can finish the transfer.",
      "Otherwise anyone can finish it: fetch the message and attestation for your burn transaction from Circle's attestation API, then submit them to the destination chain's MessageTransmitter (receiveMessage). The USDC is minted to the recipient set at burn time.",
    ],
    note: "The USDC can only be minted to the recipient chosen when it was burned. Nobody else can receive it.",
  },
  {
    id: "layerzero",
    title: "LayerZero",
    subtitle: "Messages that reached Ethereum but were never executed",
    steps: [
      "Look up the source transaction on LayerZero Scan.",
      "If the message is stored or failed, retry it from the app you used or from LayerZero Scan.",
      "Confirm the transaction on the destination chain.",
    ],
  },
  {
    id: "wormhole",
    title: "Wormhole",
    subtitle: "Portal and NTT transfers never redeemed on the destination, on any route",
    live: true,
    steps: [
      "Open the official Wormhole Portal and choose the redeem / resume transaction option.",
      "Paste the source transaction hash (or open it from Wormholescan). The signed message (VAA) is fetched automatically.",
      "Connect your wallet on the destination chain and redeem. For NTT tokens, use the token's own bridge app (or Wormhole Connect).",
    ],
    note: "Redeeming needs a little gas on the destination chain (SOL on Solana, ETH on Ethereum…). Transfers signed by an old guardian set (before late June 2026) can't be redeemed until the guardians sign them again: ask Wormhole support to re-observe the transfer.",
  },
  {
    id: "rainbow",
    title: "NEAR Rainbow Bridge",
    steps: [
      "Open the official Rainbow Bridge app and connect both wallets.",
      "Open your transfers. NEAR → Ethereum transfers can be finalized after the light-client update (a few hours).",
      "Click Finalize and confirm the transaction.",
    ],
  },
  {
    id: "agglayer",
    title: "Agglayer / Polygon zkEVM",
    subtitle: "Includes the Polygon zkEVM sunset exit",
    steps: [
      "Open the official Polygon Portal and connect your wallet.",
      "Find the bridge transaction. Once it's ready, it shows Claim on the destination chain.",
      "For Polygon zkEVM, follow the official sunset instructions to exit before the stated deadline.",
    ],
  },
  {
    id: "gnosis",
    title: "Gnosis Bridge",
    subtitle: "OmniBridge and xDAI bridge transfers to Ethereum never claimed",
    live: true,
    steps: [
      "Open the official Gnosis bridge app (bridge.gnosischain.com) and connect the wallet that sent the transfer (for the xDAI bridge, the wallet receiving the DAI).",
      "Find the transfer in your transactions, or look it up by its Gnosis transaction hash. Once the bridge validators have signed it, it shows Claim.",
      "Click Claim and confirm on Ethereum. The tokens (DAI or USDS for the xDAI bridge) go to the address chosen when the transfer was sent.",
    ],
    note: "Claim soon. A transfer can only be claimed with signatures from the current bridge validators: after the validators change, older unclaimed transfers are rejected on Ethereum and only the Gnosis bridge team can help. Nobody legitimate will DM you first.",
    manual: [
      "Anyone can send the claim for you: it's executeSignatures(message, signatures) on Ethereum, on the AMB (0x4C36d2919e407f0Cc2Ee3c993ccF8ac26d9CE64e) for OmniBridge or on the xDAI bridge (0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016).",
      "The message and the validators' signatures are stored on Gnosis, on the AMB (0x75Df5AF045d91108662D8080fD1FEFAd6aA0bb59) or the xDAI bridge (0x7301CFA0e1756B71869E93d4e4Dca5c7d0eb0AA6): numMessagesSigned and signature, keyed by the keccak256 of the message.",
    ],
  },
  {
    id: "ronin",
    title: "Ronin",
    steps: [
      "Open the official Ronin Bridge and connect your Ronin wallet.",
      "Find the pending withdrawal and claim it on Ethereum.",
      "If the signatures expired, the app offers to request new ones.",
    ],
  },
  {
    id: "taiko",
    title: "Taiko",
    steps: [
      "Open the official Taiko bridge and connect your wallet.",
      "Find the transfer. Transfers sent without a processing fee must be claimed by you.",
      "Click Claim once it's ready and confirm on the destination chain.",
    ],
  },
  {
    id: "morph",
    title: "Morph",
    steps: [
      "Open the official Morph bridge and connect your wallet.",
      "Once the batch is finalized on Ethereum, the withdrawal shows Claim.",
      "Click Claim and confirm on Ethereum.",
    ],
  },
  {
    id: "sui",
    title: "Sui Bridge",
    steps: [
      "Open the official Sui Bridge app and connect both wallets.",
      "Find the transfer. Once the validators approve it, it can be claimed on the destination chain.",
      "Click Claim and confirm the transaction.",
    ],
  },
];
