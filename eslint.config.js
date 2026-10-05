// Flat ESLint config — the frontend half of the mechanical quality gate
// (TODO group Y #163). `cargo clippy` / `cargo fmt --check` cover the backend.
//
// Deliberately narrow. The rules here are the ones that catch *defects* — a
// bad hook dependency, a `case` that falls through, a promise nobody awaits —
// not the ones that relitigate formatting or style, which no one is currently
// getting wrong. A gate that is green on the day it lands is a gate that stays
// on; one that lands with 400 pre-existing violations gets `--no-verify`'d into
// irrelevance within a week.
//
// Type-aware linting (`projectService`) is off on purpose: it roughly triples
// the run time on ~200k lines, and `npm run build` already runs `tsc`, which is
// the same type information reaching the same conclusions.

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    // Build output, deps, and the Rust side. Vite/Tauri config files are
    // linted — they are real code that can break a build.
    //
    // `target/**` holds Rust build artifacts, including generated Tauri API
    // shims; `.eldrun/**` is the sandbox's runtime scratch (KWin scripts and
    // the like). Both are machine-written, both are gitignored, and between
    // them they accounted for 253 of the 307 findings on the first run.
    ignores: [
      'dist/**',
      'mobile-dist/**',
      'node_modules/**',
      'src-tauri/**',
      'target/**',
      '.eldrun/**',
      '.tabtivity/**',
      // Agent worktrees: full checkouts, each linted from its own root.
      '.claude/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // --- Hooks: the highest-yield React rules there are. -----------------
      ...reactHooks.configs.recommended.rules,
      // exhaustive-deps is advisory, not a gate: plenty of the deliberate
      // omissions in this codebase (mount-only effects, refs held across
      // renders) are correct, and it cannot tell those from mistakes.
      'react-hooks/exhaustive-deps': 'warn',

      // --- Defect-shaped rules. --------------------------------------------
      'no-fallthrough': 'error',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-unreachable-loop': 'error',
      'no-template-curly-in-string': 'error',
      '@typescript-eslint/no-unused-expressions': 'error',
      '@typescript-eslint/no-misused-new': 'error',

      // --- Escape hatches: allowed, but each one has to be argued for. -----
      // Both stay at `warn`: 5 `@ts-ignore` and 7 `: any` across the frontend
      // is the discipline this gate exists to preserve, and neither is a bug
      // on its own. If the counts start climbing, promote these to `error`.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/ban-ts-comment': [
        'warn',
        { 'ts-ignore': 'allow-with-description', minimumDescriptionLength: 10 },
      ],

      // Unused *variables* are worth catching; unused function parameters are
      // routinely load-bearing for signature shape (callbacks, event handlers).
      // The `_` prefix is the documented opt-out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'none',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Empty blocks are usually a swallowed error; an empty `catch` with a
      // comment explaining why is the legitimate case, and stays legal.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // `let x; installCallback(() => x); x = value;` is the standard shape for
      // handing a not-yet-rendered element to a mock — the read is deferred, so
      // it cannot be a `const`, but ESLint counts one assignment and asks.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],

      // --- Rules deliberately off, with the reason. -------------------------
      // Terminal and markdown code matches control characters on purpose: ANSI
      // escapes (\x1b, \x07) in the agent-prompt and prompt-count parsers, NUL
      // sentinels in the markdown pipeline. All 8 hits were intentional.
      'no-control-regex': 'off',
      // `no-unmodified-loop-condition` cannot see mutation through a method,
      // so `while (cur <= end) { …; cur.setDate(cur.getDate() + 1) }` reads to
      // it as an infinite loop. Two false positives here, no true ones.
      'no-unmodified-loop-condition': 'off',
      // Aliasing `this` is how a nested non-arrow function (a Proxy trap, a
      // prototype-style mock) reaches its enclosing instance. Only `self`.
      '@typescript-eslint/no-this-alias': ['error', { allowedNames: ['self'] }],
    },
  },
  {
    // Tests reach for `any` and non-null assertions to build fixtures cheaply;
    // that is the right trade in a test and the wrong one in `src/`.
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**', 'src/test/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
)
