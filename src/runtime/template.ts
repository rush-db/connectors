/**
 * `{{config.subdomain}}`, `{{cursor|unix}}`, `{{credentials.instance_url}}`.
 * Filters: `unix`, `unixMs`, `iso`, `date` (YYYY-MM-DD), `sqlDatetime`
 * (`YYYY-MM-DD HH:mm:ss` in UTC, ServiceNow), `urlencode`, `json`.
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)(?:\s*\|\s*([a-zA-Z]+))?\s*\}\}/g
const WHOLE = /^\{\{\s*([a-zA-Z0-9_.]+)(?:\s*\|\s*([a-zA-Z]+))?\s*\}\}$/

export type TemplateScope = Record<string, unknown>

/** Marks a value that resolved to nothing: the field holding it is dropped. */
export const MISSING = Symbol('missing')

function lookup(scope: TemplateScope, path: string): unknown {
  let current: any = scope
  for (const key of path.split('.')) {
    if (current === null || current === undefined) {
      return undefined
    }
    current = current[key]
  }
  return current
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return value
  }
  if (typeof value === 'number') {
    // Seconds or milliseconds, by magnitude.
    return new Date(value < 1e12 ? value * 1000 : value)
  }
  if (typeof value === 'string' && value) {
    if (/^\d+$/.test(value)) {
      return toDate(Number(value))
    }
    // A date-time without a zone (ServiceNow `2024-01-01 12:00:00`) is UTC, not the host's local time.
    const zoneless = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(value)
    const date = new Date(zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : value)
    return Number.isNaN(date.getTime()) ? undefined : date
  }
  return undefined
}

function applyFilter(value: unknown, filter: string | undefined): unknown {
  if (!filter || value === undefined || value === null) {
    return value
  }
  switch (filter) {
    case 'unix': {
      const date = toDate(value)
      return date ? Math.floor(date.getTime() / 1000) : undefined
    }
    case 'unixMs': {
      const date = toDate(value)
      return date ? date.getTime() : undefined
    }
    case 'iso':
      return toDate(value)?.toISOString()
    case 'date':
      return toDate(value)?.toISOString().slice(0, 10)
    case 'sqlDatetime':
      return toDate(value)?.toISOString().slice(0, 19).replace('T', ' ')
    case 'urlencode':
      return encodeURIComponent(String(value))
    case 'json':
      return JSON.stringify(value)
    default:
      throw new Error(`Unknown template filter "${filter}"`)
  }
}

/** Resolve one string; an exact single placeholder keeps the value's type. */
export function renderString(template: string, scope: TemplateScope): unknown {
  const whole = WHOLE.exec(template)
  if (whole) {
    const value = applyFilter(lookup(scope, whole[1]), whole[2])
    return value === undefined ? MISSING : value
  }
  let missing = false
  const rendered = template.replace(PLACEHOLDER, (_match, path: string, filter?: string) => {
    const value = applyFilter(lookup(scope, path), filter)
    if (value === undefined || value === null) {
      missing = true
      return ''
    }
    return String(value)
  })
  return missing ? MISSING : rendered
}

/** Resolve every string in a value (objects and arrays deep); fields that resolve to nothing are dropped. */
export function render(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === 'string') {
    return renderString(value, scope)
  }
  if (Array.isArray(value)) {
    return value.map((item) => render(item, scope)).filter((item) => item !== MISSING)
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const rendered = render(item, scope)
      if (rendered !== MISSING) {
        out[key] = rendered
      }
    }
    return out
  }
  return value
}

/** Like `render` for a URL or path: a missing placeholder is an error, not a dropped field. */
export function renderRequired(template: string, scope: TemplateScope, what: string): string {
  const value = renderString(template, scope)
  if (value === MISSING) {
    throw new Error(`${what} needs a value that is not set: ${template}`)
  }
  return String(value)
}

export { toDate }
