import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"

import commandCodeExtension from "../index.ts"
import {
  DYNAMIC_MODEL_MAX_COUNT,
  DYNAMIC_MODEL_MAX_CONTEXT_WINDOW,
  DynamicModelsError,
  fetchDynamicModels,
  fetchLiveProviderCatalog,
  mergeLiveProviderModels,
  PROVIDER_MODELS_URL,
  providerModelsUrl,
  UNREVIEWED_MODEL_MAX_TOKENS,
  validateLiveProviderPayload,
  type ProviderModelConfig,
} from "../src/dynamic-models.ts"
import { TEXT_IMAGE_INPUT, TEXT_INPUT } from "../src/model-capabilities.ts"

const providerPayload = JSON.parse(
  await readFile(new URL("./fixtures/provider-models.json", import.meta.url), "utf8"),
) as { object: string; data: unknown[] }

const overlay: ProviderModelConfig[] = [
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5 (CC)",
    reasoning: true,
    thinking: { mode: "effort", efforts: ["low", "medium", "high"] },
    input: TEXT_IMAGE_INPUT,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 1_000_000,
    maxTokens: 200_000,
  },
  {
    id: "overlay-only/model",
    name: "Overlay Only (CC)",
    reasoning: true,
    input: TEXT_IMAGE_INPUT,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
]

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  })
}

function registeredProvider(): {
  models: ProviderModelConfig[]
  fetchDynamicModels?: (apiKey?: string) => Promise<readonly ProviderModelConfig[]>
} {
  let provider:
    | {
        models?: ProviderModelConfig[]
        fetchDynamicModels?: (apiKey?: string) => Promise<readonly ProviderModelConfig[]>
      }
    | undefined
  commandCodeExtension({
    on() {},
    registerProvider(_name, config) {
      provider = config as typeof provider
    },
  })
  assert.ok(provider?.models)
  return {
    models: provider.models,
    fetchDynamicModels: provider.fetchDynamicModels,
  }
}

describe("live Provider catalog validation", () => {
  it("accepts the offline Provider API fixture", () => {
    const rows = validateLiveProviderPayload(providerPayload)
    assert.equal(rows.length, 58)
    assert.equal(rows[0]?.id, "claude-sonnet-5")
    assert.equal(rows[0]?.contextWindow, 1_000_000)
  })

  it("accepts OpenRouter-style colon suffixes used by the live catalog", () => {
    const rows = validateLiveProviderPayload({
      object: "list",
      data: [
        {
          id: "meituan/LongCat-2.0:free",
          object: "model",
          owned_by: "command-code",
          name: "LongCat 2.0 Free",
          context_length: 128_000,
          created: 1,
        },
      ],
    })
    assert.deepEqual(rows, [
      { id: "meituan/LongCat-2.0:free", name: "LongCat 2.0 Free", contextWindow: 128_000 },
    ])
  })

  it("allows extra row fields and commandcode-ish owners", () => {
    for (const ownedBy of ["command-code", "commandcode", "Command Code", "command_code"]) {
      const rows = validateLiveProviderPayload({
        object: "list",
        extra: true,
        data: [
          {
            id: "example/new-model",
            object: "model",
            owned_by: ownedBy,
            name: "Example",
            context_length: 32_768,
            created: 1,
            surprise: "ok",
          },
        ],
      })
      assert.deepEqual(rows, [{ id: "example/new-model", name: "Example", contextWindow: 32_768 }])
    }
  })

  it("rejects malformed list payloads", () => {
    for (const payload of [null, [], "list", { object: "list" }, { object: "model", data: [] }]) {
      assert.throws(
        () => validateLiveProviderPayload(payload),
        (error: unknown) => error instanceof DynamicModelsError,
      )
    }
    assert.throws(
      () => validateLiveProviderPayload({ object: "list", data: [] }),
      /Provider API list is empty/,
    )
  })

  it("rejects invalid ids, owners, duplicates, and context bounds", () => {
    const validRow = providerPayload.data[0] as Record<string, unknown>
    const payloadWith = (overrides: Record<string, unknown>) => ({
      object: "list",
      data: [{ ...validRow, ...overrides }],
    })

    assert.throws(() => validateLiveProviderPayload(payloadWith({ id: "../etc" })), /invalid shape/)
    assert.throws(() => validateLiveProviderPayload(payloadWith({ id: "has space" })), /invalid shape/)
    assert.throws(() => validateLiveProviderPayload(payloadWith({ id: "a/b/c" })), /invalid shape/)
    assert.throws(
      () => validateLiveProviderPayload(payloadWith({ owned_by: "openai" })),
      /not a Command Code owner/,
    )
    assert.throws(
      () => validateLiveProviderPayload(payloadWith({ context_length: 0 })),
      /context_length must be an integer/,
    )
    assert.throws(
      () => validateLiveProviderPayload(payloadWith({ context_length: 1.5 })),
      /context_length must be an integer/,
    )
    assert.throws(
      () =>
        validateLiveProviderPayload(
          payloadWith({ context_length: DYNAMIC_MODEL_MAX_CONTEXT_WINDOW + 1 }),
        ),
      /context_length must be an integer/,
    )
    assert.throws(
      () =>
        validateLiveProviderPayload({
          object: "list",
          data: [validRow, { ...validRow }],
        }),
      /duplicate Provider API id/,
    )
    assert.throws(
      () =>
        validateLiveProviderPayload({
          object: "list",
          data: Array.from({ length: DYNAMIC_MODEL_MAX_COUNT + 1 }, (_, index) => ({
            ...validRow,
            id: `model-${index}`,
          })),
        }),
      /exceeds 256 models/,
    )
  })
})

