import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"

import modelsJson from "../models.json" with { type: "json" }
import {
  buildProposal,
  catalogDateWarnings,
  CatalogSourceError,
  compareCatalog,
  EXIT_CODES,
  extractPricingRowsFromHtml,
  fetchSource,
  normalizeDocsRows,
  validateCommittedCatalog,
  validateProviderPayload,
} from "../scripts/model-catalog-lib.mjs"
import { runModelCatalogCli } from "../scripts/sync-upstream-models.mjs"

const fixtures = new URL("./fixtures/", import.meta.url)
const pricingHtml = await readFile(new URL("pricing-limits-fragment.html", fixtures), "utf8")
const providerPayload = JSON.parse(
  await readFile(new URL("provider-models.json", fixtures), "utf8"),
)

describe("model catalog source validation", () => {
  it("extracts the reviewed pricing snapshot and its boundary sets", () => {
    const rows = extractPricingRowsFromHtml(pricingHtml)
    assert.equal(rows.length, 61)
    assert.equal(rows.filter((row) => !row.deprecated).length, 59)
    assert.equal(
      rows.filter((row) => !row.deprecated && row.availability["individual-go"]).length,
      36,
    )
    assert.deepEqual(
      rows.filter((row) => row.deprecated).map((row) => row.id),
      ["ling-3.0-flash-free", "claude-sonnet-4-5"],
    )
    assert.equal(rows.filter((row) => !row.deprecated && row.tiers.length > 1).length, 8)
    assert.equal(rows.filter((row) => !row.deprecated && row.deal).length, 7)
    assert.deepEqual(
      rows.filter((row) => row.timeOfDay).map((row) => row.id),
      ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
    )
  })

  it("validates the exact Provider API schema and 58 unique models", () => {
    const rows = validateProviderPayload(providerPayload)
    assert.equal(rows.length, 58)
    assert.equal(new Set(rows.map((row) => row.id)).size, 58)
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

    const invalidTimeOfDay = structuredClone(rows)
    const dynamic = invalidTimeOfDay.find((row) => row.timeOfDay)
    assert.ok(dynamic?.timeOfDay)
    dynamic.timeOfDay.peakHoursPerDay = 8
    assert.throws(() => normalizeDocsRows(invalidTimeOfDay), /hours must total 24/)

    const invalidDynamicDate = structuredClone(rows)
    const invalidDynamic = invalidDynamicDate.find((row) => row.timeOfDay)
    assert.ok(invalidDynamic?.timeOfDay)
    invalidDynamic.timeOfDay.effective = "2026-02-30T00:00:00Z"
    assert.throws(() => normalizeDocsRows(invalidDynamicDate), /valid ISO UTC timestamp/)

    const lowerPeak = structuredClone(rows)
    const lowerPeakRow = lowerPeak.find((row) => row.timeOfDay)
    assert.ok(lowerPeakRow?.timeOfDay)
    lowerPeakRow.timeOfDay.peak.input = lowerPeakRow.timeOfDay.offPeak.input - 0.01
    assert.throws(() => normalizeDocsRows(lowerPeak), /peak rate must be greater/)

    const asymmetricCacheRate = structuredClone(rows)
    const asymmetricCacheRow = asymmetricCacheRate.find((row) => row.timeOfDay)
    assert.ok(asymmetricCacheRow?.timeOfDay)
    asymmetricCacheRow.timeOfDay.peak.cacheRead = null
    assert.throws(
      () => normalizeDocsRows(asymmetricCacheRate),
      /peak and off-peak rates must both be null or both be numbers/,
    )

    const equalPeak = structuredClone(rows)
    const equalPeakRow = equalPeak.find((row) => row.timeOfDay)
    assert.ok(equalPeakRow?.timeOfDay)
    equalPeakRow.timeOfDay.peak.input = equalPeakRow.timeOfDay.offPeak.input
    assert.doesNotThrow(() => normalizeDocsRows(equalPeak))

    const zeroPeakHours = structuredClone(rows)
    const zeroPeakRow = zeroPeakHours.find((row) => row.timeOfDay)
    assert.ok(zeroPeakRow?.timeOfDay)
    zeroPeakRow.timeOfDay.peakHoursPerDay = 0
    zeroPeakRow.timeOfDay.offPeakHoursPerDay = 24
    assert.throws(() => normalizeDocsRows(zeroPeakHours), /peakHoursPerDay must be positive/)

    const mismatchedOffPeak = structuredClone(rows)
    const mismatchedRow = mismatchedOffPeak.find((row) => row.timeOfDay)
    assert.ok(mismatchedRow?.timeOfDay)
    mismatchedRow.tiers[0].rates.input += 0.01
    assert.throws(() => normalizeDocsRows(mismatchedOffPeak), /must match timeOfDay.offPeak/)

    const ambiguousSchedule = structuredClone(rows)
    const ambiguousRow = ambiguousSchedule.find((row) => row.timeOfDay)
    assert.ok(ambiguousRow)
    ambiguousRow.deal = {
      id: "ambiguous-deal",
      discountPercent: 10,
      free: false,
      expires: "2026-12-31T23:59:59Z",
    }
    assert.throws(
      () => normalizeDocsRows(ambiguousSchedule),
      /cannot combine a deal with time-of-day pricing/,
    )

    const unboundedDealSchedule = structuredClone(rows)
    const unboundedDealRow = unboundedDealSchedule.find((row) => row.timeOfDay)
    assert.ok(unboundedDealRow)
    unboundedDealRow.deal = {
      id: "unbounded-deal",
      discountPercent: 10,
      free: false,
      endsWhen: "while promotional capacity lasts",
    }
    assert.throws(
      () => normalizeDocsRows(unboundedDealSchedule),
      /cannot combine a deal with time-of-day pricing/,
    )
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

    let bodyAttempts = 0
    await assert.rejects(
      fetchSource(
        "https://example.test/models",
        "application/json",
        async () => {
          bodyAttempts += 1
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError("socket reset during body read"))
              },
            }),
            { headers: { "content-type": "application/json" } },
          )
        },
        1,
      ),
      (error: unknown) => error instanceof CatalogSourceError && error.kind === "transient",
    )
    assert.equal(bodyAttempts, 2)

    let rateLimitAttempts = 0
    const retryDelays: number[] = []
    const recovered = await fetchSource(
      "https://example.test/models",
      "application/json",
      async () => {
        rateLimitAttempts += 1
        return rateLimitAttempts === 1
          ? new Response(null, { status: 429, headers: { "retry-after": "0.01" } })
          : new Response('{"object":"list","data":[]}', {
              headers: { "content-type": "application/json" },
            })
      },
      1,
      async (ms) => {
        retryDelays.push(ms)
      },
    )
    assert.equal(recovered, '{"object":"list","data":[]}')
    assert.equal(rateLimitAttempts, 2)
    assert.deepEqual(retryDelays, [10])

    let dateAttempts = 0
    const dateDelays: number[] = []
    const retryAt = new Date(Date.now() + 30_000).toUTCString()
    await fetchSource(
      "https://example.test/models",
      "application/json",
      async () => {
        dateAttempts += 1
        return dateAttempts === 1
          ? new Response(null, { status: 429, headers: { "retry-after": retryAt } })
          : new Response('{"object":"list","data":[]}', {
              headers: { "content-type": "application/json" },
            })
      },
      1,
      async (ms) => {
        dateDelays.push(ms)
      },
    )
    assert.equal(dateAttempts, 2)
    assert.equal(dateDelays.length, 1)
    assert.ok(dateDelays[0] >= 28_000 && dateDelays[0] <= 30_000)

    let cappedAttempts = 0
    const cappedDelays: number[] = []
    await assert.rejects(
      fetchSource(
        "https://example.test/models",
        "application/json",
        async () => {
          cappedAttempts += 1
          return new Response(null, { status: 429, headers: { "retry-after": "120" } })
        },
        2,
        async (ms) => {
          cappedDelays.push(ms)
        },
      ),
      (error: unknown) => error instanceof CatalogSourceError && error.kind === "transient",
    )
    assert.equal(cappedAttempts, 1)
    assert.deepEqual(cappedDelays, [])
  })
})

