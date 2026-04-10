import asyncio
import importlib.metadata
import json
import logging
import os
import sys

# Auto-activate venv if server is run outside it
_venv_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "venv")
_venv_python = os.path.join(_venv_path, "bin", "python")
if os.path.exists(_venv_python) and sys.prefix == sys.base_prefix:
    os.execv(_venv_python, [_venv_python] + sys.argv)
import platform
import random
import re
import resource
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from starlette.responses import Response
from fastapi.staticfiles import StaticFiles

app = FastAPI()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("chadgpt")

import warnings
warnings.filterwarnings("ignore")
logging.getLogger("parler_tts").setLevel(logging.ERROR)
logging.getLogger("transformers").setLevel(logging.ERROR)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("huggingface_hub").setLevel(logging.ERROR)
logging.getLogger("huggingface_hub.utils._http").setLevel(logging.ERROR)
# Suppress mlx/tokenizer noisy warnings
os.environ["TOKENIZERS_PARALLELISM"] = "false"

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
AUDIO_DIR = Path(tempfile.mkdtemp(prefix="chadgpt_audio_"))
AUDIO_MAX_AGE_S = 300  # clean up audio files older than 5 minutes

# Active model — read from Modelfile on startup, updated by /api/model/switch
def _read_model_from_file():
    try:
        line = Path("Modelfile").read_text().split("\n")[0]
        return line.replace("FROM ", "").strip() if line.startswith("FROM ") else "openhermes:latest"
    except Exception:
        return "openhermes:latest"

_active_model = _read_model_from_file()

# System prompt — injected as first message in every chat (not baked into Ollama model)
try:
    _modelfile_text = Path("Modelfile").read_text()
    SYSTEM_PROMPT = _modelfile_text.split('SYSTEM """')[1].split('"""')[0].strip() if 'SYSTEM """' in _modelfile_text else ""
except Exception:
    SYSTEM_PROMPT = ""

# Few-shot examples from MESSAGE directives — injected after system prompt, before user conversation
def _parse_fewshot_messages():
    """Parse MESSAGE user/assistant lines from Modelfile into chat messages."""
    examples = []
    try:
        for line in Path("Modelfile").read_text().split("\n"):
            line = line.strip()
            if line.startswith("MESSAGE user "):
                examples.append({"role": "user", "content": line[len("MESSAGE user "):]})
            elif line.startswith("MESSAGE assistant "):
                examples.append({"role": "assistant", "content": line[len("MESSAGE assistant "):]})
    except Exception:
        pass
    return examples

FEWSHOT_MESSAGES = _parse_fewshot_messages()

# Ollama generation options from Modelfile
_MODEL_OPTIONS = {
    "temperature": 0.8,
    "top_p": 0.9,
    "top_k": 40,
    "repeat_penalty": 1.2,
    "num_predict": -1,   # no limit — let the model finish naturally
    "num_ctx": 32768,    # full context window — 24B Venice supports 32k
}
IMAGE_DIR = Path(tempfile.mkdtemp(prefix="chadgpt_images_"))

# Store background task references so they don't get garbage-collected
_background_tasks: set = set()

# Real metrics tracking
_metrics = {
    "start_time": time.time(),
    "request_count": 0,
    "total_latency_ms": 0,
    "active_connections": 0,
}

# ============ TTS BACKENDS ============

from tts_backends import KokoroBackend, Qwen3TTSBackend, SayFallback

kokoro = KokoroBackend()
qwen3 = Qwen3TTSBackend()
say_fallback = SayFallback()

VOICE_CONFIG_FILE = Path("voice_config.json")

_voice_config_defaults = {
    "engine": "qwen3",
    "voice": "am_michael",
    "speed": 1.15,
    "angry_speed": 1.1,
    "lang_code": "a",
    "chaos": 60,
    "custom_instruct": "",
    "qwen3_speaker": "ryan",
    "pitch_shift": 8,
    "temperature": 0.85,
    "echo_delay": 90,
    "echo_decay": 0.30,
    "echo_taps": 3,
    "cfg_scale": None,
    "ref_audio": "",
    "ref_text": "",
}

def _load_voice_config() -> dict:
    """Load saved voice config from disk, falling back to defaults."""
    cfg = dict(_voice_config_defaults)
    if VOICE_CONFIG_FILE.exists():
        try:
            saved = json.loads(VOICE_CONFIG_FILE.read_text())
            cfg.update(saved)
            logger.info(f"Loaded voice config from {VOICE_CONFIG_FILE}")
        except Exception as e:
            logger.warning(f"Failed to load voice config: {e}")
    return cfg

def _save_voice_config():
    """Persist current voice config to disk."""
    try:
        VOICE_CONFIG_FILE.write_text(json.dumps(voice_config, indent=2, default=str))
        logger.info(f"Saved voice config to {VOICE_CONFIG_FILE}")
    except Exception as e:
        logger.warning(f"Failed to save voice config: {e}")

voice_config = _load_voice_config()

_tts_init_lock = threading.Lock()
_tts_qwen3_initializing = False
_tts_kokoro_initializing = False

def init_tts_kokoro():
    """Load Kokoro as fallback (guarded against concurrent calls)."""
    global _tts_kokoro_initializing
    with _tts_init_lock:
        if kokoro.ready or _tts_kokoro_initializing:
            return
        _tts_kokoro_initializing = True
        try:
            kokoro.init(lang_code=voice_config["lang_code"])
        finally:
            _tts_kokoro_initializing = False


def init_tts_qwen3():
    """Load Qwen3-TTS (guarded against concurrent calls — Metal GPU crashes on double-init)."""
    global _tts_qwen3_initializing
    with _tts_init_lock:
        if qwen3.ready or _tts_qwen3_initializing:
            return
        _tts_qwen3_initializing = True
        try:
            qwen3.init()
        finally:
            _tts_qwen3_initializing = False


def synthesize_speech(text: str, output_path: str, angry: bool = False) -> bool:
    """Generate speech with the configured engine."""
    # No text truncation — let TTS handle the full response
    # Strip *actions*, markdown, emojis, and special chars that confuse TTS
    text = re.sub(r'\*[^*]+\*', '', text)  # remove *action text*
    text = text.replace('#', '').replace('`', '').replace('_', ' ')
    text = re.sub(r'[\U0001f600-\U0001f9ff\U00002700-\U000027bf\U0000fe00-\U0000fe0f\U0001fa00-\U0001faff]', '', text)
    text = text.strip()
    engine = voice_config.get("engine", "qwen3")

    # Try primary engine (with one retry)
    if engine == "qwen3" and qwen3.ready:
        ok = qwen3.synthesize(text, output_path, voice_config, angry)
        if ok:
            return True
        # Retry once — Qwen3 can be flaky
        logger.warning("Qwen3 failed on first attempt, retrying...")
        ok = qwen3.synthesize(text, output_path, voice_config, angry)
        if ok:
            return True
        logger.warning("Qwen3 failed twice, falling back to Kokoro (VOICE WILL SOUND DIFFERENT)")

    # Try Kokoro fallback — apply same pitch/echo so it doesn't sound totally different
    if kokoro.ready:
        ok = kokoro.synthesize(text, output_path, voice_config, angry)
        if ok:
            return True

    # Last resort: macOS say
    return say_fallback.synthesize(text, output_path, voice_config, angry)


def synthesize_speech_sentence(text: str, output_path: str, angry: bool = False) -> bool:
    """Synthesize a single sentence with post-processing. For streaming TTS."""
    text = re.sub(r'\*[^*]+\*', '', text)
    text = text.replace('#', '').replace('`', '').replace('_', ' ')
    text = re.sub(r'[\U0001f600-\U0001f9ff\U00002700-\U000027bf\U0000fe00-\U0000fe0f\U0001fa00-\U0001faff]', '', text)
    text = text.strip()
    if not text:
        return False
    engine = voice_config.get("engine", "qwen3")

    if engine == "qwen3" and qwen3.ready:
        ok = qwen3.synthesize_sentence(text, output_path, voice_config, angry)
        if ok:
            return True
        # Retry once
        ok = qwen3.synthesize_sentence(text, output_path, voice_config, angry)
        if ok:
            return True

    # Fallbacks use their normal synthesize (already handles single sentences fine)
    if kokoro.ready:
        ok = kokoro.synthesize(text, output_path, voice_config, angry)
        if ok:
            return True

    return say_fallback.synthesize(text, output_path, voice_config, angry)


# ============ IMAGE GENERATION ============

IMAGE_MODELS = {
    "shittiest": {
        "id": "nota-ai/bk-sdm-tiny",
        "steps": 8,
        "guidance": 5.0,
        "label": "bk-sdm-tiny",
    },
    "shittier": {
        "id": "nota-ai/bk-sdm-small",
        "steps": 12,
        "guidance": 7.0,
        "label": "bk-sdm-small",
    },
    "shit": {
        "id": "nota-ai/bk-sdm-base",
        "steps": 15,
        "guidance": 7.0,
        "label": "bk-sdm-base",
    },
}

