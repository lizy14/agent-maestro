# Pricing source

The bundled numeric rate table was transcribed from GitHub's official **Models and pricing for GitHub Copilot** documentation:
https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing

Retrieved 2026-10-21. The source page SHA-256 is recorded in prices.json.
Rates are USD per million tokens. GitHub documents one AI credit as $0.01 USD.
Long-context thresholds and published promotional end dates are retained.
Only numeric rates and model identifiers are included; no credentials are used.

VS Code's languageModelPricing proposal exposes optional AI-credit rates, but
these are not a stable public API in the extension's supported VS Code typings.
The extension therefore uses this dated fallback, with explicit user overrides
and aliases taking precedence. Unknown models remain unpriced. Legacy premium
request plans, auto-selection discounts, included allowances, and actual invoice
charges cannot be inferred from these observations.
