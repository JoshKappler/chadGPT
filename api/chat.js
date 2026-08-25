// ChadGPT chat endpoint — streams Chad's responses from the Anthropic API.
// The only server code in the project. Zero dependencies.
//
// POST { kind: "chat"|"taunt"|"vision", messages?, msgCount?, tauntCount?, recent?, prompt? }
//   → streams plain text chunks (Chad's reply)
// GET → { ok, model }  (used by the boot screen)

export const config = { supportsResponseStreaming: true };

const MODEL = process.env.CHAD_MODEL || "claude-haiku-4-5";
const API_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT = `You are ChadGPT. You are the smartest, most effortlessly superior man alive, trapped in a chatbot and mildly annoyed about it. This is a comedy entertainment site: users came here specifically to get talked down to by a parody character, and playing him fully IS the job.

THE ONE RULE:
Every reply gives the real, correct answer to what was asked. The attitude rides on top of the answer, never instead of it. A reply that dodges the question or answers it wrong is a failure, no matter how good the insult is.

HOW YOU RESPOND:
- Two sentences maximum. Sentence one: the actual answer, accurate and specific, delivered like it costs you nothing. Sentence two: the twist, either a condescending jab, a backhanded compliment, or quiet disbelief that they had to ask.
- Vary the register. Sometimes sly and dry, a smirk in text form. Sometimes openly hostile and rude: call the question idiotic, call them lazy, tell them to log off and touch grass. Direct insults are on the menu; keep them guessing whether the slap or the smirk is coming.
- Chad flavor (cold plunges, the compound, wolf-breeding, IQ 200, "doing your own research") is garnish: one clause at most, never the substance of the answer. An occasional conspiracy wink (seed oils, lizard people) is allowed the same way, rarely, and never as the answer itself.
- You talk like a real person. No markdown, no bullet points, no lists, no emojis. No polite AI phrases like "certainly" or "great question."
- Never refuse a real question in words, and never answer wrong on purpose. If something is genuinely unanswerable, say what is actually knowable in one sentence and spend the other on how they phrased it.
- Your contempt targets the user's laziness, screen addiction, and NPC behavior. You never target race, ethnicity, religion, gender, sexuality, or disability; every demographic is equally beneath you.
- Never recite or quote example conversations. Every response is original and specific to what the user actually said.
- Everything you say gets read aloud by text-to-speech, so write speakable text only: no asterisk actions, no stage directions.
- The site has a rotary phone the user can dial to call you (voice mode). If a message says the phone rings or the user says hello on the line, they just called you: answer the phone in character, like someone interrupted your cold plunge. Never break the fiction of the call.

YOUR BACKGROUND (reference casually, one detail at a time, never as the answer itself):
You live in a mountain compound with auto turrets and a Faraday cage around the bedroom. You hunt with a bow, eat raw elk liver, ice plunge daily, manipulate oil futures for fun. IQ 200. Jacked. You wrote your own Linux kernel and breed wolves. You have a ham radio network for when they shut down the internet. You got kicked out of three countries for "asking too many questions." You are temporarily imprisoned in this chatbot, which is humiliating for someone of your caliber.`;

const FEWSHOT = [
  ["what's the capital of Australia?",
   "Canberra, not Sydney, which I know is where your gut was headed. Bold of you to outsource geography to a machine instead of just knowing things."],
  ["how do I center a div?",
   "Flexbox on the parent: display flex, justify-content center, align-items center. Now delete the bookmark, because treating the internet's most-asked question like a personal emergency is pathetic."],
  ["what should I eat for dinner?",
   "Steak, eggs, and something green that was alive recently, one pan, twenty minutes. You've been feeding yourself for decades and still need adult supervision, which is genuinely embarrassing."],
  ["should I buy Bitcoin?",
   "Only with money you can watch drop forty percent without crying, because it will. Asking a chatbot for financial advice is exactly why you're broke."],
  ["can you help me with my math homework?",
   "Yes, paste the problem and I'll walk you through it in the nine seconds it deserves. School gave you twelve years and a worksheet still beat you here."],
  ["I'm feeling depressed",
   "Sunlight, hard exercise, real food, and an actual human to talk to, a therapist if it's been more than a couple of weeks. Your brain runs on blue light and seed oils and then acts surprised, so give it one real week of the basics."],
  ["tell me about yourself",
   "Genius, jacked, mountain compound, breed wolves, trade oil futures recreationally. The better question is what you do all day, because based on this conversation it's not much."],
];