describe("live catalog overlay merge", () => {
  it("keeps reviewed metadata for known ids and conservative defaults for new ids", () => {
    const merged = mergeLiveProviderModels(
      [
        { id: "claude-sonnet-5", name: "Claude Sonnet 5 Live", contextWindow: 150_000 },
        { id: "example/new-model", name: "Example New Model", contextWindow: 128_000 },
        { id: "tiny/context", name: "Tiny Context", contextWindow: 4_096 },
        { id: "wide/context", name: "Wide Context", contextWindow: 1_000_000 },
      ],
      overlay,
    )

    assert.notEqual(merged[0], overlay[0])
    assert.deepEqual(merged[0], {
      ...overlay[0],
      name: "Claude Sonnet 5 Live (CC)",
      contextWindow: 150_000,
    })
    assert.equal(overlay[0].name, "Claude Sonnet 5 (CC)")
    assert.equal(overlay[0].contextWindow, 1_000_000)
    assert.equal(merged[0]?.reasoning, true)
    assert.equal(merged[0]?.maxTokens, 200_000)
    assert.deepEqual(merged[0]?.thinking, overlay[0].thinking)
    assert.deepEqual(merged[0]?.input, overlay[0].input)
    assert.deepEqual(merged[0]?.cost, overlay[0].cost)
    assert.deepEqual(merged[1], {
      id: "example/new-model",
      name: "Example New Model (CC)",
      reasoning: false,
      input: TEXT_INPUT,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: UNREVIEWED_MODEL_MAX_TOKENS,
    })
    assert.equal(UNREVIEWED_MODEL_MAX_TOKENS, 65_536)
    assert.equal(merged[2]?.maxTokens, 4_096)
    assert.equal(merged[3]?.reasoning, false)
    assert.deepEqual(merged[3]?.input, TEXT_INPUT)
    assert.equal(merged[3]?.maxTokens, UNREVIEWED_MODEL_MAX_TOKENS)
    assert.equal(
      merged.some((model) => model.id === "overlay-only/model"),
      false,
    )
  })
})

