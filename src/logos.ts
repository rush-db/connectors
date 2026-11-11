/*
 * Brand logos for the built-in connectors, push templates and the agent's
 * databases: `logos/<id>.svg`, embedded into `logos.generated.ts` by
 * `pnpm logos`. Logos are trademarks of their owners (see logos/SOURCES.md),
 * shown only to identify the service a connector talks to.
 */
import { LOGOS } from './logos.generated'

/** At most this many bytes per logo; they render at icon size. */
export const MAX_LOGO_BYTES = 30 * 1024

/** Why an SVG is not safe or fit to embed as a logo; empty when it is. */
export function svgProblems(svg: string): string[] {
  const problems: string[] = []
  if (Buffer.byteLength(svg) > MAX_LOGO_BYTES) {
    problems.push(`larger than ${MAX_LOGO_BYTES} bytes`)
  }
  if (!/^<svg[\s>]/.test(svg.trim())) {
    problems.push('does not start with <svg>')
  }
  if (!/<svg[^>]*\sviewBox=/.test(svg)) {
    problems.push('has no viewBox')
  }
  const forbidden: Array<[RegExp, string]> = [
    [/<script/i, '<script>'],
    [/<foreignObject/i, '<foreignObject>'],
    [/<image[\s>]/i, '<image>'],
    [/\son[a-z]+\s*=/i, 'an event handler attribute'],
    [/(?:xlink:)?href\s*=\s*["'](?!#)/i, 'a non-local href'],
    [/url\(\s*["']?(?!#)/i, 'a non-local url()'],
    [/@import/i, '@import'],
    [/<!ENTITY|<!DOCTYPE/i, 'a DTD or entity'],
    [/javascript:/i, 'a javascript: URL']
  ]
  for (const [pattern, what] of forbidden) {
    if (pattern.test(svg)) {
      problems.push(`contains ${what}`)
    }
  }
  return problems
}

/** The SVG markup of a logo by id (connector, push template or database), if there is one. */
export function connectorLogo(id: string): string | undefined {
  return LOGOS[id]
}

/** A logo as a `data:` URI, for an `<img src>` (which never runs anything inside the SVG). */
export function connectorLogoDataUri(id: string): string | undefined {
  const svg = LOGOS[id]
  return svg ? `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` : undefined
}

/** Ids that have a logo. */
export function logoIds(): string[] {
  return Object.keys(LOGOS).sort()
}
