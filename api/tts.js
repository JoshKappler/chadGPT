// ChadGPT voice endpoint: ElevenLabs only, no fallbacks, failures are loud.
//
// POST { text, voice? } -> audio/mpeg bytes, or 4xx/5xx JSON with the reason
// GET -> { ok, backend, model, voices } | { ok: false, error }
//
// v3 Conversational at stability 0 (Creative): the same expressive v3
// family Josh approved for Matthew Schmitz, on the low-latency tier
// (measured ~40% faster than plain eleven_v3 on the same text).

const EL_MODEL = process.env.CHAD_TTS_MODEL || "eleven_v3_conversational";
const EL_VOICE_ID = process.env.CHAD_TTS_VOICE || "bwCXcoVxWNYMlC6Esa8u";
const EL_SETTINGS = { stability: 0.0 };

let _elVoices = null; // [{name, id}], cached per instance

async function elVoiceList(key) {
  if (_elVoices) return _elVoices;
  const r = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": key },
  });
  if (!r.ok) throw new Error("voices list " + r.status);
  const j = await r.json();
  _elVoices = (j.voices || []).map((v) => ({ name: v.name, id: v.voice_id }));
  return _elVoices;
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

async function upstreamError(upstream) {
  const t = await upstream.text().catch(() => "");
  let detail = t.slice(0, 200);
  try { detail = JSON.stringify(JSON.parse(t).detail).slice(0, 200); } catch {}
  console.error("elevenlabs error", upstream.status, detail);
  return "elevenlabs " + upstream.status + ": " + detail;
}

export default async function handler(req, res) {
  const key = process.env.ELEVENLABS_API_KEY;

  if (req.method === "GET") {
    if (!key) return res.status(200).json({ ok: false, backend: "elevenlabs", error: "ELEVENLABS_API_KEY missing", voices: [] });
    try {
      const voices = await elVoiceList(key);
      return res.status(200).json({ ok: true, backend: "elevenlabs", model: EL_MODEL, voices: voices.map((v) => ({ name: v.name, lang: "neural" })) });
    } catch (e) {
      return res.status(200).json({ ok: false, backend: "elevenlabs", error: e.message, voices: [] });
    }
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  const ip = (req.headers["x-forwarded-for"] || "?").split(",")[0].trim();
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "Chad's voice needs a breather. Slow down." });
  }
  if (!key) {
    return res.status(503).json({ error: "ELEVENLABS_API_KEY not configured" });
  }

  const body = req.body || {};
  const text = String(body.text == null ? "" : body.text).slice(0, 900).trim();
  if (!text) return res.status(400).json({ error: "No text" });

  // Default voice is a known id; a named pick from the dropdown is resolved
  // against the account list and unknown names are a hard 400.
  let voiceId = EL_VOICE_ID;
  if (body.voice) {
    const list = await elVoiceList(key).catch(() => []);
    const hit = list.find((v) => v.name.toLowerCase() === String(body.voice).toLowerCase() || v.id === body.voice);
    if (!hit) return res.status(400).json({ error: "Unknown voice: " + String(body.voice).slice(0, 60) });
    voiceId = hit.id;
  }

  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: EL_MODEL,
        voice_settings: EL_SETTINGS,
      }),
    }
  );
  if (!upstream.ok) {
    return res.status(502).json({ error: await upstreamError(upstream) });
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
