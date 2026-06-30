/**
 * Shared mutable state between the WhatsApp output and listener.
 * Tracks message IDs the bot itself sent so the listener can skip them
 * (prevents the bot's own outgoing messages from triggering admin-command handling).
 */
export const botSentMessageIds = new Set<string>()
