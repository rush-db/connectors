import type { StreamSpec } from '../spec'
import { defineConnector } from '../types'

/*
 * PostHog private REST API (https://posthog.com/docs/api), authenticated with
 * a personal API key. Private endpoints live on `us.posthog.com` (US Cloud),
 * `eu.posthog.com` (EU Cloud) or the instance's own domain when self-hosted;
 * the `*.i.posthog.com` hosts serve only the public capture and flags
 * endpoints.
 *
 * Every list endpoint pages with a `next` URL (limit/offset). Persons, cohorts
 * and feature flags have no modification filter, so they are read in full on
 * every run; insights filter on `last_modified_at` (`date_from`).
 *
 * Events: PostHog marks `GET /events/` as kept for backwards compatibility and
 * points bulk reads at batch exports, and its docs say third-party connectors
 * must not page through `/query`. The stream is therefore optional and
 * incremental only: without a stored cursor the endpoint returns the last 24
 * hours (its default `after`), and later runs read from the cursor onwards.
 * For full history, set up a PostHog batch export instead.
 */

const page = (path: string, query: Record<string, string | number | boolean> = {}): StreamSpec['request'] => ({
  path: `/api/projects/{{config.projectId}}${path}`,
  query: { limit: 100, ...query }
})

const nextUrl = { type: 'nextUrl', next: '$.next' } as const

export const posthog = defineConnector({
  spec: {
    id: 'posthog',
    name: 'PostHog',
    category: 'analytics',
    description: 'Persons, cohorts, feature flags, insights, dashboards and (optionally) recent events from a PostHog project.',
    docsUrl: 'https://posthog.com/docs/api',
    auth: [
      {
        type: 'bearer',
        label: 'Personal API key',
        help: 'Settings → User → Personal API keys → Create key, scoped to this project with read-only scopes: person:read, cohort:read, feature_flag:read, insight:read, dashboard:read and query:read (events). Starts with phx_.'
      }
    ],
    config: {
      host: {
        label: 'PostHog host',
        default: 'us.posthog.com',
        placeholder: 'us.posthog.com',
        help: 'us.posthog.com for US Cloud, eu.posthog.com for EU Cloud, or the domain of your self-hosted instance (no https://).'
      },
      projectId: {
        label: 'Project ID',
        placeholder: '12345',
        help: 'The number in your project URL (…/project/12345) or under Settings → Project → Project ID.'
      }
    },
    baseUrl: 'https://{{config.host}}',
    // Analytics endpoints (persons) allow 240 requests a minute and 1,200 an hour per key; 429s wait for Retry-After.
    rateLimit: { requestsPerSecond: 3 },
    test: { request: page('/feature_flags/', { limit: 1 }) },
    streams: {
      persons: {
        label: 'POSTHOG_PERSON',
        description: 'Persons (identified and anonymous users) with their properties and distinct ids.',
        request: page('/persons/'),
        records: '$.results',
        id: '$.uuid',
        pagination: nextUrl,
        fields: {
          // Person properties stay under `properties_*`; deeper values become JSON.
          rename: { id: 'person_id' },
          types: { created_at: 'datetime', last_seen_at: 'datetime' },
          omit: ['matched_fields']
        }
      },
      cohorts: {
        label: 'POSTHOG_COHORT',
        description: 'Cohorts (static and dynamic) with their size.',
        request: page('/cohorts/', { basic: true }),
        records: '$.results',
        id: '$.id',
        pagination: nextUrl,
        fields: {
          types: { created_at: 'datetime', last_calculation: 'datetime' },
          omit: ['query', 'experiment_set', 'search_match_type']
        },
        deleted: { path: '$.deleted', value: true }
      },
      feature_flags: {
        label: 'POSTHOG_FEATURE_FLAG',
        description: 'Feature flags with their rollout filters.',
        request: page('/feature_flags/'),
        records: '$.results',
        id: '$.id',
        pagination: nextUrl,
        fields: {
          types: { created_at: 'datetime', updated_at: 'datetime' },
          omit: ['analytics_dashboards', 'surveys', 'features', 'experiment_set', 'user_access_level']
        },
        deleted: { path: '$.deleted', value: true }
      },
      insights: {
        label: 'POSTHOG_INSIGHT',
        description: 'Saved insights (metadata and query, not computed results).',
        // `basic=true` returns metadata only, so listing does not compute every insight.
        request: page('/insights/', { basic: true }),
        records: '$.results',
        id: '$.id',
        pagination: nextUrl,
        incremental: {
          cursorField: '$.last_modified_at',
          // `date_from` filters `last_modified_at >` an absolute date; day precision, so look back a day.
          request: { query: { date_from: '{{cursor|date}}' } },
          lookbackSeconds: 86_400
        },
        fields: {
          types: { created_at: 'datetime', last_modified_at: 'datetime', last_refresh: 'datetime' },
          omit: ['result', 'columns', 'hogql', 'types', 'dashboard_tiles', 'user_access_level']
        },
        relations: [{ type: 'ON_DASHBOARD', target: 'dashboards', path: '$.dashboards[*]', direction: 'out' }],
        deleted: { path: '$.deleted', value: true },
        optional: true
      },
      dashboards: {
        label: 'POSTHOG_DASHBOARD',
        description: 'Dashboards.',
        request: page('/dashboards/'),
        records: '$.results',
        id: '$.id',
        pagination: nextUrl,
        fields: {
          types: { created_at: 'datetime', last_accessed_at: 'datetime', last_viewed_at: 'datetime' },
          omit: ['user_access_level', 'search_match_type']
        },
        deleted: { path: '$.deleted', value: true },
        optional: true
      },
      events: {
        label: 'POSTHOG_EVENT',
        description: 'Raw events since the last run (the first run reads the last 24 hours). High volume.',
        request: page('/events/', { limit: 1000 }),
        records: '$.results',
        id: '$.id',
        pagination: nextUrl,
        incremental: {
          cursorField: '$.timestamp',
          request: { query: { after: '{{cursor|iso}}' } },
          // Ingestion can land events a few minutes late.
          lookbackSeconds: 600
        },
        fields: {
          types: { timestamp: 'datetime' },
          omit: ['elements', 'elements_chain', 'person']
        },
        optional: true
      }
    }
  }
})
