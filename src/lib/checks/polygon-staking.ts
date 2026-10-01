import { encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { l1Client } from "../clients";
import type { Asset } from "../types";
import { bulkRead } from "./bulk";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";
import { LEGACY_GUIDE } from "./exchanges";
import { wouldSucceed } from "./simulate";

/**
 * Polygon PoS staking, on Ethereum. Delegators hold shares of a validator's ValidatorShare contract.
 * What can be waiting for them, all withdrawable by the delegator alone:
 *   - rewards never withdrawn (getLiquidRewards, at least `minAmount` = 1 POL to withdraw);
 *   - unstaked POL whose waiting period (80 checkpoints, about a day) ended but was never claimed
 *     (unbonds_new / the older single `unbonds` slot);
 *   - POL still delegated to a validator that has left: it earns nothing until it's unstaked.
 *
 * Every validator's ValidatorShare is listed below, so a wallet that never staked costs one multicall.
 * Validators added since are found by probing the next ids in that same call.
 */

export const POLYGON_STAKING: FindingSource = { id: "polygon-staking", name: "Polygon staking", guideId: LEGACY_GUIDE, explorer: "https://etherscan.io" };

const STAKE_MANAGER: Address = "0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908";
const POL: Address = "0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6";
const MIN_USD = 5;
/** Ids after the list below that are probed for new validators. */
const PROBE = 40;
/** At most this many unstake requests are read per check. */
const MAX_UNBONDS = 400;

/** ValidatorShare contract of each validator: index + 1 = validator id (Oct 1, 2026: 209 validators). */
export const VALIDATOR_SHARES: Address[] = [
  "0xc1D2e4487FF42A5971a9F4C47914D1Ac0Cb16617", "0x83e978eb20852BDB47dfa3aFE60a917b1CDA1715", "0xAF643dFB0445Fb7E8053b2e6c2200C8bfcbE8880", "0x85ED9d45b276AA69176D4A4e3e8Af6985BfD1fD4", // 1–4
  "0xD9AeF0814e7eCBB4447eab08EDe33b6EBC29F842", "0x610AEBd620437B4b4e88801abD0c8BA0D009DF5C", "0x13239ae75da684c73C23712B7Da385D130D3EAa1", "0xF74A300e3adE7e50BB807a6F706DC5eB4e8cA540", // 5–8
  "0x8296DB6591F5762cc53E6E875F329A67886EE9d4", "0xd333Ed1a41E3eba044eCa4755f24007A7A20caB0", "0xD26Ff5f17e37Be266f611a97402219Fcffa7c29b", "0x48D1f4bFE197a3c12427658ae7f16551A9C03Efc", // 9–12
  "0x6c1dFEE2B2eDe28970B666fc8F2eD47A8F9399ea", "0xbAE3224232E5FDEE492a5Ec0af784f6e0A7f0fcE", "0x45F46D300D0da167D024231538B7ffe912cd674e", "0xa180Dd33e0fe5f8c2a4022d613145c383BE5F6a6", // 13–16
  "0xB1A5cEBE10717F68B1CfDB2e392e506514eC000B", "0xa6e768fEf2D1aF36c0cfdb276422E7881a83e951", "0xd325076129227b9f9b7AfAc32d9Ef442140C953f", "0xaF7AdA91E072693398180FcF8719FCb5a860278F", // 17–20
  "0x490d3f102247d9eeE1466beBcbc7B737083A41f5", "0x4E332D23eA1D9f8247DEb4d8f03aC7b6785Be36B", "0x22E211F0916C15a6401Ce0Fa195722f317aD49cD", "0x701B1DB233425e80D62219A8286e3fD577CB129A", // 21–24
  "0xBdF1E625C7C1a39c9875FFf42450ab303ecFfF7b", "0x083C13B5bEb704776a738582e3f0922d99DDF47d", "0x3Fca6b8031844eca95351bD1d852Fa8442349274", "0x818Ee6A2491DaeeD4757D919aa1A051459c808c1", // 25–28
  "0x0e9e4B023F7921C6EdAf824d6AF934b1DBE502F0", "0x06998Af8f39Ff8630d1FB515D22781DA4DC2CA71", "0x0098Af0ceAC1238BFa1eb43652a700d1Fcd379f0", "0x2fCd6543e2c94C638b9789a63180c957647b5947", // 29–32
  "0xFD118EF96B34113C71789ED21F438fd326c9F785", "0xfBD457afAD934A1Bd9B18285a4D4C108B3f9673c", "0x2aC48B794Fd32068b9a5096220f2115bE3841a7A", "0x93109bA54Cf51FceE975AbdF07e407281358Fc5d", // 33–36
  "0xAfe97c48b465D424D25ae3A52a722F4496cEB6E3", "0xDc6a554b932411a73947547ee52d949dF242c904", "0x24Ed9A7F91dd1AfAe974ad7A95B9643b01c34536", "0x072e1d65026ea5bE3c2C70845C515c51Ce85B7DE", // 37–40
  "0x9bd39D50959FF344d5Da483D7Fe23a2D164C2A64", "0x503B36441618e61135adE1Fa6Aa8e5345DA7Ce75", "0xaAE5511b3AfbaE6C365E13a2D6D588AE84Ea1f2c", "0x524e56004B894Ccb8509ab2F707405b8fE3A1A83", // 41–44
  "0x6140605Fa8CdeBe0e23a1e0F8ce041dD7d841627", "0x86e09E491f4AC46BE9aAc4c6283C9671Ee2b235d", "0xD14a87025109013B0a2354a775cB335F926Af65A", "0x488D5E372660663456f4EdB4890F373445e922DE", // 45–48
  "0xef840Aa1de9775112A0b17B0FA0135862fa770bc", "0xAbDEA8F7E56163F4B0fC6eCC83b710Ed24BCdB5c", "0x24EBa7e8c510a7523FCB9958a7F1497D15F3D7e4", "0xeFD059E02e982E5f8040D4662a065604e084a103", // 49–52
  "0x8D1b7BD05DccA4d5a7ca897Dc1946acc749DefDA", "0x48d7c8a1ffE179bf4a8eA5aC90574A7D13b0fbfc", "0x843138cEB3aa4741a7A14BE8e28875813105dA6D", "0xaD1585fcF050bF1bDf41C6a9501C63d04D2b9cE2", // 53–56
  "0xeE3e6e6200230E8EC58710219e5dc5E1626aF6d7", "0x325508f5C8019BE084af52F70f0444afD1C26977", "0x3805C8d32AD5B6ebD221991eab804A68bC4B2654", "0x70fC25f1d3d0747986cDf5f564b9f09740Aa9421", // 57–60
  "0xb20A0aFa8Cbb1D6dab1FE6Cc420a46c43CAe100f", "0x51537Ea0510883A7a85c3aC25aA42eafA32F3655", "0xc0B92e8CAAD746DD0623090A34528fac93A985F2", "0x5DDBeE6aD14852d5F78b6eeb6b040391821ff45C", // 61–64
  "0x9a18184E0E8a52c9604Fe5a5c9c5Cc068E80C242", "0xEaCf65285A9450CbBd7d3b4d184c0A8674C531a9", "0xF57b291ae6A76Cb974f63CF1c23580Adfac654a2", "0x56d783Ca8e0b998C57a428Bf1c26A8baca50524e", // 65–68
  "0x88CfAFdCF9E45A93463FA367D2C4E713602991F9", "0x35B1CA0F398905Cf752e6FE122b51c88022FCa32", "0x6407778625dbD07B07A953951E18741536334957", "0x40EA81066321dA24af02F87E05Ded5B85E79e437", // 69–72
  "0x40B1113a67AF64c02bA6A7f06a7F463747861D30", "0x051523CCf12ED85845792D4432410d12B584F8AE", "0x8e60E8fEeEe72cD2EaF8D2E8C50075b79CCE8a58", "0x321aC7F4A02f316152Efc0D8196b59E28A2d92E5", // 73–76
  "0xF30Cf4ed712D3734161fDAab5B1DBb49Fd2D0E5c", "0xEf036919fe86F1daD362F4B3E631B4f663607118", "0x2eD68044CbE901DCC2ac448e1D276B3F928845c0", "0xe9Ce4B4A8cAd7c7661F84B80aadEc09DAeEa91C8", // 77–80
  "0x60254E82c5d4bE5af51bf51B209A87D914448F2E", "0xD60f511BEeE0fc25AEf51A9e8900873EB9e95778", "0x8DF00C3b59d89F51289616297152482F4aA09d34", "0x68a576666e8609acd30DC16166C6B22B139B7836", // 81–84
  "0xf6ab2A58b5684F7b872c8bca75d07eEf65495924", "0x7ad9c4432Abb0BE2b9AF840e48E7E7996399f387", "0xb929B89153fC2eEd442e81E5A1add4e2fa39028f", "0x41472fDdbAEc17E2a98F125Cacf8f76F919EA095", // 85–88
  "0x5666bEE98a29344F30412c2c96BA7Db1e6191C48", "0xd245710936382e5ED099d4F8D9AAE64e67e30EF3", "0x98305eF9D2619651C9bDE583D288bf16E99eCc02", "0xd94f21ef2d3852125C9eAbeA4DE6DB5BF22d3e9C", // 89–92
  "0xF97A19c39974966e5407c6E7aE3BE78e4f528e2a", "0x1FCff958Da6b987A79BC51d9F4B3FC3366094B47", "0x4eD020b46097321fbB1C773048ddfC29ec856243", "0x3f5d59528Ed948B9f0a6d0Ab24a5317b9556AB2B", // 93–96
  "0xaC1D6c20cE7F1fBF1915eFc0898D188b9C6A5CeD", "0x66e250958b161dFcDE512D10E29f40Cc17538eFE", "0x776af32c15C2c010713B6A281F49eb5541E5587d", "0x52D3934120a5bF894355EE9F106378F1AE095348", // 97–100
  "0x486f366C810ce6EA36799D9677AAc15CE894dE32", "0xd96f7A3759E907D1E1056B09622f2f9ae24804F8", "0xa7A7ec7F105Ae590c642B256CeC3BC314E611906", "0xE746678d14C769E4Fd535D19F7e4c2c61e5467bE", // 101–104
  "0x3fa8E9959C390FB3f2B19da7eeA99946fCfdF15A", "0xD9E6987D77bf2c6d0647b8181fd68A259f838C36", "0x912684363934B7119CA86C949CbB76c3C9D08A1D", "0x5A10DE50160126A5F936506BD342C541Ac44e943", // 105–108
  "0x467585AaEa860F9D8B3B43bb994E4Da8A93788a7", "0x8f846C443CFa44A6e95aaCD2aC362b6cF4fd4335", "0x59a82694a675377E010F18F598f5B9dBB83eD968", "0x6e246D13F190Fd3b6656939f167F6848B9CAFE57", // 109–112
  "0x0429D00cfC9FFb9d285F0F3414bF5b39c20395d0", "0x73A49787Fd1fCCd68A24cCE1c8589A673eFeB311", "0x5E0660fC23597f33Aa960ba5Cf664fC88100679A", "0x745801859F09eFd1A50bced32dF5c1E52c08F6bA", // 113–116
  "0xC55D28Ac155C1a43eF2309869b704dF677788E81", "0x3EDBF7E027D280BCd8126a87f382941409364269", "0xb8281E329d6615493A29738a525FE31357e43309", "0xf005A4c99a5CaE65a9aad3C54B957f3356649c8d", // 117–120
  "0xC7757805B983eE1b6272c1840c18e66837dE858E", "0xEFb47D73181bB6963c8113A58184525355287573", "0x11cc04dD962e82D411587c56b815E8f8141Eb7D5", "0xb627Cbc3d226f34b2530694B1FBeB165C2a502F1", // 121–124
  "0xA6C7811ae5e8f07E08264bCD90a7F8E3B2CfC4f9", "0x1d3f83AD562FC618bF58082aA2B44F99f7dfd416", "0x3D8b9Ccd13c854a17CEF795d6f6a0871b9ABb294", "0x641f789E463295F05e7da0cFD85Fcf1D6d74785e", // 125–128
  "0x17c09Ec4277fB5E10E0950B57506D501F9B9B169", "0x599761b13642eaEe0035C153e4F14f7c4427AfD0", "0x1Aa6c734dAA508c57325c21849cCc6f7D726C081", "0x554A8546b4947f7F500F21538722bdCBB1F37Cbb", // 129–132
  "0x6472A86d12Feec5bD201096407ecC3B297a26411", "0x0bD72469B9dC72C833Dff9cA9Be2Eb032e603125", "0xEcf62D216d91C3574E0FF81999e5c0952E6CeD5f", "0x62Cf559C758E89A8dD77101618E5E1F73dA26793", // 133–136
  "0xd1673B4bEeD98E9295875E46819810D4512f5122", "0xBbFed100b31e008f9548D5850B598ACd8803f018", "0x96Fca49aa75607CD3bE4aFf640960a8C0C98CeE5", "0xf04dFE50fd1Ee4e2320618c80c526873373FD3e3", // 137–140
  "0x9734e58401905184e2A316895762962fB24386AF", "0x857679d69fE50E7B722f94aCd2629d80C355163d", "0x875e901465A639f2E71fcfC10F426eD32F5A909a", "0xa71BfFE9ED064fBA4bF05b8a60c247E596ECaf41", // 141–144
  "0x20cf1D8870dd7306aA5ca13Aafa86b5F09A476C1", "0x6031A416A4d0FB4CdD9186494d89D8ef39B2d036", "0x8BcaFD2E2e0C6a44453CdE72fd37246AB4a277d2", "0xeA077b10A0eD33e4F68Edb2655C18FDA38F84712", // 145–148
  "0xfceEAdC436B28B686fa376671a7739e509fAe4aB", "0xa51563d2d254262E2E25aBA223BA8b2Cc2Ef962E", "0x64dd1794bBd8Da6Cf2C825Ebb63e329fA76aAf7a", "0x922B15397Bc5ae725f06460807D1e6129958FEde", // 149–152
  "0x03583fA89C62fb5166f9B16559149aEb8233580C", "0x3B22C37267DCf18FEb8E549a8b562B643ce5d9D2", "0xf3c8D0c689fDf69B3c05b18F8a3E0B31F328fF7A", "0x15a4317ac0784C0106Fdd9520ae1c681dBbda1Bf", // 153–156
  "0x632D0BddceA18B89dF816D89bbF8C00bAb86D7b7", "0x53a6eFf57F9F5D8D64829b9237e6beadacD3107f", "0x8B3f5CFC15F145D431DD8c72d00c5f2284336B8D", "0x2dfae485427012edd71B8F7a5B135Ada0d61A03A", // 157–160
  "0xd1ca51E013ca7D84aF6b8230ACF91fF372635a32", "0x15C2b3AdcA66E26B6F230b4023f52a285b7f9995", "0x20AeafB78d078f218B87437102c77a0949a0ACf4", "0xe746C8105D001521dA85523eea120A6aA584C37F", // 161–164
  "0x2905B3387c9550Ea57fa3EE7d4b7E5Abf3acD3d2", "0xd3d3aD77Bf35cE54A8575eccf04553218d9D348C", "0xd933aEf08D1Dae1b601468430C0242a9c2685DBc", "0x68F95BE6f8cd7B8d71262aDe8738f479B4594DeD", // 165–168
  "0x13072E3a95b4edD8608432EF6bA9b89cAd2640f6", "0x7BF6B861D5c119e1b2eE45b28B2dc6F7297AA5e4", "0xCc22dd2158195CD2d5B24A89e86C1D2EbFB818a4", "0xefc7F7Aa24784DD912DB321c9b7E57be6159C18E", // 169–172
  "0xE237D1599D5aA75283ebD8129106fcEd4034270E", "0xeb8eAE5A2F106E52c0ff440021AeFb16a77a038a", "0x7CAB36aA890768D7DFAAee364EE2AC754781BD26", "0x30cdE51d9BeC57d2604D91C1B412F3D8736C6a5b", // 173–176
  "0xE3E9Ba8c8C696f8537cF16b23EDDf118bbD7f21F", "0x53E0857fDdCb7434BB0aEAe3920c2b9cD394eF30", "0x0A5CFcff52277D14f06810e0A45fddf5fD141828", "0xae5c5E4723815A3149Fa0E1889D7ce4608D29BAb", // 177–180
  "0xAA43C63c727014B9E14fce0AFd32Ced157E7085e", "0x3ec2b198bFD46432Cd11FEC57B519086C3E673BD", "0x7514583C184c89CE425Df216BBD17c68B5821218", "0x60AF5A62a808237cb1858347ded9B8430c1748cA", // 181–184
  "0xBc40d379c90DefF02481ADfe223f0E33226656DA", "0x2EA3c215daeaCc1C90b51443aB5D08a9ad816138", "0x0417e87ba97A326Af037056e036a64D34d34B65F", "0x210752A388F92C9520e8921D58f7682BD2246138", // 185–188
  "0x8adF0876c1Bca8ac32425eeb08874ef98F131E8C", "0x5b491522f1d2259723fcCBbaf8887Bb1B7Fc7d97", "0x961E462A9bE15f3c929A82714B2fdC8345283ec8", "0x97997023aAB1D6b9760538Eb621bF10cfCD84868", // 189–192
  "0x185bD5d56CF5a7D0E8a68aDD81001340c7806FCE", "0x20D2C956B2e7efEa357a7a641Fd66aFC16a48F07", "0xd49B5B19dD4B0B66fcB7288196826BA2Fd11c0C8", "0x8Bf930d137EcFcEA11353DCb7d04cd764097e117", // 193–196
  "0x9FBa3bBE1F0b08A4220ED70e7B522507cdB7cdCD", "0x680ca8c5699F75374C3982D9778Cca9879cD20A9", "0xd1Ff240D0a8619C6F56ae39Dd098C7eF8F143d69", "0x6E225b58f28b7A801887eAE42539F1614Fc70aF7", // 197–200
  "0x9cfC452D3275928fCBA39571F9F49e6D5661e196", "0x8321c06B6c670c05A64A4a5006eF038d45477999", "0x35a170b1DB21785766578E0b195fD7e4AF4b3F22", "0xf966Dd9295368bb86DEFdeCC703871665771fa15", // 201–204
  "0x19E207F247EC21a79661ab44A388DD4A71315F80", "0x4CC64cEFA1c18215856de3e4Bc54a842DA0081f8", "0xBd07D0Ca900B8295d577BCd266718a3719557b2A", "0x5E2ca79B8862B46B1449602A23eD90ab81f7DCd2", // 205–208
  "0x97C52db42A8115cca7C9c8caA0105502212E4d45", // 209
];

const smAbi = parseAbi([
  "function epoch() view returns (uint256)",
  "function withdrawalDelay() view returns (uint256)",
  "function getValidatorContract(uint256) view returns (address)",
  "function validators(uint256) view returns (uint256 amount, uint256 reward, uint256 activationEpoch, uint256 deactivationEpoch, uint256 jailTime, address signer, address contractAddress, uint8 status, uint256 commissionRate, uint256 lastCommissionUpdate, uint256 delegatorsReward, uint256 delegatedAmount, uint256 initialRewardPerStake)",
]);
const shareAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function unbondNonces(address) view returns (uint256)",
  "function unbonds(address) view returns (uint256 shares, uint256 withdrawEpoch)",
  "function unbonds_new(address, uint256) view returns (uint256 shares, uint256 withdrawEpoch)",
  "function getLiquidRewards(address) view returns (uint256)",
  "function getTotalStake(address) view returns (uint256, uint256)",
  "function withdrawExchangeRate() view returns (uint256)",
  "function minAmount() view returns (uint256)",
  "function withdrawRewardsPOL()",
  "function unstakeClaimTokensPOL()",
  "function unstakeClaimTokens_newPOL(uint256 unbondNonce)",
  "function sellVoucher_newPOL(uint256 claimAmount, uint256 maximumSharesToBurn)",
]);