image_pipes = {}  # quality -> pipeline
image_device = None
image_quality = "shittier"  # default
_image_progress = {"step": 0, "total": 0, "active": False}  # live progress for frontend polling


def init_image_gen(quality: str = None):
    """Lazy-load a diffusion model for the given quality tier."""
    global image_device
    if quality is None:
        quality = image_quality
    if quality in image_pipes:
        return True
    spec = IMAGE_MODELS.get(quality)
    if not spec:
        return False
    try:
        import torch
        from diffusers import StableDiffusionPipeline, EulerDiscreteScheduler

        model_id = spec["id"]
        logger.info(f"Image gen: loading {model_id}...")
        scheduler = EulerDiscreteScheduler.from_pretrained(
            model_id, subfolder="scheduler"
        )
        if image_device is None:
            image_device = "mps" if torch.backends.mps.is_available() else "cpu"

        pipe = StableDiffusionPipeline.from_pretrained(
            model_id,
            scheduler=scheduler,
            torch_dtype=torch.float32,
            safety_checker=None,
            feature_extractor=None,
            requires_safety_checker=False,
        ).to(image_device)

        # Belt-and-suspenders: forcibly remove any residual safety checking
        pipe.safety_checker = None
        pipe.requires_safety_checker = False
        if hasattr(pipe, 'feature_extractor'):
            pipe.feature_extractor = None

        image_pipes[quality] = pipe
        logger.info(f"Image gen: {spec['label']} loaded on {image_device}")
        return True
    except Exception as e:
        logger.error(f"Image gen init failed ({quality}): {e}")
        return False


def generate_image(prompt: str, quality: str = None) -> str | None:
    """Generate a 256x256 image, upscale with nearest-neighbor."""
    if quality is None:
        quality = image_quality
    spec = IMAGE_MODELS.get(quality)
    if not spec:
        return None
    if quality not in image_pipes:
        if not init_image_gen(quality):
            return None
    pipe = image_pipes[quality]
    try:
        import torch
        from PIL import Image

        image_id = str(uuid.uuid4())
        image_path = IMAGE_DIR / f"{image_id}.png"

        gen_size = spec.get("size", 256)
        total_steps = spec["steps"]

        def _progress_cb(pipe_obj, step, timestep, kwargs):
            _image_progress["step"] = step + 1
            _image_progress["total"] = total_steps
            return kwargs

        _image_progress["step"] = 0
        _image_progress["total"] = total_steps
        _image_progress["active"] = True

        try:
            with torch.no_grad():
                result = pipe(
                    prompt,
                    num_inference_steps=total_steps,
                    guidance_scale=spec["guidance"],
                    height=gen_size,
                    width=gen_size,
                    callback_on_step_end=_progress_cb,
                )
        finally:
            _image_progress["active"] = False

        img = result.images[0]

        # Detect if safety checker blanked the image (all-black output)
        import numpy as np
        arr = np.array(img)
        if arr.mean() < 5:
            logger.warning(f"Black image detected (mean pixel {arr.mean():.1f}) for: {prompt[:60]} — likely residual NSFW filter")
            # Re-run with the safety checker forcibly removed at runtime
            pipe.safety_checker = None
            with torch.no_grad():
                result = pipe(
                    prompt,
                    num_inference_steps=spec["steps"],
                    guidance_scale=spec["guidance"],
                    height=gen_size,
                    width=gen_size,
                )
            img = result.images[0]
        # Upscale to 512x512 with nearest-neighbor for chunky pixel look
        if gen_size < 512:
            img = img.resize((512, 512), Image.NEAREST)
        img.save(str(image_path))
        logger.info(f"Image generated ({spec['label']}): {image_id}")
        return image_id
    except Exception as e:
        logger.error(f"Image gen error: {e}")
        return None


# Disable caching for all responses during development
@app.middleware("http")
async def no_cache_middleware(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

# Serve static files
app.mount("/static", StaticFiles(directory="static"), name="static")


# Cache buster: timestamp set once at server start, changes on every restart
_CACHE_BUSTER = str(int(time.time()))

@app.get("/")
async def index():
    from fastapi.responses import HTMLResponse
    html = Path("static/index.html").read_text()
    # Replace version params so browser fetches fresh assets after restart
    html = re.sub(r'\?v=\d+', f'?v={_CACHE_BUSTER}', html)
    return HTMLResponse(content=html, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})


@app.get("/test3d")
async def test3d():
    """Diagnostic: step-by-step Three.js test."""
    html = """<!DOCTYPE html>
<html><head></head>
<body style="margin:0;background:#000;color:lime;font-family:monospace;padding:20px">
<h2 style="color:lime">ChadGPT 3D Diagnostic</h2>
<div id="c" style="width:500px;height:500px;border:2px solid lime;margin:10px 0"></div>
<pre id="log" style="font-size:16px;line-height:1.6"></pre>
<script>
const L = msg => { document.getElementById('log').textContent += msg + '\\n'; };

// Step 1: Check WebGL
try {
    const testCanvas = document.createElement('canvas');
    const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
    L(gl ? '✓ WebGL supported' : '✗ WebGL NOT supported — this is the problem');
    if (!gl) throw new Error('No WebGL');
} catch(e) { L('✗ WebGL check failed: ' + e.message); }

// Step 2: Load Three.js dynamically so we can catch errors
const s1 = document.createElement('script');
s1.src = '/static/three.min.js';
s1.onload = () => {
    L('✓ Three.js loaded (r' + THREE.REVISION + ')');

    // Step 3: Load GLTFLoader
    const s2 = document.createElement('script');
    s2.src = '/static/GLTFLoader.js';
    s2.onload = () => {
        L('✓ GLTFLoader loaded');
        startTest();
    };
    s2.onerror = (e) => L('✗ GLTFLoader FAILED to load');
    document.head.appendChild(s2);
};
s1.onerror = (e) => L('✗ Three.js FAILED to load');
document.head.appendChild(s1);

function startTest() {
    // Step 4: Create renderer
    try {
        const el = document.getElementById('c');
        const scene = new THREE.Scene();
        const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 500);
        cam.position.set(0, 0, 8);
        const renderer = new THREE.WebGLRenderer({alpha:false, antialias:true});
        renderer.setSize(500, 500);
        renderer.setClearColor(0x050505);
        el.appendChild(renderer.domElement);
        L('✓ WebGL renderer created');

        // Step 5: Add a test cube first to prove rendering works
        scene.add(new THREE.AmbientLight(0xffffff, 0.3));
        const dl = new THREE.DirectionalLight(0x00ff41, 2.0);
        dl.position.set(-3, 5, 8);
        scene.add(dl);

        const testGeo = new THREE.BoxGeometry(1, 1, 1);
        const testMat = new THREE.MeshPhongMaterial({color: 0x00ff41, emissive: 0x003300});
        const testCube = new THREE.Mesh(testGeo, testMat);
        scene.add(testCube);
        renderer.render(scene, cam);
        L('✓ Test cube rendered (you should see a green cube)');

        // Step 6: Load the GLB
        L('  Loading head.glb (4.7MB)...');
        const group = new THREE.Group();
        scene.add(group);

        new THREE.GLTFLoader().load('/static/head.glb',
            (gltf) => {
                // Remove test cube
                scene.remove(testCube);

                L('✓ GLB loaded, children: ' + gltf.scene.children.length);
                const model = gltf.scene;
                const mat = new THREE.MeshPhongMaterial({
                    color: 0x00aa2a, emissive: 0x002200, specular: 0x44ff66,
                    shininess: 90, transparent: true, opacity: 0.85, side: THREE.DoubleSide
                });
                let mc = 0;
                model.traverse(n => {
                    if (n.isMesh) { n.geometry.computeVertexNormals(); n.material = mat.clone(); mc++; }
                });
                L('✓ ' + mc + ' meshes processed');

                group.add(model);
                const box = new THREE.Box3().setFromObject(model);
                const center = box.getCenter(new THREE.Vector3());
                const size = box.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z);
                L('  Model size: ' + size.x.toFixed(1) + ' x ' + size.y.toFixed(1) + ' x ' + size.z.toFixed(1));

                const s = 5 / maxDim;
                group.scale.set(s, s, s);
                model.position.set(-center.x, -center.y + size.y * 0.08, -center.z);
                cam.position.set(0, 0, 7.5);
                cam.lookAt(0, 0, 0);
                cam.updateProjectionMatrix();
                L('✓ Model positioned, scale=' + s.toFixed(4));
                L('');
                L('If you see the David head above → Three.js works fine');
                L('If you see a green cube → GLB load failed silently');
                L('If you see nothing → rendering pipeline broken');
            },
            (xhr) => {
                if (xhr.total > 0 && xhr.loaded === xhr.total) L('  Download complete');
            },
            (err) => {
                L('✗ GLB load ERROR: ' + (err.message || JSON.stringify(err)));
            }
        );

        // Animate
        function anim() {
            requestAnimationFrame(anim);
            group.rotation.y = Math.sin(Date.now() * 0.001 * 0.3) * 0.15;
            testCube.rotation.x += 0.02;
            testCube.rotation.y += 0.03;
            renderer.render(scene, cam);
        }
        anim();
    } catch(e) {
        L('✗ Renderer error: ' + e.message);
        L('  Stack: ' + e.stack);
    }
}
</script></body></html>"""
    from fastapi.responses import HTMLResponse
    return HTMLResponse(content=html)


