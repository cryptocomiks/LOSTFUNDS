# lostfunds

Find crypto stuck in a bridge: withdrawals that were started but never finished.
Free, read-only, no wallet connection. Everything runs in the browser.

## What it checks (live, on-chain)

| Network | How |
| --- | --- |
| Base, OP Mainnet, Mantle, Zora, Mode, Unichain, Ink, Soneium, World Chain, Blast, Celo, Manta Pacific, Lisk, Fraxtal, BOB, MegaETH, Shape, Boba Network, HashKey Chain, Hemi, Metal L2, Superseed, Codex, DBK Chain, Cyber, Orderly, RISE, Derive, Funki, Nillion, Towns, Phala | L2 bridge / message-passer events → `getWithdrawalStatus` (viem) against the OptimismPortal on Ethereum; when viem can't read a chain's dispute games, the portal is read directly, and on output-oracle portals a proof only counts while its output root is still in the oracle. Pre-Bedrock OP withdrawals are checked against `L1CrossDomainMessenger.successfulMessages`. Mantle's own `MessagePassed` event (MNT + ETH values) is decoded; native amounts on Celo, HashKey Chain and Mantle are shown in CELO, HSK and MNT. |
| Arbitrum One, Arbitrum Nova | `L2ToL1Tx` (ArbSys) + gateway events → `Outbox.isSpent(position)` on Ethereum. |
| Robinhood Chain, Plume, Gravity (Arbitrum Orbit, settling on Ethereum) | Same as Arbitrum, with each chain's Outbox and gateways. Gas-token withdrawals are shown in the chain's own token (PLUME, G), priced from its Ethereum address. |
| Polygon PoS | ERC20 burns (`Transfer` to 0x0) of tokens mapped by the PoS bridge (`RootChainManager.childToRootToken`) → one exit proof per burn from Polygon's proof generator → `RootChainManager.exit` simulated on Ethereum (`EXIT_ALREADY_PROCESSED` = claimed; WETH exits as ETH). Native POL / MATIC (Plasma) withdrawals aren't covered. |
| Scroll | Gateway / messenger events → `L1ScrollMessenger.isL2MessageExecuted(hash)`. |
| Linea | `MessageSent` / token-bridge events → `LineaRollup.isMessageClaimed(nonce)` + L1 `MessageClaimed` events. |
| ZKsync Era, Abstract, Sophon, Lens, Cronos zkEVM | Withdrawal events (base token, legacy bridge, asset router) → the receipt's L2→L1 message + `zks_getL2ToL1LogProof` → `L1Nullifier.isWithdrawalFinalized` on Ethereum (plus the Era diamond's and old `L1ERC20Bridge`'s own records for Era withdrawals before June 2024), the chain's executed batches, then a dry run of `L1Nullifier.finalizeDeposit`. |
| Wormhole Token Bridge + NTT (any route between 30+ EVM chains and Solana) | Transfers from Wormholescan (`/operations`, `/transactions`) → signed VAA decoded → `TokenBridge.isTransferCompleted` / Solana claim account / `NttManager.isMessageExecuted` on the destination, then a simulated redeem (or the guardian set's expiry on Solana) to tell redeemable from expired-guardian-set transfers. |
| deBridge (any route: 30+ EVM chains, Solana, Tron) | Stuck orders from deBridge's public API → `DlnSource.giveOrders` / `DlnDestination.takeOrders` on each EVM side (`src/lib/evm.ts`). |
| Gnosis Bridge (OmniBridge + xDAI bridge, Gnosis → Ethereum) | OmniBridge `TokensBridgingInitiated` (by sender) and xDAI bridge `UserRequestForSignature` (by recipient) from full-history event search on Gnosis RPC nodes → `relayedMessages` on Ethereum. Unclaimed ones: `executeSignatures` is simulated with the validators' signatures stored on Gnosis; if it's rejected, the signers are recovered to tell transfers stranded by a validator change ("check manually") from the rest. |
| Celer cBridge (refunds) | Transfer history from cBridge's public API → refunds waiting for the user (`REFUND_TO_BE_CONFIRMED`, liquidity pools) → `Pool.withdraws(wdId)` on the source chain + an eth_call of `withdraw(...)` with Celer's signatures. |
| EtherDelta / ForkDelta (all 5 contracts, 2016–2022), Token.Store, SingularX | `balanceOf(token, user)` for ETH and every token the contract still holds at least $50 of (`src/lib/checks/exchange-tokens.ts`), in one multicall → `withdraw(amount)` / `withdrawToken(token, amount)` simulated from the user. |
| IDEX v1 | Same balance read → `withdraw(token, amount)` simulated from the user (the contract allows it after 240 blocks without activity). |
| ENS auction deposits (old .eth registrar, 2017–2019) | `BidRevealed` events with the user as winning bidder (status 2) + a snapshot of the deeds that changed hands (`public/legacy/ens-deeds`) → `entries(hash)`, the deed's owner and ETH balance → `releaseDeed(hash)` simulated from the user. |
| Maker Single-Collateral Dai vaults (SCD, shut down in 2020) | A snapshot of the 5,021 CDPs that can still free at least 0.01 PETH, by owner (wallet or DSProxy owner, `public/legacy/scd-cups`) → `Tub.cups`, the debt's value at the shutdown price → `free` (or the DSProxy's `execute` of SaiProxy's `free`) simulated from the user, or `bite` when the CDP still has debt. |
| Polygon staking (on Ethereum) | One multicall over all 209 ValidatorShare contracts (`balanceOf`, `unbondNonces`, `unbonds`) → `getLiquidRewards`, `unbonds_new`, validator status → `withdrawRewardsPOL` / `unstakeClaimTokens_newPOL` / `sellVoucher_newPOL` simulated from the user. |

Data sources, all keyless: Blockscout's v2 API (transactions the wallet sent), then its Etherscan-compatible API, then Routescan's Etherscan-compatible API (Blast, Mantle, Boba, Hemi) or the chain's own (DBK Chain), full-history event search on RPC nodes that allow it (Zora, Mode, Fraxtal, BOB, MegaETH, Metal L2, Superseed, Codex, Mantle, Celo, Boba, Derive, Orderly, Nillion, Phala, Arbitrum One, Plume, Gravity, Scroll, Gnosis; Robinhood Chain in 10M-block chunks; Polygon on Tenderly's public node, with the last hours searched separately); several public RPC nodes per network; the public APIs of deBridge and Celer cBridge; DefiLlama for USD prices. `npx tsx tests/live.ts 0x…` runs every check against the real chains (set NODE_USE_ENV_PROXY=1 behind a proxy).
Optionally set `NEXT_PUBLIC_ETHERSCAN_API_KEY` to use Etherscan V2 as a fallback for history search.

Solana addresses are accepted too: they run the Wormhole, deBridge and Circle CCTP (Solana → Ethereum) checks.

OP Stack chains left out because they are offline or have no full-history source: Ancient8, Form, PGN, Redstone, RSS3 VSL, SnaxChain, Swan Chain, Swellchain, Zircuit. Not covered either: Mantle withdrawals from before its v2 upgrade (March 2024) and Boba's from before Anchorage (April 2024), which have no `MessagePassed` event.

Another 20+ bridges (Starknet, LayerZero, Synapse…) have step-by-step claim guides.

ZK Stack chains left out because their RPC nodes are offline (no receipts or proofs): Treasure, ZKcandy, ZERO Network.

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
