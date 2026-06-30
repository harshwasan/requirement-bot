/**
 * Tests for the Orchestrator — message routing, race conditions, listing/requirement paths.
 */
import { Orchestrator } from '../orchestrator'
import { BaseOutput } from '../output/base-output'
import { IncomingMessage } from '../agents/base-agent'
import { store as _storeModule } from '../history/store'

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../config', () => ({
  config: {
    domain: 'used_cars',
    aiProvider: 'claude',
    dailyResetHour: 0,
    imagesDir: '/tmp/test-images',
    searchSites: ['pakwheels.com'],
    domainDescription: 'used cars',
    maxImageSizeBytes: 5 * 1024 * 1024,
  },
  getGroupName: (id: string) => id,
}))

jest.mock('../logger', () => ({
  createLogger: () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn(() => ({})),
  }),
}))

// Mock the classifier to control what type messages are
const mockClassify = jest.fn()
jest.mock('../classifier/message-classifier', () => ({
  classifyMessage: (...args: any[]) => mockClassify(...args),
}))

// Mock listing extractor
const mockExtract = jest.fn()
jest.mock('../extractor/listing-extractor', () => ({
  extractListing: (...args: any[]) => mockExtract(...args),
}))

// Mock the history store — factory must not reference outer const/let (TDZ)
jest.mock('../history/store', () => ({
  store: {
    saveRequirement: jest.fn((r: any) => ({ ...r, id: 'req-1', status: 'pending' })),
    updateRequirementStatus: jest.fn(),
    saveResults: jest.fn(),
    saveListing: jest.fn((l: any) => ({ ...l, id: 'lst-1', createdAt: Date.now() })),
    getAgentContext: jest.fn(() => ({ pastResults: [], internalListings: [] })),
    waitReady: jest.fn().mockResolvedValue(undefined),
  },
  getStore: jest.fn(),
}))

// Reference to the mocked store (import is intercepted by Jest)
const mockStore = _storeModule as any

// Mock agent — use closure wrapper to avoid TDZ (factory is hoisted before const init)
const mockProcessReq = jest.fn()
jest.mock('../agents/claude-agent', () => ({
  ClaudeAgent: jest.fn().mockImplementation(() => ({
    processRequirement: (...args: any[]) => mockProcessReq(...args),
    classifyMessage: jest.fn(),
    extractListing: jest.fn(),
  })),
}))

