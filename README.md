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
- It does not contain an API key. Keep `COMMAND_CODE_API_KEY` in
  `~/.omp/agent/.env`, which should be permission mode `600`, or use OMP's
  interactive login flow.
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
Command Code CLI 1.14.1.

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
path tested against OMP 17.2.10.

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

Create or edit `~/.omp/agent/.env`:

```sh
mkdir -p ~/.omp/agent
printf '%s\n' 'COMMAND_CODE_API_KEY=user_...' >> ~/.omp/agent/.env
chmod 600 ~/.omp/agent/.env
```

Do not commit that file or paste real credentials into issues.
`COMMANDCODE_API_KEY` remains accepted as a legacy alias; the canonical current
Command Code variable takes precedence when both are set.

### Browser-Assisted Login

In interactive OMP, run:

```text
/login
```

Select **Command Code**. The extension opens Command Code Studio and accepts a
one-time `127.0.0.1` callback matching its loopback listener and CSRF state;
wrong-state callbacks are rejected before any success response. If automatic
callback transfer is unavailable, it prompts for the API key from the browser
after 15 seconds. OMP 17 accepts the returned API key directly. Older
OAuth-shaped saved credentials remain readable for compatibility.

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

The committed registry matches the active Command Code Provider API list and
Command Code CLI 1.14.1 catalog checked for this adaptation and exposes all 52
active entries:

| Family | Model IDs |
| --- | --- |
| Anthropic | `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-haiku-4-5-20251001` |
| OpenAI | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.4-mini` |
| DeepSeek | `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash` |
| Moonshot | `moonshotai/Kimi-K3`, `moonshotai/Kimi-K2.7-Code`, `moonshotai/Kimi-K2.7-Code-Highspeed`, `moonshotai/Kimi-K2.6`, `moonshotai/Kimi-K2.5` |
| Z.AI | `zai-org/GLM-5.2`, `zai-org/GLM-5.2-Fast`, `zai-org/GLM-5.1`, `zai-org/GLM-5` |
| MiniMax | `MiniMaxAI/MiniMax-M3`, `MiniMaxAI/MiniMax-M2.7`, `MiniMaxAI/MiniMax-M2.5` |
| Qwen | `Qwen/Qwen3.8-Max`, `Qwen/Qwen3.7-Max`, `Qwen/Qwen3.7-Plus`, `Qwen/Qwen3.7-Flash`, `Qwen/Qwen3.6-Max-Preview`, `Qwen/Qwen3.6-Plus` |
| StepFun | `stepfun/Step-3.7-Flash`, `stepfun/Step-3.5-Flash` |
| Xiaomi | `xiaomi/mimo-v2.5-pro`, `xiaomi/mimo-v2.5` |
| Tencent | `tencent/hy3-paid` |
| Google | `google/gemini-3.6-flash`, `google/gemini-3.5-flash`, `google/gemini-3.5-flash-lite`, `google/gemini-3.1-flash-lite` |
| Sakana | `sakana/fugu-ultra` |
| NVIDIA | `nvidia/nemotron-3-ultra-550b-a55b` |
| Thinking Machines | `thinkingmachines/inkling`, `thinkingmachines/inkling-small` |
| Poolside | `poolside/laguna-s-2.1-free` |
| Meta | `meta/muse-spark-1.1`, `meta/muse-spark-1.2`, `meta/muse-spark-1.2-contributor` |
| xAI | `xai/grok-4.5` |

The extension does not hide or disable models by Command Code account plan. It
exposes the committed catalog and lets Command Code return any access error.

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

When Command Code changes its live model list, check it without installing or
executing npm package contents:

```sh
node scripts/sync-upstream-models.mjs
git diff -- models.json
node --test tests/test-model-registry.ts
```

The synchronizer downloads only the public Provider API model list. Update
`models.json` manually from Command Code docs when model metadata or pricing
changes. The repository's weekly `model-drift` workflow runs the same comparison
and reports additions or removals without changing the runtime catalog.

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
the test suite with Node.js 22 or newer, which executes TypeScript without
installing a transpiler:

```sh
node --version
node --test tests/test-pure-functions.ts tests/test-oauth.ts \
  tests/test-abort.ts tests/test-stream.ts tests/test-retry.ts \
  tests/test-model-registry.ts
OMP_BIN="$(command -v omp)" node tests/test-omp-local.mjs
```

`tests/test-omp-local.mjs` starts a local mock Command Code endpoint and
exercises the actual `omp` binary in both print and RPC modes without sending a
credential to Command Code. With the existing Command Code credential, run the
live smoke test explicitly. It defaults to the currently advertised free Laguna
model so it does not consume Go-plan credits, although Command Code can still
reject it for capacity or account-state reasons. Override
`COMMAND_CODE_LIVE_MODEL` when needed:

```sh
OMP_BIN="$(command -v omp)" node tests/test-live-omp.mjs
```

## Compatibility Sources

- [OMP v17.2.10](https://github.com/can1357/oh-my-pi/releases/tag/v17.2.10)
- [Command Code changelog](https://commandcode.ai/docs/resources/changelog)
- [Command Code pricing and plan limits](https://commandcode.ai/docs/resources/pricing-limits)
- Command Code CLI 1.14.1's installed generated model reference

## License

MIT. This adaptation retains the upstream MIT-licensed implementation and
credits the original provider above.
