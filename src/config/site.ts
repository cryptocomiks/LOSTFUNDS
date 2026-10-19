/**
 * Site settings. Edit these before deploying.
 * Sections tied to an empty value are hidden automatically.
 */
export const SITE = {
  name: "FundsCheckers",
  /** Public address of the site, used for link previews and shared results. */
  // Switches to https://www.fundscheckers.com once its DNS points to Vercel.
  url: "https://lostfunds.vercel.app",
  /** The address as people type it, without https:// or www. */
  domain: "fundscheckers.com",
  title: "FundsCheckers — find the crypto you forgot to claim",
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
