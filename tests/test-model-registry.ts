import assert from "node:assert/strict"
import { describe, it } from "node:test"

import commandCodeExtension from "../index.ts"
import modelsJson from "../models.json" with { type: "json" }
import { VISION_MODEL_IDS } from "../src/model-capabilities.ts"

function pricingForModelId(modelId: string) {
  return modelsJson.pricing.find((entry) => {
    const colonIdx = entry.id.indexOf(":")
    const pricingModelId = colonIdx > 0 ? entry.id.slice(colonIdx + 1) : entry.id
    return pricingModelId === modelId || entry.id === modelId
  })
}

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
  "moonshotai/Kimi-K3",
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K2.7-Code-Highspeed",
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.5",
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
  "Qwen/Qwen3.7-Max",
  "Qwen/Qwen3.7-Plus",
  "Qwen/Qwen3.7-Flash",
  "Qwen/Qwen3.6-Max-Preview",
  "Qwen/Qwen3.6-Plus",
  "stepfun/Step-3.7-Flash",
  "stepfun/Step-3.5-Flash",
  "tencent/hy3-paid",
  "google/gemini-3.6-flash",
  "google/gemini-3.5-flash",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.1-flash-lite",
  "sakana/fugu-ultra",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "thinkingmachines/inkling",
  "thinkingmachines/inkling-small",
  "poolside/laguna-s-2.1-free",
  "meta/muse-spark-1.1",
  "meta/muse-spark-1.2",
  "meta/muse-spark-1.2-contributor",
  "xai/grok-4.5",
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
            thinking?: { mode: string; efforts: readonly string[] }
          }>
        }
      },
    })

    assert.equal(providerName, "commandcode")
    assert.equal(providerConfig?.apiKey, "COMMAND_CODE_API_KEY")
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
    assert.equal(
      providerConfig?.models?.find((model) => model.id === "moonshotai/Kimi-K3")?.thinking,
      undefined,
    )
  })

  it("prefers stored login credentials over the environment fallback", () => {
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
    assert.deepEqual(removed, ["commandcode"])

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
    assert.deepEqual(removed, [])
  })

  it("resolves a pricing row for every committed model id", () => {
    for (const model of modelsJson.models) {
      assert.ok(
        pricingForModelId(model.id),
        `missing pricing row for model id ${model.id}`,
      )
    }
  })

  it("keeps capability sets within the committed catalog", () => {
    const catalog = new Set(modelsJson.models.map((model) => model.id))
    for (const modelId of VISION_MODEL_IDS) {
      assert.ok(catalog.has(modelId), `vision override is not in models.json: ${modelId}`)
    }
  })

  it("only advertises zero pricing for the explicitly free model", () => {
    const zeroPriced = modelsJson.models
      .filter((model) => {
        const pricing = pricingForModelId(model.id)
        return pricing?.promptCost === 0 && pricing.completionCost === 0
      })
      .map((model) => model.id)

    assert.deepEqual(zeroPriced, ["poolside/laguna-s-2.1-free"])
  })
})
