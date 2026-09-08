import { PROVIDER_MODELS_URL } from "../src/dynamic-models.ts"

const PROVIDER_KEYS = ["context_length", "created", "id", "name", "object", "owned_by"]
const AVAILABILITY_KEYS = [
  "all",
  "individual-go",
  "individual-goat",
  "individual-max",
  "individual-pro",
  "individual-pro-v1",
  "individual-provider",
  "individual-ultra",
  "teams-pro",
]
const DOC_ROW_KEYS = new Set([
  "availability",
  "caps",
  "category",
  "contextWindow",
  "deal",
  "deprecated",
  "id",
  "name",
  "note",
  "priceChangeNote",
  "tiers",
  "timeOfDay",
  "tip",
])
const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"]
const MAX_SOURCE_RETRY_DELAY_MS = 60_000

export { PROVIDER_MODELS_URL }
export const PRICING_DOCS_URL = "https://commandcode.ai/docs/resources/pricing-limits"

export const EXIT_CODES = Object.freeze({
  CLEAN: 0,
  DRIFT: 1,
  TRANSIENT_FAILURE: 2,
  EXTRACTION_FAILURE: 3,
  USAGE: 64,
})

export class CatalogSourceError extends Error {
  constructor(kind, message, cause, retryAfterMs) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "CatalogSourceError"
    this.kind = kind
    this.retryAfterMs = retryAfterMs
  }
}

function extractionFailure(message, cause) {
  return new CatalogSourceError("extraction", message, cause)
}

function transientFailure(message, cause, retryAfterMs) {
  return new CatalogSourceError("transient", message, cause, retryAfterMs)
}

function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs)
}

