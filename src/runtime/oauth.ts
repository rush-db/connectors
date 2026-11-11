import { createHash, randomBytes } from 'node:crypto'

import { renderRequired } from './template'

import type { ParsedConnectorSpec } from '../spec'
import type { Credentials, OAuthClient } from '../types'

type OAuth2Auth = Extract<ParsedConnectorSpec['auth'][number], { type: 'oauth2' }>

export function oauth2Of(spec: ParsedConnectorSpec): OAuth2Auth | undefined {
  return spec.auth.find((auth): auth is OAuth2Auth => auth.type === 'oauth2')
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** The provider URL the browser goes to. `config` fills templated hosts (Zendesk subdomain). */
export function authorizeUrl(
  spec: ParsedConnectorSpec,
  params: {
    clientId: string
    redirectUri: string
    state: string
    codeChallenge?: string
    config?: Record<string, unknown>
  }
): string {
  const oauth = oauth2Of(spec)
  if (!oauth) {
    throw new Error(`${spec.id} has no OAuth 2.0 auth`)
  }
  const url = new URL(renderRequired(oauth.authorizeUrl, { config: params.config ?? {} }, 'authorizeUrl'))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('state', params.state)
  if (oauth.scopes.length) {
    url.searchParams.set('scope', oauth.scopes.join(oauth.scopeSeparator))
  }
  if (oauth.pkce && params.codeChallenge) {
    url.searchParams.set('code_challenge', params.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
  }
  for (const [key, value] of Object.entries(oauth.authorizeParams ?? {})) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

async function tokenRequest(
  spec: ParsedConnectorSpec,
  client: OAuthClient,
  form: Record<string, string>,
  config: Record<string, unknown>,
  fetchImpl: typeof fetch
): Promise<Record<string, any>> {
  const oauth = oauth2Of(spec)!
  const body = new URLSearchParams(form)
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json'
  }
  if (oauth.clientAuth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`
  } else {
    body.set('client_id', client.clientId)
    body.set('client_secret', client.clientSecret)
  }
  const response = await fetchImpl(renderRequired(oauth.tokenUrl, { config }, 'tokenUrl'), {
    method: 'POST',
    headers,
    body
  })
  const text = await response.text()
  let data: Record<string, any>
  try {
    data = JSON.parse(text)
  } catch {
    data = Object.fromEntries(new URLSearchParams(text))
  }
  if (!response.ok || data.error) {
    throw new Error(
      `OAuth token request failed (${response.status}): ${data.error_description ?? data.error ?? text.slice(0, 200)}`
    )
  }
  return data
}

function toCredentials(
  spec: ParsedConnectorSpec,
  data: Record<string, any>,
  previous?: Credentials,
  callbackParams: Record<string, unknown> = {}
): Credentials {
  const oauth = oauth2Of(spec)!
  const extra: Record<string, string> = previous?.type === 'oauth2' ? { ...(previous.extra ?? {}) } : {}
  for (const param of oauth.keepCallbackParams ?? []) {
    if (typeof callbackParams[param] === 'string' && callbackParams[param]) {
      extra[param] = callbackParams[param] as string
    }
  }
  for (const field of oauth.keepTokenFields ?? []) {
    if (data[field] !== undefined) {
      extra[field] = String(data[field])
    }
  }
  const expiresIn = Number(data.expires_in)
  return {
    type: 'oauth2',
    accessToken: String(data.access_token),
    refreshToken:
      data.refresh_token ?? (previous?.type === 'oauth2' ? previous.refreshToken : undefined) ?? undefined,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
    ...(Object.keys(extra).length ? { extra } : {})
  }
}

export async function exchangeCode(
  spec: ParsedConnectorSpec,
  params: {
    client: OAuthClient
    code: string
    redirectUri: string
    codeVerifier?: string
    config?: Record<string, unknown>
    /** The redirect's query string, for `keepCallbackParams`. */
    callbackParams?: Record<string, unknown>
    fetch?: typeof fetch
  }
): Promise<Credentials> {
  const data = await tokenRequest(
    spec,
    params.client,
    {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      ...(params.codeVerifier ? { code_verifier: params.codeVerifier } : {})
    },
    params.config ?? {},
    params.fetch ?? fetch
  )
  return toCredentials(spec, data, undefined, params.callbackParams)
}

export async function refreshCredentials(
  spec: ParsedConnectorSpec,
  credentials: Credentials,
  client: OAuthClient,
  config: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch
): Promise<Credentials> {
  if (credentials.type !== 'oauth2' || !credentials.refreshToken) {
    throw new Error('These credentials cannot be refreshed; authorize the connection again')
  }
  const data = await tokenRequest(
    spec,
    client,
    { grant_type: 'refresh_token', refresh_token: credentials.refreshToken },
    config,
    fetchImpl
  )
  return toCredentials(spec, data, credentials)
}

/** True when the access token expires within `skewSeconds`. */
export function needsRefresh(credentials: Credentials, skewSeconds = 120): boolean {
  if (credentials.type !== 'oauth2' || !credentials.expiresAt || !credentials.refreshToken) {
    return false
  }
  return new Date(credentials.expiresAt).getTime() - skewSeconds * 1000 <= Date.now()
}
