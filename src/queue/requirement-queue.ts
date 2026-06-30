import { IncomingMessage } from '../agents/base-agent'
import { createLogger } from '../logger'

const log = createLogger('queue')

export interface QueuedItem {
  msg: IncomingMessage
  type: 'requirement' | 'listing'
  enqueuedAt: number
}

export class RequirementQueue {
  private queue: QueuedItem[] = []
  private processing = false
  private onItemReady?: () => void

  enqueue(msg: IncomingMessage, type: 'requirement' | 'listing'): void {
    this.queue.push({ msg, type, enqueuedAt: Date.now() })
    log.info({ queueLength: this.queue.length, type, text: msg.text.slice(0, 60) }, 'Item enqueued')
    this.onItemReady?.()
  }

  dequeue(): QueuedItem | undefined {
    return this.queue.shift()
  }

  peek(): QueuedItem | undefined {
    return this.queue[0]
  }

  get length(): number {
    return this.queue.length
  }

  get isProcessing(): boolean {
    return this.processing
  }

  setProcessing(val: boolean): void {
    this.processing = val
  }

  /** Register a callback that fires when a new item is enqueued */
  onReady(cb: () => void): void {
    this.onItemReady = cb
  }

  clear(): void {
    this.queue = []
    log.info('Queue cleared (daily reset)')
  }
}
