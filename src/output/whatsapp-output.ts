import { config } from '../config'
import { BaseOutput } from './base-output'
import { createLogger } from '../logger'
import { botSentMessageIds } from '../shared-state'

const log = createLogger('whatsapp-output')

// Baileys socket typed as `any` to avoid static ESM import (Baileys is pure ESM)
type WASocket = any

export class WhatsAppOutput extends BaseOutput {
  private sock: WASocket = null
  private allowedJids: Set<string>

  constructor(sock?: WASocket) {
    super()
    this.sock = sock ?? null
    this.allowedJids = new Set(config.waOutputTargets)
  }

  /** Attach a shared WhatsApp socket (reuse the listener's connection) */
  setSocket(sock: WASocket): void {
    this.sock = sock
  }

  async send(text: string): Promise<void> {
    if (!this.sock) {
      log.warn('WhatsApp socket not available, skipping WA output')
      return
    }

    for (const jid of config.waOutputTargets) {
      // Security: only send to explicitly configured targets
      if (!this.allowedJids.has(jid)) {
        log.warn({ jid }, 'Attempted to send to non-allowed JID — blocked')
        continue
      }

      try {
        const sent = await this.sock.sendMessage(jid, { text })
        if (sent?.key?.id) botSentMessageIds.add(sent.key.id)
        log.debug({ jid }, 'Sent WhatsApp message')
      } catch (err) {
        log.error({ err, jid }, 'Failed to send WhatsApp message')
      }
    }
  }
}
