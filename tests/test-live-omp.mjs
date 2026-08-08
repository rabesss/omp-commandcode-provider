#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { delimiter, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { redactSensitiveText } from "../src/redaction.ts"

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const extensionPath = resolve(projectDir, "index.ts")

function findOmpBinary() {
  if (process.env.OMP_BIN) return process.env.OMP_BIN
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(entry, "omp")
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined
}

const omp = findOmpBinary()
if (!omp) throw new Error("OMP_BIN is unset and omp was not found on PATH")
const liveModel = process.env.COMMAND_CODE_LIVE_MODEL ?? "poolside/laguna-s-2.1-free"
assert.equal(
  liveModel,
  "poolside/laguna-s-2.1-free",
  "live OMP smoke is pinned to the allowlisted free model",
)

const result = spawnSync(
  omp,
  [
    "--extension",
    extensionPath,
    "--no-tools",
    "--no-session",
    "--max-time=45",
    "--thinking",
    "minimal",
    "-p",
    "--model",
    `commandcode/${liveModel}`,
    "Reply with exactly: commandcode-live-ok",
  ],
  { cwd: projectDir, encoding: "utf8", timeout: 60_000 },
)

const stdout = redactSensitiveText(result.stdout)
const stderr = redactSensitiveText(result.stderr)
assert.equal(result.status, 0, stderr)
assert.match(stdout, /commandcode-live-ok/)
assert.doesNotMatch(`${stdout}\n${stderr}`, /Bearer\s+(?!\[REDACTED\])|\buser_(?!\[REDACTED\])/)
console.log("[omp-live] PASS")
