import { describe, expect, it } from 'vitest'

import { pushTemplates } from '../src/push-templates'

describe('push templates', () => {
  it('covers Zapier, Make and n8n with unique ids', () => {
    const ids = pushTemplates.map((template) => template.id)
    expect(ids).toEqual(['zapier', 'make', 'n8n'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(pushTemplates.map((template) => [template.id, template] as const))('%s has steps, the push URL and a sample', (_id, template) => {
    expect(template.name).toBeTruthy()
    expect(template.description).toBeTruthy()
    expect(template.steps.length).toBeGreaterThan(0)
    expect(template.steps.every((step) => step.trim().length > 0)).toBe(true)
    expect(template.steps.some((step) => step.includes('{{pushUrl}}'))).toBe(true)
    expect(Object.keys(template.samplePayload).length).toBeGreaterThan(0)
    if (template.docsUrl) {
      expect(new URL(template.docsUrl).protocol).toBe('https:')
    }
  })
})
