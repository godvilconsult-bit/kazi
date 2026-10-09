"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { ApiError } from "@/lib/api";
import { makeWagmiConfig } from "@/lib/wagmi";
import type { PublicConfig } from "@/lib/types";
import { AuthProvider } from "./auth";
import { ConfigContext } from "./config";

export function Providers({ config, children }: { config: PublicConfig; children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: true,
            // Client errors (404, 403, 409) won't fix themselves; retry only server/network errors.
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
        },
      }),
  );
  const [wagmiConfig] = useState(() => makeWagmiConfig(config));
  return (
    <ConfigContext.Provider value={config}>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>{children}</AuthProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ConfigContext.Provider>
  );
}
