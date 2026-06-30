jest.mock('../history/store', () => ({
  store: {
    getAgentContext: jest.fn(() => ({
      internalListings: [],
      pastResults: [],
    })),
  },
}))

import { ClaudeCliAgent } from '../agents/claude-cli-agent'
import { IncomingMessage } from '../agents/base-agent'

describe('ClaudeCliAgent processMessage parsing', () => {
  it('accepts reply JSON with loose escapes instead of dropping it as irrelevant', async () => {
    const agent = new ClaudeCliAgent()
    const visibleSpy = jest.spyOn<any, any>(agent as any, 'callCliVisible')
      .mockResolvedValue('{"type":"reply","reply":"Hi\\! How can I help you today?"}')

    const msg: IncomingMessage = {
      id: '1',
      text: 'hi',
      sender: 'admin',
      groupId: '100000000001@lid',
      groupName: 'admin',
      source: 'whatsapp',
      timestamp: Date.now(),
      isDirectChat: true,
    }

    await expect(agent.processMessage(msg)).resolves.toEqual({
      type: 'reply',
      reply: 'Hi\\! How can I help you today?',
    })

    expect(visibleSpy).toHaveBeenCalled()
  })
})
