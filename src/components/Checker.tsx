"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import type { Target, WalletKind } from "@/lib/checker";
import { T, useLang, type Lang } from "@/lib/i18n";
import { readCache, writeCache } from "@/lib/resultCache";
import { NETWORK_COLORS } from "@/lib/brand";
import { formatAmount, formatDate, formatUsd, shortAddress } from "@/lib/format";
import { GROUPS, type Group } from "@/lib/groups";
import { MAX_WALLETS, splitInputs } from "@/lib/inputs";
import { sourceMetaById as sourceById, sourcesMetaFor as sourcesFor, type SourceMeta } from "@/lib/sourceMeta";
import type { Finding, NetworkResult, WithdrawalStatus } from "@/lib/types";
import { UNCLAIMED } from "@/lib/unclaimed";
import { CountUp } from "./CountUp";
import { bridgeFr, SOURCE_FR, sourceName } from "@/lib/sourceFr";
import { ShareResult } from "./ShareResult";
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

/** One address of a run. Several can be given at once: they are checked one after the other. */
interface Wallet {
  target: Target;
  results: Record<string, NetworkResult>;
  /** When the shown results come (partly) from this browser's recent cache. */
  cachedAt: number | null;
  /** Start of this wallet's check: the cache entry's age (so it expires 10 min after the check, not later). */
  startedAt: number;
  state: "queued" | "checking" | "done";
}

const NO_RESULTS: Record<string, NetworkResult> = {};
const sameWallet = (a: Target, b: Target) => a.kind === b.kind && a.address === b.address;
const TOO_MANY = `You can check up to ${MAX_WALLETS} addresses at a time.`;

/** What one wallet's results add up to. */
function summarize(results: Record<string, NetworkResult>) {
  const list = Object.values(results);
  const stuck = list.flatMap((r) => r.findings).filter((f) => f.status !== "recent");
  return {
    stuck: stuck.length,
    usd: stuck.reduce((s, f) => s + (f.asset.usd ?? 0), 0),
    errors: list.filter((r) => r.state === "error").length,
  };
}

/**
 * The checks themselves (viem and every protocol's code) are a separate download: the page shows up
 * without them, and they load in the background right after, so "Check" is still instant.
 */
let enginePromise: Promise<typeof import("@/lib/checker")> | null = null;
const engine = () => {
  enginePromise ??= import("@/lib/checker").catch((e) => {
    enginePromise = null; // a failed download (bad connection) is retried on the next click
    throw e;
  });
  return enginePromise;
};

const STATUS: Record<WithdrawalStatus, { label: [string, string]; tone: string; group: [string, string]; order: number }> = {
  ready: { label: ["Ready to claim", "À réclamer"], tone: "bg-green-soft text-green", group: ["Ready to claim", "Prêt à réclamer"], order: 0 },
  prove: { label: ["Needs prove", "Preuve à faire"], tone: "bg-orange-soft text-orange", group: ["Needs a prove step", "Étape de preuve à faire"], order: 1 },
  manual: { label: ["Check manually", "À vérifier"], tone: "bg-orange-soft text-orange", group: ["Needs a manual step", "Étape manuelle"], order: 2 },
  waiting: { label: ["Waiting", "En attente"], tone: "bg-purple-soft text-purple", group: ["In the waiting period", "Période d'attente"], order: 3 },
  recent: { label: ["In progress", "En cours"], tone: "bg-fill-strong text-text-2", group: ["Started recently", "Commencé récemment"], order: 4 },
};
const pick = (pair: [string, string], lang: Lang) => (lang === "fr" ? pair[1] : pair[0]);

const STATUS_HELP: Record<WithdrawalStatus, (f: Finding, lang: Lang) => string> = {
  ready: (_, l) => (l === "fr" ? "Vous pouvez le réclamer maintenant, depuis votre wallet, sur l'app officielle." : "You can claim it now, from your own wallet, through the official app."),
  prove: (_, l) => (l === "fr" ? "Prouvez-le sur Ethereum, attendez environ 7 jours, puis finalisez." : "Prove it on Ethereum, wait about 7 days, then finalize."),
  manual: (f, l) => f.note ?? (l === "fr" ? "Celui-ci demande une étape manuelle. Suivez le guide." : "This one needs a manual step. Follow the guide."),
  waiting: (f, l) =>
    f.readyAt
      ? l === "fr" ? `Réclamable à partir du ${formatDate(f.readyAt, l)}.` : `Claimable from ${formatDate(f.readyAt)}.`
      : l === "fr" ? "Encore dans la période d'attente du bridge." : "Still inside the bridge's waiting period.",
  recent: (_, l) => (l === "fr" ? "Commencé récemment. C'est sans doute encore en cours, pas oublié." : "Started recently. It's probably still in progress, not forgotten."),
};

const GROUPS_FR: Record<Group, string> = {
  l2: "L2 → Ethereum",
  solana: "Bridges cross-chain",
  airdrops: "Airdrops non réclamés",
  rewards: "Récompenses et retraits non réclamés",
  legacy: "Anciens contrats et migrations",
  reclaim: "SOL récupérable",
};

