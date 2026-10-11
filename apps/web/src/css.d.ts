// Global stylesheets are imported for their side effects only.
declare module "*.css";

// Long-form pages (src/content) are Markdown, imported as text (next.config.ts: asset/source).
declare module "*.md" {
  const text: string;
  export default text;
}
