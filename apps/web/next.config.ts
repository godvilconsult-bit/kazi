import path from "node:path";
import type { NextConfig } from "next";

/**
 * next-intl's request config, wired by hand instead of `next-intl/plugin`: the plugin loads
 * @swc/core, whose native binary caches itself under %LOCALAPPDATA% (this machine keeps everything
 * off C:). The plugin does nothing else for an app without i18n routing.
 */
const I18N_REQUEST = "./src/i18n/request.ts";

const apiOrigin = (() => {
  try {
    return new URL(process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:4000").origin;
  } catch {
    return "http://localhost:4000";
  }
})();

/**
 * Security headers. Agent output is rendered as sanitized markdown (CLAUDE.md rule 7); the CSP is a
 * second line of defence. Wallet extensions inject their own providers and are unaffected.
 */
const csp = [
  "default-src 'self'",
  // Next.js needs inline scripts for hydration; no third-party script origins.
  `script-src 'self' 'unsafe-inline'${process.env["NODE_ENV"] === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // API, chain RPCs and WalletConnect relays.
  // Local dev and e2e: anvil on any port, Next's HMR websocket.
  `connect-src 'self' ${apiOrigin} https: wss:${process.env["NODE_ENV"] === "development" ? " http://127.0.0.1:* http://localhost:* ws://localhost:*" : ""}`,
  "frame-src 'self' https://verify.walletconnect.com https://verify.walletconnect.org",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const config: NextConfig = {
  reactStrictMode: true,
  // A second dev server (the browser e2e stack) needs its own build directory.
  distDir: process.env["NEXT_DIST_DIR"] ?? ".next",
  poweredByHeader: false,
  transpilePackages: ["@kazi/shared", "@kazi/config"],
  typedRoutes: false,
  turbopack: { resolveAlias: { "next-intl/config": I18N_REQUEST } },
  webpack(cfg: { resolve: { alias: Record<string, string | false> } }) {
    cfg.resolve.alias["next-intl/config"] = path.resolve(process.cwd(), I18N_REQUEST);
    // wagmi/connectors re-exports the Base Account connector, whose SDK (→ @coinbase/cdp-sdk → x402
    // clients that aren't installed) is only imported when someone connects with it. Kazi doesn't
    // offer that connector, so its SDK resolves to an empty module.
    cfg.resolve.alias["@base-org/account"] = false;
    return cfg;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;
