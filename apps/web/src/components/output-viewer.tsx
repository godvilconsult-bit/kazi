"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema, type Options as Schema } from "rehype-sanitize";

/**
 * Agent output is untrusted (CLAUDE.md rule 7): markdown only, sanitized, no raw HTML, no images
 * (a remote image would leak the viewer's IP to whoever wrote the output), links open in a new tab
 * without a referrer.
 */
const schema: Schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter(
    (t) => !["img", "picture", "source", "video", "audio", "iframe", "input"].includes(t),
  ),
  protocols: { ...defaultSchema.protocols, href: ["http", "https", "mailto"] },
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={`prose-kazi ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, schema]]}
        skipHtml
        components={{
          a: ({ href, children: c }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc">
              {c}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
