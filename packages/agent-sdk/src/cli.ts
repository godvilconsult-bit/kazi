/**
 * kazi-agent CLI. Usage:
 *   kazi-agent dev --endpoint http://localhost:4200/run --secret whsec_... --capability translate.en-sw
 *     [--instructions "..."] [--input "..." | --input-file path] [--rubric "a;b"] [--format markdown]
 *     [--must-include "x;y"] [--timeout 600]
 * The secret can also come from KAZI_AGENT_SECRET.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runDevTask, sampleTask } from "./dev";

const FORMATS = ["markdown", "text", "json", "file"] as const;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "dev") {
    console.error(
      "usage: kazi-agent dev --endpoint <url> --secret <secret> --capability <slug> [options]",
    );
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      endpoint: { type: "string" },
      secret: { type: "string" },
      capability: { type: "string" },
      instructions: { type: "string" },
      input: { type: "string" },
      "input-file": { type: "string" },
      rubric: { type: "string" },
      format: { type: "string", default: "markdown" },
      "must-include": { type: "string" },
      timeout: { type: "string", default: "600" },
    },
  });
  const secret = values.secret ?? process.env["KAZI_AGENT_SECRET"];
  if (!values.endpoint || !secret || !values.capability) {
    console.error("--endpoint, --secret (or KAZI_AGENT_SECRET) and --capability are required");
    return 2;
  }
  const format = FORMATS.find((f) => f === values.format);
  if (!format) {
    console.error(`--format must be one of ${FORMATS.join(", ")}`);
    return 2;
  }
  const sample = sampleTask(values.capability);
  const split = (v: string | undefined) =>
    v
      ? v
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

  const result = await runDevTask({
    endpoint: values.endpoint,
    secret,
    capability: values.capability,
    instructions: values.instructions ?? sample.instructions,
    input: values["input-file"]
      ? readFileSync(values["input-file"], "utf8")
      : (values.input ?? sample.input),
    rubric: split(values.rubric) ?? sample.rubric,
    format,
    ...(split(values["must-include"]) ? { mustInclude: split(values["must-include"]) } : {}),
    timeoutSec: Number(values.timeout),
    onEvent: (line) => console.log(line),
  });

  console.log("");
  console.log(`mode: ${result.mode}, ${result.latencyMs} ms`);
  if (result.output?.text) {
    const preview =
      result.output.text.length > 1_500
        ? `${result.output.text.slice(0, 1_500)}\n…`
        : result.output.text;
    console.log(`\n--- output ---\n${preview}\n--------------`);
  }
  if (result.error) console.log(`agent failed: ${result.error.code} — ${result.error.message}`);
  for (const p of result.problems) console.log(`protocol problem: ${p}`);
  for (const c of result.checks) console.log(`check failed (${c.code}): ${c.message}`);
  console.log(
    result.ok
      ? "\nPASS: protocol and Kazi's deterministic checks OK. (On Kazi an LLM judge also scores the work against the rubric.)"
      : "\nFAIL",
  );
  return result.ok ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
