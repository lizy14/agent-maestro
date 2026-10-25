# Client model catalogs: investigation

Investigated official documentation/source on 2026-10-11. This PR updates existing DSH, CodeBuddy and WorkBuddy catalogs only; the three clients below are not reconfigured.

## Claude Code

Current official docs support a user-scoped list through `modelPicker.options` with `model`, `label`, `description`, and optional `behavesAs`. `modelPicker` requires v2.1.242+; `behavesAs` requires v2.1.257+. User/managed/`--settings` scopes are supported, not project/local scopes. `replaceBuiltInOptions` can hide built-ins and discovered rows, so it must not be enabled casually.

Optional dynamic gateway discovery uses `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` with a custom `ANTHROPIC_BASE_URL`; it requests `/v1/models?limit=1000` at startup. IDs must contain `claude` or `anthropic`. A custom single-model environment option is not the only list mechanism. Agent Maestro's Anthropic model endpoint exposes Claude-family models, but support depends on the installed client version and authentication configuration.

Sources: [picker settings](https://code.claude.com/docs/en/settings-reference.md#modelpicker), [gateway discovery protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md#model-discovery), [custom model option](https://code.claude.com/docs/en/model-config.md#add-a-custom-model-option).

## Codex CLI

Verified stable `rust-v0.162.1` supports `model_catalog_json` (absolute local path, startup catalog) and a provider-specific `model_catalog_url` (full URL). A custom inference `base_url` alone does not discover an ordinary OpenAI `/v1/models` list.

The catalog is Codex-native `{models: [...]}`, not OpenAI `{data: [...]}`. It requires rich validated operational metadata: slugs, display names, visibility, reasoning capabilities, truncation/tool behavior and base instructions or an instruction template. Inventing those from VS Code's model ID/context alone would be unsafe. A separate optional export/native catalog adapter is feasible but needs version-specific schema and capability validation. Explicit catalogs take priority over bundled fallback data.

Sources: [released schema](https://raw.githubusercontent.com/openai/codex/rust-v0.162.1/codex-rs/core/config.schema.json), [catalog endpoint](https://raw.githubusercontent.com/openai/codex/rust-v0.162.1/codex-rs/model-provider/src/models_endpoint.rs), [native catalog fields](https://raw.githubusercontent.com/openai/codex/rust-v0.162.1/codex-rs/protocol/src/openai_models.rs).

## Gemini CLI

Verified stable `v0.63.0` supports opt-in `experimental.dynamicModelConfiguration` and `modelConfigs.modelDefinitions`, keyed by model/alias ID. Visible custom entries can provide `displayName`, `tier: custom`, `isVisible: true`, description and capability flags. Optional ID resolutions map aliases to actual Gemini-protocol model IDs.

Here “dynamic” means a settings-driven registry, not verified gateway auto-discovery. With the flag disabled the legacy picker remains built-in. `GEMINI_MODEL` alone selects a default; it does not populate a registry. A version-checked explicit registry export is feasible as a separate feature, requiring opt-in because it is experimental. The gateway must still implement Gemini wire protocol.

Sources: [released settings schema](https://raw.githubusercontent.com/google-gemini/gemini-cli/v0.63.0/packages/cli/src/config/settingsSchema.ts), [model service](https://raw.githubusercontent.com/google-gemini/gemini-cli/v0.63.0/packages/core/src/services/modelConfigService.ts), [picker](https://raw.githubusercontent.com/google-gemini/gemini-cli/v0.63.0/packages/cli/src/ui/components/ModelDialog.tsx).

## Conclusion

All three can expose custom lists in current releases, but their formats and discovery behavior differ. The existing Maestro configurators still write a selected default. This PR deliberately does not add those exports or overwrite their settings. A future follow-up can add explicit version-aware opt-ins rather than pretending a generic models endpoint populates every client.