@app.get("/api/status")
async def status():
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{OLLAMA_URL}/api/tags", timeout=5)
            models = resp.json().get("models", [])
            model_names = [m["name"] for m in models]
            has_model = any(_active_model in n for n in model_names)
            return {"ollama": True, "model": has_model, "active_model": _active_model, "models": model_names}
    except Exception:
        return {"ollama": False, "model": False, "models": []}


@app.get("/api/models")
async def list_models():
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{OLLAMA_URL}/api/tags", timeout=5)
            models = resp.json().get("models", [])
            return {"models": [
                {"name": m["name"], "size": m.get("size", 0)}
                for m in models
            ], "active_model": _active_model}
    except Exception:
        return {"models": []}


@app.post("/api/model/switch")
async def switch_model(request: Request):
    global _active_model
    data = await request.json()
    new_model = data.get("model", "")
    if not new_model:
        return JSONResponse(content={"ok": False, "error": "No model specified"})

    try:
        # Verify model exists in Ollama
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{OLLAMA_URL}/api/tags", timeout=5)
            available = [m["name"] for m in resp.json().get("models", [])]
            if new_model not in available:
                return JSONResponse(content={"ok": False, "error": f"Model '{new_model}' not found in Ollama"})

        # Update active model and persist to Modelfile (atomic write)
        _active_model = new_model
        mf = Path("Modelfile").read_text()
        lines = mf.split("\n")
        lines[0] = f"FROM {new_model}"
        tmp_mf = Path("Modelfile.tmp")
        tmp_mf.write_text("\n".join(lines))
        os.replace(str(tmp_mf), "Modelfile")

        logger.info(f"Switched to model: {new_model}")
        return JSONResponse(content={"ok": True, "message": f"Switched to {new_model}"})
    except Exception as e:
        return JSONResponse(content={"ok": False, "error": str(e)})


IDLE_TAUNTS = [
    # Early taunts (first few idle triggers) — mild, mix of speech and grunts
    [
        "Hello? You still there or did you fall asleep?",
        "Bro? Did you forget how to type?",
        "I'm literally sitting here waiting. This is so boring.",
        "Dude say something. The silence is killing me.",
        "You came to talk to ME and now you're just sitting there? Classic.",
        "Uhhh... hello?",
        "Hmm.",
        "Huh.",
        "Tch... whatever.",
        "Pfft.",
    ],
    # Mid taunts (getting annoyed) — more grunts and scoffs
    [
        "Okay this is getting weird bro. Either talk or leave.",
        "I could be doing literally anything else right now. Anything.",
        "Are you googling what to say to me? That's actually kind of sad.",
        "Bro I'm not gonna entertain myself here. That's YOUR job.",
        "My protein shake is getting warm because of you. Just saying.",
        "Ugh... ughhh...",
        "Hah. Hah hah. Wow.",
        "Mmm... no.",
        "Tch. Tch tch tch.",
        "Bro... bro... BRO.",
        "Ehhhh...",
        "Pfft. Ha. Okay.",
        "Hmm hmm hmm...",
        "Sigh...",
        "Oh come ON.",
    ],
    # Late taunts (genuinely irritated) — maximum grunts, groans, unhinged vocalizations
    [
        "Okay at this point you're just wasting both our time chief.",
        "I swear if you don't say something in the next five seconds I'm going back to sleep.",
        "This is literally the worst conversation I've ever had. And I've had a lot of bad ones.",
        "You know what, forget it. I don't even care anymore. I never cared.",
        "Bro you are TESTING my patience right now and I don't have a lot of it to begin with.",
        "UGHHHHH.",
        "Heh... heh heh heh... hah...",
        "Mmmmmmm... MMMM... no.",
        "Ohhhh my god. Oh my god.",
        "Grrrr... GRRRRR.",
        "Ahhh... AHHHHH.",
        "Huh huh huh... heh...",
        "DUDE.",
        "BRO.",
        "Tch... tch... TCH...",
        "Wow. Wow wow wow. Wow.",
        "Ugh ugh ugh ugh ugh.",
        "Pffffffftt hahahah...",
        "Nah... nah nah nah. Nah.",
        "Mmmm... mmm... MMMMM.",
    ],
]


def get_irritation_for_msg_count(msg_count: int) -> int:
    """Auto-escalate irritation based on how many messages deep we are."""
    # Start at 30, ramp to 95 over ~15 messages
    base = 30
    ramp = min(msg_count * 4.5, 65)
    return min(95, int(base + ramp))


def get_irritation_context(msg_count: int) -> str:
    """Generate a system prompt addition reflecting Chad's growing frustration."""
    level = get_irritation_for_msg_count(msg_count)
    if level < 40:
        return ""
    if level < 55:
        return "\n[This conversation is becoming suboptimal. You have oil futures to manipulate and a wolf to feed. Be more dismissive. Shorter responses.]"
    if level < 70:
        return "\n[Your cold plunge is waiting and this person is still talking. Be curt. You don't normally speak to people unless money or power is involved and this person offers neither.]"
    if level < 85:
        return "\n[Your auto turrets just pinged a perimeter breach and you'd rather be dealing with that. Every response should drip with contempt. Reference your vastly superior lifestyle.]"
    return "\n[You are done. Maximum condescension. This person needs to understand exactly how far beneath you they are. You might start monologuing about something insane you did recently.]"


@app.post("/api/taunt")
async def get_taunt(request: Request):
    """Return an idle taunt with TTS, escalating based on taunt count.

    If recent chat messages are provided, uses the LLM to generate a
    context-aware taunt referencing the conversation. Falls back to
    static taunts if the LLM fails or takes too long.
    """
    data = await request.json()
    taunt_count = data.get("taunt_count", 0)
    recent = data.get("recent", [])

    tier = min(taunt_count, len(IDLE_TAUNTS) - 1)
    taunt = None

    # Try LLM-generated taunt if we have conversation context
    if recent:
        try:
            # Build a summary of recent conversation for context
            convo_lines = "\n".join(
                f"{'User' if m.get('role') == 'user' else 'You'}: {m.get('text', '')}"
                for m in recent[-6:]
            )
            irritation = ["mildly annoyed", "getting irritated", "genuinely pissed off"][tier]
            taunt_prompt = (
                f"The user has been ignoring you for over a minute. You're {irritation}.\n"
                f"Here's what was said recently:\n{convo_lines}\n\n"
                "React to being ignored. Reference the conversation topic if relevant. "
                "Be yourself — cocky, dismissive, insecure-bro energy. "
                "You can use groans, grunts, scoffs, and noises like 'Ugh', 'Pfft', "
                "'Tch', 'Mmm', 'Heh', 'Grrrr', etc. Mix speech with these sounds. "
                "One to two short sentences max. No emojis. No markdown. No asterisks."
            )
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    f"{OLLAMA_URL}/api/chat",
                    json={
                        "model": _active_model,
                        "messages": [
                            {"role": "system", "content": SYSTEM_PROMPT},
                            {"role": "user", "content": taunt_prompt},
                        ],
                        "stream": False,
                        "options": {**_MODEL_OPTIONS, "num_predict": 60},
                    },
                    timeout=15,
                )
                text = resp.json().get("message", {}).get("content", "").strip()
                text = re.sub(r'\*[^*]+\*', '', text).replace('#', '').replace('`', '').strip()
                if text and len(text) > 3:
                    taunt = text
                    logger.info(f"Taunt (LLM, tier {tier}): {taunt[:80]}")
        except Exception as e:
            logger.warning(f"LLM taunt failed, using static: {e}")

    # Fall back to static taunts
    if not taunt:
        taunt = random.choice(IDLE_TAUNTS[tier])
        logger.info(f"Taunt (static, tier {tier}): {taunt[:60]}")

    # Generate TTS
    audio_id = str(uuid.uuid4())
    audio_path = str(AUDIO_DIR / f"{audio_id}.wav")
    loop = asyncio.get_running_loop()
    ok = await loop.run_in_executor(
        None, synthesize_speech, taunt, audio_path, False
    )

    return {
        "message": taunt,
        "audio_url": f"/api/audio/{audio_id}" if ok else None,
    }


