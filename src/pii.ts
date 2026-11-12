import { createHmac } from 'node:crypto'

/*
 * Field doctrine: which properties of a stream may enter the graph.
 *
 * When a connection is configured, its fields are profiled and the ones that
 * look like personal data are proposed for exclusion (by name first, then by
 * the values sampled). A person confirms or corrects the proposal; from then
 * on every batch passes through the same policy, wherever it is applied (the
 * platform, and the on-prem agent before anything leaves the customer's
 * network).
 */

export type PiiKind =
  | 'email'
  | 'phone'
  | 'name'
  | 'address'
  | 'birthdate'
  | 'national_id'
  | 'tax_id'
  | 'payment_card'
  | 'bank_account'
  | 'ip_address'
  | 'credentials'
  | 'compensation'
  | 'health'
  | 'location'
  | 'free_text'

export type PiiFinding = {
  kind: PiiKind
  /** Where the suspicion comes from: the field name, or values that match a pattern. */
  source: 'name' | 'value'
  /** 0–1. Name matches of strong patterns and Luhn-valid cards are high; free text is low. */
  confidence: number
  reason: string
}

/** Name patterns, tested against the snake_case property name. Order matters: first match wins. */
const NAME_PATTERNS: Array<{ kind: PiiKind; pattern: RegExp; confidence: number }> = [
  { kind: 'credentials', pattern: /(^|_)(password|passwd|secret|api_?key|access_?token|refresh_?token|private_?key|otp|pin)(_|$)/, confidence: 0.95 },
  { kind: 'payment_card', pattern: /(^|_)(card_?number|cc_?num|pan|cvv|cvc)(_|$)/, confidence: 0.95 },
  { kind: 'bank_account', pattern: /(^|_)(iban|bic|swift|account_?number|routing_?number|sort_?code|bank_?account)(_|$)/, confidence: 0.9 },
  { kind: 'national_id', pattern: /(^|_)(ssn|social_?security|national_?id|passport|driver_?licen[cs]e|nin|personal_?id|inn|snils|tckn|aadhaar)(_|$)/, confidence: 0.95 },
  { kind: 'tax_id', pattern: /(^|_)(tax_?id|vat_?(id|number)|tin|ein)(_|$)/, confidence: 0.7 },
  { kind: 'email', pattern: /(^|_)e_?mail(s|_address)?(_|$)/, confidence: 0.9 },
  { kind: 'phone', pattern: /(^|_)(phone|mobile|cell|fax|tel|telephone|msisdn|whatsapp)(_?(number|no))?(_|$)/, confidence: 0.9 },
  { kind: 'birthdate', pattern: /(^|_)(dob|birth_?(date|day)|date_?of_?birth|birthday)(_|$)/, confidence: 0.95 },
  { kind: 'address', pattern: /(^|_)(street|address(_?line)?(_?\d)?|addr|postal_?code|post_?code|zip(_?code)?|house_?number|apartment)(_|$)/, confidence: 0.8 },
  { kind: 'location', pattern: /(^|_)(lat|lng|lon|latitude|longitude|geo_?location|gps)(_|$)/, confidence: 0.6 },
  { kind: 'ip_address', pattern: /(^|_)(ip|ip_?address|ipv4|ipv6|remote_?addr|client_?ip)(_|$)/, confidence: 0.85 },
  { kind: 'name', pattern: /(^|_)(first_?name|last_?name|full_?name|given_?name|family_?name|surname|middle_?name|maiden_?name|contact_?name|person_?name)(_|$)/, confidence: 0.85 },
  { kind: 'compensation', pattern: /(^|_)(salary|wage|compensation|payroll|bonus)(_|$)/, confidence: 0.7 },
  { kind: 'health', pattern: /(^|_)(diagnosis|medical|health|allerg(y|ies)|disability|blood_?type)(_|$)/, confidence: 0.8 },
  { kind: 'free_text', pattern: /(^|_)(transcript|body|message|notes?|comment|description|content)(_|$)/, confidence: 0.3 }
]

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[A-Za-z]{2,}$/
const PHONE = /^\+?[\d\s().-]{7,20}$/
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const IPV6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i
const US_SSN = /^\d{3}-\d{2}-\d{4}$/
const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/

function luhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index])
    if (double) {
      digit *= 2
      if (digit > 9) {
        digit -= 9
      }
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

function valueKind(value: string): PiiKind | undefined {
  const text = value.trim()
  if (text.length === 0 || text.length > 254) {
    return undefined
  }
  if (EMAIL.test(text)) {
    return 'email'
  }
  if (US_SSN.test(text)) {
    return 'national_id'
  }
  const compact = text.replace(/[\s-]/g, '')
  if (/^\d{13,19}$/.test(compact) && luhn(compact)) {
    return 'payment_card'
  }
  if (IBAN.test(compact.toUpperCase()) && /^[A-Z]{2}/.test(compact)) {
    return 'bank_account'
  }
  if (IPV4.test(text) || (text.includes(':') && IPV6.test(text))) {
    return 'ip_address'
  }
  // Phone last: plain numbers (ids, amounts) are not phones unless formatted like one.
  const digits = text.match(/\d/g)?.length ?? 0
  // E.164: at most 15 digits.
  if (PHONE.test(text) && /[+()\s-]/.test(text) && digits >= 7 && digits <= 15) {
    return 'phone'
  }
  return undefined
}

/**
 * Does this field look like personal data? `samples` are a few values of it.
 * Values are only inspected, never kept or returned.
 */
export function detectPii(name: string, samples: unknown[] = []): PiiFinding | undefined {
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
  for (const { kind, pattern, confidence } of NAME_PATTERNS) {
    if (pattern.test(normalized)) {
      return { kind, source: 'name', confidence, reason: `The name "${name}" suggests ${kind.replace('_', ' ')}` }
    }
  }
  const strings = samples
    .flatMap((sample) => (Array.isArray(sample) ? sample : [sample]))
    .filter((sample): sample is string | number => typeof sample === 'string' || typeof sample === 'number')
    .map(String)
  if (strings.length === 0) {
    return undefined
  }
  const counts = new Map<PiiKind, number>()
  for (const sample of strings) {
    const kind = valueKind(sample)
    if (kind) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
  }
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1])
  if (!best) {
    return undefined
  }
  const share = best[1] / strings.length
  if (share < 0.5) {
    return undefined
  }
  return {
    kind: best[0],
    source: 'value',
    confidence: Math.min(0.95, 0.5 + share / 2),
    reason: `${best[1]} of ${strings.length} sampled values look like ${best[0].replace('_', ' ')}`
  }
}

/**
 * A stream's field doctrine.
 *
 * - `auto`: nobody reviewed the stream yet; every field passes except the
 *   ones whose name looks like personal data (and `exclude`).
 * - `allowlist`: reviewed; only `include` and `hash` fields pass. Fields
 *   that show up later are held back and reported, never written, until a
 *   person reviews them.
 */
export type FieldPolicy = {
  mode: 'auto' | 'allowlist'
  include?: string[]
  exclude?: string[]
  /** Kept as a keyed hash: joinable with the same value hashed elsewhere in the project, not readable. */
  hash?: string[]
  reviewedAt?: string
  reviewedBy?: string
}

/** Properties a policy never touches: identity and sync bookkeeping. */
export const SYSTEM_PROPERTIES = new Set(['external_id', 'synced_at', 'deleted', 'deleted_at', 'received_at'])

export const AUTO_POLICY: FieldPolicy = { mode: 'auto' }

/** Keyed SHA-256 (hex) of a value: the same key and value always give the same hash. */
export function hashPiiValue(value: unknown, key: string): string | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const text = typeof value === 'string' ? value.trim().toLowerCase() : JSON.stringify(value)
  return createHmac('sha256', key).update(text).digest('hex')
}

export type PolicyResult = {
  properties: Record<string, unknown>
  /** Fields the policy held back because nobody reviewed them (allowlist mode). */
  unreviewed: string[]
  /** Fields dropped as excluded or auto-detected personal data. */
  dropped: string[]
}

/**
 * Apply a stream's doctrine to one record's properties. `hashKey` is the
 * project's hashing key; without one, fields to hash are dropped (never sent
 * in the clear).
 */
