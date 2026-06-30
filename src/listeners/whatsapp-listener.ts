import * as fs from 'fs'
import * as path from 'path'
import { Boom } from '@hapi/boom'
import { config } from '../config'
import { IncomingMessage } from '../agents/base-agent'
import { BaseListener } from './base-listener'
import { createLogger } from '../logger'
import { randomUUID } from 'crypto'
import { botSentMessageIds } from '../shared-state'

const log = createLogger('whatsapp-listener')
const AUTH_DIR = path.resolve('./data/wa-auth')

// Baileys is pure ESM with top-level await — must be loaded dynamically at runtime.
// Using `any` for the socket type avoids a static import that would break CJS loading.
type WASocket = any

const GROUP_HISTORY_SIZE = 8  // recent messages to keep per group for context

export function normalizeJid(jid: string | undefined): string {
  if (!jid) return ''
  const raw = jid.trim()
  const atIdx = raw.indexOf('@')
  if (atIdx < 0) return raw.split(':')[0] ?? ''

  const user = raw.slice(0, atIdx).split(':')[0]
  const domain = raw.slice(atIdx + 1)
  return `${user}@${domain}`
}

export function ownAdminJidsFromUserId(userId: string | undefined): string[] {
  const raw = normalizeJid(userId)
  if (!raw) return []

  const out = new Set<string>()
  out.add(raw)

  // If only phone number is present, add canonical WhatsApp JID form
  if (!raw.includes('@')) {
    out.add(`${raw}@s.whatsapp.net`)
  }

  // If Baileys gives LID user id, also allow PN JID form
  if (raw.endsWith('@lid')) {
    out.add(raw.replace(/@lid$/, '@s.whatsapp.net'))
  }

  return Array.from(out)
}

export function expandAdminJidVariants(jid: string | undefined): string[] {
  const raw = normalizeJid(jid)
  if (!raw) return []

  const out = new Set<string>()
  out.add(raw)

  if (!raw.includes('@')) {
    out.add(`${raw}@s.whatsapp.net`)
  }

  if (raw.endsWith('@lid')) {
    out.add(raw.replace(/@lid$/, '@s.whatsapp.net'))
  }

  return Array.from(out)
}

function isAdminCommandText(text: string): boolean {
  const t = text.trim().toUpperCase()
  if (!t) return false
  if (t === 'STATUS' || t === '/STATUS') return true
  // Clarification responses accepted by orchestrator
  return t === 'A' || t === 'B' || t === 'C' || t === 'R' || t === 'L' || t === 'S'
}

function unwrapMessageContent(message: any): any {
  let current = message
  while (current) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message
      continue
    }
    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message
      continue
    }
    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message
      continue
    }
    if (current.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message
      continue
    }
    if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message
      continue
    }
    break
  }
  return current ?? {}
}

function extractMessageText(message: any): string {
  const msg = unwrapMessageContent(message)
  return (
    msg?.conversation ??
    msg?.extendedTextMessage?.text ??
    msg?.imageMessage?.caption ??
    msg?.videoMessage?.caption ??
    msg?.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    ''
  )
}

export class WhatsAppListener extends BaseListener {
  private sock: WASocket = null
  private shouldReconnect = true
  private socketReadyCallbacks: Array<(sock: WASocket) => void> = []
  private groupHistory = new Map<string, Array<{sender: string, text: string}>>()
  private ownAdminJids = new Set<string>()

  /** Register a callback that fires when the socket is connected and ready */
  onSocketReady(cb: (sock: WASocket) => void): void {
    this.socketReadyCallbacks.push(cb)
    // If already connected, call immediately
    if (this.sock) cb(this.sock)
  }

  async start(): Promise<void> {
    fs.mkdirSync(AUTH_DIR, { recursive: true })
    await this.connect()
  }

  async stop(): Promise<void> {
    this.shouldReconnect = false
    this.sock?.end(undefined)
    log.info('WhatsApp listener stopped')
  }

