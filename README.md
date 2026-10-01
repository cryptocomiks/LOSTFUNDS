# lostfunds

Find the crypto you forgot to claim: unfinished bridge withdrawals, stuck cross-chain transfers,
unclaimed airdrops, rewards and old deposits. Free, read-only, no wallet connection.
Everything runs in the visitor's browser: there is no server to overload, and each visitor's
requests go straight to public blockchain nodes and the projects' own public APIs.

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
| Aave v2 rewards (Ethereum stkAAVE, Polygon WPOL, Avalanche WAVAX) | `IncentivesController.getRewardsBalance` over every aToken / variable-debt token that ever earned rewards (fixed lists: the programs ended in 2022–23) → `claimRewards(assets, max, user)` run as an eth_call from the user. |
| Aave v3 rewards (Ethereum Core / Prime / EtherFi, Arbitrum, OP, Avalanche, Polygon, Base, BNB Chain, Metis) | `RewardsController.getAllUserRewards` over the reserve tokens that carry rewards (a snapshot: every program had ended on Oct 1, 2026; a reward token missing from it triggers a fresh `getReservesList` → `getReserveData` → `getRewardsByAsset` scan) → one `claimRewards(assets, max, user, reward)` eth_call per reward, so a program whose vault is empty (SD on Ethereum) is left out. |
| Merkl (54 of its 69 chains) | Merkl's public API (`/v4/users/{address}/rewards/summary`, every chain in one call) → real tokens with a price (no points) → `Distributor.claimed(user, token)` on the chain + an eth_call of `claim([user], [token], [amount], [proof])` from the user. Chains without a CORS-enabled RPC in `src/lib/evm.ts` (or with less than ~$5k unclaimed in total) are skipped, never shown unverified. |
| Lido withdrawals (Ethereum) | `WithdrawalQueueERC721.getWithdrawalRequests(owner)` → `getWithdrawalStatus` → finalized, unclaimed requests: `findCheckpointHints` + `getClaimableEther`, then `claimWithdrawals` simulated from the owner. Pending requests show as waiting, with Lido's own estimate (wq-api.lido.fi). |
| Expired locks (Ethereum) | `locked(address)` on veCRV, veBAL, veFXS, veSDT, `positionData` on vePENDLE, `lockedBalances` on vlCVX (one multicall) → expired locks never withdrawn: `withdraw()` (`processExpiredLocks(false)` for vlCVX) simulated from the owner. |
| Curve fees, Balancer fees (Ethereum) | Addresses that ever locked (`user_point_epoch`) → `claim(address)` on Curve's 3CRV and crvUSD fee distributors, `claimTokens` (BAL, USDC) on Balancer's, repeated in one `eth_simulateV1` block until a claim returns nothing (one claim covers 50 / 20 weeks; nodes without it give a single claim, shown as "at least"). |
| EigenLayer (Ethereum) | Queued withdrawals: `DelegationManager.getQueuedWithdrawals` → past `minWithdrawalDelayBlocks`, `completeQueuedWithdrawal` simulated from the withdrawer (EIGEN strategy: bEIGEN, priced as EIGEN); otherwise waiting. Rewards (only for addresses that ever delegated): EigenLayer's sidecar API (summary + Merkle proof) → `RewardsCoordinator.cumulativeClaimed`, then `processClaim` simulated; tokens with no market price other than EIGEN are left out. |
| Aave Safety Module (Ethereum) | `getTotalRewardsBalance` on stkAAVE, stkABPT, stkAAVEwstETHBPTv2, stkGHO → `claimRewards` simulated from the staker. |
| Synthetix escrow (Ethereum, OP Mainnet) | `RewardEscrowV2.numVestingEntries` → `getVestingSchedules` (vested, non-empty entries) → `getVestingQuantity` + `vest(entryIDs)` simulated from the owner. |
| Convex staking (Ethereum) | `earned` on Convex's original CVX and cvxCRV staking pools (and the latter's 3CRV / crvUSD extra pools) → `getReward` simulated from the staker. |
| Reclaimable SOL: empty token accounts (Solana) | `getTokenAccountsByOwner` (jsonParsed) for Token and Token-2022 → accounts the owner can close: balance 0, not frozen, close authority unset or the owner, and on Token-2022 no withheld transfer fees, no confidential balance, no unknown extension. One finding with the rent they hold (every lamport comes back), wrapped SOL reported separately (closing unwraps the whole balance). Hidden under $1. |
| Reclaimable SOL: inactive stake (Solana) | `getProgramAccounts` on the Stake program, filtered on the withdraw authority → stake accounts never delegated or unstaked in an earlier epoch, fully cooled down (the stake program's cooldown, computed from the StakeHistory sysvar) and not locked up. Active and still-deactivating stake isn't reported. |
| Reclaimable SOL: Marinade tickets (Solana) | `getProgramAccounts` on Marinade, filtered on the beneficiary → delayed-unstake tickets that are due (an epoch + 30 minutes after they were ordered), with Marinade's state (paused?) and reserve (can it pay?) read in the same request as the Clock. |

Rewards worth less than $5 on Ethereum, or $1 elsewhere, are not shown (DefiLlama prices, or Merkl's own).

Data sources, all keyless: Blockscout's v2 API (transactions the wallet sent), then its Etherscan-compatible API, then Routescan's Etherscan-compatible API (Blast, Mantle, Boba, Hemi) or the chain's own (DBK Chain), full-history event search on RPC nodes that allow it (Zora, Mode, Fraxtal, BOB, MegaETH, Metal L2, Superseed, Codex, Mantle, Celo, Boba, Derive, Orderly, Nillion, Phala, Arbitrum One, Plume, Gravity, Scroll, Gnosis; Robinhood Chain in 10M-block chunks; Polygon on Tenderly's public node, with the last hours searched separately); several public RPC nodes per network; the public APIs of deBridge, Celer cBridge and Merkl; DefiLlama for USD prices. `npx tsx tests/live.ts 0x…` runs every check against the real chains (set NODE_USE_ENV_PROXY=1 behind a proxy).
Optionally set `NEXT_PUBLIC_ETHERSCAN_API_KEY` to use Etherscan V2 as a fallback for history search.

Solana addresses are accepted too: they run the Wormhole, deBridge, Circle CCTP (Solana → Ethereum) and Kamino checks, and the reclaimable SOL checks (empty token accounts, inactive stake, Marinade tickets). Solana index queries go to public.rpc.solanavibestation.com, the only keyless node found that answers them from a web page: solana-rpc.publicnode.com refuses them and api.mainnet-beta.solana.com refuses any request with an Origin header. It rate-limits each connection (a burst of about 3 requests, then about 1 per second), so rate-limited calls are retried with a backoff.

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
