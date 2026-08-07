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
  it("retries a transient bodiless 2xx response before content", async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      calls += 1
      if (calls === 1) return new Response(null, { status: 204 })
      return fetch(input, init)
    }
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl(), fetchImpl })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 1,
      }),
    )

    assert.equal(calls, 2)
    assert.equal(events.at(-1)?.type, "done")
  })

  it("retries a generic pre-response network failure", async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      calls += 1
      if (calls === 1) throw new TypeError("socket reset")
      return fetch(input, init)
    }
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
      fetchImpl,
    })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 1,
      }),
    )

    assert.equal(calls, 2)
    assert.equal(events.at(-1)?.type, "done")
  })

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
  it("uses the injected clock for stream watchdog calculations", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    let clockCalls = 0
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
      now: () => {
        clockCalls += 1
        return Date.now()
      },
    })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), { apiKey: TEST_API_KEY }),
    )

    assert.equal(events.at(-1)?.type, "done")
    assert.ok(clockCalls >= 5, `expected watchdog clock calls, received ${clockCalls}`)
  })

  it("retains attempt-timeout semantics while reading a non-OK response body", async () => {
    const fetchImpl: typeof fetch = async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("bad request"))
            controller.close()
          }, 100)
        },
      })
      return new Response(body, { status: 400 })
    }
    const { streamCommandCode } = createTestDeps({ fetchImpl })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        timeoutMs: 25,
        maxRetries: 0,
      }),
      2_000,
    )

    const last = events.at(-1)
    if (last?.type !== "error") throw new Error("expected error")
    assert.match(last.error.errorMessage ?? "", /timed out after 25ms/i)
  })

  it("retries an attempt timeout while reading a non-OK response body", async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      if (calls === 1) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode("slow error"))
              controller.close()
            }, 100)
          },
        })
        return new Response(body, { status: 400 })
      }
      return new Response(`${JSON.stringify({ type: "finish", finishReason: "stop" })}\n`)
    }
    const { streamCommandCode } = createTestDeps({ fetchImpl })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        timeoutMs: 25,
        maxRetries: 1,
      }),
      2_000,
    )

    assert.equal(calls, 2)
    assert.equal(events.at(-1)?.type, "done")
  })

  it("retries an attempt timeout raised while onResponse is pending", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
    })
    let hookCalls = 0
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        timeoutMs: 25,
        maxRetries: 1,
        onResponse: async () => {
          hookCalls += 1
          if (hookCalls === 1) await new Promise<never>(() => undefined)
        },
      }),
      2_000,
    )

    assert.equal(server.requestCount(), 2)
    assert.equal(hookCalls, 2)
    assert.equal(events.at(-1)?.type, "done")
  })

  it("enforces OMP's first-stream-event deadline across retries", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
      responseDelay: 100,
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        streamFirstEventTimeoutMs: 25,
        maxRetries: 2,
      }),
      2_000,
    )

    assert.equal(server.requestCount(), 1)
    const last = events.at(-1)
    if (last?.type !== "error") throw new Error("expected error")
    assert.match(last.error.errorMessage ?? "", /first stream event.*25ms/i)
  })

  it("does not count SSE comments as the first semantic stream event", async () => {
    server.mockResponse({
      type: "success",
      chunks: [
        ": connection established\n",
        `${JSON.stringify({ type: "finish", finishReason: "stop" })}\n`,
      ],
      delays: [0, 50],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        streamFirstEventTimeoutMs: 25,
      }),
      2_000,
    )

    const last = events.at(-1)
    if (last?.type !== "error") throw new Error("expected error")
    assert.match(last.error.errorMessage ?? "", /first stream event/i)
  })

  it("disables first-event and idle watchdogs when OMP passes zero", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
      responseDelay: 40,
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        streamFirstEventTimeoutMs: 0,
        streamIdleTimeoutMs: 0,
      }),
      2_000,
    )

    assert.equal(events.at(-1)?.type, "done")
  })

  it("enforces OMP's idle deadline after provider content without retrying", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "text-delta", text: "partial" })],
      hangAfterLast: true,
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        streamIdleTimeoutMs: 25,
        maxRetries: 2,
      }),
      2_000,
    )

    assert.equal(server.requestCount(), 1)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "error"])
    const last = events.at(-1)
    if (last?.type !== "error") throw new Error("expected error")
    assert.match(last.error.errorMessage ?? "", /stream idle.*25ms/i)
  })

  it("resets the idle deadline on raw SSE comments and keepalives", async () => {
    server.mockResponse({
      type: "success",
      chunks: [
        `${JSON.stringify({ type: "text-delta", text: "partial" })}\n`,
        ": ping one\n",
        ": ping two\n",
        `${JSON.stringify({ type: "finish", finishReason: "stop" })}\n`,
      ],
      delays: [0, 15, 15, 15],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        streamIdleTimeoutMs: 25,
      }),
      2_000,
    )

    assert.equal(events.at(-1)?.type, "done")
  })

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
  it("retries a truncated stream that ends before provider content", async () => {
    server.mockResponseQueue([
      {
        type: "success",
        chunks: [": connection established\n"],
      },
      {
        type: "success",
        events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
      },
    ])
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 1,
      }),
    )

    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "done"])
  })

  it("ignores empty deltas so a pre-content retry cannot orphan block events", async () => {
    server.mockResponseQueue([
      {
        type: "success",
        events: [
          JSON.stringify({ type: "text-delta", text: "" }),
          JSON.stringify({ type: "reasoning-delta", text: "" }),
          JSON.stringify({
            type: "error",
            error: { message: "temporary", statusCode: 503, isRetryable: true },
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
        maxRetries: 1,
      }),
    )

    assert.equal(server.requestCount(), 2)
    assert.deepEqual(eventTypes(events), ["start", "text_start", "text_delta", "text_end", "done"])
  })

  it("uses the remaining first-event budget after a pre-content stream retry", async () => {
    server.mockResponseQueue([
      {
        type: "success",
        events: [
          JSON.stringify({
            type: "error",
            error: { message: "temporary", statusCode: 503, isRetryable: true },
          }),
        ],
      },
      {
        type: "success",
        events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
        responseDelay: 60,
      },
    ])
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 1,
        maxRetryDelayMs: 1,
        streamFirstEventTimeoutMs: 200,
        streamIdleTimeoutMs: 30,
      }),
      2_000,
    )

    assert.equal(server.requestCount(), 2)
    assert.equal(events.at(-1)?.type, "done")
  })

  it("does not retry after a reasoning delta even before reasoning-end", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({ type: "reasoning-delta", text: "partial thought" }),
        JSON.stringify({
          type: "error",
          error: { message: "temporary", statusCode: 503, isRetryable: true },
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
    assert.deepEqual(eventTypes(events), ["start", "thinking_start", "thinking_delta", "error"])
  })

  it("retries a nested retryable provider error before content", async () => {
    server.mockResponseQueue([
      {
        type: "success",
        events: [
          JSON.stringify({
            type: "error",
            error: { message: "temporary", statusCode: 503, isRetryable: true },
          }),
        ],
      },
      {
        type: "success",
        events: [JSON.stringify({ type: "finish", finishReason: "stop" })],
      },
    ])
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 1,
        sessionId: "stable-session",
      }),
    )

    assert.equal(server.requestCount(), 2)
    assert.equal(server.lastRequestHeaders()["x-session-id"], "stable-session")
    assert.equal(events.at(-1)?.type, "done")
  })

  it("does not let a pre-content retry delay exceed the remaining first-event deadline", async () => {
    server.mockResponse({
      type: "success",
      events: [
        JSON.stringify({
          type: "error",
          error: { message: "temporary", statusCode: 503, isRetryable: true },
        }),
      ],
    })
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: TEST_API_KEY,
        maxRetries: 1,
        streamFirstEventTimeoutMs: 25,
      }),
    )

    assert.equal(server.requestCount(), 1)
    const last = events.at(-1)
    if (last?.type !== "error") throw new Error("expected error")
    assert.match(last.error.errorMessage ?? "", /first stream event/i)
  })


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
