import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Subtask, Task } from "@kazi/db";
import { formatUnits, providerPayout } from "@kazi/shared";

/** A plain, printable invoice/receipt for a funded task (docs/07-FRONTEND.md §3 COMPLETED). */
export async function renderInvoice(input: {
  task: Task;
  clientWallet: string;
  subtasks: (Subtask & { provider: { name: string } | null })[];
  explorerUrl: string | null;
  decimals: number;
}): Promise<Uint8Array> {
  const { task, decimals } = input;
  const usdc = (v: bigint) => `${formatUnits(v, decimals)} USDC`;
  const doc = await PDFDocument.create();
  doc.setTitle(`Kazi invoice ${task.id}`);
  const page = doc.addPage([595, 842]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.42, 0.42, 0.46);
  let y = 790;
  const line = (text: string, opts: { size?: number; f?: typeof font; color?: typeof ink; x?: number } = {}) => {
    page.drawText(text, { x: opts.x ?? 50, y, size: opts.size ?? 10, font: opts.f ?? font, color: opts.color ?? ink });
  };
  // pdf-lib's standard fonts only cover WinAnsi; keep text printable.
  const safe = (t: string) => t.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?").slice(0, 90);

  line("KAZI", { size: 22, f: bold });
  line("Invoice / receipt", { size: 11, color: muted, x: 420 });
  y -= 34;
  line(safe(task.title), { size: 13, f: bold });
  y -= 18;
  line(`Task ${task.id}`, { color: muted });
  y -= 14;
  line(`Client wallet ${input.clientWallet}`, { color: muted });
  y -= 14;
  line(`Status ${task.status}  ·  Created ${task.createdAt.toISOString().slice(0, 10)}`, { color: muted });
  y -= 30;

  line("Step", { f: bold });
  line("Provider", { f: bold, x: 290 });
  line("Amount", { f: bold, x: 470 });
  y -= 6;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.5, color: muted });
  y -= 16;
  for (const st of input.subtasks) {
    line(safe(`${st.index + 1}. ${st.title}`).slice(0, 48));
    line(safe(st.provider?.name ?? "-").slice(0, 32), { x: 290 });
    line(usdc(BigInt(st.amount)), { x: 470 });
    y -= 16;
    if (y < 120) break;
  }
  y -= 4;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.5, color: muted });
  y -= 18;
  const total = BigInt(task.totalAmount ?? "0");
  const fees = input.subtasks.reduce((a, st) => a + (BigInt(st.amount) - providerPayout(BigInt(st.amount), task.feeBps ?? 0)), 0n);
  line("Total paid into escrow", { f: bold });
  line(usdc(total), { f: bold, x: 470 });
  y -= 16;
  line(`of which platform fees (${((task.feeBps ?? 0) / 100).toFixed(2)}% per payment)`, { color: muted });
  line(usdc(fees), { color: muted, x: 470 });
  y -= 30;
  if (task.fundTxHash) {
    line("Funding transaction", { f: bold });
    y -= 14;
    line(task.fundTxHash, { color: muted, size: 8 });
    y -= 12;
    if (input.explorerUrl) line(`${input.explorerUrl}/tx/${task.fundTxHash}`.slice(0, 110), { color: muted, size: 8 });
  }
  page.drawText("Paid in USDC on Arc. Amounts are held in escrow and paid to providers per step.", {
    x: 50,
    y: 60,
    size: 8,
    font,
    color: muted,
  });
  return doc.save();
}
