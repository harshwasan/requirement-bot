<h1 align="center">⚙️ Requirement Bot</h1>

<p align="center">
  <b>A configurable AI workflow that classifies marketplace requirements, searches approved sources, and prepares ranked matches for operator review.</b>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#ai-providers">AI providers</a> ·
  <a href="#security">Security</a>
</p>

---

Marketplace and sales groups often lose useful requests in fast-moving chat. Someone posts *"looking for a 2018 Honda Civic under a fixed budget in Demo City"* and the message scrolls away before the right listing is found. **Requirement Bot** ingests allowlisted chats, classifies messages with an LLM, and when it sees a genuine requirement it runs a controlled search over trusted sites and prepares ranked matches.

It can also capture listings — parsing free text and photos into structured records — so future requirements can be matched against local history first, before touching the web.

It is **domain-agnostic**: ships with presets for **used cars** and **real estate**, and works for any buy/sell vertical by changing a couple of environment variables.

> This repository is a sanitized portfolio/demo release. Configure it only for groups, channels, websites and recipients where you have permission to automate monitoring or replies.

---

## Features

- **Requirement detection** — an LLM classifies every message as *requirement*, *listing*, or *irrelevant* with a human-in-the-loop fallback for ambiguous ones.
- **Agentic search** — for each requirement, the agent runs a `web_search` -> `scrape_page` -> `report_results` tool loop, restricted to an allowlist of sites you control.
- **Vision-based listing extraction** — turns photos and captions into structured fields such as make, model, year, price, condition, location and contact.
- **Memory** — listings and past results are stored in SQLite; internal matches are surfaced first and results are de-duplicated against history.
- **Pluggable providers** — swap the AI provider and I/O channels via config, no code changes.
- **Operator controls** — DM the bot `STATUS` for a health check, or `A/B/C` to resolve a pending clarification.
- **Daily reset** — a cron-scheduled session reset keeps each day's run clean.

---

## How it works

```
                  ┌──────────────┐      ┌──────────────┐
  WhatsApp  ─────▶│              │      │              │
  Telegram  ─────▶│  Listeners   │─────▶│  Classifier  │  requirement / listing /
                  │ (group msgs) │      │    (LLM)     │  irrelevant / unclear
                  └──────────────┘      └──────┬───────┘
                                               │
                 ┌─────────────────────────────┼─────────────────────────────┐
                 ▼                             ▼                              ▼
        ┌─────────────────┐          ┌──────────────────┐           ┌────────────────┐
        │   LISTING       │          │   REQUIREMENT    │           │  NEEDS CLARITY │
        │  vision extract │          │  agentic search  │           │  ask operator  │
        │  → structured   │          │  loop:           │           │   (A/B/C)      │
        │    record       │          │  • internal DB   │           └────────────────┘
        └────────┬────────┘          │  • web_search    │
                 │                   │  • scrape_page   │
                 ▼                   │  • report_results│
        ┌─────────────────┐          └────────┬─────────┘
        │   SQLite store  │◀──────────────────┤  (save + dedupe)
        │  listings /     │                   ▼
        │  requirements / │          ┌──────────────────┐
        │  results        │          │     Outputs      │─────▶  WhatsApp / Telegram
        └─────────────────┘          │  ranked matches  │        (you / a group)
                                      └──────────────────┘
```

