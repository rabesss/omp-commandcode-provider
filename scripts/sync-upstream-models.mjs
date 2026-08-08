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

export async function runModelCatalogCli(
  args = process.argv.slice(2),
  {
    readFileImpl = readFile,
    fetchLiveCatalogImpl = fetchLiveCatalog,
    log = console.log,
    warn = console.warn,
    error = console.error,
  } = {},
) {
  if (args.some((arg) => !["--proposal"].includes(arg)) || args.length > 1) {
    error("Usage: node scripts/sync-upstream-models.mjs [--proposal]")
    return EXIT_CODES.USAGE
  }

  try {
    const committed = validateCommittedCatalog(JSON.parse(await readFileImpl(modelsPath, "utf8")))
    const { providerModels, docsRows } = await fetchLiveCatalogImpl()

    if (args.includes("--proposal")) {
      log(JSON.stringify(buildProposal(committed, providerModels, docsRows), null, 2))
      return EXIT_CODES.CLEAN
    }

    const diffs = compareCatalog(committed, providerModels, docsRows)
    if (diffs.length > 0) {
      error(`[models] drift detected in ${diffs.length} catalog path(s)`)
      for (const diff of diffs) error(`[models] ${diff.path}`)
      error("[models] run `npm run models:proposal` for a deterministic read-only report")
      return EXIT_CODES.DRIFT
    }

    for (const warning of catalogDateWarnings(docsRows)) {
      warn(`[models] warning: ${warning}`)
    }

    const goCount = docsRows.filter(
      (row) => !row.deprecated && row.availability["individual-go"],
    ).length
    const mappedDocs = new Set(committed.models.map((model) => model.docsId))
    const docsOnlyCount = docsRows.filter(
      (row) => !row.deprecated && !mappedDocs.has(row.id),
    ).length
    const deprecatedCount = docsRows.filter((row) => row.deprecated).length
    log(
      `[models] synchronized: ${providerModels.length} live, ${goCount} Individual Go, ${docsOnlyCount} docs-only, ${deprecatedCount} deprecated`,
    )
    return EXIT_CODES.CLEAN
  } catch (caught) {
    if (caught instanceof CatalogSourceError) {
      error(`[models] ${caught.kind} failure: ${caught.message}`)
      return caught.kind === "transient"
        ? EXIT_CODES.TRANSIENT_FAILURE
        : EXIT_CODES.EXTRACTION_FAILURE
    }
    error(
      `[models] unexpected failure: ${caught instanceof Error ? caught.message : String(caught)}`,
    )
    return EXIT_CODES.EXTRACTION_FAILURE
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runModelCatalogCli()
}
