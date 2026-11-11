import { describe, expect, it, vi } from 'vitest'

import {
  ConnectorHttpError,
  ConnectorRuntime,
  EgressError,
  assertEgressAllowed,
  authorizeUrl,
  createPkcePair,
  defineConnector,
  exchangeCode,
  isBlockedAddress,
  needsRefresh,
  type ConnectionContext,
  type ConnectorSpec
} from '../src'
import { createMockFetch, noSleep } from '../src/testing'
import { bearer, mockRuntime } from './helpers'

const spec: ConnectorSpec = {
  id: 'example',
  name: 'Example',
  category: 'custom',
  description: 'Test connector',
  auth: [
    {
      type: 'oauth2',
      authorizeUrl: 'https://{{config.host}}/authorize',
      tokenUrl: 'https://auth.example.com/token',
      scopes: ['read', 'profile'],
      keepTokenFields: ['instance_url']
    },
    { type: 'apiKey', in: 'query', name: 'api_key' },
    { type: 'basic', baseUrl: 'https://basic.example.com' }
  ],
  baseUrl: 'https://api.example.com',
  rateLimit: { maxRetries: 2 },
  test: { request: { path: '/me' }, account: '$.name' },
  streams: { items: { label: 'ITEM', request: { path: '/items' }, records: '$', id: '$.id' } }
}
const def = defineConnector({ spec })

