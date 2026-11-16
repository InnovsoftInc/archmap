import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import { defineConfig, globalIgnores } from "eslint/config";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import { importX } from "eslint-plugin-import-x";
// @ts-expect-error - No types available for eslint-plugin-promise
import pluginPromise from "eslint-plugin-promise";
import pluginSecurity from "eslint-plugin-security";
import tsParser from "@typescript-eslint/parser";
import { configs as preferArrowFunctionsConfigs } from "eslint-plugin-prefer-arrow-functions";

export default defineConfig([
  // Tests write and then delete coverage/, so linting it races the delete.
  // The viewer is plain browser JavaScript served as-is; the tests write
  // probe folders.
  globalIgnores([
    "dist",
    "coverage",
    "viewer/**",
    "**/.tmp-*",
    "src/__tests__/fixtures/**",
  ]),
  {
    // A stale eslint-disable comment hides nothing, but it misleads readers
    // and silently re-enables suppression if the rule comes back.
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  js.configs.recommended,
  preferArrowFunctionsConfigs.all,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- flatConfigs.recommended's languageOptions type conflicts with defineConfig's expected ConfigWithExtends across the @typescript-eslint/utils and @eslint/config-helpers versions in this repo
  importX.flatConfigs.recommended as any,
  pluginSecurity.configs.recommended,
  tseslint.configs.strict,
  {
    plugins: {
      promise: pluginPromise,
    },
    files: ["**/*.{js,mjs,cjs,jsx,mjsx,ts,tsx,mtsx}"],
    languageOptions: {
      parser: tsParser,
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      ecmaVersion: "latest",
      sourceType: "module",
    },
    settings: {
      "import-x/resolver-next": [
        createTypeScriptImportResolver({
          alwaysTryTypes: true,
          bun: true,
          project: ["./tsconfig.json"],
        }),
      ],
    },
    rules: {
      /* Manually adding promise rules because eslint-plugin-promise is not
       * compatible with ESLint flat config, so the recommended preset cannot
       * be used directly. Defining rules here ensures they are applied correctly.
       */
      "promise/always-return": "error",
      "promise/no-return-wrap": "error",
      "promise/param-names": "error",
      "promise/catch-or-return": "error",
      "promise/no-native": "off",
      "promise/no-nesting": "warn",
      "promise/no-promise-in-callback": "warn",
      "promise/no-callback-in-promise": "warn",
      "promise/avoid-new": "off",
      "promise/no-new-statics": "error",
      "promise/no-return-in-finally": "warn",
      "promise/valid-params": "warn",
      /** Enforce a convention in module import order
       * @see https://github.com/un-ts/eslint-plugin-import-x/blob/master/docs/rules/order.md
       */
      "import-x/order": [
        "warn",
        {
          groups: [
            "builtin", // Node.js modules first
            "external", // npm packages next
            "internal", // internal monorepo or alias packages
            "parent", // ../ imports
            "sibling", // ./ imports
            "index", // ./index files
            "object", // type-only or special TS imports
          ],
        },
      ],
    },
  },
  {
    rules: {
      // archmap's job is reading and writing files in the folder its user points it at (--dir, --out),
      // so every fs call takes a computed path by design.
      "security/detect-non-literal-fs-filename": "off",
    },
  },
  {
    // The model is keyed by ids from save files. Collections have no prototype and
    // validateSave rejects __proto__, prototype and constructor, so keyed access is safe.
    files: ["src/legacy/ledger.ts"],
    rules: { "security/detect-object-injection": "off" },
  },
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The plugin's scripts and the installed bin are plain JavaScript run by
    // node, outside the TypeScript project, so lint them without type info.
    files: ["plugin/**/*.mjs", "bin/**/*.mjs"],
    languageOptions: { parserOptions: { project: false } },
  },
  eslintConfigPrettier, // This plugin must always be last so it gets the chance to override other configs.
]);
