"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useAccount, useSwitchChain } from "wagmi";
import { ExternalLink } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { useKaziConfig } from "@/components/config";
import { PageBody } from "@/components/container";
import { AddressPill } from "@/components/money";
import { Button, ButtonLink, Card, Notice, PageHeader } from "@/components/ui";

export default function GetUsdcPage() {
  const t = useTranslations("getUsdc");
  const cfg = useKaziConfig();
  const { address, isConnected } = useAccount();
  const { switchChainAsync, isPending } = useSwitchChain();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const testnet = cfg.chain.network !== "mainnet";

  return (
    <PageBody narrow>
      <PageHeader kicker={t("kicker")} title={t("title")}>
        {t("intro")}
      </PageHeader>
      <div className="space-y-4">
        <Card>
          <h2 className="font-display text-lg font-bold">{t("networkTitle")}</h2>
          <p className="mt-1 text-sm text-muted">{t("networkBody", { name: cfg.chain.name })}</p>
          {isConnected ? (
            <Button
              className="mt-4"
              loading={isPending}
              onClick={async () => {
                setError(null);
                try {
                  // Wallets add the chain when they don't know it yet (wallet_addEthereumChain).
                  await switchChainAsync({ chainId: cfg.chain.id });
                  setDone(true);
                } catch (err) {
                  setError(errorMessage(err));
                }
              }}
            >
              {t("addNetwork", { name: cfg.chain.name })}
            </Button>
          ) : null}
          {done ? (
            <Notice tone="ok" className="mt-3">
              {t("networkAdded")}
            </Notice>
          ) : null}
          {error ? (
            <Notice tone="bad" className="mt-3">
              {error}
            </Notice>
          ) : null}
        </Card>
        <Card>
          <h2 className="font-display text-lg font-bold">
            {testnet ? t("testnetTitle") : t("mainnetTitle")}
          </h2>
          <p className="mt-1 text-sm text-muted">{testnet ? t("testnetBody") : t("mainnetBody")}</p>
          {address ? <AddressPill address={address} className="mt-3" /> : null}
          {testnet && cfg.chain.faucetUrl ? (
            <div className="mt-4">
              <ButtonLink href={cfg.chain.faucetUrl} external variant="accent">
                {t("faucet")}
                <ExternalLink className="size-4" />
              </ButtonLink>
            </div>
          ) : null}
        </Card>
        <Card className="opacity-80">
          <h2 className="font-display text-lg font-bold">{t("mpesaTitle")}</h2>
          <p className="mt-1 text-sm text-muted">{t("mpesaBody")}</p>
        </Card>
      </div>
    </PageBody>
  );
}
