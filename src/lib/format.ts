import { formatUnits } from "viem";

export function formatAmount(amount: bigint, decimals: number): string {
  const n = Number(formatUnits(amount, decimals));
  if (n === 0) return "0";
  if (n < 0.0001) return "<0.0001";
  const digits = n >= 1000 ? 0 : n >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, maximumSignificantDigits: n >= 1000 ? undefined : 6 });
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
