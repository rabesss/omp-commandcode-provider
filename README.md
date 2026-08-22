# omp-commandcode-provider

A dependency-free [OMP](https://github.com/can1357/oh-my-pi) extension for using
[Command Code](https://commandcode.ai) subscription/API-key models from `omp`.

This project is an OMP adaptation of
[ninehills/pi-commandcode-provider](https://github.com/ninehills/pi-commandcode-provider).
It preserves Command Code's authenticated CLI transport, streaming, tool calls,
thinking blocks, abort handling, browser-assisted login, and model registry,
while using OMP's native extension API and install layout.

This is an unofficial, community-maintained extension. It is not affiliated
with or endorsed by Command Code.

## Security And Dependencies

- Runtime dependencies: **none**.
- Install-time dependencies: **none**. Install by cloning source into OMP's
  native extension directory; do not run `npm install`.
- Runtime imports are only tracked local source files, `models.json`, and Node
  built-ins. Its OMP `ExtensionAPI` import is type-only and erased at runtime.
- It does not contain an API key. Prefer OMP's interactive `/login` flow,
  which stores the credential in OMP's permission-restricted `agent.db` auth
  store. `COMMAND_CODE_API_KEY` remains available for headless environments.
- `models.json` is committed source data rather than fetched or executed during
  installation.

## Go Plan Transport Boundary

The $1 **Go** plan includes Command Code CLI usage, but Command Code documents
Provider API access as a separate Provider plan. This adapter therefore sends
generation requests through the same authenticated internal CLI endpoint,
`/alpha/generate`, using the user's existing Command Code token. It does not
send inference requests to `/provider/v1` and does not require a custom API.

The public `/provider/v1/models` endpoint is used only by the opt-in development
drift check. The internal generation endpoint is unofficial and may change in a
future Command Code release, so compatibility is pinned and tested against
Command Code CLI 1.32.1.

## Install

Clone the extension source locally:

```sh
mkdir -p ~/.omp/agent/extensions
git clone https://github.com/rabesss/omp-commandcode-provider.git \
  ~/.omp/agent/extensions/omp-commandcode-provider
```

Then add the verified explicit extension path to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/.omp/agent/extensions/omp-commandcode-provider
```

OMP also documents native package-directory discovery through the included
`omp.extensions` manifest, but the explicit entry is the reliable installation
path tested against OMP 17.4.2.

No package-manager install or build step is required. Restart `omp`, then verify
registration:

```sh
omp models commandcode
```

To update:

```sh
git -C ~/.omp/agent/extensions/omp-commandcode-provider pull --ff-only
```

### Alternative Checkout Path

If you prefer to keep the checkout elsewhere, use that absolute directory in
the same `extensions` setting:

```yaml
extensions:
  - /path/to/omp-commandcode-provider
```

## Authentication

### API Key

For headless environments, create or edit `~/.omp/agent/.env`:

```sh
mkdir -p ~/.omp/agent
printf '%s\n' 'COMMAND_CODE_API_KEY=user_...' >> ~/.omp/agent/.env
chmod 600 ~/.omp/agent/.env
```

Do not commit that file or paste real credentials into issues.
`COMMANDCODE_API_KEY` remains accepted as a legacy alias; the canonical current
Command Code variable takes precedence when both are set. A credential saved by
OMP's `/login` flow takes precedence over either environment fallback.

### Browser-Assisted Login

In interactive OMP, run:

```text
/login
```

Select **Command Code**. The extension opens Command Code Studio and accepts a
one-time `localhost` callback on a listener bound to `127.0.0.1`, matching the
current CLI contract and CSRF state. Current callback identity metadata is
preserved when present; the prior `{apiKey,state}` shape remains accepted for
compatibility. Wrong-state callbacks are rejected before any success response.
If automatic callback transfer is unavailable, it prompts for the API key from
the browser after the CLI-compatible two-minute window. OMP 17 accepts the
returned API key directly and stores it in `~/.omp/agent/agent.db`. Older
OAuth-shaped saved credentials remain readable for compatibility. The provider
uses OMP's saved credential even when a stale Command Code key remains in
`~/.omp/agent/.env`. When OMP still contains older OAuth-shaped Command Code
rows, the most recently pasted login API key is pinned in memory for the
request; the extension does not rewrite or delete the credential database.

When the browser cannot reach loopback callbacks in a known environment, set
`COMMANDCODE_AUTH_TIMEOUT_MS` to a shorter positive millisecond value to reach
the manual paste fallback sooner.

The provider also retains the original compatibility fallback for
`~/.commandcode/auth.json` and legacy `~/.pi/agent/auth.json` credential files.
Its manifest retains `pi.extensions` as a compatibility alias in addition to
the OMP-native `omp.extensions` declaration.

## Usage

Use a qualified OMP model selector:

```sh
omp --model commandcode/gpt-5.4
omp -p --model commandcode/deepseek/deepseek-v4-flash "Reply briefly."
```

Do not use `--provider commandcode`: OMP resolves extension-defined providers
through qualified `--model commandcode/<model-id>` selectors.

## Models

The committed registry matches the 58 models currently exposed by the Command
Code Provider API and the reviewed Command Code CLI 1.32.1 catalog:

| Family | Model IDs |
| --- | --- |
| Anthropic | `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-haiku-4-5-20251001` |
| OpenAI | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.4-mini` |
| DeepSeek | `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-flash-vision-exp` |
| Moonshot | `moonshotai/Kimi-K3`, `moonshotai/Kimi-K2.7-Code`, `moonshotai/Kimi-K2.7-Code-Highspeed`, `moonshotai/Kimi-K2.6`, `moonshotai/Kimi-K2.5` |
| Z.AI | `zai-org/GLM-5.3`, `zai-org/GLM-5.2`, `zai-org/GLM-5.2-Fast`, `zai-org/GLM-5.1`, `zai-org/GLM-5` |
| MiniMax | `MiniMaxAI/MiniMax-M3`, `MiniMaxAI/MiniMax-M2.7`, `MiniMaxAI/MiniMax-M2.5` |
| Qwen | `Qwen/Qwen3.8-Max`, `Qwen/Qwen3.8-27B`, `Qwen/Qwen3.7-Max`, `Qwen/Qwen3.7-Plus`, `Qwen/Qwen3.7-Flash`, `Qwen/Qwen3.6-Max-Preview`, `Qwen/Qwen3.6-Plus` |
| StepFun | `stepfun/Step-3.7-Flash`, `stepfun/Step-3.5-Flash` |
| Xiaomi | `xiaomi/mimo-v2.5-pro`, `xiaomi/mimo-v2.5` |
| Tencent | `tencent/hy3-paid` |
| Google | `google/gemini-3.7-flash`, `google/gemini-3.6-flash`, `google/gemini-3.5-flash`, `google/gemini-3.5-flash-lite`, `google/gemini-3.1-flash-lite` |
| Sakana | `sakana/fugu-ultra` |
| NVIDIA | `nvidia/nemotron-3-ultra-550b-a55b` |
| Thinking Machines | `thinkingmachines/inkling`, `thinkingmachines/inkling-small` |
| Stealth | `stealth/ox-alpha` |
| Poolside | `poolside/laguna-s-2.1-free` |
| Meta | `meta/muse-spark-1.1`, `meta/muse-spark-1.2`, `meta/muse-spark-1.2-contributor` |
| xAI | `xai/grok-4.5`, `xai/grok-4.6` |

The pricing/limits docs currently contain 61 rows: all 58 API models, one active
docs-only model (`claude-opus-4-6`), and two deprecated models
(`ling-3.0-flash-free` and `claude-sonnet-4-5`). The extension never registers
docs-only or deprecated rows automatically. Exactly 36 of the 58 API models are
currently listed for Individual Go.

The extension preserves all 58 API models instead of filtering by account plan,
because plan access can change independently of a release. Models outside Go
are marked in the committed descriptions, and a recognizable upstream
plan-entitlement error gains an Individual Go hint. Command Code remains the
authority on actual account access.

### Catalog Sources And Automatic Fields

`models.json` is an offline reviewed snapshot with explicit source boundaries:

- Provider API: exact live IDs, display names, context windows, and ordering.
- Pricing/limits docs: plan availability, text/vision/reasoning flags, input and
  output rates, cache-read and five-minute cache-write rates, tier boundaries,
  deals, future price notes, and deprecation state.
- Command Code CLI 1.32.1: maximum output, reasoning-effort choices, input
  modalities, descriptions, and vendor/provider labels. These fields remain
  manual because the CLI exposes no supported rich catalog endpoint.
- Reviewed conflict records: source disagreements and their dated decision.

This means source-exposed fields can be checked and proposed automatically.
New models are report-only until every CLI-only rich field has been reviewed;
the maintenance command never invents them or mutates `models.json`.

OMP accepts one flat cost per token dimension. The extension therefore uses the
first documented tier. Permanent/current deal rates are reflected, while a
date-bounded deal uses its first-tier list rate so the committed estimate does
not silently expire. Time-of-day prices use the documented peak rate so the
single OMP estimate never understates a possible charge. A missing cache
dimension is stored as unsupported rather than as a source price of zero. These
are advisory estimates only; tiers, deals, and the final bill remain
authoritative in Command Code Studio Usage.

The extension applies two runtime metadata corrections without altering the
audited registry: `gpt-5.3-codex` is exposed with a `272K` usable input
context because its `128K` output budget is separate in OMP, and the DeepSeek
models are exposed with `200K` maximum output because the Command Code gateway
currently rejects larger `max_tokens` requests.

The provider also registers vision-capable models with `["text", "image"]`
modalities so OMP can route image-enabled tasks (for example `inspect_image`)
to models that support vision in the Command Code CLI catalog. For those models,
user image blocks are serialized to Command Code's current `{ type: "image",
image: "data:<mime>;base64,...", mimeType: "<mime>" }` wire format; text-only
models keep a placeholder instead of silently dropping attachments.

Check both public sources without installing or executing npm package contents:

```sh
npm run models:check
npm run models:proposal
node --test tests/test-model-catalog.ts tests/test-model-registry.ts
```

`models:check` is read-only and distinguishes catalog drift, transient network
failure, and structural extraction failure. It validates both the Provider API
and the official pricing page against strict shape/count/mapping invariants.
`models:proposal` emits a deterministic old/new report with
`writesPerformed: false`; it does not update the runtime catalog. The weekly
workflow uses the same read-only check.

## Features

- Streaming text responses and reasoning/thinking blocks.
- Live reasoning deltas, explicit terminal-event validation, and truncated-stream
  detection.
- OMP tool-call serialization and tool-result round trips.
- OMP 17 JSON Schema forwarding, including callable schemas, `$defs`, `$ref`,
  unions, descriptions, and constraints.
- OMP temperature, reasoning effort, session ID, first-event timeout, and idle
  timeout options.
- Request cancellation and stream cleanup.
- Bounded transient retries only before provider content is observed; API keys
  are redacted from surfaced HTTP and stream errors.
- Command Code usage/cost reporting from the included model registry.
- API-key environment authentication.
- Browser-assisted `/login` with localhost callback, CSRF state validation, and
  manual key fallback.
- Optional request/response payload hooks retained from the upstream provider.

## Development And Verification

Installing the extension does not require these commands. Contributors can run
the test suite with Node.js 22.18 or newer, which provides unflagged
`node:sqlite` support and executes TypeScript by default without installing a
transpiler:

```sh
node --version
node --test tests/test-pure-functions.ts tests/test-oauth.ts \
  tests/test-abort.ts tests/test-stream.ts tests/test-retry.ts \
  tests/test-model-catalog.ts tests/test-model-registry.ts
OMP_BIN="$(command -v omp)" node tests/test-omp-local.mjs
```

`tests/test-omp-local.mjs` starts a local mock Command Code endpoint and
exercises the actual `omp` binary in both print and RPC modes without sending a
credential to Command Code. With the existing Command Code credential, run the
live smoke test explicitly. The direct adapter test reads the existing enabled
OMP credential without printing it, pins the free Laguna model, caps output at
eight tokens, and validates stream completion plus usage. The OMP-level test is
also pinned to Laguna and will reject model overrides rather than risk a billed
fallback. Command Code can still reject the free model for capacity or account
state.

```sh
npm run test:live
```

## Compatibility Sources

- [OMP v17.4.2](https://github.com/can1357/oh-my-pi/releases/tag/v17.4.2)
- [Command Code changelog](https://commandcode.ai/docs/resources/changelog)
- [Command Code pricing and plan limits](https://commandcode.ai/docs/resources/pricing-limits)
- Command Code CLI 1.32.1's generated model reference and public changelog.

## License

MIT. This adaptation retains the upstream MIT-licensed implementation and
credits the original provider above.
