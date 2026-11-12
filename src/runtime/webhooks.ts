import { createHmac, timingSafeEqual } from 'node:crypto'

import { queryAll, queryOne } from './jsonpath'
import { mapRecord } from './mapper'

import type { ParsedConnectorSpec } from '../spec'
import type { WebhookEvent } from '../types'

export type WebhookDelivery = {
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>
  rawBody: string
  /** The connection's signing secret (or client secret for HubSpot). */
  secret?: string
  /** Full URL the provider called (HubSpot v3 signs it). */
  url?: string
  method?: string
  /** Max age of a signed timestamp. */
  toleranceSeconds?: number
}

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const hmac = (secret: string, payload: string, encoding: 'hex' | 'base64', algorithm: 'sha256' | 'sha1' = 'sha256') =>
  createHmac(algorithm, secret).update(payload, 'utf8').digest(encoding)

function fresh(timestampSeconds: number, tolerance: number) {
  return Number.isFinite(timestampSeconds) && Math.abs(Date.now() / 1000 - timestampSeconds) <= tolerance
}

/** True when the delivery carries a valid signature for the spec's scheme. */
export function verifyWebhook(spec: ParsedConnectorSpec, delivery: WebhookDelivery): boolean {
  const signature = spec.webhooks?.signature
  if (!signature) {
    return false
  }
  const tolerance = delivery.toleranceSeconds ?? 300
  const header = (name: string) => delivery.headers[name.toLowerCase()]
  const secret = delivery.secret
  if (signature.scheme === 'none') {
    return true
  }
  if (!secret) {
    return false
  }
  switch (signature.scheme) {
    case 'hmacSha256': {
      const sent = header(signature.header)
      if (!sent) {
        return false
      }
      let payload = delivery.rawBody
      if (signature.timestampHeader) {
        const timestamp = header(signature.timestampHeader)
        if (!timestamp) {
          return false
        }
        payload = timestamp + delivery.rawBody
      }
      return safeEqual(sent, signature.prefix + hmac(secret, payload, signature.encoding, signature.algorithm))
    }
    case 'sharedSecret': {
      const sent = header(signature.header)
      if (!sent) {
        return false
      }
      const basic = /^Basic\s+(.+)$/i.exec(sent)
      if (basic) {
        return safeEqual(Buffer.from(basic[1], 'base64').toString('utf8'), secret)
      }
      return safeEqual(sent.replace(/^Bearer\s+/i, ''), secret)
    }
    case 'stripe': {
      // Stripe-Signature: t=…,v1=…[,v1=…]
      const parts = (header('stripe-signature') ?? '').split(',').map((part) => part.split('='))
      const timestamp = Number(parts.find(([key]) => key === 't')?.[1])
      const expected = hmac(secret, `${timestamp}.${delivery.rawBody}`, 'hex')
      return (
        fresh(timestamp, tolerance) &&
        parts.some(([key, value]) => key === 'v1' && value !== undefined && safeEqual(value, expected))
      )
    }
    case 'paddle': {
      // Paddle-Signature: ts=…;h1=…
      const parts = Object.fromEntries(
        (header('paddle-signature') ?? '').split(';').map((part) => part.split('=') as [string, string])
      )
      const timestamp = Number(parts.ts)
      return (
        fresh(timestamp, tolerance) &&
        Boolean(parts.h1) &&
        safeEqual(parts.h1, hmac(secret, `${parts.ts}:${delivery.rawBody}`, 'hex'))
      )
    }
    case 'hubspotV3': {
      // base64 HMAC of method + uri + body + timestamp, timestamp in ms.
      const sent = header('x-hubspot-signature-v3')
      const timestamp = header('x-hubspot-request-timestamp')
      if (!sent || !timestamp || !delivery.url) {
        return false
      }
      if (!fresh(Number(timestamp) / 1000, tolerance)) {
        return false
      }
      const payload = `${delivery.method ?? 'POST'}${decodeURIComponent(delivery.url)}${delivery.rawBody}${timestamp}`
      return safeEqual(sent, hmac(secret, payload, 'base64'))
    }
  }
}

function routeFor(spec: ParsedConnectorSpec, type: string) {
  const routes = spec.webhooks?.routes ?? {}
  if (Object.prototype.hasOwnProperty.call(routes, type)) {
    return routes[type]
  }
  // The most specific pattern wins: `charge.dispute.*` before `charge.*`, whatever the declaration order.
  const patterns = Object.keys(routes)
    .filter((pattern) => pattern.includes('*'))
    .sort((a, b) => b.replace(/\*/g, '').length - a.replace(/\*/g, '').length)
  for (const pattern of patterns) {
    const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
    if (regex.test(type)) {
      return routes[pattern]
    }
  }
  return undefined
}

/** The events of one verified delivery, routed to streams. Unrouted event types are dropped. */
export function parseWebhook(spec: ParsedConnectorSpec, body: unknown): WebhookEvent[] {
  const webhooks = spec.webhooks
  if (!webhooks) {
    return []
  }
  const events = webhooks.events ? queryAll(body, webhooks.events).flat() : [body]
  const out: WebhookEvent[] = []
  for (const event of events) {
    const base = queryOne(event, webhooks.type)
    const suffix = webhooks.typeSuffix ? queryOne(event, webhooks.typeSuffix) : undefined
    const type = typeof base === 'string' && suffix !== undefined && suffix !== null ? `${base}.${suffix}` : base
    const baseId = queryOne(event, webhooks.id)
    const idSuffix = webhooks.idSuffix ? queryOne(event, webhooks.idSuffix) : undefined
    const id =
      baseId !== undefined && baseId !== null && idSuffix !== undefined && idSuffix !== null ?
        `${baseId}:${idSuffix}`
      : baseId
    if (typeof type !== 'string' || id === undefined || id === null) {
      continue
    }
    const route = routeFor(spec, type)
    if (!route) {
      continue
    }
    const stream = spec.streams[route.stream]
    const object = webhooks.object ? queryOne(event, webhooks.object) : undefined
    const record = object && route.action === 'upsert' ? mapRecord(object, stream) : undefined
    const objectId = webhooks.objectId ? queryOne(event, webhooks.objectId) : undefined
    const externalId =
      record?.externalId ??
      (objectId !== undefined && objectId !== null ? String(objectId)
      : object ? String(queryOne(object, stream.id) ?? '')
      : undefined)
    out.push({
      id: String(id),
      type,
      stream: route.stream,
      action: route.action === 'upsert' && !record ? 'refetch' : route.action,
      ...(externalId ? { externalId } : {}),
      ...(record ? { record } : {})
    })
  }
  return out
}
