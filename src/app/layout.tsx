import type { Metadata, Viewport } from "next";
import { SITE } from "@/config/site";
import "./globals.css";

export const metadata: Metadata = {
  title: SITE.title,
  description: SITE.description,
  icons: { icon: "/icon.svg" },
  openGraph: { title: SITE.title, description: SITE.description, type: "website" },
  twitter: { card: "summary", title: SITE.title, description: SITE.description },
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
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
