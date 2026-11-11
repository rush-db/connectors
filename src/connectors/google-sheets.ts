import { propertyName } from '../runtime/mapper'
import type { StreamSpec } from '../spec'
import { defineConnector, type ConnectorHttp, type StreamState } from '../types'

/*
 * Google Sheets API v4: one stream per tab of the configured spreadsheet.
 * The first row holds the column names; every later non-empty row is a
 * record. A record's id is the value of the key column when one is set
 * (rows without a key are skipped), else the row number, which shifts when
 * rows are inserted or removed above it, so set a key column for stable ids.
 *
 * Sheets have no change feed: every run reads the whole tab, in chunks of
 * rows, and the state remembers the next row so an interrupted run resumes.
 * No webhooks.
 */

const CHUNK_ROWS = 5000

/** Quoted A1 sheet name: `'Q1 ''24'`. */
const quoteSheet = (title: string) => `'${title.replace(/'/g, "''")}'`

function columnLetter(index: number): string {
  let letter = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letter = String.fromCharCode(65 + ((n - 1) % 26)) + letter
  }
  return letter
}

/** Column names from the header row: blanks get the column letter, repeats a suffix. */
export function headerNames(row: unknown[]): string[] {
  const seen = new Map<string, number>()
  return row.map((cell, index) => {
    const base = String(cell ?? '').trim() || `column_${columnLetter(index)}`
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    return count === 1 ? base : `${base}_${count}`
  })
}

function tabStream(title: string, keyColumn: string | undefined): StreamSpec {
  const label = `GSHEET_${propertyName(title).toUpperCase()}`.replace(/^GSHEET_F_/, 'GSHEET_')
  const id =
    keyColumn && !keyColumn.includes("'") ? `$['${keyColumn}']`
    : keyColumn && !keyColumn.includes('"') ? `$["${keyColumn}"]`
    : '$._row'
  return {
    label,
    description: `Rows of the "${title}" tab.`,
    request: {
      path: `/v4/spreadsheets/{{config.spreadsheetId}}/values/${encodeURIComponent(quoteSheet(title))}`
    },
    records: '$.values',
    id
  }
}

function tabTitle(stream: StreamSpec): string | undefined {
  const encoded = stream.request.path.split('/values/')[1]
  if (!encoded) {
    return undefined
  }
  const quoted = decodeURIComponent(encoded)
  return quoted.startsWith("'") && quoted.endsWith("'") ? quoted.slice(1, -1).replace(/''/g, "'") : quoted
}

async function* readTab(
  http: ConnectorHttp,
  spreadsheetId: string,
  title: string,
  state: StreamState
) {
  const valuesUrl = (range: string) =>
    `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${quoteSheet(title)}!${range}`)}`
  const options = { valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING', majorDimension: 'ROWS' }

  const header = await http.request({ url: valuesUrl('1:1'), query: options })
  const names = headerNames(header.data?.values?.[0] ?? [])
  if (!names.length) {
    yield { records: [], state: { cursor: undefined } }
    return
  }
  let start = Number((state.page as { row?: number } | undefined)?.row) || 2
  for (;;) {
    const end = start + CHUNK_ROWS - 1
    const response = await http.request({ url: valuesUrl(`${start}:${end}`), query: options })
    const rows: unknown[][] = response.data?.values ?? []
    const records = rows
      .map((row, index) => {
        if (!row.some((cell) => cell !== '' && cell !== null && cell !== undefined)) {
          return null
        }
        const record: Record<string, unknown> = { _row: start + index }
        names.forEach((name, column) => {
          record[name] = row[column] ?? null
        })
        return record
      })
      .filter(Boolean)
    const done = rows.length < CHUNK_ROWS
    yield { records, state: done ? { cursor: undefined } : { cursor: undefined, page: { row: end + 1 } } }
    if (done) {
      return
    }
    start = end + 1
  }
}

export const googleSheets = defineConnector({
  spec: {
    id: 'google-sheets',
    name: 'Google Sheets',
    category: 'spreadsheet',
    description: 'Every tab of a Google spreadsheet as records, with the first row as column names.',
    docsUrl: 'https://developers.google.com/sheets/api/reference/rest',
    auth: [
      {
        type: 'oauth2',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' }
      }
    ],
    config: {
      spreadsheetId: {
        label: 'Spreadsheet ID',
        placeholder: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
        help: 'The part of the spreadsheet URL between /d/ and /edit.'
      },
      keyColumn: {
        label: 'Key column',
        required: false,
        help: 'Header of a column with a unique value per row (an email, an order number). Without one, rows are identified by row number.'
      }
    },
    baseUrl: 'https://sheets.googleapis.com',
    // 60 read requests per minute per user.
    rateLimit: { requestsPerSecond: 1 },
    test: {
      request: { path: '/v4/spreadsheets/{{config.spreadsheetId}}', query: { fields: 'properties.title' } },
      account: '$.properties.title'
    },
    streams: {}
  },
  hooks: {
    async discover(ctx) {
      const spreadsheetId = String(ctx.connection.config.spreadsheetId ?? '')
      const keyColumn = ctx.connection.config.keyColumn ? String(ctx.connection.config.keyColumn) : undefined
      const response = await ctx.http.request({
        url: `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`,
        query: { fields: 'sheets.properties(sheetId,title,sheetType)' }
      })
      const streams: Record<string, StreamSpec> = {}
      for (const sheet of response.data?.sheets ?? []) {
        const properties = sheet?.properties
        if (!properties?.title || (properties.sheetType && properties.sheetType !== 'GRID')) {
          continue
        }
        let name = propertyName(properties.title)
        for (let n = 2; streams[name]; n++) {
          name = `${propertyName(properties.title)}_${n}`
        }
        streams[name] = tabStream(properties.title, keyColumn)
      }
      return streams
    },
    read(stream, state, ctx) {
      const title = tabTitle(stream.spec)
      if (!title) {
        return undefined
      }
      return readTab(ctx.http, String(ctx.connection.config.spreadsheetId ?? ''), title, state)
    }
  }
})
