import { z } from "zod";

/**
 * Deterministic CSV cleaning for the csv-cleaner house agent: Claude plans the column mapping
 * (`cleaningPlanSchema`), this code applies it to every row, so results are reproducible and the
 * data itself never passes through the model beyond a sample.
 */

export const cleaningPlanSchema = z.object({
  columns: z
    .array(
      z.object({
        source: z.string(),
        target: z.string().min(1).max(80),
        type: z.enum(["text", "integer", "decimal", "date", "phone", "email", "drop"]),
        case: z.enum(["none", "lower", "upper", "title"]).default("none"),
        dateFormat: z.enum(["YMD", "DMY", "MDY"]).optional(),
        phoneCountry: z
          .string()
          .regex(/^\d{1,3}$/)
          .optional(),
      }),
    )
    .min(1),
  dedupe: z.boolean().default(true),
  dropEmptyRows: z.boolean().default(true),
  notes: z.array(z.string().max(300)).max(20).default([]),
});
export type CleaningPlan = z.infer<typeof cleaningPlanSchema>;

/** RFC 4180 parser with delimiter detection (comma, semicolon or tab). */
export function parseCsv(input: string): { rows: string[][]; delimiter: string } {
  const text = input.replace(/^\uFEFF/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length - 1] as const);
  const delimiter = counts.sort((a, b) => b[1] - a[1])[0]?.[0] ?? ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return { rows: rows.filter((r) => !(r.length === 1 && r[0] === "")), delimiter };
}

export function toCsv(rows: string[][]): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(cell).join(",")).join("\n");
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());
}

function cleanNumber(raw: string, integer: boolean): string | null {
  let s = raw.replace(/[\s']/g, "");
  if (s === "") return "";
  // A currency code around a number ("TZS1,250", "980 KES") is dropped; anything else stays as-is.
  const withCode = /^(?:[A-Z]{3})?(-?[\d.,]+)(?:[A-Z]{3})?$/i.exec(s);
  if (withCode?.[1]) s = withCode[1];
  const commas = (s.match(/,/g) ?? []).length;
  const dots = (s.match(/\./g) ?? []).length;
  if (commas > 0 && dots > 0) {
    // "1.234,56" vs "1,234.56": with both present, the last separator is the decimal one.
    s =
      s.lastIndexOf(",") > s.lastIndexOf(".")
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
  } else if (commas + dots > 0) {
    const sep = commas > 0 ? "," : ".";
    const count = commas + dots;
    // One separator followed by exactly 3 digits ("980,500") or several ("1.250.000") = thousands.
    const thousands =
      count > 1 || (s.length - s.indexOf(sep) - 1 === 3 && /^-?\d+$/.test(s.replace(sep, "")));
    s = thousands ? s.split(sep).join("") : s.replace(sep, ".");
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  if (integer) return /^-?\d+(\.0+)?$/.test(s) ? s.replace(/\.0+$/, "") : null;
  return s;
}

function cleanDate(raw: string, format: "YMD" | "DMY" | "MDY"): string | null {
  const s = raw.trim();
  if (s === "") return "";
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  const parts = iso ? [iso[1], iso[2], iso[3]] : s.split(/[/.\-\s]+/);
  if (parts.length < 3) return null;
  const [a, b, c] = parts.map((p) => Number(p)) as [number, number, number];
  let y: number;
  let m: number;
  let d: number;
  if (iso || format === "YMD") [y, m, d] = [a, b, c];
  else if (format === "DMY") [d, m, y] = [a, b, c];
  else [m, d, y] = [a, b, c];
  if (y < 100) y += y < 70 ? 2000 : 1900;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    return null;
  return date.toISOString().slice(0, 10);
}

function cleanPhone(raw: string, country: string | undefined): string | null {
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits === "") return "";
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0") && country) digits = country + digits.slice(1);
  else if (country && digits.length <= 9) digits = country + digits;
  return /^\d{8,15}$/.test(digits) ? `+${digits}` : null;
}

export interface CleanResult {
  rows: string[][];
  rowsIn: number;
  rowsOut: number;
  duplicatesRemoved: number;
  emptyRemoved: number;
  invalid: Record<string, number>;
}

/** Applies the plan. Values that can't be converted are kept as-is and counted, never dropped. */
export function applyPlan(header: string[], body: string[][], plan: CleaningPlan): CleanResult {
  const byName = new Map(header.map((h, i) => [h.trim(), i]));
  const cols = plan.columns.filter((c) => c.type !== "drop" && byName.has(c.source.trim()));
  const invalid: Record<string, number> = {};
  const out: string[][] = [cols.map((c) => c.target)];
  let emptyRemoved = 0;
  const seen = new Set<string>();
  let duplicatesRemoved = 0;
  for (const raw of body) {
    const row = cols.map((c) => {
      const v = (raw[byName.get(c.source.trim()) ?? -1] ?? "").trim().replace(/\s+/g, " ");
      let cleaned: string | null;
      switch (c.type) {
        case "integer":
        case "decimal":
          cleaned = cleanNumber(v, c.type === "integer");
          break;
        case "date":
          cleaned = cleanDate(v, c.dateFormat ?? "DMY");
          break;
        case "phone":
          cleaned = cleanPhone(v, c.phoneCountry);
          break;
        case "email":
          cleaned = v === "" ? "" : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v.toLowerCase() : null;
          break;
        default:
          cleaned =
            c.case === "lower"
              ? v.toLowerCase()
              : c.case === "upper"
                ? v.toUpperCase()
                : c.case === "title"
                  ? titleCase(v)
                  : v;
      }
      if (cleaned === null) {
        invalid[c.target] = (invalid[c.target] ?? 0) + 1;
        return v;
      }
      return cleaned;
    });
    if (plan.dropEmptyRows && row.every((v) => v === "")) {
      emptyRemoved++;
      continue;
    }
    if (plan.dedupe) {
      const key = JSON.stringify(row);
      if (seen.has(key)) {
        duplicatesRemoved++;
        continue;
      }
      seen.add(key);
    }
    out.push(row);
  }
  return {
    rows: out,
    rowsIn: body.length,
    rowsOut: out.length - 1,
    duplicatesRemoved,
    emptyRemoved,
    invalid,
  };
}
