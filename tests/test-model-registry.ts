import assert from "node:assert/strict"
import { describe, it } from "node:test"

import commandCodeExtension from "../index.ts"
import modelsJson from "../models.json" with { type: "json" }
import { VISION_MODEL_IDS } from "../src/model-capabilities.ts"
import {
  buildRuntimeCatalog,
  isAvailableOnIndividualGo,
  reportRuntimeCatalogIssues,
} from "../src/model-registry.ts"

function docsRowForModelId(modelId: string) {
  const model = modelsJson.models.find((entry) => entry.id === modelId)
  return modelsJson.source.pricingDocs.rows.find((entry) => entry.id === model?.docsId)
}

const runtimeCatalog = buildRuntimeCatalog(modelsJson)

const expectedModels = [
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-haiku-4-5-20251001",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-vision-exp",
  "moonshotai/Kimi-K3",
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K2.7-Code-Highspeed",
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.5",
  "zai-org/GLM-5.3",
  "zai-org/GLM-5.2",
  "zai-org/GLM-5.2-Fast",
  "zai-org/GLM-5.1",
  "zai-org/GLM-5",
  "MiniMaxAI/MiniMax-M3",
  "MiniMaxAI/MiniMax-M2.7",
  "MiniMaxAI/MiniMax-M2.5",
  "xiaomi/mimo-v2.5-pro",
  "xiaomi/mimo-v2.5",
  "Qwen/Qwen3.8-Max",
  "Qwen/Qwen3.8-27B",
  "Qwen/Qwen3.7-Max",
  "Qwen/Qwen3.7-Plus",
  "Qwen/Qwen3.7-Flash",
  "Qwen/Qwen3.6-Max-Preview",
  "Qwen/Qwen3.6-Plus",
  "stepfun/Step-3.7-Flash",
  "stepfun/Step-3.5-Flash",
  "tencent/hy3-paid",
  "google/gemini-3.7-flash",
  "google/gemini-3.6-flash",
  "google/gemini-3.5-flash",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.1-flash-lite",
  "sakana/fugu-ultra",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "thinkingmachines/inkling",
  "thinkingmachines/inkling-small",
  "stealth/ox-alpha",
  "poolside/laguna-s-2.1-free",
  "meta/muse-spark-1.1",
  "meta/muse-spark-1.2",
  "meta/muse-spark-1.2-contributor",
  "xai/grok-4.5",
  "xai/grok-4.6",
]

