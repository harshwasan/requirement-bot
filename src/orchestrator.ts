import * as cron from 'node-cron'
import { config } from './config'
import { AgentResult, IncomingMessage, MessageType } from './agents/base-agent'
import { ClaudeAgent } from './agents/claude-agent'
import { ClaudeCliAgent } from './agents/claude-cli-agent'
import { CodexAgent } from './agents/codex-agent'
import { OllamaAgent } from './agents/ollama-agent'
import { BaseAgent } from './agents/base-agent'
import { classifyMessage } from './classifier/message-classifier'
import { extractListing } from './extractor/listing-extractor'
import { store } from './history/store'
import { RequirementQueue } from './queue/requirement-queue'
import { BaseOutput } from './output/base-output'
import { formatListingSaved, formatRequirementResultMessages } from './output/base-output'
import { createLogger } from './logger'

const log = createLogger('orchestrator')

interface PendingClarification {
  msg: IncomingMessage
  askedAt: number
}

interface InboundQueuedItem {
  msg: IncomingMessage
  resolve: () => void
}

const IMAGE_WAIT_MS = 4 * 60 * 1000  // 4 minutes

export class Orchestrator {
  private queue = new RequirementQueue()
  private outputs: BaseOutput[]
  private agent: BaseAgent
  private busy = false
  private inboundQueue: InboundQueuedItem[] = []
  private inboundBusy = false
  private pendingClarifications: PendingClarification[] = []
  // key: `${groupId}:${sender}` — text-only messages waiting for a photo follow-up
  private imageWait = new Map<string, { msg: IncomingMessage; timer: NodeJS.Timeout }>()

  constructor(outputs: BaseOutput[]) {
    this.outputs = outputs
    this.agent = this.createAgent()

    // Process queue whenever a new item arrives
    this.queue.onReady(() => this.processNext())

    // Daily reset at configured hour
    cron.schedule(`0 ${config.dailyResetHour} * * *`, () => {
      log.info('Daily reset triggered')
      this.queue.clear()
      this.agent = this.createAgent()  // fresh agent instance
    })
  }

  private createAgent(): BaseAgent {
    switch (config.aiProvider) {
      case 'claude':     return new ClaudeAgent()
      case 'claude-cli': return new ClaudeCliAgent()
      case 'codex':      return new CodexAgent()
      case 'ollama':     return new OllamaAgent()
    }
  }

  /** Handle an incoming message from any listener */
  async handleMessage(msg: IncomingMessage): Promise<void> {
    // Admin command from the operator's personal chat
    if (msg.isAdminCommand) {
      await this.handleAdminCommand(msg)
      return
    }

    await new Promise<void>((resolve) => {
      this.inboundQueue.push({ msg, resolve })
      this.processInboundQueue()
    })
  }

  private async processInboundQueue(): Promise<void> {
    if (this.inboundBusy) return
    this.inboundBusy = true

    try {
      while (this.inboundQueue.length > 0) {
        const item = this.inboundQueue.shift()!
        try {
          await this.handleFilteredMessage(item.msg)
        } catch (err) {
          log.error({ err }, 'Failed to process inbound message')
        } finally {
          item.resolve()
        }
      }
    } finally {
      this.inboundBusy = false
    }
  }

  private async handleFilteredMessage(msg: IncomingMessage): Promise<void> {
    // If images arrive, check if they're a follow-up to a pending text-only listing
    if (msg.imageBase64 && msg.imageBase64.length > 0) {
      const key = `${msg.groupId}:${msg.sender}`
      const waiting = this.imageWait.get(key)
      if (waiting) {
        clearTimeout(waiting.timer)
        this.imageWait.delete(key)
        log.info({ sender: msg.sender }, 'Images received — merging with pending text listing')
        await this.handleListing({ ...waiting.msg, imageBase64: msg.imageBase64 })
        return
      }
    }

    log.info({ source: msg.source, text: msg.text.slice(0, 80) }, 'Handling incoming message')

    // Single-pass: agent classifies AND acts in one window (used by claude-cli)
    if (this.agent.processMessage) {
      let res
      try {
        res = await this.agent.processMessage(msg)
      } catch (err) {
        log.error({ err }, 'processMessage threw an error')
        if (this.isRateLimitError(err)) {
          await this.broadcastRateLimitNotice()
        } else {
          await this.broadcastProcessingErrorNotice()
        }
        return
      }

      if (res.type === 'irrelevant') {
        log.info('Message irrelevant — ignoring')
        return
      }
      if (res.type === 'reply') {
        await this.broadcast(res.reply)
        return
      }
      if (res.type === 'needs_clarification') {
        await this.askClarification(msg)
        return
      }
      if (res.type === 'listing') {
        await this.saveListing(msg, res.listing)
        return
      }
      if (res.type === 'requirement') {
        try {
          await this.saveAndBroadcastResult(msg, res.result)
        } catch (err) {
          log.error({ err }, 'saveAndBroadcastResult failed')
        }
      }
      return
    }

    // Fallback: separate classify → extract/search calls (other agent types)
    const type = await classifyMessage(msg)

    if (type === 'irrelevant') {
      log.info('Message classified as irrelevant — ignoring')
      return
    }

    if (type === 'listing') {
      // Text-only listing: wait for photos before committing.
      // If no images arrive within 4 minutes, treat as a requirement instead.
      if (!msg.imageBase64 || msg.imageBase64.length === 0) {
        log.info({ sender: msg.sender }, 'Text-only listing — waiting 4 min for images before deciding')
        const key = `${msg.groupId}:${msg.sender}`
        const timer = setTimeout(async () => {
          this.imageWait.delete(key)
          log.info({ sender: msg.sender }, 'No images followed — reclassifying text-only listing as requirement')
          this.queue.enqueue(msg, 'requirement')
        }, IMAGE_WAIT_MS)
        this.imageWait.set(key, { msg, timer })
        return
      }
      await this.handleListing(msg)
      return
    }

    if (type === 'needs_clarification') {
      await this.askClarification(msg)
      return
    }

    // Requirement — enqueue for agent processing
    this.queue.enqueue(msg, 'requirement')
  }

