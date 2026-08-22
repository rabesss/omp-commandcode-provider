export interface CatalogRates {
  input: number
  output: number
  cacheRead: number | null
  cacheWrite: number | null
}

export interface CatalogTier {
  label: string | null
  context: string | null
  rates: CatalogRates
  listRates: CatalogRates | null
}

export interface CatalogDocsRow {
  id: string
  name: string
  category: string
  deprecated: boolean
  contextWindow: number | null
  availability: Record<string, boolean>
  caps: { text: boolean; vision: boolean; reasoning: boolean }
  tiers: CatalogTier[]
  deal?: { expires?: string }
  timeOfDay?: {
    effective: string
    peak: CatalogRates
    offPeak: CatalogRates
    peakHoursPerDay: number
    offPeakHoursPerDay: number
    windows: string
    tip: string
  }
}

export interface CatalogModel {
  key: string
  id: string
  docsId: string
  provider: string
  spec: string
  label: string
  name: string
  description: string
  reasoning: boolean
  reasoningEfforts: string[] | null
  contextWindow: number
  maxOutputTokens: number
  vendorLabel: string | null
}

export interface ModelsJson {
  schemaVersion: number
  source: {
    pricingDocs: {
      staticPricingPolicy: string
      rows: CatalogDocsRow[]
    }
  }
  models: CatalogModel[]
}

export interface RuntimeCatalogModel extends CatalogModel {
  availableOnIndividualGo: boolean
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  pricingBasis: "effective-first-tier" | "list-first-tier" | "time-of-day-peak"
  cacheReadSupported: boolean
  cacheWriteSupported: boolean
}

export interface RuntimeCatalogResult {
  models: RuntimeCatalogModel[]
  issues: string[]
}

export function reportRuntimeCatalogIssues(
  issues: readonly string[],
  warn: (message: string) => void = console.warn,
): void {
  for (const issue of issues) warn(`[commandcode] skipped catalog entry: ${issue}`)
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function staticRates(row: CatalogDocsRow): {
  rates: CatalogRates
  basis: RuntimeCatalogModel["pricingBasis"]
} | undefined {
  const firstTier = row.tiers?.[0]
  if (!firstTier) return undefined

  // OMP can expose only one static rate. For time-of-day pricing, use the
  // documented peak rate so estimates never understate the possible charge.
  if (row.timeOfDay) {
    return { rates: row.timeOfDay.peak, basis: "time-of-day-peak" }
  }
  // Date-bounded discounts make a committed runtime price silently stale when
  // the date rolls over. Keep their list rate static; permanent/current prices
  // use the documented first tier. The maintenance check still records deals.
  if (row.deal?.expires) {
    return firstTier.listRates
      ? { rates: firstTier.listRates, basis: "list-first-tier" }
      : undefined
  }
  return { rates: firstTier.rates, basis: "effective-first-tier" }
}

export function buildRuntimeCatalog(catalog: ModelsJson): RuntimeCatalogResult {
  const issues: string[] = []
  const rowsById = new Map<string, CatalogDocsRow>()
  const duplicateDocsIds = new Set<string>()

  for (const row of catalog.source?.pricingDocs?.rows ?? []) {
    if (rowsById.has(row.id)) duplicateDocsIds.add(row.id)
    else rowsById.set(row.id, row)
  }

  const modelIds = new Set<string>()
  const models: RuntimeCatalogModel[] = []
  for (const model of catalog.models ?? []) {
    if (modelIds.has(model.id)) {
      issues.push(`duplicate model id ${model.id}`)
      continue
    }
    modelIds.add(model.id)

    if (duplicateDocsIds.has(model.docsId)) {
      issues.push(`duplicate docs pricing id ${model.docsId} for ${model.id}`)
      continue
    }
    const row = rowsById.get(model.docsId)
    if (!row || row.deprecated) {
      issues.push(`missing active docs pricing row ${model.docsId} for ${model.id}`)
      continue
    }
    const selected = staticRates(row)
    if (!selected) {
      issues.push(`missing first-tier pricing for ${model.id}`)
      continue
    }
    if (!selected.rates || typeof selected.rates !== "object") {
      issues.push(`invalid first-tier pricing for ${model.id}`)
      continue
    }
    const { input, output, cacheRead, cacheWrite } = selected.rates
    if (
      !finiteNonNegative(input) ||
      !finiteNonNegative(output) ||
      !(cacheRead === null || finiteNonNegative(cacheRead)) ||
      !(cacheWrite === null || finiteNonNegative(cacheWrite))
    ) {
      // OMP requires a complete numeric cost object. Skipping only the corrupt
      // model avoids both a false free-price claim and a total provider outage.
      issues.push(`invalid first-tier pricing for ${model.id}`)
      continue
    }

    models.push({
      ...model,
      availableOnIndividualGo: row.availability?.["individual-go"] === true,
      cost: {
        input,
        output,
        cacheRead: cacheRead ?? 0,
        cacheWrite: cacheWrite ?? 0,
      },
      pricingBasis: selected.basis,
      cacheReadSupported: cacheRead !== null,
      cacheWriteSupported: cacheWrite !== null,
    })
  }

  return { models, issues }
}

export function isAvailableOnIndividualGo(catalog: ModelsJson, modelId: string): boolean | undefined {
  const model = catalog.models?.find((entry) => entry.id === modelId)
  if (!model) return undefined
  const row = catalog.source?.pricingDocs?.rows?.find((entry) => entry.id === model.docsId)
  return row?.availability?.["individual-go"]
}