// Mock cron
jest.mock('node-cron', () => ({
  schedule: jest.fn(),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

class MockOutput extends BaseOutput {
  public received: string[] = []
  async send(text: string): Promise<void> {
    this.received.push(text)
  }
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'msg-1',
    text: 'Looking for Toyota Corolla',
    sender: 'Ali',
    groupId: '-100123',
    groupName: 'Test Group',
    source: 'telegram',
    timestamp: Date.now(),
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Orchestrator', () => {
  let output: MockOutput
  let orchestrator: Orchestrator

  beforeEach(() => {
    jest.clearAllMocks()
    output = new MockOutput()
    orchestrator = new Orchestrator([output])

    mockProcessReq.mockResolvedValue({
      requirementId: 'req-1',
      requirementText: 'Toyota Corolla',
      matches: [],
      summary: 'No results.',
      searchedSites: ['pakwheels.com'],
      searchedAt: Date.now(),
    })

    mockExtract.mockResolvedValue({
      make: 'Toyota', model: 'Corolla', year: 2020,
    })
  })

  describe('handleMessage — routing', () => {
    it('ignores messages classified as irrelevant', async () => {
      mockClassify.mockResolvedValue('irrelevant')
      await orchestrator.handleMessage(makeMsg())
      expect(mockStore.saveRequirement).not.toHaveBeenCalled()
      expect(mockStore.saveListing).not.toHaveBeenCalled()
      expect(output.received).toHaveLength(0)
    })

    it('routes listing messages to listing handler', async () => {
      mockClassify.mockResolvedValue('listing')
      await orchestrator.handleMessage(makeMsg({ imageBase64: ['img'] }))
      expect(mockStore.saveListing).toHaveBeenCalled()
    })

    it('routes requirement messages to queue', async () => {
      mockClassify.mockResolvedValue('requirement')
      // Wait for async processing
      await orchestrator.handleMessage(makeMsg())
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockStore.saveRequirement).toHaveBeenCalled()
    })

    it('sends output after processing requirement', async () => {
      mockClassify.mockResolvedValue('requirement')
      await orchestrator.handleMessage(makeMsg())
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(output.received.length).toBeGreaterThan(0)
    })

    it('sends output after processing listing', async () => {
      mockClassify.mockResolvedValue('listing')
      await orchestrator.handleMessage(makeMsg({ imageBase64: ['img'] }))
      expect(output.received.length).toBeGreaterThan(0)
    })
  })

  describe('handleMessage — listing path', () => {
    // Text-only listings wait 4 min for images; use imageBase64 to trigger immediate save
    const listingMsg = (overrides: Partial<IncomingMessage> = {}) =>
      makeMsg({ imageBase64: ['base64img'], ...overrides })

    beforeEach(() => {
      mockClassify.mockResolvedValue('listing')
    })

    it('saves listing with correct source', async () => {
      await orchestrator.handleMessage(listingMsg({ source: 'telegram' }))
      expect(mockStore.saveListing).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'telegram' })
      )
    })

    it('saves listing with sender info', async () => {
      await orchestrator.handleMessage(listingMsg({ sender: 'Ahmed' }))
      expect(mockStore.saveListing).toHaveBeenCalledWith(
        expect.objectContaining({ sender: 'Ahmed' })
      )
    })

    it('saves listing with group info', async () => {
      await orchestrator.handleMessage(listingMsg({ groupId: '-100xyz', groupName: 'Cars Group' }))
      expect(mockStore.saveListing).toHaveBeenCalledWith(
        expect.objectContaining({ groupId: '-100xyz', groupName: 'Cars Group' })
      )
    })

    it('text-only listing starts image wait (does not call saveListing immediately)', async () => {
      await orchestrator.handleMessage(makeMsg({ imageBase64: undefined }))
      expect(mockStore.saveListing).not.toHaveBeenCalled()
    })

    it('sets imagePaths when images present', async () => {
      await orchestrator.handleMessage(listingMsg({ imageBase64: ['base64data'] }))
      const call = mockStore.saveListing.mock.calls[0][0]
      expect(call.imagePaths).toBeDefined()
      expect(Array.isArray(call.imagePaths)).toBe(true)
    })
  })

  describe('handleMessage — requirement path', () => {
    beforeEach(() => {
      mockClassify.mockResolvedValue('requirement')
    })

    it('marks requirement as processing before running agent', async () => {
      await orchestrator.handleMessage(makeMsg())
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(mockStore.updateRequirementStatus).toHaveBeenCalledWith('req-1', 'processing')
    })

    it('marks requirement as done after agent completes', async () => {
      await orchestrator.handleMessage(makeMsg())
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(mockStore.updateRequirementStatus).toHaveBeenCalledWith('req-1', 'done')
    })

    it('fetches agent context before calling agent', async () => {
      await orchestrator.handleMessage(makeMsg())
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(mockStore.getAgentContext).toHaveBeenCalled()
    })
  })

  describe('Race condition prevention', () => {
    it('processes items sequentially (not double-processing)', async () => {
      mockClassify.mockResolvedValue('requirement')

      let processingCount = 0
      let maxConcurrent = 0

      mockProcessReq.mockImplementation(async () => {
        processingCount++
        maxConcurrent = Math.max(maxConcurrent, processingCount)
        await new Promise(resolve => setTimeout(resolve, 50))
        processingCount--
        return { requirementId: 'req-1', requirementText: 'test', matches: [], summary: '', searchedSites: [], searchedAt: Date.now() }
      })

      // Fire 3 messages at the same time
      await Promise.all([
        orchestrator.handleMessage(makeMsg({ id: '1', text: 'req 1' })),
        orchestrator.handleMessage(makeMsg({ id: '2', text: 'req 2' })),
        orchestrator.handleMessage(makeMsg({ id: '3', text: 'req 3' })),
      ])

      // Wait for all to process
      await new Promise(resolve => setTimeout(resolve, 500))

      // Should never have more than 1 concurrent agent
      expect(maxConcurrent).toBe(1)
    })
  })

  describe('broadcast — multiple outputs', () => {
    it('sends to all configured outputs', async () => {
      const output2 = new MockOutput()
      const multi = new Orchestrator([output, output2])
      mockClassify.mockResolvedValue('listing')
      await multi.handleMessage(makeMsg({ imageBase64: ['img'] }))
      expect(output.received.length).toBeGreaterThan(0)
      expect(output2.received.length).toBeGreaterThan(0)
    })

    it('continues sending to other outputs if one fails', async () => {
      const failingOutput = new MockOutput()
      failingOutput.send = jest.fn().mockRejectedValue(new Error('Send failed'))
      const multi = new Orchestrator([failingOutput, output])
      mockClassify.mockResolvedValue('listing')
      await expect(multi.handleMessage(makeMsg({ imageBase64: ['img'] }))).resolves.not.toThrow()
    })
  })
})
