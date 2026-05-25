#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const upstreamUrl =
  "https://raw.githubusercontent.com/ninehills/pi-commandcode-provider/main/models.json"
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const modelsPath = resolve(projectDir, "models.json")
const write = process.argv.includes("--write")

if (process.argv.slice(2).some((arg) => arg !== "--write")) {
  throw new Error("Usage: node scripts/sync-upstream-models.mjs [--write]")
}

const response = await fetch(upstreamUrl)
if (!response.ok) {
  throw new Error(`Unable to fetch upstream model registry: HTTP ${response.status}`)
}

const upstream = await response.json()
if (
  !upstream ||
  !Array.isArray(upstream.models) ||
  !Array.isArray(upstream.pricing) ||
  upstream.models.some((model) => typeof model?.id !== "string")
) {
  throw new Error("Upstream models.json does not match the expected registry shape")
}

const next = `${JSON.stringify(upstream, null, 2)}\n`
const current = await readFile(modelsPath, "utf8")
const currentRegistry = JSON.parse(current)

if (JSON.stringify(currentRegistry) === JSON.stringify(upstream)) {
  console.log(`[models] synchronized with upstream (${upstream.models.length} models)`)
  process.exit(0)
}

if (!write) {
  console.error(
    `[models] upstream has changed (${upstream.models.length} models); review with --write, git diff, and tests`,
  )
  process.exit(1)
}

await writeFile(modelsPath, next, "utf8")
console.log(`[models] wrote reviewed upstream candidate (${upstream.models.length} models)`)
