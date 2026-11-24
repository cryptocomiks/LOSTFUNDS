"use client";

import { useEffect } from "react";

interface TelegramWebApp {
  ready(): void;
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
      const app = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
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
