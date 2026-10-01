import { encodeFunctionData, isAddressEqual, maxUint256, parseAbi, zeroAddress, type Address } from "viem";
import { evmChain, evmClient } from "../evm";
import { tokenMeta } from "../tokens";
import type { Asset, Finding } from "../types";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";
import { contractUrl, dustUsd, perChain } from "./multichain";
import { wouldSucceed } from "./simulate";

/**
 * Aave liquidity-mining rewards earned and never claimed. An amount is only shown once the
 * exact claim transaction succeeds as an eth_call from the user's address: some programs show
 * a balance in the views but their vault is empty (SD on Ethereum v3), so they can't be claimed.
 */

export const AAVE_V2: FindingSource = { id: "aave-v2", name: "Aave v2", guideId: "aave-merkl" };
export const AAVE_V3: FindingSource = { id: "aave-v3", name: "Aave v3", guideId: "aave-merkl" };

const chainName = (id: number) => evmChain(id)?.name ?? `chain ${id}`;

/* ───────────── Aave v2: IncentivesController ───────────── */

const v2Abi = parseAbi([
  "function getRewardsBalance(address[] assets, address user) view returns (uint256)",
  "function claimRewards(address[] assets, uint256 amount, address to) returns (uint256)",
]);

export interface V2Market {
  chainId: number;
  controller: Address;
  reward: { token: Address; symbol: string };
  /** DISTRIBUTION_END of the controller. */
  ended: string;
  extra?: string;
  /**
   * Every aToken / variable-debt token whose incentive index is above zero (stable debt never had
   * any). Fixed: every program ended in 2022–23. getUserUnclaimedRewards alone would miss what
   * accrued since the user's last interaction, so the balance is computed over all of them.
   */
  assets: Address[];
}

