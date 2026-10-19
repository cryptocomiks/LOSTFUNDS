import type { Metadata, Viewport } from "next";
import { SITE } from "@/config/site";
import { SiteAnalytics } from "@/components/SiteAnalytics";
import { LANG_SCRIPT } from "@/lib/i18n";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: SITE.title,
  description: SITE.description,
  alternates: { canonical: "/" },
  keywords: ["unclaimed airdrop", "lost crypto", "stuck bridge withdrawal", "unclaimed crypto", "airdrop checker", "crypto oubliée", "airdrop non réclamé"],
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "48x48" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/manifest.webmanifest",
  appleWebApp: { title: SITE.name, statusBarStyle: "black-translucent" },
  openGraph: {
    title: SITE.title,
    description: SITE.description,
    type: "website",
    url: SITE.url,
    siteName: SITE.name,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: `${SITE.name} — Is money still waiting for you?` }],
  },
  twitter: { card: "summary_large_image", title: SITE.title, description: SITE.description, images: ["/og.png"] },
};

const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: SITE.name,
  url: SITE.url,
  description: SITE.description,
  applicationCategory: "FinanceApplication",
  operatingSystem: "Any",
  inLanguage: ["en", "fr"],
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfd" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The inline script sets lang / data-lang before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: LANG_SCRIPT }} />
        {/* What the site is, for search engines. */}
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }} />
      </head>
      <body className="min-h-dvh">
        {children}
        <SiteAnalytics />
      </body>
    </html>
  );
}
