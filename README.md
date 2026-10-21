# Agent Maestro

[![Visual Studio Marketplace installs](https://badgen.net/vs-marketplace/i/Joouis.agent-maestro)](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro)
[![Visual Studio Marketplace downloads](https://badgen.net/vs-marketplace/d/Joouis.agent-maestro)](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro)
[![Visual Studio Marketplace rating](https://badgen.net/vs-marketplace/rating/Joouis.agent-maestro)](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro)

Use your preferred coding client with the GitHub Copilot models available in VS Code. Agent Maestro provides a local API bridge for Claude Code, Claude Desktop, Codex, Gemini CLI, DSH Desktop, CodeBuddy / WorkBuddy, and other compatible clients. Model requests use VS Code's Copilot connection and remain subject to your account's model access and usage limits.

For automation, Agent Maestro also exposes Roo Code tasks through REST and MCP: start work, follow progress, and respond to tool approvals from another application. Cline integration currently supports basic task creation.

![Claude Code setup](https://media.githubusercontent.com/media/Joouis/agent-maestro/main/assets/configure-claude-code-demo.gif)

## Features

- **Choose your client and model.** Connect through Anthropic Messages, OpenAI Chat Completions/Responses, or Gemini-compatible endpoints, with setup commands including DSH Desktop and CodeBuddy / WorkBuddy, and a picker of available Copilot models.
- **Work with tools and images.** Supported tool histories and image inputs are converted to VS Code messages. Ordinary client tools still execute in the client; AM does not run them on its behalf.
- **Search for current information.** Exa-backed search supports declared Anthropic/Responses web-search tools and experimental Codex standalone search, with source links and protocol-specific limits.
- **Configure longer conversations.** Claude Code and Codex setup uses the selected model's advertised context window. Streaming heartbeats keep supported clients connected while a response is pending.
- **Automate Roo tasks.** Use HTTP/SSE for task progress and interaction, or the MCP task tool for up to 20 concurrent tasks.
- **Inspect local usage.** Run **Agent Maestro: Open Usage Dashboard** for token/cache totals, latency, model and session breakdowns, and daily charts. No proxy or database service is required.

### Usage dashboard

The dashboard records model calls made through Agent Maestro's Anthropic, OpenAI, and Gemini generation endpoints, including individual rounds of hosted web search. It does not observe native Copilot Chat or other traffic that bypasses Maestro. Token and cache values come from provider usage metadata; missing usage is shown as unavailable, not zero or an invented cache saving. Reasoning tokens are a subset of output tokens. Cache hit rate is token-weighted over calls with reported cache counts; it is not a request hit rate or a billing estimate.

Collection is local and can be disabled with `agent-maestro.usage.enabled`. Records contain numeric usage, timing, model, endpoint, outcome, and bounded client/session identifiersâ€”no prompts, generated text, tool arguments, request bodies, credentials, or arbitrary headers. The extension stores a rotating JSONL journal in its VS Code global storage, retaining at most 30 days and approximately 100 MiB. The dashboard reads at most the newest 50,000 records. Each extension host writes a separate journal, so multiple windows do not overwrite one another. Remote extension hosts keep their own storage; use persistent volumes for dev containers.

Session IDs are taken from `x-agent-maestro-session-id`, Codex `session_id` / `session-id` / `thread-id`, or the model request's conversation/cache identifier. Clients can send `x-agent-maestro-session-name` explicitly. **Import Codex session names** lets you choose a `session_index.jsonl` metadata file; only ID/title pairs are imported, and no credentials or chat transcripts are read. Titles are optional metadata and may be sensitive. The dashboard never scans other extensions' private databases or reads names automatically. Native Copilot session names are not available through this integration.

Use preset or custom date ranges and model/session/client/outcome/cache filters. Pivot by model, model × cache hit/miss, session, client, endpoint, or input size. Switch hourly/daily trends between tokens, estimated USD, TTFT, latency, throughput, and cache percentage. The dashboard includes a TTFT histogram and TTFT-versus-uncached-input scatter. JSON/CSV exports contain the selected metrics, including estimate provenance. Statistics start when this version is activated; earlier traffic is not reconstructed. Calls rejected before a model is invoked are not counted.

**Performance measurements are observed at the VS Code model API boundary.** Time to first content (TTFT) starts before sendRequest and ends at the first nonempty text/tool chunk; usage metadata does not count as content. It includes queueing, network, provider buffering, and hidden reasoning, so it is not isolated prefill time. Output throughput is reported output tokens divided by full call duration for completed calls. Stream emission rate is output tokens divided by first-to-last content time, only for completed multi-chunk calls with explicitly reported zero reasoning tokens. It is an approximate delivery rate, not GPU decode throughput or per-token latency. A chunk may contain many tokens. Actual prefill/decode timing and inter-token latency require upstream telemetry; input tokens / TTFT would be misleading.

**Cache cohorts distinguish some cached input, explicitly zero cached input, and unknown.** Use model and input-size pivots when comparing cache-hit versus miss latency; aggregate differences do not establish that caching caused the speedup. Token-weighted hit rate and percentage of calls with any cache reads are shown separately. P50/P95/P99 latency and P50/P95 TTFT are calculated from individual eligible calls; missing values are excluded and coverage is displayed. Timing added by this version is unavailable for old journal entries.

**Dollar figures are API-equivalent estimates, not Copilot bills.** A bundled, dated LiteLLM public pricing snapshot provides exact-match standard text rates, including supported long-context thresholds and cache read/write rates. Set agent-maestro.usage.priceOverrides with per-million-token input, output, cacheRead, and cacheWrite rates for your BYOK pricing, or use agent-maestro.usage.priceAliases for explicit aliases. Example: { "my-model": { "input": 2, "output": 10, "cacheRead": 0.2 } }. No fuzzy model matching or credential access is used. Unknown models, missing cache counts, and inconsistent usage remain unpriced; totals show priced-call coverage. Missing cache-write counts are treated as zero. Rates are applied at view/export time, so changing them reprices retained history. Nonstandard service tiers, non-text modalities, search/tool fees, subscriptions, taxes, and provider-specific discounts are not inferred. Cache savings compare estimated input charges with all input charged at the uncached input rate; writes can make savings negative.

The UI uses local SVG charts without network resources. Provider calls are observed only through Maestro; native Copilot Chat traffic remains out of scope.

This README and the [documentation index](docs/README.md) describe this checkout. Features in pending `.changeset/` entries may not yet be available in the installed Marketplace release; check the [changelog](CHANGELOG.md) for released versions.

## Quick Start

### Prerequisites

- VS Code **1.120.0 or newer**, with GitHub Copilot signed in and eligible models available. The LLM proxy currently selects models from the `copilot` vendor.
- Install the client you want to use: Claude Code, Claude Desktop, Codex, or Gemini CLI. Installing a client alone does not provide proxy models.
- Install Roo Code or a compatible variant such as Kilo Code only if you need task orchestration. Cline is optional and currently supports task creation only.

For source development, use Node.js 22 or newer and the pnpm version specified in [package.json](package.json).

### 1. Install and Start the Proxy

Install [Agent Maestro from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro) or [Open VSX](https://open-vsx.org/extension/Joouis/agent-maestro).

Open your project in VS Code and keep that window running while using the client. The API server starts when Agent Maestro activates, normally at `http://127.0.0.1:23333`.

Run **Agent Maestro: Get API Server Status** from the Command Palette to confirm the server and active port. If it is stopped, run **Agent Maestro: Start API Server**. You do not need the separate MCP server for LLM proxy requests.

### 2. Configure Your Client

Open the Command Palette and run the relevant command:

| Client         | Command                                              | Configuration written                                                                             |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Claude Code    | **Agent Maestro: Configure Claude Code Settings**    | Choose `~/.claude/settings.json` or `<workspace>/.claude/settings.json`                           |
| Claude Desktop | **Agent Maestro: Configure Claude Desktop Settings** | Platform-specific `Claude-3p/configLibrary` gateway configuration                                 |
| Codex          | **Agent Maestro: Configure Codex Settings**          | `~/.codex/config.toml`                                                                            |
| Gemini CLI     | **Agent Maestro: Configure Gemini CLI Settings**     | Choose `~/.gemini/.env` or `<workspace>/.gemini/.env`, plus `settings.json` in the same directory |

For Claude Code, Codex, or Gemini CLI, choose a model from the picker. If the list is empty, check Copilot sign-in and model availability in VS Code before continuing. Claude Code and Gemini CLI also offer project settings when you want the configuration limited to this workspace.

If you have enabled AM's optional LLM API key, apply the [client authentication settings](#access-and-authentication) before the first request. Otherwise, the generated placeholder credentials are sufficient for the default local setup.

### 3. Get Your First Response

Start a fresh client session so it loads the new configuration. For CLI clients, use a terminal in the configured project directory:

| Client          | Start after configuration                            |
| --------------- | ---------------------------------------------------- |
| Claude Code CLI | Run `claude`                                         |
| Codex CLI       | Run `codex`                                          |
| Gemini CLI      | Run `gemini`                                         |
| Claude Desktop  | Fully quit and reopen the app, then start a new chat |

Send this small connectivity check:

```text
Reply with exactly AM_CONNECTED. Do not read files or use tools.
```

Look for the reply **and** the matching request in VS Code's **Output â†’ Agent Maestro** channel. AM logs an incoming request with its resolved model and a completion with token usage; this confirms the client used the proxy rather than another configured provider. The prompt is a smoke check, not a guarantee of exact model output.

Once connected, try a normal task such as explaining a function in your project. Requests consume model quota, and any tool approvals remain part of the client workflow. If the check fails, see [troubleshooting](#troubleshooting-and-diagnostics). Direct API users can use the [complete request examples](docs/llm-compatibility.md#request-examples).

### One-Click Setup for DSH / DSH Desktop

Run `Agent Maestro: Configure DSH Settings`, choose Desktop, a named CLI/Web profile, or legacy DSH, then choose the default model. **All proxy-supported models** are written to DSH's model catalog so you can switch models in Desktop's picker.

Desktop configuration uses `$DSH_HOME/profiles/desktop/cordis.patch.yml` (default `~/.dsh`); named profiles use their own directory. Cordis patches configure `llm-pi-ai` with `openai-completions` and the proxy's actual port, plus `agent-default-model`. Legacy mode writes `settings.yaml` with `openai-responses`.

Each model retains its ID and receives a pretty name, runtime image-input capability, positive advertised context limit, and known output limit. `maxInputTokens` is mapped conservatively to DSH's combined `contextWindow`; DSH reserves completion/headroom, so usable input may be smaller. Unknown limits are not guessed. API keys are referenced through `AGENT_MAESTRO_API_KEY`, not stored as secrets in YAML.

Existing files are backed up. Owned managed blocks are replaced without rewriting unrelated UI/MCP entries; conflicting extra target overrides or malformed markers require manual merging. For an unmanaged configuration, the existing document and suggested block open side by side. Replace/merge matching entries and preserve other providers; never append duplicate target IDs. Home-wide Cordis patches apply after profile patches.

Set the Maestro API key (or a nonempty placeholder when authentication is disabled) in the environment inherited by DSH. Keep VS Code's proxy running and start a new DSH session to use a changed default. Live model/search behavior depends on your Copilot account; DSH web search uses a separate configured search provider. See the [DSH setup guide](docs/dsh-setup.md) for examples, model-picker behavior, safe updates, and troubleshooting.

### One-Click Setup for CodeBuddy / WorkBuddy

Configure CodeBuddy / WorkBuddy to use VS Code's language models with a single command `Agent Maestro: Configure CodeBuddy / WorkBuddy Settings` via Command Palette.

You can choose between:

- **User Settings** (`~/.codebuddy/models.json` and `~/.workbuddy/models.json`): Personal global settings for all projects
- **Project Settings** (`<workspace>/.codebuddy/models.json` and `<workspace>/.workbuddy/models.json`): Project-specific settings

This automatically creates or updates both `.codebuddy/models.json` and `.workbuddy/models.json` with all proxy-eligible VS Code chat models, each routed to Agent Maestro's OpenAI-compatible endpoint. Only the `models` array is written â€” `availableModels` is intentionally **not** written, so the host app's built-in models stay selectable (writing it as a whitelist of only these custom IDs would hide the built-in models). Capability flags such as `supportsToolCall` and `supportsImages` are derived from the model metadata returned by the VS Code LM API/Copilot runtime:

```json
{
  "models": [
    {
      "id": "gpt-5.5",
      "name": "GPT-5.5 (Agent Maestro)",
      "vendor": "OpenAI",
      "apiKey": "Powered by Agent Maestro",
      "maxInputTokens": 272000,
      "url": "http://127.0.0.1:23333/api/openai/v1/chat/completions",
      "supportsToolCall": true,
      "supportsImages": true
    },
    {
      "id": "claude-sonnet-4",
      "name": "Claude Sonnet 4 (Agent Maestro)",
      "vendor": "OpenAI",
      "apiKey": "Powered by Agent Maestro",
      "maxInputTokens": 200000,
      "url": "http://127.0.0.1:23333/api/openai/v1/chat/completions",
      "supportsToolCall": true,
      "supportsImages": true
    }
  ]
}
```

## Web Search

Search is available when a supported client requests it. AM does not add search to every prompt.

| Client/API path    | How it is enabled                                                                        | What to expect                                                         |
| ------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Anthropic Messages | Client declares `web_search_20250305` and the model selects it                           | At most one search per request; final text with source links           |
| OpenAI Responses   | Client declares stable `web_search` and the model selects it                             | At most one search per request; hosted-search events and URL citations |
| Codex standalone   | **Configure Codex Settings** enables the experimental feature for supported CLI versions | Up to four search queries plus page `open` and `find` operations       |

After configuring a supported Codex release, try asking it to find a recent release announcement and cite its sources. An existing `web_search = "disabled"` setting is preserved; change it to `"live"` if you want to enable search.

Searches can use Exa's anonymous allowance, including domain, recency, country, and cache-only constraints on standalone search. No Exa API key is required; anonymous access remains subject to Exa's rate limits. Run **Agent Maestro: Set Exa API Key** to use your Exa account. Queries and retrieved page URLs are sent to Exa, whose usage limits and billing are separate from Copilot.

These paths have different contracts: Gemini has no hosted-search integration here, and not every native search option or Codex web command is supported. See [search compatibility and supported Codex versions](docs/llm-compatibility.md#web-search).

## Models and Context Windows

- **Claude Code:** Setup writes the selected model's compaction window and defaults the compaction threshold to 85% unless you already set one. For the supported 1M tier, it adds the client-side `[1m]` marker.
- **Codex:** Setup writes `model_context_window` from the selected model's advertised `maxInputTokens`.

AM prefers Copilot-provided usage metadata when available and estimates token counts otherwise. A local estimate can differ from provider usage; see [context-window handling](docs/claude-code-context-window.md) for the exact configuration and limits.

Run **Agent Maestro: Select Fallback Model** to choose a model for requests whose model ID cannot be matched. Exact and fuzzy matches take priority. Selecting `auto` leaves automatic model selection in effect; unavailable models can fall back to another available Copilot model.

`GET /api/v1/lm/chatModels` lists models discovered by VS Code, including vendors that may not be proxy-eligible. The Output channel distinguishes eligible Copilot models.

## Configuration

Use VS Code settings for the following options. Port and default-Roo settings can be set per workspace; the other settings have application scope.

| Setting                                     | Default                      | Purpose                                             |
| ------------------------------------------- | ---------------------------- | --------------------------------------------------- |
| `agent-maestro.proxyServerPort`             | `23333`                      | Proxy HTTP port                                     |
| `agent-maestro.mcpServerPort`               | `23334`                      | MCP port                                            |
| `agent-maestro.defaultRooIdentifier`        | `rooveterinaryinc.roo-cline` | Default Roo-compatible extension                    |
| `agent-maestro.rooVariantIdentifiers`       | `["kilocode.kilo-code"]`     | Additional Roo variants to discover                 |
| `agent-maestro.fallbackModelId`             | `""`                         | Fallback model; configure through the command above |
| `agent-maestro.allowOutsideWorkspaceAccess` | `false`                      | Permit filesystem access outside the workspace      |

`AGENT_MAESTRO_PROXY_PORT` and `AGENT_MAESTRO_MCP_PORT` environment variables override the corresponding settings. Restart the extension host after changing ports or extension identifiers.

### Roo/Kilo and MCP Setup

The MCP server normally uses port `23334` and requires the configured default Roo extension to provide a task manager. If only Kilo Code is installed, set `agent-maestro.defaultRooIdentifier` to `kilocode.kilo-code` and reload VS Code before starting MCP. HTTP task requests can also select an installed variant explicitly with `extensionId`.

**Install MCP Configuration** currently writes `http://localhost:23334/mcp` regardless of the configured port. If you use a custom MCP port, update that URL in the generated client configuration manually after installation.

### Gemini Settings and Existing Overrides

The configurator writes `GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, and `GEMINI_TELEMETRY_ENABLED=false` to the chosen `.gemini/.env`, preserving an existing API key. It also sets `security.auth.selectedType` to `gemini-api-key` in the adjacent `settings.json`.

The configurator warns about a workspace-root `.env` that can override user settings. If Gemini still connects to an old endpoint, check that file and the launching environment as well as `.gemini/.env`.

## Access and Authentication

Authentication is disabled by default. **Agent Maestro: Set LLM API Key** stores an optional key in VS Code SecretStorage; an empty value disables it again. Generated placeholder client keys do not configure the server key. When authentication is enabled, configure the same key in your client, using:

| Route prefix       | Header                        |
| ------------------ | ----------------------------- |
| `/api/anthropic/*` | `x-api-key: <key>`            |
| `/api/openai/*`    | `Authorization: Bearer <key>` |
| `/api/gemini/*`    | `x-goog-api-key: <key>`       |

See [complete request examples](docs/llm-compatibility.md#request-examples).

### Claude Code with Authentication Enabled

Set `ANTHROPIC_API_KEY` in the chosen settings file's `env` section and remove `ANTHROPIC_AUTH_TOKEN` there and from the launching environment. AM requires `x-api-key`; the configurator's `ANTHROPIC_AUTH_TOKEN` sends a bearer header instead. Keep `ANTHROPIC_BASE_URL` pointing to AM. Rerunning the configurator can reintroduce the token setting, so recheck these fields afterward. See Claude Code's [gateway authentication guidance](https://code.claude.com/docs/en/llm-gateway-rollout).

### Remote Access

The HTTP server listens on a wildcard address. **The LLM key does not protect `/api/v1` task, file, or workspace operations, or the separate MCP server.** Before making either port accessible beyond a trusted local environment, put authenticated access controls in front of it. CORS is not an access-control substitute; AM currently allows cross-origin browser requests. See the [remote demo requirements](examples/demo-site/README.md#remote-access).

## API and Commands

The default HTTP origin is `http://127.0.0.1:23333`. Inspect the running instance's [`/openapi.json`](http://127.0.0.1:23333/openapi.json) for routes and schemas; use the compatibility guides for supported protocol behavior and limits.

| Interface               | Paths                                                                                               | Reference                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Anthropic               | `/api/anthropic/v1/messages`, `/api/anthropic/v1/messages/count_tokens`, `/api/anthropic/v1/models` | [LLM compatibility](docs/llm-compatibility.md#endpoints)       |
| OpenAI                  | `/api/openai/v1/chat/completions`, `/api/openai/v1/responses`                                       | [Responses compatibility](docs/openai-responses-api-design.md) |
| Gemini                  | `/api/gemini/v1beta/models/{model}:generateContent`, `:streamGenerateContent`, `:countTokens`       | [LLM compatibility](docs/llm-compatibility.md#endpoints)       |
| Codex standalone search | `/api/openai/v1/alpha/search`                                                                       | [Search compatibility](docs/llm-compatibility.md#web-search)   |
| Roo and Cline           | `/api/v1/roo/*`, `/api/v1/cline/task`                                                               | [Roo HTTP/SSE](docs/roo-routes-events.md)                      |
| Model discovery         | `/api/v1/lm/chatModels`, `/api/v1/lm/tools`                                                         | Running OpenAPI document                                       |

Use these Command Palette actions to manage the extension:

- **Agent Maestro: Start API Server**, **Stop API Server**, **Restart API Server**, **Get API Server Status**.
- **Agent Maestro: Start MCP Server**, **Stop MCP Server**, **Get MCP Server Status**, **Install MCP Configuration**.
- **Agent Maestro: Get Extensions Status**.
- **Agent Maestro: Set Exa API Key** to configure or clear an optional search-provider key.

## Troubleshooting and Diagnostics

| Symptom                                       | First check                                                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection refused                            | Keep the VS Code window open; check **Get API Server Status** and the client's configured port.                                                                                  |
| No models in the setup picker                 | Check Copilot sign-in, model access, and model-discovery messages in AM Output.                                                                                                  |
| HTTP 401                                      | Match the server key and provider-specific header; see the Claude Code authentication note above.                                                                                |
| Client answers but AM has no matching request | Start a new client session and inspect its active provider/base URL and project/environment overrides.                                                                           |
| MCP unavailable with Kilo                     | Select Kilo as the default Roo extension and reload; check the generated MCP URL for custom ports.                                                                               |
| GPT requests always show `cache_read: 0`      | On VS Code 1.139, upgrade to 1.140 or set `github.copilot.chat.responsesApi.promptCacheBreakpoint.enabled` to `false`; see [GPT prompt cache](docs/copilot-gpt-prompt-cache.md). |

Start with the **Agent Maestro** Output channel. Supported LLM request failures also append diagnostics to a timestamped `*-debug.log` in the first workspace folder when file logging succeeds; the error response includes the path when available.

**Review every log before sharing it.** Known Anthropic message fields are redacted in diagnostic files, but system prompts, tool definitions, unknown fields, and error details can remain. Raw OpenAI/Gemini request bodies are not redacted. Debug-level Output logs are a separate channel and can contain request or response content. See the [logging scope](docs/llm-compatibility.md#diagnostic-logs).

## Development and Further Reading

- [Documentation index](docs/README.md): current guides, runbooks, and dated design records.
- [Testing guide](docs/testing.md) and [contributor instructions](AGENTS.md).
- [Roo extension API notes](docs/roo-code/README.md) and [remote demo](examples/demo-site/README.md).
- [Changelog](CHANGELOG.md), including migration details for older versions.

Potential future work includes code-server deployment support, richer orchestration for Claude Code/Codex, and task scheduling. These are roadmap items, not supported interfaces.

[Report a bug or request a feature](https://github.com/Joouis/agent-maestro/issues).

## License

[MIT](LICENSE).