type Call = { address: Address; abi: typeof smAbi | typeof shareAbi; functionName: string; args?: readonly unknown[] };

/** Reads everything in as few eth_calls as possible (one for a wallet that never staked). Any failure fails the check. */
const readAll = (calls: Call[]): Promise<unknown[]> => bulkRead(calls as never);

interface Validator {
  id: number;
  share: Address;
}
interface Position extends Validator {
  shares: bigint;
  nonces: number;
  legacy: { shares: bigint; withdrawEpoch: bigint };
}

const positionCalls = (vs: Validator[], user: Address): Call[] =>
  vs.flatMap(({ share }) => [
    { address: share, abi: shareAbi, functionName: "balanceOf", args: [user] },
    { address: share, abi: shareAbi, functionName: "unbondNonces", args: [user] },
    { address: share, abi: shareAbi, functionName: "unbonds", args: [user] },
  ]);
const toPositions = (vs: Validator[], r: unknown[]): Position[] =>
  vs.map((v, i) => {
    const [shares, withdrawEpoch] = r[i * 3 + 2] as readonly [bigint, bigint];
    return { ...v, shares: r[i * 3] as bigint, nonces: Number(r[i * 3 + 1] as bigint), legacy: { shares, withdrawEpoch } };
  });

/** Foundation validators (ids below 8) keep the old exchange-rate precision. */
const precision = (id: number) => (id < 8 ? 100n : 10n ** 29n);
const polAsset = (amount: bigint): Asset => ({ symbol: "POL", decimals: 18, amount, token: POL, tokenChain: "ethereum" });

