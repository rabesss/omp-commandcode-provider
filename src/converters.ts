import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { MessageLike, StopReason, ToolLike } from "./types.ts"

const NON_VISION_IMAGE_PLACEHOLDER = "[image omitted: model does not support vision]"
const MALFORMED_IMAGE_PLACEHOLDER = "[image omitted: attachment had no image data]"
const DEFAULT_IMAGE_MIME_TYPE = "image/png"

export interface MessagesToCCOptions {
  supportsVision?: boolean
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

export function recordArray(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord)
}

export function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      if (isRecord(parsed)) return parsed
    } catch {
      // Some providers stream incomplete JSON argument fragments.
    }
  }
  return {}
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function defaultAuthPaths(home: string): string[] {
  return [join(home, ".commandcode", "auth.json"), join(home, ".pi", "agent", "auth.json")]
}

export function getApiKey(
  options: {
    env?: NodeJS.ProcessEnv
    authPaths?: readonly string[]
    homeDir?: () => string
  } = {},
): string | undefined {
  const env = options.env ?? process.env
  if (env.COMMAND_CODE_API_KEY) return env.COMMAND_CODE_API_KEY
  if (env.COMMANDCODE_API_KEY) return env.COMMANDCODE_API_KEY

  const home = options.homeDir?.() ?? homedir()
  const authPaths = options.authPaths ?? defaultAuthPaths(home)

  for (const authPath of authPaths) {
    try {
      if (!existsSync(authPath)) continue
      const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"))
      if (!isRecord(parsed)) continue

      // Legacy: direct apiKey or commandcode field
      const apiKey = stringValue(parsed.apiKey)
      if (apiKey) return apiKey
      const commandcode = stringValue(parsed.commandcode)
      if (commandcode) return commandcode

      // Legacy Pi OAuth credential file support is retained from the upstream provider.
      const providerKey = isRecord(parsed.commandcode) ? parsed.commandcode : undefined
      if (providerKey && stringValue(providerKey.type) === "oauth") {
        const access = stringValue(providerKey.access)
        if (access) return access
      }
    } catch {
      // Ignore malformed or unreadable auth files.
    }
  }

  return undefined
}

export function textContent(message: { content?: unknown }): string {
  return recordArray(message.content)
    .filter((part) => part.type === "text")
    .map((part) => stringValue(part.text) ?? "")
    .join("\n")
}

export function getEnvironmentInfo(): string {
  return `${process.platform}-${process.arch}, Node.js ${process.version}`
}

const LEGACY_SCHEMA_KINDS = new Set([
  "string",
  "String",
  "number",
  "Number",
  "boolean",
  "Boolean",
  "object",
  "Object",
  "array",
  "Array",
  "union",
  "Union",
  "optional",
  "Optional",
])

function containsLegacySchemaShape(value: unknown, seen = new WeakSet<object>()): boolean {
  if (Array.isArray(value)) return value.some((item) => containsLegacySchemaShape(item, seen))
  if (!isRecord(value) || seen.has(value)) return false
  seen.add(value)
  if (LEGACY_SCHEMA_KINDS.has(stringValue(value.kind) ?? "")) return true
  const type = stringValue(value.type)
  if (type && /^[A-Z]/.test(type) && LEGACY_SCHEMA_KINDS.has(type)) return true

  // Recurse only through positions that contain schemas. Annotation/assertion
  // payloads such as const, default, examples, and enum are arbitrary JSON and
  // may legitimately contain fields named `kind` or `type`.
  const schemaMaps = [
    value.properties,
    value.patternProperties,
    value.dependentSchemas,
    value.$defs,
    value.definitions,
  ]
  for (const schemaMap of schemaMaps) {
    if (
      isRecord(schemaMap) &&
      Object.values(schemaMap).some((item) => containsLegacySchemaShape(item, seen))
    ) {
      return true
    }
  }

  const schemaArrays = [value.prefixItems, value.anyOf, value.oneOf, value.allOf, value.variants]
  for (const schemaArray of schemaArrays) {
    if (
      Array.isArray(schemaArray) &&
      schemaArray.some((item) => containsLegacySchemaShape(item, seen))
    ) {
      return true
    }
  }

  const schemaValues = [
    value.items,
    value.additionalProperties,
    value.unevaluatedProperties,
    value.propertyNames,
    value.contains,
    value.not,
    value.if,
    value.then,
    value.else,
    value.wrapped,
    value.inner,
    value.element,
  ]
  return schemaValues.some((item) => containsLegacySchemaShape(item, seen))
}

