/*
 * Push templates: how a no-code automation tool sends records into a RushDB
 * webhook (push) connection. Nothing here runs; a platform shows the steps
 * next to the connection's push URL.
 *
 * The push URL carries its own secret token, so no other auth is needed. Its
 * body is one record (a JSON object), an array of records, or
 * `{ "records": [...] }`, at most 1,000 records per request. An
 * `Idempotency-Key` header makes a retried delivery count once.
 */

import { connectorLogoDataUri } from './logos'

export type PushTemplate = {
  id: string
  name: string
  description: string
  docsUrl?: string
  /** Steps a person follows in the tool, in order. `{{pushUrl}}` stands for the connection's push URL. */
  steps: string[]
  /** A body the tool can send as is. */
  samplePayload: Record<string, unknown>
  /** The tool's logo as a `data:image/svg+xml` URI. */
  logo?: string
}

const samplePayload = {
  records: [
    {
      id: 'lead-1001',
      email: 'ada@example.com',
      company: 'Example Inc.',
      source: 'webinar',
      created_at: '2026-01-15T10:30:00Z'
    }
  ]
}

const templates: Array<Omit<PushTemplate, 'logo'>> = [
  {
    id: 'zapier',
    name: 'Zapier',
    description: 'Send each Zap trigger (a new form entry, a new row, a closed deal) to RushDB as a record.',
    docsUrl: 'https://help.zapier.com/hc/en-us/articles/8496326446989',
    steps: [
      'In your Zap, after the trigger, add an action step and choose “Webhooks by Zapier”.',
      'Pick the “POST” event and continue.',
      'Set URL to {{pushUrl}} and Payload Type to “JSON”.',
      'Under Data, add one row per property (for example id, email, company) and map each to a field from the trigger. Leave “Wrap Request In Array” off.',
      'Optional: under Headers, add Idempotency-Key mapped to the trigger record’s id, so a replayed Zap does not create a duplicate.',
      'Test the step; RushDB answers 202 with the number of accepted records. Then publish the Zap.'
    ],
    samplePayload: samplePayload.records[0]
  },
  {
    id: 'make',
    name: 'Make',
    description: 'Send bundles from a Make scenario to RushDB with the HTTP app.',
    docsUrl: 'https://apps.make.com/http',
    steps: [
      'In your scenario, add a module after the trigger and choose HTTP → “Make a request”.',
      'Set URL to {{pushUrl}} and Method to POST.',
      'Set Body content type to “application/json” (JSON, raw) and write the body; map scenario values into it, for example {"records":[{"id":"{{1.id}}","email":"{{1.email}}"}]}.',
      'Optional: add a header Idempotency-Key with a value unique to the bundle (its id).',
      'Use an Array aggregator before the HTTP module to send many bundles in one request (up to 1,000 records).',
      'Run once to check the 202 response, then schedule the scenario.'
    ],
    samplePayload
  },
  {
    id: 'n8n',
    name: 'n8n',
    description: 'Send items from an n8n workflow to RushDB with the HTTP Request node.',
    docsUrl: 'https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/',
    steps: [
      'Add an “HTTP Request” node after the node that produces your items.',
      'Set Method to POST and URL to {{pushUrl}}. Leave Authentication as “None”: the token is part of the URL.',
      'Turn on “Send Body”, set Body Content Type to JSON and Specify Body to “Using JSON”.',
      'Write the body with expressions, for example {"records":[{"id":"{{ $json.id }}","email":"{{ $json.email }}"}]}. The node sends one request per item; aggregate items first to send up to 1,000 records at once.',
      'Optional: turn on “Send Headers” and add Idempotency-Key = {{ $json.id }}.',
      'Execute the node to check the 202 response, then activate the workflow.'
    ],
    samplePayload
  }
]

export const pushTemplates: PushTemplate[] = templates.map((template) => ({
  ...template,
  logo: connectorLogoDataUri(template.id)
}))
