"use client";

import { useTranslations } from "next-intl";
import { PageBody } from "@/components/container";
import { ErrorState } from "@/components/ui";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errorPage");
  const tc = useTranslations("common");
  return (
    <PageBody narrow className="py-16">
      <ErrorState title={t("title")} message={t("body")} onRetry={reset} retryLabel={tc("retry")} />
    </PageBody>
  );
}
