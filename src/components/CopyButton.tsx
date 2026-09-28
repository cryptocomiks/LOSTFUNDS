"use client";

import { useState } from "react";
import { Check, Copy } from "./icons";

export function CopyButton({ value, label = "Copy", className = "" }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard blocked */
        }
      }}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] font-medium text-text transition hover:bg-fill active:scale-[0.97] ${className}`}
      aria-label={`${label} ${value}`}
    >
      {copied ? <Check width={15} height={15} className="text-green" /> : <Copy width={15} height={15} />}
      {copied ? "Copied" : label}
    </button>
  );
}
