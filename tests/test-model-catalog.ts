import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"

import modelsJson from "../models.json" with { type: "json" }
import {
  buildProposal,
  catalogDateWarnings,
  CatalogSourceError,
  compareCatalog,
  extractPricingRowsFromHtml,
  fetchSource,
  normalizeDocsRows,
  validateCommittedCatalog,
  validateProviderPayload,
} from "../scripts/model-catalog-lib.mjs"

const fixtures = new URL("./fixtures/", import.meta.url)
const pricingHtml = await readFile(new URL("pricing-limits-fragment.html", fixtures), "utf8")
const providerPayload = JSON.parse(
  await readFile(new URL("provider-models.json", fixtures), "utf8"),
)

describe("model catalog source validation", () => {
  it("extracts the reviewed pricing snapshot and its boundary sets", () => {
    const rows = extractPricingRowsFromHtml(pricingHtml)
    assert.equal(rows.length, 55)
    assert.equal(rows.filter((row) => !row.deprecated).length, 53)
    assert.equal(
      rows.filter((row) => !row.deprecated && row.availability["individual-go"]).length,
      32,
    )
    assert.deepEqual(
      rows.filter((row) => row.deprecated).map((row) => row.id),
      ["ling-3.0-flash-free", "claude-sonnet-4-5"],
    )
    assert.equal(rows.filter((row) => !row.deprecated && row.tiers.length > 1).length, 6)
    assert.equal(rows.filter((row) => !row.deprecated && row.deal).length, 8)
  })

  it("validates the exact Provider API schema and 52 unique models", () => {
    const rows = validateProviderPayload(providerPayload)
    assert.equal(rows.length, 52)
    assert.equal(new Set(rows.map((row) => row.id)).size, 52)
  })

  it("fails closed on empty, truncated, and interstitial docs responses", () => {
    for (const input of [
      "",
      pricingHtml.slice(0, pricingHtml.indexOf("self.__next_f.push") + 30),
      "<html><head><title>Checking your browser</title></head><body>Wait</body></html>",
      pricingHtml.replace(/<script>self\.__next_f[\s\S]*<\/script>/, ""),
    ]) {
      assert.throws(
        () => extractPricingRowsFromHtml(input),
        (error: unknown) => error instanceof CatalogSourceError && error.kind === "extraction",
      )
    }
  })

  it("rejects duplicate rows, malformed numbers, and unknown schema fields", () => {
    const rows = extractPricingRowsFromHtml(pricingHtml)
    assert.throws(() => normalizeDocsRows([...rows, structuredClone(rows[0])]), /duplicate pricing docs id/)

    const stringRate = structuredClone(rows)
    ;(stringRate[0].tiers[0].rates as Record<string, unknown>).input = "$0.30"
    assert.throws(() => normalizeDocsRows(stringRate), /input must be a non-negative number/)

    const unknownField = structuredClone(rows)
    ;(unknownField[0] as Record<string, unknown>).surprise = true
    assert.throws(() => normalizeDocsRows(unknownField), /unknown field surprise/)
  })

  it("distinguishes transient fetch failures from extraction failures", async () => {
    await assert.rejects(
      fetchSource(
        "https://example.test/models",
        "application/json",
        async () => new Response("busy", { status: 503 }),
        0,
      ),
      (error: unknown) => error instanceof CatalogSourceError && error.kind === "transient",
    )
    await assert.rejects(
      fetchSource(
        "https://example.test/models",
        "application/json",
        async () => new Response("<html>wrong</html>", { headers: { "content-type": "text/html" } }),
        0,
      ),
      (error: unknown) => error instanceof CatalogSourceError && error.kind === "extraction",
    )
    await assert.rejects(
      fetchSource(
        "https://example.test/models",
        "application/json",
        async () => new Response(null, { status: 302, headers: { location: "/login" } }),
        0,
      ),
      (error: unknown) => error instanceof CatalogSourceError && error.kind === "extraction",
    )
  })
})

describe("committed model catalog", () => {
  it("is canonical and matches both reviewed source fixtures", () => {
    validateCommittedCatalog(modelsJson, new Date("2026-08-08T12:00:00Z"))
    const diffs = compareCatalog(
      modelsJson,
      validateProviderPayload(providerPayload),
      extractPricingRowsFromHtml(pricingHtml),
    )
    assert.deepEqual(diffs, [])
  })

  it("keeps proposals deterministic and read-only for a synthetic new model", async () => {
    const before = await readFile(new URL("../models.json", import.meta.url), "utf8")
    const providerModels = validateProviderPayload(providerPayload)
    const added = {
      ...providerModels.at(-1),
      id: "example/new-model",
      name: "Example New Model",
    }
    const proposal = buildProposal(
      modelsJson,
      [...providerModels, added],
      extractPricingRowsFromHtml(pricingHtml),
    )
    const repeated = buildProposal(
      modelsJson,
      [...providerModels, added],
      extractPricingRowsFromHtml(pricingHtml),
    )
    const after = await readFile(new URL("../models.json", import.meta.url), "utf8")

    assert.equal(proposal.writesPerformed, false)
    assert.deepEqual(repeated, proposal)
    assert.ok(proposal.diffs.some((diff) => diff.path === "models.order"))
    assert.equal(after, before)
  })

  it("reports date-bound source metadata without changing catalog values", () => {
    const rows = extractPricingRowsFromHtml(pricingHtml)
    const warnings = catalogDateWarnings(rows, new Date("2026-08-08T12:00:00Z"))
    assert.ok(warnings.some((warning) => warning.startsWith("qwen-3.7-max:")))
    assert.ok(!warnings.some((warning) => warning.startsWith("gpt-5.6-terra:")))
  })

  it("enforces override lifecycle and verification staleness", () => {
    const stale = structuredClone(modelsJson)
    stale.sourceConflicts[0].verifiedAt = "2025-01-01"
    assert.throws(
      () => validateCommittedCatalog(stale, new Date("2026-08-08T12:00:00Z")),
      /older than 180 days/,
    )

    const noLongerConflicting = structuredClone(modelsJson)
    noLongerConflicting.sourceConflicts[0].conflicting.value = false
    assert.throws(
      () => validateCommittedCatalog(noLongerConflicting, new Date("2026-08-08T12:00:00Z")),
      /does not describe a real value conflict/,
    )
  })
})
