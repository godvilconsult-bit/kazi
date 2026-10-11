"use client";

import { Printer } from "lucide-react";
import { Button } from "./ui";

/** Opens the browser's print dialog, where "Save as PDF" is one of the destinations. */
export function PrintButton({ label }: { label: string }) {
  return (
    <Button variant="outline" size="sm" onClick={() => window.print()} className="print:hidden">
      <Printer className="size-4" aria-hidden />
      {label}
    </Button>
  );
}
