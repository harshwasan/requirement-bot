import TelegramBot from 'node-telegram-bot-api'
import { config } from '../config'
import { BaseOutput } from './base-output'
import { createLogger } from '../logger'

const log = createLogger('telegram-output')

export class TelegramOutput extends BaseOutput {
  private bot: TelegramBot
  private chatIds: string[]

  constructor() {
    super()
    if (!config.tgBotToken) throw new Error('TG_BOT_TOKEN required for Telegram output')
    this.bot = new TelegramBot(config.tgBotToken)
    this.chatIds = config.tgOutputTargets
  }

  async send(text: string): Promise<void> {
    for (const chatId of this.chatIds) {
      try {
        await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' })
        log.debug({ chatId }, 'Sent Telegram message')
      } catch (err) {
        // Retry without markdown if parsing fails
        try {
          await this.bot.sendMessage(chatId, text)
        } catch (err2) {
          log.error({ err: err2, chatId }, 'Failed to send Telegram message')
        }
      }
    }
  }
}
