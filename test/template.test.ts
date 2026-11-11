import { describe, expect, it } from 'vitest'

import { renderTemplate } from '../src'
import { MISSING, renderRequired, renderString } from '../src/runtime/template'

const scope = {
  config: { subdomain: 'acme', limit: 50, name: 'a b&c' },
  cursor: '2024-03-01T12:30:45.123Z',
  credentials: { instance_url: 'https://acme.my.salesforce.com' }
}

describe('template', () => {
  it('keeps the type of a whole placeholder and interpolates inside strings', () => {
    expect(renderString('{{config.limit}}', scope)).toBe(50)
    expect(renderString('https://{{config.subdomain}}.zendesk.com', scope)).toBe('https://acme.zendesk.com')
    expect(renderString('{{ credentials.instance_url }}', scope)).toBe('https://acme.my.salesforce.com')
  })

  it('applies filters', () => {
    expect(renderString('{{cursor|unix}}', scope)).toBe(1709296245)
    expect(renderString('{{cursor|unixMs}}', scope)).toBe(1709296245123)
    expect(renderString('{{cursor|iso}}', scope)).toBe('2024-03-01T12:30:45.123Z')
    expect(renderString('{{cursor|date}}', scope)).toBe('2024-03-01')
    expect(renderString('{{cursor|sqlDatetime}}', scope)).toBe('2024-03-01 12:30:45')
    expect(renderString('{{config.name|urlencode}}', scope)).toBe('a%20b%26c')
    expect(renderString('{{config|json}}', { config: { a: 1 } })).toBe('{"a":1}')
    expect(renderString('{{cursor|iso}}', { cursor: 1709296245 })).toBe('2024-03-01T12:30:45.000Z')
    expect(() => renderString('{{cursor|nope}}', scope)).toThrow(/Unknown template filter/)
  })

  it('reads a date-time without a zone as UTC', () => {
    expect(renderString('{{cursor|iso}}', { cursor: '2024-01-01 12:00:00' })).toBe('2024-01-01T12:00:00.000Z')
    expect(renderString('{{cursor|iso}}', { cursor: '2024-01-01T00:00:00.000+0000' })).toBe('2024-01-01T00:00:00.000Z')
  })

  it('drops fields whose placeholders resolve to nothing', () => {
    expect(renderString('{{cursor}}', {})).toBe(MISSING)
    expect(renderString('updated>{{cursor}}', {})).toBe(MISSING)
    expect(
      renderTemplate({ start_time: '{{cursor|unix}}', limit: 10, list: ['{{missing}}', 'x'], nested: { a: '{{nope}}' } }, {})
    ).toEqual({ limit: 10, list: ['x'], nested: {} })
  })

  it('requires values in URLs', () => {
    expect(() => renderRequired('https://{{config.subdomain}}.x.com', { config: {} }, 'baseUrl')).toThrow(
      /baseUrl needs a value/
    )
  })
})
