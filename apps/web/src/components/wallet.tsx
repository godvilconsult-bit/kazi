"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useConnect, type Connector } from "wagmi";
import { Wallet } from "lucide-react";
import { Dialog } from "./dialog";
import { Button } from "./ui";

/**
 * "Connect wallet" + the wallet picker. Used wherever a wallet is needed: the session cookie can
 * outlive the wallet connection (e.g. after a reload), so pages offer to reconnect in place.
 */
export function ConnectWalletButton({
  size = "sm",
  variant = "outline",
  compact,
  className,
}: {
  size?: "sm" | "md" | "lg";
  variant?: "outline" | "primary" | "accent";
  compact?: boolean;
  className?: string;
}) {
  const t = useTranslations("wallet");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant={variant} className={className} onClick={() => setOpen(true)}>
        <Wallet className="size-4" />
        <span className={compact ? "hidden sm:inline" : undefined}>{t("connect")}</span>
      </Button>
      <WalletPicker open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function WalletPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("wallet");
  const { connectors, connect, isPending, variables, error } = useConnect();
  // Prefer wallets discovered via EIP-6963 over the generic "Injected" entry when both exist.
  const discovered = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  const list = connectors.filter((c) => !(c.id === "injected" && discovered.length > 0));
  return (
    <Dialog open={open} onClose={onClose} title={t("chooseWallet")}>
      {list.length === 0 ? <p className="text-sm text-muted">{t("noWallets")}</p> : null}
      <div className="flex flex-col gap-2">
        {list.map((c) => (
          <ConnectorRow
            key={c.uid}
            connector={c}
            pending={isPending && variables?.connector === c}
            onClick={() => connect({ connector: c }, { onSuccess: onClose })}
          />
        ))}
      </div>
      {error ? (
        <p className="mt-3 text-sm text-bad" role="alert">
          {error.message.split("\n")[0]}
        </p>
      ) : null}
      <p className="mt-4 text-xs text-muted">{t("signInHint")}</p>
    </Dialog>
  );
}

function ConnectorRow({
  connector,
  pending,
  onClick,
}: {
  connector: Connector;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-3 text-left font-semibold transition-colors hover:border-ink hover:bg-surface-2 disabled:opacity-60"
    >
      {connector.icon ? (
        // Wallet icons are data: URIs announced by the wallet itself (EIP-6963).
        <img src={connector.icon} alt="" className="size-7 rounded" />
      ) : (
        <span className="grid size-7 place-items-center rounded bg-surface-2">
          <Wallet className="size-4" />
        </span>
      )}
      <span className="flex-1">{connector.name}</span>
      {pending ? <span className="text-xs text-muted">…</span> : null}
    </button>
  );
}
