#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { delimiter, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

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

const result = spawnSync(
  omp,
  [
    "--extension",
    extensionPath,
    "--no-tools",
    "--no-session",
    "--thinking",
    "minimal",
    "-p",
    "--model",
    "commandcode/deepseek/deepseek-v4-flash",
    "Reply with exactly: commandcode-live-ok",
  ],
  { cwd: projectDir, encoding: "utf8", timeout: 120_000 },
)

assert.equal(result.status, 0, result.stderr)
assert.match(result.stdout, /commandcode-live-ok/)
console.log("[omp-live] PASS")
