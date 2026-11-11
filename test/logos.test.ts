import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// @ts-expect-error plain ESM script without types
import { renderLogos } from '../scripts/build-logos.mjs'
import { catalog } from '../src/catalog'
import { builtinConnectors } from '../src/connectors'
import { connectorLogo, logoIds, svgProblems } from '../src/logos'
import { pushTemplates } from '../src/push-templates'

const DATABASES = ['postgres', 'mysql', 'mongodb', 'clickhouse']
const expected = [
  ...builtinConnectors.map((definition) => definition.spec.id),
  ...pushTemplates.map((template) => template.id),
  ...DATABASES
]

describe('logos', () => {
  it('src/logos.generated.ts matches logos/ (run `pnpm logos`)', () => {
    expect(readFileSync(join(__dirname, '..', 'src', 'logos.generated.ts'), 'utf8')).toBe(renderLogos())
  })

  it('has one for every connector, push template and agent database, and nothing else', () => {
    expect(expected.filter((id) => !connectorLogo(id))).toEqual([])
    expect(logoIds().filter((id) => !expected.includes(id))).toEqual([])
  })

  it('is static, local and small', () => {
    const problems = logoIds().flatMap((id) => svgProblems(connectorLogo(id)!).map((problem) => `${id}: ${problem}`))
    expect(problems).toEqual([])
  })

  it('reaches the catalog and push templates as data URIs', () => {
    expect(catalog().every((entry) => entry.logo?.startsWith('data:image/svg+xml;base64,'))).toBe(true)
    expect(pushTemplates.every((template) => template.logo?.startsWith('data:image/svg+xml;base64,'))).toBe(true)
  })

  it('refuses active or remote content', () => {
    const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${body}</svg>`
    expect(svgProblems(svg('<path d="M0 0h1v1z"/>'))).toEqual([])
    expect(svgProblems(svg('<use href="#a"/>'))).toEqual([])
    expect(svgProblems(svg('<script>alert(1)</script>'))).toContain('contains <script>')
    expect(svgProblems(svg('<path onload="x()"/>'))).toContain('contains an event handler attribute')
    expect(svgProblems(svg('<use href="https://example.com/a.svg#x"/>'))).toContain('contains a non-local href')
    expect(svgProblems(svg('<rect style="fill:url(https://t.example/p)"/>'))).toContain('contains a non-local url()')
    expect(svgProblems('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toContain('has no viewBox')
  })
})