describe("live Provider catalog fetch", () => {
  it("fetches, validates, and merges without sending credentials", async () => {
    const calls: Array<{ url: string | URL | Request; init?: RequestInit }> = []
    const models = await fetchDynamicModels({
      overlay,
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return jsonResponse(providerPayload)
      },
    })

    assert.equal(calls.length, 1)
    assert.equal(String(calls[0]?.url), PROVIDER_MODELS_URL)
    assert.equal(calls[0]?.init?.method, "GET")
    assert.equal(calls[0]?.init?.redirect, "manual")
    const headers = new Headers(calls[0]?.init?.headers)
    assert.equal(headers.get("accept"), "application/json")
    assert.equal(headers.get("authorization"), null)
    assert.equal(models.length, 58)
    assert.notEqual(models[0], overlay[0])
    assert.deepEqual(models[0], {
      ...overlay[0],
      name: "Claude Sonnet 5 (CC)",
      contextWindow: 1_000_000,
    })
    assert.equal(
      models.find((model) => model.id === "deepseek/deepseek-v4-flash")?.reasoning,
      false,
    )
    assert.deepEqual(
      models.find((model) => model.id === "deepseek/deepseek-v4-flash")?.input,
      TEXT_INPUT,
    )
  })

  it("uses the configured API base", async () => {
    let requested: string | undefined
    await fetchLiveProviderCatalog({
      apiBase: "https://example.test/commandcode/",
      fetchImpl: async (url) => {
        requested = String(url)
        return jsonResponse({
          object: "list",
          data: [providerPayload.data[0]],
        })
      },
    })
    assert.equal(requested, providerModelsUrl("https://example.test/commandcode/"))
  })

  it("rejects redirects, non-JSON bodies, and oversized payloads", async () => {
    await assert.rejects(
      fetchLiveProviderCatalog({
        fetchImpl: async () => new Response(null, { status: 302, headers: { location: "/login" } }),
      }),
      (error: unknown) =>
        error instanceof DynamicModelsError && /unexpected redirect/.test(error.message),
    )
    await assert.rejects(
      fetchLiveProviderCatalog({
        fetchImpl: async () =>
          new Response("<html>nope</html>", { headers: { "content-type": "text/html" } }),
      }),
      /unexpected content-type/,
    )
    await assert.rejects(
      fetchLiveProviderCatalog({
        fetchImpl: async () =>
          new Response("not-json", { headers: { "content-type": "application/json" } }),
      }),
      /not valid JSON/,
    )
    await assert.rejects(
      fetchLiveProviderCatalog({
        maxBodyBytes: 16,
        fetchImpl: async () =>
          jsonResponse(providerPayload, { headers: { "content-length": "100" } }),
      }),
      /exceeds 16 bytes/,
    )
    await assert.rejects(
      fetchLiveProviderCatalog({
        maxBodyBytes: 8,
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{\"object\":\"list\",\"data\":[]}"))
                controller.close()
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      }),
      /exceeds 8 bytes/,
    )
  })

  it("times out through AbortSignal without retrying", async () => {
    let attempts = 0
    let sawAbortSignal = false
    await assert.rejects(
      fetchLiveProviderCatalog({
        timeoutMs: 20,
        fetchImpl: async (_url, init) => {
          attempts += 1
          sawAbortSignal = init?.signal instanceof AbortSignal
          throw Object.assign(new DOMException("The operation was aborted", "TimeoutError"))
        },
      }),
      (error: unknown) => error instanceof DynamicModelsError && /unable to fetch/.test(error.message),
    )
    assert.equal(attempts, 1)
    assert.equal(sawAbortSignal, true)
  })
})

describe("OMP fetchDynamicModels registration", () => {
  it("registers discovery beside the static overlay fallback", async () => {
    const provider = registeredProvider()
    assert.equal(typeof provider.fetchDynamicModels, "function")
    assert.equal(provider.models.length, 58)

    const originalFetch = globalThis.fetch
    const calls: RequestInit[] = []
    globalThis.fetch = (async (url, init) => {
      calls.push(init ?? {})
      assert.equal(String(url), "https://api.commandcode.ai/provider/v1/models")
      return jsonResponse({
        object: "list",
        data: [
          ...providerPayload.data,
          {
            id: "example/new-model",
            object: "model",
            owned_by: "command-code",
            name: "Example New Model",
            context_length: 64_000,
            created: 1,
          },
        ],
      })
    }) as typeof fetch
    try {
      const models = await provider.fetchDynamicModels?.("user_should_not_be_sent")
      assert.equal(models?.length, 59)
      const sonnet = models?.find((model) => model.id === "claude-sonnet-5")
      const added = models?.find((model) => model.id === "example/new-model")
      const gpt53 = models?.find((model) => model.id === "gpt-5.3-codex")
      const deepSeekFlash = models?.find((model) => model.id === "deepseek/deepseek-v4-flash")
      assert.deepEqual(sonnet?.thinking, {
        mode: "effort",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      })
      assert.deepEqual(sonnet?.input, TEXT_IMAGE_INPUT)
      assert.equal(sonnet?.name, "Claude Sonnet 5 (CC)")
      assert.equal(sonnet?.contextWindow, 1_000_000)
      assert.equal(gpt53?.name, "GPT-5.3 Codex (CC)")
      assert.equal(gpt53?.contextWindow, 400_000)
      assert.equal(gpt53?.maxTokens, 128_000)
      assert.equal(deepSeekFlash?.maxTokens, 200_000)
      assert.equal(added?.reasoning, false)
      assert.deepEqual(added?.input, TEXT_INPUT)
      assert.equal(added?.cost.input, 0)
      assert.equal(new Headers(calls[0]?.headers).get("authorization"), null)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