/** What each group looks for, in plain words (shown when the group is open). */
const GROUP_HELP: Record<Group, [string, string]> = {
  l2: [
    "Money sent from a “layer 2” network (Base, Arbitrum, Starknet…) back to Ethereum. These withdrawals take two or three steps, and the last one, on Ethereum, is easy to forget. Networks that shut down are here too.",
    "De l'argent renvoyé d'un réseau « layer 2 » (Base, Arbitrum, Starknet…) vers Ethereum. Ces retraits se font en deux ou trois étapes, et la dernière, sur Ethereum, s'oublie facilement. Les réseaux qui ont fermé sont ici aussi.",
  ],
  solana: [
    "Transfers between two blockchains that left one side but were never received, or never refunded, on the other.",
    "Des transferts entre deux blockchains partis d'un côté mais jamais reçus, ou jamais remboursés, de l'autre.",
  ],
  airdrops: [
    "Free tokens a project set aside for its early users. They only become yours once you claim them, and some never expire.",
    "Des tokens gratuits qu'un projet a mis de côté pour ses premiers utilisateurs. Ils ne sont à vous qu'une fois réclamés, et certains n'expirent jamais.",
  ],
  rewards: [
    "Rewards, fees and withdrawals that an app holds for you until you come and take them: staking, lending, liquidity pools, vesting, locks that have expired.",
    "Des récompenses, frais et retraits qu'une app garde pour vous jusqu'à ce que vous veniez les chercher : staking, prêt, pools de liquidité, vesting, verrous expirés.",
  ],
  legacy: [
    "Deposits left in apps from 2016 to 2021, old tokens that are only worth something once swapped for their new version, and Safes you may have forgotten.",
    "Des dépôts restés dans des apps de 2016 à 2021, de vieux tokens qui ne valent quelque chose qu'une fois échangés contre leur nouvelle version, et des Safes que vous avez peut-être oubliés.",
  ],
  reclaim: [
    "SOL locked as a deposit in Solana accounts you no longer use, and fees owed to you. Closing the accounts gives the SOL back.",
    "Du SOL bloqué en caution dans des comptes Solana que vous n'utilisez plus, et des frais qui vous sont dus. Fermer les comptes vous rend ce SOL.",
  ],
};

/** The address errors from resolveInput, in French. */
function inputErrorFr(msg: string): string {
  if (msg.startsWith("Paste a wallet")) return "Collez une adresse de wallet ou un nom ENS.";
  if (msg.startsWith("That ENS name")) return "Ce nom ENS n'est pas valide.";
  if (msg.endsWith("doesn't resolve to an address.")) return `${msg.replace(" doesn't resolve to an address.", "")} ne correspond à aucune adresse.`;
  if (msg.startsWith("That's a transaction hash")) return "C'est un hash de transaction, pas une adresse de wallet.";
  if (msg.startsWith("That doesn't look")) return "Ça ne ressemble pas à une adresse de wallet.";
  if (msg === TOO_MANY) return `Vous pouvez vérifier jusqu'à ${MAX_WALLETS} adresses à la fois.`;
  return msg;
}

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