export function toJsonSchema(schema: unknown): unknown {
  if ((typeof schema === "object" && schema !== null) || typeof schema === "function") {
    const toJsonSchemaMethod = (schema as { toJsonSchema?: unknown }).toJsonSchema
    if (typeof toJsonSchemaMethod === "function") {
      try {
        return toJsonSchema(
          toJsonSchemaMethod.call(schema, {
            target: "draft-2020-12",
            fallback: (context: { base?: unknown }) => context.base ?? {},
          }),
        )
      } catch {
        return {}
      }
    }
  }

  if (!isRecord(schema)) return {}

  // OMP 17 exposes standards-compliant JSON Schema. Forward it losslessly;
  // only the older `kind` shapes below need conversion.
  const containsLegacyShape = containsLegacySchemaShape(schema)
  if (!("kind" in schema) && !containsLegacyShape) {
    try {
      const cloned: unknown = JSON.parse(JSON.stringify(schema))
      return isRecord(cloned) ? cloned : {}
    } catch {
      return {}
    }
  }

  const kind = stringValue(schema.kind) ?? stringValue(schema.type)
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined
  if (enumValues) {
    return { type: typeof enumValues[0], enum: enumValues }
  }

  switch (kind) {
    case "string":
    case "String":
      return { type: "string" }
    case "number":
    case "Number":
      return { type: "number" }
    case "boolean":
    case "Boolean":
      return { type: "boolean" }
    case "object":
    case "Object": {
      const properties: Record<string, unknown> = {}
      const inferredRequired: string[] = []
      const sourceProperties = isRecord(schema.properties) ? schema.properties : undefined
      const optional = Array.isArray(schema.optional)
        ? schema.optional.filter((item): item is string => typeof item === "string")
        : []

      if (sourceProperties) {
        for (const [key, value] of Object.entries(sourceProperties)) {
          properties[key] = toJsonSchema(value)
          const valueRecord = isRecord(value) ? value : undefined
          if (booleanValue(valueRecord?.optional) !== true && !optional.includes(key)) {
            inferredRequired.push(key)
          }
        }
      }

      const explicitRequired = Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === "string")
        : undefined
      const required = explicitRequired ?? inferredRequired
      const out: Record<string, unknown> = { type: "object" }
      if (Object.keys(properties).length > 0) out.properties = properties
      if (required.length > 0) out.required = required
      return out
    }
    case "array":
    case "Array":
      return {
        type: "array",
        items: toJsonSchema(schema.items ?? schema.element),
      }
    case "union":
    case "Union": {
      const variants = Array.isArray(schema.variants)
        ? schema.variants
        : Array.isArray(schema.anyOf)
          ? schema.anyOf
          : []
      for (const variant of variants) {
        const converted = toJsonSchema(variant)
        if (isRecord(converted) && Object.keys(converted).length > 0) return converted
      }
      return {}
    }
    case "optional":
    case "Optional":
      return toJsonSchema(schema.wrapped ?? schema.inner)
    default:
      return {}
  }
}

export function toolsToJson(tools?: readonly ToolLike[]): unknown[] {
  if (!tools) return []
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters ? toJsonSchema(tool.parameters) : {},
  }))
}

