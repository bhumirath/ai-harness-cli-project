import pc from 'picocolors'

export interface OutputOpts {
  json?: boolean
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** Simple aligned table (no dependency). Cells are stringified and truncated. */
export function printTable(rows: Record<string, unknown>[], columns: string[], max = 60): void {
  if (rows.length === 0) {
    console.log(pc.dim('(none)'))
    return
  }
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ')
    return s.length > max ? `${s.slice(0, max - 1)}…` : s
  }
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)))
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd()
  console.log(pc.bold(line(columns.map((c) => c.toUpperCase()))))
  for (const r of rows) console.log(line(columns.map((c) => cell(r[c]))))
}

export const MICRO_PER_CREDIT = 1_000_000n

/** micro-credits (integer string) → "12.34" credits (1 credit = ฿1). BigInt only, no floats. */
export function formatCredits(micro: string | bigint, decimals = 2): string {
  const v = typeof micro === 'bigint' ? micro : BigInt(micro)
  const neg = v < 0n
  const abs = neg ? -v : v
  const scale = 10n ** BigInt(6 - decimals)
  const rounded = (abs + scale / 2n) / scale // half-up at the shown precision
  const whole = rounded / 10n ** BigInt(decimals)
  const frac = (rounded % 10n ** BigInt(decimals)).toString().padStart(decimals, '0')
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${wholeStr}${decimals ? `.${frac}` : ''}`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}
