"use client";

import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

/**
 * Vercel Web Analytics (anonymous visit counts, no cookies) and Speed Insights.
 * Checked addresses travel in ?address=…: the query and hash are removed before anything is sent,
 * so no address ever reaches the analytics.
 */
function withoutQuery<T extends { url: string }>(event: T): T {
  try {
    const u = new URL(event.url);
    u.search = "";
    u.hash = "";
    return { ...event, url: u.toString() };
  } catch {
    return { ...event, url: "/" };
  }
}

export function SiteAnalytics() {
  return (
    <>
      <Analytics beforeSend={withoutQuery} />
      <SpeedInsights beforeSend={withoutQuery} />
    </>
  );
}
