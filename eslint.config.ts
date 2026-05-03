import eslint from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import importX from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintConfigPrettier,

  // Global config
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Source files — strictest rules
  {
    files: ["index.ts", "src/**/*.ts"],
    ignores: ["src/__tests__/**"],
    plugins: { "import-x": importX },
    settings: {
      "import-x/resolver": {
        typescript: {
          project: "./tsconfig.json",
        },
        node: true,
      },
    },
    rules: {
      // === TypeScript Strict ===
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
          allowDirectConstAssertionInArrowFunctions: true,
        },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/method-signature-style": "error",
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/prefer-regexp-exec": "error",
      "@typescript-eslint/promise-function-async": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-duplicate-type-constituents": "error",
      "@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
      "@typescript-eslint/no-unnecessary-template-expression": "error",
      "@typescript-eslint/no-useless-empty-export": "error",
      "@typescript-eslint/prefer-find": "error",
      "@typescript-eslint/prefer-includes": "error",
      "@typescript-eslint/prefer-reduce-type-parameter": "error",
      "@typescript-eslint/prefer-string-starts-ends-with": "error",

      // === JavaScript Strict ===
      "no-console": "error",
      "no-debugger": "error",
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      "no-implicit-coercion": "error",
      "object-shorthand": ["error", "always"],
      "prefer-template": "error",
      "no-else-return": ["error", { allowElseIf: false }],
      "prefer-arrow-callback": "error",
      "func-style": ["error", "declaration", { allowArrowFunctions: true }],
      "prefer-spread": "error",
      "prefer-rest-params": "error",
      "no-param-reassign": "error",
      "no-throw-literal": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-new-wrappers": "error",
      "no-proto": "error",
      "no-return-assign": "error",
      "no-self-compare": "error",
      "no-sequences": "error",
      "no-unneeded-ternary": "error",
      "no-useless-call": "error",
      "no-useless-concat": "error",
      "no-useless-rename": "error",
      "no-useless-return": "error",
      radix: "error",
      "@typescript-eslint/no-shadow": "error",

      // === Import Ordering & Path Restrictions ===
      "import-x/order": [
        "error",
        {
          groups: [
            "builtin", // node:fs, node:path
            "external", // npm packages
            "internal", // @/* alias
            "parent", // ../
            "sibling", // ./
            "index", // ./index
            "type",
          ],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
          pathGroups: [
            { pattern: "@/**", group: "internal" },
            { pattern: "~/**", group: "internal" },
          ],
          pathGroupsExcludedImportTypes: ["builtin"],
        },
      ],
      "import-x/newline-after-import": ["error", { count: 1 }],
      "import-x/no-duplicates": "error",
      // ../ 상대경로 전부 차단 → @/ 또는 ~/ alias 사용
      // false positive: resolves @/ then flags the relative path as "parent"
      "import-x/no-relative-parent-imports": "off",
    },
  },

  // Test files — relaxed rules
  {
    files: ["src/__tests__/**"],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/unbound-method": "off",
      "import-x/order": "off",
    },
  },

  // ESLint config file itself
  {
    files: ["eslint.config.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
);
