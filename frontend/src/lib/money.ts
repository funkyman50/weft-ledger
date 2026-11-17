export interface FormatCentsOptions {
  sign?: boolean
  symbol?: boolean
  grouping?: boolean
}

const GROUPED_DOLLAR_FORMATTER = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatCents(cents: number, options: FormatCentsOptions = {}): string {
  const { sign = true, symbol = false, grouping = false } = options
  const abs = Math.abs(cents) / 100
  const digits = grouping
    ? GROUPED_DOLLAR_FORMATTER.format(abs)
    : abs.toFixed(2)
  return `${sign && cents < 0 ? '-' : ''}${symbol ? '$' : ''}${digits}`
}

export function money(cents: number, showPlus = false): string {
  const value = formatCents(cents, { symbol: true, grouping: true }).replace(/^-/, '−')
  return showPlus && cents > 0 ? `+${value}` : value
}

export function amountInputText(value: string): string | null {
  const normalized = value.replace(/\s/g, '').replace(/−/g, '-')
  const digits = normalized.replace(/[$,-]/g, '')
  return /^[0-9.,$-]*$/.test(normalized) && /^\d*(?:\.\d{0,2})?$/.test(digits) ? normalized : null
}
