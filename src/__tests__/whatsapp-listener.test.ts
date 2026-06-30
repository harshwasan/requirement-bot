import { expandAdminJidVariants, normalizeJid, ownAdminJidsFromUserId } from '../listeners/whatsapp-listener'

describe('whatsapp listener JID normalization', () => {
  it('preserves the JID domain while removing the device suffix', () => {
    expect(normalizeJid('100000000001:3@lid')).toBe('100000000001@lid')
    expect(normalizeJid('100000000002:3@s.whatsapp.net')).toBe('100000000002@s.whatsapp.net')
  })

  it('builds admin variants for the bot account from both PN and LID identities', () => {
    expect(ownAdminJidsFromUserId('100000000001:3@lid')).toEqual([
      '100000000001@lid',
      '100000000001@s.whatsapp.net',
    ])

    expect(ownAdminJidsFromUserId('100000000002:3@s.whatsapp.net')).toEqual([
      '100000000002@s.whatsapp.net',
    ])
  })

  it('keeps configured admin targets stable when already in canonical form', () => {
    expect(expandAdminJidVariants('100000000002@s.whatsapp.net')).toEqual([
      '100000000002@s.whatsapp.net',
    ])
  })
})
