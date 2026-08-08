export function redactSensitiveText(message: string, secrets: readonly string[] = []): string {
  let redacted = message
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]")
  }
  return redacted
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\buser_[A-Za-z0-9._~-]+/g, "user_[REDACTED]")
}
