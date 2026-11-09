/**
 * Site settings. Edit these before deploying.
 * Sections tied to an empty value are hidden automatically.
 */
export const SITE = {
  name: "FundsCheckers",
  /** Public address of the site, used for link previews and shared results. */
  url: "https://www.fundscheckers.com",
  /** The address as people type it, without https:// or www. */
  domain: "fundscheckers.com",
  title: "FundsCheckers — find the crypto you forgot to claim",
  description:
    "Unfinished bridge withdrawals, unclaimed airdrops, rewards and old deposits: check any Ethereum or Solana address in seconds. Free, read-only, no wallet connection.",
  /** e.g. "https://x.com/yourhandle" */
  twitter: "",
  /** Tip addresses. Leave empty to hide the Tip section. */
  tips: {
    evm: { address: "0x55Fd19b31DeE7BdbE6745B33a2DD9DfA8B684bB6", label: "" }, // label: e.g. an ENS name
    solana: { address: "B8tZrAXiEW8u6ibE8whwgbML1wzMzHXnQtJZd4BQezyK" },
    bitcoin: { address: "bc1qf2h32fruxj56jkfeydxgf9ppga5yvqmlr4vx64" },
  },
};
