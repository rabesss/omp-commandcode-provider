import assert from "node:assert/strict"
import { describe, it } from "node:test"

import commandCodeExtension from "../index.ts"
import modelsJson from "../models.json" with { type: "json" }

const expectedModels = [
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-haiku-4-5-20251001",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.5",
  "zai-org/GLM-5.1",
  "zai-org/GLM-5",
  "MiniMaxAI/MiniMax-M2.7",
  "MiniMaxAI/MiniMax-M2.5",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "Qwen/Qwen3.6-Max-Preview",
  "Qwen/Qwen3.6-Plus",
  "Qwen/Qwen3.7-Max",
  "stepfun/Step-3.5-Flash",
  "xiaomi/mimo-v2.5-pro",
  "xiaomi/mimo-v2.5",
  "google/gemini-3.5-flash",
  "google/gemini-3.1-flash-lite",
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
      | { models?: Array<{ id: string; contextWindow: number; maxTokens: number }> }
      | undefined

    commandCodeExtension({
      registerProvider(name, config) {
        providerName = name
        providerConfig = config as {
          models?: Array<{ id: string; contextWindow: number; maxTokens: number }>
        }
      },
    })

    assert.equal(providerName, "commandcode")
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
  })
})
