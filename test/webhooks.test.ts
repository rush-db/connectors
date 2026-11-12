import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { parseConnectorSpec, parseWebhook, verifyWebhook, type ConnectorSpec, type WebhooksSpec } from '../src'

const SECRET = 'whsec_test'
const body = JSON.stringify({ id: 'evt_1', type: 'thing.updated', data: { object: { id: 't1', name: 'A' } } })
const hmac = (payload: string, encoding: 'hex' | 'base64', algorithm = 'sha256') =>
  createHmac(algorithm, SECRET).update(payload).digest(encoding)
const now = () => Math.floor(Date.now() / 1000)

function specWith(webhooks: WebhooksSpec) {
  const spec: ConnectorSpec = {
    id: 'example',
    name: 'Example',
    category: 'custom',
    description: 'Test',
    auth: [{ type: 'none' }],
    baseUrl: 'https://api.example.com',
    streams: {
      things: { label: 'THING', request: { path: '/things' }, records: '$', id: '$.id' },
      parts: { label: 'PART', request: { path: '/parts' }, records: '$', id: '$.id' }
    },
    webhooks
  }
  return parseConnectorSpec(spec)
}

const base = { type: '$.type', id: '$.id', object: '$.data.object', routes: { '*': { stream: 'things' } } }

describe('verifyWebhook', () => {
  it('none accepts everything; a missing secret rejects every signed scheme', () => {
    expect(verifyWebhook(specWith({ ...base, signature: { scheme: 'none' } }), { headers: {}, rawBody: body })).toBe(true)
    const spec = specWith({ ...base, signature: { scheme: 'stripe' } })
    expect(verifyWebhook(spec, { headers: {}, rawBody: body })).toBe(false)
  })

  it('hmacSha256 hex with prefix', () => {
    const spec = specWith({ ...base, signature: { scheme: 'hmacSha256', header: 'X-Hub-Signature', prefix: 'sha256=' } })
    const good = { 'x-hub-signature': `sha256=${hmac(body, 'hex')}` }
    expect(verifyWebhook(spec, { headers: good, rawBody: body, secret: SECRET })).toBe(true)
    expect(verifyWebhook(spec, { headers: good, rawBody: `${body} `, secret: SECRET })).toBe(false)
    expect(verifyWebhook(spec, { headers: {}, rawBody: body, secret: SECRET })).toBe(false)
  })

  it('hmacSha256 base64 over timestamp + body (Zendesk)', () => {
    const spec = specWith({
      ...base,
      signature: { scheme: 'hmacSha256', header: 'X-Sig', timestampHeader: 'X-Sig-Ts', encoding: 'base64' }
    })
    const ts = '2024-01-01T00:00:00Z'
    const headers = { 'x-sig': hmac(ts + body, 'base64'), 'x-sig-ts': ts }
    expect(verifyWebhook(spec, { headers, rawBody: body, secret: SECRET })).toBe(true)
    expect(verifyWebhook(spec, { headers: { 'x-sig': headers['x-sig'] }, rawBody: body, secret: SECRET })).toBe(false)
  })

  it('hmacSha256 with the sha1 algorithm (Intercom)', () => {
    const spec = specWith({
      ...base,
      signature: { scheme: 'hmacSha256', header: 'X-Hub-Signature', prefix: 'sha1=', algorithm: 'sha1' }
    })
    const headers = { 'x-hub-signature': `sha1=${hmac(body, 'hex', 'sha1')}` }
    expect(verifyWebhook(spec, { headers, rawBody: body, secret: SECRET })).toBe(true)
    const sha256 = { 'x-hub-signature': `sha1=${hmac(body, 'hex')}` }
    expect(verifyWebhook(spec, { headers: sha256, rawBody: body, secret: SECRET })).toBe(false)
  })

  it('stripe: t and v1, within tolerance', () => {
    const spec = specWith({ ...base, signature: { scheme: 'stripe' } })
    const t = now()
    const header = (time: number) => `t=${time},v1=bad,v1=${hmac(`${time}.${body}`, 'hex')}`
    expect(verifyWebhook(spec, { headers: { 'stripe-signature': header(t) }, rawBody: body, secret: SECRET })).toBe(true)
    expect(verifyWebhook(spec, { headers: { 'stripe-signature': header(t - 3600) }, rawBody: body, secret: SECRET })).toBe(
      false
    )
  })

  it('paddle: ts and h1', () => {
    const spec = specWith({ ...base, signature: { scheme: 'paddle' } })
    const ts = now()
    const headers = { 'paddle-signature': `ts=${ts};h1=${hmac(`${ts}:${body}`, 'hex')}` }
    expect(verifyWebhook(spec, { headers, rawBody: body, secret: SECRET })).toBe(true)
    expect(verifyWebhook(spec, { headers, rawBody: body, secret: 'other' })).toBe(false)
  })

  it('hubspotV3: method + decoded URL + body + timestamp, base64', () => {
    const spec = specWith({ ...base, signature: { scheme: 'hubspotV3' } })
    const ts = String(Date.now())
    const url = 'https://hooks.example.com/w/abc?x=a%20b'
    const sig = hmac(`POST${decodeURIComponent(url)}${body}${ts}`, 'base64')
    const headers = { 'x-hubspot-signature-v3': sig, 'x-hubspot-request-timestamp': ts }
    expect(verifyWebhook(spec, { headers, rawBody: body, secret: SECRET, url, method: 'POST' })).toBe(true)
    expect(verifyWebhook(spec, { headers, rawBody: body, secret: SECRET })).toBe(false)
    const stale = { ...headers, 'x-hubspot-request-timestamp': String(Date.now() - 3_600_000) }
    expect(verifyWebhook(spec, { headers: stale, rawBody: body, secret: SECRET, url })).toBe(false)
  })

  it('sharedSecret: verbatim, Bearer or HTTP basic', () => {
    const spec = specWith({ ...base, signature: { scheme: 'sharedSecret', header: 'Authorization' } })
    const verify = (value: string, secret: string) =>
      verifyWebhook(spec, { headers: { authorization: value }, rawBody: body, secret })
    expect(verify('s3cret', 's3cret')).toBe(true)
    expect(verify('Bearer s3cret', 's3cret')).toBe(true)
    expect(verify(`Basic ${Buffer.from('user:pass').toString('base64')}`, 'user:pass')).toBe(true)
    expect(verify(`Basic ${Buffer.from('user:nope').toString('base64')}`, 'user:pass')).toBe(false)
    expect(verify('wrong', 's3cret')).toBe(false)
  })
})

