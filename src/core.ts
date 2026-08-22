/**
 * Testable Command Code provider core.
 *
 * The runtime imports live in index.ts; this module takes injected stream/cost
 * dependencies so tests can exercise the real serialization and stream parser.
 */

import { randomUUID } from "node:crypto"
import { basename } from "node:path"

import {
  getApiKey,
  getEnvironmentInfo,
  isRecord,
  mapFinishReason,
  messagesToCC,
  numberValue,
  parseStreamEventLine,
  recordOrEmpty,
  stringValue,
  toolsToJson,
} from "./converters.ts"
import { modelSupportsVision } from "./model-capabilities.ts"
import { redactSensitiveText } from "./redaction.ts"
import type {
  AssistantMessageEventStreamLike,
  AssistantMessageLike,
  ContextLike,
  CoreDependencies,
  ErrorReason,
  ModelLike,
  StopReason,
  StreamOptions,
  TerminalReason,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  Usage,
} from "./types.ts"

export * from "./converters.ts"
export * from "./model-capabilities.ts"
export * from "./types.ts"

export const DEFAULT_API_BASE = "https://api.commandcode.ai"
export const COMMAND_CODE_CLI_VERSION = "1.32.1"
const COMMAND_CODE_MAX_OUTPUT_TOKENS = 200_000
const DEFAULT_MAX_RETRIES = 0
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 100_000
const DEFAULT_IDLE_TIMEOUT_MS = 120_000
const BASE_RETRY_DELAY_MS = 500

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

class CommandCodeStreamError extends Error {
  readonly statusCode?: number
  readonly isRetryable?: boolean

  constructor(
    message: string,
    statusCode?: number,
    isRetryable?: boolean,
  ) {
    super(message)
    this.name = "CommandCodeStreamError"
    this.statusCode = statusCode
    this.isRetryable = isRetryable
  }
}

function redactErrorMessage(message: string, apiKey: string): string {
  return redactSensitiveText(message, [apiKey])
}

function isPlanEntitlementError(status: number, body: string): boolean {
  if (![400, 402, 403, 404, 429].includes(status)) return false
  return /(?:not (?:available|included|enabled)|unsupported).{0,80}(?:plan|subscription)|(?:plan|subscription|entitlement).{0,80}(?:model|access)/i.test(
    body,
  )
}

function parseRetryAfterSeconds(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, (date - nowMs) / 1000)
  return undefined
}

function effectiveMaxRetryDelayMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RETRY_DELAY_MS
  if (value === 0) return Number.POSITIVE_INFINITY
  return value
}

function retryDelayMs(
  attempt: number,
  retryAfterHeader: string | null,
  maxDelayMs: number,
  nowMs = Date.now(),
): number {
  const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader, nowMs)
  if (retryAfterSeconds !== undefined) {
    const retryAfterMs = retryAfterSeconds * 1000
    if (retryAfterMs > maxDelayMs) return -1
    return retryAfterMs
  }
  const exponential = BASE_RETRY_DELAY_MS * 2 ** attempt
  const jitter = exponential * 0.2 * Math.random()
  return Math.min(exponential + jitter, maxDelayMs)
}

function defaultUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function commandCodeUsage(event: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(event.totalUsage) ? event.totalUsage : undefined
}

function commandCodeInputTokenDetails(
  usage: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

function abortError(message = "The operation was aborted"): DOMException {
  return new DOMException(message, "AbortError")
}

function timeoutError(timeoutMs: number | undefined): Error {
  return new Error(
    timeoutMs === undefined
      ? "Command Code API request timed out"
      : `Command Code API request timed out after ${timeoutMs}ms`,
  )
}

function firstStreamEventTimeoutError(timeoutMs: number): Error {
  return new Error(`Command Code first stream event timed out after ${timeoutMs}ms`)
}

function streamIdleTimeoutError(timeoutMs: number): Error {
  return new Error(`Command Code stream idle timed out after ${timeoutMs}ms`)
}

function successStopReason(reason: TerminalReason): StopReason {
  if (reason === "length" || reason === "toolUse") return reason
  return "stop"
}

function generateMaxTokens(model: ModelLike, options?: StreamOptions): number {
  return Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens, COMMAND_CODE_MAX_OUTPUT_TOKENS)
}

