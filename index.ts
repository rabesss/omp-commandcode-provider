/**
 * Command Code provider for OMP.
 *
 * Connects OMP to Command Code's API (https://api.commandcode.ai/alpha/generate).
 *
 * Authentication (pick one):
 *   1. Run `/login`, then select Command Code - opens browser to commandcode.ai, auto-stores API key
 *   2. Set COMMAND_CODE_API_KEY (or legacy COMMANDCODE_API_KEY) environment variable
 *   3. Place API key in `~/.commandcode/auth.json` or legacy `~/.pi/agent/auth.json`
 *      as {"apiKey": "user_..."} or {"commandcode": "user_..."}
 *
 * Models are sourced from the reviewed, committed models.json registry.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { readFileSync } from "node:fs"

import {
  COMMAND_CODE_CLI_VERSION,
  createStreamCommandCode,
  DEFAULT_API_BASE,
  modelInputModalities,
} from "./src/core.ts"
import { getApiKey, login, refreshToken } from "./src/oauth.ts"
import {
  buildRuntimeCatalog,
  isAvailableOnIndividualGo,
  reportRuntimeCatalogIssues,
  type ModelsJson,
} from "./src/model-registry.ts"
import { calculateCost, createAssistantMessageEventStream } from "./src/runtime.ts"

const API_BASE = process.env.COMMANDCODE_API_BASE ?? DEFAULT_API_BASE
const PROVIDER_ID = "commandcode"
const modelsJsonData = JSON.parse(readFileSync(new URL("./models.json", import.meta.url), "utf8"))

// ---------------------------------------------------------------------------
// Load model definitions from models.json
// ---------------------------------------------------------------------------

interface CredentialContext {
  model?: { provider: string }
  modelRegistry?: {
    authStorage?: {
      getAll?(): Record<
        string,
        | { type?: string; key?: string; source?: string }
        | Array<{ type?: string; key?: string; source?: string }>
      >
      setConfigApiKey?(provider: string, apiKey: string): void
      removeConfigApiKey(provider: string): void
    }
  }
}

const modelsJson = modelsJsonData as ModelsJson
const runtimeCatalog = buildRuntimeCatalog(modelsJson)
reportRuntimeCatalogIssues(runtimeCatalog.issues)

const MODEL_OVERRIDES: Record<string, { contextWindow?: number; maxTokens?: number }> = {
  // OMP represents the usable input context separately from the output budget.
  "gpt-5.3-codex": { contextWindow: 272_000 },
  // Command Code currently rejects params.max_tokens above 200K.
  "deepseek/deepseek-v4-pro": { maxTokens: 200_000 },
  "deepseek/deepseek-v4-flash": { maxTokens: 200_000 },
}

// ---------------------------------------------------------------------------
// Build OMP model list (all defaults come from models.json)
// ---------------------------------------------------------------------------

const MODELS = runtimeCatalog.models.map((m) => {
  const override = MODEL_OVERRIDES[m.id]
  return {
    id: m.id,
    name: `${m.name} (CC)`,
    reasoning: m.reasoning,
    thinking:
      m.reasoningEfforts && m.reasoningEfforts.length > 0
        ? { mode: "effort" as const, efforts: m.reasoningEfforts }
        : undefined,
    contextWindow: override?.contextWindow ?? m.contextWindow,
    maxTokens: override?.maxTokens ?? m.maxOutputTokens,
    cost: m.cost,
  }
})

// ---------------------------------------------------------------------------
// Stream factory
// ---------------------------------------------------------------------------

const streamCommandCode = createStreamCommandCode({
  createStream: createAssistantMessageEventStream,
  calculateCost,
  apiBase: API_BASE,
  isAvailableOnIndividualGo: (modelId) => isAvailableOnIndividualGo(modelsJson, modelId),
})

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const preferCurrentLoginCredential = (ctx: CredentialContext) => {
    const authStorage = ctx.modelRegistry?.authStorage
    if (ctx.model?.provider !== PROVIDER_ID || !authStorage) return

    const stored = authStorage.getAll?.()[PROVIDER_ID]
    const credentials = stored === undefined ? [] : Array.isArray(stored) ? stored : [stored]
    const currentLoginKey = credentials
      .filter(
        (credential) =>
          credential.type === "api_key" &&
          credential.source === "login" &&
          typeof credential.key === "string" &&
          credential.key.length > 0,
      )
      // OMP 17.2.11 loads SQLite credentials by ascending row id and getAll()
      // preserves that order, so the newest distinct pasted key is last.
      .at(-1)?.key

    if (currentLoginKey && authStorage.setConfigApiKey) {
      // OMP resolves an in-memory config key ahead of legacy OAuth rows. This
      // keeps a freshly pasted one-time API key active without mutating the DB.
      authStorage.setConfigApiKey(PROVIDER_ID, currentLoginKey)
    } else {
      // OMP 17.2.11 implements this as an idempotent Map.delete on the
      // in-memory config override; it never edits ~/.omp/agent/.env or the DB.
      authStorage.removeConfigApiKey(PROVIDER_ID)
    }
  }

  pi.on("session_start", (_event, ctx) => preferCurrentLoginCredential(ctx))
  pi.on("before_provider_request", (_event, ctx) => preferCurrentLoginCredential(ctx))

  pi.registerProvider(PROVIDER_ID, {
    name: "Command Code",
    baseUrl: API_BASE,
    apiKey: "COMMAND_CODE_API_KEY",
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
      thinking: model.thinking,
      input: modelInputModalities(model.id),
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  })
}
