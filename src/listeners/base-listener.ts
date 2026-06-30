import { IncomingMessage } from '../agents/base-agent'

export type MessageHandler = (msg: IncomingMessage) => Promise<void>

export abstract class BaseListener {
  protected handlers: MessageHandler[] = []

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler)
  }

  protected async emit(msg: IncomingMessage): Promise<void> {
    for (const handler of this.handlers) {
      await handler(msg).catch(() => {})
    }
  }

  abstract start(): Promise<void>
  abstract stop(): Promise<void>
}