function FindingRow({ f, index, lang }: { f: Finding; index: number; lang: Lang }) {
  const s = STATUS[f.status];
  const fr = lang === "fr";
  // Some findings (airdrops) come from a source listed under another id: never assume it exists.
  const source = sourceById(f.networkId);
  // French texts when the check provides them; the English ones otherwise.
  const t = (fr && f.fr) || {};
  const claimAt = t.claimAt ?? f.claimAt ?? (source && (fr ? (SOURCE_FR[source.id]?.bridgeUrl ?? bridgeFr(source.bridgeUrl)) : source.bridgeUrl));
  const dateLabel = t.dateLabel ?? f.dateLabel;
  // Reclaimable SOL sits in accounts, not in a transfer: no date, and the link opens the account.
  const inAccount = source?.group === "reclaim";
  return (
    <li className="animate-fade-up px-5 py-5 sm:px-6" style={{ animationDelay: `${index * 50}ms` }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] text-text-2">
          <NetDot id={f.networkId} />
          <span className="font-medium text-text">{t.label ?? (fr && f.networkName === source?.name ? sourceName(source, lang) : f.networkName)}</span>
          {f.timestamp > 0 && !inAccount && (
            <>
              <span aria-hidden>·</span>
              <span>
                {dateLabel ?? (fr ? (f.networkId === "airdrops" ? "Airdroppé le" : "Envoyé le") : f.networkId === "airdrops" ? "Airdropped" : "Sent")}{" "}
                {formatDate(f.timestamp, lang)}
              </span>
            </>
          )}
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${s.tone}`}>{pick(s.label, lang)}</span>
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[28px] leading-tight font-semibold tracking-tight tabular-nums">
          {formatAmount(f.asset.amount, f.asset.decimals, lang)} <span className="text-text-2">{f.asset.symbol}</span>
        </span>
        {f.asset.usd !== undefined && (
          <span className="text-[17px] text-text-2 tabular-nums">≈ {formatUsd(f.asset.usd, lang)}</span>
        )}
      </div>

      <p className="mt-1.5 text-[15px] leading-relaxed break-words text-text-2">{t.note ?? f.note ?? STATUS_HELP[f.status](f, lang)}</p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => openGuide(f.guideId)}
          className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[14px] font-medium text-white transition hover:bg-accent-hover active:scale-[0.97]"
        >
          {fr ? "Comment réclamer" : "How to claim"} <ArrowRight width={15} height={15} />
        </button>
        <a
          href={f.txUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-full px-3 py-2 text-[14px] text-link hover:underline"
        >
          {t.linkLabel
            ? t.linkLabel
            : f.linkLabel && !fr
              ? f.linkLabel
              : inAccount
              ? fr ? "Voir sur Solscan" : "View on Solscan"
              : /\/(address|account)\//.test(f.txUrl)
                ? fr ? "Voir le contrat" : "View contract"
                : f.txUrl.includes("/tx/")
                  ? fr ? "Voir la transaction" : "View transaction"
                  : fr ? "Voir sur l'explorateur" : "View on explorer"} <ArrowUpRight width={14} height={14} />
        </a>
      </div>

      {claimAt && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-text-3">
          {fr ? "Où réclamer :" : "Where to claim:"}
          <code className="rounded-md bg-fill px-1.5 py-0.5 font-mono text-[12px] [overflow-wrap:anywhere] text-text-2">{claimAt}</code>
          <span className="hidden sm:inline">{fr ? "(tapez-le vous-même)" : "(type it yourself)"}</span>
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
  const lang = useLang();
  const sources = sourcesFor(kind);
  return (
    <div className="space-y-3">
      {(Object.keys(GROUPS) as Group[])
        .filter((g) => sources.some((s) => s.group === g))
        .map((g) => (
          <GroupBlock key={g} group={g} sources={sources.filter((n) => n.group === g)} results={results} onRetry={onRetry} lang={lang} />
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
  lang,
}: {
  group: Group;
  sources: SourceMeta[];
  results: Record<string, NetworkResult>;
  onRetry: (id: string) => void;
  lang: Lang;
}) {
  const fr = lang === "fr";
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
          <span className="truncate text-[15px] font-medium">{fr ? GROUPS_FR[group] : GROUPS[group]}</span>
          <span className="shrink-0 text-[13px] text-text-3 tabular-nums">
            {done < sources.length ? `${done}/${sources.length}` : fr ? `${sources.length} vérifiés` : `${sources.length} checked`}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {found > 0 && (
            <span className="rounded-full bg-orange-soft px-2 py-0.5 text-[12px] font-semibold text-orange tabular-nums">
              {found} {fr ? (found > 1 ? "trouvés" : "trouvé") : "found"}
            </span>
          )}
          {failed > 0 && (
            <span className="rounded-full bg-red-soft px-2 py-0.5 text-[12px] font-semibold text-red tabular-nums">
              {failed} {fr ? (failed > 1 ? "échecs" : "échec") : "failed"}
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
      {open && <p className="border-t border-line px-4 pt-3 text-[13px] leading-relaxed text-text-2 sm:px-5">{pick(GROUP_HELP[group], lang)}</p>}
      {open && (
        <ul className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 md:grid-cols-4">
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
                  <span className="truncate">{sourceName(n, lang)}</span>
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
                    <Refresh width={13} height={13} /> {fr ? "Réessayer" : "Retry"}
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
  const lang = useLang();
  const fr = lang === "fr";
  const [input, setInput] = useState("");
  /** Clipboard reading is only offered where the browser supports it (decided after mount). */
  const [canPaste, setCanPaste] = useState(false);
  useEffect(() => setCanPaste(typeof navigator !== "undefined" && !!navigator.clipboard?.readText), []);
  // Fetch the checks as soon as the page is idle, so they're ready before the first click.
  useEffect(() => {
    const start = () => engine().catch(() => {});
    if ("requestIdleCallback" in window) {
      const id = requestIdleCallback(start, { timeout: 2500 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(start, 1200);
    return () => clearTimeout(id);
  }, []);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorIsInput, setErrorIsInput] = useState(false);
  /** Which entry the error is about, when several addresses were given. */
  const [errorEntry, setErrorEntry] = useState<string | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  /** The wallet whose details are shown. */
  const [active, setActive] = useState(0);
  /** The details follow the wallet being checked, until the visitor picks one. */
  const followRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const activeIndex = Math.min(active, wallets.length - 1);
  const wallet = wallets[activeIndex] as Wallet | undefined;
  const target = wallet?.target ?? null;
  const results = wallet?.results ?? NO_RESULTS;
  const cachedAt = wallet?.cachedAt ?? null;

  const patch = useCallback(
    (t: Target, fn: (w: Wallet) => Wallet) => setWallets((prev) => prev.map((w) => (sameWallet(w.target, t) ? fn(w) : w))),
    [],
  );

  /** Runs every check for one wallet. Returns its results once they are all in. */
  const checkWallet = useCallback(
    async (t: Target, fresh: boolean, signal: AbortSignal, runChecks: typeof import("@/lib/checker").runChecks) => {
      // Checks this browser completed a few minutes ago are shown as they were; only the rest run.
      const cached = fresh ? null : readCache(t.kind, t.address);
      const known = new Set(sourcesFor(t.kind).map((s) => s.id));
      const reused = (cached?.results ?? []).filter((r) => known.has(r.networkId));
      const local: Record<string, NetworkResult> = Object.fromEntries(reused.map((r) => [r.networkId, r]));
      patch(t, (w) => ({ ...w, state: "checking", startedAt: Date.now(), cachedAt: reused.length ? cached!.at : null, results: { ...local } }));
      const todo = [...known].filter((id) => !(id in local));

      const failed: string[] = [];
      const update = (r: NetworkResult) => {
        local[r.networkId] = r;
        patch(t, (w) => ({ ...w, results: { ...w.results, [r.networkId]: r } }));
      };
      if (todo.length)
        await runChecks(
          t,
          (r) => {
            if (r.state === "error") failed.push(r.networkId);
            update(r);
          },
          signal,
          todo,
        );
      // One automatic second attempt for checks whose data sources were busy. The wait is longer
      // and randomized so that many visitors on one network don't all retry at the same instant.
      if (failed.length && !signal.aborted) {
        await new Promise((r) => setTimeout(r, 4000 + Math.random() * 3000));
        if (!signal.aborted) await runChecks(t, update, signal, failed);
      }
      if (!signal.aborted) patch(t, (w) => ({ ...w, state: "done" }));
      return local;
    },
    [patch],
  );

  const run = useCallback(
    async (raw: string, fresh = false) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setError(null);
      setErrorEntry(null);
      setWallets([]);
      setActive(0);
      followRef.current = true;
      setPhase("resolving");
      try {
        const { resolveInput, runChecks, InputError } = await engine();
        const entries = splitInputs(raw);
        if (entries.length > MAX_WALLETS) throw new InputError(TOO_MANY);
        const resolved = await Promise.all(
          (entries.length ? entries : [""]).map((entry) =>
            resolveInput(entry).catch((e) => {
              throw Object.assign(e as Error, { entry: entries.length > 1 ? entry : undefined });
            }),
          ),
        );
        if (ctrl.signal.aborted) return;
        // The same wallet given twice (an address and its ENS name) is checked once.
        const targets = resolved.filter((t, i) => resolved.findIndex((x) => sameWallet(x, t)) === i);
        setWallets(targets.map((t) => ({ target: t, results: {}, cachedAt: null, startedAt: 0, state: "queued" })));
        setPhase("checking");
        const url = new URL(location.href);
        url.searchParams.set("address", targets.map((t) => t.ens ?? t.address).join(","));
        url.hash = "";
        history.replaceState(null, "", url);
        requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));

        let best = 0;
        let bestUsd = 0;
        for (let i = 0; i < targets.length; i++) {
          if (ctrl.signal.aborted) return;
          if (followRef.current) setActive(i);
          const { usd } = summarize(await checkWallet(targets[i], fresh, ctrl.signal, runChecks));
          if (usd > bestUsd) [best, bestUsd] = [i, usd];
        }
        if (ctrl.signal.aborted) return;
        // Several wallets: end on the one with the most to claim, unless the visitor chose one.
        if (followRef.current && targets.length > 1) setActive(best);
        setPhase("done");
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setPhase("idle");
        const InputError = await engine().then((m) => m.InputError, () => null);
        const isInput = !!InputError && e instanceof InputError;
        setError(isInput ? (e as Error).message : "Couldn't resolve that name. Check your connection and try again.");
        setErrorIsInput(isInput);
        setErrorEntry((e as { entry?: string }).entry ?? null);
      }
    },
    [checkWallet],
  );

  /** Runs one wallet's checks again, live (the others keep their results). */
  const recheck = useCallback(
    async (t: Target) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setPhase("checking");
      try {
        const { runChecks } = await engine();
        await checkWallet(t, true, ctrl.signal, runChecks);
      } finally {
        if (!ctrl.signal.aborted) setPhase("done");
      }
    },
    [checkWallet],
  );

  // Keep this browser's short-lived cache up to date as checks complete (including manual retries),
  // so a reload or a reopened link mid-way doesn't start over.
  const savedRef = useRef(new Map<string, Record<string, NetworkResult>>());
  useEffect(() => {
    for (const w of wallets) {
      const key = `${w.target.kind}:${w.target.address}`;
      if (w.state === "queued" || savedRef.current.get(key) === w.results) continue;
      savedRef.current.set(key, w.results);
      writeCache(w.target.kind, w.target.address, Object.values(w.results), w.cachedAt ?? w.startedAt);
    }
  }, [wallets]);

  const retry = useCallback(
    async (id: string) => {
      if (!target) return;
      const { checkSource, sourcesFor: engineSources } = await engine();
      const net = engineSources(target.kind).find((s) => s.id === id);
      if (!net) return;
      patch(target, (w) => ({ ...w, results: { ...w.results, [id]: { networkId: id, state: "running", findings: [], completed: 0 } } }));
      const r = await checkSource(net, target.address);
      patch(target, (w) => ({ ...w, results: { ...w.results, [id]: r } }));
    },
    [target, patch],
  );

  // Shareable links: ?address=0x… runs the check on load.
  useEffect(() => {
    const a = new URLSearchParams(location.search).get("address");
    if (a) {
      setInput(splitInputs(a).join(" "));
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
  /** The wallet on screen is still being checked (in a run of several, others may be). */
  const walletBusy = busy && wallet?.state !== "done";
  const several = wallets.length > 1;
  const summaries = useMemo(() => wallets.map((w) => summarize(w.results)), [wallets]);
  const grand = {
    usd: summaries.reduce((s, x) => s + x.usd, 0),
    stuck: summaries.reduce((s, x) => s + x.stuck, 0),
    errors: summaries.reduce((s, x) => s + x.errors, 0),
    done: wallets.filter((w) => w.state === "done").length,
    withFinds: summaries.filter((x) => x.stuck > 0).length,
  };

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
            <T en="Unclaimed crypto finder" fr="Détecteur de crypto oubliée" />
          </p>
          <h1
            className="animate-fade-up mx-auto mt-4 max-w-[820px] text-[44px] leading-[1.04] font-semibold tracking-[-0.035em] sm:text-[72px] md:text-[84px]"
            style={{ animationDelay: "60ms" }}
          >
            <T
              en={
                <>
                  Is money still <br className="hidden sm:block" />
                  <span className="text-gradient">waiting for you?</span>
                </>
              }
              fr={
                <>
                  De l&apos;argent vous <br className="hidden sm:block" />
                  <span className="text-gradient">attend encore ?</span>
                </>
              }
            />
          </h1>
          <p
            className="animate-fade-up mx-auto mt-6 max-w-[620px] text-[19px] leading-relaxed text-text-2 sm:text-[21px]"
            style={{ animationDelay: "120ms" }}
          >
            <T
              en="Bridge withdrawals you never finished, airdrops you never claimed, rewards, deposits and old tokens you forgot. Paste an address: we check them all, live on-chain."
              fr="Des retraits de bridge jamais terminés, des airdrops jamais réclamés, des récompenses, des dépôts et de vieux tokens oubliés. Collez une adresse : on vérifie tout, en direct on-chain."
            />
          </p>

          {/* What is out there, measured on-chain: the details are in the section below. Not on phones, where the address field must stay on the first screen. */}
          <a
            href="#unclaimed"
            className="animate-fade-up group mx-auto mt-7 hidden flex-wrap sm:inline-flex items-baseline justify-center gap-x-2 gap-y-1 rounded-2xl px-3 py-1 text-[15px] text-text-2 transition hover:text-text"
            style={{ animationDelay: "150ms" }}
          >
            <span className="text-gradient text-[22px] font-semibold tracking-tight sm:text-[26px]">
              <CountUp value={UNCLAIMED.totalUsd} kind="usd" duration={2200} />
            </span>
            <span>
              <T en="unclaimed, measured on-chain" fr="non réclamés, mesurés on-chain" />
              <span aria-hidden className="ml-1 inline-block transition-transform group-hover:translate-y-0.5">
                ↓
              </span>
            </span>
          </a>

          <div className="animate-fade-up mx-auto mt-8 max-w-[680px]" style={{ animationDelay: "180ms" }}>
            <p className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-surface/70 px-4 py-2 text-[13px] text-text-2 backdrop-blur">
              <Shield width={15} height={15} className="shrink-0 text-green" />
              <T
                en="Runs in your browser. We never log or store the addresses you check."
                fr="Tout se passe dans votre navigateur. Nous n'enregistrons jamais les adresses vérifiées."
              />
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
                id="address"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={(e) => {
                  // A text field drops line breaks: a pasted list of addresses would be glued into one.
                  const text = e.clipboardData.getData("text");
                  if (!/[\r\n]/.test(text.trim())) return;
                  e.preventDefault();
                  const el = e.currentTarget;
                  const start = el.selectionStart ?? el.value.length;
                  const end = el.selectionEnd ?? el.value.length;
                  setInput(splitInputs(`${el.value.slice(0, start)} ${text} ${el.value.slice(end)}`).join(" "));
                }}
                placeholder={fr ? "Collez une adresse Ethereum ou Solana, ou un nom ENS" : "Paste an Ethereum or Solana address, or ENS name"}
                aria-label={fr ? "Adresse Ethereum ou Solana, ou nom ENS" : "Ethereum or Solana address, or ENS name"}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                className="min-w-0 flex-1 bg-transparent py-3 text-[17px] outline-none placeholder:text-text-3"
              />
              {canPaste && !input && !busy && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const text = splitInputs(await navigator.clipboard.readText()).join(" ");
                      if (text) {
                        setInput(text);
                        run(text);
                      }
                    } catch {
                      /* permission refused: the visitor can still paste by hand */
                    }
                  }}
                  className="shrink-0 rounded-full px-3 py-2 text-[14px] font-medium text-link transition hover:bg-fill"
                >
                  <T en="Paste" fr="Coller" />
                </button>
              )}
              <button
                type="submit"
                disabled={busy}
                className="flex h-12 shrink-0 items-center gap-2 rounded-full bg-accent px-6 text-[16px] font-medium text-white transition hover:bg-accent-hover active:scale-[0.97] disabled:opacity-70"
              >
                {busy ? <Spinner className="text-white" /> : null}
                {busy ? <T en="Checking" fr="Analyse" /> : <T en="Check" fr="Vérifier" />}
              </button>
            </form>

            {error ? (
              <p role="alert" className="mt-4 flex items-center justify-center gap-2 text-[14px] text-red">
                <Alert width={16} height={16} className="shrink-0" />
                <span className="min-w-0 break-words">
                  {errorEntry && <span className="font-mono">{errorEntry.length > 20 ? shortAddress(errorEntry) : errorEntry}{fr ? " : " : ": "}</span>}
                  {fr ? (errorIsInput ? inputErrorFr(error) : "Impossible de trouver ce nom. Vérifiez votre connexion et réessayez.") : error}
                </span>
              </p>
            ) : (
              <p className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[13px] text-text-3">
                <Lock width={14} height={14} className="shrink-0" />
                <T en="Read-only. No wallet connection, no signatures." fr="Lecture seule. Sans wallet, sans signature." />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setInput("vitalik.eth");
                    run("vitalik.eth");
                  }}
                  className="font-medium text-link hover:underline disabled:opacity-60"
                >
                  <T en="Try vitalik.eth" fr="Essayer vitalik.eth" />
                </button>
              </p>
            )}
            <p className="mt-2 text-[13px] text-text-3">
              <T
                en={`Several wallets? Paste up to ${MAX_WALLETS} addresses at once, separated by a space.`}
                fr={`Plusieurs wallets ? Collez jusqu'à ${MAX_WALLETS} adresses d'un coup, séparées par un espace.`}
              />
            </p>
          </div>
        </div>
      </section>

      {/* ───── Results ───── */}
      {target && phase !== "idle" && (
        <section ref={resultsRef} className="scroll-mt-16 bg-bg-alt" aria-live="polite">
          <div className="mx-auto max-w-[980px] px-4 py-14 sm:px-6 sm:py-20">
            {/* Several wallets: the total, and one chip per wallet to open its details */}
            {several && (
              <div className="animate-fade-up mb-6 overflow-hidden rounded-3xl border border-line bg-surface shadow-soft">
                <div className="p-6 sm:p-8">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-[14px] text-text-2">{fr ? `${wallets.length} adresses, tout additionné` : `${wallets.length} addresses, all together`}</p>
                    <p className="flex items-center gap-2 text-[13px] text-text-3 tabular-nums">
                      {busy && <Spinner className="text-accent" />}
                      {grand.done}/{wallets.length} {fr ? "adresses vérifiées" : "addresses checked"}
                    </p>
                  </div>
                  <div className="mt-6">
                    {grand.stuck > 0 ? (
                      <>
                        <p className="text-[15px] font-medium text-orange">
                          {fr
                            ? `${grand.stuck} chose${grand.stuck > 1 ? "s" : ""} à réclamer sur ${grand.withFinds} adresse${grand.withFinds > 1 ? "s" : ""}`
                            : `${grand.stuck} thing${grand.stuck > 1 ? "s" : ""} to claim on ${grand.withFinds} address${grand.withFinds > 1 ? "es" : ""}`}
                        </p>
                        <p className="mt-1 text-[44px] leading-none font-semibold tracking-[-0.03em] tabular-nums sm:text-[56px]">
                          {grand.usd > 0 ? formatUsd(grand.usd, lang) : fr ? `${grand.stuck} à réclamer` : `${grand.stuck} to claim`}
                        </p>
                      </>
                    ) : busy ? (
                      <p className="text-[28px] font-semibold tracking-tight sm:text-[34px]">{fr ? "Analyse en cours…" : "Checking…"}</p>
                    ) : grand.errors > 0 ? (
                      <p className="text-[28px] font-semibold tracking-tight sm:text-[34px]">{fr ? "Vérification incomplète" : "Check incomplete"}</p>
                    ) : (
                      <p className="text-[28px] font-semibold tracking-tight sm:text-[34px]">
                        {fr ? `Rien d'oublié sur ces ${wallets.length} adresses` : `Nothing left behind on these ${wallets.length} addresses`}
                      </p>
                    )}
                  </div>
                  <ul className="mt-6 flex flex-wrap gap-2">
                    {wallets.map((w, i) => {
                      const sum = summaries[i];
                      const name = w.target.ens ?? shortAddress(w.target.address);
                      return (
                        <li key={`${w.target.kind}:${w.target.address}`}>
                          <button
                            type="button"
                            aria-pressed={i === activeIndex}
                            onClick={() => {
                              followRef.current = false;
                              setActive(i);
                            }}
                            className={`flex items-center gap-2 rounded-full border px-3.5 py-2 text-[14px] transition active:scale-[0.97] ${
                              i === activeIndex ? "border-accent bg-accent-soft text-text" : "border-line bg-surface text-text-2 hover:bg-fill"
                            }`}
                          >
                            <span className="font-mono">{name}</span>
                            {w.state === "queued" ? (
                              <Clock width={15} height={15} className="text-text-3" />
                            ) : w.state === "checking" ? (
                              <Spinner className="text-text-3" />
                            ) : sum.stuck > 0 ? (
                              <span className="rounded-full bg-orange-soft px-2 py-0.5 text-[12px] font-semibold text-orange tabular-nums">
                                {sum.usd > 0 ? formatUsd(sum.usd, lang) : sum.stuck}
                              </span>
                            ) : sum.errors > 0 ? (
                              <Alert width={16} height={16} className="text-orange" />
                            ) : (
                              <CheckCircle width={17} height={17} className="text-green" />
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-4 text-[13px] text-text-3">
                    {fr ? "Choisissez une adresse pour voir son détail juste en dessous." : "Pick an address to see its details right below."}
                  </p>
                  {phase === "done" && <ShareResult data={{ usd: grand.usd, count: grand.stuck }} lang={lang} />}
                </div>
                {busy && <div className="shimmer h-0.5 w-full" />}
              </div>
            )}

            {/* Summary */}
            <div key={`${target.kind}:${target.address}`} className="animate-fade-up overflow-hidden rounded-3xl border border-line bg-surface shadow-soft">
              <div className="p-6 sm:p-8">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-[14px] text-text-2">
                    <span className="font-mono">{target.ens ?? shortAddress(target.address)}</span>
                    {target.ens && <span className="font-mono text-text-3">{shortAddress(target.address)}</span>}
                  </div>
                  <div className="flex items-center gap-2 text-[13px] text-text-3 tabular-nums">
                    {walletBusy && <Spinner className="text-accent" />}
                    {finished}/{sourcesFor(target.kind).length} {fr ? "vérifications faites" : "checks done"}
                  </div>
                </div>

                {walletBusy && stuck.length === 0 ? (
                  <div className="mt-6">
                    <p className="text-[28px] font-semibold tracking-tight sm:text-[34px]">
                      {wallet?.state === "queued" ? (fr ? "En attente de son tour…" : "Waiting for its turn…") : fr ? "Analyse en cours…" : "Checking…"}
                    </p>
                    <p className="mt-2 text-[15px] text-text-2">
                      {fr
                        ? "On cherche les retraits inachevés, les transferts bloqués, les airdrops, les récompenses et les vieux tokens, puis on demande à chaque blockchain s'ils vous attendent encore."
                        : "Looking for unfinished withdrawals, stuck transfers, airdrops, rewards and old tokens, then asking each chain whether they're still waiting for you."}
                    </p>
                  </div>
                ) : stuck.length > 0 ? (
                  <div className="mt-6">
                    <p className="text-[15px] font-medium text-orange">
                      {fr
                        ? `${stuck.length} chose${stuck.length > 1 ? "s" : ""} à réclamer`
                        : `${stuck.length} thing${stuck.length > 1 ? "s" : ""} to claim`}
                    </p>
                    <p className="mt-1 text-[44px] leading-none font-semibold tracking-[-0.03em] tabular-nums sm:text-[56px]">
                      {totalUsd > 0 ? formatUsd(totalUsd, lang) : fr ? `${stuck.length} à réclamer` : `${stuck.length} to claim`}
                    </p>
                    <p className="mt-3 max-w-[560px] text-[15px] text-text-2">
                      {fr
                        ? "Une réclamation envoie toujours 100 % des fonds sur votre propre adresse, via l'app officielle. Personne ne peut le faire à votre place, et personne n'a besoin de votre phrase secrète. Ouvrez « Comment réclamer » sur chaque ligne pour les étapes. Chaque réclamation est une transaction ordinaire : vous ne payez que les frais de réseau, quelques centimes sur la plupart des réseaux et davantage sur Ethereum."
                        : 'Claiming always sends 100% of the funds to your own address, through the official app. Nobody else can do it for you, and nobody needs your seed phrase. Open "How to claim" on each line for the steps. Each claim is an ordinary transaction: you only pay the network fee, a few cents on most networks and more on Ethereum.'}
                    </p>
                    {!several && finished === sourcesFor(target.kind).length && <ShareResult data={{ usd: totalUsd, count: stuck.length }} lang={lang} />}
                  </div>
                ) : errors > 0 ? (
                  <div className="mt-6 flex items-start gap-4">
                    <Alert width={40} height={40} className="mt-1 shrink-0 text-orange" />
                    <div>
                      <p className="text-[28px] font-semibold tracking-tight sm:text-[34px]">{fr ? "Vérification incomplète" : "Check incomplete"}</p>
                      <p className="mt-2 text-[15px] text-text-2">
                        {fr
                          ? `${errors} vérification${errors > 1 ? "s n'ont" : " n'a"} pas pu tourner pour l'instant, on ne peut donc pas encore conclure. Rien n'a été trouvé sur les ${finished - errors} autres. Réessayez celles qui manquent ci-dessous.`
                          : `${errors} check${errors > 1 ? "s" : ""} couldn't run right now, so we can't say yet. Nothing was found on the ${finished - errors} others. Retry the missing ones below.`}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="mt-6 flex items-start gap-4">
                    <CheckCircle width={40} height={40} className="mt-1 shrink-0 text-green" />
                    <div>
                      <p className="text-[28px] font-semibold tracking-tight sm:text-[34px]">{fr ? "Rien d'oublié" : "Nothing left behind"}</p>
                      <p className="mt-2 text-[15px] text-text-2">
                        {fr
                          ? completed > 0
                            ? `${completed > 1 ? `Les ${completed} retraits trouvés ont tous été terminés.` : "Le retrait trouvé a bien été terminé."}`
                            : `Rien n'attend cette adresse dans les ${finished} endroits vérifiés.`
                          : completed > 0
                            ? `All ${completed} withdrawal${completed > 1 ? "s" : ""} we found were completed.`
                            : `Nothing is waiting for this address in the ${finished} places we checked.`}{" "}
                      </p>
                      {!several && phase === "done" && <ShareResult data={{ usd: 0, count: 0 }} lang={lang} />}
                    </div>
                  </div>
                )}
              </div>
              {walletBusy && <div className="shimmer h-0.5 w-full" />}
            </div>

            {/* Findings */}
            {groups.map(([status, items]) => (
              <div key={status} className="mt-10">
                <h3 className="mb-3 px-1 text-[13px] font-semibold tracking-wide text-text-3 uppercase">
                  {pick(STATUS[status].group, lang)}
                </h3>
                <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-3xl border border-line bg-surface shadow-soft">
                  {items.map((f, i) => (
                    <FindingRow key={f.id} f={f} index={i} lang={lang} />
                  ))}
                </ul>
              </div>
            ))}

            {/* Networks */}
            <div className="mt-10">
              <div className="mb-3 flex items-center justify-between px-1">
                <h3 className="text-[13px] font-semibold tracking-wide text-text-3 uppercase">{fr ? "Ce qu'on a vérifié" : "What we checked"}</h3>
                {phase === "done" &&
                  (cachedAt ? (
                    <span className="flex items-center gap-1.5 text-[13px] text-text-3">
                      <Clock width={14} height={14} />
                      {fr ? "Vérifié il y a" : "Checked"} {Math.max(1, Math.round((Date.now() - cachedAt) / 60_000))} min{fr ? "" : " ago"} ·
                      <button
                        type="button"
                        onClick={() => recheck(target)}
                        className="font-medium text-link hover:underline"
                      >
                        {fr ? "Revérifier" : "Check again"}
                      </button>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-[13px] text-text-3">
                      <Clock width={14} height={14} /> {fr ? "Données en direct, à l'instant" : "Live data, just now"}
                    </span>
                  ))}
              </div>
              <NetworkGrid key={`${target.kind}:${target.address}`} results={results} onRetry={retry} kind={target.kind} />
              {Object.values(results).some((r) => r.state === "error") && (
                <details className="mt-3 rounded-2xl border border-line bg-surface px-4 py-3 text-[13px] text-text-2">
                  <summary className="cursor-pointer font-medium text-text">{fr ? "Pourquoi certaines vérifications ont échoué ?" : "Why did some checks fail?"}</summary>
                  <ul className="mt-2 space-y-1 font-mono text-[12px] break-all">
                    {Object.values(results)
                      .filter((r) => r.state === "error")
                      .map((r) => (
                        <li key={r.networkId}>
                          {sourceById(r.networkId) && sourceName(sourceById(r.networkId)!, lang)}: {r.error}
                        </li>
                      ))}
                  </ul>
                </details>
              )}
              <p className="mt-4 px-1 text-[13px] leading-relaxed text-text-3">
                {fr
                  ? "Certaines apps (LayerZero, Synapse, Sui…) ne peuvent pas encore être vérifiées automatiquement. Si vous en avez utilisé une, suivez son guide plus bas."
                  : "Some apps (LayerZero, Synapse, Sui…) can't be checked automatically yet. If you used one, follow its guide below."}
              </p>
            </div>

            {/* Most people have more than one wallet */}
            {phase === "done" && (
              <div className="mt-10 flex justify-center">
                <button
                  type="button"
                  onClick={() => {
                    setInput("");
                    scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
                    const field = document.getElementById("address");
                    const started = Date.now();
                    const focus = () => (scrollY < 4 || Date.now() - started > 2500 ? field?.focus({ preventScroll: true }) : requestAnimationFrame(focus));
                    requestAnimationFrame(focus);
                  }}
                  className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-5 py-2.5 text-[15px] font-medium text-text shadow-soft transition hover:-translate-y-0.5 hover:shadow-float active:scale-[0.97]"
                >
                  <Search width={16} height={16} className="text-text-3" />
                  {fr ? "Vérifier d'autres adresses" : "Check other addresses"}
                </button>
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
}
