import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/index.ts', testing: 'src/testing/index.ts', agent: 'src/agent/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'node18'
  },
  {
    // The on-prem agent's command (`rushdb-agent`).
    entry: { 'rushdb-agent': 'src/agent/cli.ts' },
    format: ['cjs'],
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: true,
    target: 'node18'
  }
])
