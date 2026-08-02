import { includeIgnoreFile } from "@eslint/compat";
import pluginJs from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import globals from "globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gitignorePath = path.resolve(__dirname, ".gitignore");

/** @type {import('eslint').Linter.Config[]} */
export default [
  includeIgnoreFile(gitignorePath),
  { ignores: ["src/server/gatekeeper/**", "tests/pathfinding/playground/**"] },
  { files: ["**/*.{js,mjs,cjs,ts}"] },
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "__mocks__/fileMock.js",
            "examples/external-agent/agent-policy.mjs",
            "examples/external-agent/simple-agent.mjs",
            "examples/external-agent/smoke-test.mjs",
            "examples/external-agent/starter-framework.mjs",
            "eslint.config.js",
            "scripts/sync-assets.mjs",
            ".omp/hooks/pre/proxywar-guard.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Disable rules that would fail. The failures should be fixed, and the entries here removed.
      "@typescript-eslint/no-explicit-any": "off",
      "no-unused-vars": "off",
    },
  },
  {
    rules: {
      // Enable rules
      "@typescript-eslint/prefer-nullish-coalescing": "warn",
      eqeqeq: "error",
      "no-case-declarations": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "none",
          caughtErrors: "none",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Plain JS/MJS/CJS module files (build scripts, .mjs policies, adapter JS
    // modules) are not part of a TS project, so the type-aware project service
    // cannot resolve them ("not found by the project service"). Lint them
    // without type-checking instead of erroring on every such file.
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
];
