"use client";

import { useState } from "react";
import { SITE } from "@/config/site";
import type { Lang } from "@/lib/i18n";

/** A result worth sharing, without the address: the total, or the number of finds. */
export interface ShareData {
  usd: number;
  count: number;
}

const money = (usd: number, lang: Lang) =>
  lang === "fr" ? `${Math.round(usd).toLocaleString("fr-FR")} $` : `$${Math.round(usd).toLocaleString("en-US")}`;

function message({ usd, count }: ShareData, lang: Lang): { headline: string; text: string } {
  if (count === 0)
    return lang === "fr"
      ? { headline: "J'ai vérifié mon wallet.", text: `J'ai vérifié si de la crypto m'attendait encore quelque part avec ${SITE.name}. Et vous ?` }
      : { headline: "I checked my wallet.", text: `I checked whether crypto was still waiting for me anywhere with ${SITE.name}. Have you?` };
  const what =
    usd >= 1
      ? money(usd, lang)
      : lang === "fr"
        ? `${count} chose${count > 1 ? "s" : ""}`
        : `${count} thing${count > 1 ? "s" : ""}`;
  return lang === "fr"
    ? { headline: `J'ai retrouvé ${what}`, text: `J'ai retrouvé ${what} de crypto oubliée avec ${SITE.name}. Vérifiez votre adresse, c'est gratuit :` }
    : { headline: `I found ${what}`, text: `I found ${what} of forgotten crypto with ${SITE.name}. Check your address, it's free:` };
}

/** Draws the 1200×630 share card. No address on it, ever. */
async function drawCard(d: ShareData, lang: Lang): Promise<Blob | null> {
  const W = 1200, H = 630;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  if (!g) return null;
  await document.fonts?.ready;
  const font = (w: number, s: number) => `${w} ${s}px -apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, "Segoe UI", Roboto, sans-serif`;
  g.fillStyle = "#05060b";
  g.fillRect(0, 0, W, H);
  for (const [col, x, y, r] of [["rgba(10,132,255,0.30)", 220, 120, 520], ["rgba(123,97,255,0.28)", 980, 140, 480], ["rgba(229,72,125,0.24)", 700, 640, 520]] as const) {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, col);
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
  }
  const brand = g.createLinearGradient(80, 0, 1120, 0);
  brand.addColorStop(0, "#0A84FF");
  brand.addColorStop(0.55, "#7B61FF");
  brand.addColorStop(1, "#E5487D");
  // logo tile + name
  const tile = g.createLinearGradient(80, 72, 144, 136);
  tile.addColorStop(0, "#0A84FF");
  tile.addColorStop(0.55, "#7B61FF");
  tile.addColorStop(1, "#E5487D");
  g.fillStyle = tile;
  g.beginPath();
  g.roundRect(80, 72, 64, 64, 18);
  g.fill();
  g.strokeStyle = "#fff";
  g.lineWidth = 5;
  g.lineCap = "round";
  g.save();
  g.translate(80, 72);
  g.scale(2, 2);
  g.lineWidth = 2.4;
  g.stroke(new Path2D("M10.5 18.5a6 6 0 1 0 1.2-6.9"));
  g.stroke(new Path2D("M10.5 8.5v4h4"));
  g.restore();
  g.fillStyle = "#f5f5f7";
  g.font = font(700, 40);
  g.fillText(SITE.name, 166, 117);

  const { headline } = message(d, lang);
  g.fillStyle = "#a1a1a6";
  g.font = font(600, 36);
  g.fillText(d.count ? (lang === "fr" ? "Crypto oubliée, retrouvée" : "Forgotten crypto, found") : (lang === "fr" ? "Vérification terminée" : "Check complete"), 80, 270);
  // headline, shrunk to fit
  let size = 104;
  g.font = font(800, size);
  while (g.measureText(headline).width > W - 160 && size > 50) g.font = font(800, (size -= 4));
  g.fillStyle = d.count ? brand : "#f5f5f7";
  g.fillText(headline, 76, 270 + size + 14);
  g.fillStyle = "#a1a1a6";
  g.font = font(500, 32);
  g.fillText(lang === "fr" ? "Gratuit · Lecture seule · Sans connexion de wallet" : "Free · Read-only · No wallet connection", 80, 520);
  g.fillStyle = "#f5f5f7";
  g.font = font(600, 36);
  g.fillText(SITE.url.replace(/^https?:\/\//, ""), 80, 572);
  return new Promise((r) => c.toBlob((b) => r(b), "image/png"));
}

export function ShareResult({ data, lang }: { data: ShareData; lang: Lang }) {
  const [note, setNote] = useState<string | null>(null);
  const { text } = message(data, lang);
  const url = SITE.url;
  const full = `${text} ${url}`;

  const share = async () => {
    setNote(null);
    try {
      const blob = await drawCard(data, lang);
      const file = blob && new File([blob], "lostfunds.png", { type: "image/png" });
      if (file && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text, url });
        return;
      }
      if (navigator.share) {
        await navigator.share({ text, url });
        return;
      }
      // Desktop fallback: save the image, copy the text.
      if (blob) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "lostfunds.png";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }
      await navigator.clipboard?.writeText(full).catch(() => {});
      setNote(lang === "fr" ? "Image téléchargée et texte copié." : "Image saved and text copied.");
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") setNote(lang === "fr" ? "Le partage n'a pas marché." : "Sharing didn't work.");
    }
  };

  const enc = encodeURIComponent;
  const link = "rounded-full px-3 py-2 text-[14px] text-link hover:underline";
  return (
    <div className="mt-5 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={share}
        className="inline-flex items-center gap-2 rounded-full bg-fill-strong px-4 py-2 text-[14px] font-medium text-text transition hover:bg-fill active:scale-[0.97]"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3v13M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
        </svg>
        {lang === "fr" ? "Partager mon résultat" : "Share my result"}
      </button>
      <a className={link} target="_blank" rel="noopener noreferrer" href={`https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}`}>
        X
      </a>
      <a className={link} target="_blank" rel="noopener noreferrer" href={`https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`}>
        Telegram
      </a>
      <a className={link} target="_blank" rel="noopener noreferrer" href={`https://wa.me/?text=${enc(full)}`}>
        WhatsApp
      </a>
      <span className="text-[12px] text-text-3">{lang === "fr" ? "Votre adresse n'est jamais partagée." : "Your address is never shared."}</span>
      {note && <span className="w-full px-1 text-[13px] text-text-2">{note}</span>}
    </div>
  );
}