1. **Listen** — `WhatsAppListener` (via [Baileys](https://github.com/WhiskeySockets/Baileys)) and/or `TelegramListener` ingest messages (text + images) from allowlisted groups.
2. **Classify** — the configured AI agent labels each message. Text-only listings wait briefly for follow-up photos before being committed.
3. **Act**
   - *Listings* → extracted into a structured record (vision + text) and saved.
   - *Requirements* → queued, then handed to the agent, which checks internal listings first and then searches the allowlisted sites.
4. **Review or reply** — ranked matches are formatted for your chosen output channel. In production deployments, put an operator approval step in front of any public reply.

---

## Quick start

> **Prerequisites:** Node.js 20+, and an API key for your chosen AI provider (or the Claude CLI / a local Ollama install).

```bash
git clone https://github.com/harshwasan/requirement-bot.git
cd requirement-bot
npm install

cp .env.example .env      # then edit .env — see Configuration below
npm run build
npm start
```

**First run / discovery mode.** Start with empty group/output settings and the bot boots in setup mode: it shows a WhatsApp QR code to scan, then prints discovered group identifiers to the logs. Copy only the groups you are allowed to monitor into `.env`, restart, and run a small private test before enabling real outputs.

| Script              | What it does                              |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | Run from TypeScript with `tsx` (no build) |
| `npm run dev:watch` | Same, with auto-reload                    |
| `npm run build`     | Compile to `dist/`                        |
| `npm start`         | Run the compiled build                    |
| `npm test`          | Run the Jest test suite                   |

---

## Configuration

All configuration is via environment variables — see [`.env.example`](.env.example) for the fully commented list. The essentials:

| Variable           | Description                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| `INPUT_SOURCE`     | `whatsapp` · `telegram` · `both` — where to listen                     |
| `OUTPUT_TARGET`    | `whatsapp` · `telegram` · `both` — where to send results               |
| `AI_PROVIDER`      | `claude` · `claude-cli` · `codex` · `ollama`                           |
| `AI_MODEL`         | Model id for the provider (e.g. `claude-opus-4-8`)                     |
| `DOMAIN`           | `used_cars` · `real_estate` · `custom`                                 |
| `SEARCH_SITES`     | Comma-separated allowlist of sites the agent may search                |
| `LOCATION`         | Preferred location for results (e.g. `Demo City`)                      |
| `SEARCH_PRIORITY`  | Ranking preference (e.g. `quality first, then proximity, then price`)  |

Group IDs, output targets, and provider keys are also set here. WhatsApp groups use JIDs (`...@g.us`); Telegram groups use negative chat IDs.

---

## AI providers

The agent is provider-agnostic behind a `BaseAgent` interface — pick whichever fits your cost/latency/privacy needs:

| `AI_PROVIDER` | Backend                          | Notes                                                        |
| ------------- | -------------------------------- | ------------------------------------------------------------ |
| `claude`      | Anthropic API (`@anthropic-ai/sdk`) | Default. Set `ANTHROPIC_API_KEY` + `AI_MODEL`.            |
| `claude-cli`  | Local Claude Code CLI            | Uses a Claude subscription already installed on the machine. |
| `codex`       | OpenAI                           | Set `OPENAI_API_KEY`.                                        |
| `ollama`      | Local open-source models         | Fully offline; set `OLLAMA_BASE_URL` + `OLLAMA_MODEL`.       |

**Model choice.** The default is `claude-opus-4-8` (most capable). For high-volume groups where classification dominates the bill, a cheaper model such as `claude-sonnet-4-6` or `claude-haiku-4-5` is a reasonable trade — set `AI_MODEL` accordingly.

---

## Security

- **Strict site allowlisting.** The agent can only search and scrape hostnames in `SEARCH_SITES`, validated by exact hostname / subdomain match — so `car.attacker.com` can never pass a `car` allowlist.
- **Path-traversal guards** on configurable storage paths (`DB_PATH`, `IMAGES_DIR`).
- **Image size limits** before anything is sent to a vision model.
- **Prompt sanitization** on user-supplied requirement text.
- **Safe Claude CLI default.** Claude permission-bypass flags are disabled unless `REQBOT_ALLOW_CLAUDE_BYPASS=true` is explicitly set in a private trusted sandbox.
- **Secrets stay local.** `.env`, the WhatsApp auth folder, the SQLite DB, images, and logs are all git-ignored — nothing sensitive is committed.
- **Human-review fit.** The safest production pattern is to send ranked matches to an operator first, then let the operator approve, edit or reject any outbound reply.

### Before publishing your fork

- Do not commit `.env`, auth folders, QR images, SQLite databases, downloaded media or logs.
- Replace real group names, phone numbers, chat IDs and locations with placeholders in docs/tests.
- Rotate any key or token that was ever committed, pasted into an issue, or shared in a demo.
- Review output wording so the bot is not presented as sending unsolicited or unapproved messages.

---

## Project structure

```
src/
├── index.ts              # bootstrap: wire listeners → orchestrator → outputs
├── orchestrator.ts       # routing, queueing, clarifications, daily reset
├── config.ts             # env parsing + validation + allowlist helpers
├── agents/               # BaseAgent + claude / claude-cli / codex / ollama
├── classifier/           # message → requirement | listing | irrelevant
├── extractor/            # listing → structured record
├── listeners/            # whatsapp (Baileys) + telegram inputs
├── output/               # whatsapp + telegram result formatting/sending
├── history/              # SQLite store + schema (listings, requirements, results)
├── queue/                # sequential requirement queue
└── tools/                # claude callback host + DB query tools
```

---

## Disclaimer

This project automates searches against third-party websites. Respect each site's Terms of Service, `robots.txt`, privacy expectations, messaging-platform rules and applicable rate limits when configuring `SEARCH_SITES` or chat listeners. Provided as-is under the MIT License for educational and personal-automation use.

---

<p align="center">Built by <a href="https://github.com/harshwasan">Harsh Wasan</a> — automation engineer.</p>
