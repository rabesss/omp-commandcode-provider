/**
 * Command Code provider for OMP.
 *
 * Connects OMP to Command Code's API (https://api.commandcode.ai/alpha/generate).
 *
 * Authentication (pick one):
 *   1. Run `/login`, then select Command Code - opens browser to commandcode.ai, auto-stores API key
 *   2. Set COMMANDCODE_API_KEY environment variable
 *   3. Place API key in `~/.commandcode/auth.json` or legacy `~/.pi/agent/auth.json`
 *      as {"apiKey": "user_..."} or {"commandcode": "user_..."}
 *
 * Models are sourced from the reviewed, committed models.json registry.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"

import modelsJsonData from "./models.json" with { type: "json" }
import { COMMAND_CODE_CLI_VERSION, createStreamCommandCode, DEFAULT_API_BASE } from "./src/core.ts"
import { getApiKey, login, refreshToken } from "./src/oauth.ts"
import { calculateCost, createAssistantMessageEventStream } from "./src/runtime.ts"

const API_BASE = process.env.COMMANDCODE_API_BASE ?? DEFAULT_API_BASE

// ---------------------------------------------------------------------------
// Load model definitions from models.json
// ---------------------------------------------------------------------------

interface ModelsJson {
  providers: Record<string, string>
  models: Array<{
    key: string
    id: string
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
  }>
  pricing: Array<{
    provider: string
    id: string
    category: string
    promptCost: number
    completionCost: number
    cacheWrite5mCost: number
    cacheWrite1hCost: number
    cacheHitCost: number
  }>
}

const modelsJson = modelsJsonData as ModelsJson

const MODEL_OVERRIDES: Record<string, { contextWindow?: number; maxTokens?: number }> = {
  // OMP represents the usable input context separately from the output budget.
  "gpt-5.3-codex": { contextWindow: 272_000 },
  // Command Code currently rejects params.max_tokens above 200K.
  "deepseek/deepseek-v4-pro": { maxTokens: 200_000 },
  "deepseek/deepseek-v4-flash": { maxTokens: 200_000 },
}

// ---------------------------------------------------------------------------
// Build cost lookup (model id -> pricing)
// ---------------------------------------------------------------------------

const costByModelId = new Map<string, ModelsJson["pricing"][number]>()
for (const p of modelsJson.pricing) {
  // Pricing id is like "anthropic:claude-sonnet-4-6"
  const colonIdx = p.id.indexOf(":")
  if (colonIdx > 0) {
    costByModelId.set(p.id.substring(colonIdx + 1), p)
  }
  costByModelId.set(p.id, p)
}

// ---------------------------------------------------------------------------
// Build OMP model list (all defaults come from models.json)
// ---------------------------------------------------------------------------

const MODELS = modelsJson.models.map((m) => {
  const cost = costByModelId.get(m.id)
  const override = MODEL_OVERRIDES[m.id]
  return {
    id: m.id,
    name: `${m.name} (CC)`,
    reasoning: m.reasoning,
    contextWindow: override?.contextWindow ?? m.contextWindow,
    maxTokens: override?.maxTokens ?? m.maxOutputTokens,
    cost: {
      input: cost?.promptCost ?? 0,
      output: cost?.completionCost ?? 0,
      cacheRead: cost?.cacheHitCost ?? 0,
      cacheWrite: Math.max(cost?.cacheWrite5mCost ?? 0, cost?.cacheWrite1hCost ?? 0),
    },
  }
})

// ---------------------------------------------------------------------------
// Stream factory
// ---------------------------------------------------------------------------

const streamCommandCode = createStreamCommandCode({
  createStream: createAssistantMessageEventStream,
  calculateCost,
  apiBase: API_BASE,
})

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerProvider("commandcode", {
    name: "Command Code",
    baseUrl: API_BASE,
    apiKey: "COMMANDCODE_API_KEY",
    authHeader: true,
    api: "commandcode-custom",
    streamSimple: streamCommandCode,
    headers: {
      "x-command-code-version": COMMAND_CODE_CLI_VERSION,
      "x-cli-environment": "production",
    },
    oauth: {
      name: "Command Code",
      login,
      refreshToken,
      getApiKey,
    },
    models: MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: ["text"] as const,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  })
}
