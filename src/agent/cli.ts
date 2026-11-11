import { mapRecord } from '../runtime/mapper'
import { applyFieldPolicy, AUTO_POLICY, profileFields } from '../pii'
import { RushDBAgent, AGENT_VERSION, normalizeValue, streamSpecOf } from './agent'
import { AgentClient } from './client'
import { loadAgentConfig, SAMPLE_CONFIG, streamId } from './config'

const HELP = `rushdb-agent ${AGENT_VERSION}: syncs databases on your network into RushDB, outbound only.

Usage: rushdb-agent <command> [--config rushdb-agent.yaml]

Commands:
  init       print a sample configuration
  check      connect to every source and to RushDB; change nothing
  dry-run    print what the next batch of each stream would send (after the field policy); send nothing
  fields     profile fields locally and report names, types and PII findings to RushDB (no values)
  once       run one sync cycle and exit
  run        keep syncing (the interval is set in RushDB; "Sync now" is picked up within pollSeconds)
`

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command] = argv
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(HELP)
    return command ? 0 : 1
  }
  if (command === 'init') {
    process.stdout.write(SAMPLE_CONFIG)
    return 0
  }
  const config = loadAgentConfig(argValue(argv, '--config') ?? process.env.RUSHDB_AGENT_CONFIG ?? 'rushdb-agent.yaml')
  const client = new AgentClient(config.rushdb.url, config.rushdb.token)
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => controller.abort())
  }
  const agent = new RushDBAgent({ client, config, signal: controller.signal })

  switch (command) {
    case 'check': {
      for (const version of await agent.connect()) {
        process.stdout.write(`source ok  ${version}\n`)
      }
      const description = await client.describe()
      process.stdout.write(`rushdb ok  connection "${description.connection.name}"${description.connection.paused ? ' (paused)' : ''}\n`)
      await agent.close()
      return 0
    }
    case 'dry-run': {
      await agent.connect()
      const description = await client.describe().catch(() => undefined)
      for (const source of config.sources) {
        for (const stream of source.streams) {
          const id = streamId(source, stream)
          const policy = description?.streams.find((candidate) => candidate.stream === id)?.policy ?? AUTO_POLICY
          const rows = await agent['drivers'].get(source.name)!.sample(stream, 3)
          const spec = streamSpecOf(source, stream)
          const preview = rows.map((row) => {
            const mapped = mapRecord(normalizeValue(row), spec)
            return mapped ? applyFieldPolicy(mapped.properties, policy, description?.hashKey) : undefined
          })
          process.stdout.write(`\n## ${id} → ${stream.label} (policy: ${policy.mode})\n${JSON.stringify(preview, null, 2)}\n`)
          const fields = profileFields(rows.map((row) => mapRecord(normalizeValue(row), spec)?.properties ?? {}))
          const flagged = fields.filter((field) => field.pii)
          if (flagged.length) {
            process.stdout.write(`Looks personal: ${flagged.map((field) => `${field.name} (${field.pii!.kind})`).join(', ')}\n`)
          }
        }
      }
      await agent.close()
      return 0
    }
    case 'fields': {
      await agent.connect()
      await agent.register()
      const count = await agent.reportFields()
      process.stdout.write(`Reported the fields of ${count} streams. Review them in RushDB.\n`)
      await agent.close()
      return 0
    }
    case 'once': {
      await agent.connect()
      await agent.register()
      const report = await agent.cycle('manual', argv.includes('--full'))
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      await agent.close()
      return report.status === 'failed' ? 1 : 0
    }
    case 'run':
      await agent.runForever()
      return 0
    default:
      process.stderr.write(HELP)
      return 1
  }
}

const isMain = typeof require !== 'undefined' && require.main === module
if (isMain || process.argv[1]?.endsWith('rushdb-agent') || process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('cli.cjs')) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`rushdb-agent: ${(error as Error).message}\n`)
      process.exit(1)
    }
  )
}
