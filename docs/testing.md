# Testing Guide

Use the Node/pnpm versions in [package.json](../package.json). Tests use Mocha and an extension host via `@vscode/test-cli`; dependencies must be installed before running them.

## Commands

Run from the repository root:

```bash
pnpm check-types
pnpm lint
pnpm test
```

`pnpm test` compiles tests, type-checks/builds the extension, runs lint, and launches the VS Code test host. Use type-check/lint during editing, then the full suite for behavior changes. For tests-only iteration, `pnpm build-tests` refreshes compiled tests and `pnpm watch-tests` watches them.

The checked-in [.vscode-test.mjs](../.vscode-test.mjs) selects `out/test/**/*.test.js`. If the host cannot start (for example, a missing cached executable), fix the test-host installation or select a verified local installation with a temporary test-runner configuration. A launch failure is not a passing test run; do not commit machine-specific paths.

## Suite Map

| Area under `src/test`                                                     | Coverage                                                       |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [extension.test.ts](../src/test/extension.test.ts)                        | Activation and registered commands                             |
| [schemas](../src/test/schemas/)                                           | Request schema validation                                      |
| [utils](../src/test/utils/)                                               | Configuration, models, images, and shared helpers              |
| [server](../src/test/server/) conversion suites                           | Anthropic, Chat, Responses, and Gemini message/tool conversion |
| `server/toolHistory*.test.ts`                                             | Shared normalization and official SDK stream compatibility     |
| `server/*WebSearch.test.ts`                                               | Hosted/standalone search, provider limits, and isolation       |
| `server/sseHeartbeat.test.ts` and `languageModelRequestLifecycle.test.ts` | Heartbeats, cancellation, timeouts, and stream ordering        |

Use the test runner's output for current counts; parameterized suites make manually maintained totals unreliable.

## Adding Tests

Follow existing `suite` / `test` conventions with Node `assert`. Cover the observable regression, restore mocks/listeners in cleanup hooks, and use isolated temporary files/ports. Do not make ordinary tests consume external model or Exa quota. See [AGENTS.md](../AGENTS.md#tests) for required coverage.

## DSH configuration coverage

The DSH-specific suites cover complete eligible model catalogs, separate default selection, display names, image capabilities, known context/output limits, profile paths, credentials by reference, cancellation, backups/concurrent edits, and preserving unrelated UI/MCP patches during managed-block updates:

- `utils/dshSettings.test.ts` — catalog generation, scalar escaping, formats, limits, managed markers and file-content updates.
- `utils/dshSettingsSafety.test.ts` — conflicting/unsupported YAML layouts and preservation safeguards.
- `utils/dshConfigurator.test.ts` — command callbacks with isolated temporary configuration and mocked model metadata; no hosted-model requests.

The scoped DSH suites passed **219 tests** during this change's verification using an isolated local VS Code test host. Counts can change as coverage grows; use current runner output. Type checking, ESLint and test compilation also passed. These checks do not establish live DSH/Copilot image/chat/search behavior. Follow the [DSH setup guide](dsh-setup.md) for a manual connectivity check.

## Manual Validation

The usage dashboard suites under src/test/usage cover streaming and non-streaming provider usage for Anthropic, OpenAI Chat/Responses, and Gemini; multi-round and concurrent session correlation; cancellation and provider errors; weighted cache rates; journal reload/retention; schema allowlisting; and HTML escaping. The extension suite checks that **Open Usage Dashboard** creates and reuses a webview. These tests use synthetic usage, not live provider credentials.

For dashboard UI review, invoke **Agent Maestro: Open Usage Dashboard**, change period/model/session filters, inspect the empty state, import a synthetic session_index.jsonl, forget imported names, and export a filtered view. Check light/dark themes, keyboard navigation, and a narrow editor column. Automated webview activation does not prove every native file-dialog or rendering path.

Cost/performance tests cover exact pricing and aliases, long-context rates, cache read/write accounting, unknown-data coverage, formula-safe CSV, observed timing that excludes metadata and empty content, reasoning/single-chunk exclusions from emission rate, and cache-cohort pivots. Verify model × cache comparisons and dollar trends with synthetic data; these checks do not establish actual provider bills or GPU prefill/decode timings.

Unit tests do not prove UI behavior or live provider compatibility. Record the AM revision, VS Code/client versions, model, isolated ports, expected output, and relevant AM logs for manual runs. Avoid sharing raw request/session logs without applying the [logging guidance](llm-compatibility.md#diagnostic-logs).

- Use the [Codex collaboration runbook](codex-multi-agent-e2e.md) for Responses namespace/plaintext collaboration changes.
- Recheck [image MIME behavior](vscode-image-mime-defect.md) when changing the VS Code engine.
- For documentation-only edits, check links, anchors, examples, and diagrams. Build the website if its source changes; model requests and a full extension-host run are unnecessary unless behavior also changes.
