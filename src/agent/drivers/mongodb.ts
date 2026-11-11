import { importDriver, selectedColumns, type Position, type Row, type SourceDriver } from './driver'

import type { AgentSourceConfig, AgentStreamConfig } from '../config'

/** MongoDB: keyset over (cursor, _id) with an index on them recommended. */
export function mongodbDriver(source: AgentSourceConfig): SourceDriver {
  let client: any
  let db: any
  const projection = (stream: AgentStreamConfig) => {
    const columns = selectedColumns(stream)
    return columns ? Object.fromEntries(columns.map((column) => [column, 1])) : undefined
  }
  return {
    async connect() {
      const mongodb = await importDriver<any>('mongodb')
      const MongoClient = mongodb.MongoClient ?? mongodb.default?.MongoClient
      client = new MongoClient(source.url, { readPreference: 'secondaryPreferred' })
      await client.connect()
      db = client.db(source.database)
      const info = await db.admin().command({ buildInfo: 1 }).catch(() => ({}))
      return `mongodb ${info.version ?? ''}`.trim()
    },
    async page(stream: AgentStreamConfig, after: Position, limit: number): Promise<Row[]> {
      const id = stream.id === 'id' ? '_id' : stream.id
      const filter: Record<string, unknown>[] = [stream.filter ?? {}]
      let sort: Record<string, 1>
      if (stream.cursor) {
        if (after.cursor !== undefined && after.cursor !== null) {
          filter.push(
            after.id !== undefined && after.id !== null ?
              { $or: [{ [stream.cursor]: { $gt: after.cursor } }, { [stream.cursor]: after.cursor, [id]: { $gt: after.id } }] }
            : { [stream.cursor]: { $gte: after.cursor } }
          )
        }
        sort = { [stream.cursor]: 1, [id]: 1 }
      } else {
        if (after.id !== undefined && after.id !== null) {
          filter.push({ [id]: { $gt: after.id } })
        }
        sort = { [id]: 1 }
      }
      return db
        .collection(stream.collection)
        .find({ $and: filter }, { projection: projection(stream) })
        .sort(sort)
        .limit(limit)
        .toArray()
    },
    async sample(stream: AgentStreamConfig, limit: number): Promise<Row[]> {
      return db.collection(stream.collection).find(stream.filter ?? {}, { projection: projection(stream) }).limit(limit).toArray()
    },
    async close() {
      await client?.close()
    }
  }
}