describe('http client', () => {
  it('retries a 429 after Retry-After', async () => {
    let calls = 0
    const sleep = vi.fn(async (_ms: number) => undefined)
    const { runtime } = mockRuntime(
      [
        {
          path: '/me',
          respond: () => (++calls === 1 ? { status: 429, headers: { 'retry-after': '2' } } : { body: { name: 'Acme' } })
        }
      ],
      { sleep }
    )
    expect(await runtime.test(def, bearer())).toEqual({ account: 'Acme' })
    expect(calls).toBe(2)
    const waited = sleep.mock.calls.map(([ms]) => ms)
    expect(waited.some((ms) => ms >= 2000 && ms < 2300)).toBe(true)
  })

  it('gives up after maxRetries and reports the status', async () => {
    const { runtime } = mockRuntime([{ path: '/me', status: 503, body: { error: 'down' } }])
    const error = await runtime.test(def, bearer()).catch((caught) => caught)
    expect(error).toBeInstanceOf(ConnectorHttpError)
    expect(error.status).toBe(503)
    expect(error.isAuthError).toBe(false)
  })

  it('refreshes the token once on a 401 and hands the new credentials back', async () => {
    const onCredentials = vi.fn()
    const fetch = createMockFetch([
      {
        method: 'POST',
        path: '/token',
        body: { access_token: 'new-token', expires_in: 3600, instance_url: 'https://x.example.com' }
      },
      {
        path: '/me',
        respond: ({ headers }) =>
          headers.authorization === 'Bearer new-token' ? { body: { name: 'Acme' } } : { status: 401, body: {} }
      }
    ])
    const connection: ConnectionContext = {
      config: {},
      credentials: { type: 'oauth2', accessToken: 'old-token', refreshToken: 'refresh-1' },
      oauthClient: { clientId: 'id', clientSecret: 'secret' },
      onCredentials
    }
    const runtime = new ConnectorRuntime({ fetch, sleep: noSleep, egress: () => 'any' })
    expect(await runtime.test(def, connection)).toEqual({ account: 'Acme' })
    expect(onCredentials).toHaveBeenCalledTimes(1)
    const refreshed = onCredentials.mock.calls[0][0]
    expect(refreshed).toMatchObject({
      type: 'oauth2',
      accessToken: 'new-token',
      refreshToken: 'refresh-1',
      extra: { instance_url: 'https://x.example.com' }
    })
    const tokenCall = fetch.calls.find((call) => call.url.endsWith('/token'))!
    expect(tokenCall.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'id' })
  })

  it('refreshes before expiry and stops on a second 401', async () => {
    expect(
      needsRefresh({ type: 'oauth2', accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    ).toBe(true)
    expect(needsRefresh({ type: 'oauth2', accessToken: 'a', expiresAt: new Date(0).toISOString() })).toBe(false)
    const { runtime } = mockRuntime([{ path: '/me', status: 401, body: { error: 'nope' } }])
    const error = await runtime.test(def, bearer()).catch((caught) => caught)
    expect(error.isAuthError).toBe(true)
  })

  it('puts API keys in the query and uses the auth method’s own base URL', async () => {
    const { fetch, runtime } = mockRuntime([{ path: '/me', body: { name: 'A' } }])
    await runtime.test(def, { config: {}, credentials: { type: 'apiKey', apiKey: 'k1' } })
    expect(new URL(fetch.calls[0].url).searchParams.get('api_key')).toBe('k1')
    await runtime.test(def, { config: {}, credentials: { type: 'basic', username: 'u', password: 'p' } })
    expect(fetch.calls[1].url).toBe('https://basic.example.com/me')
    expect(fetch.calls[1].headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
  })

  it('caps the response size', async () => {
    const fetch = createMockFetch([{ path: '/me', body: { name: 'x'.repeat(2000) } }])
    const runtime = new ConnectorRuntime({ fetch, egress: () => 'any', maxResponseBytes: 100 })
    await expect(runtime.test(def, bearer())).rejects.toThrow(/larger than 100 bytes/)
  })
})

describe('oauth', () => {
  it('builds the authorize URL with templated host, scopes and PKCE', () => {
    const { verifier, challenge } = createPkcePair()
    expect(verifier).not.toBe(challenge)
    const url = new URL(
      authorizeUrl(new ConnectorRuntime().spec(def), {
        clientId: 'cid',
        redirectUri: 'https://app.example.com/cb',
        state: 's1',
        codeChallenge: challenge,
        config: { host: 'login.example.com' }
      })
    )
    expect(url.origin).toBe('https://login.example.com')
    expect(url.searchParams.get('scope')).toBe('read profile')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('exchanges a code and keeps token fields', async () => {
    const fetch = createMockFetch([
      { method: 'POST', path: '/token', body: { access_token: 'a', refresh_token: 'r', instance_url: 'https://i.example.com' } }
    ])
    const credentials = await exchangeCode(new ConnectorRuntime().spec(def), {
      client: { clientId: 'id', clientSecret: 'secret' },
      code: 'c',
      redirectUri: 'https://app.example.com/cb',
      codeVerifier: 'v',
      fetch
    })
    expect(credentials).toEqual({
      type: 'oauth2',
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: undefined,
      extra: { instance_url: 'https://i.example.com' }
    })
    expect(fetch.calls[0].body).toMatchObject({ code_verifier: 'v', grant_type: 'authorization_code' })
  })
})

describe('egress', () => {
  it('blocks private, loopback, link-local and mapped addresses', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1']) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
    expect(isBlockedAddress('8.8.8.8')).toBe(false)
    expect(isBlockedAddress('2606:4700::1111')).toBe(false)
  })

  it('allows only public HTTPS hosts under public-only', async () => {
    await expect(assertEgressAllowed('http://8.8.8.8/', 'public-only')).rejects.toThrow(EgressError)
    await expect(assertEgressAllowed('https://localhost/', 'public-only')).rejects.toThrow(/not allowed/)
    await expect(assertEgressAllowed('https://metadata.internal/', 'public-only')).rejects.toThrow(/not allowed/)
    await expect(assertEgressAllowed('https://169.254.169.254/latest', 'public-only')).rejects.toThrow(/private/)
    await expect(assertEgressAllowed('https://[::ffff:127.0.0.1]/', 'public-only')).rejects.toThrow(/private/)
    await expect(assertEgressAllowed('https://8.8.8.8/', 'public-only')).resolves.toBeUndefined()
    await expect(assertEgressAllowed('http://127.0.0.1/', 'any')).resolves.toBeUndefined()
  })

  it('applies to every connector by default, built-in hooks included', async () => {
    const fetch = createMockFetch([{ path: '/me', body: {} }])
    const runtime = new ConnectorRuntime({ fetch })
    const hooked = defineConnector({ spec: { ...spec, baseUrl: 'https://{{config.host}}' }, hooks: {} })
    await expect(runtime.test(hooked, bearer({ host: '169.254.169.254' }))).rejects.toThrow(EgressError)
    expect(fetch.calls).toHaveLength(0)
  })
})
