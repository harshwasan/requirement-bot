import { config } from '../config'
import { IncomingMessage, MessageType } from '../agents/base-agent'
import { ClaudeAgent } from '../agents/claude-agent'
import { ClaudeCliAgent } from '../agents/claude-cli-agent'
import { CodexAgent } from '../agents/codex-agent'
import { OllamaAgent } from '../agents/ollama-agent'
import { BaseAgent } from '../agents/base-agent'
import { createLogger } from '../logger'

const log = createLogger('classifier')

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

export async function classifyMessage(msg: IncomingMessage): Promise<MessageType> {
  try {
    const type = await getAgent().classifyMessage(msg)
    log.info({ type, text: msg.text.slice(0, 80) }, 'Message classified')
    return type
  } catch (err) {
    log.error({ err }, 'Classification failed, defaulting to irrelevant')
    return 'irrelevant'
  }
}
