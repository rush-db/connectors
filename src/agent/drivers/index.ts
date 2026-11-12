import { clickhouseDriver } from './clickhouse'
import { mongodbDriver } from './mongodb'
import { mysqlDriver } from './mysql'
import { postgresDriver } from './postgres'

import type { AgentSourceConfig } from '../config'
import type { DriverFactory, SourceDriver } from './driver'

export const drivers: Record<AgentSourceConfig['type'], DriverFactory> = {
  postgres: postgresDriver,
  mysql: mysqlDriver,
  mongodb: mongodbDriver,
  clickhouse: clickhouseDriver
}

export function createDriver(source: AgentSourceConfig): SourceDriver {
  return drivers[source.type](source)
}

export type { DriverFactory, Position, Row, SourceDriver } from './driver'
