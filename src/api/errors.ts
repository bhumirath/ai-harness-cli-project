/** Exit codes (docs/10-cli.md). */
export const EXIT = { ok: 0, error: 1, usage: 2, auth: 3, payment: 4 } as const

export class CliError extends Error {
  readonly exitCode: number
  readonly code?: string
  readonly status?: number
  constructor(message: string, opts: { exitCode?: number; code?: string; status?: number } = {}) {
    super(message)
    this.name = 'CliError'
    this.exitCode = opts.exitCode ?? EXIT.error
    this.code = opts.code
    this.status = opts.status
  }

  /** From the API's `{ error: { code, message } }` body. */
  static fromResponse(status: number, body: unknown): CliError {
    const err =
      body && typeof body === 'object' && 'error' in body
        ? (body as { error?: { code?: unknown; message?: unknown } }).error
        : undefined
    const code = typeof err?.code === 'string' ? err.code : undefined
    let message = typeof err?.message === 'string' ? err.message : `HTTP ${status}`
    let exitCode: number = EXIT.error
    if (status === 401) {
      exitCode = EXIT.auth
      message = `${message} — run \`harness login\``
    } else if (status === 402) {
      exitCode = EXIT.payment
    } else if (code === 'FREE_QUOTA_EXCEEDED') {
      exitCode = EXIT.payment
      const details = (body as { error?: { details?: { limit?: number; resetAt?: string } } }).error
        ?.details
      if (details?.resetAt) {
        message = `Daily free messages used up (${details.limit ?? '?'}/day) — resets ${new Date(details.resetAt).toLocaleString()}. Add your own API key or buy credits to continue.`
      }
    } else if (code === 'EMAIL_NOT_VERIFIED') {
      message = `${message} — open the web app and verify your email`
    }
    return new CliError(message, { exitCode, code, status })
  }
}