function assertExtraction(condition, message) {
  if (!condition) throw extractionFailure(message)
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function ownKeysEqual(value, expected) {
  return isPlainObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected)
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function requiredString(value, label) {
  assertExtraction(typeof value === "string" && value.trim() !== "", `${label} must be a string`)
  return value
}

function parseStrictIsoDate(value, label) {
  const date = requiredString(value, label)
  const parsed = Date.parse(`${date}T00:00:00.000Z`)
  assertExtraction(
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      !Number.isNaN(parsed) &&
      new Date(parsed).toISOString().slice(0, 10) === date,
    `${label} must be a valid ISO date`,
  )
  return parsed
}

function optionalString(value, label) {
  if (value === undefined || value === null) return undefined
  return requiredString(value, label)
}

function normalizeRates(value, label) {
  assertExtraction(isPlainObject(value), `${label} must be an object`)
  for (const key of Object.keys(value)) {
    assertExtraction(RATE_KEYS.includes(key), `${label} has unknown rate field ${key}`)
  }
  assertExtraction(finiteNonNegative(value.input), `${label}.input must be a non-negative number`)
  assertExtraction(finiteNonNegative(value.output), `${label}.output must be a non-negative number`)
  for (const key of ["cacheRead", "cacheWrite"]) {
    assertExtraction(
      value[key] === undefined || value[key] === null || finiteNonNegative(value[key]),
      `${label}.${key} must be a non-negative number or be absent`,
    )
  }
  return {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead ?? null,
    cacheWrite: value.cacheWrite ?? null,
  }
}

function normalizeDeal(value, label) {
  if (value === undefined) return undefined
  assertExtraction(isPlainObject(value), `${label} must be an object`)
  const allowed = new Set([
    "discountPercent",
    "endsWhen",
    "expires",
    "free",
    "id",
    "revertNote",
  ])
  for (const key of Object.keys(value)) {
    assertExtraction(allowed.has(key), `${label} has unknown field ${key}`)
  }
  requiredString(value.id, `${label}.id`)
  assertExtraction(
    finiteNonNegative(value.discountPercent) && value.discountPercent <= 100,
    `${label}.discountPercent must be between 0 and 100`,
  )
  assertExtraction(typeof value.free === "boolean", `${label}.free must be boolean`)
  if (value.expires !== undefined) {
    requiredString(value.expires, `${label}.expires`)
    assertExtraction(!Number.isNaN(Date.parse(value.expires)), `${label}.expires must be an ISO date`)
  }
  return {
    id: value.id,
    discountPercent: value.discountPercent,
    free: value.free,
    ...(value.expires === undefined ? {} : { expires: value.expires }),
    ...(value.endsWhen === undefined
      ? {}
      : { endsWhen: requiredString(value.endsWhen, `${label}.endsWhen`) }),
    ...(value.revertNote === undefined
      ? {}
      : { revertNote: requiredString(value.revertNote, `${label}.revertNote`) }),
  }
}

function normalizeTimeOfDay(value, label) {
  if (value === undefined) return undefined
  assertExtraction(isPlainObject(value), `${label} must be an object`)
  const expected = [
    "effective",
    "offPeak",
    "offPeakHoursPerDay",
    "peak",
    "peakHoursPerDay",
    "tip",
    "windows",
  ]
  assertExtraction(ownKeysEqual(value, expected), `${label} does not match the expected schema`)
  const effective = requiredString(value.effective, `${label}.effective`)
  const instantMatch = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}))?Z$/.exec(effective)
  const parsedInstant = Date.parse(effective)
  assertExtraction(
    instantMatch !== null &&
      !Number.isNaN(parsedInstant) &&
      new Date(parsedInstant).toISOString() ===
        `${instantMatch[1]}.${instantMatch[2] ?? "000"}Z`,
    `${label}.effective must be a valid ISO UTC timestamp`,
  )
  for (const key of ["peakHoursPerDay", "offPeakHoursPerDay"]) {
    assertExtraction(
      finiteNonNegative(value[key]) && value[key] > 0,
      `${label}.${key} must be positive`,
    )
  }
  assertExtraction(
    value.peakHoursPerDay + value.offPeakHoursPerDay === 24,
    `${label} hours must total 24`,
  )
  const peak = normalizeRates(value.peak, `${label}.peak`)
  const offPeak = normalizeRates(value.offPeak, `${label}.offPeak`)
  for (const key of RATE_KEYS) {
    const peakRate = peak[key]
    const offPeakRate = offPeak[key]
    assertExtraction(
      (peakRate === null) === (offPeakRate === null),
      `${label}.${key} peak and off-peak rates must both be null or both be numbers`,
    )
    assertExtraction(
      peakRate === null || offPeakRate === null || peakRate >= offPeakRate,
      `${label}.${key} peak rate must be greater than or equal to off-peak`,
    )
  }
  return {
    effective,
    peak,
    offPeak,
    peakHoursPerDay: value.peakHoursPerDay,
    offPeakHoursPerDay: value.offPeakHoursPerDay,
    windows: requiredString(value.windows, `${label}.windows`),
    tip: requiredString(value.tip, `${label}.tip`),
  }
}

function resolveFlightReference(value, records, seen = new Set()) {
  if (typeof value !== "string" || !/^\$[0-9A-Za-z]+:/.test(value)) return value
  assertExtraction(!seen.has(value), `cyclic React Flight reference ${value}`)
  const nextSeen = new Set(seen).add(value)
  const [recordIdWithDollar, ...path] = value.slice(1).split(":")
  let current = records.get(recordIdWithDollar)
  assertExtraction(current !== undefined, `unknown React Flight record ${recordIdWithDollar}`)
  for (const segment of path) {
    if (segment === "props" && Array.isArray(current)) {
      current = current[3]
      continue
    }
    assertExtraction(
      (Array.isArray(current) || isPlainObject(current)) && Object.hasOwn(current, segment),
      `invalid React Flight reference path ${value}`,
    )
    current = current[segment]
  }
  return resolveFlightReference(current, records, nextSeen)
}