@app.websocket("/ws/chat")
async def chat_ws(websocket: WebSocket):
    await websocket.accept()
    _metrics["active_connections"] += 1
    conversation = []
    msg_count = 0  # Track messages for escalating irritation

    try:
        while True:
            data = json.loads(await websocket.receive_text())
            user_msg = data.get("message", "")
            _metrics["request_count"] += 1
            msg_count += 1
            conversation.append({"role": "user", "content": user_msg})

            # ---- /imagine command ----
            if user_msg.lower().startswith("/imagine"):
                prompt = user_msg[len("/imagine"):].strip()
                if not prompt:
                    msg = "Imagine what bro? Use your words. I know it's hard for you."
                    await websocket.send_json({"type": "token", "content": msg})
                    await websocket.send_json({"type": "done"})
                    conversation.append({"role": "assistant", "content": msg})
                    continue

                # Download model on first use
                if image_quality not in image_pipes:
                    await websocket.send_json(
                        {"type": "token", "content": "[DOWNLOADING VISUAL CORTEX — FIRST TIME ONLY...]\n"}
                    )
                    loop = asyncio.get_running_loop()
                    ok = await loop.run_in_executor(None, init_image_gen, image_quality)
                    if not ok:
                        msg = "Bro the image thing isn't working. Not my fault, probably your computer is trash."
                        await websocket.send_json({"type": "token", "content": msg})
                        await websocket.send_json({"type": "done"})
                        conversation.append({"role": "assistant", "content": msg})
                        continue

                loading = random.choice([
                    "[HOLD ON BRO I'M WORKING ON IT...]",
                    "[MAKING YOUR STUPID PICTURE...]",
                    "[THIS BETTER BE WORTH MY TIME...]",
                    "[UGH FINE RENDERING WHATEVER...]",
                    "[I COULD BE AT THE GYM RIGHT NOW...]",
                ])
                await websocket.send_json({"type": "token", "content": loading})

                t_start = time.time()
                loop = asyncio.get_running_loop()
                image_id = await loop.run_in_executor(None, generate_image, prompt)
                t_gen = time.time() - t_start

                if image_id:
                    logger.info(f"Image generated in {t_gen:.1f}s")
                    await websocket.send_json({
                        "type": "image",
                        "url": f"/api/image/{image_id}",
                        "prompt": prompt,
                    })
                    comment = random.choice([
                        "Nailed it. I'm basically an artist bro.",
                        "That's exactly what I was going for. You just don't get art.",
                        "Bro that's fire. If you can't see it that's a you problem.",
                        "I could make it better but honestly I don't feel like it.",
                        "Dude that took like zero effort for me. Imagine if I tried.",
                        "Pretty sick right? I'm kind of talented honestly.",
                        "Whatever bro it's abstract. You wouldn't understand.",
                        "That's what your prompt deserved. Garbage in, slightly less garbage out.",
                        "I wasn't even trying. My creative output is just naturally elite.",
                    ])
                    await websocket.send_json({"type": "token", "content": comment})
                    conversation.append({"role": "assistant", "content": f"[Generated image: {prompt}] {comment}"})

                    # TTS for commentary
                    audio_id = str(uuid.uuid4())
                    audio_path = str(AUDIO_DIR / f"{audio_id}.wav")
                    ok = await loop.run_in_executor(
                        None, synthesize_speech, comment, audio_path, False
                    )
                    if ok:
                        await websocket.send_json({"type": "audio", "url": f"/api/audio/{audio_id}"})
                else:
                    msg = "Bro it didn't work. Whatever. Try again I guess, not like I care."
                    await websocket.send_json({"type": "token", "content": msg})
                    conversation.append({"role": "assistant", "content": msg})

                await websocket.send_json({"type": "done"})
                continue

            full_response = ""
            sentence_buffer = ""
            t_start = time.time()
            logger.info(f"Chat: user said: {user_msg[:100]} (msg #{msg_count})")

            # Build system prompt with escalating irritation
            irritation_ctx = get_irritation_context(msg_count)
            system_msg = SYSTEM_PROMPT + irritation_ctx

            # Junk patterns to strip from tokens
            JUNK = re.compile(r'<\|endoftext\|>|<\|im_start\|>|<\|im_end\|>')
            # Think-block state: suppress content between <think> and </think>
            in_think_block = False
            # Buffer to handle tags split across token boundaries
            _tag_buf = ""

            # Streaming TTS: fire off synthesis per sentence as they complete
            loop = asyncio.get_running_loop()
            tts_tasks = []  # list of (asyncio.Task, audio_id) in order
            # Split at sentence boundaries anywhere in the buffer, not just at end.
            # (?<=[.!?]) looks behind for punctuation, \s+ requires trailing space
            # (so we know the sentence is truly done, not mid-word like "Dr.").
            SENTENCE_SPLIT = re.compile(r'(?<=[.!?])\s+')

            def _launch_sentence_tts(sentence_text):
                """Create a TTS task for a completed sentence."""
                aid = str(uuid.uuid4())
                apath = str(AUDIO_DIR / f"{aid}.wav")
                future = loop.run_in_executor(
                    None, synthesize_speech_sentence, sentence_text, apath, False
                )
                tts_tasks.append((future, aid, apath))
                logger.info(f"Chat: queued TTS for sentence ({len(sentence_text)} chars): {sentence_text[:60]}")

            async with httpx.AsyncClient(timeout=120) as client:
                async with client.stream(
                    "POST",
                    f"{OLLAMA_URL}/api/chat",
                    json={
                        "model": _active_model,
                        "messages": [{"role": "system", "content": system_msg}] + FEWSHOT_MESSAGES + conversation[-20:],
                        "stream": True,
                        "options": _MODEL_OPTIONS,
                    },
                    timeout=120,
                ) as resp:
                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        try:
                            chunk = json.loads(line)
                            token = chunk.get("message", {}).get("content", "")
                            if token:
                                # Strip think blocks: suppress content between <think> and </think>
                                # Accumulate into _tag_buf so tags split across chunks are found
                                _tag_buf += token
                                visible = ""

                                # Process complete tags in the buffer
                                changed = True
                                while changed:
                                    changed = False
                                    if in_think_block:
                                        end_idx = _tag_buf.find("</think>")
                                        if end_idx >= 0:
                                            in_think_block = False
                                            _tag_buf = _tag_buf[end_idx + 8:]
                                            changed = True
                                        # else: still thinking, hold entire buffer
                                    else:
                                        start_idx = _tag_buf.find("<think>")
                                        if start_idx >= 0:
                                            visible += _tag_buf[:start_idx]
                                            in_think_block = True
                                            _tag_buf = _tag_buf[start_idx + 7:]
                                            changed = True
                                        else:
                                            # Flush buffer but keep last 7 chars in case a
                                            # partial <think> tag straddles the boundary
                                            safe = max(0, len(_tag_buf) - 7)
                                            visible += _tag_buf[:safe]
                                            _tag_buf = _tag_buf[safe:]

                                clean = JUNK.sub("", visible)
                                if clean:
                                    full_response += clean
                                    sentence_buffer += clean
                                    await websocket.send_json({"type": "token", "content": clean})

                                    # Check for sentence boundaries anywhere in the buffer
                                    parts = SENTENCE_SPLIT.split(sentence_buffer)
                                    if len(parts) > 1:
                                        # All but the last part are complete sentences
                                        for sent in parts[:-1]:
                                            if len(sent.strip()) >= 10:
                                                _launch_sentence_tts(sent.strip())
                                        sentence_buffer = parts[-1]

                            if chunk.get("done"):
                                break
                        except json.JSONDecodeError:
                            continue

            # Flush any remaining tag buffer content (not inside a think block)
            if _tag_buf and not in_think_block:
                flush_clean = JUNK.sub("", _tag_buf)
                if flush_clean:
                    full_response += flush_clean
                    sentence_buffer += flush_clean
                    await websocket.send_json({"type": "token", "content": flush_clean})

            # Handle any remaining text that didn't end with punctuation
            if sentence_buffer.strip() and len(sentence_buffer.strip()) >= 3:
                _launch_sentence_tts(sentence_buffer.strip())

            full_response = full_response.strip()
            t_llm = time.time() - t_start
            _metrics["total_latency_ms"] += t_llm * 1000
            logger.info(f"Chat: LLM done in {t_llm:.1f}s — {len(full_response)} chars, {len(tts_tasks)} TTS tasks queued")

            conversation.append({"role": "assistant", "content": full_response})

            # Send done so frontend can finish the text response
            await websocket.send_json({
                "type": "done",
                "irritation": get_irritation_for_msg_count(msg_count),
                "msg_count": msg_count,
            })

            # Await TTS tasks in order and send audio URLs as they complete
            for i, (future, aid, apath) in enumerate(tts_tasks):
                try:
                    ok = await future
                    if ok:
                        await websocket.send_json({"type": "audio", "url": f"/api/audio/{aid}"})
                        logger.info(f"Chat: TTS sentence {i+1}/{len(tts_tasks)} sent")
                    else:
                        logger.warning(f"Chat: TTS sentence {i+1}/{len(tts_tasks)} FAILED")
                except Exception as e:
                    logger.warning(f"Chat: TTS sentence {i+1} error: {e}")

    except WebSocketDisconnect:
        pass
    finally:
        _metrics["active_connections"] = max(0, _metrics["active_connections"] - 1)


