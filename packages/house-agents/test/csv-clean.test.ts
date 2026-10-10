import { describe, expect, it } from "vitest";
import { applyPlan, cleaningPlanSchema, parseCsv, toCsv } from "../src/csv-cleaner/clean";

/** The csv-cleaner's deterministic half: parsing, conversions and the honesty rules. */

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, CRLF and semicolons", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n').rows).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
    ]);
    const semi = parseCsv("date;amount\n2025-01-03;1.250.000\n");
    expect(semi.delimiter).toBe(";");
    expect(semi.rows[1]).toEqual(["2025-01-03", "1.250.000"]);
  });

  it("round-trips through toCsv", () => {
    const rows = [["name", "note"], ["Asha", 'says "hi", ok']];
    expect(parseCsv(toCsv(rows)).rows).toEqual(rows);
  });
});

describe("applyPlan", () => {
  const plan = cleaningPlanSchema.parse({
    columns: [
      { source: "Customer Name ", target: "customer_name", type: "text", case: "title" },
      { source: "Phone No.", target: "phone", type: "phone", phoneCountry: "255" },
      { source: "Joined", target: "joined", type: "date", dateFormat: "DMY" },
      { source: "Email", target: "email", type: "email" },
      { source: "Amount", target: "amount", type: "decimal" },
      { source: "Notes", target: "notes", type: "drop" },
    ],
    dedupe: true,
    dropEmptyRows: true,
  });
  const header = ["Customer Name ", "Phone No.", "Joined", "Email", "Amount", "Notes"];

  it("cleans every row the same way and reports what it couldn't convert", () => {
    const body = [
      ["  amina juma ", "0754 123 456", "03/02/2024", "AMINA@Example.com", "1.250.000,50", "vip"],
      ["John  Mushi", "+255 713 222 333", "15/11/2023", "john@example.com", "980,500", ""],
      ["  amina juma ", "0754 123 456", "03/02/2024", "AMINA@Example.com", "1.250.000,50", "vip"],
      ["Rehema K", "713444555", "31/02/2025", "rehema(at)mail", "abc", ""],
      ["", "", "", "", "", ""],
    ];
    const r = applyPlan(header, body, plan);
    expect(r.rows[0]).toEqual(["customer_name", "phone", "joined", "email", "amount"]);
    expect(r.rows[1]).toEqual(["Amina Juma", "+255754123456", "2024-02-03", "amina@example.com", "1250000.50"]);
    expect(r.rows[2]).toEqual(["John Mushi", "+255713222333", "2023-11-15", "john@example.com", "980500"]);
    // Invalid values are kept as-is and counted, never silently "fixed".
    expect(r.rows[3]).toEqual(["Rehema K", "+255713444555", "31/02/2025", "rehema(at)mail", "abc"]);
    expect(r.invalid).toEqual({ joined: 1, email: 1, amount: 1 });
    expect(r).toMatchObject({ rowsIn: 5, rowsOut: 3, duplicatesRemoved: 1, emptyRemoved: 1 });
  });

  it("reads month-first dates when the plan says so", () => {
    const us = cleaningPlanSchema.parse({ columns: [{ source: "d", target: "d", type: "date", dateFormat: "MDY" }] });
    expect(applyPlan(["d"], [["12/31/2024"], ["01/15/25"]], us).rows.slice(1)).toEqual([["2024-12-31"], ["2025-01-15"]]);
  });
});
