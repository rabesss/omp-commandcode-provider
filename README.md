# omp-commandcode-provider

A dependency-free [OMP](https://github.com/can1357/oh-my-pi) extension for using
[Command Code](https://commandcode.ai) subscription/API-key models from `omp`.

This project is an OMP adaptation of
[ninehills/pi-commandcode-provider](https://github.com/ninehills/pi-commandcode-provider).
It preserves its Command Code transport, streaming, tool calls, thinking blocks,
abort handling, browser-assisted login, and model registry, while using OMP's
native extension API and install layout.

This is an unofficial, community-maintained extension. It is not affiliated
with or endorsed by Command Code.

## Security And Dependencies

- Runtime dependencies: **none**.
- Install-time dependencies: **none**. Install by cloning source into OMP's
  native extension directory; do not run `npm install`.
- Runtime imports are only tracked local source files, `models.json`, and Node
  built-ins. Its OMP `ExtensionAPI` import is type-only and erased at runtime.
- It does not contain an API key. Keep `COMMANDCODE_API_KEY` in
  `~/.omp/agent/.env`, which should be permission mode `600`, or use OMP's
  interactive login flow.
- `models.json` is committed source data rather than fetched or executed during
  installation.

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
path tested against `omp/15.2.4`.

No package-manager install or build step is required. Restart `omp`, then verify
registration:

```sh
omp --list-models commandcode
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
printf '%s\n' 'COMMANDCODE_API_KEY=user_...' >> ~/.omp/agent/.env
chmod 600 ~/.omp/agent/.env
```

Do not commit that file or paste real credentials into issues.

### Browser-Assisted Login

In interactive OMP, run:

```text
/login
```

Select **Command Code**. The extension opens Command Code Studio and accepts a
one-time `127.0.0.1` callback matching its loopback listener; if automatic
callback transfer is unavailable, it prompts for the API key from the browser
after 15 seconds. API keys do not require OAuth refresh, so the provider stores
the credential using OMP's provider-auth interface.

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

The committed registry matches the Command Code Provider API model list checked
for this adaptation and exposes all 23 entries:

| Family | Model IDs |
| --- | --- |
| Anthropic | `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5-20251001` |
| OpenAI | `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.4-mini` |
| DeepSeek | `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash` |
| Moonshot | `moonshotai/Kimi-K2.6`, `moonshotai/Kimi-K2.5` |
| Z.AI | `zai-org/GLM-5.1`, `zai-org/GLM-5` |
| MiniMax | `MiniMaxAI/MiniMax-M2.7`, `MiniMaxAI/MiniMax-M2.5` |
| Qwen | `Qwen/Qwen3.6-Max-Preview`, `Qwen/Qwen3.6-Plus`, `Qwen/Qwen3.7-Max` |
| StepFun | `stepfun/Step-3.5-Flash` |
| Xiaomi | `xiaomi/mimo-v2.5-pro`, `xiaomi/mimo-v2.5` |
| Google | `google/gemini-3.5-flash`, `google/gemini-3.1-flash-lite` |

The extension applies two runtime metadata corrections without altering the
audited registry: `gpt-5.3-codex` is exposed with a `272K` usable input
context because its `128K` output budget is separate in OMP, and the DeepSeek
models are exposed with `200K` maximum output because the Command Code gateway
currently rejects larger `max_tokens` requests.

When Command Code changes its live model list, check it without installing or
executing npm package contents:

```sh
node scripts/sync-upstream-models.mjs
git diff -- models.json
node --test tests/test-model-registry.ts
```

The synchronizer downloads only the public Provider API model list. Update
`models.json` manually from Command Code docs when model metadata or pricing
changes.

## Features

- Streaming text responses and reasoning/thinking blocks.
- OMP tool-call serialization and tool-result round trips.
- Request cancellation and stream cleanup.
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
  tests/test-abort.ts tests/test-stream.ts tests/test-model-registry.ts
OMP_BIN="$(command -v omp)" node tests/test-omp-local.mjs
```

`tests/test-omp-local.mjs` starts a local mock Command Code endpoint and
exercises the actual `omp` binary in both print and RPC modes without sending a
credential to Command Code. With a configured Command Code credential, run the
live smoke test explicitly:

```sh
OMP_BIN="$(command -v omp)" node tests/test-live-omp.mjs
```

## License

MIT. This adaptation retains the upstream MIT-licensed implementation and
credits the original provider above.
