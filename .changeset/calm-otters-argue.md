---
"agent-maestro": patch
---

Stop writing the `availableModels` whitelist into CodeBuddy / WorkBuddy `models.json`. Previously the configurator set `availableModels` to only the Agent Maestro-proxied model IDs, which made the host app hide all of its built-in models (the field acts as a strict allowlist during model resolution). The configurator now writes only the `models` array and strips any pre-existing `availableModels` entry, so built-in models stay selectable alongside the custom Agent Maestro models.
