"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { ECONOMY_MIN_HEADROOM_MS } from "@kazi/shared";
import { api, errorMessage } from "@/lib/api";
import { parseUsdcInput } from "@/lib/format";
import type { FileView, TaskView } from "@/lib/types";
import { useAuth } from "@/components/auth";
import { useKaziConfig } from "@/components/config";
import { PageBody } from "@/components/container";
import { FileUpload } from "@/components/file-upload";
import { DRAFT_KEY } from "@/components/hero-composer";
import { Button, Chip, Field, Input, Notice, PageHeader, Textarea } from "@/components/ui";
import { cn } from "@/lib/cn";

const HOUR = 3_600_000;
const PRESETS = [
  { key: "deadline1d", ms: 24 * HOUR },
  { key: "deadline3d", ms: 72 * HOUR },
  { key: "deadline7d", ms: 168 * HOUR },
] as const;

/** datetime-local value for a Date, in the browser's time zone. */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function NewTaskPage() {
  return (
    <Suspense>
      <Composer />
    </Suspense>
  );
}

function Composer() {
  const t = useTranslations("composer");
  const cfg = useKaziConfig();
  const router = useRouter();
  const params = useSearchParams();
  const fromId = params.get("from");
  const { user, signIn, signingIn } = useAuth();
  const { isConnected } = useAccount();

  const [description, setDescription] = useState("");
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<FileView[]>([]);
  const [budget, setBudget] = useState("");
  const [preset, setPreset] = useState<number | "custom">(PRESETS[1].ms);
  const [custom, setCustom] = useState(() => toLocalInput(new Date(Date.now() + 72 * HOUR)));
  const [speed, setSpeed] = useState<"ECONOMY" | "EXPRESS">("ECONOMY");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A draft from the landing page, or a task being edited (duplicate + cancel the old quote).
  useEffect(() => {
    if (fromId) {
      void api<{ task: TaskView }>(`/tasks/${fromId}`)
        .then(({ task }) => {
          setDescription(task.description);
          setTitle(task.title);
          setSpeed(task.speed);
        })
        .catch(() => undefined);
      return;
    }
    try {
      const draft = sessionStorage.getItem(DRAFT_KEY);
      if (draft) {
        setDescription(draft);
        sessionStorage.removeItem(DRAFT_KEY);
      }
    } catch {
      // storage unavailable
    }
  }, [fromId]);

  const deadline = useMemo(
    () => (preset === "custom" ? new Date(custom) : new Date(Date.now() + preset)),
    [preset, custom],
  );
  const deadlineOk =
    !Number.isNaN(deadline.getTime()) &&
    deadline.getTime() - Date.now() >= HOUR &&
    deadline.getTime() - Date.now() <= 90 * 24 * HOUR;
  const budgetUnits = budget.trim() ? parseUsdcInput(budget, cfg.usdcDecimals) : null;
  const budgetInvalid = budget.trim() !== "" && budgetUnits === null;
  const economyTooClose =
    speed === "ECONOMY" && deadlineOk && deadline.getTime() - Date.now() < ECONOMY_MIN_HEADROOM_MS;
  const derivedTitle = (title.trim() || description.trim().split(/\n|(?<=[.!?])\s/)[0] || "").slice(
    0,
    120,
  );

  async function submit() {
    setError(null);
    if (description.trim().length < 10) return setError(t("tooShort"));
    if (!deadlineOk) return setError(t("deadlineInvalid"));
    setSubmitting(true);
    try {
      const { task } = await api<{ task: TaskView }>("/tasks", {
        method: "POST",
        body: {
          title: derivedTitle.length >= 3 ? derivedTitle : description.trim().slice(0, 60),
          description: description.trim(),
          attachments: files.map((f) => f.id),
          ...(budgetUnits !== null ? { budgetMax: budgetUnits.toString() } : {}),
          deadline: deadline.toISOString(),
          speed,
        },
      });
      await api(`/tasks/${task.id}/quote`, { method: "POST" });
      if (fromId) await api(`/tasks/${fromId}/cancel`, { method: "POST" }).catch(() => undefined);
      router.push(`/tasks/${task.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <PageBody narrow>
      <PageHeader kicker={t("kicker")} title={t("title")}>
        {t("intro")}
      </PageHeader>
      {fromId ? (
        <Notice tone="info" className="mb-6">
          {t("duplicateNote")}
        </Notice>
      ) : null}

      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={t("descriptionLabel")} hint={t("descriptionHint")} htmlFor="description">
          <Textarea
            id="description"
            required
            rows={7}
            maxLength={20_000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("descriptionPlaceholder")}
          />
        </Field>

        <Field label={t("titleLabel")} hint={t("titleHint")} htmlFor="title">
          <Input
            id="title"
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={derivedTitle}
          />
        </Field>

        <Field label={t("files")} hint={t("filesHint")}>
          <FileUpload files={files} onChange={setFiles} disabled={!user} />
        </Field>

        <div className="grid gap-6 sm:grid-cols-2">
          <Field label={t("deadline")} error={!deadlineOk ? t("deadlineInvalid") : undefined}>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <Chip key={p.key} active={preset === p.ms} onClick={() => setPreset(p.ms)}>
                  {t(p.key)}
                </Chip>
              ))}
              <Chip active={preset === "custom"} onClick={() => setPreset("custom")}>
                {t("deadlineCustom")}
              </Chip>
            </div>
            {preset === "custom" ? (
              <Input
                type="datetime-local"
                className="mt-2"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
              />
            ) : null}
          </Field>
          <Field
            label={`${t("budget")} (USDC)`}
            hint={t("budgetHint")}
            error={budgetInvalid ? t("budgetHint") : undefined}
            htmlFor="budget"
          >
            <Input
              id="budget"
              inputMode="decimal"
              placeholder="25.00"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </Field>
        </div>

        <fieldset>
          <legend className="mb-2 text-sm font-semibold">{t("speed")}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["ECONOMY", "EXPRESS"] as const).map((s) => (
              <label
                key={s}
                className={cn(
                  "cursor-pointer rounded-xl border p-4 transition-colors",
                  speed === s
                    ? "border-ink bg-surface shadow-stamp-sm"
                    : "border-line bg-surface/60 hover:border-ink/60",
                )}
              >
                <input
                  type="radio"
                  name="speed"
                  value={s}
                  checked={speed === s}
                  onChange={() => setSpeed(s)}
                  className="sr-only"
                />
                <span className="font-display text-lg font-bold">
                  {s === "ECONOMY" ? t("economy") : t("express")}
                </span>
                <span className="mt-1 block text-sm text-muted">
                  {s === "ECONOMY" ? t("economyHint") : t("expressHint")}
                </span>
              </label>
            ))}
          </div>
          {economyTooClose ? (
            <p className="mt-2 text-sm text-warn">{t("economyTooClose")}</p>
          ) : null}
        </fieldset>

        {error ? <Notice tone="bad">{error}</Notice> : null}

        <div className="border-t border-dashed border-line pt-5">
          {user ? (
            <Button
              type="submit"
              variant="accent"
              size="lg"
              loading={submitting}
              className="w-full sm:w-auto"
            >
              {submitting ? t("submitting") : t("submit")}
            </Button>
          ) : (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-muted">{t("signInToSubmit")}</p>
              {isConnected ? (
                <Button onClick={() => void signIn()} loading={signingIn}>
                  {t("submit")}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </form>
    </PageBody>
  );
}
