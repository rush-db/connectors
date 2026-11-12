import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * Custom and AI-built connectors call URLs a person (or a model) typed. Before
 * each request, the host must resolve only to public addresses: no loopback,
 * private, link-local (cloud metadata), CGNAT or multicast ranges, and HTTPS
 * only. Built-in connectors call fixed provider hosts and skip the check.
 */
export type EgressPolicy = 'public-only' | 'any'

export class EgressError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EgressError'
  }
}

function ipv4Blocked(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function ipv6Blocked(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::1') {
    return true
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped) {
    return ipv4Blocked(mapped[1])
  }
  // WHATWG URL parsing rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16)
    const low = parseInt(mappedHex[2], 16)
    return ipv4Blocked(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower)
}

export function isBlockedAddress(ip: string): boolean {
  return isIP(ip) === 6 ? ipv6Blocked(ip) : ipv4Blocked(ip)
}

export async function assertEgressAllowed(url: string, policy: EgressPolicy): Promise<void> {
  if (policy === 'any') {
    return
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new EgressError(`Not a URL: ${url}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new EgressError(`Only HTTPS URLs are allowed: ${parsed.origin}`)
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new EgressError(`Host not allowed: ${host}`)
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new EgressError(`Host resolves to a private or reserved address: ${host}`)
  }
}
