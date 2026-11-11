import { describe, expect, it } from 'vitest'

import { builtinConnectors, catalog, getConnector, parseConnectorSpec } from '../src'

describe('catalog', () => {
  it('lists every built-in connector in order', () => {
    expect(builtinConnectors.map((definition) => definition.spec.id)).toEqual([
      'hubspot',
      'salesforce',
      'pipedrive',
      'salesloft',
      'stripe',
      'paddle',
      'lemonsqueezy',
      'quickbooks',
      'xero',
      'netsuite',
      'zendesk',
      'intercom',
      'servicenow',
      'planhat',
      'gong',
      'fireflies',
      'jira',
      'linear',
      'asana',
      'clickup',
      'monday',
      'trello',
      'youtrack',
      'sentry',
      'notion',
      'confluence',
      'google-sheets',
      'airtable',
      'docusign',
      'loopio',
      'posthog',
      'brevo',
      'sensor-tower',
      'similarweb',
      'semrush',
      'trustpilot'
    ])
  })

  it.each(builtinConnectors.map((definition) => [definition.spec.id, definition] as const))(
    '%s parses and uses provider-prefixed labels',
    (_id, definition) => {
      const spec = parseConnectorSpec(definition.spec)
      for (const stream of Object.values(spec.streams)) {
        expect(stream.label).toMatch(/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/)
        for (const relation of stream.relations ?? []) {
          expect(relation.type).toMatch(/^[A-Z][A-Z0-9_]*$/)
        }
      }
      expect(spec.auth.length).toBeGreaterThan(0)
    }
  )

  it('describes connectors without credentials', () => {
    const entries = catalog()
    expect(entries).toHaveLength(36)
    const stripe = entries.find((entry) => entry.id === 'stripe')!
    expect(stripe.webhooks).toBe(true)
    expect(stripe.auth).toEqual(['bearer', 'oauth2'])
    expect(getConnector('salesforce')?.spec.name).toBe('Salesforce')
    expect(getConnector('nope')).toBeUndefined()
  })
})
