// ChadGPT voice endpoint, streams speech from the OpenAI Audio API.
//
// POST { text, voice?, speed? } -> audio/mpeg bytes
// GET -> { ok, voices }  (used by the settings panel and the boot screen)

const MODEL = process.env.CHAD_TTS_MODEL || "gpt-4o-mini-tts";
const API_URL = "https://api.openai.com/v1/audio/speech";

const VOICES = ["cedar", "ash", "onyx", "echo", "verse", "marin", "ballad", "alloy", "sage"];
const DEFAULT_VOICE = "cedar";

const INSTRUCTIONS =
  "Deep, confident male voice. Smug, dry, condescending delivery: unhurried, " +
  "faintly amused, like a genius explaining something obvious to someone slow. " +
  "A smirk should be audible. Never cheerful, never customer-service polite.";

const _hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (_hits.get(ip) || []).filter((t) => t > windowStart);
  arr.push(now);
  _hits.set(ip, arr);
  if (_hits.size > 5000) _hits.clear();
  return arr.length > 40;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: !!process.env.OPENAI_API_KEY, voices: VOICES });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  const ip = (req.headers["x-forwarded-for"] || "?").split(",")[0].trim();
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "Chad's voice needs a breather. Slow down." });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: "OPENAI_API_KEY not configured" });
  }

  const body = req.body || {};
  const text = String(body.text == null ? "" : body.text).slice(0, 600).trim();
  if (!text) return res.status(400).json({ error: "No text" });
  const voice = VOICES.includes(body.voice) ? body.voice : DEFAULT_VOICE;
  let speed = Number(body.speed) || 1.0;
  speed = Math.min(1.5, Math.max(0.5, speed));

  const upstream = await fetch(API_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      voice,
      input: text,
      instructions: INSTRUCTIONS,
      response_format: "mp3",
      speed,
    }),
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error("openai tts error", upstream.status, detail.slice(0, 500));
    return res.status(502).json({ error: "Chad's voice box is offline." });
  }

  res.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "no-store",
  });
  try {
    for await (const chunk of upstream.body) {
      res.write(Buffer.from(chunk));
    }
  } catch (e) {
    console.error("tts stream aborted", e.message);
  }
  res.end();
}
