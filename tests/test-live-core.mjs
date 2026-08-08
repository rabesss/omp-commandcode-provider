#!/usr/bin/env node

import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"

import modelsJson from "../models.json" with { type: "json" }
import { createStreamCommandCode } from "../src/core.ts"
import { buildRuntimeCatalog } from "../src/model-registry.ts"
import { redactSensitiveText } from "../src/redaction.ts"
import { calculateCost, createAssistantMessageEventStream } from "../src/runtime.ts"

const LIVE_MODEL = "poolside/laguna-s-2.1-free"
const MAX_OUTPUT_TOKENS = 8

function loadStoredCommandCodeKey() {
  const db = new DatabaseSync(join(homedir(), ".omp", "agent", "agent.db"), { readOnly: true })
  try {
    const rows = db
      .prepare(
        `SELECT credential_type, data
           FROM auth_credentials
          WHERE provider = ? AND disabled_cause IS NULL
          ORDER BY CASE credential_type WHEN 'api_key' THEN 0 ELSE 1 END, updated_at DESC`,
      )
      .all("commandcode")
    for (const row of rows) {
      const data = JSON.parse(row.data)
      const key = row.credential_type === "api_key" ? data.key : data.access
      if (typeof key === "string" && key.length > 0) return key
    }
    throw new Error("No enabled Command Code credential is stored in OMP")
  } finally {
    db.close()
  }
}

const apiKey = loadStoredCommandCodeKey()
const runtimeCatalog = buildRuntimeCatalog(modelsJson)
assert.deepEqual(runtimeCatalog.issues, [])
const model = runtimeCatalog.models.find((entry) => entry.id === LIVE_MODEL)
assert.ok(model, `missing allowlisted live model ${LIVE_MODEL}`)
assert.equal(model.availableOnIndividualGo, true)
assert.equal(model.cost.input, 0)
assert.equal(model.cost.output, 0)

const streamCommandCode = createStreamCommandCode({
  createStream: createAssistantMessageEventStream,
  calculateCost,
})
const stream = streamCommandCode(
  {
    id: model.id,
    api: "commandcode-custom",
    provider: "commandcode",
    maxTokens: model.maxOutputTokens,
    cost: model.cost,
  },
  {
    systemPrompt: "Return only the requested literal text.",
    messages: [{ role: "user", content: "Reply exactly: OK" }],
    tools: [],
  },
  {
    apiKey,
    maxTokens: MAX_OUTPUT_TOKENS,
    disableReasoning: true,
    maxRetries: 0,
    timeoutMs: 30_000,
    streamFirstEventTimeoutMs: 20_000,
    streamIdleTimeoutMs: 20_000,
  },
)

const events = []
for await (const event of stream) events.push(event)
const terminal = events.at(-1)
if (terminal?.type === "error") {
  throw new Error(redactSensitiveText(terminal.error.errorMessage ?? "live request failed", [apiKey]))
}
assert.equal(terminal?.type, "done")
assert.ok(terminal.message.usage.input >= 0)
assert.ok(terminal.message.usage.output > 0)
assert.ok(terminal.message.usage.totalTokens >= terminal.message.usage.output)
assert.equal(terminal.message.usage.cost.total, 0)
assert.match(
  terminal.message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(""),
  /OK/i,
)
console.log(`[core-live] PASS (${LIVE_MODEL}, max_output_tokens=${MAX_OUTPUT_TOKENS})`)
