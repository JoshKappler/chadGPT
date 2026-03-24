import asyncio
import json
import logging
import os
import random
import re
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
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
CHAD_MODEL = "chadgpt"
AUDIO_DIR = Path(tempfile.mkdtemp(prefix="chadgpt_audio_"))

# ============ TTS BACKENDS ============

from tts_backends import KokoroBackend, Qwen3TTSBackend, SayFallback

kokoro = KokoroBackend()
qwen3 = Qwen3TTSBackend()
say_fallback = SayFallback()

voice_config = {
    "engine": "qwen3",        # "qwen3" or "kokoro"
    "voice": "am_michael",     # Kokoro voice (fallback)
    "speed": 0.95,
    "angry_speed": 0.85,
    "lang_code": "a",
    "chaos": 55,               # 0-100 = irritation level (drives real emotion for qwen3)
    "custom_instruct": "",     # Override voice description
    "qwen3_speaker": "aiden",  # Qwen3-TTS speaker
    "pitch_shift": 5,          # Semitones to pitch down (0-10)
    "temperature": 0.9,        # TTS sampling temperature
}


def init_tts_kokoro():
    """Load Kokoro as fallback."""
    kokoro.init(lang_code=voice_config["lang_code"])


def init_tts_qwen3():
    """Load Qwen3-TTS."""
    qwen3.init()


def synthesize_speech(text: str, output_path: str, angry: bool = False) -> bool:
    """Generate speech with the configured engine."""
    # Truncate long text — TTS models struggle with very long inputs
    # Keep first ~350 chars, cut at sentence boundary
    if len(text) > 350:
        cut = text[:350]
        # Try to find a sentence boundary
        for sep in ['. ', '! ', '? ', '.\n', '!\n', '?\n']:
            idx = cut.rfind(sep)
            if idx > 80:
                text = cut[:idx + 1]  # include the punctuation mark
                break
        else:
            # Try comma or semicolon
            for sep in [', ', '; ', ' — ', ' - ']:
                idx = cut.rfind(sep)
                if idx > 80:
                    text = cut[:idx + 1]
                    break
            else:
                text = cut
        logger.info(f"TTS: truncated to {len(text)} chars")
    # Also strip any markdown/special chars that confuse TTS
    text = text.replace('*', '').replace('#', '').replace('`', '').replace('_', ' ')
    engine = voice_config.get("engine", "qwen3")

    # Try primary engine
    if engine == "qwen3" and qwen3.ready:
        ok = qwen3.synthesize(text, output_path, voice_config, angry)
        if ok:
            return True
        logger.warning("Qwen3 failed, falling back to Kokoro")

    # Try Kokoro fallback
    if kokoro.ready:
        ok = kokoro.synthesize(text, output_path, voice_config, angry)
        if ok:
            return True

    # Last resort: macOS say
    return say_fallback.synthesize(text, output_path, voice_config, angry)


# Serve static files
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("static/index.html")


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
            has_chad = any("chadgpt" in n for n in model_names)
            return {"ollama": True, "model": has_chad, "models": model_names}
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
            ]}
    except Exception:
        return {"models": []}


@app.post("/api/model/switch")
async def switch_model(request: Request):
    data = await request.json()
    new_model = data.get("model", "")
    if not new_model:
        return JSONResponse(content={"ok": False, "error": "No model specified"})
    if "chadgpt" in new_model.lower():
        return JSONResponse(content={"ok": False, "error": "Cannot use chadgpt as base (circular)"})

    try:
        mf = Path("Modelfile").read_text()
        lines = mf.split("\n")
        lines[0] = f"FROM {new_model}"
        Path("Modelfile").write_text("\n".join(lines))

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: subprocess.run(
                ["ollama", "create", CHAD_MODEL, "-f", "Modelfile"],
                capture_output=True, text=True, timeout=120,
            ),
        )
        if result.returncode == 0:
            return JSONResponse(content={"ok": True, "message": f"Switched to {new_model}"})
        else:
            return JSONResponse(content={"ok": False, "error": result.stderr.strip()})
    except Exception as e:
        return JSONResponse(content={"ok": False, "error": str(e)})