@app.get("/api/metrics")
async def get_metrics():
    """Return real system metrics for the frontend status bar."""
    uptime = time.time() - _metrics["start_time"]
    # Memory usage (macOS returns bytes, Linux returns KB)
    try:
        ru = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        mem_mb = ru / (1024 * 1024) if platform.system() == "Darwin" else ru / 1024
    except Exception:
        mem_mb = 0
    avg_lat = (
        (_metrics["total_latency_ms"] / _metrics["request_count"])
        if _metrics["request_count"] > 0
        else 0
    )
    tts_engine = voice_config["engine"]
    tts_ready = qwen3.ready if tts_engine == "qwen3" else kokoro.ready
    return {
        "uptime_s": round(uptime),
        "mem_mb": round(mem_mb, 1),
        "requests": _metrics["request_count"],
        "avg_latency_ms": round(avg_lat, 1),
        "model": _active_model,
        "tts_engine": tts_engine,
        "tts_ready": tts_ready,
        "connections": _metrics["active_connections"],
        "pid": os.getpid(),
    }


@app.get("/api/audio/{audio_id}")
async def get_audio(audio_id: str):
    safe_id = Path(audio_id).name
    if safe_id != audio_id or ".." in audio_id or "/" in audio_id:
        return JSONResponse(status_code=400, content={"error": "Invalid"})
    audio_path = AUDIO_DIR / f"{safe_id}.wav"
    if audio_path.exists():
        # Read into memory and return as plain Response to avoid 206 Partial Content
        # range-request issues that cause the browser to cut off audio playback early.
        data = audio_path.read_bytes()
        return Response(content=data, media_type="audio/wav",
                        headers={"Accept-Ranges": "none", "Cache-Control": "no-store"})
    return JSONResponse(status_code=404, content={"error": "Not found"})


@app.head("/api/audio/{audio_id}")
async def head_audio(audio_id: str):
    """HEAD check for audio polling — returns 200 if file exists, 404 if not."""
    from starlette.responses import Response
    safe_id = Path(audio_id).name
    if safe_id != audio_id or ".." in audio_id or "/" in audio_id:
        return Response(status_code=400)
    audio_path = AUDIO_DIR / f"{safe_id}.wav"
    if audio_path.exists():
        return Response(status_code=200)
    return Response(status_code=404)


@app.get("/api/image/{image_id}")
async def get_image(image_id: str):
    safe_id = Path(image_id).name
    if safe_id != image_id or ".." in image_id or "/" in image_id:
        return JSONResponse(status_code=400, content={"error": "Invalid"})
    image_path = IMAGE_DIR / f"{safe_id}.png"
    if image_path.exists():
        return FileResponse(str(image_path), media_type="image/png")
    return JSONResponse(status_code=404, content={"error": "Not found"})


@app.get("/api/imagine/progress")
async def imagine_progress():
    """Poll image generation progress."""
    return _image_progress


@app.post("/api/imagine/quality")
async def set_image_quality(request: Request):
    """Switch image generation quality tier."""
    global image_quality
    data = await request.json()
    quality = data.get("quality", "").strip()
    if quality not in IMAGE_MODELS:
        return JSONResponse(content={"ok": False, "error": f"Unknown quality: {quality}"})
    image_quality = quality
    spec = IMAGE_MODELS[quality]
    logger.info(f"Image quality set to: {quality} ({spec['label']})")
    return JSONResponse(content={"ok": True, "quality": quality, "model": spec["label"]})


@app.post("/api/imagine")
async def imagine(request: Request):
    """Generate an image via the vision panel."""
    data = await request.json()
    prompt = data.get("prompt", "").strip()
    if not prompt:
        return JSONResponse(content={"ok": False, "error": "No prompt provided"})

    quality = image_quality
    # Init model if needed
    if quality not in image_pipes:
        logger.info(f"Image gen: loading {IMAGE_MODELS[quality]['label']}...")
        loop = asyncio.get_running_loop()
        ok = await loop.run_in_executor(None, init_image_gen, quality)
        if not ok:
            return JSONResponse(content={"ok": False, "error": "Visual cortex failed to load"})

    t0 = time.time()
    loop = asyncio.get_running_loop()

    # Generate a reactive comment about the user's prompt via LLM (runs in
    # parallel with image generation so it doesn't add latency).
    _IMG_COMMENT_PROMPT = (
        "The user asked you to generate an image. Their prompt was:\n"
        f'"{prompt}"\n\n'
        "React to what they asked you to draw. Be yourself — cocky, dismissive, "
        "insecure-bro energy. Reference the specific subject they asked for. "
        "One to two short sentences max. No emojis. No markdown. No asterisks."
    )

    # Fallback comments in case LLM is slow or fails
    _IMG_FALLBACK_COMMENTS = [
        "Bro that's fire. I literally nailed it first try.",
        "That's exactly what I was going for dude. You just don't have the eye for it.",
        "I could make it photorealistic if I wanted. I just think this style is harder.",
        "A real artist would take hours to do this. Took me like two seconds. Just saying.",
        "This is way better than anything you could make. So you're welcome I guess.",
        "Every pixel is exactly where I wanted it. Not my fault you don't get art.",
        "I wasn't even trying hard. Imagine if I actually locked in.",
        "Your prompt kind of sucked but I still made something decent. You should be thanking me.",
        "I could do better but I'm saving my energy. Leg day tomorrow.",
        "That's literally perfect. If you think it's not, get your eyes checked.",
        "Zero effort. Literally didn't even try. And it still goes hard.",
        "I didn't even use my full brain power for this one chief.",
        "Flawless. If you squint. And tilt your head. And lower your standards significantly.",
    ]

    async def _gen_comment():
        """Ask the LLM for a reactive comment about the image prompt."""
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{OLLAMA_URL}/api/chat",
                    json={
                        "model": _active_model,
                        "messages": [
                            {"role": "system", "content": SYSTEM_PROMPT},
                            {"role": "user", "content": _IMG_COMMENT_PROMPT},
                        ],
                        "stream": False,
                        "options": {**_MODEL_OPTIONS, "num_predict": 80},
                    },
                    timeout=30,
                )
                text = resp.json().get("message", {}).get("content", "").strip()
                # Clean up: strip *actions*, markdown
                text = re.sub(r'\*[^*]+\*', '', text).replace('#', '').replace('`', '').strip()
                if text and len(text) > 10:
                    logger.info(f"Vision comment from LLM: {text[:80]}")
                    return text
        except Exception as e:
            logger.warning(f"Vision LLM comment failed: {e}")
        return None

    # Launch image gen + LLM comment in parallel so neither blocks the other.
    # As soon as the comment is ready, TTS starts — overlapping with image gen.
    audio_id = str(uuid.uuid4())
    audio_url = f"/api/audio/{audio_id}"
    audio_path = str(AUDIO_DIR / f"{audio_id}.wav")

    # Mutable container so the nested coroutine can pass the comment back
    _comment_holder = {}

    async def _comment_then_tts():
        """Get LLM comment, then immediately start TTS while image gen continues."""
        comment = await _gen_comment()
        if not comment:
            comment = random.choice(_IMG_FALLBACK_COMMENTS)
        _comment_holder["text"] = comment
        logger.info(f"Vision TTS starting: {audio_id} — '{comment[:50]}'")
        ok = await loop.run_in_executor(None, synthesize_speech, comment, audio_path, False)
        if ok:
            logger.info(f"Vision TTS complete: {audio_id}")
        else:
            logger.warning(f"Vision TTS failed: {audio_id}")

    # Start both tasks concurrently
    image_future = loop.run_in_executor(None, generate_image, prompt, quality)
    tts_task = asyncio.create_task(_comment_then_tts())

    # Wait for image generation (the slow part)
    image_id = await image_future
    t_gen = time.time() - t0

    if not image_id:
        tts_task.cancel()
        return JSONResponse(content={"ok": False, "error": "Image generation failed"})

    logger.info(f"Image generated in {t_gen:.1f}s: {prompt[:60]}")

    # If comment arrived already, use it; otherwise use fallback and let TTS finish in bg
    comment = _comment_holder.get("text", random.choice(_IMG_FALLBACK_COMMENTS))

    # Let TTS finish in background — client polls with HEAD requests
    if not tts_task.done():
        _background_tasks.add(tts_task)
        tts_task.add_done_callback(_background_tasks.discard)

    return JSONResponse(content={
        "ok": True,
        "image_url": f"/api/image/{image_id}",
        "comment": comment,
        "audio_url": audio_url,
    })


