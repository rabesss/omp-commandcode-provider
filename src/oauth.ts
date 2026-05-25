/**
 * Command Code OAuth provider for OMP's /login flow.
 *
 * Implements a browser-assisted API key retrieval flow:
 * 1. Starts a local HTTP server on a Command Code CLI-compatible port
 * 2. Opens the Command Code Studio auth page in the browser
 * 3. The user authenticates on the Command Code website
 * 4. The website POSTs the API key back to the local server
 * 5. If browser transfer fails, the user can paste the API key manually
 * 6. The API key is handed back to OMP as provider auth credentials
 *
 * Since Command Code API keys don't expire, we store them as
 * OAuth credentials with a far-future expiry.
 */

import { randomBytes } from "node:crypto"
import { startAuthServer } from "./auth-server.ts"

const STUDIO_BASE_URL = "https://commandcode.ai"
const CALLBACK_HOST = "127.0.0.1"
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000 // API keys don't expire
const DEFAULT_AUTH_TIMEOUT_MS = 15_000

export interface OAuthLoginCallbacks {
  onAuth(params: { url: string }): void
  onPrompt(params: { message: string }): Promise<string>
}

export interface OAuthCredentials {
  refresh: string
  access: string
  expires: number
}

class AuthTimeoutError extends Error {
  constructor() {
    super("Browser authentication timed out")
    this.name = "AuthTimeoutError"
  }
}

function generateStateToken(): string {
  return randomBytes(32).toString("base64url")
}

function getAuthTimeoutMs(): number {
  const raw = process.env.COMMANDCODE_AUTH_TIMEOUT_MS
  if (!raw) return DEFAULT_AUTH_TIMEOUT_MS

  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AUTH_TIMEOUT_MS
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AuthTimeoutError()), timeoutMs)

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function credentialsFromApiKey(apiKey: string): OAuthCredentials {
  return {
    refresh: apiKey,
    access: apiKey,
    expires: Date.now() + TEN_YEARS_MS,
  }
}

/**
 * Remove common terminal paste wrappers/control chars and surrounding whitespace.
 */
export function sanitizeApiKey(input: string): string {
  const esc = String.fromCharCode(27)
  return Array.from(
    input
      .replaceAll(`${esc}[200~`, "")
      .replaceAll(`${esc}[201~`, "")
      .replaceAll("[200~", "")
      .replaceAll("[201~", ""),
  )
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code > 31 && code !== 127
    })
    .join("")
    .trim()
}

async function promptForApiKey(callbacks: OAuthLoginCallbacks, message: string) {
  const apiKey = sanitizeApiKey(await callbacks.onPrompt({ message }))
  if (!apiKey) throw new Error("No Command Code API key provided")
  return credentialsFromApiKey(apiKey)
}

/**
 * Starts the browser-based login flow for Command Code.
 *
 * Returns OAuth credentials where access == refresh == the user's API key.
 * The keys don't expire, so we set a far-future expiry.
 */
export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  let authServer
  try {
    authServer = await startAuthServer()
  } catch {
    return promptForApiKey(
      callbacks,
      "Could not start browser auth. Paste your Command Code API key:",
    )
  }

  const stateToken = generateStateToken()
  const callbackUrl = `http://${CALLBACK_HOST}:${authServer.port}/callback`
  const authUrl = `${STUDIO_BASE_URL}/studio/auth/cli?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(stateToken)}`

  // Tell OMP to open the browser.
  callbacks.onAuth({ url: authUrl })

  // Wait for the Command Code Studio to POST the API key back. If the browser
  // cannot reach the loopback callback (Command Code shows "Copy your API key"), fall back
  // to OMP's prompt so the user can paste the key from the browser.
  let callback: { apiKey: string; state: string }
  try {
    callback = await withTimeout(authServer.waitForCallback, getAuthTimeoutMs())
  } catch (error) {
    authServer.server.close()
    if (error instanceof AuthTimeoutError) {
      return promptForApiKey(
        callbacks,
        "Automatic transfer failed or timed out. Paste your Command Code API key:",
      )
    }
    throw error
  }

  // Validate state token to prevent CSRF.
  if (callback.state !== stateToken) {
    authServer.server.close()
    throw new Error("State token mismatch. Authentication may have been tampered with.")
  }

  return credentialsFromApiKey(callback.apiKey)
}

/**
 * Command Code API keys don't expire, so "refresh" is a no-op.
 * Returns the same credentials with an updated far-future expiry.
 */
export async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return credentialsFromApiKey(credentials.refresh)
}

/**
 * Returns the access token (API key) from OAuth credentials.
 */
export function getApiKey(credentials: OAuthCredentials): string {
  return credentials.access
}
