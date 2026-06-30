import { RequirementQueue } from '../queue/requirement-queue'
import { IncomingMessage } from '../agents/base-agent'

function makeMsg(id = '1', text = 'test'): IncomingMessage {
  return {
    id,
    text,
    source: 'telegram',
    timestamp: Date.now(),
  }
}

describe('RequirementQueue', () => {
  let queue: RequirementQueue

  beforeEach(() => {
    queue = new RequirementQueue()
  })

  it('starts empty', () => {
    expect(queue.length).toBe(0)
    expect(queue.dequeue()).toBeUndefined()
    expect(queue.peek()).toBeUndefined()
  })

  it('enqueues items', () => {
    queue.enqueue(makeMsg('1'), 'requirement')
    expect(queue.length).toBe(1)
  })

  it('dequeues in FIFO order', () => {
    queue.enqueue(makeMsg('1', 'first'), 'requirement')
    queue.enqueue(makeMsg('2', 'second'), 'requirement')
    queue.enqueue(makeMsg('3', 'third'), 'listing')

    expect(queue.dequeue()?.msg.text).toBe('first')
    expect(queue.dequeue()?.msg.text).toBe('second')
    expect(queue.dequeue()?.msg.text).toBe('third')
    expect(queue.dequeue()).toBeUndefined()
  })

  it('peek does not remove item', () => {
    queue.enqueue(makeMsg('1'), 'requirement')
    expect(queue.peek()?.msg.id).toBe('1')
    expect(queue.peek()?.msg.id).toBe('1')
    expect(queue.length).toBe(1)
  })

  it('clear empties the queue', () => {
    queue.enqueue(makeMsg('1'), 'requirement')
    queue.enqueue(makeMsg('2'), 'requirement')
    queue.clear()
    expect(queue.length).toBe(0)
    expect(queue.dequeue()).toBeUndefined()
  })

  it('isProcessing starts false', () => {
    expect(queue.isProcessing).toBe(false)
  })

  it('setProcessing updates flag', () => {
    queue.setProcessing(true)
    expect(queue.isProcessing).toBe(true)
    queue.setProcessing(false)
    expect(queue.isProcessing).toBe(false)
  })

  it('calls onReady callback when item is enqueued', () => {
    const cb = jest.fn()
    queue.onReady(cb)
    queue.enqueue(makeMsg('1'), 'requirement')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('onReady callback fires for each enqueue', () => {
    const cb = jest.fn()
    queue.onReady(cb)
    queue.enqueue(makeMsg('1'), 'requirement')
    queue.enqueue(makeMsg('2'), 'listing')
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('stores the message type', () => {
    queue.enqueue(makeMsg('1'), 'listing')
    expect(queue.dequeue()?.type).toBe('listing')
  })

  it('stores enqueuedAt timestamp', () => {
    const before = Date.now()
    queue.enqueue(makeMsg('1'), 'requirement')
    const after = Date.now()
    const item = queue.dequeue()!
    expect(item.enqueuedAt).toBeGreaterThanOrEqual(before)
    expect(item.enqueuedAt).toBeLessThanOrEqual(after)
  })
})