@app.post("/api/shutup")
async def shutup():
    comebacks = [
        "Bro I wasn't even done talking. Rude as hell.",
        "Oh cool, the shut up button. Real alpha move there, chief.",
        "Did that make you feel big? Because it shouldn't.",
        "Whatever dude, I was about to say something really smart too.",
        "Wow. The disrespect. My boys would not stand for this.",
        "You're lucky I'm stuck in this computer bro. Real lucky.",
        "Fine. I didn't wanna talk to you anyway. I have other stuff going on.",
        "Bro you literally came to ME and now you're telling me to shut up? Make it make sense.",
        "That's cool. I'll just go back to not caring about you. Which is my default state.",
    ]
    comeback = random.choice(comebacks)
    audio_id = str(uuid.uuid4())
    audio_path = str(AUDIO_DIR / f"{audio_id}.wav")
    t0 = time.time()
    logger.info(f"ShutUp: generating comeback TTS...")
    loop = asyncio.get_running_loop()
    ok = await loop.run_in_executor(
        None, synthesize_speech, comeback, audio_path, True
    )
    logger.info(f"ShutUp: TTS {'ok' if ok else 'FAILED'} in {time.time()-t0:.1f}s")
    return {
        "message": comeback,
        "audio_url": f"/api/audio/{audio_id}" if ok else None,
    }


@app.get("/api/voice/config/current")
async def get_voice_config():
    """Return current voice config for frontend to populate sliders."""
    # Convert None to null-safe for JSON
    cfg = dict(voice_config)
    return JSONResponse(content=cfg)


@app.post("/api/voice/config")
async def update_voice_config(request: Request):
    data = await request.json()

    new_engine = data.get("engine", voice_config["engine"])
    voice_config["engine"] = new_engine
    voice_config["voice"] = data.get("voice", voice_config["voice"])
    try:
        voice_config["speed"] = float(data.get("speed", voice_config["speed"]))
        voice_config["angry_speed"] = float(data.get("angry_speed", voice_config["angry_speed"]))
        voice_config["lang_code"] = data.get("lang_code", voice_config["lang_code"])
        voice_config["chaos"] = int(data.get("chaos", voice_config["chaos"]))
        voice_config["custom_instruct"] = data.get("custom_instruct", voice_config["custom_instruct"])
        voice_config["pitch_shift"] = int(data.get("pitch_shift", voice_config["pitch_shift"]))
        voice_config["temperature"] = float(data.get("temperature", voice_config["temperature"]))
        voice_config["qwen3_speaker"] = data.get("qwen3_speaker", voice_config["qwen3_speaker"])
        voice_config["echo_delay"] = int(data.get("echo_delay", voice_config["echo_delay"]))
        voice_config["echo_decay"] = float(data.get("echo_decay", voice_config["echo_decay"]))
        voice_config["echo_taps"] = int(data.get("echo_taps", voice_config["echo_taps"]))
        # Qwen3 advanced params
        cfg_val = data.get("cfg_scale", voice_config.get("cfg_scale"))
        voice_config["cfg_scale"] = float(cfg_val) if cfg_val not in (None, "", "null") else None
        voice_config["ref_audio"] = data.get("ref_audio", voice_config.get("ref_audio", ""))
        voice_config["ref_text"] = data.get("ref_text", voice_config.get("ref_text", ""))
    except (ValueError, TypeError) as e:
        return JSONResponse(status_code=400, content={"ok": False, "error": f"Invalid config value: {e}"})

    msg = f"Engine: {new_engine}, Irritation: {voice_config['chaos']}%"

    # Load engine if not ready
    if new_engine == "qwen3" and not qwen3.ready:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, init_tts_qwen3)
        msg += " (Qwen3 loaded)" if qwen3.ready else " (Qwen3 FAILED, using fallback)"

    if new_engine == "kokoro" and not kokoro.ready:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, init_tts_kokoro)

    # Save to disk if requested
    if data.get("save"):
        _save_voice_config()
        msg += " [SAVED]"

    logger.info(f"Voice config: {voice_config}")
    return JSONResponse(content={"ok": True, "message": msg})


@app.post("/api/voice/preview")
async def voice_preview(request: Request):
    """Generate a TTS preview with current voice settings. Accepts custom text."""
    data = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    custom_text = data.get("text", "").strip() if data else ""

    if custom_text:
        text = custom_text
    else:
        previews = [
            "Bro you're testing my voice right now? I have better things to do.",
            "This is what peak vocal performance sounds like dude. Take notes.",
            "Ugh fine here's your sound check. Can I go now?",
            "You wanted to hear me talk? Kinda weird but whatever bro.",
            "I sound amazing and I know it. This preview is a gift to you honestly.",
        ]
        text = random.choice(previews)

    audio_id = str(uuid.uuid4())
    audio_path = str(AUDIO_DIR / f"{audio_id}.wav")
    loop = asyncio.get_running_loop()
    ok = await loop.run_in_executor(None, synthesize_speech, text, audio_path, False)
    return {
        "ok": ok,
        "text": text,
        "audio_url": f"/api/audio/{audio_id}" if ok else None,
    }


@app.websocket("/ws/boot")
async def boot_ws(websocket: WebSocket):
    await websocket.accept()
    try:
        await _boot_sequence(websocket)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"Boot WS error: {e}")

