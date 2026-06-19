---
"agent-maestro": patch
---

Add a new `Agent Maestro: Configure CodeBuddy / WorkBuddy Settings` command that creates or updates both `.codebuddy/models.json` and `.workbuddy/models.json` (user-level or project-level) to route CodeBuddy / WorkBuddy model calls through Agent Maestro's OpenAI-compatible `/api/openai/v1/chat/completions` endpoint.
