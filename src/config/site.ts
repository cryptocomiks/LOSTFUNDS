/**
 * Site settings. Edit these before deploying.
 * Sections tied to an empty value are hidden automatically.
 */
export const SITE = {
  name: "lostfunds",
  title: "Lost Funds Checker",
  description:
    "Check if your crypto is stuck in a bridge: withdrawals you started but never finished. Free, read-only, no wallet connection.",
  /** e.g. "https://x.com/yourhandle" */
  twitter: "",
  /** Tip addresses. Leave empty to hide the Tip section. */
  tips: {
    evm: { address: "", label: "" }, // label: e.g. an ENS name
    solana: { address: "" },
  },
};