function systemPromptText(prompt: ContextLike["systemPrompt"]): string {
  return typeof prompt === "string" ? prompt : (prompt?.join("\n\n") ?? "")
}

function reasoningEffort(model: ModelLike, options?: StreamOptions): string | undefined {
  const efforts = model.thinking?.efforts ?? []
  const commandCodeEfforts = efforts.filter((effort) => effort !== "minimal")
  if (commandCodeEfforts.length === 0) return undefined
  if (options?.disableReasoning) return commandCodeEfforts[0]
  if (options?.reasoning === "minimal" && commandCodeEfforts.includes("low")) return "low"
  return options?.reasoning && commandCodeEfforts.includes(options.reasoning)
    ? options.reasoning
    : undefined
}

export function createStreamCommandCode(deps: CoreDependencies) {
  const apiBase = deps.apiBase ?? DEFAULT_API_BASE
  const fetchImpl = deps.fetchImpl ?? fetch
  const cwd = deps.cwd ?? (() => process.cwd())
  const now = deps.now ?? (() => Date.now())
  const uuid = deps.uuid ?? (() => randomUUID())
  const delay =
    deps.delay ??
    ((ms: number, signal: AbortSignal) => {
      if (signal.aborted) return Promise.reject(abortError())
      return new Promise<void>((resolve, reject) => {
        const id = setTimeout(() => {
          signal.removeEventListener("abort", onAbort)
          resolve()
        }, ms)
        const onAbort = () => {
          clearTimeout(id)
          reject(abortError())
        }
        signal.addEventListener("abort", onAbort, { once: true })
      })
    })

  function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError())

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError())
      signal.addEventListener("abort", onAbort, { once: true })
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort)
          reject(error)
        },
      )
    })
  }

  return function streamCommandCode(
    model: ModelLike,
    context: ContextLike,
    options?: StreamOptions,
  ): AssistantMessageEventStreamLike {
    const stream = deps.createStream()

    async function run() {
      const literalApiKeyRefs = new Set([
        "COMMAND_CODE_API_KEY",
        "$COMMAND_CODE_API_KEY",
        "COMMANDCODE_API_KEY",
        "$COMMANDCODE_API_KEY",
      ])
      const hostApiKey =
        options?.apiKey && !literalApiKeyRefs.has(options.apiKey) ? options.apiKey : undefined
      const apiKey =
        hostApiKey ??
        getApiKey({
          env: deps.env,
          authPaths: deps.authPaths,
          homeDir: deps.homeDir,
        })

      if (!apiKey) {
        const msg: AssistantMessageLike = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: defaultUsage(),
          stopReason: "error",
          errorMessage:
            "No Command Code API key. Run /login and select Command Code, set COMMAND_CODE_API_KEY (or legacy COMMANDCODE_API_KEY) in ~/.omp/agent/.env, or configure ~/.commandcode/auth.json.",
          timestamp: now(),
        }
        stream.push({ type: "error", reason: "error", error: msg })
        stream.end()
        return
      }

      const output: AssistantMessageLike = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: defaultUsage(),
        stopReason: "stop",
        timestamp: now(),
      }

      const controller = new AbortController()
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let textBlock: TextContent | undefined
      let currentTextIdx = -1
      let thinkingBlock: ThinkingContent | undefined
      let currentThinkingIdx = -1
      let finished = false
      let receivedProviderContent = false

      const abortUpstream = () => {
        if (!controller.signal.aborted) controller.abort()
        try {
          reader?.cancel().catch(() => undefined)
        } catch {
          // Reader cancellation is best-effort.
        }
      }

      if (options?.signal?.aborted) {
        abortUpstream()
      } else {
        options?.signal?.addEventListener("abort", abortUpstream, {
          once: true,
        })
      }

      const endTextBlock = () => {
        if (!textBlock) return
        stream.push({
          type: "text_end",
          contentIndex: currentTextIdx,
          content: textBlock.text,
          partial: output,
        })
        textBlock = undefined
        currentTextIdx = -1
      }

      const endThinkingBlock = () => {
        if (!thinkingBlock) return
        stream.push({
          type: "thinking_end",
          contentIndex: currentThinkingIdx,
          content: thinkingBlock.thinking,
          partial: output,
        })
        thinkingBlock = undefined
        currentThinkingIdx = -1
      }

      const handleEvent = (event: unknown) => {
        if (!isRecord(event)) return

        switch (event.type) {
          case "text-delta": {
            const delta = stringValue(event.text) ?? ""
            if (!delta) break
            endThinkingBlock()
            receivedProviderContent = true
            if (!textBlock) {
              textBlock = { type: "text", text: "" }
              output.content.push(textBlock)
              currentTextIdx = output.content.length - 1
              stream.push({
                type: "text_start",
                contentIndex: currentTextIdx,
                partial: output,
              })
            }
            textBlock.text += delta
            stream.push({
              type: "text_delta",
              contentIndex: currentTextIdx,
              delta,
              partial: output,
            })
            break
          }

          case "reasoning-delta": {
            const delta = stringValue(event.text) ?? ""
            if (!delta) break
            endTextBlock()
            receivedProviderContent = true
            if (!thinkingBlock) {
              thinkingBlock = { type: "thinking", thinking: "" }
              output.content.push(thinkingBlock)
              currentThinkingIdx = output.content.length - 1
              stream.push({
                type: "thinking_start",
                contentIndex: currentThinkingIdx,
                partial: output,
              })
            }
            thinkingBlock.thinking += delta
            stream.push({
              type: "thinking_delta",
              contentIndex: currentThinkingIdx,
              delta,
              partial: output,
            })
            break
          }

          case "reasoning-end": {
            endThinkingBlock()
            break
          }

          case "tool-call": {
            endTextBlock()
            endThinkingBlock()
            receivedProviderContent = true
            const toolCall: ToolCallContent = {
              type: "toolCall",
              id: stringValue(event.toolCallId) ?? "",
              name: stringValue(event.toolName) ?? "",
              arguments: recordOrEmpty(event.input ?? event.args ?? event.arguments),
            }
            output.content.push(toolCall)
            const idx = output.content.length - 1
            stream.push({
              type: "toolcall_start",
              contentIndex: idx,
              partial: output,
            })
            stream.push({
              type: "toolcall_end",
              contentIndex: idx,
              toolCall,
              partial: output,
            })
            break
          }

          case "finish": {
            const usage = commandCodeUsage(event)
            if (usage) {
              const details = commandCodeInputTokenDetails(usage)
              output.usage.input = numberValue(usage.inputTokens) ?? 0
              output.usage.output = numberValue(usage.outputTokens) ?? 0
              output.usage.cacheRead = numberValue(details?.cacheReadTokens) ?? 0
              output.usage.cacheWrite = numberValue(details?.cacheWriteTokens) ?? 0
              output.usage.totalTokens =
                output.usage.input +
                output.usage.output +
                output.usage.cacheRead +
                output.usage.cacheWrite
              deps.calculateCost(model, output.usage)
            }
            output.stopReason = mapFinishReason(event.finishReason)
            finished = true
            break
          }

          case "abort": {
            output.stopReason = "stop"
            finished = true
            break
          }

          case "error": {
            const errorRecord = isRecord(event.error) ? event.error : undefined
            const rawMessage =
              stringValue(errorRecord?.message) ?? stringValue(event.error) ?? "Stream error"
            const statusCode = numberValue(errorRecord?.statusCode)
            const isRetryable =
              typeof errorRecord?.isRetryable === "boolean"
                ? errorRecord.isRetryable
                : undefined
            const message = redactErrorMessage(
              statusCode === undefined ? rawMessage : `${statusCode}: ${rawMessage}`,
              apiKey,
            )
            output.stopReason = "error"
            output.errorMessage = message
            throw new CommandCodeStreamError(message, statusCode, isRetryable)
          }
        }
      }

      try {
        stream.push({ type: "start", partial: output })

        const selectedReasoningEffort = reasoningEffort(model, options)
        let body: unknown = {
          config: {
            workingDir: basename(cwd()) || ".",
            date: new Date(now()).toISOString().split("T")[0],
            environment: getEnvironmentInfo(),
            structure: [],
            isGitRepo: false,
            currentBranch: "",
            mainBranch: "",
            gitStatus: "",
            recentCommits: [],
          },
          memory: "",
          taste: "",
          skills: null,
          permissionMode: "standard",
          params: {
            model: model.id,
            messages: messagesToCC(context.messages, {
              supportsVision: modelSupportsVision(model.id),
            }),
            tools: options?.toolChoice === "none" ? [] : toolsToJson(context.tools),
            system: systemPromptText(context.systemPrompt),
            max_tokens: generateMaxTokens(model, options),
            ...(numberValue(options?.temperature) === undefined
              ? {}
              : { temperature: options?.temperature }),
            ...(selectedReasoningEffort
              ? { reasoning_effort: selectedReasoningEffort }
              : {}),
            stream: true,
          },
        }

        const nextBody = await raceAbort(
          Promise.resolve(options?.onPayload?.(body, model)),
          controller.signal,
        )
        if (nextBody !== undefined) body = nextBody

        const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES
        const maxRetryDelayMs = effectiveMaxRetryDelayMs(options?.maxRetryDelayMs)
        const timeoutMs = options?.timeoutMs
        const firstEventTimeoutMs =
          options?.streamFirstEventTimeoutMs === 0
            ? undefined
            : options?.streamFirstEventTimeoutMs && options.streamFirstEventTimeoutMs > 0
              ? Math.trunc(options.streamFirstEventTimeoutMs)
              : DEFAULT_FIRST_EVENT_TIMEOUT_MS
        const idleTimeoutMs =
          options?.streamIdleTimeoutMs === 0
            ? undefined
            : options?.streamIdleTimeoutMs && options.streamIdleTimeoutMs > 0
              ? Math.trunc(options.streamIdleTimeoutMs)
              : DEFAULT_IDLE_TIMEOUT_MS
        const firstEventDeadline =
          firstEventTimeoutMs === undefined ? undefined : now() + firstEventTimeoutMs
        let receivedSemanticEvent = false
        let lastRawChunkAt: number | undefined

        const waitBeforeRetry = async (waitMs: number) => {
          if (receivedSemanticEvent) {
            if (idleTimeoutMs === undefined) {
              if (waitMs > 0) await delay(waitMs, controller.signal)
              return
            }
            const remainingMs = (lastRawChunkAt ?? now()) + idleTimeoutMs - now()
            if (remainingMs <= 0 || waitMs >= remainingMs) {
              throw streamIdleTimeoutError(idleTimeoutMs)
            }
            if (waitMs <= 0) return
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(
                () => reject(streamIdleTimeoutError(idleTimeoutMs)),
                remainingMs,
              )
              delay(waitMs, controller.signal).then(
                () => {
                  clearTimeout(timer)
                  resolve()
                },
                (error: unknown) => {
                  clearTimeout(timer)
                  reject(error)
                },
              )
            })
            return
          }

          if (firstEventDeadline === undefined) {
            if (waitMs > 0) await delay(waitMs, controller.signal)
            return
          }

          const remainingMs = firstEventDeadline - now()
          if (remainingMs <= 0 || waitMs >= remainingMs) {
            throw firstStreamEventTimeoutError(firstEventTimeoutMs!)
          }
          if (waitMs <= 0) return

          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(firstStreamEventTimeoutError(firstEventTimeoutMs!)),
              remainingMs,
            )
            delay(waitMs, controller.signal).then(
              () => {
                clearTimeout(timer)
                resolve()
              },
              (error: unknown) => {
                clearTimeout(timer)
                reject(error)
              },
            )
          })
        }
        const requestHeaders = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "x-command-code-version": COMMAND_CODE_CLI_VERSION,
          "x-cli-environment": "production",
          "x-project-slug": "pi-cc",
          "x-taste-learning": "false",
          "x-co-flag": "false",
          "x-session-id": options?.sessionId || uuid(),
          ...Object.fromEntries(
            Object.entries(options?.headers ?? {}).filter(
              ([header]) => header.toLowerCase() !== "user-agent",
            ),
          ),
          "User-Agent": "cli",
        }
        const bodyStr = JSON.stringify(body)

        retryLoop: for (let attempt = 0; ; attempt++) {
          const attemptController = new AbortController()
          let attemptTimedOut = false
          let attemptTimeoutId: ReturnType<typeof setTimeout> | undefined
          let attemptFirstEventTimedOut = false
          let attemptFirstEventTimeoutId: ReturnType<typeof setTimeout> | undefined
          let attemptIdleTimedOut = false
          let attemptIdleTimeoutId: ReturnType<typeof setTimeout> | undefined

          const clearAttemptTimeout = () => {
            if (attemptTimeoutId !== undefined) {
              clearTimeout(attemptTimeoutId)
              attemptTimeoutId = undefined
            }
          }

          if (timeoutMs !== undefined) {
            attemptTimeoutId = setTimeout(() => {
              attemptTimedOut = true
              attemptController.abort()
            }, timeoutMs)
          }

          if (firstEventDeadline !== undefined && !receivedSemanticEvent) {
            const remainingMs = firstEventDeadline - now()
            if (remainingMs <= 0) throw firstStreamEventTimeoutError(firstEventTimeoutMs!)
            attemptFirstEventTimeoutId = setTimeout(() => {
              attemptFirstEventTimedOut = true
              attemptController.abort()
            }, remainingMs)
          }

          const clearFirstEventTimeout = () => {
            if (attemptFirstEventTimeoutId !== undefined) {
              clearTimeout(attemptFirstEventTimeoutId)
              attemptFirstEventTimeoutId = undefined
            }
          }

          const clearIdleTimeout = () => {
            if (attemptIdleTimeoutId !== undefined) {
              clearTimeout(attemptIdleTimeoutId)
              attemptIdleTimeoutId = undefined
            }
          }

          const armIdleTimeout = () => {
            clearIdleTimeout()
            if (!receivedSemanticEvent || idleTimeoutMs === undefined) return
            const remainingMs = (lastRawChunkAt ?? now()) + idleTimeoutMs - now()
            if (remainingMs <= 0) {
              attemptIdleTimedOut = true
              attemptController.abort()
              return
            }
            attemptIdleTimeoutId = setTimeout(() => {
              attemptIdleTimedOut = true
              attemptController.abort()
            }, remainingMs)
          }

          const onOuterAbort = () => attemptController.abort()
          controller.signal.addEventListener("abort", onOuterAbort, { once: true })
          armIdleTimeout()

          try {
            let response: Response
            try {
              response = await fetchImpl(`${apiBase}/alpha/generate`, {
                method: "POST",
                headers: requestHeaders,
                body: bodyStr,
                signal: attemptController.signal,
              })
            } catch (fetchError: unknown) {
              if (controller.signal.aborted) throw abortError("Aborted")
              if (attemptFirstEventTimedOut) {
                throw firstStreamEventTimeoutError(firstEventTimeoutMs!)
              }
              if (attemptIdleTimedOut) {
                throw streamIdleTimeoutError(idleTimeoutMs!)
              }
              if (attemptTimedOut) {
                if (attempt < maxRetries) continue retryLoop
                throw timeoutError(timeoutMs)
              }
              if (attempt < maxRetries) {
                const waitMs = retryDelayMs(attempt, null, maxRetryDelayMs, now())
                await waitBeforeRetry(waitMs)
                continue retryLoop
              }
              throw fetchError
            }

            if (!response.ok && isRetryableStatus(response.status) && attempt < maxRetries) {
              const waitMs = retryDelayMs(
                attempt,
                response.headers.get("retry-after"),
                maxRetryDelayMs,
                now(),
              )
              if (waitMs < 0) {
                const requestedSeconds =
                  parseRetryAfterSeconds(response.headers.get("retry-after"), now()) ?? 0
                const capLabel =
                  maxRetryDelayMs === Number.POSITIVE_INFINITY ? "disabled" : `${maxRetryDelayMs}ms`
                throw new Error(`Retry-After delay ${requestedSeconds}s exceeds max ${capLabel}`)
              }
              await response.text().catch(() => "")
              await waitBeforeRetry(waitMs)
              continue retryLoop
            }

            try {
              await raceAbort(
                Promise.resolve(
                  options?.onResponse?.(
                    {
                      status: response.status,
                      headers: headersToRecord(response.headers),
                    },
                    model,
                  ),
                ),
                attemptController.signal,
              )
            } catch (responseHookError: unknown) {
              if (controller.signal.aborted) throw abortError("Aborted")
              if (attemptFirstEventTimedOut) {
                throw firstStreamEventTimeoutError(firstEventTimeoutMs!)
              }
              if (attemptIdleTimedOut) throw streamIdleTimeoutError(idleTimeoutMs!)
              if (attemptTimedOut) {
                if (attempt < maxRetries) {
                  await waitBeforeRetry(0)
                  continue retryLoop
                }
                throw timeoutError(timeoutMs)
              }
              throw responseHookError
            }

            if (!response.ok) {
              let errBody: string
              try {
                errBody = await raceAbort(
                  response.text().catch(() => ""),
                  attemptController.signal,
                )
              } catch (errorBodyReadError: unknown) {
                if (controller.signal.aborted) throw abortError("Aborted")
                if (attemptFirstEventTimedOut) {
                  throw firstStreamEventTimeoutError(firstEventTimeoutMs!)
                }
                if (attemptIdleTimedOut) throw streamIdleTimeoutError(idleTimeoutMs!)
                if (attemptTimedOut) {
                  if (attempt < maxRetries) {
                    await waitBeforeRetry(0)
                    continue retryLoop
                  }
                  throw timeoutError(timeoutMs)
                }
                throw errorBodyReadError
              }
              const availabilityHint =
                deps.isAvailableOnIndividualGo?.(model.id) === false &&
                isPlanEntitlementError(response.status, errBody)
                  ? ` Model ${model.id} is not currently listed for Individual Go; choose a Go-available model or check Command Code plan access.`
                  : ""
              throw new Error(
                redactErrorMessage(
                  `Command Code API error ${response.status}: ${errBody.slice(0, 500)}${availabilityHint}`,
                  apiKey,
                ),
              )
            }

            reader = response.body?.getReader()
            if (!reader) {
              if (attempt < maxRetries) {
                const waitMs = retryDelayMs(attempt, null, maxRetryDelayMs, now())
                await waitBeforeRetry(waitMs)
                continue retryLoop
              }
              throw new Error("No response body")
            }

            const decoder = new TextDecoder()
            let buffer = ""

            try {
              readLoop: for (;;) {
                if (controller.signal.aborted) throw abortError("Aborted")
                const readResult = await raceAbort(reader.read(), attemptController.signal)
                attemptIdleTimedOut = false
                const { done, value } = readResult
                if (done) {
                  if (buffer.trim()) {
                    const parsed = parseStreamEventLine(buffer)
                    if (parsed !== undefined) {
                      receivedSemanticEvent = true
                      lastRawChunkAt = now()
                      clearFirstEventTimeout()
                      armIdleTimeout()
                    }
                    handleEvent(parsed)
                  }
                  if (!finished) {
                    throw new CommandCodeStreamError(
                      "Stream ended unexpectedly before completion (no finish or abort event) — response was truncated",
                      502,
                      true,
                    )
                  }
                  break
                }
                if (controller.signal.aborted) throw abortError("Aborted")

                if (receivedSemanticEvent) {
                  lastRawChunkAt = now()
                  armIdleTimeout()
                }

                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split("\n")
                buffer = lines.pop() ?? ""

                for (const line of lines) {
                  if (controller.signal.aborted) throw abortError("Aborted")
                  const parsed = parseStreamEventLine(line)
                  if (parsed !== undefined) {
                    receivedSemanticEvent = true
                    lastRawChunkAt = now()
                    clearFirstEventTimeout()
                    armIdleTimeout()
                  }
                  handleEvent(parsed)
                  if (finished) break readLoop
                }
              }
            } catch (streamError: unknown) {
              await reader.cancel().catch(() => undefined)
              try {
                reader.releaseLock()
              } catch {
                // Reader may already be released.
              }
              reader = undefined

              if (controller.signal.aborted) throw streamError
              if (attemptFirstEventTimedOut) {
                throw firstStreamEventTimeoutError(firstEventTimeoutMs!)
              }
              const effectiveStreamError = attemptIdleTimedOut
                ? streamIdleTimeoutError(idleTimeoutMs!)
                : streamError
              const retryableStreamError =
                !(effectiveStreamError instanceof CommandCodeStreamError) ||
                effectiveStreamError.isRetryable !== false
              const canRetry =
                !receivedProviderContent && retryableStreamError && attempt < maxRetries
              if (canRetry) {
                output.content.length = 0
                textBlock = undefined
                currentTextIdx = -1
                thinkingBlock = undefined
                currentThinkingIdx = -1
                output.stopReason = "stop"
                output.errorMessage = undefined
                finished = false
                receivedSemanticEvent = false
                lastRawChunkAt = undefined
                attemptIdleTimedOut = false
                clearIdleTimeout()
                const waitMs = attemptTimedOut
                  ? 0
                  : retryDelayMs(attempt, null, maxRetryDelayMs, now())
                await waitBeforeRetry(waitMs)
                continue retryLoop
              }
              if (attemptTimedOut) throw timeoutError(timeoutMs)
              throw effectiveStreamError
            }

            endTextBlock()
            endThinkingBlock()

            stream.push({
              type: "done",
              reason: successStopReason(output.stopReason),
              message: output,
            })
            stream.end()
            break retryLoop
          } finally {
            controller.signal.removeEventListener("abort", onOuterAbort)
            clearAttemptTimeout()
            clearFirstEventTimeout()
            clearIdleTimeout()
          }
        }
      } catch (error: unknown) {
        const reason: ErrorReason = controller.signal.aborted ? "aborted" : "error"
        output.stopReason = reason
        output.errorMessage =
          reason === "aborted"
            ? "Request aborted"
            : error instanceof Error
              ? redactErrorMessage(error.message, apiKey)
              : redactErrorMessage(String(error), apiKey)
        stream.push({ type: "error", reason, error: output })
        stream.end()
      } finally {
        options?.signal?.removeEventListener("abort", abortUpstream)
        try {
          await reader?.cancel()
        } catch {
          // Reader may already be closed/cancelled.
        }
        try {
          reader?.releaseLock()
        } catch {
          // Reader may already be released/cancelled by the abort path.
        }
      }
    }

    run().catch((error: unknown) => {
      const msg: AssistantMessageLike = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: defaultUsage(),
        stopReason: "error",
        errorMessage: redactSensitiveText(error instanceof Error ? error.message : String(error)),
        timestamp: now(),
      }
      stream.push({ type: "error", reason: "error", error: msg })
      stream.end()
    })

    return stream
  }
}