  private async askClarification(msg: IncomingMessage): Promise<void> {
    this.pendingClarifications.push({ msg, askedAt: Date.now() })
    const idx = this.pendingClarifications.length

    const historyLines = msg.groupHistory && msg.groupHistory.length > 0
      ? `\nRecent context:\n${msg.groupHistory.map(h => `  ${h.sender}: ${h.text}`).join('\n')}\n`
      : ''

    const question =
      `Unclear message in "${msg.groupName ?? msg.groupId}"\n` +
      `From: ${msg.sender}\n` +
      `"${msg.text}"` +
      historyLines +
      `\nIs this:\n` +
      `A - Requirement (someone looking to buy)\n` +
      `B - Listing (someone selling)\n` +
      `C - Skip\n\n` +
      `Reply A, B, or C`

    log.info({ pending: idx }, 'Asking admin for clarification')
    await this.broadcast(question)
  }

  private async handleAdminCommand(msg: IncomingMessage): Promise<void> {
    const reply = msg.text.trim().toUpperCase()

    if (reply === 'STATUS' || reply === '/STATUS') {
      const agentStatus = this.agent.getRuntimeStatus ? this.agent.getRuntimeStatus() : `Provider: ${config.aiProvider}`
      const status =
        `Bot status\n` +
        `Inbound queue: ${this.inboundQueue.length}\n` +
        `Inbound busy: ${this.inboundBusy ? 'yes' : 'no'}\n` +
        `Requirement queue: ${this.queue.length}\n` +
        `Requirement busy: ${this.busy ? 'yes' : 'no'}\n` +
        `Pending clarifications: ${this.pendingClarifications.length}\n` +
        `Waiting image follow-ups: ${this.imageWait.size}\n` +
        `${agentStatus}`
      await this.broadcast(status)
      return
    }

    if (this.pendingClarifications.length === 0) {
      log.info({ reply }, 'Admin reply received but no pending clarifications')
      return
    }

    const { msg: pending } = this.pendingClarifications.shift()!

    if (reply.startsWith('A') || reply.startsWith('R')) {
      log.info('Admin classified pending as requirement')
      await this.broadcast('Got it - treating as requirement, searching now...')
      this.queue.enqueue(pending, 'requirement')
    } else if (reply.startsWith('B') || reply.startsWith('L')) {
      log.info('Admin classified pending as listing')
      await this.broadcast('Got it - saving as listing...')
      await this.handleListing(pending)
    } else if (reply.startsWith('C') || reply.startsWith('S')) {
      log.info('Admin skipped pending message')
      await this.broadcast('Skipped.')
    } else {
      // Put it back and let admin know
      this.pendingClarifications.unshift({ msg: pending, askedAt: Date.now() })
      await this.broadcast('Reply A (requirement), B (listing), or C (skip)')
    }
  }

  /** Save a listing from already-extracted CarListing data (used by single-pass agent) */
  private async saveListing(msg: IncomingMessage, carData: import('./history/store').CarListing): Promise<void> {
    const imagePaths = msg.imageBase64 && msg.imageBase64.length > 0
      ? msg.imageBase64.map((_, i) => `${config.imagesDir}/${msg.source}_${msg.id}_${i}.jpg`)
      : undefined

    const listing = store.saveListing({
      domain: config.domain,
      source: msg.source,
      groupId: msg.groupId,
      groupName: msg.groupName,
      sender: msg.sender,
      rawText: msg.text,
      imagePaths,
      postedAt: msg.timestamp,
      ...carData,
    })

    log.info({ id: listing.id, make: listing.make, model: listing.model }, 'Listing saved')
    await this.broadcast(formatListingSaved(listing, msg))
  }