describe("Command Code model registry", () => {
  it("retains every model in the audited upstream snapshot", () => {
    assert.deepEqual(
      modelsJson.models.map((model) => model.id),
      expectedModels,
    )
  })

  it("registers every committed model with OMP", () => {
    let providerName = ""
    let providerConfig:
      | {
          apiKey?: string
          models?: Array<{
            id: string
            input: readonly string[]
            contextWindow: number
            maxTokens: number
            reasoning: boolean
            cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
            thinking?: { mode: string; efforts: readonly string[] }
          }>
        }
      | undefined

    commandCodeExtension({
      on() {},
      registerProvider(name, config) {
        providerName = name
        providerConfig = config as {
          apiKey?: string
          models?: Array<{
            id: string
            input: readonly string[]
            contextWindow: number
            maxTokens: number
            reasoning: boolean
            cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
            thinking?: { mode: string; efforts: readonly string[] }
          }>
        }
      },
    })

    assert.equal(providerName, "commandcode")
    assert.notEqual(providerConfig?.apiKey, "COMMAND_CODE_API_KEY")
    assert.deepEqual(
      providerConfig?.models?.map((model) => model.id),
      expectedModels,
    )
    const gpt53Codex = providerConfig?.models?.find((model) => model.id === "gpt-5.3-codex")
    const deepSeekFlash = providerConfig?.models?.find(
      (model) => model.id === "deepseek/deepseek-v4-flash",
    )
    const deepSeekPro = providerConfig?.models?.find(
      (model) => model.id === "deepseek/deepseek-v4-pro",
    )
    assert.equal(gpt53Codex?.contextWindow, 272_000)
    assert.equal(deepSeekFlash?.maxTokens, 200_000)
    assert.equal(deepSeekPro?.maxTokens, 200_000)
    assert.equal(
      providerConfig?.models?.find((model) => model.id === "xiaomi/mimo-v2.5-pro")?.contextWindow,
      1_000_000,
    )
    assert.deepEqual(
      providerConfig?.models?.find((model) => model.id === "claude-opus-4-8")?.input,
      ["text", "image"],
    )
    assert.deepEqual(
      providerConfig?.models?.find((model) => model.id === "gpt-5.3-codex")?.input,
      ["text", "image"],
    )
    assert.deepEqual(
      providerConfig?.models?.find((model) => model.id === "google/gemini-3.1-flash-lite")?.input,
      ["text", "image"],
    )
    assert.deepEqual(
      providerConfig?.models?.find((model) => model.id === "moonshotai/Kimi-K2.7-Code")?.input,
      ["text", "image"],
    )
    assert.deepEqual(
      providerConfig?.models?.find((model) => model.id === "moonshotai/Kimi-K2.7-Code-Highspeed")
        ?.input,
      ["text", "image"],
    )
    assert.deepEqual(
      providerConfig?.models?.find((model) => model.id === "stealth/ox-alpha")?.input,
      ["text", "image"],
    )
    assert.deepEqual(
      providerConfig?.models?.find((model) => model.id === "sakana/fugu-ultra")?.input,
      ["text", "image"],
    )
    assert.deepEqual(
      providerConfig?.models?.find((model) => model.id === "deepseek/deepseek-v4-flash")?.input,
      ["text"],
    )
    assert.deepEqual(
      providerConfig?.models?.find((model) => model.id === "zai-org/GLM-5.2")?.input,
      ["text"],
    )
    assert.deepEqual(
      providerConfig?.models?.find((model) => model.id === "claude-sonnet-5")?.thinking,
      { mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] },
    )
    assert.deepEqual(
      providerConfig?.models?.find((model) => model.id === "stealth/ox-alpha")?.thinking,
      { mode: "effort", efforts: ["low", "high", "max"] },
    )
    assert.equal(
      providerConfig?.models?.find((model) => model.id === "stealth/ox-alpha")?.contextWindow,
      1_048_576,
    )
    assert.equal(
      providerConfig?.models?.find((model) => model.id === "stealth/ox-alpha")?.maxTokens,
      131_072,
    )
    assert.equal(
      providerConfig?.models?.find((model) => model.id === "moonshotai/Kimi-K3")?.thinking,
      undefined,
    )
    assert.equal(
      providerConfig?.models?.find((model) => model.id === "MiniMaxAI/MiniMax-M3")?.reasoning,
      true,
    )
    assert.equal(
      providerConfig?.models?.find((model) => model.id === "xiaomi/mimo-v2.5-pro")?.reasoning,
      false,
    )
    assert.equal(
      providerConfig?.models?.find((model) => model.id === "xiaomi/mimo-v2.5")?.reasoning,
      false,
    )
    assert.equal(
      providerConfig?.models?.find((model) => model.id === "claude-sonnet-4-6")?.reasoning,
      false,
    )
    assert.equal(
      providerConfig?.models?.find((model) => model.id === "claude-sonnet-4-6")?.cost.cacheWrite,
      3.75,
    )
    assert.equal(
      providerConfig?.models?.find((model) => model.id === "claude-opus-4-7")?.cost.cacheWrite,
      6.25,
    )
    assert.equal(
      providerConfig?.models?.find((model) => model.id === "claude-haiku-4-5-20251001")?.cost
        .cacheWrite,
      1.25,
    )
    assert.equal(
      providerConfig?.models?.find((model) => model.id === "gpt-5.6-terra")?.cost.input,
      2,
    )
    assert.equal(
      providerConfig?.models?.find((model) => model.id === "deepseek/deepseek-v4-pro")?.cost.input,
      1.32,
    )
    assert.equal(
      runtimeCatalog.models.find((model) => model.id === "deepseek/deepseek-v4-pro")?.pricingBasis,
      "time-of-day-peak",
    )
  })

  it("registers a real environment key but never an unresolved placeholder", () => {
    const canonical = process.env.COMMAND_CODE_API_KEY
    const legacy = process.env.COMMANDCODE_API_KEY
    try {
      process.env.COMMAND_CODE_API_KEY = "user_current_environment_key"
      process.env.COMMANDCODE_API_KEY = "user_legacy_environment_key"
      let apiKey: string | undefined
      commandCodeExtension({
        on() {},
        registerProvider(_name, config) {
          apiKey = config.apiKey
        },
      })
      assert.equal(apiKey, "user_current_environment_key")

      delete process.env.COMMAND_CODE_API_KEY
      commandCodeExtension({
        on() {},
        registerProvider(_name, config) {
          apiKey = config.apiKey
        },
      })
      assert.equal(apiKey, "user_legacy_environment_key")

      delete process.env.COMMANDCODE_API_KEY
      commandCodeExtension({
        on() {},
        registerProvider(_name, config) {
          apiKey = config.apiKey
        },
      })
      assert.equal(apiKey, undefined)
    } finally {
      if (canonical === undefined) delete process.env.COMMAND_CODE_API_KEY
      else process.env.COMMAND_CODE_API_KEY = canonical
      if (legacy === undefined) delete process.env.COMMANDCODE_API_KEY
      else process.env.COMMANDCODE_API_KEY = legacy
    }
  })

  it("prefers the current pasted login key over legacy OAuth and environment fallbacks", () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()

    commandCodeExtension({
      on(event, handler) {
        handlers.set(event, handler)
      },
      registerProvider() {},
    })

    assert.ok(handlers.has("session_start"))
    assert.ok(handlers.has("before_provider_request"))

    const removed: string[] = []
    const context: {
      model: { provider: string } | undefined
      modelRegistry: {
        authStorage: {
          has: () => boolean
          removeConfigApiKey: (provider: string) => number
        }
      }
    } = {
      model: { provider: "commandcode" },
      modelRegistry: {
        authStorage: {
          has: () => true,
          removeConfigApiKey: (provider: string) => removed.push(provider),
        },
      },
    }

    handlers.get("session_start")?.({ type: "session_start" }, context)
    assert.deepEqual(removed, ["commandcode"])

    removed.length = 0
    handlers.get("before_provider_request")?.({ type: "before_provider_request" }, context)
    handlers.get("before_provider_request")?.({ type: "before_provider_request" }, context)
    assert.deepEqual(removed, ["commandcode", "commandcode"])

    removed.length = 0
    context.model = { provider: "other" }
    handlers.get("session_start")?.({ type: "session_start" }, context)
    handlers.get("before_provider_request")?.({ type: "before_provider_request" }, context)
    assert.deepEqual(removed, [])

    context.model = undefined
    handlers.get("session_start")?.({ type: "session_start" }, context)
    handlers.get("before_provider_request")?.({ type: "before_provider_request" }, context)
    assert.deepEqual(removed, [])

    context.model = { provider: "commandcode" }
    context.modelRegistry.authStorage.has = () => false
    handlers.get("before_provider_request")?.({ type: "before_provider_request" }, context)
    assert.deepEqual(removed, ["commandcode"])

    const pinned: Array<[string, string]> = []
    handlers.get("before_provider_request")?.(
      { type: "before_provider_request" },
      {
        model: { provider: "commandcode" },
        modelRegistry: {
          authStorage: {
            has: () => true,
            getAll: () => ({
              commandcode: [
                { type: "oauth" },
                { type: "api_key", key: "older-pasted-key", source: "login" },
                { type: "api_key", key: "current-pasted-key", source: "login" },
              ],
            }),
            setConfigApiKey: (provider: string, key: string) => pinned.push([provider, key]),
            removeConfigApiKey: () => {
              throw new Error("should keep the current pasted key pinned")
            },
          },
        },
      },
    )
    assert.deepEqual(pinned, [["commandcode", "current-pasted-key"]])

    const clearedAfterDelete: string[] = []
    handlers.get("before_provider_request")?.(
      { type: "before_provider_request" },
      {
        model: { provider: "commandcode" },
        modelRegistry: {
          authStorage: {
            has: () => false,
            getAll: () => ({}),
            removeConfigApiKey: (provider: string) => clearedAfterDelete.push(provider),
          },
        },
      },
    )
    assert.deepEqual(clearedAfterDelete, ["commandcode"])

    for (const event of ["session_start", "before_provider_request"]) {
      assert.doesNotThrow(() => {
        handlers.get(event)?.(
          { type: event },
          { model: { provider: "commandcode" } },
        )
      })
      assert.doesNotThrow(() => {
        handlers.get(event)?.(
          { type: event },
          { model: { provider: "commandcode" }, modelRegistry: {} },
        )
      })
    }
  })

  it("maps every committed model to exactly one active docs row", () => {
    assert.deepEqual(runtimeCatalog.issues, [])
    assert.equal(runtimeCatalog.models.length, expectedModels.length)
    for (const model of modelsJson.models) {
      const row = docsRowForModelId(model.id)
      assert.ok(row, `missing docs row for model id ${model.id}`)
      assert.equal(row?.deprecated, false)
    }

    assert.equal(new Set(modelsJson.models.map((model) => model.docsId)).size, 58)
    assert.deepEqual(modelsJson.source.pricingDocs.docsOnlyActive, ["claude-opus-4-6"])
    assert.deepEqual(modelsJson.source.pricingDocs.deprecated, [
      "ling-3.0-flash-free",
      "claude-sonnet-4-5",
    ])
  })

  it("keeps capability sets within the committed catalog", () => {
    const catalog = new Set(modelsJson.models.map((model) => model.id))
    for (const modelId of VISION_MODEL_IDS) {
      assert.ok(catalog.has(modelId), `vision override is not in models.json: ${modelId}`)
    }
    for (const model of modelsJson.models) {
      const row = docsRowForModelId(model.id)
      assert.equal(model.reasoning, row?.caps.reasoning, `${model.id} reasoning drift`)
      assert.equal(VISION_MODEL_IDS.has(model.id), row?.caps.vision, `${model.id} vision drift`)
    }
  })

  it("only advertises zero pricing for the explicitly free models", () => {
    const zeroPriced = runtimeCatalog.models
      .filter((model) => model.cost.input === 0 && model.cost.output === 0)
      .map((model) => model.id)

    assert.deepEqual(zeroPriced, ["stealth/ox-alpha", "poolside/laguna-s-2.1-free"])
  })

  it("skips only a corruptly-priced model instead of claiming it is free", () => {
    const corrupt = structuredClone(modelsJson)
    const row = corrupt.source.pricingDocs.rows.find((entry) => entry.id === "gpt-5.4")
    assert.ok(row)
    row.tiers = []

    const result = buildRuntimeCatalog(corrupt)
    assert.equal(result.models.length, 57)
    assert.ok(result.issues.includes("missing first-tier pricing for gpt-5.4"))
    assert.equal(result.models.some((model) => model.id === "gpt-5.4"), false)

    const warnings: string[] = []
    reportRuntimeCatalogIssues(result.issues, (message) => warnings.push(message))
    assert.deepEqual(warnings, [
      "[commandcode] skipped catalog entry: missing first-tier pricing for gpt-5.4",
    ])

    const missingListRate = structuredClone(modelsJson)
    const gemini37 = missingListRate.source.pricingDocs.rows.find(
      (entry) => entry.id === "gemini-3.7-flash",
    )
    assert.ok(gemini37)
    gemini37.tiers[0].listRates = null
    const missingListResult = buildRuntimeCatalog(missingListRate)
    assert.equal(missingListResult.models.some((entry) => entry.id === "google/gemini-3.7-flash"), false)
    assert.ok(missingListResult.issues.includes("missing first-tier pricing for google/gemini-3.7-flash"))

    const missingTiers = structuredClone(modelsJson)
    const missingTiersRow = missingTiers.source.pricingDocs.rows.find(
      (entry) => entry.id === "gpt-5.4",
    )
    assert.ok(missingTiersRow)
    delete (missingTiersRow as Partial<typeof missingTiersRow>).tiers
    const missingTiersResult = buildRuntimeCatalog(missingTiers)
    assert.equal(missingTiersResult.models.length, 57)
    assert.ok(missingTiersResult.issues.includes("missing first-tier pricing for gpt-5.4"))

    const missingRates = structuredClone(modelsJson)
    const missingRatesRow = missingRates.source.pricingDocs.rows.find(
      (entry) => entry.id === "gpt-5.4",
    )
    assert.ok(missingRatesRow)
    delete (missingRatesRow.tiers[0] as Partial<(typeof missingRatesRow.tiers)[number]>).rates
    const missingRatesResult = buildRuntimeCatalog(missingRates)
    assert.equal(missingRatesResult.models.length, 57)
    assert.ok(missingRatesResult.issues.includes("invalid first-tier pricing for gpt-5.4"))
  })

  it("treats missing plan availability as unavailable without failing registration", () => {
    const corrupt = structuredClone(modelsJson)
    const row = corrupt.source.pricingDocs.rows.find((entry) => entry.id === "gpt-5.4")
    assert.ok(row)
    delete (row as Partial<typeof row>).availability

    const result = buildRuntimeCatalog(corrupt)
    assert.equal(result.models.length, 58)
    assert.deepEqual(result.issues, [])
    assert.equal(
      result.models.find((entry) => entry.id === "gpt-5.4")?.availableOnIndividualGo,
      false,
    )
  })

  it("keeps plan lookup safe when optional catalog structures are corrupt", () => {
    assert.equal(isAvailableOnIndividualGo(modelsJson, "poolside/laguna-s-2.1-free"), true)
    assert.equal(
      isAvailableOnIndividualGo(
        { models: modelsJson.models } as never,
        "poolside/laguna-s-2.1-free",
      ),
      undefined,
    )
  })

  it("loads and registers synchronously when network access throws", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error("network access is forbidden during registration")
    }) as typeof fetch
    try {
      const imported = await import(`../index.ts?offline=${Date.now()}`)
      let registered = 0
      imported.default({
        on() {},
        registerProvider(_name: string, config: { models?: unknown[] }) {
          registered = config.models?.length ?? 0
        },
      })
      assert.equal(registered, 58)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
