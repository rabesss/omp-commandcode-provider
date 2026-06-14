export const TEXT_INPUT = ["text"] as const
export const TEXT_IMAGE_INPUT = ["text", "image"] as const

/**
 * Vision-capable Command Code models (matches command-code CLI inputModalities).
 * Source: command-code@0.37.2 model catalog.
 */
export type ModelInputModalities = typeof TEXT_INPUT | typeof TEXT_IMAGE_INPUT

export const VISION_MODEL_IDS: ReadonlySet<string> = new Set<string>([
  "claude-sonnet-4-6",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-haiku-4-5-20251001",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.5",
  "MiniMaxAI/MiniMax-M3",
  "xiaomi/mimo-v2.5",
  "Qwen/Qwen3.6-Plus",
  "Qwen/Qwen3.7-Plus",
  "stepfun/Step-3.7-Flash",
  "google/gemini-3.5-flash",
  "google/gemini-3.1-flash-lite",
])

export function modelSupportsVision(modelId: string): boolean {
  return VISION_MODEL_IDS.has(modelId)
}

export function modelInputModalities(modelId: string): ModelInputModalities {
  return modelSupportsVision(modelId) ? TEXT_IMAGE_INPUT : TEXT_INPUT
}
