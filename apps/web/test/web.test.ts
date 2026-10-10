import { describe, expect, it } from "vitest";
import en from "../src/messages/en.json";
import sw from "../src/messages/sw.json";
import { parseUsdcInput, priceLabel, shortAddress, tokenAmount, usdc } from "../src/lib/format";
import { initSteps, isBusy, isUserRejection, nextStep, stepsReducer } from "../src/lib/tx-steps";

/** docs/07-FRONTEND.md §6: amount formatting and tx stepper error states; plus en/sw parity. */

describe("money display", () => {
  it("shows 2 decimals rounded down, with the exact value kept", () => {
    expect(usdc("1999999", 6)).toEqual({ display: "1.99", exact: "1.999999" });
    expect(usdc("25730000", 6).display).toBe("25.73");
    expect(usdc("0", 6).display).toBe("0.00");
    expect(usdc(null, 6).display).toBe("0.00");
    // Same base units, different token decimals: never assume 6.
    expect(usdc("1000000000000000000", 18).display).toBe("1.00");
  });

  it("parses user input into base units and rejects bad input", () => {
    expect(parseUsdcInput("12.5", 6)).toBe(12_500_000n);
    expect(parseUsdcInput(" 3 ", 6)).toBe(3_000_000n);
    expect(parseUsdcInput("1.1234567", 6)).toBeNull(); // more decimals than the token has
    expect(parseUsdcInput("-1", 6)).toBeNull();
    expect(parseUsdcInput("abc", 6)).toBeNull();
    expect(parseUsdcInput("", 6)).toBeNull();
  });

  it("formats token amounts, prices and addresses", () => {
    expect(tokenAmount(10_000n * 10n ** 18n, 18, 0)).toBe("10,000");
    expect(tokenAmount(1_234_567_891n, 6)).toBe("1,234.56");
    expect(priceLabel({ model: "per_unit", unit: "1000_words", price: "0.80" })).toBe(
      "0.80 USDC / 1,000 words",
    );
    expect(priceLabel({ model: "fixed", price: "6.00" })).toBe("6.00 USDC");
    expect(shortAddress("0x274262A0321A0701b0A46a3576e07aE881c286Bb")).toBe("0x2742…86Bb");
  });
});

describe("transaction stepper", () => {
  it("walks approve → fund and records hashes", () => {
    let s = initSteps(["approve", "fund"]);
    s = stepsReducer(s, { type: "wallet", key: "approve" });
    expect(isBusy(s)).toBe(true);
    s = stepsReducer(s, { type: "sent", key: "approve", hash: "0xaa" });
    s = stepsReducer(s, { type: "done", key: "approve" });
    expect(nextStep(s)?.key).toBe("fund");
    s = stepsReducer(s, { type: "wallet", key: "fund" });
    s = stepsReducer(s, { type: "sent", key: "fund", hash: "0xbb" });
    s = stepsReducer(s, { type: "done", key: "fund" });
    expect(nextStep(s)).toBeNull();
    expect(s.map((x) => x.hash)).toEqual(["0xaa", "0xbb"]);
  });

  it("keeps finished steps on retry and resets the failed one", () => {
    let s = initSteps(["approve", "fund"]);
    s = stepsReducer(s, { type: "skip", key: "approve" }); // allowance already enough
    s = stepsReducer(s, { type: "wallet", key: "fund" });
    s = stepsReducer(s, { type: "error", key: "fund", error: "execution reverted" });
    expect(isBusy(s)).toBe(false);
    expect(s[1]).toMatchObject({ status: "error", error: "execution reverted" });
    s = stepsReducer(s, { type: "reset" });
    expect(s.map((x) => x.status)).toEqual(["skipped", "idle"]);
    expect(nextStep(s)?.key).toBe("fund");
  });

  it("treats wallet rejections as the user's choice", () => {
    expect(
      isUserRejection(
        Object.assign(new Error("User rejected the request."), {
          name: "UserRejectedRequestError",
        }),
      ),
    ).toBe(true);
    expect(isUserRejection(new Error("execution reverted: InsufficientBalance"))).toBe(false);
  });
});

describe("translations", () => {
  const keys = (o: unknown, prefix = ""): string[] =>
    typeof o === "object" && o !== null
      ? Object.entries(o).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
      : [prefix];
  // Argument names only ({name} or {count, plural, …}); words inside plural branches are text.
  const placeholders = (s: string) =>
    [...new Set([...s.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((m) => m[1]))].sort();
  const lookup = (o: unknown, path: string) =>
    path.split(".").reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], o);

  it("Swahili has exactly the English keys", () => {
    expect(keys(sw).sort()).toEqual(keys(en).sort());
  });

  it("every Swahili string keeps the English placeholders", () => {
    for (const k of keys(en)) {
      const e = lookup(en, k);
      const s = lookup(sw, k);
      if (typeof e === "string" && typeof s === "string")
        expect(placeholders(s), k).toEqual(placeholders(e));
    }
  });
});