export function applyFieldPolicy(
  properties: Record<string, unknown>,
  policy: FieldPolicy | null | undefined,
  hashKey?: string
): PolicyResult {
  const effective = policy ?? AUTO_POLICY
  const include = new Set(effective.include ?? [])
  const exclude = new Set(effective.exclude ?? [])
  const hash = new Set(effective.hash ?? [])
  const out: Record<string, unknown> = {}
  const unreviewed: string[] = []
  const dropped: string[] = []
  for (const [key, value] of Object.entries(properties)) {
    if (SYSTEM_PROPERTIES.has(key)) {
      out[key] = value
      continue
    }
    if (exclude.has(key)) {
      dropped.push(key)
      continue
    }
    if (hash.has(key)) {
      if (hashKey) {
        out[key] = Array.isArray(value) ? value.map((item) => hashPiiValue(item, hashKey)) : hashPiiValue(value, hashKey)
      } else {
        dropped.push(key)
      }
      continue
    }
    if (effective.mode === 'allowlist') {
      if (include.has(key)) {
        out[key] = value
      } else {
        unreviewed.push(key)
      }
      continue
    }
    const finding = detectPii(key)
    if (finding && finding.kind !== 'free_text' && finding.confidence >= 0.7) {
      dropped.push(key)
      continue
    }
    out[key] = value
  }
  return { properties: out, unreviewed, dropped }
}

export type FieldProfile = {
  name: string
  type: 'string' | 'number' | 'boolean' | 'datetime' | 'array' | 'null'
  /** Share of sampled records that have a value. */
  coverage: number
  pii?: PiiFinding
  /** A masked example (never a raw value of a field that looks like personal data). */
  example?: string
  /** What the doctrine would do with it now. */
  suggestion: 'include' | 'exclude' | 'hash'
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}.*)?$/

function maskExample(value: unknown, pii: boolean): string | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (pii) {
    return text.length <= 2 ? '••' : `${text[0]}${'•'.repeat(Math.min(8, text.length - 2))}${text[text.length - 1]}`
  }
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}

/**
 * Profile the fields of sample records for review: type, coverage, a PII
 * finding and what to do with the field. Identifiers that also look like
 * personal data (email) are suggested for hashing, so joins keep working.
 */
export function profileFields(records: Array<Record<string, unknown>>): FieldProfile[] {
  const names = new Set<string>()
  records.forEach((record) => Object.keys(record).forEach((name) => names.add(name)))
  const out: FieldProfile[] = []
  for (const name of names) {
    if (SYSTEM_PROPERTIES.has(name)) {
      continue
    }
    const values = records.map((record) => record[name]).filter((value) => value !== null && value !== undefined && value !== '')
    const first = values[0]
    const type: FieldProfile['type'] =
      first === undefined ? 'null'
      : Array.isArray(first) ? 'array'
      : typeof first === 'number' ? 'number'
      : typeof first === 'boolean' ? 'boolean'
      : typeof first === 'string' && ISO_DATE.test(first) ? 'datetime'
      : 'string'
    const pii = detectPii(name, values.slice(0, 50))
    const joinable = pii && (pii.kind === 'email' || pii.kind === 'phone' || pii.kind === 'tax_id')
    out.push({
      name,
      type,
      coverage: records.length ? values.length / records.length : 0,
      ...(pii ? { pii } : {}),
      example: maskExample(first, Boolean(pii)),
      suggestion:
        !pii || pii.kind === 'free_text' || pii.confidence < 0.7 ? 'include'
        : joinable ? 'hash'
        : 'exclude'
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** The allowlist doctrine a review produces from profiles and the person's choices. */
export function policyFromReview(
  choices: Array<{ name: string; action: 'include' | 'exclude' | 'hash' }>,
  reviewedBy?: string
): FieldPolicy {
  return {
    mode: 'allowlist',
    include: choices.filter((choice) => choice.action === 'include').map((choice) => choice.name),
    exclude: choices.filter((choice) => choice.action === 'exclude').map((choice) => choice.name),
    hash: choices.filter((choice) => choice.action === 'hash').map((choice) => choice.name),
    reviewedAt: new Date().toISOString(),
    ...(reviewedBy ? { reviewedBy } : {})
  }
}