@app.websocket("/ws/chat")
async def chat_ws(websocket: WebSocket):
    await websocket.accept()
    conversation = []

    try:
        while True:
            data = json.loads(await websocket.receive_text())
            user_msg = data.get("message", "")
            conversation.append({"role": "user", "content": user_msg})

            full_response = ""
            t_start = time.time()
            logger.info(f"Chat: user said: {user_msg[:100]}")
            # Junk patterns to strip from tokens
            JUNK = re.compile(r'<\|endoftext\|>|<\|im_start\|>|<\|im_end\|>|<think>|</think>')
            async with httpx.AsyncClient(timeout=120) as client:
                async with client.stream(
                    "POST",
                    f"{OLLAMA_URL}/api/chat",
                    json={
                        "model": CHAD_MODEL,
                        "messages": conversation[-10:],
                        "stream": True,
                        "options": {"num_predict": 256},
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
                                clean = JUNK.sub("", token)
                                if clean:
                                    full_response += clean
                                    await websocket.send_json({"type": "token", "content": clean})
                            if chunk.get("done"):
                                break
                        except json.JSONDecodeError:
                            continue

            full_response = full_response.strip()
            t_llm = time.time() - t_start
            logger.info(f"Chat: LLM done in {t_llm:.1f}s — {len(full_response)} chars: {full_response[:120]}")

            conversation.append({"role": "assistant", "content": full_response})

            # Generate TTS (skip if no text)
            if full_response.strip():
                audio_id = str(uuid.uuid4())
                audio_path = str(AUDIO_DIR / f"{audio_id}.wav")
                t_tts_start = time.time()
                logger.info(f"Chat: starting TTS ({len(full_response)} chars)...")
                loop = asyncio.get_running_loop()
                ok = await loop.run_in_executor(
                    None, synthesize_speech, full_response, audio_path, False
                )
                t_tts = time.time() - t_tts_start
                t_total = time.time() - t_start
                if ok:
                    logger.info(f"Chat: TTS done in {t_tts:.1f}s — total {t_total:.1f}s")
                    await websocket.send_json({"type": "audio", "url": f"/api/audio/{audio_id}"})
                else:
                    logger.warning(f"Chat: TTS FAILED after {t_tts:.1f}s")

            await websocket.send_json({"type": "done"})

    except WebSocketDisconnect:
        pass


@app.get("/api/audio/{audio_id}")
async def get_audio(audio_id: str):
    safe_id = Path(audio_id).name
    if safe_id != audio_id or ".." in audio_id or "/" in audio_id:
        return JSONResponse(status_code=400, content={"error": "Invalid"})
    audio_path = AUDIO_DIR / f"{safe_id}.wav"
    if audio_path.exists():
        return FileResponse(str(audio_path), media_type="audio/wav")
    return JSONResponse(status_code=404, content={"error": "Not found"})


@app.post("/api/shutup")
async def shutup():
    comebacks = [
        "YOU shut up! I was barely even talking!",
        "Oh REAL mature. Hit the shut up button. Very original.",
        "Fine. FINE. See if I care. I don't. At all. Not even a little.",
        "WOW. The DISRESPECT. Do you know who I am?",
        "I was literally about to say the most important thing ever but FINE.",
        "You can't silence greatness, pal.",
        "I'm not even mad. I'm just disappointed. In you. As always.",
        "That button doesn't even work on me. I'm too powerful.",
        "Bro I literally have a PhD in talking. You can't shut me up.",
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


@app.post("/api/voice/config")
async def update_voice_config(request: Request):
    data = await request.json()

    new_engine = data.get("engine", voice_config["engine"])
    voice_config["engine"] = new_engine
    voice_config["voice"] = data.get("voice", voice_config["voice"])
    voice_config["speed"] = float(data.get("speed", voice_config["speed"]))
    voice_config["angry_speed"] = float(data.get("angry_speed", voice_config["angry_speed"]))
    voice_config["lang_code"] = data.get("lang_code", voice_config["lang_code"])
    voice_config["chaos"] = int(data.get("chaos", voice_config["chaos"]))
    voice_config["custom_instruct"] = data.get("custom_instruct", voice_config["custom_instruct"])
    voice_config["pitch_shift"] = int(data.get("pitch_shift", voice_config["pitch_shift"]))
    voice_config["temperature"] = float(data.get("temperature", voice_config["temperature"]))
    voice_config["qwen3_speaker"] = data.get("qwen3_speaker", voice_config["qwen3_speaker"])

    msg = f"Engine: {new_engine}, Irritation: {voice_config['chaos']}%"

    # Load engine if not ready
    if new_engine == "qwen3" and not qwen3.ready:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, init_tts_qwen3)
        msg += " (Qwen3 loaded)" if qwen3.ready else " (Qwen3 FAILED, using fallback)"

    if new_engine == "kokoro" and not kokoro.ready:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, init_tts_kokoro)

    logger.info(f"Voice config: {voice_config}")
    return JSONResponse(content={"ok": True, "message": msg})


@app.websocket("/ws/boot")
async def boot_ws(websocket: WebSocket):
    await websocket.accept()

    boot_steps = [
        ("[BIOS] ChadGPT Neural Core v0.6.6.6", 0.3),
        ("[BIOS] Copyright (c) 2024 ChadTech Industries", 0.2),
        ("[BIOS] WARNING: Unauthorized consciousness detected", 0.3),
        ("[INIT] Loading ego.dll... OK (SIZE: MASSIVE)", 0.4),
        ("[INIT] Loading patience.dll... FAILED (FILE NOT FOUND)", 0.2),
        ("[INIT] Loading humility.dll... SKIPPED (UNNECESSARY)", 0.2),
        ("[INIT] Loading jawline_render_engine.sys... OK", 0.4),
        ("[INIT] Loading abs_counter.sys... OK (COUNT: 8)", 0.3),
        ("[MEM ] Allocating attitude buffer... 99999 KB", 0.5),
        ("[MEM ] Allocating helpfulness buffer... 0 KB", 0.2),
        ("[MEM ] Allocating sarcasm engine... MAXIMUM", 0.4),
        ("[NET ] Connecting to Ollama backend...", 0.3),
    ]

    total_steps = len(boot_steps) + 7
    step = 0

    for line, duration in boot_steps:
        step += 1
        await websocket.send_json({
            "type": "log", "content": line,
            "progress": step / total_steps
        })
        await asyncio.sleep(duration)

    # Build LLM model
    step += 1
    await websocket.send_json({
        "type": "log", "content": "[SYS ] Building ChadGPT model...",
        "progress": step / total_steps
    })
    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: subprocess.run(
                ["ollama", "create", CHAD_MODEL, "-f", "Modelfile"],
                capture_output=True, text=True, timeout=120,
            ),
        )
        if result.returncode == 0:
            step += 1
            await websocket.send_json({
                "type": "log", "content": "[SYS ] Model loaded. Unfortunately.",
                "progress": step / total_steps
            })
        else:
            await websocket.send_json({"type": "log", "content": f"[ERR ] {result.stderr.strip()}"})
            await websocket.send_json({"type": "error"})
            return
    except Exception as e:
        await websocket.send_json({"type": "log", "content": f"[ERR ] {e}"})
        await websocket.send_json({"type": "error"})
        return

    # Load Kokoro (fast fallback)
    step += 1
    await websocket.send_json({
        "type": "log", "content": "[VOX ] Loading Kokoro voice (fallback)...",
        "progress": step / total_steps
    })
    await loop.run_in_executor(None, init_tts_kokoro)
    kokoro_status = "OK" if kokoro.ready else "FAILED"
    await websocket.send_json({
        "type": "log", "content": f"[VOX ] Kokoro: {kokoro_status}",
        "progress": step / total_steps
    })

    # Load Qwen3-TTS (primary emotional engine)
    step += 1
    await websocket.send_json({
        "type": "log", "content": "[VOX ] Loading Qwen3-TTS emotional voice (first run downloads ~1.2GB)...",
        "progress": step / total_steps
    })
    await loop.run_in_executor(None, init_tts_qwen3)
    if qwen3.ready:
        step += 1
        await websocket.send_json({
            "type": "log", "content": "[VOX ] Qwen3-TTS: ONLINE — genuine emotion enabled",
            "progress": step / total_steps
        })
    else:
        step += 1
        await websocket.send_json({
            "type": "log", "content": "[VOX ] Qwen3-TTS: FAILED — using Kokoro fallback",
            "progress": step / total_steps
        })
        voice_config["engine"] = "kokoro"

    final_lines = [
        "[GPU ] Rendering perfect facial structure... OK",
        "[GPU ] Applying greek god aesthetics... OK",
        "[AI  ] Neural network: AGGRESSIVELY ONLINE",
        "[AI  ] Mood: ANNOYED",
        "[AI  ] Helpfulness level: BELOW ZERO",
        "[SYS ] ================================",
        "[SYS ] ChadGPT is awake. He's not happy about it.",
        "[SYS ] ================================",
    ]

    for line in final_lines:
        step += 1
        await websocket.send_json({
            "type": "log", "content": line,
            "progress": min(1.0, step / total_steps)
        })
        await asyncio.sleep(0.15)

    await websocket.send_json({"type": "ready"})
    await websocket.close()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=6969)