  private async connect(): Promise<void> {
    // Dynamic import — deferred until runtime so Node's ESM loader handles it
    const baileys = await import('@whiskeysockets/baileys')
    const makeWASocket = baileys.default
    const { DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore } = baileys

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    this.ownAdminJids = new Set<string>([
      ...ownAdminJidsFromUserId(state.creds?.me?.id),
      ...ownAdminJidsFromUserId(state.creds?.me?.lid),
    ])

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, log as any),
      },
      printQRInTerminal: false,
      logger: log.child({ submodule: 'baileys' }) as any,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    })

    this.sock.ev.on('creds.update', saveCreds)

    this.sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }: any) => {
      if (qr) {
        // Save QR as a PNG image — much easier to scan than ASCII art
        try {
          const qrcode = await import('qrcode')
          const qrPath = path.resolve('./data/whatsapp-qr.png')
          fs.mkdirSync('./data', { recursive: true })
          await qrcode.default.toFile(qrPath, qr, { width: 400 })
          log.info(`QR code saved — open this file and scan it with WhatsApp:\n\n  ${qrPath}\n`)
        } catch {
          // Fallback to ASCII if image generation fails
          const qrcode = await import('qrcode-terminal')
          qrcode.default.generate(qr, { small: false })
          log.info('Scan the QR code above to connect WhatsApp')
        }
      }

      if (connection === 'open') {
        log.info({ groups: config.waAllowedGroups }, 'WhatsApp connected')
        for (const cb of this.socketReadyCallbacks) cb(this.sock)

        // Discovery mode: if no groups configured, list all groups this number is in
        if (config.waAllowedGroups.length === 0) {
          log.warn('WA_ALLOWED_GROUPS is empty — running in DISCOVERY MODE')
          log.warn('Listing all groups your WhatsApp is in. Copy the JIDs you want into .env:')
          try {
            const groups = await this.sock.groupFetchAllParticipating()
            for (const [jid, meta] of Object.entries(groups)) {
              log.info({ jid, name: (meta as any).subject }, 'GROUP FOUND')
            }
            log.warn('Set WA_ALLOWED_GROUPS=<jid1>,<jid2> in .env then restart the bot')
          } catch (err) {
            log.warn({ err }, 'Could not fetch group list — send a message in any group to discover its JID')
          }
        }
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error as Boom)?.output?.statusCode
        const shouldReconnect = code !== DisconnectReason.loggedOut && this.shouldReconnect

        log.warn({ code, shouldReconnect }, 'WhatsApp connection closed')

        if (shouldReconnect) {
          setTimeout(() => this.connect(), 5000)
        }
      }
    })

    this.sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
      log.info({ type, count: messages?.length }, 'messages.upsert fired')

      if (type !== 'notify' && type !== 'append') {
        log.info({ type }, 'Skipping unsupported upsert event type')
        return
      }

      // Derive admin JIDs: configured output targets + bot's own number
      const adminJids = new Set<string>([
        ...config.waOutputTargets.flatMap(j => expandAdminJidVariants(j)),
        ...Array.from(this.ownAdminJids),
      ].filter(Boolean))
      const inputJids = new Set<string>(config.waAllowedGroups.map(j => normalizeJid(j)))

      for (const msg of messages) {
        const jid = normalizeJid(msg.key.remoteJid)
        log.info({ jid, fromMe: msg.key.fromMe, id: msg.key.id }, 'Raw message in handler')

        // Skip messages the bot itself sent (prevents feedback loops)
        if (msg.key.id && botSentMessageIds.has(msg.key.id)) {
          log.info({ id: msg.key.id }, 'Skipping bot-sent message')
          botSentMessageIds.delete(msg.key.id)
          continue
        }

        const adminText = extractMessageText(msg.message)
        const adminMatched = adminJids.has(jid)
        log.info({ jid, adminMatched, adminText: adminText.slice(0, 60) }, 'Admin/direct match evaluation')
        if (adminMatched) {
          if (isAdminCommandText(adminText)) {
            log.info({ jid, text: adminText.slice(0, 60) }, 'Admin command received')
            const incoming: IncomingMessage = {
              id: randomUUID(),
              text: adminText,
              sender: 'admin',
              groupId: jid,
              groupName: 'admin',
              source: 'whatsapp',
              timestamp: (msg.messageTimestamp as number ?? Date.now() / 1000) * 1000,
              isDirectChat: true,
              isAdminCommand: true,
            }
            await this.emit(incoming)
            continue
          }

          // Allow normal processing from admin direct chat as a test/control channel.
          // This runs before the fromMe filter so self-messages can still drive the bot.
          if (adminText.trim().length > 0) {
            log.info({ jid, text: adminText.slice(0, 60), fromMe: msg.key.fromMe }, 'Admin direct message received')
            const incoming: IncomingMessage = {
              id: randomUUID(),
              text: adminText,
              sender: 'admin',
              groupId: jid,
              groupName: 'admin',
              source: 'whatsapp',
              timestamp: (msg.messageTimestamp as number ?? Date.now() / 1000) * 1000,
              isDirectChat: true,
            }
            await this.emit(incoming)
            continue
          }
        }

        // Keep ignoring most self-messages, but allow:
        // 1) admin chat (handled above), 2) configured input groups (useful for owner testing)
        if (msg.key.fromMe && !adminJids.has(jid) && !inputJids.has(jid)) continue

        // Filter: only allowed groups
        if (!inputJids.has(jid)) {
          if (inputJids.size === 0 && jid.endsWith('@g.us')) {
            log.info({ jid }, 'DISCOVERY — message received from group. Add this JID to WA_ALLOWED_GROUPS in .env')
          }
          continue
        }

        const text = extractMessageText(msg.message)

        const imageBase64: string[] = []
        if (msg.message?.imageMessage) {
          try {
            const buffer = await this.downloadMedia(msg)
            if (buffer) imageBase64.push(buffer.toString('base64'))
          } catch (err) {
            log.warn({ err }, 'Failed to download WA image')
          }
        }

        if (!text && imageBase64.length === 0) continue

        const sender =
          msg.pushName ??
          msg.key.participant?.split('@')[0] ??
          msg.key.remoteJid?.split('@')[0] ??
          'unknown'

        // Grab current history for this group (before adding the new message)
        const history = this.groupHistory.get(jid) ?? []

        // Update history ring buffer
        const updated = [...history, { sender, text }]
        if (updated.length > GROUP_HISTORY_SIZE) updated.shift()
        this.groupHistory.set(jid, updated)

        const incoming: IncomingMessage = {
          id: randomUUID(),
          text,
          sender,
          groupId: jid,
          groupName: config.waGroupNames[jid] ?? jid,
          source: 'whatsapp',
          timestamp: (msg.messageTimestamp as number ?? Date.now() / 1000) * 1000,
          imageBase64: imageBase64.length > 0 ? imageBase64 : undefined,
          groupHistory: history.length > 0 ? history : undefined,
        }

        log.info({ jid, sender, text: text.slice(0, 60) }, 'WhatsApp message received')
        await this.emit(incoming)
      }
    })
  }

  private async downloadMedia(msg: any): Promise<Buffer | null> {
    try {
      const { downloadMediaMessage } = await import('@whiskeysockets/baileys')
      const buffer = await downloadMediaMessage(msg, 'buffer', {})

      fs.mkdirSync(config.imagesDir, { recursive: true })
      const filename = path.join(config.imagesDir, `wa_${msg.key.id}.jpg`)
      fs.writeFileSync(filename, buffer as Buffer)

      return buffer as Buffer
    } catch {
      return null
    }
  }
}
