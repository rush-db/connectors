/**
 * Test kit for connector authors: a fetch that answers from recorded
 * fixtures, so a connector's backfill, incremental and webhook paths run in
 * CI without credentials.
 */

export type MockRoute = {
  method?: string
  /** Path (without query) or a RegExp over `origin + path`. */
  path: string | RegExp
  /** Match only when every one of these query params has this value. */
  query?: Record<string, string>
  status?: number
  headers?: Record<string, string>
  body?: unknown
  /** Compute the response from the request. */
  respond?: (request: {
    url: URL
    method: string
    headers: Record<string, string>
    body: unknown
  }) => { status?: number; headers?: Record<string, string>; body?: unknown }
}

export type MockFetch = typeof fetch & {
  calls: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }>
}

export function createMockFetch(routes: MockRoute[]): MockFetch {
  const calls: MockFetch['calls'] = []
  const mock = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    let body: unknown = init?.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        // Form bodies stay strings.
      }
    } else if (body instanceof URLSearchParams) {
      body = Object.fromEntries(body.entries())
    }
    calls.push({ method, url: url.toString(), headers, body })
    const route = routes.find((candidate) => {
      if ((candidate.method ?? 'GET').toUpperCase() !== method) {
        return false
      }
      const pathMatches =
        typeof candidate.path === 'string' ?
          candidate.path === url.pathname
        : candidate.path.test(url.origin + url.pathname)
      if (!pathMatches) {
        return false
      }
      return Object.entries(candidate.query ?? {}).every(([key, value]) => url.searchParams.get(key) === value)
    })
    if (!route) {
      return new Response(JSON.stringify({ error: `No mock for ${method} ${url.pathname}${url.search}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      })
    }
    const answer = route.respond ? route.respond({ url, method, headers, body }) : route
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json', ...(answer.headers ?? {}) }
    })
  }) as MockFetch
  mock.calls = calls
  return mock
}

/** No waiting in tests: retries and rate limits resolve at once. */
export const noSleep = async () => undefined
