/**
 * Retry and timeout tests for Command Code transport.
 */

import assert from "node:assert/strict"
import { after, before, beforeEach, describe, it } from "node:test"

import type { AssistantMessageEvent } from "../src/core.ts"
import {
  collectEvents,
  createTestDeps,
  makeContext,
  makeModel,
  startMockCommandCodeServer,
  type MockCommandCodeServer,
} from "./helpers.ts"

const TEST_API_KEY = "option-key"

let server: MockCommandCodeServer

before(async () => {
  server = await startMockCommandCodeServer()
})

after(async () => {
  await server.close()
})

beforeEach(() => {
  server.reset()
})

function eventTypes(events: readonly AssistantMessageEvent[]): string[] {
  return events.map((event) => event.type)
}

describe("streamCommandCode retry", () => {
  it("retries 429 and succeeds on the second attempt", async () => {
    server.mockResponseQueue([
      { type: "error", status: 429, body: "rate limited" },
      {
        type: "success",
        events: [
          JSON.stringify({ type: "text-delta", text: "ok" }),
          JSON.stringify({ type: "finish", finishReason: "stop" }),
        ],
      },
    ])
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 2,
      }),
    )

    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "done"])
  })

  it("does not retry non-retryable 400 errors", async () => {
    server.mockResponse({ type: "error", status: 400, body: "bad request" })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 2,
      }),
    )

    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const last = events.at(-1)
    if (last?.type !== "error") throw new Error("expected error")
    assert.match(last.error.errorMessage ?? "", /400/)
  })

  it("exhausts maxRetries and emits the final error", async () => {
    server.mockResponse({ type: "error", status: 503, body: "unavailable" })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 3,
      }),
    )

    assert.equal(server.requestCount(), 4)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const last = events.at(-1)
    if (last?.type !== "error") throw new Error("expected error")
    assert.match(last.error.errorMessage ?? "", /503/)
  })
})

describe("streamCommandCode Retry-After", () => {
  it("respects Retry-After seconds", async () => {
    let delayCalled = false
    server.mockResponseQueue([
      {
        type: "error",
        status: 429,
        body: "rate limited",
        headers: { "retry-after": "2" },
      },
      {
        type: "success",
        events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
      },
    ])
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
      delay: async (ms: number) => {
        delayCalled = true
        assert.equal(ms, 2000)
      },
    })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 2,
      }),
    )

    assert.equal(server.requestCount(), 2)
    assert.equal(events.at(-1)?.type, "done")
    assert.ok(delayCalled)
  })

  it("fails when Retry-After exceeds maxRetryDelayMs", async () => {
    server.mockResponse({
      type: "error",
      status: 429,
      body: "rate limited",
      headers: { "retry-after": "300" },
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 1,
        maxRetryDelayMs: 10_000,
      }),
    )

    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const last = events.at(-1)
    if (last?.type !== "error") throw new Error("expected error")
    assert.match(last.error.errorMessage ?? "", /exceeds max/)
  })
})

describe("streamCommandCode timeout", () => {
  it("retries on per-attempt timeout before content and succeeds", async () => {
    server.mockResponseQueue([
      {
        type: "success",
        events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
        hangAfterLast: true,
        responseDelay: 200,
      },
      {
        type: "success",
        events: [
          JSON.stringify({ type: "text-delta", text: "fast" }),
          JSON.stringify({ type: "finish", finishReason: "stop" }),
        ],
      },
    ])
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        timeoutMs: 50,
        maxRetries: 2,
      }),
      5_000,
    )

    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "done"])
  })

  it("does not retry timeout after partial text was emitted", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "text-delta", text: "partial" })],
      hangAfterLast: true,
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        timeoutMs: 50,
        maxRetries: 2,
      }),
      5_000,
    )

    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "error"])
  })

  it("reports exhausted timeouts clearly", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
      hangAfterLast: true,
      responseDelay: 200,
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        timeoutMs: 50,
        maxRetries: 1,
      }),
      5_000,
    )

    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "error"])
    const last = events.at(-1)
    if (last?.type !== "error") throw new Error("expected error")
    assert.match(last.error.errorMessage ?? "", /timed out after 50ms/)
  })
})

describe("streamCommandCode stream-level error retry", () => {
  it("retries a provider error event before visible content", async () => {
    server.mockResponseQueue([
      {
        type: "success",
        events: [
          JSON.stringify({
            type: "error",
            error: "Service temporarily unavailable. Please try again shortly.",
          }),
        ],
      },
      {
        type: "success",
        events: [
          JSON.stringify({ type: "text-delta", text: "ok" }),
          JSON.stringify({ type: "finish", finishReason: "stop" }),
        ],
      },
    ])
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 2,
      }),
    )

    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "done"])
  })

  it("does not retry a provider error after visible content", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({ type: "text-delta", text: "partial" }),
        JSON.stringify({
          type: "error",
          error: "Service temporarily unavailable",
        }),
      ],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 2,
      }),
    )

    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "error"])
  })
})
