import type { NextConfig } from "next";

// Deploy retrigger: production was stuck at PR #27; this nudge ships PR #28's
// /app/hub/:tool redirect.

const nextConfig: NextConfig = {
  // Allow a second `next dev` of THIS app (e.g. a parallel agent session) to
  // use its own build dir so two servers don't corrupt a shared `.next`.
  // Defaults to `.next` → production and the primary dev server are unaffected.
  // Start the secondary server with: NEXT_DIST_DIR=.next-dev3004 PORT=3004 …
  distDir: process.env.NEXT_DIST_DIR ?? ".next",

  // ── Client-side env WITHOUT the `NEXT_PUBLIC_` prefix ────────────────────
  //
  // THIS BLOCK IS LOAD-BEARING. Delete it and both features below go silently
  // dark — the code compiles, the UI renders, and the values are `undefined`
  // in the browser. That is the exact "dead control" failure mode PR #315 was
  // opened to remove, so it must not be reintroduced here by accident.
  //
  // WHY: Next.js only inlines `process.env.X` into the CLIENT bundle when `X`
  // starts with `NEXT_PUBLIC_`. Both consumers below are `"use client"`
  // modules, so a bare `process.env.NEXT_WALLETCONNECT_PROJECT_ID` read there
  // evaluates to `undefined` in the browser no matter what Vercel holds.
  //
  // The `env` key is the pre-`NEXT_PUBLIC_` mechanism and has no prefix rule:
  // whatever is listed here is inlined into the JS bundle at build time. That
  // lets the Vercel variable keep a name with no "PUBLIC" in it while the
  // client still receives the value.
  //
  // NEITHER VALUE IS A SECRET, and nothing here makes a secret public:
  //   - NEXT_WALLETCONNECT_PROJECT_ID — a public client id from cloud.reown.com.
  //     WalletConnect requires it in the browser to open a session; it is
  //     designed to ship in the bundle.
  //   - NEXT_PRIVY_LOGIN_METHODS — a comma-separated list like "email,google".
  //     Config, not a credential.
  // Do NOT extend this block with anything that must stay server-side; an
  // entry here is world-readable in the shipped JS.
  //
  // `?? ""` because Next rejects an `undefined` value in this map, and because
  // both readers already treat empty-string as "unset" (falsy gate in
  // Providers.tsx; `if (!raw) return ["email"]` in lib/privy/config.ts). So an
  // unset variable still degrades to today's behaviour rather than throwing.
  env: {
    NEXT_WALLETCONNECT_PROJECT_ID: process.env.NEXT_WALLETCONNECT_PROJECT_ID ?? "",
    NEXT_PRIVY_LOGIN_METHODS: process.env.NEXT_PRIVY_LOGIN_METHODS ?? "",
  },

  async redirects() {
    return [
      // BlueBank's production gate (/app/bank + /pay) now lives in
      // src/middleware.ts — it's a token-unlockable preview, which a static
      // config redirect can't express (and config redirects run BEFORE
      // middleware, so they'd shadow the gate). See the BlueBank preview gate
      // there. Remove that block when BlueBank ships to GA.
      // Both of these used to point at `api.blueagent.dev`, which no longer
      // resolves — the Vercel project behind that hostname is gone, so every
      // hit returned 404. `/mcp` is the shortcut printed in the X bio and in
      // tweets, so the most-shared link on the site was dead.
      //
      // The old comment planned to "re-point to blueagent.dev/docs/mcp once the
      // docs domain is consolidated onto the main site". That consolidation has
      // happened (by deletion rather than by plan), so this is that re-point.
      // Destinations are now same-origin paths that exist in this app under
      // src/app/docs/ — a route that ships with the build can't rot the way an
      // external hostname can.
      //
      // Kept at 307 (`permanent: false`) deliberately: a 308 is cached by the
      // browser indefinitely, and these two have already moved once.
      {
        source: "/mcp",
        destination: "/docs/mcp",
        permanent: false,
      },
      {
        source: "/api-docs",
        destination: "/docs/api",
        permanent: false,
      },
      // (Removed the /app/hub/:tool → /hub/:tool redirect: /app/hub/[tool] is now
      //  a real in-app route — the redirect would shadow it.)
    ];
  },
  webpack(config) {
    // tempoWallet connector dynamically imports 'accounts' (native pkg)
    // which doesn't exist in Node/webpack — mark it as external to skip bundling
    config.externals = [
      ...(Array.isArray(config.externals) ? config.externals : config.externals ? [config.externals] : []),
      { accounts: "accounts", "pino-pretty": "pino-pretty" },
    ];
    // wagmi v3's `wagmi/connectors` barrel re-exports OPTIONAL connectors
    // (porto / safe / walletconnect / metamask-sdk / base-account) whose peer
    // deps we don't install — we only use coinbaseWallet + EIP-6963 + farcaster.
    // Those unresolved imports made webpack fail the whole connectors module,
    // leaving coinbaseWallet undefined and breaking wallet connect. Stub them to
    // empty modules so the barrel compiles; the app never instantiates them.
    config.resolve = config.resolve || {};
    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      "@base-org/account": false,
      "@metamask/connect-evm": false,
      porto: false,
      "porto/internal": false,
      "porto/wagmi": false,
      "@safe-global/safe-apps-sdk": false,
      "@safe-global/safe-apps-provider": false,
      "@walletconnect/ethereum-provider": false,
    };
    return config;
  },
};

export default nextConfig;
