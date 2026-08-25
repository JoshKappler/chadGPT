// ChadGPT voice endpoint. Primary backend: ElevenLabs (gravelly, chaotic
// settings) when ELEVENLABS_API_KEY is set; falls back to OpenAI speech.
//
// POST { text, voice?, speed? } -> audio/mpeg bytes
// GET -> { ok, backend, voices }  (settings panel + boot screen)

// Multilingual v2: highest similarity for professional voice clones.
// No voice_settings override: the API then uses the voice's own stored
// settings, which is what the website preview plays.
const EL_MODEL = process.env.CHAD_TTS_MODEL || "eleven_multilingual_v2";
// Josh's pick from the ElevenLabs voice library
const EL_VOICE = process.env.CHAD_TTS_VOICE || "bwCXcoVxWNYMlC6Esa8u";

const OPENAI_MODEL = "gpt-4o-mini-tts";
const OPENAI_VOICES = ["ash", "cedar", "onyx", "echo", "verse", "marin", "ballad", "alloy", "sage"];
const OPENAI_INSTRUCTIONS =
  "Very deep, gravelly male voice, low-pitched and resonant, with a rough texture. " +
  "Smug, dry, condescending delivery: unhurried, faintly amused, like a genius " +
  "explaining something obvious to someone slow. A smirk should be audible. " +
  "Never cheerful, never customer-service polite.";

let _elVoices = null; // [{name, id}], cached per instance

async function elVoiceList() {
  if (_elVoices) return _elVoices;
  const r = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
  });
  if (!r.ok) return [];
  const j = await r.json().catch(() => null);
  _elVoices = (j && j.voices ? j.voices : []).map((v) => ({ name: v.name, id: v.voice_id }));
  return _elVoices;
}

async function elResolveVoice(name) {
  const list = await elVoiceList();
  const hit = list.find((v) => v.name.toLowerCase() === String(name).toLowerCase());
  if (hit) return hit.id;
  const dflt = list.find((v) => v.name.toLowerCase() === EL_VOICE.toLowerCase());
  return dflt ? dflt.id : (list[0] && list[0].id);
}

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

async function pipeAudio(upstream, res) {
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error("tts upstream error", upstream.status, detail.slice(0, 500));
    res.status(502).json({ error: "Chad's voice box is offline." });
    return;
  }
  res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
  try {
    for await (const chunk of upstream.body) {
      res.write(Buffer.from(chunk));
    }
  } catch (e) {
    console.error("tts stream aborted", e.message);
  }
  res.end();
}

export default async function handler(req, res) {
  const elKey = process.env.ELEVENLABS_API_KEY;
  const oaKey = process.env.OPENAI_API_KEY;

  if (req.method === "GET") {
    if (elKey) {
      const voices = await elVoiceList().catch(() => []);
      return res.status(200).json({ ok: true, backend: "elevenlabs", voices: voices.map((v) => ({ name: v.name, lang: "neural" })) });
    }
    if (oaKey) {
      return res.status(200).json({ ok: true, backend: "openai", voices: OPENAI_VOICES.map((n) => ({ name: n, lang: "neural" })) });
    }
    return res.status(200).json({ ok: false, backend: null, voices: [] });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  const ip = (req.headers["x-forwarded-for"] || "?").split(",")[0].trim();
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "Chad's voice needs a breather. Slow down." });
  }
  if (!elKey && !oaKey) {
    return res.status(503).json({ error: "No TTS key configured" });
  }

  const body = req.body || {};
  const text = String(body.text == null ? "" : body.text).slice(0, 600).trim();
  if (!text) return res.status(400).json({ error: "No text" });
  let speed = Number(body.speed) || 1.0;
  speed = Math.min(1.5, Math.max(0.5, speed));

  if (elKey) {
    const voiceId = await elResolveVoice(body.voice || EL_VOICE).catch(() => null);
    if (voiceId) {
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { "xi-api-key": elKey, "content-type": "application/json" },
          body: JSON.stringify({
            text,
            model_id: EL_MODEL,
          }),
        }
      );
      if (upstream.ok) return pipeAudio(upstream, res);
      const detail = await upstream.text().catch(() => "");
      console.error("elevenlabs error, falling back", upstream.status, detail.slice(0, 300));
    }
  }

  if (!oaKey) return res.status(502).json({ error: "Chad's voice box is offline." });
  const voice = OPENAI_VOICES.includes(body.voice) ? body.voice : "ash";
  const upstream = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      authorization: `Bearer ${oaKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      voice,
      input: text,
      instructions: OPENAI_INSTRUCTIONS,
      response_format: "mp3",
      speed,
    }),
  });
  return pipeAudio(upstream, res);
}