function completeToolCallIds(messages?: readonly MessageLike[]): Set<string> {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()

  for (const message of messages ?? []) {
    if (message.role === "assistant") {
      for (const content of recordArray(message.content)) {
        if (content.type === "toolCall") {
          const id = stringValue(content.id)
          if (id) callIds.add(id)
        }
      }
    } else if (message.role === "toolResult") {
      if (message.toolCallId) resultIds.add(message.toolCallId)
    }
  }

  return new Set([...callIds].filter((id) => resultIds.has(id)))
}

export function messagesToCC(
  messages?: readonly MessageLike[],
  options: MessagesToCCOptions = {},
): unknown[] {
  const out: unknown[] = []
  const pairedToolCallIds = completeToolCallIds(messages)
  const supportsVision = options.supportsVision === true

  for (const message of messages ?? []) {
    if (message.role === "user") {
      out.push({
        role: "user",
        content: userContentToCC(message.content, supportsVision),
      })
    } else if (message.role === "assistant") {
      const parts: unknown[] = []
      for (const content of recordArray(message.content)) {
        if (content.type === "text") {
          parts.push({ type: "text", text: stringValue(content.text) ?? "" })
        } else if (content.type === "thinking") {
          parts.push({
            type: "reasoning",
            text: stringValue(content.thinking) ?? "",
          })
        } else if (content.type === "toolCall") {
          const toolCallId = stringValue(content.id) ?? ""
          if (!pairedToolCallIds.has(toolCallId)) continue
          parts.push({
            type: "tool-call",
            toolCallId,
            toolName: stringValue(content.name) ?? "",
            input: recordOrEmpty(content.arguments),
          })
        }
      }
      if (parts.length > 0) out.push({ role: "assistant", content: parts })
    } else if (message.role === "toolResult") {
      if (!message.toolCallId || !pairedToolCallIds.has(message.toolCallId)) continue
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            output: message.isError
              ? { type: "error-text", value: textContent(message) }
              : { type: "text", value: textContent(message) },
          },
        ],
      })
    }
  }
  return out
}

function imagePartToCC(
  part: Record<string, unknown>,
): { type: "image"; image: string; mimeType: string } | undefined {
  const data = stringValue(part.data)
  if (!data) return undefined

  const dataUrlMimeType = /^data:([^;,]+)/.exec(data)?.[1]
  const mimeType = stringValue(part.mimeType) ?? dataUrlMimeType ?? DEFAULT_IMAGE_MIME_TYPE
  const image = data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`
  return { type: "image", image, mimeType }
}

function userContentToCC(content: unknown, supportsVision: boolean): unknown {
  if (typeof content === "string") return content

  type CCUserPart =
    | { type: "text"; text: string }
    | { type: "image"; image: string; mimeType: string }
  const parts: CCUserPart[] = []
  let omittedImages = false
  let malformedImages = false

  for (const part of recordArray(content)) {
    if (part.type === "text") {
      parts.push({ type: "text", text: stringValue(part.text) ?? "" })
      continue
    }

    if (part.type === "image") {
      if (supportsVision) {
        const imagePart = imagePartToCC(part)
        if (imagePart) {
          parts.push(imagePart)
        } else {
          malformedImages = true
        }
      } else {
        omittedImages = true
      }
    }
  }

  if (malformedImages) parts.push({ type: "text", text: MALFORMED_IMAGE_PLACEHOLDER })
  if (omittedImages) parts.push({ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER })
  if (parts.length === 0) return ""

  if (parts.length === 1 && parts[0]?.type === "text") return parts[0].text
  return parts
}

export function parseStreamEventLine(line: string): unknown | undefined {
  let trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return undefined
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim()
  if (!trimmed || trimmed === "[DONE]") return undefined

  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed
  } catch {
    return undefined
  }
}

export function mapFinishReason(reason: unknown): StopReason {
  if (reason === "tool-calls") return "toolUse"
  if (
    reason === "length" ||
    reason === "max_tokens" ||
    reason === "max-tokens" ||
    reason === "max_output_tokens"
  ) {
    return "length"
  }
  return "stop"
}
