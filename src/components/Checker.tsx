"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { checkSource, InputError, resolveInput, runChecks, sourcesFor, type Target, type WalletKind } from "@/lib/checker";
import { NETWORK_COLORS } from "@/lib/brand";
import { formatAmount, formatDate, formatUsd, shortAddress } from "@/lib/format";
import { GROUPS, sourceById, type Group } from "@/lib/sources";
import type { Finding, NetworkResult, WithdrawalStatus } from "@/lib/types";
import { CopyButton } from "./CopyButton";
import {
  Alert,
  ArrowRight,
  ArrowUpRight,
  CheckCircle,
  Clock,
  Lock,
  Refresh,
  Search,
  Shield,
  Spinner,
} from "./icons";

type Phase = "idle" | "resolving" | "checking" | "done";

const STATUS: Record<WithdrawalStatus, { label: string; tone: string; group: string; order: number }> = {
  ready: { label: "Ready to claim", tone: "bg-green-soft text-green", group: "Ready to claim", order: 0 },
  prove: { label: "Needs prove", tone: "bg-orange-soft text-orange", group: "Needs a prove step", order: 1 },
  manual: { label: "Check manually", tone: "bg-orange-soft text-orange", group: "Legacy withdrawals", order: 2 },
  waiting: { label: "Waiting", tone: "bg-purple-soft text-purple", group: "In the waiting period", order: 3 },
  recent: { label: "In progress", tone: "bg-fill-strong text-text-2", group: "Started recently", order: 4 },
};

const STATUS_HELP: Record<WithdrawalStatus, (f: Finding) => string> = {
  ready: () => "The last step can be done now, from your own wallet, through the official bridge.",
  prove: () => "Prove it on Ethereum, wait about 7 days, then finalize.",
  manual: (f) => f.note ?? "This withdrawal uses an older format. Check it in the bridge's official app.",
  waiting: (f) =>
    f.readyAt ? `Claimable from ${formatDate(f.readyAt)}.` : "Still inside the bridge's waiting period.",
  recent: () => "Started less than a week ago. It's probably still in progress, not stuck.",
};

const NetDot = ({ id, size = 10 }: { id: string; size?: number }) => (
  <span
    className="inline-block shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/15"
    style={{ width: size, height: size, background: NETWORK_COLORS[id] ?? "var(--text-3)" }}
  />
);

