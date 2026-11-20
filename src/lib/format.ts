import { formatUnits } from "viem";

/** A token amount as people write it: "1,234.5" in English, "1 234,5" in French. */
export function formatAmount(amount: bigint, decimals: number, lang: "en" | "fr" = "en"): string {
  const n = Number(formatUnits(amount, decimals));
  if (n === 0) return "0";
  const locale = lang === "fr" ? "fr-FR" : "en-US";
  if (n < 1e-9) return lang === "fr" ? "<0,000000001" : "<0.000000001";
  // Tiny amounts can be worth a lot (pool tokens): three significant digits instead of "<0.0001".
  if (n < 0.0001) return n.toLocaleString(locale, { maximumSignificantDigits: 3, maximumFractionDigits: 12 });
  const digits = n >= 1000 ? 0 : n >= 1 ? 4 : 6;
  return n.toLocaleString(locale, { maximumFractionDigits: digits, maximumSignificantDigits: n >= 1000 ? undefined : 6 });
}

export function formatUsd(n: number, lang: "en" | "fr" = "en"): string {
  const digits = n >= 1000 ? 0 : 2;
  if (lang === "fr") {
    if (n < 0.01) return "<0,01 $";
    return `${n.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits })} $`;
  }
  if (n < 0.01) return "<$0.01";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  });
}

export function formatDate(unix: number, lang: "en" | "fr" = "en"): string {
  return new Date(unix * 1000).toLocaleDateString(lang === "fr" ? "fr-FR" : "en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
