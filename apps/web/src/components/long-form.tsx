import { Children, isValidElement, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * A long-form page (docs, whitepaper): Kazi's own Markdown from src/content, never user or agent
 * content, so no HTML passes through (react-markdown renders none without rehype-raw). Section
 * headings get anchors and a sticky table of contents.
 */
export function LongForm({
  markdown,
  contentLang,
  tocLabel,
  notice,
}: {
  markdown: string;
  contentLang: string;
  tocLabel: string;
  notice?: ReactNode;
}) {
  const toc = [...markdown.matchAll(/^## (.+)$/gm)].map((m) => {
    const text = (m[1] ?? "").replace(/[`*_]/g, "");
    return { text, id: slugify(text) };
  });
  return (
    <div className="grid gap-10 lg:grid-cols-[220px_minmax(0,1fr)] print:block">
      <nav aria-label={tocLabel} className="lg:sticky lg:top-24 lg:self-start print:hidden">
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.18em] text-muted">{tocLabel}</p>
        <ol className="space-y-1.5 border-s border-line ps-4 text-sm">
          {toc.map((h) => (
            <li key={h.id}>
              <a href={`#${h.id}`} className="text-ink/75 hover:text-accent" lang={contentLang}>
                {h.text}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <div className="min-w-0">
        {notice}
        <article className="prose-kazi prose-doc max-w-3xl" lang={contentLang}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h2: ({ children }) => <h2 id={slugify(textOf(children))}>{children}</h2>,
              a: ({ href, children }) =>
                href?.startsWith("/") ? (
                  <Link href={href}>{children}</Link>
                ) : (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ),
            }}
          >
            {markdown}
          </ReactMarkdown>
        </article>
      </div>
    </div>
  );
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return Children.toArray(node).map(textOf).join("");
}
