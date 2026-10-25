# DSH / DSH Desktop setup

## Connect and choose models

1. Keep VS Code running with a language-model provider authorized (for example GitHub Copilot) and Agent Maestro's API server started.
2. Run **Agent Maestro: Configure DSH Settings**. Choose **DSH Desktop**, a named **DSH CLI / Web Profile**, or **Legacy DSH**.
3. For modern profiles, choose the default model. Setup refreshes VS Code model metadata and writes **all proxy-supported models**, not only the default. Legacy mode exports the provider catalog but does not persist an agent-default override; select the default in the legacy client separately. Switch among those models in DSH Desktop's model picker.
4. Supply `AGENT_MAESTRO_API_KEY` in the environment inherited by DSH. Use the key configured in Agent Maestro, or a nonempty placeholder if proxy authentication is disabled. No literal secret is written to the patch.
5. Start a new DSH session to use a changed default. Existing sessions can retain their logged model. If configuration does not refresh, fully quit/reopen DSH.

DSH and VS Code must reach the same loopback endpoint. For remote VS Code, forward the proxy port to the Desktop machine first; a remote host's `127.0.0.1` is not your local machine.

## Files and formats

| Target                | Configuration                                   |
| --------------------- | ----------------------------------------------- |
| Desktop               | `$DSH_HOME/profiles/desktop/cordis.patch.yml`   |
| Named CLI/Web profile | `$DSH_HOME/profiles/<profile>/cordis.patch.yml` |
| Legacy installation   | `$DSH_HOME/settings.yaml`                       |

`DSH_HOME` defaults to `~/.dsh`. Choose the actual profile name for your CLI/Web launch. Modern profiles use a top-level Cordis patch array with `openai-completions`; legacy mode retains the older mapping-style `settings.yaml` and `openai-responses` format.

Minimal modern example (the configurator writes every supported model, with actual metadata):

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      agent-maestro:
        displayName: "Agent Maestro"
        apiKeyEnv: AGENT_MAESTRO_API_KEY
        api: openai-completions
        baseURL: "http://127.0.0.1:23333/api/openai/v1/"
        models:
          - id: "gpt-6.1-sol"
            name: "GPT-6.1 Sol (Agent Maestro)"
            contextWindow: 921793
            input:
              - text
              - image
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: agent-maestro
    model: "gpt-6.1-sol"
```

The example's ID, limits and image capability are illustrative. Only models reported by your VS Code runtime are exported. The proxy's actual port replaces `23333` when configured differently.

## Model metadata

- Copilot IDs are preserved unless they occupy the reserved qualified prefix. Other vendors receive stable qualified route IDs to distinguish identical raw IDs. Display names receive ` (Agent Maestro)` once, with vendor/internal-alias detail where needed.
- Runtime `maxInputTokens` becomes a **conservative** DSH `contextWindow`. DSH defines this as combined request/response capacity and reserves output/headroom during compaction; usable prompt capacity can be smaller. Setup does not invent a larger physical context limit.
- A known positive `maxOutputTokens` becomes DSH `maxTokens`, which is both an output cap and an explicit default request output allowance. Unknown limits are omitted.
- `imageInput` or `supportsImageToText` enables `[text, image]`; missing/false capability uses `[text]`. Declaring vision does not prove the hosted model accepts an actual image request.
- Reasoning levels and unrelated provider options are not guessed from incomplete metadata.

## Existing configuration and safe updates

Setup backs up existing files before writing. A single managed block bounded by Agent Maestro markers can be replaced while preserving unrelated UI/MCP patches outside it. Additional provider/default-model overrides, malformed markers, or unsupported surrounding layouts stop automatic updates.

An existing **unmanaged** patch is not overwritten: setup opens it next to a suggested block. Merge/replace matching `llm-pi-ai` and `agent-default-model` entries; do not append duplicate IDs. Cordis replaces entire plugin configs, so retain other providers inside `llm-pi-ai.config` and keep your other patch entries intact.

Home-wide `$DSH_HOME/cordis.patch.yml` applies after the profile patch and may override it. Inspect that layer if the selected catalog/default appears ignored. Changes made while the model picker is open are detected rather than overwritten.

## Web search is separate

The chat proxy does not automatically provide DSH's `web_search`. DSH executes that tool through its own search provider. Stock DeepSeek search requires a DeepSeek API key for an Agent Maestro conversation; account-based search applies to DeepSeek Account conversations. Configure DSH's **Plugins → Web search**, or install/configure an alternative backend. Public-URL `web_fetch` is separate and does not discover URLs.

## Troubleshooting

- **No available models:** check the selected provider's sign-in/authorization and VS Code model availability. Other vendors use qualified route IDs rather than their raw IDs; a registry entry does not guarantee the endpoint can complete a request.
- **Only one model appears:** rerun setup with this version; it exports the complete eligible catalog. For an unmanaged file, perform the suggested merge.
- **Managed-block conflict:** keep exactly one start/end marker pair and remove additional overrides of the same target IDs only after reviewing what they configure. Never delete unrelated UI/MCP settings to silence the warning.
- **Authentication failure:** check the key configured in Agent Maestro and the key reference inherited by DSH; do not use a search-provider key as the Maestro key.
- **Image request failure:** verify the selected runtime model advertises vision and inspect proxy diagnostics. Configuration tests are not a live vision test.

References: [DSH provider guide](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/guide/providers.md), [pi-ai adapter](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/llm/llm-pi-ai), and [Agent Maestro testing guide](testing.md).
