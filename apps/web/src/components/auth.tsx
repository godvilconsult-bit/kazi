"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useDisconnect, useSignMessage } from "wagmi";
import { createSiweMessage } from "viem/siwe";
import { api, ApiError, errorMessage } from "@/lib/api";
import { isUserRejection } from "@/lib/tx-steps";
import type { User } from "@/lib/types";
import { useKaziConfig } from "./config";

interface AuthState {
  user: User | null;
  loading: boolean;
  signingIn: boolean;
  error: string | null;
  /** The connected wallet differs from the signed-in one. */
  mismatch: boolean;
  signIn: () => Promise<boolean>;
  signOut: () => Promise<void>;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("AuthProvider missing");
  return ctx;
}

/** Sign-In with Ethereum (EIP-4361) against the API; the session is an httpOnly cookie. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const cfg = useKaziConfig();
  const qc = useQueryClient();
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { disconnectAsync } = useDisconnect();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return (await api<{ user: User }>("/me")).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });

  const signIn = useCallback(async () => {
    if (!address) return false;
    setSigningIn(true);
    setError(null);
    try {
      const { nonce } = await api<{ nonce: string }>("/auth/nonce");
      const message = createSiweMessage({
        address,
        chainId: cfg.chain.id,
        domain: window.location.host,
        nonce,
        uri: window.location.origin,
        version: "1",
        issuedAt: new Date(),
        statement: "Sign in to Kazi",
      });
      const signature = await signMessageAsync({ message });
      const { user } = await api<{ user: User }>("/auth/verify", {
        method: "POST",
        body: { message, signature },
      });
      qc.setQueryData(["me"], user);
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      return true;
    } catch (err) {
      if (!isUserRejection(err)) setError(errorMessage(err));
      return false;
    } finally {
      setSigningIn(false);
    }
  }, [address, cfg.chain.id, signMessageAsync, qc]);

  const signOut = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    qc.setQueryData(["me"], null);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    await disconnectAsync().catch(() => undefined);
  }, [qc, disconnectAsync]);

  const user = me.data ?? null;
  const value = useMemo<AuthState>(
    () => ({
      user,
      loading: me.isLoading,
      signingIn,
      error,
      mismatch: Boolean(user && address && user.wallet.toLowerCase() !== address.toLowerCase()),
      signIn,
      signOut,
      isAdmin: Boolean(user?.roles.includes("ADMIN")),
    }),
    [user, me.isLoading, signingIn, error, address, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
