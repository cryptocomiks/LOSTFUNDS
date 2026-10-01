"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { checkSource, InputError, resolveInput, runChecks, sourcesFor, type Target, type WalletKind } from "@/lib/checker";
import { readCache, writeCache } from "@/lib/resultCache";
import { NETWORK_COLORS } from "@/lib/brand";
import { formatAmount, formatDate, formatUsd, shortAddress } from "@/lib/format";
import { GROUPS, sourceById, type CheckSource, type Group } from "@/lib/sources";
import type { Finding, NetworkResult, WithdrawalStatus } from "@/lib/types";
import { CopyButton } from "./CopyButton";
import {
  Alert,
  ArrowRight,
  ArrowUpRight,
  CheckCircle,
  Chevron,
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
  manual: { label: "Check manually", tone: "bg-orange-soft text-orange", group: "Needs a manual step", order: 2 },
  waiting: { label: "Waiting", tone: "bg-purple-soft text-purple", group: "In the waiting period", order: 3 },
  recent: { label: "In progress", tone: "bg-fill-strong text-text-2", group: "Started recently", order: 4 },
};

const STATUS_HELP: Record<WithdrawalStatus, (f: Finding) => string> = {
  ready: () => "You can claim it now, from your own wallet, through the official app.",
  prove: () => "Prove it on Ethereum, wait about 7 days, then finalize.",
  manual: (f) => f.note ?? "This one needs a manual step. Follow the guide.",
  waiting: (f) =>
    f.readyAt ? `Claimable from ${formatDate(f.readyAt)}.` : "Still inside the bridge's waiting period.",
  recent: () => "Started recently. It's probably still in progress, not forgotten.",
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
  // Some findings (airdrops) come from a source listed under another id: never assume it exists.
  const source = sourceById(f.networkId);
  const claimAt = f.claimAt ?? source?.bridgeUrl;
  // Reclaimable SOL sits in accounts, not in a transfer: no date, and the link opens the account.
  const inAccount = source?.group === "reclaim";
  return (
    <li className="animate-fade-up px-5 py-5 sm:px-6" style={{ animationDelay: `${index * 50}ms` }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] text-text-2">
          <NetDot id={f.networkId} />
          <span className="font-medium text-text">{f.networkName}</span>
          {f.timestamp > 0 && !inAccount && (
            <>
              <span aria-hidden>·</span>
              <span>
                {f.dateLabel ?? (f.networkId === "airdrops" ? "Airdropped" : "Sent")} {formatDate(f.timestamp)}
              </span>
            </>
          )}
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
          {inAccount ? "View on Solscan" : f.txUrl.includes("/tx/") ? "View transaction" : "View on explorer"} <ArrowUpRight width={14} height={14} />
        </a>
      </div>

      {claimAt && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-text-3">
          Where to claim:
          <code className="rounded-md bg-fill px-1.5 py-0.5 font-mono text-[12px] text-text-2">{claimAt}</code>
          <span className="hidden sm:inline">(type it yourself)</span>
        </div>
      )}
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
    <div className="space-y-3">
      {(Object.keys(GROUPS) as Group[])
        .filter((g) => sources.some((s) => s.group === g))
        .map((g) => (
          <GroupBlock key={g} group={g} sources={sources.filter((n) => n.group === g)} results={results} onRetry={onRetry} />
        ))}
    </div>
  );
}

