"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { FileText, Paperclip, X } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { uploadFile } from "@/lib/upload";
import type { FileView } from "@/lib/types";
import { Button } from "./ui";

/** Multi-file uploader: each file goes straight to storage; the parent keeps the file ids. */
export function FileUpload({
  files,
  onChange,
  max = 20,
  disabled,
}: {
  files: FileView[];
  onChange: (files: FileView[]) => void;
  max?: number;
  disabled?: boolean;
}) {
  const t = useTranslations("composer");
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<{ name: string; progress: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function add(list: FileList | null) {
    if (!list) return;
    setError(null);
    const next = [...files];
    for (const f of Array.from(list).slice(0, Math.max(0, max - files.length))) {
      setBusy({ name: f.name, progress: 0 });
      try {
        next.push(await uploadFile(f, (p) => setBusy({ name: f.name, progress: p })));
        onChange([...next]);
      } catch (err) {
        setError(t("uploadFailed", { name: f.name, error: errorMessage(err) }));
      }
    }
    setBusy(null);
    if (input.current) input.current.value = "";
  }

  return (
    <div>
      {files.length > 0 ? (
        <ul className="mb-2 space-y-1.5">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
              <FileText className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{f.filename}</span>
              <span className="font-mono text-xs text-muted">{formatBytes(f.size)}</span>
              <button
                type="button"
                className="rounded p-1 text-muted hover:bg-surface-2 hover:text-bad"
                aria-label={`${t("remove")} ${f.filename}`}
                onClick={() => onChange(files.filter((x) => x.id !== f.id))}
                disabled={disabled}
              >
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input ref={input} type="file" multiple className="sr-only" onChange={(e) => void add(e.target.files)} disabled={disabled || busy !== null} />
      <Button variant="outline" size="sm" onClick={() => input.current?.click()} disabled={disabled || files.length >= max} loading={busy !== null}>
        <Paperclip className="size-4" />
        {busy ? `${t("uploading", { name: busy.name })} ${Math.round(busy.progress * 100)}%` : t("addFiles")}
      </Button>
      {error ? (
        <p className="mt-2 text-sm text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
