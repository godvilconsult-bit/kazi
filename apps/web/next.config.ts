import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

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
  `connect-src 'self' ${apiOrigin} https: wss:${process.env["NODE_ENV"] === "development" ? " http://127.0.0.1:8545 http://localhost:8545 ws://localhost:3000" : ""}`,
  "frame-src 'self' https://verify.walletconnect.com https://verify.walletconnect.org",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@kazi/shared", "@kazi/config"],
  typedRoutes: false,
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

export default withNextIntl(config);
