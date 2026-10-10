import type { PrismaClient } from "@kazi/db";
import type { ObjectStorage } from "@kazi/config/storage";
import { capabilityOutputSchema, type AgentInput } from "@kazi/shared";
import { resolveFileRefs, signedFileRef, type FileRef } from "../files/files";

/** Agent input text is capped by the capability input schema (200k chars). */
const MAX_INPUT_CHARS = 190_000;
/** Signed URLs given to agents stay valid long enough for a worst-case (24 h) attempt. */
export const AGENT_FILE_URL_TTL_SEC = 26 * 3_600;

/**
 * What a provider works from (docs/06-ROUTER.md §4): the client's request, the client's
 * attachments, and the accepted outputs of the steps it depends on. The evaluator's judge sees the
 * same text input, so it can tell facts the client supplied from invented ones. File URLs are
 * signed only when `storage` is given (the judge needs text, not files).
 */
export async function buildAgentInput(
  deps: { prisma: PrismaClient; storage?: ObjectStorage | undefined },
  st: {
    taskId: string;
    dependsOn: number[];
    task: { title: string; description: string; attachments?: unknown; clientId?: string };
  },
): Promise<AgentInput> {
  const depOutputs = st.dependsOn.length
    ? await deps.prisma.submission.findMany({
        where: { accepted: true, subtask: { taskId: st.taskId, index: { in: st.dependsOn } } },
        include: { subtask: { select: { index: true, title: true } } },
        orderBy: { subtask: { index: "asc" } },
      })
    : [];
  const sections = [`## Client request\n\n${st.task.title}\n\n${st.task.description}`];
  const fileRefs: FileRef[] = [];
  for (const d of depOutputs) {
    const out = capabilityOutputSchema.safeParse(d.output);
    if (!out.success) continue;
    if (out.data.text) {
      sections.push(
        `## Output of step ${d.subtask.index + 1}: ${d.subtask.title}\n\n${out.data.text}`,
      );
    }
    fileRefs.push(...(out.data.files ?? []));
  }

  let files: FileRef[] = [];
  if (deps.storage) {
    const storage = deps.storage;
    const ids = Array.isArray(st.task.attachments)
      ? st.task.attachments.filter((v): v is string => typeof v === "string")
      : [];
    for (const id of ids) {
      const ref = await signedFileRef({ prisma: deps.prisma, storage }, id, AGENT_FILE_URL_TTL_SEC);
      if (ref) files.push(ref);
    }
    files.push(
      ...(await resolveFileRefs(
        { prisma: deps.prisma, storage },
        fileRefs,
        AGENT_FILE_URL_TTL_SEC,
      )),
    );
  } else {
    files = fileRefs.filter((f) => !f.url.startsWith("kazi://"));
  }
  const text = sections.join("\n\n");
  return {
    text: text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS)}\n[… truncated]` : text,
    ...(files.length ? { files: files.slice(0, 20) } : {}),
  };
}
