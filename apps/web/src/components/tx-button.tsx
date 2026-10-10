"use client";

import { useState, type ReactNode } from "react";
import type { Hex } from "viem";
import { errorMessage } from "@/lib/api";
import { isUserRejection } from "@/lib/tx-steps";
import { TxLink } from "./money";
import { Button, type ButtonProps } from "./ui";

/**
 * One wallet transaction behind a button: spinner while the wallet and chain work, the explorer
 * link once sent, and the error (wallet rejections stay quiet — they're the user's choice).
 */
export function TxButton({
  run,
  onDone,
  children,
  disabled,
  variant = "primary",
  size = "md",
  className,
}: {
  run: (onHash: (hash: Hex) => void) => Promise<unknown>;
  onDone?: () => void;
  children: ReactNode;
  disabled?: boolean;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={className}>
      <Button
        variant={variant}
        size={size}
        loading={busy}
        disabled={disabled}
        onClick={async () => {
          setError(null);
          setHash(null);
          setBusy(true);
          try {
            await run(setHash);
            onDone?.();
          } catch (err) {
            if (!isUserRejection(err)) setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {children}
      </Button>
      {hash ? <TxLink hash={hash} className="mt-1.5 flex" /> : null}
      {error ? (
        <p className="mt-1.5 text-sm text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
