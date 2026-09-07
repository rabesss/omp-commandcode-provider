import { TEXT_INPUT } from "./model-capabilities.ts"

export const PROVIDER_MODELS_PATH = "/provider/v1/models"
export const PROVIDER_MODELS_URL = `https://api.commandcode.ai${PROVIDER_MODELS_PATH}`

export const DYNAMIC_MODEL_FETCH_TIMEOUT_MS = 10_000
export const DYNAMIC_MODEL_MAX_BODY_BYTES = 1_048_576
export const DYNAMIC_MODEL_MAX_COUNT = 256
export const DYNAMIC_MODEL_MAX_CONTEXT_WINDOW = 16_777_216
export const UNREVIEWED_MODEL_MAX_TOKENS = 200_000

const MODEL_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127})?$/
const OWNED_BY_PATTERN = /^command[-_\s]?code$/i
const UNREVIEWED_MODEL_COST = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

export class DynamicModelsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "DynamicModelsError"
  }
}

export interface LiveProviderModel {
  id: string
  name: string
  contextWindow: number
}

export interface ProviderModelConfig {
  id: string
  name: string
  reasoning: boolean
  thinking?: { mode: "effort"; efforts: readonly string[] }
  input: readonly string[]
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  contextWindow: number
  maxTokens: number
}

export interface FetchDynamicModelsOptions {
  overlay: readonly ProviderModelConfig[]
  apiBase?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxBodyBytes?: number
}

export function providerModelsUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, "")}${PROVIDER_MODELS_PATH}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DynamicModelsError(`${label} must be a non-empty string`)
  }
  return value
}

export function validateLiveProviderPayload(payload: unknown): LiveProviderModel[] {
  if (!isPlainObject(payload)) {
    throw new DynamicModelsError("Provider API payload must be an object")
  }
  if (payload.object !== "list" || !Array.isArray(payload.data)) {
    throw new DynamicModelsError("Provider API payload is not a list")
  }
  if (payload.data.length === 0) {
    throw new DynamicModelsError("Provider API list is empty")
  }
  if (payload.data.length > DYNAMIC_MODEL_MAX_COUNT) {
    throw new DynamicModelsError(
      `Provider API list exceeds ${DYNAMIC_MODEL_MAX_COUNT} models`,
    )
  }

  const seen = new Set<string>()
  return payload.data.map((row, index) => {
    const label = `Provider API row ${index}`
    if (!isPlainObject(row)) {
      throw new DynamicModelsError(`${label} must be an object`)
    }
    if (row.object !== "model") {
      throw new DynamicModelsError(`${label}.object must be model`)
    }

    const id = requiredString(row.id, `${label}.id`)
    if (!MODEL_ID_PATTERN.test(id)) {
      throw new DynamicModelsError(`${label}.id has an invalid shape`)
    }
    if (seen.has(id)) {
      throw new DynamicModelsError(`duplicate Provider API id ${id}`)
    }
    seen.add(id)

    const ownedBy = requiredString(row.owned_by, `${label}.owned_by`)
    if (!OWNED_BY_PATTERN.test(ownedBy)) {
      throw new DynamicModelsError(`${label}.owned_by is not a Command Code owner`)
    }

    const name = requiredString(row.name, `${label}.name`)
    if (name.length > 256) {
      throw new DynamicModelsError(`${label}.name exceeds 256 characters`)
    }

    const contextWindow = row.context_length
    if (
      typeof contextWindow !== "number" ||
      !Number.isInteger(contextWindow) ||
      contextWindow < 1 ||
      contextWindow > DYNAMIC_MODEL_MAX_CONTEXT_WINDOW
    ) {
      throw new DynamicModelsError(
        `${label}.context_length must be an integer from 1 to ${DYNAMIC_MODEL_MAX_CONTEXT_WINDOW}`,
      )
    }

    return { id, name, contextWindow }
  })
}

export function mergeLiveProviderModels(
  live: readonly LiveProviderModel[],
  overlay: readonly ProviderModelConfig[],
): ProviderModelConfig[] {
  const overlayById = new Map(overlay.map((model) => [model.id, model]))
  return live.map((row) => {
    const known = overlayById.get(row.id)
    if (known) return known
    return {
      id: row.id,
      name: `${row.name} (CC)`,
      reasoning: false,
      input: TEXT_INPUT,
      cost: { ...UNREVIEWED_MODEL_COST },
      contextWindow: row.contextWindow,
      maxTokens: Math.min(row.contextWindow, UNREVIEWED_MODEL_MAX_TOKENS),
    }
  })
}

async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DynamicModelsError(`Provider models response exceeds ${maxBytes} bytes`)
  }

  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new DynamicModelsError(`Provider models response exceeds ${maxBytes} bytes`)
    }
    return text
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new DynamicModelsError(`Provider models response exceeds ${maxBytes} bytes`)
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export async function fetchLiveProviderCatalog(
  options: Omit<FetchDynamicModelsOptions, "overlay"> = {},
): Promise<LiveProviderModel[]> {
  const url = options.apiBase ? providerModelsUrl(options.apiBase) : PROVIDER_MODELS_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DYNAMIC_MODEL_FETCH_TIMEOUT_MS
  const maxBodyBytes = options.maxBodyBytes ?? DYNAMIC_MODEL_MAX_BODY_BYTES

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new DynamicModelsError(`unable to fetch ${url}`, { cause: error })
  }

  if (response.status >= 300 && response.status < 400) {
    throw new DynamicModelsError(`unexpected redirect from ${url}`)
  }
  if (!response.ok) {
    throw new DynamicModelsError(`HTTP ${response.status} from ${url}`)
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim()
  if (contentType !== "application/json") {
    throw new DynamicModelsError(
      `unexpected content-type ${contentType ?? "<missing>"} from ${url}`,
    )
  }

  let text: string
  try {
    text = await readCappedText(response, maxBodyBytes)
  } catch (error) {
    if (error instanceof DynamicModelsError) throw error
    throw new DynamicModelsError(`unable to read ${url}`, { cause: error })
  }

  let payload: unknown
  try {
    payload = JSON.parse(text) as unknown
  } catch (error) {
    throw new DynamicModelsError("Provider API response is not valid JSON", { cause: error })
  }
  return validateLiveProviderPayload(payload)
}

export async function fetchDynamicModels(
  options: FetchDynamicModelsOptions,
): Promise<readonly ProviderModelConfig[]> {
  const live = await fetchLiveProviderCatalog(options)
  return mergeLiveProviderModels(live, options.overlay)
}