function resolveFlightTree(value, records) {
  const resolved = resolveFlightReference(value, records)
  if (Array.isArray(resolved)) return resolved.map((entry) => resolveFlightTree(entry, records))
  if (isPlainObject(resolved)) {
    return Object.fromEntries(
      Object.entries(resolved).map(([key, entry]) => [key, resolveFlightTree(entry, records)]),
    )
  }
  return resolved
}

export function normalizeDocsRows(rows) {
  assertExtraction(Array.isArray(rows) && rows.length > 0, "pricing docs yielded zero model rows")
  const seen = new Set()
  return rows.map((row, rowIndex) => {
    const label = `pricing row ${rowIndex}`
    assertExtraction(isPlainObject(row), `${label} must be an object`)
    for (const key of Object.keys(row)) {
      assertExtraction(DOC_ROW_KEYS.has(key), `${label} has unknown field ${key}`)
    }
    const id = requiredString(row.id, `${label}.id`)
    assertExtraction(!seen.has(id), `duplicate pricing docs id ${id}`)
    seen.add(id)
    assertExtraction(
      ownKeysEqual(row.availability, AVAILABILITY_KEYS),
      `${label}.availability does not match the expected plan schema`,
    )
    for (const key of AVAILABILITY_KEYS) {
      assertExtraction(typeof row.availability[key] === "boolean", `${label}.availability.${key} must be boolean`)
    }
    assertExtraction(
      ownKeysEqual(row.caps, ["reasoning", "text", "vision"]),
      `${label}.caps does not match the expected capability schema`,
    )
    for (const key of ["reasoning", "text", "vision"]) {
      assertExtraction(typeof row.caps[key] === "boolean", `${label}.caps.${key} must be boolean`)
    }
    assertExtraction(Array.isArray(row.tiers) && row.tiers.length > 0, `${label}.tiers must not be empty`)
    const tiers = row.tiers.map((tier, tierIndex) => {
      const tierLabel = `${label}.tiers[${tierIndex}]`
      assertExtraction(isPlainObject(tier), `${tierLabel} must be an object`)
      for (const key of Object.keys(tier)) {
        assertExtraction(
          ["context", "label", "listRates", "rates"].includes(key),
          `${tierLabel} has unknown field ${key}`,
        )
      }
      return {
        label: optionalString(tier.label, `${tierLabel}.label`) ?? null,
        context: optionalString(tier.context, `${tierLabel}.context`) ?? null,
        rates: normalizeRates(tier.rates, `${tierLabel}.rates`),
        listRates:
          tier.listRates === undefined || tier.listRates === null
            ? null
            : normalizeRates(tier.listRates, `${tierLabel}.listRates`),
      }
    })
    assertExtraction(
      row.contextWindow === undefined ||
        row.contextWindow === null ||
        (Number.isInteger(row.contextWindow) && row.contextWindow > 0),
      `${label}.contextWindow must be a positive integer or be absent`,
    )
    if (row.deprecated !== undefined) {
      assertExtraction(typeof row.deprecated === "boolean", `${label}.deprecated must be boolean`)
    }
    let priceChangeNote
    if (row.priceChangeNote !== undefined) {
      assertExtraction(isPlainObject(row.priceChangeNote), `${label}.priceChangeNote must be an object`)
      assertExtraction(
        ownKeysEqual(row.priceChangeNote, ["effective", "text"]),
        `${label}.priceChangeNote does not match the expected schema`,
      )
      requiredString(row.priceChangeNote.effective, `${label}.priceChangeNote.effective`)
      assertExtraction(
        !Number.isNaN(Date.parse(row.priceChangeNote.effective)),
        `${label}.priceChangeNote.effective must be an ISO date`,
      )
      priceChangeNote = {
        effective: row.priceChangeNote.effective,
        text: requiredString(row.priceChangeNote.text, `${label}.priceChangeNote.text`),
      }
    }
    const deal = normalizeDeal(row.deal, `${label}.deal`)
    const timeOfDay = normalizeTimeOfDay(row.timeOfDay, `${label}.timeOfDay`)
    assertExtraction(
      !(deal && timeOfDay),
      `${label} cannot combine a deal with time-of-day pricing`,
    )
    if (timeOfDay) {
      assertExtraction(
        JSON.stringify(tiers[0].rates) === JSON.stringify(timeOfDay.offPeak),
        `${label}.tiers[0].rates must match timeOfDay.offPeak`,
      )
    }
    return {
      id,
      name: requiredString(row.name, `${label}.name`),
      category: requiredString(row.category, `${label}.category`),
      deprecated: row.deprecated === true,
      contextWindow: row.contextWindow ?? null,
      availability: Object.fromEntries(AVAILABILITY_KEYS.map((key) => [key, row.availability[key]])),
      caps: {
        text: row.caps.text,
        vision: row.caps.vision,
        reasoning: row.caps.reasoning,
      },
      tiers,
      ...(deal === undefined ? {} : { deal }),
      ...(row.note === undefined ? {} : { note: requiredString(row.note, `${label}.note`) }),
      ...(row.tip === undefined ? {} : { tip: requiredString(row.tip, `${label}.tip`) }),
      ...(priceChangeNote === undefined ? {} : { priceChangeNote }),
      ...(timeOfDay === undefined ? {} : { timeOfDay }),
    }
  })
}

