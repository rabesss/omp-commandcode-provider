#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  buildProposal,
  catalogDateWarnings,
  CatalogSourceError,
  compareCatalog,
  EXIT_CODES,
  fetchLiveCatalog,
  validateCommittedCatalog,
} from "./model-catalog-lib.mjs"

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const modelsPath = resolve(projectDir, "models.json")
const args = process.argv.slice(2)

if (args.some((arg) => !["--proposal"].includes(arg)) || args.length > 1) {
  console.error("Usage: node scripts/sync-upstream-models.mjs [--proposal]")
  process.exit(EXIT_CODES.USAGE)
}

try {
  const committed = validateCommittedCatalog(JSON.parse(await readFile(modelsPath, "utf8")))
  const { providerModels, docsRows } = await fetchLiveCatalog()

  if (args.includes("--proposal")) {
    console.log(JSON.stringify(buildProposal(committed, providerModels, docsRows), null, 2))
    process.exit(EXIT_CODES.CLEAN)
  }

  const diffs = compareCatalog(committed, providerModels, docsRows)
  if (diffs.length > 0) {
    console.error(`[models] drift detected in ${diffs.length} catalog path(s)`)
    for (const diff of diffs) console.error(`[models] ${diff.path}`)
    console.error("[models] run `npm run models:proposal` for a deterministic read-only report")
    process.exit(EXIT_CODES.DRIFT)
  }

  for (const warning of catalogDateWarnings(docsRows)) {
    console.warn(`[models] warning: ${warning}`)
  }

  const goCount = docsRows.filter(
    (row) => !row.deprecated && row.availability["individual-go"],
  ).length
  const mappedDocs = new Set(committed.models.map((model) => model.docsId))
  const docsOnlyCount = docsRows.filter((row) => !row.deprecated && !mappedDocs.has(row.id)).length
  const deprecatedCount = docsRows.filter((row) => row.deprecated).length
  console.log(
    `[models] synchronized: ${providerModels.length} live, ${goCount} Individual Go, ${docsOnlyCount} docs-only, ${deprecatedCount} deprecated`,
  )
} catch (error) {
  if (error instanceof CatalogSourceError) {
    console.error(`[models] ${error.kind} failure: ${error.message}`)
    process.exit(
      error.kind === "transient" ? EXIT_CODES.TRANSIENT_FAILURE : EXIT_CODES.EXTRACTION_FAILURE,
    )
  }
  console.error(`[models] unexpected failure: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(EXIT_CODES.EXTRACTION_FAILURE)
}
