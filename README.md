# lostfunds

Find crypto stuck in a bridge: withdrawals that were started but never finished.
Free, read-only, no wallet connection. Everything runs in the browser.

## What it checks (live, on-chain)

| Network | How |
| --- | --- |
| Base, OP Mainnet, Zora, Mode, Unichain, Ink, Soneium, World Chain, Blast, Lisk, Fraxtal, BOB, MegaETH, Shape, Metal L2, Superseed, Codex | L2 bridge / message-passer events → `getWithdrawalStatus` (viem) against the OptimismPortal on Ethereum; when viem can't read a chain's dispute games, the portal is read directly. Pre-Bedrock OP withdrawals are checked against `L1CrossDomainMessenger.successfulMessages`. |
| Arbitrum One, Arbitrum Nova | `L2ToL1Tx` (ArbSys) + gateway events → `Outbox.isSpent(position)` on Ethereum. |
| Scroll | Gateway / messenger events → `L1ScrollMessenger.isL2MessageExecuted(hash)`. |
| Linea | `MessageSent` / token-bridge events → `LineaRollup.isMessageClaimed(nonce)` + L1 `MessageClaimed` events. |
| deBridge (any route: 30+ EVM chains, Solana, Tron) | Stuck orders from deBridge's public API → `DlnSource.giveOrders` / `DlnDestination.takeOrders` on each EVM side (`src/lib/evm.ts`). |

Data sources, all keyless: Blockscout's v2 API (transactions the wallet sent), then its Etherscan-compatible API, then Routescan's Etherscan-compatible API (Blast), full-history event search on RPC nodes that allow it (Zora, Mode, Fraxtal, BOB, MegaETH, Metal L2, Superseed, Codex, Arbitrum One, Scroll); several public RPC nodes per network; DefiLlama for USD prices. `npx tsx tests/live.ts 0x…` runs every check against the real chains (set NODE_USE_ENV_PROXY=1 behind a proxy).
Optionally set `NEXT_PUBLIC_ETHERSCAN_API_KEY` to use Etherscan V2 as a fallback for history search.

Solana addresses are accepted too: they run the Wormhole, deBridge and Circle CCTP (Solana → Ethereum) checks.

OP Stack chains left out because they are offline or have no full-history source: Ancient8, Form, PGN, Redstone, RSS3 VSL, SnaxChain, Zircuit.

Another 20+ bridges (Polygon, ZKsync, Starknet, CCTP, LayerZero, Wormhole…) have step-by-step claim guides.

## Develop

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # checks run against an in-memory mock chain
npm run build      # static export in out/ (IPFS / ENS / any static host)
npx tsx tests/screenshots.ts shots   # screenshots of out/ with mocked chain data
```

## Configure

Edit `src/config/site.ts`: name, X link, tip addresses (sections with empty values are hidden).
Networks and contract addresses live in `src/lib/networks.ts`, guide texts in `src/content/guides.ts`.