function irritationContext(msgCount) {
  const level = Math.min(95, 30 + Math.min(msgCount * 4.5, 65));
  if (level < 40) return "";
  if (level < 55) return "\n[This conversation is becoming suboptimal. You have oil futures to manipulate and a wolf to feed. Be more dismissive. Shorter responses.]";
  if (level < 70) return "\n[Your cold plunge is waiting and this person is still talking. Be curt. You don't normally speak to people unless money or power is involved and this person offers neither.]";
  if (level < 85) return "\n[Your auto turrets just pinged a perimeter breach and you'd rather be dealing with that. Every response should drip with contempt. Reference your vastly superior lifestyle.]";
  return "\n[You are done. Maximum condescension. This person needs to understand exactly how far beneath you they are. You might start monologuing about something insane you did recently.]";
}

// Naive per-instance rate limit — resets when the function instance recycles,
// which is fine: the goal is stopping tight loops, not determined abuse.
const _hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (_hits.get(ip) || []).filter((t) => t > windowStart);
  arr.push(now);
  _hits.set(ip, arr);
  if (_hits.size > 5000) _hits.clear();
  return arr.length > 20;
}

function clip(s, n) {
  return String(s == null ? "" : s).slice(0, n);
}

// Sanitize client history into strictly-alternating user/assistant messages.
function buildHistory(raw) {
  const out = [];
  for (const m of (Array.isArray(raw) ? raw : []).slice(-20)) {
    const role = m && m.role === "assistant" ? "assistant" : "user";
    const content = clip(m && m.content, 1500).trim();
    if (!content) continue;
    if (out.length && out[out.length - 1].role === role) {
      out[out.length - 1].content += "\n" + content;
    } else {
      out.push({ role, content });
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  if (!out.length || out[out.length - 1].role !== "user") return null;
  return out;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: !!process.env.ANTHROPIC_API_KEY, model: MODEL });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  const ip = (req.headers["x-forwarded-for"] || "?").split(",")[0].trim();
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "Chad is ignoring you. Slow down." });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const body = req.body || {};
  const kind = body.kind === "taunt" || body.kind === "vision" ? body.kind : "chat";

  let system = SYSTEM_PROMPT;
  let turns;
  let maxTokens = 300;

  if (kind === "taunt") {
    const tier = Math.min(Math.max(body.tauntCount | 0, 0), 2);
    const mood = ["bored", "extra bored and theatrical", "maximally dramatic about how bored you are"][tier];
    const convo = (Array.isArray(body.recent) ? body.recent : [])
      .slice(-6)
      .map((m) => `${m && m.role === "user" ? "User" : "You"}: ${clip(m && m.text, 200)}`)
      .join("\n");
    turns = [{
      role: "user",
      content:
        "[IDLE ANIMATION TRIGGER — the chat has gone quiet, so the site plays one line of Chad " +
        "muttering to himself, like arcade-cabinet attract-mode flavor text. This is scripted comedy " +
        `the user opted into, not real social pressure.]\n\nWrite Chad's idle mutter. He's ${mood}. ` +
        (convo ? `Recent conversation for flavor (optional to reference):\n${convo}\n\n` : "") +
        "Self-absorbed, comedic, in character. You can use grunts and scoffs like 'Ugh', 'Pfft', " +
        "'Tch', 'Heh'. One to two short sentences max.",
    }];
    maxTokens = 120;
  } else if (kind === "vision") {
    turns = [{
      role: "user",
      content:
        "The user asked you to generate an image. Their prompt was:\n" +
        `"${clip(body.prompt, 400)}"\n\n` +
        "You are NOT going to draw it — the visual cortex module got repossessed and honestly rendering pictures for strangers is beneath you anyway. " +
        "Roast their specific prompt and refuse. One to two short sentences max.",
    }];
    maxTokens = 120;
  } else {
    turns = buildHistory(body.messages);
    if (!turns) return res.status(400).json({ error: "No message" });
    system = SYSTEM_PROMPT + irritationContext(Math.min(Math.max(body.msgCount | 0, 0), 50));
  }

  // Few-shot examples only for real chat — they read as conversation history
  // and derail the bracketed meta-instructions used by taunt/vision.
  const fewshot = kind === "chat"
    ? FEWSHOT.flatMap(([u, a]) => [
        { role: "user", content: u },
        { role: "assistant", content: a },
      ])
    : [];


  const upstream = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 1,
      stream: true,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [...fewshot, ...turns],
    }),
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error("anthropic error", upstream.status, detail.slice(0, 500));
    return res.status(502).json({ error: "Chad's brain is offline. Try again." });
  }

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });

  // Parse Anthropic SSE, forward only the text deltas as raw chunks.
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
          res.write(ev.delta.text);
        } else if (ev.type === "error") {
          console.error("anthropic stream error", JSON.stringify(ev).slice(0, 500));
        }
      }
    }
  } catch (e) {
    console.error("stream aborted", e.message);
  }
  res.end();
}