export const AAVE_V2_MARKETS: V2Market[] = [
  {
    chainId: 1,
    controller: "0xd784927Ff2f95ba542BfC824c8a8a98F3495f6b5",
    reward: { token: "0x4da27a545c0c5B758a6BA100e3a049001de870f5", symbol: "stkAAVE" },
    ended: "May 22, 2022",
    extra: " They come as stkAAVE (staked AAVE): keep it staked, or unstake it after the cooldown on the app's Stake page.",
    assets: [
      "0x3Ed3B47Dd13EC9a98b44e6204A523E766B225811", "0x531842cEbbdD378f8ee36D171d6cC9C4fcf475Ec", "0x9ff58f4fFB29fA2266Ab25e75e2A8b3503311656",
      "0x9c39809Dec7F95F5e0713634a4D0701329B3b4d2", "0x030bA81f1c18d280636F32af80b9AAd02Cf0854e", "0xF63B34710400CAd3e044cFfDcAb00a0f32E33eCf",
      "0x5165d24277cD063F5ac44Efd447B27025e888f37", "0x7EbD09022Be45AD993BAA1CEc61166Fcc8644d97", "0xDf7FF54aAcAcbFf42dfe29DD6144A69b629f8C9e",
      "0xB9D7CB55f463405CDfBe4E90a6D2Df01C2B92BF1", "0x5BdB050A92CADcCfCDcCCBFC17204a1C9cC0Ab73", "0xFFC97d72E13E01096502Cb8Eb52dEe56f74DAD7B",
      "0x05Ec93c0365baAeAbF7AefFb0972ea7ECdD39CF1", "0xfc218A6Dfe6901CB34B1a5281FC6f1b8e7E56877", "0xA361718326c15715591c299427c62086F69923D9",
      "0xbA429f7011c9fa04cDd46a2Da24dc0FF0aC6099c", "0x028171bCA77440897B824Ca71D1c56caC55b68A3", "0x6C3c78838c761c6Ac7bE9F59fe808ea2A6E4379d",
      "0xaC6Df26a590F08dcC95D5a4705ae8abbc88509Ef", "0x39C6b3e42d6A679d7D776778Fe880BC9487C2EDA", "0x6B05D1c608015Ccb8e205A690cB86773A96F39f1",
      "0xa06bC25B5805d5F8d82847D191Cb4Af5A3e873E0", "0x0b8f12b1788BFdE65Aa1ca52E3e9F3Ba401be16D", "0xa685a61171bb30d4072B338c80Cb7b2c865c873E",
      "0x0A68976301e46Ca6Ce7410DB28883E309EA0D352", "0xc713e5E149D5D0715DcD1c156a020976e7E56B88", "0xba728eAd5e496BE00DCF66F650b6d7758eCB50f8",
      "0xCC12AbE4ff81c9378D670De1b57F8e0Dd228D77a", "0xcd9D82d33bd737De215cDac57FE2F7f04DF77FE0", "0x35f6B052C598d933D69A4EEC4D04c73A191fE6c2",
      "0x267EB8Cf715455517F9BD5834AeAE3CeA1EBdbD8", "0x6C5024Cd4F8A59110119C56f8933403A539555EB", "0xdC6a3Ab17299D9C2A412B0e0a4C1f55446AE0817",
      "0x101cc05f4A51C0319f570d5E146a8C625198e636", "0x01C0eb1f8c6F1C1bF74ae028697ce7AA2a8b0E92", "0xBcca60bB61934080951369a648Fb03DF4F96263C",
      "0x619beb58998eD2278e08620f97007e1116D5D25b", "0x8dAE6Cb04688C62d939ed9B68d32Bc62e49970b1", "0x00ad8eBF64F141f1C81e9f8f792d3d1631c6c684",
      "0xD37EE7e4f452C6638c96536e68090De8cBcdb583", "0x279AF5b99540c1A3A7E3CDd326e19659401eF99e", "0x272F97b7a56a387aE942350bBC7Df5700f8a4576",
      "0x13210D4Fe0d5402bd7Ecbc4B5bC5cFcA3b71adB0", "0xF256CC7847E919FAc9B808cC216cAc87CCF2f47a", "0xfAFEDF95E21184E3d880bd56D4806c4b8d31c69A",
      "0x514cd6756CCBe28772d4Cb81bC3156BA9d1744aa", "0xc9BC48c72154ef3e5425641a3c747242112a46AF", "0xB5385132EE8321977FfF44b60cDE9fE9AB0B4e6b",
      "0x1E6bb68Acec8fefBD87D192bE09bb274170a0548", "0x2e8F4bdbE3d47d7d7DE490437AeA9915D930F1A3", "0xFDb93B3b10936cf81FA59A02A7523B6e2149b2B7",
      "0x6F634c6135D2EBD550000ac92F494F9CB8183dAe", "0x4dDff5885a67E4EffeC55875a3977D7E60F82ae0", "0xd4937682df3C8aEF4FE912A96A74121C0829E664",
      "0xfE8F19B17fFeF0fDbfe2671F248903055AFAA8Ca", "0x683923dB55Fead99A79Fa01A27EeC3cB19679cC3", "0x1982b2F5814301d4e9a8b0201555376e62F82428",
      "0x9a14e23A58edf4EFDcB360f68cd1b95ce2081a2F", "0xc2e2152647F4C26028482Efaf64b2Aa28779EFC4", "0x952749E07d7157bb9644A894dFAF3Bad5eF6D918",
      "0xB29130CBcC3F791f077eAdE0266168E808E5151e", "0xce1871f791548600cb59efbefFC9c38719142079",
    ],
  },
  {
    chainId: 137,
    controller: "0x357D51124f59836DeD84c8a1730D72B749d8BC23",
    reward: { token: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", symbol: "WPOL" },
    ended: "April 13, 2022",
    assets: [
      "0x27F8D03b3a2196956ED754baDc28D73be8830A6e", "0x75c4d1Fb84429023170086f06E682DcbBF537b7d", "0x1a13F4Ca1d028320A707D99520AbFefca3998b7F",
      "0x248960A9d75EdFa3de94F7193eae3161Eb349a12", "0x60D55F02A771d515e077c9C2403a1ef324885CeC", "0x8038857FD47108A07d1f6Bf652ef1cBeC279A2f3",
      "0x5c2ed810328349100A66B82b78a1791B101C9D61", "0xF664F50631A6f0D72ecdaa0e49b0c019Fa72a8dC", "0x28424507fefb6f7f8E9D3860F56504E4e5f5f390",
      "0xeDe17e9d79fc6f9fF9250D9EEfbdB88Cc18038b5", "0x8dF3aad3a84da6b69A4DA8aeC3eA40d9091B2Ac4", "0x59e8E9100cbfCBCBAdf86b9279fa61526bBB8765",
      "0x1d2a0E5EC8E5bBDCA5CB219e649B565d8e5c3360",
    ],
  },
  {
    chainId: 43114,
    controller: "0x01D83Fe6A10D2f2B7AF17034343746188272cAc9",
    reward: { token: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", symbol: "WAVAX" },
    ended: "April 2, 2023",
    assets: [
      "0x53f7c5869a859F0AeC3D334ee8B4Cf01E3492f21", "0x4e575CacB37bc1b5afEc68a0462c4165A5268983", "0x47AFa96Cdc9fAb46904A55a6ad4bf6660B53c38a",
      "0x1852DC24d1a8956a0B356AA18eDe954c7a0Ca5ae", "0x532E6537FEA298397212F09A61e03311686f548e", "0xfc1AdA7A288d6fCe0d29CcfAAa57Bc9114bb2DbE",
      "0x46A51127C3ce23fb7AB1DE06226147F446e4a857", "0x848c080d2700CBE1B894a3374AD5E887E5cCb89c", "0xD45B7c061016102f9FA220502908f2c0f1add1D7",
      "0x8352E3fd18B8d84D3c8a1b538d788899073c7A8E", "0x686bEF2417b6Dc32C50a3cBfbCC3bb60E1e9a15D", "0x2dc0E35eC3Ab070B8a175C829e23650Ee604a9eB",
      "0xDFE521292EcE2A4f44242efBcD66Bc594CA9714B", "0x66A0FE52Fb629a6cB4D10B8580AFDffE888F5Fd4",
    ],
  },
];

/** The claim refreshes the user's index on every asset: ~2.4M gas on Ethereum, too close to the 3M default. */
const V2_CLAIM_GAS = 8_000_000n;

async function v2Market(m: V2Market, user: Address): Promise<Finding[]> {
  const client = evmClient(m.chainId)!;
  const amount = await client.readContract({ address: m.controller, abi: v2Abi, functionName: "getRewardsBalance", args: [m.assets, user] });
  if (!amount) return [];
  const data = encodeFunctionData({ abi: v2Abi, functionName: "claimRewards", args: [m.assets, maxUint256, user] });
  if (!(await wouldSucceed(client, { from: user, to: m.controller, data, gas: V2_CLAIM_GAS }))) return [];
  const name = chainName(m.chainId);
  return [
    makeFinding(AAVE_V2, {
      key: m.reward.token,
      label: `Aave v2 · ${name}`,
      status: "ready",
      asset: { symbol: m.reward.symbol, decimals: 18, amount, token: m.reward.token, tokenChain: evmChain(m.chainId)!.llama },
      txHash: `${m.chainId}:${m.controller}`,
      txUrl: contractUrl(m.chainId, m.controller),
      timestamp: 0,
      note: `Liquidity-mining rewards from Aave v2 on ${name}, a program that ended on ${m.ended}. This address earned them and never claimed them: they can still be claimed.${m.extra ?? ""}`,
      claimAt: `app.aave.com, ${name} V2 market, Dashboard → Claim`,
      minUsd: dustUsd(m.chainId),
    }),
  ];
}

/** Aave v2 incentives on Ethereum (stkAAVE), Polygon (WPOL) and Avalanche (WAVAX). */
export const checkAaveV2 = (user: Address): Promise<CheckOutput> => perChain(AAVE_V2_MARKETS, (m) => chainName(m.chainId), (m) => v2Market(m, user));

/* ───────────── Aave v3: RewardsController ───────────── */

const rcAbi = parseAbi([
  "function getAllUserRewards(address[] assets, address user) view returns (address[] rewardsList, uint256[] unclaimedAmounts)",
  "function claimRewards(address[] assets, uint256 amount, address to, address reward) returns (uint256)",
  "function getRewardsByAsset(address asset) view returns (address[])",
]);
const poolAbi = parseAbi([
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns (((uint256 data) configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
]);

export interface V3Reward {
  token: Address;
  symbol: string;
  decimals: number;
}
const reward = (token: Address, symbol: string, decimals = 18): V3Reward => ({ token, symbol, decimals });

export interface V3Market {
  chainId: number;
  /** Markets of app.aave.com these rewards show up in. */
  market: string;
  controller: Address;
  pools: Address[];
  /** The controller's reward tokens (getRewardsList) on Oct 1, 2026, when every program had ended. */
  rewards: V3Reward[];
  /**
   * The aTokens / debt tokens that carry rewards: getRewardsByAsset over every reserve of the pools,
   * which matches each controller's whole AssetConfigUpdated history (checked on every chain but
   * BNB Chain, which has no keyless log source). Hardcoded rather than read from the pools on every
   * check: no program is live, so this can't go stale unless Aave adds a new one, and a new program
   * shows up as an unknown reward token (then the assets are read on-chain, see discoverAssets).
   * It keeps each check to one light call per chain instead of three in a row (reserves → reserve
   * data → rewards): over all 160 Ethereum reserve tokens, getAllUserRewards costs 4.7M gas and a
   * claim 3.1M, against 0.2M and 0.3M here.
   */
  assets: Address[];
}

const V3_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"; // same address on Arbitrum, OP, Avalanche, Polygon
const V3_CONTROLLER = "0x929EC64c34a17401F460460D4B9390518E5B473e";

export const AAVE_V3_MARKETS: V3Market[] = [
  {
    chainId: 1,
    market: "Ethereum Core or Prime",
    controller: "0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb",
    pools: ["0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", "0x4e033931ad43597d96D6bcc25c280717730B58B1", "0x0AA97c284e98396202b6A04024F5E2c65026F3c0"], // Core, Prime, EtherFi
    rewards: [
      reward("0x30D20208d987713f46DFD34EF128Bb16C404D10f", "SD"), // its vault is empty: claims revert
      reward("0xfA1fDbBD71B0aA16162D76914d69cD8CB3Ef92da", "aEthLidoWETH"),
      reward("0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", "wstETH"),
      reward("0x32a6268f9Ba3642Dda7892aDd74f1D34469A4259", "aEthUSDS"),
      reward("0xC035a7cf15375cE2706766804551791aD035E0C2", "aEthLidowstETH"),
    ],
    assets: [
      "0x1c0E06a0b1A4c160c17545FF2A951bfcA57C0002", // aEthETHx
      "0x32a6268f9Ba3642Dda7892aDd74f1D34469A4259", // aEthUSDS
      "0xC035a7cf15375cE2706766804551791aD035E0C2", // aEthLidowstETH
      "0xfA1fDbBD71B0aA16162D76914d69cD8CB3Ef92da", // aEthLidoWETH
      "0x2A1FBcb52Ed4d9b23daD17E1E8Aed4BB0E6079b8", // aEthLidoUSDC
    ],
  },
  {
    chainId: 42161,
    market: "Arbitrum",
    controller: V3_CONTROLLER,
    pools: [V3_POOL],
    rewards: [reward("0x912CE59144191C1204E64559FE8253a0e49E6548", "ARB")],
    assets: [
      "0x724dc807b04555b71ed48a6896b6F41593b8C637", // aArbUSDCn
      "0xeBe517846d0F36eCEd99C735cbF6131e1fEB775D", // aArbGHO
      "0x18248226C16BF76c032817854E7C83a2113B4f06", // variableDebtArbGHO
    ],
  },
  {
    chainId: 10,
    market: "Optimism",
    controller: V3_CONTROLLER,
    pools: [V3_POOL],
    rewards: [reward("0x4200000000000000000000000000000000000042", "OP")],
    assets: [
      "0x82E64f49Ed5EC1bC6e43DAD4FC8Af9bb3A2312EE", // aOptDAI
      "0x8619d80FB0141ba7F184CbF22fd724116D9f7ffC", // variableDebtOptDAI
      "0x625E7708f30cA75bfd92586e17077590C60eb4cD", // aOptUSDC
      "0xFCCf3cAbbe80101232d343252614b6A3eE81C989", // variableDebtOptUSDC
      "0x078f358208685046a11C85e8ad32895DED33A249", // aOptWBTC
      "0x92b42c66840C7AD907b4BF74879FF3eF7c529473", // variableDebtOptWBTC
      "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8", // aOptWETH
      "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351", // variableDebtOptWETH
      "0x6ab707Aca953eDAeFBc4fD23bA73294241490620", // aOptUSDT
      "0xfb00AC187a8Eb5AFAE4eACE434F493Eb62672df7", // variableDebtOptUSDT
      "0xf329e36C7bF6E5E86ce2150875a84Ce77f477375", // aOptAAVE
      "0x6d80113e533a2C0fe82EaBD35f1875DcEA89Ea97", // aOptSUSD
      "0x4a1c3aD6Ed28a636ee1751C69071f6be75DEb8B8", // variableDebtOptSUSD
      "0x38d693cE1dF5AaDF7bC62595A37D667aD57922e5", // aOptUSDCn
    ],
  },
  {
    chainId: 43114,
    market: "Avalanche",
    controller: V3_CONTROLLER,
    pools: [V3_POOL],
    rewards: [reward("0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", "WAVAX"), reward("0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE", "sAVAX")],
    assets: [
      "0x82E64f49Ed5EC1bC6e43DAD4FC8Af9bb3A2312EE", // aAvaDAI
      "0x8619d80FB0141ba7F184CbF22fd724116D9f7ffC", // variableDebtAvaDAI
      "0x191c10Aa4AF7C30e871E70C95dB0E4eb77237530", // aAvaLINK
      "0x953A573793604aF8d41F306FEb8274190dB4aE0e", // variableDebtAvaLINK
      "0x625E7708f30cA75bfd92586e17077590C60eb4cD", // aAvaUSDC
      "0xFCCf3cAbbe80101232d343252614b6A3eE81C989", // variableDebtAvaUSDC
      "0x078f358208685046a11C85e8ad32895DED33A249", // aAvaWBTC
      "0x92b42c66840C7AD907b4BF74879FF3eF7c529473", // variableDebtAvaWBTC
      "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8", // aAvaWETH
      "0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351", // variableDebtAvaWETH
      "0x6ab707Aca953eDAeFBc4fD23bA73294241490620", // aAvaUSDT
      "0xfb00AC187a8Eb5AFAE4eACE434F493Eb62672df7", // variableDebtAvaUSDT
      "0xf329e36C7bF6E5E86ce2150875a84Ce77f477375", // aAvaAAVE
      "0xE80761Ea617F66F96274eA5e8c37f03960ecC679", // variableDebtAvaAAVE
      "0x6d80113e533a2C0fe82EaBD35f1875DcEA89Ea97", // aAvaWAVAX
      "0x4a1c3aD6Ed28a636ee1751C69071f6be75DEb8B8", // variableDebtAvaWAVAX
      "0x513c7E3a9c69cA3e22550eF58AC1C0088e918FFf", // aAvaSAVAX
      "0x8ffDf2DE812095b1D19CB146E4c004587C0A0692", // aAvaBTC.b
      "0xA8669021776Bc142DfcA87c21b4A52595bCbB40a", // variableDebtAvaBTC.b
    ],
  },
  {
    chainId: 137,
    market: "Polygon",
    controller: V3_CONTROLLER,
    pools: [V3_POOL],
    rewards: [
      reward("0x1d734A02eF1e1f5886e66b0673b71Af5B53ffA94", "SD"),
      reward("0xC3C7d422809852031b44ab29EEC9F1EfF2A58756", "LDO"),
      reward("0x3A58a54C066FdC0f2D55FC9C89F0415C92eBf3C4", "stMATIC"),
      reward("0xfa68FB4628DFF1028CFEc22b4162FCcd0d45efb6", "MaticX"),
    ],
    assets: [
      "0x4a1c3aD6Ed28a636ee1751C69071f6be75DEb8B8", // variableDebtPolWMATIC
      "0xEA1132120ddcDDA2F119e99Fa7A27a0d036F7Ac9", // aPolSTMATIC
      "0x80cA0d8C38d2e2BcbaB66aA1648Bd1C7160500FE", // aPolMATICX
    ],
  },
  {
    chainId: 8453,
    market: "Base",
    controller: "0xf9cc4F0D883F1a1eb2c253bdb46c254Ca51E1F44",
    pools: ["0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"],
    rewards: [reward("0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", "aBasUSDC", 6)],
    assets: ["0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB"], // aBasUSDC
  },
  {
    chainId: 56,
    market: "BNB Chain",
    controller: "0xC206C2764A9dBF27d599613b8F9A63ACd1160ab4",
    pools: ["0x6807dc923806fE8Fd134338EABCA509979a7e0cB"],
    rewards: [reward("0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409", "FDUSD")],
    assets: ["0xE628B8a123e6037f1542e662B9F55141a16945C8"], // variableDebtBnbFDUSD
  },
  {
    chainId: 1088,
    market: "Metis",
    controller: "0x30C1b8F0490fa0908863d6Cbd2E36400b4310A6B",
    pools: ["0x90df02551bB792286e8D4f13E0e357b4Bf1D6a57"],
    rewards: [reward("0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000", "METIS")],
    assets: [
      "0x13Bd89aF338f3c7eAE9a75852fC2F1ca28B4DDbF", // variableDebtMetmDAI
      "0x7314Ef2CA509490f65F52CC8FC9E0675C66390b8", // aMetMETIS
      "0x0110174183e13D5Ea59D7512226c5D5A47bA2c40", // variableDebtMetMETIS
      "0x571171a7EF1e3c8c83d47EF1a50E225E9c351380", // variableDebtMetmUSDC
      "0x6B45DcE8aF4fE5Ab3bFCF030d8fB57718eAB54e5", // variableDebtMetmUSDT
      "0x8acAe35059C9aE27709028fF6689386a44c09f3a", // aMetWETH
      "0x8Bb19e3DD277a73D4A95EE434F14cE4B92898421", // variableDebtMetWETH
    ],
  },
];

const discovered = new Map<number, Promise<Address[]>>();

/** Every reserve token of the market's pools that carries rewards, read on-chain (once per page load). */
function discoverAssets(m: V3Market): Promise<Address[]> {
  let p = discovered.get(m.chainId);
  if (!p) {
    p = (async () => {
      const client = evmClient(m.chainId)!;
      const reserves = await Promise.all(
        m.pools.map(async (pool) => {
          const list = await client.readContract({ address: pool, abi: poolAbi, functionName: "getReservesList" });
          return Promise.all(list.map((a) => client.readContract({ address: pool, abi: poolAbi, functionName: "getReserveData", args: [a] })));
        }),
      );
      const tokens = [
        ...new Set(reserves.flat().flatMap((r) => [r.aTokenAddress, r.variableDebtTokenAddress, r.stableDebtTokenAddress])),
      ].filter((t) => !isAddressEqual(t, zeroAddress));
      const rewards = await Promise.all(tokens.map((t) => client.readContract({ address: m.controller, abi: rcAbi, functionName: "getRewardsByAsset", args: [t] })));
      const carrying = tokens.filter((_, i) => rewards[i].length > 0);
      return [...m.assets, ...carrying.filter((t) => !m.assets.some((a) => isAddressEqual(a, t)))];
    })().catch((e) => {
      discovered.delete(m.chainId);
      throw e;
    });
    discovered.set(m.chainId, p);
  }
  return p;
}

/** Aave's aTokens are named a<Chain><Asset> (aEthUSDS, aBasUSDC…). */
const isAToken = (symbol: string) => /^a(Eth|Arb|Opt|Ava|Pol|Bas|Bnb|Met)[A-Za-z]/.test(symbol);

async function v3Market(m: V3Market, user: Address): Promise<Finding[]> {
  const client = evmClient(m.chainId)!;
  const read = (assets: readonly Address[]) =>
    client.readContract({ address: m.controller, abi: rcAbi, functionName: "getAllUserRewards", args: [assets, user] });
  let assets: readonly Address[] = m.assets;
  let [rewards, amounts] = await read(assets);
  // The controller lists a reward token we don't know: a new program, on assets we may not have.
  if (rewards.some((r) => !m.rewards.some((k) => isAddressEqual(k.token, r)))) {
    assets = await discoverAssets(m);
    [rewards, amounts] = await read(assets);
  }
  const name = chainName(m.chainId);
  const found = await Promise.all(
    rewards.map(async (token, i) => {
      if (!amounts[i] || isAddressEqual(token, zeroAddress)) return null;
      // One claim per reward (claimAllRewards reverts as a whole when any reward can't be paid).
      const data = encodeFunctionData({ abi: rcAbi, functionName: "claimRewards", args: [assets, maxUint256, user, token] });
      if (!(await wouldSucceed(client, { from: user, to: m.controller, data }))) return null; // e.g. the program's vault is empty
      const known = m.rewards.find((k) => isAddressEqual(k.token, token));
      const meta = known ?? (await tokenMeta([client], token));
      if (!meta) throw new Error(`couldn't read reward token ${token}`);
      const asset: Asset = { symbol: meta.symbol, decimals: meta.decimals, amount: amounts[i], token, tokenChain: evmChain(m.chainId)!.llama };
      return makeFinding(AAVE_V3, {
        key: token,
        label: `Aave v3 · ${name}`,
        status: "ready",
        asset,
        txHash: `${m.chainId}:${m.controller}`,
        txUrl: contractUrl(m.chainId, m.controller),
        timestamp: 0,
        note:
          `Rewards from an Aave v3 incentive program on ${name} that this address earned and never claimed: they can still be claimed.` +
          (isAToken(meta.symbol) ? ` They're paid as ${meta.symbol}, an Aave deposit you can withdraw.` : ""),
        claimAt: `app.aave.com, ${m.market} market, Dashboard → Claim`,
        minUsd: dustUsd(m.chainId),
      });
    }),
  );
  return found.filter((f) => f !== null);
}

/** Aave v3 incentives on Ethereum (Core, Prime, EtherFi), Arbitrum, OP, Avalanche, Polygon, Base, BNB Chain and Metis. */
export const checkAaveV3 = (user: Address): Promise<CheckOutput> => perChain(AAVE_V3_MARKETS, (m) => chainName(m.chainId), (m) => v3Market(m, user));