export function extractPricingRowsFromHtml(html) {
  assertExtraction(typeof html === "string" && html.length > 0, "pricing docs response was empty")
  assertExtraction(/<title>Pricing Limits \| Command Code/.test(html), "pricing docs title marker is missing")
  assertExtraction(/<h1>Pricing &amp; Limits<\/h1>/.test(html), "pricing docs heading marker is missing")

  const records = new Map()
  const scriptPattern = /self\.__next_f\.push\((\[1,"(?:[^"\\]|\\.)*"\])\)<\/script>/gs
  for (const match of html.matchAll(scriptPattern)) {
    let chunk
    try {
      chunk = JSON.parse(match[1])[1]
    } catch (error) {
      throw extractionFailure("unable to decode a React Flight script", error)
    }
    const recordMatch = /^([0-9A-Za-z]+):(.*)\n?$/s.exec(chunk)
    if (!recordMatch) continue
    try {
      records.set(recordMatch[1], JSON.parse(recordMatch[2].trim()))
    } catch {
      // Most Flight records are not model data. The row-bearing record must be JSON below.
    }
  }

  const rowRecords = [...records.values()].filter(
    (record) => Array.isArray(record) && isPlainObject(record[3]) && Array.isArray(record[3].rows),
  )
  assertExtraction(rowRecords.length === 1, `expected one pricing row record, found ${rowRecords.length}`)
  return normalizeDocsRows(resolveFlightTree(rowRecords[0][3].rows, records))
}

export function validateProviderPayload(payload) {
  assertExtraction(isPlainObject(payload), "Provider API payload must be an object")
  assertExtraction(payload.object === "list" && Array.isArray(payload.data), "Provider API payload is not a list")
  const seen = new Set()
  return payload.data.map((row, index) => {
    const label = `Provider API row ${index}`
    assertExtraction(ownKeysEqual(row, PROVIDER_KEYS), `${label} does not match the expected schema`)
    const id = requiredString(row.id, `${label}.id`)
    assertExtraction(!seen.has(id), `duplicate Provider API id ${id}`)
    seen.add(id)
    assertExtraction(row.object === "model", `${label}.object must be model`)
    assertExtraction(Number.isInteger(row.created) && row.created >= 0, `${label}.created must be an integer`)
    requiredString(row.owned_by, `${label}.owned_by`)
    requiredString(row.name, `${label}.name`)
    assertExtraction(
      Number.isInteger(row.context_length) && row.context_length > 0,
      `${label}.context_length must be a positive integer`,
    )
    return { id, name: row.name, contextWindow: row.context_length }
  })
}

function validateCommittedRate(rate, label) {
  assertExtraction(isPlainObject(rate), `${label} must be an object`)
  for (const key of RATE_KEYS) {
    assertExtraction(
      finiteNonNegative(rate[key]) || (key.startsWith("cache") && rate[key] === null),
      `${label}.${key} must be a non-negative number or an explicit null cache sentinel`,
    )
  }
}

export function validateCommittedCatalog(catalog, now = new Date()) {
  assertExtraction(isPlainObject(catalog), "models.json must contain an object")
  assertExtraction(catalog.schemaVersion === 2, "models.json schemaVersion must be 2")
  assertExtraction(isPlainObject(catalog.source), "models.json source metadata is missing")
  assertExtraction(Array.isArray(catalog.models) && catalog.models.length > 0, "models.json models must not be empty")
  assertExtraction(
    Array.isArray(catalog.source.pricingDocs?.rows),
    "models.json source.pricingDocs.rows must be an array",
  )
  const docsRows = normalizeDocsRows(catalog.source.pricingDocs.rows)
  assertExtraction(
    JSON.stringify(docsRows) === JSON.stringify(catalog.source.pricingDocs.rows),
    "committed pricing rows are not in canonical form",
  )

  const modelIds = new Set()
  const docsIds = new Set()
  for (const [index, model] of catalog.models.entries()) {
    const label = `models.json model ${index}`
    assertExtraction(isPlainObject(model), `${label} must be an object`)
    for (const key of [
      "key",
      "id",
      "docsId",
      "provider",
      "spec",
      "label",
      "name",
      "description",
      "reasoning",
      "contextWindow",
      "maxOutputTokens",
    ]) {
      assertExtraction(Object.hasOwn(model, key), `${label}.${key} is required`)
    }
    requiredString(model.id, `${label}.id`)
    requiredString(model.docsId, `${label}.docsId`)
    assertExtraction(!modelIds.has(model.id), `duplicate committed model id ${model.id}`)
    assertExtraction(!docsIds.has(model.docsId), `duplicate committed docs id ${model.docsId}`)
    modelIds.add(model.id)
    docsIds.add(model.docsId)
    assertExtraction(typeof model.reasoning === "boolean", `${label}.reasoning must be boolean`)
    assertExtraction(
      model.reasoningEfforts === null ||
        (Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.every((v) => typeof v === "string")),
      `${label}.reasoningEfforts must be a string array or null`,
    )
    assertExtraction(Number.isInteger(model.contextWindow) && model.contextWindow > 0, `${label}.contextWindow is invalid`)
    assertExtraction(
      Number.isInteger(model.maxOutputTokens) && model.maxOutputTokens > 0,
      `${label}.maxOutputTokens is invalid`,
    )
  }

  const rowById = new Map(docsRows.map((row) => [row.id, row]))
  for (const model of catalog.models) {
    const row = rowById.get(model.docsId)
    assertExtraction(row !== undefined, `missing docs row ${model.docsId} for ${model.id}`)
    assertExtraction(row.deprecated === false, `model ${model.id} maps to deprecated docs row ${model.docsId}`)
    validateCommittedRate(row.tiers[0].rates, `pricing docs row ${row.id} first-tier rates`)
    if (row.deal?.expires) {
      assertExtraction(
        row.tiers[0].listRates !== null,
        `pricing docs row ${row.id} has an expiring deal without first-tier listRates`,
      )
      validateCommittedRate(row.tiers[0].listRates, `pricing docs row ${row.id} first-tier list rates`)
    }
  }

  const mapped = new Set(catalog.models.map((model) => model.docsId))
  const docsOnly = docsRows.filter((row) => !row.deprecated && !mapped.has(row.id)).map((row) => row.id)
  const deprecated = docsRows.filter((row) => row.deprecated).map((row) => row.id)
  assertExtraction(
    JSON.stringify(docsOnly) === JSON.stringify(catalog.source.pricingDocs.docsOnlyActive),
    "docs-only active rows do not match source.pricingDocs.docsOnlyActive",
  )
  assertExtraction(
    JSON.stringify(deprecated) === JSON.stringify(catalog.source.pricingDocs.deprecated),
    "deprecated rows do not match source.pricingDocs.deprecated",
  )
  assertExtraction(
    docsRows.length === catalog.source.pricingDocs.expectedRowCount,
    "pricing row count does not match source.pricingDocs.expectedRowCount",
  )
  assertExtraction(
    catalog.models.length === catalog.source.providerApi.expectedModelCount,
    "model count does not match source.providerApi.expectedModelCount",
  )

  assertExtraction(Array.isArray(catalog.sourceConflicts), "models.json sourceConflicts must be an array")
  const conflictKeys = new Set()
  for (const [index, conflict] of catalog.sourceConflicts.entries()) {
    const label = `source conflict ${index}`
    assertExtraction(isPlainObject(conflict), `${label} must be an object`)
    requiredString(conflict.modelId, `${label}.modelId`)
    requiredString(conflict.field, `${label}.field`)
    assertExtraction(modelIds.has(conflict.modelId), `${label} references unknown model ${conflict.modelId}`)
    const key = `${conflict.modelId}:${conflict.field}`
    assertExtraction(!conflictKeys.has(key), `duplicate ${label} for ${key}`)
    conflictKeys.add(key)
    for (const side of ["chosen", "conflicting"]) {
      assertExtraction(isPlainObject(conflict[side]), `${label}.${side} must be an object`)
      requiredString(conflict[side].source, `${label}.${side}.source`)
      assertExtraction(Object.hasOwn(conflict[side], "value"), `${label}.${side}.value is required`)
    }
    assertExtraction(
      JSON.stringify(conflict.chosen.value) !== JSON.stringify(conflict.conflicting.value),
      `${label} does not describe a real value conflict`,
    )
    const model = catalog.models.find((entry) => entry.id === conflict.modelId)
    if (conflict.field === "reasoning") {
      assertExtraction(
        conflict.chosen.value === model.reasoning,
        `${label}.chosen.value does not match the committed model`,
      )
    }
    requiredString(conflict.rationale, `${label}.rationale`)
    requiredString(conflict.evidence, `${label}.evidence`)
    requiredString(conflict.verifiedAt, `${label}.verifiedAt`)
    const verifiedAt = Date.parse(conflict.verifiedAt)
    assertExtraction(!Number.isNaN(verifiedAt), `${label}.verifiedAt must be an ISO date`)
    const ageMs = now.getTime() - verifiedAt
    assertExtraction(ageMs >= 0, `${label}.verifiedAt must not be in the future`)
    assertExtraction(ageMs <= 180 * 24 * 60 * 60 * 1000, `${label} is older than 180 days`)
    if (conflict.reviewAfter !== undefined) {
      parseStrictIsoDate(conflict.reviewAfter, `${label}.reviewAfter`)
    }
  }
  return catalog
}

function pushDiff(diffs, path, committed, live) {
  if (JSON.stringify(committed) !== JSON.stringify(live)) diffs.push({ path, committed, live })
}

export function compareCatalog(catalog, providerModels, docsRows) {
  validateCommittedCatalog(catalog)
  const normalizedDocsRows = normalizeDocsRows(docsRows)
  const diffs = []
  pushDiff(diffs, "source.providerApi.expectedModelCount", catalog.models.length, providerModels.length)
  pushDiff(
    diffs,
    "models.order",
    catalog.models.map((model) => model.id),
    providerModels.map((model) => model.id),
  )
  const liveProviderById = new Map(providerModels.map((model) => [model.id, model]))
  for (const model of catalog.models) {
    const live = liveProviderById.get(model.id)
    if (!live) continue
    pushDiff(diffs, `models.${model.id}.name`, model.name, live.name)
    pushDiff(diffs, `models.${model.id}.contextWindow`, model.contextWindow, live.contextWindow)
  }
  pushDiff(diffs, "source.pricingDocs.rows", catalog.source.pricingDocs.rows, normalizedDocsRows)
  return diffs
}

export function buildProposal(catalog, providerModels, docsRows) {
  return {
    schemaVersion: 1,
    writesPerformed: false,
    diffs: compareCatalog(catalog, providerModels, docsRows),
  }
}

export function catalogDateWarnings(rows, now = new Date(), sourceConflicts = []) {
  const nowMs = now.getTime()
  const warnings = []
  for (const row of rows) {
    if (row.deprecated) continue
    if (row.deal?.expires && Date.parse(row.deal.expires) <= nowMs) {
      warnings.push(`${row.id}: documented deal expiry has passed (${row.deal.expires})`)
    }
    if (row.priceChangeNote?.effective && Date.parse(row.priceChangeNote.effective) <= nowMs) {
      warnings.push(
        `${row.id}: documented price-change date has arrived (${row.priceChangeNote.effective})`,
      )
    }
    if (row.timeOfDay?.effective && Date.parse(row.timeOfDay.effective) <= nowMs) {
      warnings.push(
        `${row.id}: documented time-of-day pricing date has arrived (${row.timeOfDay.effective})`,
      )
    }
  }
  for (const conflict of sourceConflicts) {
    if (conflict.reviewAfter !== undefined) {
      const reviewAfterMs = parseStrictIsoDate(
        conflict.reviewAfter,
        `${conflict.modelId}.reviewAfter`,
      )
      if (reviewAfterMs > nowMs) continue
      warnings.push(
        `${conflict.modelId}: source-conflict review date has arrived (${conflict.reviewAfter})`,
      )
    }
  }
  return warnings
}

export async function fetchSource(
  url,
  accept,
  fetchImpl = fetch,
  retries = 2,
  delayImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept, "user-agent": "omp-commandcode-provider-model-check/1" },
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      })
      if (response.status >= 300 && response.status < 400) {
        throw extractionFailure(`unexpected redirect from ${url}`)
      }
      if (response.status === 429) {
        throw transientFailure(
          `HTTP 429 from ${url}`,
          undefined,
          parseRetryAfterMs(response.headers.get("retry-after")),
        )
      }
      if (response.status >= 500) throw transientFailure(`HTTP ${response.status} from ${url}`)
      if (!response.ok) throw extractionFailure(`HTTP ${response.status} from ${url}`)
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim()
      if (contentType !== accept) {
        throw extractionFailure(`unexpected content-type ${contentType ?? "<missing>"} from ${url}`)
      }
      // Consume the body inside the retry boundary. A timeout or connection
      // reset after headers is still a transient transport failure, while a
      // successfully read but malformed payload is classified by its parser.
      return await response.text()
    } catch (error) {
      if (error instanceof CatalogSourceError && error.kind === "extraction") throw error
      lastError = error
      if (attempt < retries) {
        const retryAfterMs =
          error instanceof CatalogSourceError ? error.retryAfterMs : undefined
        if (retryAfterMs !== undefined && retryAfterMs > MAX_SOURCE_RETRY_DELAY_MS) {
          throw error
        }
        await delayImpl(retryAfterMs ?? 250 * 2 ** attempt)
      }
    }
  }
  if (lastError instanceof CatalogSourceError) throw lastError
  throw transientFailure(`unable to fetch ${url}`, lastError)
}

export async function fetchLiveCatalog(fetchImpl = fetch) {
  const [providerText, docsHtml] = await Promise.all([
    fetchSource(PROVIDER_MODELS_URL, "application/json", fetchImpl),
    fetchSource(PRICING_DOCS_URL, "text/html", fetchImpl),
  ])
  let providerPayload
  try {
    providerPayload = JSON.parse(providerText)
  } catch (error) {
    throw extractionFailure("Provider API response is not valid JSON", error)
  }
  return {
    providerModels: validateProviderPayload(providerPayload),
    docsRows: extractPricingRowsFromHtml(docsHtml),
    docsHtml,
  }
}
