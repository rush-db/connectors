import { builtinConnectors } from './connectors'
import { connectorLogoDataUri } from './logos'
import { parseConnectorSpec } from './spec'

import type { ConnectorCatalogEntry, ConnectorDefinition } from './types'

const byId = new Map(builtinConnectors.map((definition) => [definition.spec.id, definition]))

/** A built-in connector by id. */
export function getConnector(id: string): ConnectorDefinition | undefined {
  return byId.get(id)
}

/** What a catalog page shows about a connector, without credentials or request details. */
export function describeConnector(definition: ConnectorDefinition): ConnectorCatalogEntry {
  const spec = parseConnectorSpec(definition.spec)
  return {
    id: spec.id,
    name: spec.name,
    category: spec.category,
    description: spec.description,
    docsUrl: spec.docsUrl,
    auth: spec.auth.map((auth) => auth.type),
    streams: Object.entries(spec.streams).map(([name, stream]) => ({
      name,
      label: stream.label,
      description: stream.description,
      optional: stream.optional
    })),
    config: spec.config,
    webhooks: Boolean(spec.webhooks),
    incremental: Object.values(spec.streams).some((stream) => Boolean(stream.incremental)),
    beta: Boolean(definition.beta),
    logo: connectorLogoDataUri(spec.id)
  }
}

export function catalog(): ConnectorCatalogEntry[] {
  return builtinConnectors.map(describeConnector)
}