function openGuide(id: string) {
  history.replaceState(null, "", `${location.pathname}${location.search}#guide-${id}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  document.getElementById(`guide-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ───────────────────────── Finding row ───────────────────────── */

function FindingRow({ f, index }: { f: Finding; index: number }) {
  const s = STATUS[f.status];
  const net = sourceById(f.networkId)!;
  return (
    <li className="animate-fade-up px-5 py-5 sm:px-6" style={{ animationDelay: `${index * 50}ms` }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] text-text-2">
          <NetDot id={f.networkId} />
          <span className="font-medium text-text">{f.networkName}</span>
          <span aria-hidden>·</span>
          <span>
            {f.networkId === "airdrops" ? "Airdropped" : "Sent"} {formatDate(f.timestamp)}
          </span>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${s.tone}`}>{s.label}</span>
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[28px] leading-tight font-semibold tracking-tight tabular-nums">
          {formatAmount(f.asset.amount, f.asset.decimals)} <span className="text-text-2">{f.asset.symbol}</span>
        </span>
        {f.asset.usd !== undefined && (
          <span className="text-[17px] text-text-2 tabular-nums">≈ {formatUsd(f.asset.usd)}</span>
        )}
      </div>

      <p className="mt-1.5 text-[15px] leading-relaxed text-text-2">{f.note ?? STATUS_HELP[f.status](f)}</p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => openGuide(f.guideId)}
          className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[14px] font-medium text-white transition hover:bg-accent-hover active:scale-[0.97]"
        >
          How to claim <ArrowRight width={15} height={15} />
        </button>
        <a
          href={f.txUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-full px-3 py-2 text-[14px] text-link hover:underline"
        >
          View transaction <ArrowUpRight width={14} height={14} />
        </a>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-text-3">
        Where to claim:
        <code className="rounded-md bg-fill px-1.5 py-0.5 font-mono text-[12px] text-text-2">{net.bridgeUrl}</code>
        <span className="hidden sm:inline">(type it yourself)</span>
      </div>
    </li>
  );
}

/* ───────────────────────── Network status grid ───────────────────────── */

function NetworkGrid({
  results,
  onRetry,
  kind,
}: {
  results: Record<string, NetworkResult>;
  onRetry: (id: string) => void;
  kind: WalletKind;
}) {
  const sources = sourcesFor(kind);
  return (
    <div className="space-y-5">
      {(Object.keys(GROUPS) as Group[]).filter((g) => sources.some((s) => s.group === g)).map((g) => (
        <div key={g}>
          <p className="mb-2 px-1 text-[13px] font-medium text-text-2">{GROUPS[g]}</p>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {sources.filter((n) => n.group === g).map((n) => {
              const r = results[n.id];
              const state = r?.state ?? "queued";
              const found = r?.findings.filter((f) => f.status !== "recent").length ?? 0;
              return (
                <li
                  key={n.id}
                  className="flex items-center justify-between gap-2 rounded-2xl border border-line bg-surface px-3.5 py-3 text-[14px]"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <NetDot id={n.id} />
                    <span className="truncate">{n.name}</span>
                  </span>
                  {state === "running" || state === "queued" ? (
                    <Spinner className="text-text-3" />
                  ) : state === "error" ? (
                    <button
                      type="button"
                      onClick={() => onRetry(n.id)}
                      className="flex items-center gap-1 rounded-full bg-red-soft px-2 py-0.5 text-[12px] font-medium text-red"
                      title={r?.error}
                    >
                      <Refresh width={13} height={13} /> Retry
                    </button>
                  ) : found > 0 ? (
                    <span className="rounded-full bg-orange-soft px-2 py-0.5 text-[12px] font-semibold text-orange tabular-nums">
                      {found}
                    </span>
                  ) : (
                    <CheckCircle width={18} height={18} className="text-green" />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── Main ───────────────────────── */

export function Checker() {
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [results, setResults] = useState<Record<string, NetworkResult>>({});
  const abortRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const run = useCallback(async (raw: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setResults({});
    setPhase("resolving");
    try {
      const resolved = await resolveInput(raw);
      if (ctrl.signal.aborted) return;
      setTarget(resolved);
      setPhase("checking");
      const url = new URL(location.href);
      url.searchParams.set("address", resolved.ens ?? resolved.address);
      url.hash = "";
      history.replaceState(null, "", url);
      requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
      const failed: string[] = [];
      await runChecks(
        resolved,
        (r) => {
          if (r.state === "error") failed.push(r.networkId);
          setResults((prev) => ({ ...prev, [r.networkId]: r }));
        },
        ctrl.signal,
      );
      // One automatic second attempt for networks whose data sources were busy.
      if (failed.length && !ctrl.signal.aborted) {
        await new Promise((r) => setTimeout(r, 1500));
        await Promise.all(
          failed.map(async (id) => {
            if (ctrl.signal.aborted) return;
            setResults((prev) => ({ ...prev, [id]: { networkId: id, state: "running", findings: [], completed: 0 } }));
            const r = await checkSource(sourceById(id)!, resolved.address);
            if (!ctrl.signal.aborted) setResults((prev) => ({ ...prev, [id]: r }));
          }),
        );
      }
      if (!ctrl.signal.aborted) setPhase("done");
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setPhase("idle");
      setError(e instanceof InputError ? e.message : "Couldn't resolve that name. Check your connection and try again.");
    }
  }, []);

  const retry = useCallback(
    async (id: string) => {
      const net = sourceById(id);
      if (!net || !target) return;
      setResults((prev) => ({ ...prev, [id]: { networkId: id, state: "running", findings: [], completed: 0 } }));
      const r = await checkSource(net, target.address);
      setResults((prev) => ({ ...prev, [id]: r }));
    },
    [target],
  );

  // Shareable links: ?address=0x… runs the check on load.
  useEffect(() => {
    const a = new URLSearchParams(location.search).get("address");
    if (a) {
      setInput(a);
      run(a);
    }
    return () => abortRef.current?.abort();
  }, [run]);

  const all = useMemo(
    () =>
      Object.values(results)
        .flatMap((r) => r.findings)
        .sort((a, b) => STATUS[a.status].order - STATUS[b.status].order || (b.asset.usd ?? 0) - (a.asset.usd ?? 0)),
    [results],
  );
  const stuck = all.filter((f) => f.status !== "recent");
  const totalUsd = stuck.reduce((s, f) => s + (f.asset.usd ?? 0), 0);
  const finished = Object.values(results).filter((r) => r.state === "done" || r.state === "error").length;
  const errors = Object.values(results).filter((r) => r.state === "error").length;
  const completed = Object.values(results).reduce((s, r) => s + r.completed, 0);
  const busy = phase === "resolving" || phase === "checking";

  const groups = useMemo(() => {
    const g = new Map<WithdrawalStatus, Finding[]>();
    for (const f of all) g.set(f.status, [...(g.get(f.status) ?? []), f]);
    return [...g.entries()];
  }, [all]);

  return (
    <>
      {/* ───── Hero ───── */}
      <section id="top" className="hero-glow relative overflow-hidden">
        <div className="mx-auto max-w-[980px] px-4 pt-20 pb-16 text-center sm:px-6 sm:pt-28 sm:pb-24">
          <p className="animate-fade-up text-[13px] font-semibold tracking-[0.14em] text-accent uppercase">
            Unclaimed bridge withdrawals
          </p>
          <h1
            className="animate-fade-up mx-auto mt-4 max-w-[820px] text-[44px] leading-[1.04] font-semibold tracking-[-0.035em] sm:text-[72px] md:text-[84px]"
            style={{ animationDelay: "60ms" }}
          >
            Is your crypto <br className="hidden sm:block" />
            <span className="text-gradient">stuck in a bridge?</span>
          </h1>
          <p
            className="animate-fade-up mx-auto mt-6 max-w-[620px] text-[19px] leading-relaxed text-text-2 sm:text-[21px]"
            style={{ animationDelay: "120ms" }}
          >
            Many withdrawals need one last step on the destination chain. If it never happened, the funds are still
            waiting for you.
          </p>

          <div className="animate-fade-up mx-auto mt-10 max-w-[680px]" style={{ animationDelay: "180ms" }}>
            <p className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-surface/70 px-4 py-2 text-[13px] text-text-2 backdrop-blur">
              <Shield width={15} height={15} className="shrink-0 text-green" />
              Runs in your browser. We never log or store the addresses you check.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) run(input);
              }}
              className="group flex items-center gap-2 rounded-full border border-line bg-surface p-2 pl-5 shadow-float transition focus-within:border-accent/50 focus-within:ring-4 focus-within:ring-accent-soft"
            >
              <Search className="shrink-0 text-text-3" />
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Paste an Ethereum or Solana address, or ENS name"
                aria-label="Ethereum or Solana address, or ENS name"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                className="min-w-0 flex-1 bg-transparent py-3 text-[17px] outline-none placeholder:text-text-3"
              />
              <button
                type="submit"
                disabled={busy}
                className="flex h-12 shrink-0 items-center gap-2 rounded-full bg-accent px-6 text-[16px] font-medium text-white transition hover:bg-accent-hover active:scale-[0.97] disabled:opacity-70"
              >
                {busy ? <Spinner className="text-white" /> : null}
                {busy ? "Checking" : "Check"}
              </button>
            </form>

            {error ? (
              <p role="alert" className="mt-4 flex items-center justify-center gap-2 text-[14px] text-red">
                <Alert width={16} height={16} /> {error}
              </p>
            ) : (
              <p className="mt-4 flex items-center justify-center gap-2 text-[13px] text-text-3">
                <Lock width={14} height={14} />
                Read-only. No wallet connection, no signatures. Ethereum and Solana addresses, ENS names.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ───── Results ───── */}
      {target && phase !== "idle" && (
        <section ref={resultsRef} className="scroll-mt-16 bg-bg-alt" aria-live="polite">
          <div className="mx-auto max-w-[980px] px-4 py-14 sm:px-6 sm:py-20">
            {/* Summary */}
            <div className="animate-fade-up overflow-hidden rounded-3xl border border-line bg-surface shadow-soft">
              <div className="p-6 sm:p-8">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-[14px] text-text-2">
                    <span className="font-mono">{target.ens ?? shortAddress(target.address)}</span>
                    {target.ens && <span className="font-mono text-text-3">{shortAddress(target.address)}</span>}
                  </div>
                  <div className="flex items-center gap-2 text-[13px] text-text-3 tabular-nums">
                    {busy && <Spinner className="text-accent" />}
                    {finished}/{sourcesFor(target.kind).length} checks done
                  </div>
                </div>

                {busy && stuck.length === 0 ? (
                  <div className="mt-6">
                    <p className="text-[28px] font-semibold tracking-tight sm:text-[34px]">Checking bridges…</p>
                    <p className="mt-2 text-[15px] text-text-2">
                      Finding your withdrawals, cross-chain transfers and airdrops, then asking each chain whether it was completed.
                    </p>
                  </div>
                ) : stuck.length > 0 ? (
                  <div className="mt-6">
                    <p className="text-[15px] font-medium text-orange">
                      {stuck.length} unclaimed transfer{stuck.length > 1 ? "s" : ""} found
                    </p>
                    <p className="mt-1 text-[44px] leading-none font-semibold tracking-[-0.03em] tabular-nums sm:text-[56px]">
                      {totalUsd > 0 ? formatUsd(totalUsd) : `${stuck.length} to claim`}
                    </p>
                    <p className="mt-3 max-w-[560px] text-[15px] text-text-2">
                      Claiming always sends 100% of the funds to your own address, through the official bridge. Nobody
                      else can do it for you, and nobody needs your seed phrase.
                    </p>
                  </div>
                ) : errors > 0 ? (
                  <div className="mt-6 flex items-start gap-4">
                    <Alert width={40} height={40} className="mt-1 shrink-0 text-orange" />
                    <div>
                      <p className="text-[28px] font-semibold tracking-tight sm:text-[34px]">Check incomplete</p>
                      <p className="mt-2 text-[15px] text-text-2">
                        {errors} check{errors > 1 ? "s" : ""} couldn&apos;t run right now, so we can&apos;t say
                        yet. Nothing was found on the {finished - errors} others. Retry the missing ones below.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="mt-6 flex items-start gap-4">
                    <CheckCircle width={40} height={40} className="mt-1 shrink-0 text-green" />
                    <div>
                      <p className="text-[28px] font-semibold tracking-tight sm:text-[34px]">No stuck funds found</p>
                      <p className="mt-2 text-[15px] text-text-2">
                        {completed > 0
                          ? `All ${completed} withdrawal${completed > 1 ? "s" : ""} we found were completed.`
                          : "We didn't find any unfinished withdrawals on the networks we check."}{" "}
                      </p>
                    </div>
                  </div>
                )}
              </div>
              {busy && <div className="shimmer h-0.5 w-full" />}
            </div>

            {/* Findings */}
            {groups.map(([status, items]) => (
              <div key={status} className="mt-10">
                <h3 className="mb-3 px-1 text-[13px] font-semibold tracking-wide text-text-3 uppercase">
                  {STATUS[status].group}
                </h3>
                <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-3xl border border-line bg-surface shadow-soft">
                  {items.map((f, i) => (
                    <FindingRow key={f.id} f={f} index={i} />
                  ))}
                </ul>
              </div>
            ))}

            {/* Networks */}
            <div className="mt-10">
              <div className="mb-3 flex items-center justify-between px-1">
                <h3 className="text-[13px] font-semibold tracking-wide text-text-3 uppercase">What we checked</h3>
                {phase === "done" && (
                  <span className="flex items-center gap-1.5 text-[13px] text-text-3">
                    <Clock width={14} height={14} /> Live data, just now
                  </span>
                )}
              </div>
              <NetworkGrid results={results} onRetry={retry} kind={target.kind} />
              {Object.values(results).some((r) => r.state === "error") && (
                <details className="mt-3 rounded-2xl border border-line bg-surface px-4 py-3 text-[13px] text-text-2">
                  <summary className="cursor-pointer font-medium text-text">Why did some checks fail?</summary>
                  <ul className="mt-2 space-y-1 font-mono text-[12px] break-all">
                    {Object.values(results)
                      .filter((r) => r.state === "error")
                      .map((r) => (
                        <li key={r.networkId}>
                          {sourceById(r.networkId)?.name}: {r.error}
                        </li>
                      ))}
                  </ul>
                </details>
              )}
              <p className="mt-4 px-1 text-[13px] leading-relaxed text-text-3">
                Other bridges (ZKsync, Starknet, LayerZero, Synapse…) aren&apos;t checked automatically
                yet. If you used one, follow its guide below.
              </p>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
