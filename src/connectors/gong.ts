import { ConnectorHttpError } from '../runtime/http'
import { toDate } from '../runtime/template'
import { defineConnector, type ConnectorHttp, type StreamState } from '../types'

/*
 * Gong API v2.
 *
 * Calls come from `POST /v2/calls/extensive` (metadata, parties, topics,
 * trackers and the brief), transcripts from `POST /v2/calls/transcript`; both
 * page with `records.cursor` in the body. Both filter by call start time
 * (`fromDateTime`), and a call shows up only once Gong has processed it, so an
 * incremental read is a window: from the previous run's start, less a two-day
 * lookback, to now. Edits to an older call (a renamed title, a new comment)
 * arrive with the next full read.
 *
 * The `read` hook runs both streams because Gong answers 404 when no call
 * matches the filter, which a spec would treat as a failure.
 *
 * OAuth tokens are bound to a per-customer API host, returned in the token
 * response as `api_base_url_for_customer`.
 */

const LOOKBACK_SECONDS = 2 * 24 * 60 * 60

const CALL_CONTENT = {
  context: 'Extended',
  exposedFields: {
    parties: true,
    content: { brief: true, keyPoints: true, callOutcome: true, topics: true, trackers: true },
    interaction: { speakers: true }
  }
}

/** Gong's 404 for a filter without matches: "No calls found corresponding to the provided filters". */
const noMatches = (error: unknown) =>
  error instanceof ConnectorHttpError && error.status === 404 && /not? .*found/i.test(JSON.stringify(error.body ?? ''))

async function* pages(http: ConnectorHttp, url: string, body: Record<string, unknown>, key: string) {
  let cursor: string | undefined
  for (;;) {
    let data: any
    try {
      data = (await http.request({ method: 'POST', url, body: cursor ? { ...body, cursor } : body })).data
    } catch (error) {
      if (noMatches(error)) {
        return
      }
      throw error
    }
    yield (data?.[key] ?? []) as unknown[]
    const next = data?.records?.cursor
    if (!next || next === cursor) {
      return
    }
    cursor = String(next)
  }
}

async function* windowRead(
  http: ConnectorHttp,
  url: string,
  body: Record<string, unknown>,
  key: string,
  state: StreamState
) {
  const startedAt = new Date().toISOString()
  const since = state.cursor === undefined ? undefined : toDate(state.cursor)
  const filter = since ? { fromDateTime: new Date(since.getTime() - LOOKBACK_SECONDS * 1000).toISOString() } : {}
  for await (const records of pages(http, url, { ...body, filter }, key)) {
    // The window's end becomes the cursor only once every page is written.
    yield { records, state: { cursor: state.cursor } }
  }
  yield { records: [], state: { cursor: startedAt } }
}

/** One record per transcript: the monologues joined into plain text, speaker by speaker. */
function transcriptText(record: any) {
  const monologues: any[] = Array.isArray(record?.transcript) ? record.transcript : []
  const text = monologues
    .map((monologue) => {
      const sentences = (monologue.sentences ?? []).map((sentence: any) => sentence.text).join(' ')
      return `${monologue.speakerId ?? 'unknown'}: ${sentences}`
    })
    .join('\n')
  return {
    callId: record.callId,
    text,
    speakerIds: [...new Set(monologues.map((monologue) => String(monologue.speakerId)))],
    topics: [...new Set(monologues.map((monologue) => monologue.topic).filter(Boolean))]
  }
}

export const gong = defineConnector({
  spec: {
    id: 'gong',
    name: 'Gong',
    category: 'sales',
    description: 'Calls with participants, topics and briefs, users and (optionally) call transcripts from Gong.',
    docsUrl: 'https://gong.app.gong.io/settings/api/documentation',
    auth: [
      {
        type: 'basic',
        usernameLabel: 'Access key',
        passwordLabel: 'Access key secret',
        help: 'Company Settings → Ecosystem → API → Create access key (technical administrator). Gong API keys are not scoped; the connector only reads.'
      },
      {
        type: 'oauth2',
        baseUrl: '{{credentials.api_base_url_for_customer}}',
        authorizeUrl: 'https://app.gong.io/oauth2/authorize',
        tokenUrl: 'https://app.gong.io/oauth2/generate-customer-token',
        scopes: ['api:calls:read:basic', 'api:calls:read:extensive', 'api:calls:read:transcript', 'api:users:read'],
        pkce: false,
        clientAuth: 'basic',
        keepTokenFields: ['api_base_url_for_customer']
      }
    ],
    baseUrl: 'https://api.gong.io',
    // 3 calls per second and 10,000 per day per company.
    rateLimit: { requestsPerSecond: 2 },
    test: { request: { path: '/v2/users' } },
    streams: {
      calls: {
        label: 'GONG_CALL',
        description: 'Recorded calls and meetings with participants, topics, trackers and the brief.',
        request: { method: 'POST', path: '/v2/calls/extensive', body: { filter: {}, contentSelector: CALL_CONTENT } },
        records: '$.calls',
        id: '$.metaData.id',
        pagination: { type: 'cursor', next: '$.records.cursor', param: 'cursor', in: 'body' },
        // Read by the hook: a window over the call start time.
        incremental: {
          cursorField: '$.metaData.started',
          request: { body: { filter: { fromDateTime: '{{cursor|iso}}' } } },
          lookbackSeconds: LOOKBACK_SECONDS
        },
        fields: {
          flatten: ['$.metaData'],
          // `parties` keeps names, emails and phone numbers of the participants.
          types: { started: 'datetime', scheduled: 'datetime', duration: 'number', parties: 'json' }
        },
        relations: [
          { type: 'HOSTED_BY', target: 'users', path: '$.metaData.primaryUserId', direction: 'out' },
          { type: 'ATTENDED_BY', target: 'users', path: '$.parties[*].userId', direction: 'out' }
        ]
      },
      users: {
        label: 'GONG_USER',
        description: 'Gong users.',
        request: { path: '/v2/users' },
        records: '$.users',
        id: '$.id',
        pagination: { type: 'cursor', next: '$.records.cursor', param: 'cursor' },
        fields: { omit: ['settings'], types: { created: 'datetime' } },
        relations: [{ type: 'REPORTS_TO', target: 'users', path: '$.managerId', direction: 'out' }]
      },
      transcripts: {
        label: 'GONG_TRANSCRIPT',
        description:
          'Full call transcripts as plain text. Personal data: everything said on the call. High volume; off by default.',
        request: { method: 'POST', path: '/v2/calls/transcript', body: { filter: {} } },
        records: '$.callTranscripts',
        id: '$.callId',
        pagination: { type: 'cursor', next: '$.records.cursor', param: 'cursor', in: 'body' },
        relations: [{ type: 'TRANSCRIPT_OF', target: 'calls', path: '$.callId', direction: 'out' }],
        optional: true
      }
    }
  },
  hooks: {
    read(stream, state, ctx) {
      if (stream.name === 'calls') {
        return windowRead(ctx.http, '/v2/calls/extensive', { contentSelector: CALL_CONTENT }, 'calls', state)
      }
      if (stream.name === 'transcripts') {
        return windowRead(ctx.http, '/v2/calls/transcript', {}, 'callTranscripts', state)
      }
      return undefined
    },
    transform(stream, record) {
      return stream === 'transcripts' ? transcriptText(record) : record
    }
  }
})