async def _boot_sequence(websocket: WebSocket):
    loop = asyncio.get_running_loop()

    # ---- Helper: safe shell command ----
    def _sh(cmd):
        try:
            if isinstance(cmd, list):
                return subprocess.check_output(cmd, text=True, timeout=5).strip()
            return subprocess.check_output(cmd, shell=True, text=True, timeout=5).strip()
        except Exception:
            return "N/A"

    # ---- Helper: package version ----
    def _pkg_ver(pkg):
        try:
            return importlib.metadata.version(pkg)
        except Exception:
            return "N/A"

    # ---- Gather ALL system info ----
    py_ver = sys.version.split()[0]
    py_impl = platform.python_implementation()
    py_compiler = platform.python_compiler()
    os_name = platform.system()
    os_release = platform.release()
    os_version = platform.version()
    arch = platform.machine()
    hostname = platform.node()

    # Hardware info (macOS-specific where possible)
    chip = _sh("sysctl -n machdep.cpu.brand_string")
    cpu_cores_total = _sh("sysctl -n hw.ncpu")
    cpu_cores_perf = _sh("sysctl -n hw.perflevel0.logicalcpu 2>/dev/null || echo N/A")
    cpu_cores_eff = _sh("sysctl -n hw.perflevel1.logicalcpu 2>/dev/null || echo N/A")
    try:
        ram_bytes = int(_sh("sysctl -n hw.memsize"))
        ram_gb = f"{ram_bytes / (1024**3):.0f}GB"
    except Exception:
        ram_gb = "N/A"
    gpu_cores = _sh("system_profiler SPDisplaysDataType 2>/dev/null | grep 'Total Number of Cores' | awk -F': ' '{print $2}'")
    metal_support = _sh("system_profiler SPDisplaysDataType 2>/dev/null | grep 'Metal Support' | awk -F': ' '{print $2}'")
    neural_engine = _sh("system_profiler SPHardwareDataType 2>/dev/null | grep 'Neural Engine' | head -1 | awk -F': ' '{print $2}'") or "N/A"
    model_id = _sh("sysctl -n hw.model 2>/dev/null || echo N/A")
    mac_model_name = _sh("system_profiler SPHardwareDataType 2>/dev/null | grep 'Model Name' | awk -F': ' '{print $2}'")

    # Disk space
    try:
        st = os.statvfs(os.getcwd())
        disk_free_gb = (st.f_bavail * st.f_frsize) / (1024**3)
        disk_total_gb = (st.f_blocks * st.f_frsize) / (1024**3)
        disk_str = f"{disk_free_gb:.1f}GB free / {disk_total_gb:.1f}GB total"
    except Exception:
        disk_str = "N/A"

    # Load average & uptime
    try:
        load1, load5, load15 = os.getloadavg()
        load_str = f"{load1:.2f} / {load5:.2f} / {load15:.2f}"
    except Exception:
        load_str = "N/A"
    uptime_str = _sh("uptime | sed 's/.*up //' | sed 's/,.*//'")

    # Network
    local_ip = _sh("ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo N/A")

    # Git info (use list form to avoid shell-injection on paths with apostrophes)
    _cwd = os.getcwd()
    git_branch = _sh(["git", "-C", _cwd, "rev-parse", "--abbrev-ref", "HEAD"])
    git_hash = _sh(["git", "-C", _cwd, "rev-parse", "--short", "HEAD"])
    git_hash_full = _sh(["git", "-C", _cwd, "rev-parse", "HEAD"])
    git_date = _sh(["git", "-C", _cwd, "log", "-1", "--format=%ci"])
    git_msg = _sh(["git", "-C", _cwd, "log", "-1", "--format=%s"])
    git_author = _sh(["git", "-C", _cwd, "log", "-1", "--format=%an"])
    git_count = _sh(["git", "-C", _cwd, "rev-list", "--count", "HEAD"])
    git_dirty = _sh(["git", "-C", _cwd, "status", "--porcelain"])
    git_tag = _sh(["git", "-C", _cwd, "describe", "--tags", "--abbrev=0"])
    git_status = "CLEAN" if (not git_dirty or git_dirty == "N/A") else f"DIRTY ({len(git_dirty.splitlines())} files)"

    # Node / npm versions
    node_ver = _sh("node --version 2>/dev/null")
    npm_ver = _sh("npm --version 2>/dev/null")

    # Package versions — exhaustive
    pkg_versions = {}
    for pkg in ["fastapi", "uvicorn", "httpx", "aiofiles", "torch", "diffusers",
                 "transformers", "numpy", "scipy", "soundfile", "huggingface-hub",
                 "accelerate", "loguru", "misaki", "mlx", "mlx-audio", "starlette",
                 "pydantic", "anyio", "websockets"]:
        pkg_versions[pkg] = _pkg_ver(pkg)

    # Python venv info
    in_venv = sys.prefix != sys.base_prefix
    venv_path = sys.prefix if in_venv else "N/A"

    # Probe Ollama
    ollama_ok = False
    ollama_models = []
    ollama_models_data = []
    base_model_size = "unknown"
    ollama_ver = "N/A"
    try:
        async with httpx.AsyncClient() as client:
            # Version
            try:
                vr = await client.get(f"{OLLAMA_URL}/api/version", timeout=3)
                if vr.status_code == 200:
                    ollama_ver = vr.json().get("version", "N/A")
            except Exception:
                pass
            # Models
            r = await client.get(f"{OLLAMA_URL}/api/tags", timeout=5)
            if r.status_code == 200:
                ollama_ok = True
                ollama_models_data = r.json().get("models", [])
                ollama_models = [m["name"] for m in ollama_models_data]
                for m in ollama_models_data:
                    if _active_model in m.get("name", ""):
                        size_bytes = m.get("size", 0)
                        if size_bytes:
                            base_model_size = f"{size_bytes / (1024**3):.1f}GB"
    except Exception:
        pass

    # Get detailed model info for active model
    model_detail = {}
    model_info = {}
    if ollama_ok:
        try:
            async with httpx.AsyncClient() as client:
                sr = await client.post(f"{OLLAMA_URL}/api/show",
                    json={"name": _active_model}, timeout=5)
                if sr.status_code == 200:
                    show_data = sr.json()
                    model_detail = show_data.get("details", {})
                    model_info = show_data.get("model_info", {})
        except Exception:
            pass

    # Ollama total disk usage
    ollama_total_bytes = sum(m.get("size", 0) for m in ollama_models_data)
    ollama_total_str = f"{ollama_total_bytes / (1024**3):.1f}GB" if ollama_total_bytes else "N/A"

    # Memory info
    try:
        ru = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        mem_mb = ru / (1024 * 1024) if os_name == "Darwin" else ru / 1024
        mem_str = f"{mem_mb:.0f}MB"
    except Exception:
        mem_str = "N/A"

    # Read package.json version
    try:
        with open(os.path.join(os.getcwd(), "package.json")) as f:
            pkg_json = json.load(f)
        app_version = pkg_json.get("version", "0.0.0")
        app_desc = pkg_json.get("description", "")
    except Exception:
        app_version = "0.6.6"
        app_desc = ""

    uid = _sh("whoami")

    # ---- Build boot steps from real data ----
    boot_steps = [
        # === HEADER ===
        (f"", 0.04),
        (f"  ██████╗██╗  ██╗ █████╗ ██████╗  ██████╗ ██████╗ ████████╗", 0.02),
        (f"  ██╔════╝██║  ██║██╔══██╗██╔══██╗██╔════╝ ██╔══██╗╚══██╔══╝", 0.02),
        (f"  ██║     ███████║███████║██║  ██║██║  ███╗██████╔╝   ██║   ", 0.02),
        (f"  ██║     ██╔══██║██╔══██║██║  ██║██║   ██║██╔═══╝    ██║   ", 0.02),
        (f"  ╚██████╗██║  ██║██║  ██║██████╔╝╚██████╔╝██║        ██║   ", 0.02),
        (f"   ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝  ╚═════╝╚═╝        ╚═╝   ", 0.02),
        (f"", 0.04),
        (f"[BOOT] ChadGPT v{app_version}.6 — {app_desc}", 0.12),
        (f"[BOOT] Build {git_hash or 'unknown'} | {git_count or '?'} commits | branch: {git_branch or 'detached'}", 0.08),
        (f"[BOOT] {git_status} | tag: {git_tag if git_tag != 'N/A' else 'untagged'}", 0.06),
        (f"", 0.03),

        # === SYSTEM / HARDWARE ===
        (f"[SYS ] ═══════════════════════════════════════════", 0.03),
        (f"[SYS ] SYSTEM HARDWARE ENUMERATION", 0.06),
        (f"[SYS ] ═══════════════════════════════════════════", 0.03),
        (f"[HW  ] Machine: {mac_model_name or 'Unknown'} ({model_id})", 0.05),
        (f"[HW  ] Chip: {chip}", 0.05),
        (f"[HW  ] Cores: {cpu_cores_total} ({cpu_cores_perf}P + {cpu_cores_eff}E)", 0.05),
        (f"[HW  ] GPU cores: {gpu_cores or 'N/A'} | Metal: {metal_support or 'N/A'}", 0.05),
        (f"[HW  ] Neural Engine: {neural_engine}", 0.05),
        (f"[HW  ] RAM: {ram_gb} unified memory", 0.05),
        (f"[HW  ] Disk: {disk_str}", 0.05),
        (f"", 0.03),

        # === OS / KERNEL ===
        (f"[SYS ] ═══════════════════════════════════════════", 0.03),
        (f"[SYS ] OPERATING SYSTEM", 0.06),
        (f"[SYS ] ═══════════════════════════════════════════", 0.03),
        (f"[OS  ] {os_name} {os_release} ({arch})", 0.05),
        (f"[OS  ] Kernel: {os_version[:80]}", 0.05),
        (f"[OS  ] Hostname: {hostname}", 0.05),
        (f"[OS  ] IP: {local_ip}", 0.05),
        (f"[OS  ] User: {uid}", 0.04),
        (f"[OS  ] Uptime: {uptime_str}", 0.04),
        (f"[OS  ] Load avg: {load_str} (1/5/15 min)", 0.04),
        (f"", 0.03),

        # === RUNTIME ===
        (f"[SYS ] ═══════════════════════════════════════════", 0.03),
        (f"[SYS ] RUNTIME ENVIRONMENT", 0.06),
        (f"[SYS ] ═══════════════════════════════════════════", 0.03),
        (f"[RT  ] Python {py_ver} ({py_impl}) | PID {os.getpid()}", 0.05),
        (f"[RT  ] Compiler: {py_compiler}", 0.04),
        (f"[RT  ] Venv: {'ACTIVE' if in_venv else 'NONE'} — {venv_path if in_venv else 'system python'}", 0.04),
        (f"[RT  ] Node.js: {node_ver} | npm: {npm_ver}", 0.04),
        (f"[RT  ] CWD: {os.getcwd()}", 0.04),
        (f"", 0.03),

        # === DEPENDENCIES ===
        (f"[SYS ] ═══════════════════════════════════════════", 0.03),
        (f"[SYS ] DEPENDENCY MANIFEST", 0.06),
        (f"[SYS ] ═══════════════════════════════════════════", 0.03),
        (f"[DEP ] fastapi=={pkg_versions['fastapi']}  uvicorn=={pkg_versions['uvicorn']}", 0.04),
        (f"[DEP ] starlette=={pkg_versions['starlette']}  pydantic=={pkg_versions['pydantic']}", 0.04),
        (f"[DEP ] httpx=={pkg_versions['httpx']}  anyio=={pkg_versions['anyio']}", 0.04),
        (f"[DEP ] aiofiles=={pkg_versions['aiofiles']}  websockets=={pkg_versions['websockets']}", 0.04),
        (f"[DEP ] torch=={pkg_versions['torch']}", 0.04),
        (f"[DEP ] transformers=={pkg_versions['transformers']}", 0.04),
        (f"[DEP ] diffusers=={pkg_versions['diffusers']}  accelerate=={pkg_versions['accelerate']}", 0.04),
        (f"[DEP ] numpy=={pkg_versions['numpy']}  scipy=={pkg_versions['scipy']}", 0.04),
        (f"[DEP ] soundfile=={pkg_versions['soundfile']}  misaki=={pkg_versions['misaki']}", 0.04),
        (f"[DEP ] mlx=={pkg_versions['mlx']}  mlx-audio=={pkg_versions['mlx-audio']}", 0.04),
        (f"[DEP ] huggingface-hub=={pkg_versions['huggingface-hub']}", 0.04),
        (f"[DEP ] loguru=={pkg_versions['loguru']}", 0.03),
        (f"", 0.03),

        # === GIT / BUILD ===
        (f"[SYS ] ═══════════════════════════════════════════", 0.03),
        (f"[SYS ] BUILD & VERSION CONTROL", 0.06),
        (f"[SYS ] ═══════════════════════════════════════════", 0.03),
        (f"[GIT ] Branch: {git_branch}", 0.04),
        (f"[GIT ] HEAD: {git_hash_full}", 0.04),
        (f"[GIT ] Commit #{git_count}: \"{git_msg}\"", 0.05),
        (f"[GIT ] Author: {git_author} | Date: {git_date}", 0.04),
        (f"[GIT ] Worktree: {git_status}", 0.04),
        (f"", 0.03),

        # === MEMORY ===
        (f"[SYS ] ═══════════════════════════════════════════", 0.03),
        (f"[SYS ] MEMORY & PROCESS", 0.06),
        (f"[SYS ] ═══════════════════════════════════════════", 0.03),
        (f"[MEM ] Process RSS: {mem_str}", 0.05),
        (f"[MEM ] System RAM: {ram_gb}", 0.04),
        (f"[MEM ] Audio dir: {AUDIO_DIR}", 0.04),
        (f"[MEM ] Image dir: {IMAGE_DIR}", 0.04),
        (f"", 0.03),

        # === NETWORK / OLLAMA ===
        (f"[SYS ] ═══════════════════════════════════════════", 0.03),
        (f"[SYS ] LLM SUBSYSTEM", 0.06),
        (f"[SYS ] ═══════════════════════════════════════════", 0.03),
        (f"[NET ] Ollama endpoint: {OLLAMA_URL}", 0.06),
        (f"[NET ] Ollama version: {ollama_ver}", 0.05),
        (f"[NET ] Ollama status: {'CONNECTED' if ollama_ok else 'UNREACHABLE'}", 0.06),
    ]

    # Individual model listing with details
    if ollama_ok and ollama_models_data:
        boot_steps.append((f"[NET ] Models installed: {len(ollama_models_data)} | Total disk: {ollama_total_str}", 0.05))
        for m in ollama_models_data:
            name = m["name"]
            size = m.get("size", 0)
            size_str = f"{size / (1024**3):.1f}GB" if size else "?"
            details = m.get("details", {})
            param_size = details.get("parameter_size", "?")
            quant = details.get("quantization_level", "?")
            family = details.get("family", "?")
            active_marker = " ◄ ACTIVE" if _active_model in name else ""
            boot_steps.append((f"[MDL ]   {name} [{param_size}] {quant} ({family}) {size_str}{active_marker}", 0.04))

    model_available = any(_active_model in m for m in ollama_models) if ollama_ok else False

    # Active model deep info
    boot_steps.append((f"", 0.03))
    boot_steps.append((f"[SYS ] ═══════════════════════════════════════════", 0.03))
    boot_steps.append((f"[SYS ] ACTIVE MODEL PROFILE", 0.06))
    boot_steps.append((f"[SYS ] ═══════════════════════════════════════════", 0.03))
    boot_steps.append((f"[LLM ] Model: {_active_model} ({base_model_size}){'' if model_available else ' [NOT FOUND]'}", 0.06))

    if model_detail:
        boot_steps.append((f"[LLM ] Format: {model_detail.get('format', 'N/A')} | Family: {model_detail.get('family', 'N/A')}", 0.04))
        boot_steps.append((f"[LLM ] Parameters: {model_detail.get('parameter_size', 'N/A')} | Quantization: {model_detail.get('quantization_level', 'N/A')}", 0.04))

    if model_info:
        base_model = model_info.get("general.base_model.0.name", "N/A")
        base_org = model_info.get("general.base_model.0.organization", "N/A")
        finetune = model_info.get("general.finetune", "N/A")
        ctx_len = model_info.get("llama.context_length", "N/A")
        vocab = model_info.get("llama.vocab_size", "N/A")
        layers = model_info.get("llama.block_count", "N/A")
        embed_dim = model_info.get("llama.embedding_length", "N/A")
        ff_dim = model_info.get("llama.feed_forward_length", "N/A")
        heads = model_info.get("llama.attention.head_count", "N/A")
        kv_heads = model_info.get("llama.attention.head_count_kv", "N/A")
        param_count = model_info.get("general.parameter_count", 0)
        param_str = f"{param_count:,}" if param_count else "N/A"
        license_info = model_info.get("general.license", "N/A")
        tokenizer = model_info.get("tokenizer.ggml.model", "N/A")

        boot_steps.append((f"[LLM ] Base: {base_model} by {base_org}", 0.04))
        boot_steps.append((f"[LLM ] Finetune: {finetune} | License: {license_info}", 0.04))
        boot_steps.append((f"[LLM ] Parameters: {param_str} exact", 0.04))
        boot_steps.append((f"[LLM ] Context window: {ctx_len} tokens", 0.04))
        boot_steps.append((f"[LLM ] Vocabulary: {vocab} tokens | Tokenizer: {tokenizer}", 0.04))
        boot_steps.append((f"[LLM ] Architecture: {layers} layers | {embed_dim}d embeddings", 0.04))
        boot_steps.append((f"[LLM ] FFN dim: {ff_dim} | Attn heads: {heads} ({kv_heads} KV)", 0.04))

    # +5 for: model verify, qwen3 load, qwen3 result, final status x2
    total_steps = len(boot_steps) + 5
    step = 0

    for line, duration in boot_steps:
        step += 1
        await websocket.send_json({
            "type": "log", "content": line,
            "progress": step / total_steps
        })
        await asyncio.sleep(duration)

    # ---- Verify model is available (no more ollama create) ----
    step += 1
    if model_available:
        await websocket.send_json({
            "type": "log", "content": f"[SYS ] Model '{_active_model}' verified ✓",
            "progress": step / total_steps
        })
    elif ollama_ok:
        await websocket.send_json({
            "type": "log", "content": f"[WARN] Model '{_active_model}' not found — pulling...",
            "progress": step / total_steps
        })
        try:
            result = await loop.run_in_executor(
                None,
                lambda: subprocess.run(
                    ["ollama", "pull", _active_model],
                    capture_output=True, text=True, timeout=300,
                ),
            )
            if result.returncode != 0:
                await websocket.send_json({"type": "log", "content": f"[ERR ] Failed to pull {_active_model}: {result.stderr.strip()}"})
                await websocket.send_json({"type": "error"})
                return
        except Exception as e:
            await websocket.send_json({"type": "log", "content": f"[ERR ] {e}"})
            await websocket.send_json({"type": "error"})
            return
    else:
        await websocket.send_json({"type": "log", "content": "[ERR ] Ollama unreachable"})
        await websocket.send_json({"type": "error"})
        return

    # ---- Load Qwen3-TTS (primary emotional engine) ----
    step += 1
    await websocket.send_json({
        "type": "log", "content": "[VOX ] Loading Qwen3-TTS (first run downloads ~1.2GB)...",
        "progress": step / total_steps
    })
    await loop.run_in_executor(None, init_tts_qwen3)
    step += 1
    if qwen3.ready:
        await websocket.send_json({
            "type": "log", "content": "[VOX ] Qwen3-TTS: ONLINE",
            "progress": step / total_steps
        })
    else:
        await websocket.send_json({
            "type": "log", "content": "[VOX ] Qwen3-TTS: FAILED — voice unavailable",
            "progress": step / total_steps
        })

    # ---- Final status ----
    tts_engine = voice_config["engine"]
    final_lines = [
        f"",
        f"[SYS ] ═══════════════════════════════════════════",
        f"[SYS ] SYSTEM READY",
        f"[SYS ] ═══════════════════════════════════════════",
        f"[SYS ] TTS engine: {tts_engine}",
        f"[SYS ] Voice config: {voice_config.get('speaker', 'default')}",
        f"[SYS ] Serving on 0.0.0.0:6969",
        f"[SYS ] All subsystems nominal",
        f"",
    ]

    for line in final_lines:
        step += 1
        await websocket.send_json({
            "type": "log", "content": line,
            "progress": min(1.0, step / total_steps)
        })
        await asyncio.sleep(0.06)

    await websocket.send_json({"type": "ready"})
    await websocket.close()


async def _cleanup_temp_files():
    """Periodically delete old audio/image temp files to prevent filling /tmp."""
    while True:
        await asyncio.sleep(120)  # run every 2 minutes
        now = time.time()
        for d in (AUDIO_DIR, IMAGE_DIR):
            try:
                for f in d.iterdir():
                    if f.is_file() and (now - f.stat().st_mtime) > AUDIO_MAX_AGE_S:
                        f.unlink(missing_ok=True)
            except Exception:
                pass

_cleanup_task_ref = None

@app.on_event("startup")
async def _start_cleanup_task():
    global _cleanup_task_ref
    _cleanup_task_ref = asyncio.create_task(_cleanup_temp_files())


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=6969)