describe('parseWebhook', () => {
  it('upserts the payload object as a mapped record', () => {
    const spec = specWith({ ...base, signature: { scheme: 'none' } })
    expect(parseWebhook(spec, JSON.parse(body))).toEqual([
      {
        id: 'evt_1',
        type: 'thing.updated',
        stream: 'things',
        action: 'upsert',
        externalId: 't1',
        record: { externalId: 't1', properties: { name: 'A', external_id: 't1' }, links: [] }
      }
    ])
  })

  it('routes exact types first, then the most specific pattern, and drops unrouted types', () => {
    const spec = specWith({
      ...base,
      signature: { scheme: 'none' },
      routes: {
        'thing.*': { stream: 'things', action: 'upsert' },
        'thing.part.*': { stream: 'parts', action: 'upsert' },
        'thing.deleted': { stream: 'things', action: 'delete' }
      }
    })
    const event = (type: string) => ({ id: type, type, data: { object: { id: 'o1' } } })
    const [updated, part, deleted, other] = [
      'thing.updated',
      'thing.part.created',
      'thing.deleted',
      'other.updated'
    ].map((type) => parseWebhook(spec, event(type)))
    expect(updated[0]).toMatchObject({ stream: 'things', action: 'upsert' })
    expect(part[0]).toMatchObject({ stream: 'parts', action: 'upsert' })
    expect(deleted[0]).toEqual({ id: 'thing.deleted', type: 'thing.deleted', stream: 'things', action: 'delete', externalId: 'o1' })
    expect(other).toEqual([])
  })

  it('reads many events per delivery and refetches by object id', () => {
    const spec = specWith({
      signature: { scheme: 'none' },
      events: '$[*]',
      type: '$.subscriptionType',
      id: '$.eventId',
      objectId: '$.objectId',
      routes: { 'thing.*': { stream: 'things', action: 'refetch' } }
    })
    const events = parseWebhook(spec, [
      { eventId: 1, subscriptionType: 'thing.propertyChange', objectId: 42 },
      { eventId: 2, subscriptionType: 'thing.creation', objectId: 43 },
      { subscriptionType: 'thing.creation' }
    ])
    expect(events).toEqual([
      { id: '1', type: 'thing.propertyChange', stream: 'things', action: 'refetch', externalId: '42' },
      { id: '2', type: 'thing.creation', stream: 'things', action: 'refetch', externalId: '43' }
    ])
  })

  it('joins a type suffix and falls back to refetch when an upsert has no object', () => {
    const spec = specWith({
      signature: { scheme: 'none' },
      type: '$.meta.entity',
      typeSuffix: '$.meta.action',
      id: '$.meta.id',
      object: '$.data',
      objectId: '$.meta.entity_id',
      routes: { 'thing.delete': { stream: 'things', action: 'delete' }, 'thing.*': { stream: 'things' } }
    })
    expect(parseWebhook(spec, { meta: { entity: 'thing', action: 'delete', id: 'e1', entity_id: '7' }, data: null })).toEqual([
      { id: 'e1', type: 'thing.delete', stream: 'things', action: 'delete', externalId: '7' }
    ])
    expect(parseWebhook(spec, { meta: { entity: 'thing', action: 'change', id: 'e2', entity_id: '8' } })[0]).toMatchObject({
      action: 'refetch',
      externalId: '8'
    })
  })
})
