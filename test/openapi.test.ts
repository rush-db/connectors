import { describe, expect, it } from 'vitest'

import { connectorFromOpenApi, listOpenApiOperations, parseConnectorSpec } from '../src'

const doc = {
  openapi: '3.0.0',
  info: { title: 'Acme API', description: 'Acme' },
  servers: [{ url: 'https://api.acme.example' }],
  components: {
    securitySchemes: { token: { type: 'http', scheme: 'bearer' } },
    schemas: {
      Customer: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
      CustomerList: {
        type: 'object',
        properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Customer' } }, has_more: { type: 'boolean' } }
      }
    }
  },
  paths: {
    '/v1/customers': {
      get: {
        operationId: 'listCustomers',
        summary: 'List customers',
        parameters: [{ name: 'starting_after', in: 'query' }, { name: 'limit', in: 'query' }],
        responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomerList' } } } } }
      }
    },
    '/v1/orders': {
      get: {
        parameters: [{ name: 'page', in: 'query' }, { name: 'per_page', in: 'query' }],
        responses: {
          '200': { content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { uuid: { type: 'string' } } } } } } }
        }
      }
    },
    '/v1/customers/{id}': { get: { responses: {} } }
  }
}

describe('openapi draft', () => {
  it('guesses records, ids and pagination per operation', () => {
    const operations = listOpenApiOperations(doc)
    expect(operations).toHaveLength(3)
    expect(operations[0]).toMatchObject({ records: '$.data', id: '$.id', pagination: { type: 'lastId', param: 'starting_after' } })
    expect(operations[1]).toMatchObject({ records: '$', id: '$.uuid', pagination: { type: 'page', sizeParam: 'per_page' } })
  })

  it('drafts a valid spec without parameterised paths', () => {
    const spec = connectorFromOpenApi(doc, { id: 'acme' })
    expect(Object.keys(spec.streams)).toEqual(['customer', 'order'])
    expect(spec.streams.customer.label).toBe('CUSTOMER')
    expect(spec.baseUrl).toBe('https://api.acme.example')
    expect(spec.auth[0].type).toBe('bearer')
    expect(() => parseConnectorSpec(spec)).not.toThrow()
  })
})
