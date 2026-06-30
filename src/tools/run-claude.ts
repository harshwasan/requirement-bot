#!/usr/bin/env tsx
/**
 * Runner called from a visible terminal window by claude-cli-agent.
 * Reads the prompt from a file (avoids command-line escaping issues entirely),
 * passes it to claude as a raw Node.js argument (no shell interpretation),
 * and streams output to both the terminal and an output file simultaneously.
 *
 * Usage: npx tsx run-claude.ts <promptFile> <outputFile> [--allowedTools Tools,...]
 */
import { spawn } from 'child_process'
import * as fs from 'fs'

const [promptFile, outputFile, ...extraArgs] = process.argv.slice(2)

if (!promptFile || !outputFile) {
  console.error('Usage: run-claude.ts <promptFile> <outputFile> [--allowedTools ...]')
  process.exit(1)
}

const prompt = fs.readFileSync(promptFile, 'utf8')
const allowPermissionBypass = process.env.REQBOT_ALLOW_CLAUDE_BYPASS === 'true'

// Remove CLAUDECODE env var so claude doesn't refuse to run inside another Claude session
const env = { ...process.env }
delete env['CLAUDECODE']

// Pass the prompt via stdin — avoids Windows command-line length limits entirely.
// Claude --print accepts input from stdin or as a positional arg; stdin is safer for large prompts.
const permissionArgs = allowPermissionBypass
  ? ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
  : []
const child = spawn('claude', [...permissionArgs, '--print', ...extraArgs], {
  stdio: ['pipe', 'pipe', 'inherit'],  // stdin piped (for prompt), stdout piped, stderr to terminal
  env,
})

child.stdin?.write(prompt, 'utf8')
child.stdin?.end()

const writeStream = fs.createWriteStream(outputFile)

child.stdout?.on('data', (data: Buffer) => {
  process.stdout.write(data)   // show in terminal
  writeStream.write(data)      // save for the bot to parse
})

child.on('close', (code) => {
  writeStream.end()
  process.exit(code ?? 0)
})

child.on('error', (err) => {
  console.error('Failed to run claude:', err)
  writeStream.end()
  process.exit(1)
})
