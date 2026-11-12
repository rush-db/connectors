/**
 * A small JSONPath subset, enough for API responses: `$`, `.key`, `['key']`,
 * `["key"]`, `[0]`, `[*]` and `.*`. No filters, no recursion, no scripts:
 * specs written by people or models can never execute anything.
 */

type Segment = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'wildcard' }

const cache = new Map<string, Segment[]>()

export function parsePath(path: string): Segment[] {
  const cached = cache.get(path)
  if (cached) {
    return cached
  }
  if (!path.startsWith('$')) {
    throw new Error(`JSONPath must start with $: ${path}`)
  }
  const segments: Segment[] = []
  let i = 1
  while (i < path.length) {
    const char = path[i]
    if (char === '.') {
      i++
      if (path[i] === '*') {
        segments.push({ kind: 'wildcard' })
        i++
        continue
      }
      let key = ''
      while (i < path.length && path[i] !== '.' && path[i] !== '[') {
        key += path[i++]
      }
      if (!key) {
        throw new Error(`Empty key in JSONPath: ${path}`)
      }
      segments.push({ kind: 'key', key })
    } else if (char === '[') {
      const end = path.indexOf(']', i)
      if (end === -1) {
        throw new Error(`Unclosed [ in JSONPath: ${path}`)
      }
      const inner = path.slice(i + 1, end).trim()
      i = end + 1
      if (inner === '*') {
        segments.push({ kind: 'wildcard' })
      } else if (/^-?\d+$/.test(inner)) {
        segments.push({ kind: 'index', index: Number(inner) })
      } else if (/^(['"]).*\1$/.test(inner)) {
        segments.push({ kind: 'key', key: inner.slice(1, -1) })
      } else {
        throw new Error(`Unsupported JSONPath segment [${inner}] in ${path}`)
      }
    } else {
      throw new Error(`Unexpected "${char}" in JSONPath: ${path}`)
    }
  }
  cache.set(path, segments)
  return segments
}

/** Every value the path selects (wildcards fan out). */
export function queryAll(value: unknown, path: string): unknown[] {
  let current: unknown[] = [value]
  for (const segment of parsePath(path)) {
    const next: unknown[] = []
    for (const item of current) {
      if (item === null || item === undefined) {
        continue
      }
      if (segment.kind === 'key') {
        if (typeof item === 'object' && segment.key in (item as object)) {
          next.push((item as Record<string, unknown>)[segment.key])
        }
      } else if (segment.kind === 'index') {
        if (Array.isArray(item)) {
          const at = segment.index < 0 ? item.length + segment.index : segment.index
          if (at >= 0 && at < item.length) {
            next.push(item[at])
          }
        }
      } else if (Array.isArray(item)) {
        next.push(...item)
      } else if (typeof item === 'object') {
        next.push(...Object.values(item as object))
      }
    }
    current = next
  }
  return current
}

/** The first value the path selects, or undefined. */
export function queryOne<T = unknown>(value: unknown, path: string): T | undefined {
  const segments = parsePath(path)
  if (!segments.some((segment) => segment.kind === 'wildcard')) {
    let current: any = value
    for (const segment of segments) {
      if (current === null || current === undefined) {
        return undefined
      }
      if (segment.kind === 'key') {
        current = typeof current === 'object' ? current[segment.key] : undefined
      } else if (segment.kind === 'index') {
        current =
          Array.isArray(current) ?
            current[segment.index < 0 ? current.length + segment.index : segment.index]
          : undefined
      }
    }
    return current as T | undefined
  }
  return queryAll(value, path)[0] as T | undefined
}

/** The records a path selects: an array is the list; a single object is a list of one. */
export function queryRecords(value: unknown, path: string): unknown[] {
  const selected = queryAll(value, path)
  if (selected.length === 1 && Array.isArray(selected[0])) {
    return selected[0]
  }
  return selected.filter((item) => item !== undefined && item !== null)
}
