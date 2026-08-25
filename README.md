# ChadGPT

Comprehensively Horrible Advice Dispenser. A CRT-terminal chatbot with a comedically
unhelpful sigma-bro persona, streaming voice, idle taunts, and a rotary-dial phone mode.

Live at [chadgpt.joshuakappler.com](https://chadgpt.joshuakappler.com).

- Static frontend in `public/`, one serverless function in `api/chat.js` (zero deps)
- LLM: Anthropic Messages API, streamed (`ANTHROPIC_API_KEY`, optional `CHAD_MODEL`)
- Voice: browser `speechSynthesis`, per-sentence while streaming
- Voice *input* (mic / call mode) needs a browser with the Web Speech recognition API
  (Chrome/Edge — not Firefox)

Local dev: `vercel dev`.
