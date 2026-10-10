"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { Wallet } from "lucide-react";
import { useAuth } from "./auth";
import { Button, EmptyState, Skeleton } from "./ui";

/** Renders children only for a signed-in user; otherwise a sign-in prompt. */
export function RequireAuth({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const t = useTranslations("common");
  const tw = useTranslations("wallet");
  const { user, loading, signIn, signingIn, error } = useAuth();
  const { isConnected } = useAccount();
  if (loading) return <Skeleton className="h-40" />;
  if (!user) {
    return (
      <EmptyState
        icon={<Wallet className="size-8" />}
        title={t("signInNeeded")}
        action={
          isConnected ? (
            <div className="flex flex-col items-center gap-2">
              <Button loading={signingIn} onClick={() => void signIn()}>
                {tw("signIn")}
              </Button>
              {error ? <p className="text-sm text-bad">{error}</p> : null}
            </div>
          ) : (
            <p className="text-sm text-muted">{tw("connect")} ↗</p>
          )
        }
      >
        {tw("signInHint")}
      </EmptyState>
    );
  }
  if (admin && !user.roles.includes("ADMIN")) return <EmptyState title={t("error")} />;
  return <>{children}</>;
}
