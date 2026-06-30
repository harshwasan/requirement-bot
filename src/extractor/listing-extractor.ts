import { config } from '../config'
import { IncomingMessage } from '../agents/base-agent'
import { CarListing } from '../history/store'
import { ClaudeAgent } from '../agents/claude-agent'
import { ClaudeCliAgent } from '../agents/claude-cli-agent'
import { CodexAgent } from '../agents/codex-agent'
import { OllamaAgent } from '../agents/ollama-agent'
import { BaseAgent } from '../agents/base-agent'
import { createLogger } from '../logger'

const log = createLogger('extractor')

let _agent: BaseAgent | null = null

function getAgent(): BaseAgent {
  if (_agent) return _agent
  switch (config.aiProvider) {
    case 'claude':     _agent = new ClaudeAgent();    break
    case 'claude-cli': _agent = new ClaudeCliAgent(); break
    case 'codex':      _agent = new CodexAgent();     break
    case 'ollama':     _agent = new OllamaAgent();    break
  }
  return _agent!
}

export async function extractListing(msg: IncomingMessage): Promise<CarListing> {
  try {
    const listing = await getAgent().extractListing(msg)
    log.info({ make: listing.make, model: listing.model, year: listing.year }, 'Listing extracted')
    return listing
  } catch (err) {
    log.error({ err }, 'Listing extraction failed')
    return { extraDetails: { raw_text: msg.text, error: 'extraction_failed' } }
  }
}
