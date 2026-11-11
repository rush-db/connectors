import { ConnectorRuntime, type ConnectionContext, type ConnectorDefinition, type ReadBatch, type StreamState } from '../src'
import { createMockFetch, noSleep, type MockRoute } from '../src/testing'

/** A runtime over mocked routes; egress is open because fixtures use fixed hosts and no DNS. */
export function mockRuntime(routes: MockRoute[], options: { sleep?: (ms: number) => Promise<void> } = {}) {
  const fetch = createMockFetch(routes)
  const runtime = new ConnectorRuntime({ fetch, sleep: options.sleep ?? noSleep, egress: () => 'any' })
  return { fetch, runtime }
}

export async function readAll(
  runtime: ConnectorRuntime,
  definition: ConnectorDefinition,
  connection: ConnectionContext,
  stream: string,
  state: StreamState = {},
  options: { full?: boolean; maxRecords?: number } = {}
): Promise<ReadBatch[]> {
  const batches: ReadBatch[] = []
  for await (const batch of runtime.read(definition, connection, stream, state, options)) {
    batches.push(batch)
  }
  return batches
}

export const records = (batches: ReadBatch[]) => batches.flatMap((batch) => batch.records)

export const bearer = (config: Record<string, unknown> = {}): ConnectionContext => ({
  config,
  credentials: { type: 'bearer', token: 'test-token' }
})