export async function checkPolygonStaking(user: Address): Promise<CheckOutput> {
  const known: Validator[] = VALIDATOR_SHARES.map((share, i) => ({ id: i + 1, share }));
  const probe = Array.from({ length: PROBE }, (_, i) => known.length + 1 + i);

  // 1. The checkpoint epoch, new validators, and the user's position in every validator (669 reads, one eth_call).
  const first = await readAll([
    { address: STAKE_MANAGER, abi: smAbi, functionName: "epoch" },
    { address: STAKE_MANAGER, abi: smAbi, functionName: "withdrawalDelay" },
    ...probe.map((id) => ({ address: STAKE_MANAGER, abi: smAbi, functionName: "getValidatorContract", args: [BigInt(id)] })),
    ...positionCalls(known, user),
  ]);
  const epoch = first[0] as bigint;
  const delay = first[1] as bigint;
  const added: Validator[] = probe.flatMap((id, i) => {
    const share = first[2 + i] as Address;
    return share !== zeroAddress ? [{ id, share }] : [];
  });
  let positions = toPositions(known, first.slice(2 + PROBE));
  if (added.length) positions = positions.concat(toPositions(added, await readAll(positionCalls(added, user))));
  const mine = positions.filter((p) => p.shares > 0n || p.nonces > 0 || p.legacy.shares > 0n);
  if (!mine.length) return { findings: [], completed: 0 };

  // 2. Details: rewards, stake and validator state where the user holds shares; each unstake request.
  const calls: Call[] = [];
  const at: Record<string, number> = {};
  const add = (key: string, call: Call) => {
    at[key] = calls.length;
    calls.push(call);
  };
  let unbondReads = 0;
  for (const p of mine) {
    if (p.shares > 0n) {
      add(`${p.id}:rewards`, { address: p.share, abi: shareAbi, functionName: "getLiquidRewards", args: [user] });
      add(`${p.id}:stake`, { address: p.share, abi: shareAbi, functionName: "getTotalStake", args: [user] });
      add(`${p.id}:min`, { address: p.share, abi: shareAbi, functionName: "minAmount" });
      add(`${p.id}:validator`, { address: STAKE_MANAGER, abi: smAbi, functionName: "validators", args: [BigInt(p.id)] });
    }
    if (p.nonces > 0 || p.legacy.shares > 0n) add(`${p.id}:rate`, { address: p.share, abi: shareAbi, functionName: "withdrawExchangeRate" });
    for (let n = 1; n <= p.nonces && unbondReads < MAX_UNBONDS; n++, unbondReads++)
      add(`${p.id}:unbond:${n}`, { address: p.share, abi: shareAbi, functionName: "unbonds_new", args: [user, BigInt(n)] });
  }
  const r = await readAll(calls);
  const get = <T>(key: string) => r[at[key]] as T;

  // 3. Everything withdrawable now, each simulated from the user's address.
  interface Claim {
    key: string;
    p: Position;
    amount: bigint;
    data: Hex;
    fn: string;
    note: string;
  }
  const claims: Claim[] = [];
  for (const p of mine) {
    const where = `validator #${p.id}'s contract (${p.share})`;
    if (p.shares > 0n) {
      const rewards = get<bigint>(`${p.id}:rewards`);
      if (rewards >= get<bigint>(`${p.id}:min`))
        claims.push({
          key: "rewards",
          p,
          amount: rewards,
          data: encodeFunctionData({ abi: shareAbi, functionName: "withdrawRewardsPOL" }),
          fn: "withdrawRewardsPOL",
          note: `Rewards from staking with Polygon validator #${p.id}, never withdrawn. Withdraw them at staking.polygon.technology, or on Etherscan: Write as Proxy → withdrawRewardsPOL on ${where}, from this wallet.`,
        });
      const deactivation = get<readonly unknown[]>(`${p.id}:validator`)[3] as bigint;
      const [stake] = get<readonly [bigint, bigint]>(`${p.id}:stake`);
      if (deactivation > 0n && deactivation <= epoch && stake > 0n)
        claims.push({
          key: "stake",
          p,
          amount: stake,
          data: encodeFunctionData({ abi: shareAbi, functionName: "sellVoucher_newPOL", args: [stake, p.shares] }),
          fn: "sellVoucher_newPOL",
          note: `This POL is still delegated to Polygon validator #${p.id}, which has stopped validating: it earns nothing anymore. Unstake it at staking.polygon.technology (or sellVoucher_newPOL on ${where}), then claim it after 80 checkpoints, about a day.`,
        });
    }
    const unbonds: [string, bigint, bigint, Hex, string][] = [];
    if (p.legacy.shares > 0n)
      unbonds.push(["unbond", p.legacy.shares, p.legacy.withdrawEpoch, encodeFunctionData({ abi: shareAbi, functionName: "unstakeClaimTokensPOL" }), "unstakeClaimTokensPOL"]);
    for (let n = 1; n <= p.nonces; n++) {
      if (at[`${p.id}:unbond:${n}`] === undefined) break;
      const [shares, withdrawEpoch] = get<readonly [bigint, bigint]>(`${p.id}:unbond:${n}`);
      if (shares > 0n)
        unbonds.push([
          `unbond:${n}`,
          shares,
          withdrawEpoch,
          encodeFunctionData({ abi: shareAbi, functionName: "unstakeClaimTokens_newPOL", args: [BigInt(n)] }),
          `unstakeClaimTokens_newPOL(${n})`,
        ]);
    }
    for (const [key, shares, withdrawEpoch, data, fn] of unbonds) {
      if (withdrawEpoch + delay > epoch) continue; // still in its waiting period: nothing is stuck yet
      claims.push({
        key,
        p,
        amount: (get<bigint>(`${p.id}:rate`) * shares) / precision(p.id),
        data,
        fn,
        note: `You unstaked this POL from Polygon validator #${p.id} and its waiting period is over, but it was never claimed. Claim it at staking.polygon.technology, or on Etherscan: Write as Proxy → ${fn} on ${where}, from this wallet.`,
      });
    }
  }

  const out: CheckOutput = { findings: [], completed: 0 };
  const errors: string[] = [];
  await Promise.all(
    claims.map(async (c) => {
      let ok: boolean;
      try {
        ok = await wouldSucceed(l1Client(), { from: user, to: c.p.share, data: c.data });
      } catch (e) {
        errors.push(`validator #${c.p.id}: ${(e as Error).message.split("\n")[0]}`);
        return;
      }
      if (!ok) return;
      out.findings.push(
        makeFinding(POLYGON_STAKING, {
          key: c.key,
          label: c.key === "rewards" ? "Polygon staking rewards" : "Polygon staking",
          status: "ready",
          asset: polAsset(c.amount),
          txHash: c.p.share,
          txUrl: `https://etherscan.io/address/${c.p.share}#writeProxyContract`,
          linkLabel: "Open the contract",
          timestamp: 0,
          note: c.note,
          claimAt: "staking.polygon.technology",
          minUsd: MIN_USD,
        }),
      );
    }),
  );
  if (unbondReads >= MAX_UNBONDS && mine.reduce((n, p) => n + p.nonces, 0) > MAX_UNBONDS)
    errors.push(`only the first ${MAX_UNBONDS} unstake requests were checked`);
  if (errors.length) out.error = `claim check failed: ${errors.join(" · ")}`;
  return out;
}
