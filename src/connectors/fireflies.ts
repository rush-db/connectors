import { defineConnector } from '../types'

/*
 * Fireflies.ai GraphQL API.
 *
 * Transcripts (meeting records with the AI summary and participants, not the
 * spoken sentences) page with `limit`/`skip` in the query variables, 50 at a
 * time. `fromDate` filters by meeting date: a meeting is listed once it has
 * been processed, so incremental reads re-read a day before the newest meeting
 * seen. A summary edited later on an older meeting arrives with the next full
 * read.
 */

const TRANSCRIPTS = `query Transcripts($limit: Int, $skip: Int, $fromDate: DateTime) {
  transcripts(limit: $limit, skip: $skip, fromDate: $fromDate) {
    id
    title
    date
    duration
    host_email
    organizer_email
    participants
    meeting_attendees { displayName email name }
    meeting_link
    transcript_url
    user { user_id }
    summary { keywords action_items overview short_summary topics_discussed meeting_type }
  }
}`

const USERS = `query Users {
  users { user_id email name is_admin num_transcripts minutes_consumed recent_meeting }
}`

export const fireflies = defineConnector({
  spec: {
    id: 'fireflies',
    name: 'Fireflies.ai',
    category: 'sales',
    description: 'Meeting transcripts with summaries, action items and participants, and team members from Fireflies.ai.',
    docsUrl: 'https://docs.fireflies.ai/graphql-api/query/transcripts',
    auth: [
      {
        type: 'bearer',
        label: 'API key',
        help: 'Fireflies → Settings → Developer Settings → copy the API key. Keys are not scoped; the connector only sends read queries. A team admin key sees the whole team’s meetings.'
      }
    ],
    errors: '$.errors',
    baseUrl: 'https://api.fireflies.ai',
    // Business plans allow 60 requests per minute.
    rateLimit: { requestsPerSecond: 1 },
    test: {
      request: { method: 'POST', path: '/graphql', body: { query: 'query { user { user_id email name } }' } },
      account: '$.data.user.email'
    },
    streams: {
      transcripts: {
        label: 'FIREFLIES_TRANSCRIPT',
        description: 'Meetings with summary, keywords, action items and participant emails (personal data).',
        request: {
          method: 'POST',
          path: '/graphql',
          body: { query: TRANSCRIPTS, variables: { fromDate: '{{cursor|iso}}' } }
        },
        records: '$.data.transcripts',
        id: '$.id',
        pagination: { type: 'offset', param: 'variables.skip', limitParam: 'variables.limit', limit: 50, in: 'body' },
        incremental: { cursorField: '$.date', format: 'iso', lookbackSeconds: 24 * 60 * 60 },
        fields: {
          omit: ['user'],
          types: { date: 'unixMs', duration: 'number', meeting_attendees: 'json' }
        },
        relations: [{ type: 'RECORDED_BY', target: 'users', path: '$.user.user_id', direction: 'out' }]
      },
      users: {
        label: 'FIREFLIES_USER',
        description: 'Members of the Fireflies team.',
        request: { method: 'POST', path: '/graphql', body: { query: USERS } },
        records: '$.data.users',
        id: '$.user_id'
      }
    }
  }
})
