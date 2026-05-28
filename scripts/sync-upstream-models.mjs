#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const upstreamUrl = "https://api.commandcode.ai/provider/v1/models"
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const modelsPath = resolve(projectDir, "models.json")

if (process.argv.length > 2) {
  throw new Error("Usage: node scripts/sync-upstream-models.mjs")
}

const response = await fetch(upstreamUrl, { headers: { accept: "application/json" } })
if (!response.ok) {
  throw new Error(`Unable to fetch Command Code model registry: HTTP ${response.status}`)
}

const upstream = await response.json()
if (
  !upstream ||
  upstream.object !== "list" ||
  !Array.isArray(upstream.data) ||
  upstream.data.some((model) => typeof model?.id !== "string")
) {
  throw new Error("Command Code model registry does not match the expected shape")
}

const current = JSON.parse(await readFile(modelsPath, "utf8"))
const currentIds = current.models.map((model) => model.id)
const upstreamIds = upstream.data.map((model) => model.id)
const currentSet = new Set(currentIds)
const upstreamSet = new Set(upstreamIds)
const missing = upstreamIds.filter((id) => !currentSet.has(id))
const stale = currentIds.filter((id) => !upstreamSet.has(id))

if (missing.length === 0 && stale.length === 0) {
  console.log(`[models] synchronized with Command Code Provider API (${upstreamIds.length} models)`)
  process.exit(0)
}

if (missing.length > 0) console.error(`[models] missing from models.json: ${missing.join(", ")}`)
if (stale.length > 0) console.error(`[models] not in live Provider API: ${stale.join(", ")}`)
process.exit(1)
