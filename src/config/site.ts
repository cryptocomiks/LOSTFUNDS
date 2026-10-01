/**
 * Site settings. Edit these before deploying.
 * Sections tied to an empty value are hidden automatically.
 */
export const SITE = {
  name: "lostfunds",
  title: "lostfunds — find the crypto you forgot to claim",
  description:
    "Unfinished bridge withdrawals, unclaimed airdrops, rewards and old deposits: check any Ethereum or Solana address in seconds. Free, read-only, no wallet connection.",
  /** e.g. "https://x.com/yourhandle" */
  twitter: "",
  /** Tip addresses. Leave empty to hide the Tip section. */
  tips: {
    evm: { address: "", label: "" }, // label: e.g. an ENS name
    solana: { address: "" },
  },
};
