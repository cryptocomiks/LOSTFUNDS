"use client";

import { useEffect } from "react";
import { SITE } from "@/config/site";

interface TelegramWebApp {
  ready(): void;
  /** Telegram's signed launch data: proves to the bot which user opened the Mini App. */
  initData?: string;
  expand(): void;
  version?: string;
  isVersionAtLeast?(v: string): boolean;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
}

/** Telegram opens a Mini App with its launch data in the hash, and keeps it in sessionStorage across reloads. */
export function inTelegram(): boolean {
  try {
    return location.hash.includes("tgWebApp") || !!sessionStorage.getItem("__telegram__initParams");
  } catch {
    return false;
  }
}

function hex(color: string): string | null {
  const m = color.match(/\d+/g);
  if (!m || m.length < 3) return null;
  return `#${m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
}

const webApp = () => (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;

/** One line of the summary the bot writes in the chat. */
export interface ChatItem {
  /** "0.016 ETH" */
  what: string;
  /** "Maker SCD vaults" */
  where: string;
  usd?: number;
  /** Not claimable yet (waiting period). */
  later: boolean;
}

/**
 * Opened from the bot, a finished check is summed up in the chat by the bot: totals only, never the
 * address. Once per address and browser session, and never outside Telegram.
 */
export function sendSummaryToChat(key: string, items: ChatItem[], failed: number): void {
  const initData = webApp()?.initData;
  if (!SITE.telegramApi || !initData) return;
  try {
    const k = `tg-summary:${key}`;
    if (sessionStorage.getItem(k)) return;
    sessionStorage.setItem(k, "1");
  } catch {
    return;
  }
  fetch(`${SITE.telegramApi}/api/result`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ initData, items, failed }),
    keepalive: true,
    referrerPolicy: "no-referrer",
  }).catch(() => {});
}

/**
 * When the site is opened from the Telegram bot: tells Telegram the page is ready, takes the full
 * height and gives Telegram's bars the page's own background. Telegram's script is only fetched
 * inside Telegram; other visitors never contact telegram.org.
 */
export function TelegramMiniApp() {
  useEffect(() => {
    if (!inTelegram()) return;
    const s = document.createElement("script");
    s.src = "https://telegram.org/js/telegram-web-app.js";
    s.async = true;
    s.onload = () => {
      const app = webApp();
      if (!app) return;
      try {
        app.ready();
        app.expand();
        const bg = hex(getComputedStyle(document.body).backgroundColor);
        if (bg && app.isVersionAtLeast?.("6.1")) {
          app.setHeaderColor?.(bg);
          app.setBackgroundColor?.(bg);
        }
        if (bg && app.isVersionAtLeast?.("7.10")) app.setBottomBarColor?.(bg);
      } catch {
        // An old Telegram client: the page works without any of this.
      }
    };
    document.head.appendChild(s);
  }, []);
  return null;
}