describe("committed model catalog", () => {
  it("is canonical and matches both reviewed source fixtures", () => {
    validateCommittedCatalog(modelsJson, new Date("2026-08-22T12:00:00Z"))
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
    const warnings = catalogDateWarnings(
      rows,
      new Date("2026-08-22T12:00:00Z"),
      modelsJson.sourceConflicts,
    )
    assert.ok(warnings.some((warning) => warning.startsWith("qwen-3.7-max:")))
    assert.ok(!warnings.some((warning) => warning.startsWith("gpt-5.6-terra:")))
    assert.ok(
      warnings.some((warning) => warning.startsWith("deepseek-v4-pro: documented time-of-day")),
    )
    assert.ok(!warnings.some((warning) => warning.startsWith("claude-sonnet-5:")))

    const postReviewWarnings = catalogDateWarnings(
      rows,
      new Date("2026-09-01T12:00:00Z"),
      modelsJson.sourceConflicts,
    )
    assert.ok(
      postReviewWarnings.some((warning) =>
        warning.startsWith("claude-sonnet-5: source-conflict review date"),
      ),
    )
  })

  it("enforces override lifecycle and verification staleness", () => {
    const stale = structuredClone(modelsJson)
    stale.sourceConflicts[0].verifiedAt = "2025-01-01"
    assert.throws(
      () => validateCommittedCatalog(stale, new Date("2026-08-22T12:00:00Z")),
      /older than 180 days/,
    )

    const noLongerConflicting = structuredClone(modelsJson)
    noLongerConflicting.sourceConflicts[0].conflicting.value = false
    assert.throws(
      () => validateCommittedCatalog(noLongerConflicting, new Date("2026-08-22T12:00:00Z")),
      /does not describe a real value conflict/,
    )

    const invalidReviewDate = structuredClone(modelsJson)
    invalidReviewDate.sourceConflicts[1].reviewAfter = "2026-02-30"
    assert.throws(
      () => validateCommittedCatalog(invalidReviewDate, new Date("2026-08-22T12:00:00Z")),
      /reviewAfter must be a valid ISO date/,
    )
    assert.throws(
      () =>
        catalogDateWarnings(
          extractPricingRowsFromHtml(pricingHtml),
          new Date("2026-08-22T12:00:00Z"),
          invalidReviewDate.sourceConflicts,
        ),
      /reviewAfter must be a valid ISO date/,
    )
  })

  it("rejects an active expiring deal without a static list rate", () => {
    const missingListRate = structuredClone(modelsJson)
    const gemini37 = missingListRate.source.pricingDocs.rows.find(
      (row) => row.id === "gemini-3.7-flash",
    )
    assert.ok(gemini37)
    gemini37.tiers[0].listRates = null
    assert.throws(
      () => validateCommittedCatalog(missingListRate, new Date("2026-08-22T12:00:00Z")),
      /expiring deal without first-tier listRates/,
    )
  })

  it("maps clean, drift, transient, extraction, proposal, and usage CLI outcomes", async () => {
    const providerModels = validateProviderPayload(providerPayload)
    const docsRows = extractPricingRowsFromHtml(pricingHtml)
    const output: string[] = []
    const baseDeps = {
      readFileImpl: async () => JSON.stringify(modelsJson),
      fetchLiveCatalogImpl: async () => ({ providerModels, docsRows }),
      log: (message: string) => output.push(message),
      warn: (message: string) => output.push(message),
      error: (message: string) => output.push(message),
    }

    assert.equal(await runModelCatalogCli([], baseDeps), EXIT_CODES.CLEAN)
    assert.equal(await runModelCatalogCli(["--proposal"], baseDeps), EXIT_CODES.CLEAN)
    assert.match(output.at(-1) ?? "", /"writesPerformed": false/)
    assert.equal(await runModelCatalogCli(["--unknown"], baseDeps), EXIT_CODES.USAGE)

    const added = { ...providerModels.at(-1)!, id: "example/new-model", name: "New Model" }
    assert.equal(
      await runModelCatalogCli([], {
        ...baseDeps,
        fetchLiveCatalogImpl: async () => ({ providerModels: [...providerModels, added], docsRows }),
      }),
      EXIT_CODES.DRIFT,
    )

    for (const [kind, expected] of [
      ["transient", EXIT_CODES.TRANSIENT_FAILURE],
      ["extraction", EXIT_CODES.EXTRACTION_FAILURE],
    ] as const) {
      assert.equal(
        await runModelCatalogCli([], {
          ...baseDeps,
          fetchLiveCatalogImpl: async () => {
            throw new CatalogSourceError(kind, `${kind} fixture`)
          },
        }),
        expected,
      )
    }

    for (const readFileImpl of [
      async () => {
        throw new Error("ENOENT fixture")
      },
      async () => "not json",
    ]) {
      assert.equal(
        await runModelCatalogCli([], { ...baseDeps, readFileImpl }),
        EXIT_CODES.EXTRACTION_FAILURE,
      )
    }
  })
})
