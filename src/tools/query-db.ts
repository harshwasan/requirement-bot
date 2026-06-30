#!/usr/bin/env tsx
/**
 * CLI tool for the claude-cli agent to query the DB.
 * Usage: npx tsx src/tools/query-db.ts "search terms"
 *
 * Outputs JSON: { listings: [...], pastResults: [...] }
 */
import 'dotenv/config'
import { getStore } from '../history/store'

const query = process.argv[2] ?? ''

async function main() {
  const store = getStore()
  await store.waitReady()

  if (!query.trim()) {
    console.log(JSON.stringify({ listings: [], pastResults: [] }))
    store.close()
    return
  }

  const context = store.getAgentContext(query)
  console.log(JSON.stringify(context, null, 2))
  store.close()
}

main().catch(err => {
  console.error(JSON.stringify({ error: String(err) }))
  process.exit(1)
})
