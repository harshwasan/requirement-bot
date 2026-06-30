import TelegramBot from 'node-telegram-bot-api'
import * as fs from 'fs'
import * as path from 'path'
import { config } from '../config'
import { IncomingMessage } from '../agents/base-agent'
import { BaseListener } from './base-listener'
import { createLogger } from '../logger'
import { randomUUID } from 'crypto'

const log = createLogger('telegram-listener')

export class TelegramListener extends BaseListener {
  private bot: TelegramBot

  constructor() {
    super()
    if (!config.tgBotToken) throw new Error('TG_BOT_TOKEN is required for Telegram listener')
    this.bot = new TelegramBot(config.tgBotToken, { polling: false })
  }

  async start(): Promise<void> {
    this.bot.startPolling()

    this.bot.on('message', async (msg) => {
      // Filter: only allowed groups
      const chatId = String(msg.chat.id)
      if (!config.tgAllowedGroups.includes(chatId)) {
        log.debug({ chatId }, 'Ignoring message from non-allowed group')
        return
      }

      // Skip bot's own messages
      if (msg.from?.is_bot) return

      const text = msg.text ?? msg.caption ?? ''
      const imageBase64: string[] = []

      // Download images if present
      if (msg.photo?.length) {
        const largest = msg.photo[msg.photo.length - 1]!
        try {
          const b64 = await this.downloadPhotoAsBase64(largest.file_id)
          if (b64) imageBase64.push(b64)
        } catch (err) {
          log.warn({ err }, 'Failed to download Telegram photo')
        }
      }

      if (!text && imageBase64.length === 0) return

      const incoming: IncomingMessage = {
        id: randomUUID(),
        text,
        sender: msg.from?.username ?? msg.from?.first_name ?? String(msg.from?.id),
        groupId: chatId,
        groupName: msg.chat.title ?? chatId,
        source: 'telegram',
        timestamp: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
        imageBase64: imageBase64.length > 0 ? imageBase64 : undefined,
      }

      log.info({ groupId: chatId, sender: incoming.sender, text: text.slice(0, 60) }, 'Telegram message received')
      await this.emit(incoming)
    })

    log.info({ groups: config.tgAllowedGroups }, 'Telegram listener started')
  }

  async stop(): Promise<void> {
    await this.bot.stopPolling()
    log.info('Telegram listener stopped')
  }

  private async downloadPhotoAsBase64(fileId: string): Promise<string | null> {
    try {
      const fileInfo = await this.bot.getFile(fileId)
      const filePath = fileInfo.file_path
      if (!filePath) return null

      // Guard against path traversal in Telegram's file_path
      if (filePath.includes('..') || filePath.startsWith('/')) {
        log.warn({ filePath }, 'Suspicious file path from Telegram — skipping')
        return null
      }

      const { default: fetch } = await import('node-fetch')
      const url = `https://api.telegram.org/file/bot${config.tgBotToken}/${filePath}`

      // Check file size before downloading the whole thing
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)

      let buffer: Buffer
      try {
        const res = await fetch(url, { signal: controller.signal as any })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10)
        if (contentLength > config.maxImageSizeBytes) {
          log.warn({ contentLength, max: config.maxImageSizeBytes }, 'Image too large — skipping')
          return null
        }

        buffer = Buffer.from(await res.arrayBuffer())
      } finally {
        clearTimeout(timer)
      }

      if (buffer.length > config.maxImageSizeBytes) {
        log.warn({ size: buffer.length }, 'Downloaded image exceeds size limit — skipping')
        return null
      }

      // Save to disk with sanitized filename
      fs.mkdirSync(config.imagesDir, { recursive: true })
      const safeId = fileId.replace(/[^a-zA-Z0-9_-]/g, '_')
      const localPath = path.join(config.imagesDir, `tg_${safeId}.jpg`)
      fs.writeFileSync(localPath, buffer)

      return buffer.toString('base64')
    } catch (err) {
      log.warn({ fileId }, `Photo download failed: ${(err as Error).message}`)
      return null
    }
  }
}
