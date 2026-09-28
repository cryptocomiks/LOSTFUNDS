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
    subtitle: "Uniswap (UNI, 2020): no deadline",
    live: true,
    steps: [
      "Uniswap's September 2020 airdrop never expires. Around 12.5 million UNI are still waiting to be claimed.",
      "Open the official Uniswap app and connect the eligible wallet. If a Claim UNI prompt shows, confirm it.",
      "No prompt? Claim directly on the contract: open the MerkleDistributor (0x090D4613473dEE047c3f2706764f49E0821D256e) on Etherscan, Write Contract → claim, with your index, address, amount and proof from Uniswap's published list (github.com/Uniswap/mrkl-drop-data-chunks).",
    ],
    note: "The UNI can only be sent to the eligible address itself, whoever submits the claim. Never sign anything on a site that asks you to \"approve\" tokens to receive an airdrop.",
  },
  {
    id: "opstack",
    title: "OP Stack chains",
    subtitle: "Base, OP Mainnet, Zora, Mode, Unichain, Ink, Soneium…",
    live: true,
    steps: [
      "Open the chain's official bridge (most OP Stack chains use Superbridge) and connect the wallet that made the withdrawal.",
      "Go to the activity or history tab and find the withdrawal.",
      "If it says Prove, click it and confirm on Ethereum. Then wait about 7 days.",
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
      "Open the official Arbitrum bridge (or your Orbit chain's own bridge) and connect the wallet that made the withdrawal.",
      "Open the transaction history and look for withdrawals marked Claimable.",
      "Withdrawals become claimable about 7 days after they were sent (the challenge period).",
      "Click Claim and confirm on Ethereum (or the Orbit chain's parent chain). The funds are released to your address.",
    ],
    note: "Withdrawals from before the Nitro upgrade (August 31, 2022) are still claimable, but some apps hide them.",
    manual: [
      "Every withdrawal has a position in the Outbox. Get the proof by calling constructOutboxProof on the NodeInterface (0x00000000000000000000000000000000000000C8) on Arbitrum.",
      "Then call executeTransaction on the chain's Outbox contract on Ethereum with that proof and the fields of your L2ToL1Tx event.",
    ],
  },
  {
    id: "polygon-pos",
    title: "Polygon PoS",
    subtitle: "Withdrawals burned on Polygon, never exited on Ethereum",
    steps: [
      "Open the official Polygon Portal and connect the wallet that made the withdrawal.",
      "Open the transaction history and find the withdrawal.",
      "After the checkpoint (usually 1–3 hours) the withdrawal shows Claim.",
      "Click Claim and confirm on Ethereum. The funds are released from the bridge to your address.",
    ],
    note: "Old withdrawals through the Plasma bridge (mostly MATIC) have an extra 7-day wait and a final Process exit step.",
    manual: [
      "Build the exit payload for your burn transaction with Polygon's proof generator API, then call exit(bytes) on the RootChainManager on Ethereum.",
    ],
  },
  {
    id: "zksync",
    title: "ZKsync Era and ZK Stack chains",
    subtitle: "ZKsync Era, Sophon, Abstract, Lens, Cronos zkEVM",
    steps: [
      "Most withdrawals are finalized automatically a few hours after the batch is proven.",
      "If yours wasn't, open the chain's official bridge portal and connect your wallet.",
      "Find the withdrawal in the history. If it shows Claim, click it and confirm on Ethereum.",
    ],
    manual: [
      "Get the message proof with zks_getL2ToL1LogProof on the L2, then call finalizeWithdrawal (or finalizeDeposit on newer contracts) on the L1 shared bridge.",
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
    subtitle: "Transfers that were never redeemed on the destination",
    live: true,
    steps: [
      "Open the official Wormhole Portal and choose the redeem / resume transaction option.",
      "Paste the source transaction hash (or open it from Wormholescan). The signed message (VAA) is fetched automatically.",
      "Connect your wallet on the destination chain and redeem. Signed transfers don't expire.",
    ],
    note: "Redeeming to Solana needs a little SOL for fees; redeeming to Ethereum needs ETH for gas.",
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
    title: "Gnosis Chain",
    steps: [
      "Open the official Gnosis bridge and connect your wallet.",
      "Find the withdrawal. When enough validators have signed it, it shows Claim.",
      "Click Claim and confirm on Ethereum.",
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
