// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.next-e2e/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "**/coverage/**",
      "**/.turbo/**",
      "packages/contracts/lib/**",
      "packages/contracts/out/**",
      "packages/contracts/cache/**",
      "packages/contracts/broadcast/**",
      "apps/web/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      // CLAUDE.md: no `any` — use `unknown` + Zod.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests may assert presence with `!` — a wrong assumption fails the test. App code stays strict.
    files: ["**/test/**/*.ts", "**/*.test.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  {
    // Node scripts (plain .mjs): the runtime globals they use.
    files: ["**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    // React hooks rules for the web app (calls in order, complete effect dependencies).
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  prettier,
);
