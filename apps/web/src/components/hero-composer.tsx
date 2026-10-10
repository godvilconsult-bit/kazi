"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowRight } from "lucide-react";
import { Chip } from "./ui";

/** Draft carried from the landing page to /new without putting task text in the URL. */
export const DRAFT_KEY = "kazi-draft";

export function saveDraft(text: string) {
  try {
    sessionStorage.setItem(DRAFT_KEY, text);
  } catch {
    // storage unavailable: /new simply starts empty
  }
}

export function HeroComposer() {
  const t = useTranslations("landing");
  const router = useRouter();
  const [text, setText] = useState("");
  const examples = [t("example1"), t("example2"), t("example3"), t("example4")];
  return (
    <form
      className="rounded-xl border border-ink bg-surface p-3 shadow-stamp sm:p-4"
      onSubmit={(e) => {
        e.preventDefault();
        saveDraft(text.trim());
        router.push("/new");
      }}
    >
      <label htmlFor="hero-task" className="sr-only">
        {t("composerLabel")}
      </label>
      <textarea
        id="hero-task"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder={t("composerPlaceholder")}
        className="w-full resize-none bg-transparent text-base leading-relaxed placeholder:text-muted/70 focus:outline-none"
      />
      <div className="mt-2 flex flex-col gap-3 border-t border-dashed border-line pt-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted">{t("composerHint")}</p>
        <button
          type="submit"
          className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-ink bg-accent px-5 font-semibold text-accent-ink shadow-stamp-sm transition-all hover:-translate-x-px hover:-translate-y-px hover:shadow-stamp"
        >
          {t("composerCta")}
          <ArrowRight className="size-4" />
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted">
          {t("examples")}
        </span>
        {examples.map((ex) => (
          <Chip key={ex} onClick={() => setText(ex)} className="text-xs">
            {ex}
          </Chip>
        ))}
      </div>
    </form>
  );
}
