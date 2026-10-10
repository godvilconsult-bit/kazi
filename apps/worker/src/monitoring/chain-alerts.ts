import type { ChainEvent, PrismaClient } from "@kazi/db";
import { formatUnits, parseUnits } from "@kazi/shared";
import type { ContractKind } from "../indexer/handlers";
import { notify } from "../notify";
import type { Alerter } from "./alerts";

/**
 * Alerts from indexed contract events (docs/09 §2 "monitoring on large releases, role changes,
 * pauses"). Runs after the indexer applied each event, exactly once per event.
 */

/** Admin parameter changes across Kazi's contracts. */
const ADMIN_SETTINGS = new Set([
  "FeeUpdated",
  "FeeDistributorUpdated",
  "SplitUpdated",
  "TreasuryUpdated",
  "BuybackReserveUpdated",
  "StakingVaultUpdated",
  "InsurancePoolUpdated",
  "CooldownsUpdated",
  "MaxSlashBpsUpdated",
  "MinStakeUpdated",
  "PayoutDelayUpdated",
]);

export interface ChainAlertDeps {
  alerter: Alerter;
  prisma: PrismaClient;
  usdcDecimals: () => Promise<number>;
  /** USDC (decimal string) at or above which one release raises LARGE_RELEASE; null = off. */
  largeReleaseUsdc: string | null;
}

export function chainEventAlerts(deps: ChainAlertDeps) {
  return async (ev: ChainEvent, kind: ContractKind): Promise<void> => {
    const args = ev.args as Record<string, unknown>;
    const where = {
      contract: kind,
      address: ev.contract,
      txHash: ev.txHash,
      block: ev.blockNumber.toString(),
    };
    const once = { key: `${ev.txHash}:${ev.logIndex}`, dedupeSec: 7 * 24 * 3_600 };

    if (ev.name === "RoleGranted" || ev.name === "RoleRevoked") {
      await deps.alerter.send(
        "ROLE_CHANGED",
        `${ev.name} on ${kind} for ${String(args["account"])}`,
        { ...where, role: args["role"], account: args["account"], sender: args["sender"] },
        once,
      );
      return;
    }
    if (ev.name === "Paused" || ev.name === "Unpaused") {
      const paused = ev.name === "Paused";
      await deps.alerter.send(
        paused ? "ESCROW_PAUSED" : "ESCROW_UNPAUSED",
        `${kind} ${paused ? "paused" : "unpaused"} by ${String(args["account"])}`,
        { ...where, by: args["account"] },
        once,
      );
      return;
    }
    if (ADMIN_SETTINGS.has(ev.name)) {
      await deps.alerter.send(
        "ADMIN_SETTING_CHANGED",
        `${ev.name} on ${kind}`,
        { ...where, args },
        once,
      );
      return;
    }
    if (ev.name === "PayoutChangeRequested") {
      const providerId = BigInt(String(args["providerId"]));
      const provider = await deps.prisma.provider.findFirst({
        where: { onchainId: providerId },
        select: { id: true, name: true, ownerId: true },
      });
      await deps.alerter.send(
        "PAYOUT_CHANGE_REQUESTED",
        `payout change requested for provider #${providerId}${provider ? ` (${provider.name})` : ""} → ${String(args["newPayout"])}`,
        {
          ...where,
          providerId: providerId.toString(),
          newPayout: args["newPayout"],
          effectiveAt: args["effectiveAt"],
        },
        once,
      );
      // docs/09 §1: the owner hears about every payout change, so a hijacked key is noticed within the delay.
      if (provider) {
        await notify(deps.prisma, provider.ownerId, {
          type: "PAYOUT_CHANGE_REQUESTED",
          title: `Payout address change requested for ${provider.name}`,
          body: `New payout address ${String(args["newPayout"])} takes effect after the safety delay. If this wasn't you, cancel it from your wallet and contact Kazi now.`,
          link: `/provider/${provider.id}`,
        });
      }
      return;
    }
    if (ev.name === "MilestoneReleased" && deps.largeReleaseUsdc !== null) {
      const decimals = await deps.usdcDecimals();
      const total =
        BigInt(String(args["providerAmount"] ?? "0")) + BigInt(String(args["fee"] ?? "0"));
      const threshold = parseUnits(deps.largeReleaseUsdc, decimals);
      if (total >= threshold) {
        await deps.alerter.send(
          "LARGE_RELEASE",
          `${formatUnits(total, decimals)} USDC released (task ${String(args["taskId"])}, step ${String(args["index"])})`,
          { ...where, amount: total.toString() },
          once,
        );
      }
    }
  };
}