/** One group of checks: a summary line, opened automatically when something needs attention. */
function GroupBlock({
  group,
  sources,
  results,
  onRetry,
}: {
  group: Group;
  sources: CheckSource[];
  results: Record<string, NetworkResult>;
  onRetry: (id: string) => void;
}) {
  const states = sources.map((n) => results[n.id]);
  const done = states.filter((r) => r?.state === "done" || r?.state === "error").length;
  const failed = states.filter((r) => r?.state === "error").length;
  const found = states.reduce((n, r) => n + (r?.findings.filter((f) => f.status !== "recent").length ?? 0), 0);
  const attention = failed > 0 || found > 0;
  const [open, setOpen] = useState(attention);
  useEffect(() => {
    if (attention) setOpen(true);
  }, [attention]);

  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-fill sm:px-5"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="truncate text-[15px] font-medium">{GROUPS[group]}</span>
          <span className="shrink-0 text-[13px] text-text-3 tabular-nums">
            {done < sources.length ? `${done}/${sources.length}` : `${sources.length} checked`}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {found > 0 && (
            <span className="rounded-full bg-orange-soft px-2 py-0.5 text-[12px] font-semibold text-orange tabular-nums">
              {found} found
            </span>
          )}
          {failed > 0 && (
            <span className="rounded-full bg-red-soft px-2 py-0.5 text-[12px] font-semibold text-red tabular-nums">
              {failed} failed
            </span>
          )}
          {done < sources.length ? (
            <Spinner className="text-text-3" />
          ) : !attention ? (
            <CheckCircle width={18} height={18} className="text-green" />
          ) : null}
          <Chevron width={16} height={16} className={`text-text-3 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open && (
        <ul className="grid grid-cols-2 gap-2 border-t border-line p-3 sm:grid-cols-3 md:grid-cols-4">
          {sources.map((n) => {
            const r = results[n.id];
            const state = r?.state ?? "queued";
            const count = r?.findings.filter((f) => f.status !== "recent").length ?? 0;
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
                ) : count > 0 ? (
                  <span className="rounded-full bg-orange-soft px-2 py-0.5 text-[12px] font-semibold text-orange tabular-nums">
                    {count}
                  </span>
                ) : (
                  <CheckCircle width={18} height={18} className="text-green" />
                )}
              </li>
            );
          })}
        </ul>
      )}
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
  /** When the shown results come (partly) from this browser's recent cache. */
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Start of the current run: the cache entry's age (so it expires 10 min after the check, not later). */
  const startedAtRef = useRef(0);
  const resultsRef = useRef<HTMLDivElement>(null);

  const run = useCallback(async (raw: string, fresh = false) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setResults({});
    setCachedAt(null);
    startedAtRef.current = Date.now();
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

      // Checks this browser completed a few minutes ago are shown as they were; only the rest run.
      const cached = fresh ? null : readCache(resolved.kind, resolved.address);
      const known = new Set(sourcesFor(resolved.kind).map((s) => s.id));
      const reused = (cached?.results ?? []).filter((r) => known.has(r.networkId));
      if (reused.length) {
        setCachedAt(cached!.at);
        setResults(Object.fromEntries(reused.map((r) => [r.networkId, r])));
      }
      const todo = [...known].filter((id) => !reused.some((r) => r.networkId === id));

      const failed: string[] = [];
      const update = (r: NetworkResult) => {
        if (r.state === "error") failed.push(r.networkId);
        setResults((prev) => ({ ...prev, [r.networkId]: r }));
      };
      if (todo.length) await runChecks(resolved, update, ctrl.signal, todo);
      // One automatic second attempt for checks whose data sources were busy. The wait is longer
      // and randomized so that many visitors on one network don't all retry at the same instant.
      if (failed.length && !ctrl.signal.aborted) {
        await new Promise((r) => setTimeout(r, 4000 + Math.random() * 3000));
        if (!ctrl.signal.aborted) await runChecks(resolved, (r) => setResults((prev) => ({ ...prev, [r.networkId]: r })), ctrl.signal, failed);
      }
      if (!ctrl.signal.aborted) setPhase("done");
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setPhase("idle");
      setError(e instanceof InputError ? e.message : "Couldn't resolve that name. Check your connection and try again.");
    }
  }, []);

  // Keep this browser's short-lived cache up to date as checks complete (including manual retries),
  // so a reload or a reopened link mid-way doesn't start over.
  useEffect(() => {
    if (target && phase !== "idle" && phase !== "resolving")
      writeCache(target.kind, target.address, Object.values(results), cachedAt ?? startedAtRef.current);
  }, [phase, results, target, cachedAt]);

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
            Unclaimed crypto finder
          </p>
          <h1
            className="animate-fade-up mx-auto mt-4 max-w-[820px] text-[44px] leading-[1.04] font-semibold tracking-[-0.035em] sm:text-[72px] md:text-[84px]"
            style={{ animationDelay: "60ms" }}
          >
            Is money still <br className="hidden sm:block" />
            <span className="text-gradient">waiting for you?</span>
          </h1>
          <p
            className="animate-fade-up mx-auto mt-6 max-w-[620px] text-[19px] leading-relaxed text-text-2 sm:text-[21px]"
            style={{ animationDelay: "120ms" }}
          >
            Bridge withdrawals you never finished, airdrops you never claimed, rewards and deposits you forgot.
            Paste an address: we check them all, live on-chain.
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
                    <p className="text-[28px] font-semibold tracking-tight sm:text-[34px]">Checking…</p>
                    <p className="mt-2 text-[15px] text-text-2">
                      Looking for unfinished withdrawals, stuck transfers, unclaimed airdrops and rewards, then asking each
                      chain whether they&apos;re still waiting for you.
                    </p>
                  </div>
                ) : stuck.length > 0 ? (
                  <div className="mt-6">
                    <p className="text-[15px] font-medium text-orange">
                      {stuck.length} thing{stuck.length > 1 ? "s" : ""} to claim
                    </p>
                    <p className="mt-1 text-[44px] leading-none font-semibold tracking-[-0.03em] tabular-nums sm:text-[56px]">
                      {totalUsd > 0 ? formatUsd(totalUsd) : `${stuck.length} to claim`}
                    </p>
                    <p className="mt-3 max-w-[560px] text-[15px] text-text-2">
                      Claiming always sends 100% of the funds to your own address, through the official app. Nobody
                      else can do it for you, and nobody needs your seed phrase. Open &quot;How to claim&quot; on each
                      line for the steps.
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
                      <p className="text-[28px] font-semibold tracking-tight sm:text-[34px]">Nothing left behind</p>
                      <p className="mt-2 text-[15px] text-text-2">
                        {completed > 0
                          ? `All ${completed} withdrawal${completed > 1 ? "s" : ""} we found were completed.`
                          : `Nothing is waiting for this address in the ${finished} places we checked.`}{" "}
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
                {phase === "done" &&
                  (cachedAt ? (
                    <span className="flex items-center gap-1.5 text-[13px] text-text-3">
                      <Clock width={14} height={14} />
                      Checked {Math.max(1, Math.round((Date.now() - cachedAt) / 60_000))} min ago ·
                      <button
                        type="button"
                        onClick={() => run(target.ens ?? target.address, true)}
                        className="font-medium text-link hover:underline"
                      >
                        Check again
                      </button>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-[13px] text-text-3">
                      <Clock width={14} height={14} /> Live data, just now
                    </span>
                  ))}
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
                Some apps (Starknet, LayerZero, Synapse…) can&apos;t be checked automatically yet. If you used
                one, follow its guide below.
              </p>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
