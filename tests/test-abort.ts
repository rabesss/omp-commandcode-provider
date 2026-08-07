/**
 * Abort tests against the real streamCommandCode core.
 */

import assert from "node:assert/strict"
import { after, before, beforeEach, describe, it } from "node:test"

import {
  collectEvents,
  createTestDeps,
  makeContext,
  makeModel,
  startMockCommandCodeServer,
  type MockCommandCodeServer,
} from "./helpers.ts"

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

describe("streamCommandCode — abort behavior", () => {
  it("aborts during Retry-After delay without starting another attempt", async () => {
    server.mockResponse({
      type: "error",
      status: 429,
      body: "rate limited",
      headers: { "retry-after": "10" },
    })
    const controller = new AbortController()
    let enteredDelay!: () => void
    const delayStarted = new Promise<void>((resolve) => {
      enteredDelay = resolve
    })
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
      delay: (_ms, signal) =>
        new Promise<void>((resolve, reject) => {
          enteredDelay()
          const onAbort = () => reject(new DOMException("aborted", "AbortError"))
          signal.addEventListener("abort", onAbort, { once: true })
          if (signal.aborted) onAbort()
          void resolve
        }),
    })

    const stream = streamCommandCode(makeModel(), makeContext(), {
      apiKey: "mock-key",
      signal: controller.signal,
      maxRetries: 2,
      maxRetryDelayMs: 0,
    })
    const eventsPromise = collectEvents(stream)
    await delayStarted
    controller.abort()
    const events = await eventsPromise

    assert.equal(server.requestCount(), 1)
    const last = events.at(-1)
    if (last?.type !== "error") throw new Error("expected error")
    assert.equal(last.reason, "aborted")
  })

  it("emits aborted error when signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
        signal: controller.signal,
      }),
    )

    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "error"],
    )
    const error = events.at(-1)
    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.equal(error.reason, "aborted")
    assert.equal(error.error.stopReason, "aborted")
    assert.equal(server.requestCount(), 0)
  })

  it("emits aborted error and cancels the response reader mid-stream", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "text-delta", text: "first" })],
      hangAfterLast: true,
    })
    const controller = new AbortController()
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const stream = streamCommandCode(makeModel(), makeContext(), {
      apiKey: "mock-key",
      signal: controller.signal,
    })

    const events = await Promise.race([
      (async () => {
        const observed = []
        for await (const event of stream) {
          observed.push(event)
          if (event.type === "text_delta") controller.abort()
          if (event.type === "done" || event.type === "error") break
        }
        return observed
      })(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for aborted stream")), 2_000)
      }),
    ])

    assert.ok(
      events.some((event) => event.type === "text_delta"),
      "stream should process data before abort",
    )
    const error = events.at(-1)
    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.equal(error.reason, "aborted")
    assert.equal(error.error.errorMessage, "Request aborted")
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(server.responseClosedBeforeEnd(), "abort should close the hanging upstream response")
  })
})
