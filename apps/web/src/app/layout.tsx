import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Bricolage_Grotesque, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { headers } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { geoFromHeaders } from "@/lib/geo";
import { getPublicConfig } from "@/lib/server-api";
import { Providers } from "@/components/providers";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { Offline } from "@/components/offline";
import "./globals.css";

// Every page depends on live API config (chain, contracts, decimals); nothing is prerendered at build.
export const dynamic = "force-dynamic";

const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-bricolage", display: "swap" });
const sans = Instrument_Sans({ subsets: ["latin"], variable: "--font-instrument", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return { title: { default: t("title"), template: "%s · Kazi" }, description: t("description") };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3eee3" },
    { media: "(prefers-color-scheme: dark)", color: "#110e0b" },
  ],
};

/** Applied before paint so the page never flashes the wrong theme. */
const themeScript = `(function(){try{var t=localStorage.getItem("kazi-theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch(e){}})()`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, config, requestHeaders] = await Promise.all([getLocale(), getPublicConfig(), headers()]);
  const geo = geoFromHeaders(requestHeaders);
  return (
    <html lang={locale} suppressHydrationWarning className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh bg-bg font-sans text-ink antialiased">
        <NextIntlClientProvider>
          {config ? (
            <Providers config={config} geo={geo}>
              <div className="flex min-h-dvh flex-col">
                <Header />
                <main className="flex-1">{children}</main>
                <Footer />
              </div>
            </Providers>
          ) : (
            <Offline />
          )}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
