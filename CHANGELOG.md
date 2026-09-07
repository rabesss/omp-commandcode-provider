# Changelog

## Unreleased

### Added

- Fetch the live Command Code Provider model catalog at runtime and merge it
  with the committed `models.json` overlay. New IDs appear automatically with
  conservative text-only defaults and a 65,536-token output cap, still bounded
  by live context. Known IDs keep reviewed vision, reasoning, pricing, and
  max-output metadata, and take live display names and context windows. The
  static `models` list remains the cold-start fallback. `models:check` /
  `models:proposal` stay optional maintenance tools that fetch the Provider API
  and pricing docs; they never write `models.json`.

### Changed

- Pin the adapter compatibility header and reviewed rich-model snapshot to
  Command Code CLI 1.32.1 and the integration baseline to OMP 17.4.2.
- Refresh the committed official pricing/limits snapshot to 61 rows and use
  conservative peak rates for the new time-of-day pricing schema.
- Use documented five-minute cache-write rates. This lowers the reported
  cache-write estimate for three Anthropic models that previously used the
  larger of the five-minute and one-hour values.
- Mark MiniMax M3 as reasoning-capable and remove advertised reasoning from
  MiMo V2.5 and MiMo V2.5 Pro. Claude Sonnet 4.6 now follows the conservative
  documented capability because an Individual Go probe could not reach model
  inference to verify the CLI-only effort choices.
- Update DeepSeek V4 Flash's display name to `DeepSeek V4 Flash (latest)`.

### Added

- Fail-closed Provider API and pricing-page validation with offline fixtures,
  distinct transient/extraction/drift outcomes, plan/tier/deal reporting, dated
  conflict records, and a proposal-only maintenance mode.
- Individual Go availability metadata for all 58 registered models and clearer
  recognized plan-entitlement errors.
- Ox Alpha with 1,048,576-token context, 131,072-token output, vision, free
  pricing, and `low`/`high`/`max` reasoning; also add the five other models
  introduced through Command Code CLI 1.32.1.
- A secret-scrubbed, eight-token, free-model direct live adapter smoke test.
- In-memory preference for the current pasted login API key when legacy
  OAuth-shaped Command Code rows remain in OMP's credential pool.
- CLI-compatible two-minute browser login, `localhost` callback URL, current
  callback identity metadata, and compatibility with the prior callback shape.

### Fixed

- Remove four orphan legacy pricing rows and prevent silent pricing-key
  collisions or missing prices from being presented as free usage.
- Retry catalog rate limits (with bounded `Retry-After` handling) and body-stage
  transport failures as transient errors, surface any runtime model skipped for
  corrupt pricing, guard malformed runtime tier and availability fields, and
  reject expiring deals without a stable list rate.
- Clear a pinned login key after its stored credential is deleted, and verify
  raw live-test output for credential-shaped leaks before scrubbing diagnostics.
- Validate peak/off-peak ordering, positive schedule windows, tier alignment,
  and ambiguous deal combinations; record the removed Claude Sonnet 5 revert
  schedule as a dated source decision instead of dropping it silently.
