import 'dotenv/config'
import * as fs from 'fs'
import { config } from './config'
import { store } from './history/store'
import { Orchestrator } from './orchestrator'
import { BaseListener } from './listeners/base-listener'
import { BaseOutput } from './output/base-output'
import { TelegramListener } from './listeners/telegram-listener'
import { TelegramOutput } from './output/telegram-output'
import { WhatsAppListener } from './listeners/whatsapp-listener'
import { WhatsAppOutput } from './output/whatsapp-output'
import { createLogger } from './logger'
import { startClaudeCallbackServer } from './claude-callback'

const log = createLogger('main')

async function main() {
  log.info({
    domain: config.domain,
    inputSource: config.inputSource,
    outputTarget: config.outputTarget,
    aiProvider: config.aiProvider,
    aiModel: config.aiModel,
    searchSites: config.searchSites,
  }, 'RequirementBot starting')

  // Ensure data dirs
  fs.mkdirSync(config.imagesDir, { recursive: true })

  // Wait for the DB to finish async WASM init before any messages arrive
  await store.waitReady()
  log.info('Database ready')

  // Local callback endpoint for interactive Claude subagents
  startClaudeCallbackServer(config.claudeCallbackPort)

  // ── Build output handlers ────────────────────────────────────────────────────
  const outputs: BaseOutput[] = []

  let waListener: WhatsAppListener | null = null
  let waOutput: WhatsAppOutput | null = null

  if (config.outputTarget === 'whatsapp' || config.outputTarget === 'both') {
    if (config.waOutputTargets.length === 0) {
      log.warn('WA_OUTPUT_TARGETS is empty — WhatsApp output disabled')
    } else {
      waOutput = new WhatsAppOutput()
      outputs.push(waOutput)
    }
  }

  if (config.outputTarget === 'telegram' || config.outputTarget === 'both') {
    if (config.tgOutputTargets.length === 0) {
      log.warn('TG_OUTPUT_TARGETS is empty — Telegram output disabled')
    } else {
      outputs.push(new TelegramOutput())
    }
  }

  // In setup/discovery mode (no outputs yet), allow startup so the user can
  // scan the QR code and see their group JIDs before filling in .env
  const setupMode = outputs.length === 0
  if (setupMode) {
    log.warn('No output targets configured — running in SETUP MODE (QR login + group discovery only)')
  }

  // ── Build orchestrator ───────────────────────────────────────────────────────
  const orchestrator = new Orchestrator(outputs)

  // ── Build listeners ──────────────────────────────────────────────────────────
  const listeners: BaseListener[] = []

  if (config.inputSource === 'whatsapp' || config.inputSource === 'both') {
    // Always start WA listener — even with no groups configured — so the user can
    // scan QR and see group JIDs printed in the logs (discovery mode)
    waListener = new WhatsAppListener()
    if (!setupMode) {
      waListener.onMessage(msg => orchestrator.handleMessage(msg))
    }
    listeners.push(waListener)

    // Share the live socket with WA output once connected
    if (waOutput) {
      waListener.onSocketReady(sock => waOutput!.setSocket(sock))
    }
  }

  if (config.inputSource === 'telegram' || config.inputSource === 'both') {
    if (!config.tgBotToken) {
      log.warn('TG_BOT_TOKEN not set — Telegram listener disabled')
    } else if (config.tgAllowedGroups.length === 0) {
      log.warn('TG_ALLOWED_GROUPS is empty — Telegram listener disabled')
    } else {
      const tgListener = new TelegramListener()
      tgListener.onMessage(msg => orchestrator.handleMessage(msg))
      listeners.push(tgListener)
    }
  }

  if (listeners.length === 0) {
    throw new Error('No listeners configured. Check INPUT_SOURCE and group settings.')
  }

  // ── Start all listeners ──────────────────────────────────────────────────────
  for (const listener of listeners) {
    await listener.start()
  }

  log.info(`RequirementBot running. Listening on ${listeners.length} source(s), outputting to ${outputs.length} target(s).`)

  // ── Graceful shutdown ────────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down...')
    for (const listener of listeners) {
      await listener.stop().catch(() => {})
    }
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
