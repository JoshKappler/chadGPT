# ChadGPT

A chatbot that answers every question correctly and insults you for asking.
Live at [chadgpt-seven.vercel.app](https://chadgpt-seven.vercel.app).

## How it works

- The avatar redraws the GigaChad photo on a canvas as green phosphor with
  Sobel edge contours. Voice amplitude warps the jaw region so his mouth
  moves while he talks, and the head tracks the mouse with parallax.
- A fullscreen WebGL shader lays CRT glass over the whole page: scanlines,
  a phosphor dot grid, vignette, and interlace shimmer.
- `api/chat.js` streams replies from the Anthropic Messages API
  (`claude-haiku-4-5` by default). An irritation counter climbs with every
  message and feeds grumpier context into the system prompt as the
  conversation drags on.
- Each sentence goes to ElevenLabs through `api/tts.js` while the reply is
  still streaming, so speech generation overlaps playback. There's no
  fallback voice; a synthesis failure prints in the chat feed.
- Dial 666-CHAD on the rotary phone for a voice call. Mic input uses the
  browser's Web Speech recognition API (Chrome and Edge, not Firefox).
- Leave the chat idle and he mutters to himself. The taunts are generated
  from the recent conversation, arcade attract-mode style.

## Run it

Static frontend in `public/`, serverless functions in `api/`, zero
dependencies. Needs `ANTHROPIC_API_KEY` and `ELEVENLABS_API_KEY`.

```
vercel dev
```