  /** Save requirement + results from a single-pass agent result, then broadcast */
  private async saveAndBroadcastResult(msg: IncomingMessage, result: AgentResult): Promise<void> {
    const req = store.saveRequirement({
      rawText: msg.text,
      source: msg.source,
      groupId: msg.groupId,
      groupName: msg.groupName,
      sender: msg.sender,
      timestamp: msg.timestamp,
    })

    if (result.matches.filter(m => m.source === 'external_site').length > 0) {
      store.saveResults(req.id, result.matches
        .filter(m => m.source === 'external_site')
        .map(m => ({ dealerName: m.dealerName, link: m.link, price: m.price, details: m.details, confidence: m.confidence, source: m.source }))
      )
    }
    store.updateRequirementStatus(req.id, 'done')

    // Use the requirement's DB id in the result for traceability
    result = { ...result, requirementId: req.id }
    for (const text of formatRequirementResultMessages(result, msg, config.requirementReplyMode)) {
      await this.broadcast(text)
    }
    log.info({ matches: result.matches.length }, 'Requirement processed and saved')
  }

  private async handleListing(msg: IncomingMessage): Promise<void> {
    log.info({ sender: msg.sender }, 'Processing listing')

    const carData = await extractListing(msg)
    await this.saveListing(msg, carData)
  }

  private async processNext(): Promise<void> {
    // Atomic busy check — dequeue immediately to prevent double-processing
    if (this.busy || this.queue.length === 0) return
    const item = this.queue.dequeue()
    if (!item) return  // another caller already consumed it

    this.busy = true
    const { msg } = item
    let requirementId: string | null = null

    try {
      log.info({ text: msg.text.slice(0, 80) }, 'Processing requirement')

      // Save requirement to DB
      const req = store.saveRequirement({
        rawText: msg.text,
        source: msg.source,
        groupId: msg.groupId,
        groupName: msg.groupName,
        sender: msg.sender,
        timestamp: msg.timestamp,
      })
      requirementId = req.id

      store.updateRequirementStatus(req.id, 'processing')

      // Build context from history
      const context = store.getAgentContext(msg.text)
      log.info({
        internalMatches: context.internalListings.length,
        pastResults: context.pastResults.length
      }, 'Agent context built')

      // Run agent
      const result = await this.agent.processRequirement(req.id, msg.text, context)

      // Save results
      if (result.matches.filter(m => m.source === 'external_site').length > 0) {
        store.saveResults(req.id, result.matches
          .filter(m => m.source === 'external_site')
          .map(m => ({
            dealerName: m.dealerName,
            link: m.link,
            price: m.price,
            details: m.details,
            confidence: m.confidence,
            source: m.source,
          }))
        )
      }

      store.updateRequirementStatus(req.id, 'done')

      // Send output
      for (const text of formatRequirementResultMessages(result, msg, config.requirementReplyMode)) {
        await this.broadcast(text)
      }

      log.info({ matches: result.matches.length }, 'Requirement processed')
    } catch (err) {
      log.error({ err }, 'Failed to process requirement')
      if (requirementId) {
        try { store.updateRequirementStatus(requirementId, 'failed') } catch { /* ignore */ }
      }
      if (this.isRateLimitError(err)) {
        await this.broadcastRateLimitNotice()
      } else {
        await this.broadcastProcessingErrorNotice()
      }
    } finally {
      this.busy = false
      // Process next item if queued
      if (this.queue.length > 0) {
        setImmediate(() => this.processNext())
      }
    }
  }

  private async broadcast(text: string): Promise<void> {
    await Promise.allSettled(
      this.outputs.map(out => out.send(text).catch(err => log.error({ err }, 'Output failed')))
    )
  }

  private isRateLimitError(err: unknown): boolean {
    const msg = String((err as Error)?.message ?? err ?? '').toLowerCase()
    return (
      msg.includes('rate limit') ||
      msg.includes('rate_limit') ||
      msg.includes('rate-limit') ||
      msg.includes('/rate-limit-options') ||
      msg.includes('too many requests')
    )
  }

  private async broadcastRateLimitNotice(): Promise<void> {
    await this.broadcast('AI provider rate limit exceeded. Please try again after some time.')
  }

  private async broadcastProcessingErrorNotice(): Promise<void> {
    await this.broadcast('AI processing failed for this request. Please try again.')
  }
}
