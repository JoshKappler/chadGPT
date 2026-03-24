// ChadGPT Main Application

let powered = false;
let booted = false;
let chatWs = null;
let isStreaming = false;

// ============ POWER / BOOT ============

let bootAudioEl = null;

function togglePower() {
    if (powered) {
        playSoundFile('/static/switch.wav');
        setTimeout(() => playSoundFile('/static/shutdown.wav'), 150);
        powerOff();
    } else {
        playSoundFile('/static/switch.wav');
        setTimeout(() => playBootSound(), 200);
        unlockAudio();
        powerOn();
    }
}

// Boot sound: HTML5 Audio for the initial play, then Web Audio API for gapless loop
let bootLoopCtx = null;
let bootLoopSource = null;
let bootLoopGain = null;

function playBootSound() {
    try {
        bootAudioEl = new Audio('/static/boot.wav');
        const volSlider = document.getElementById('boot-volume');
        const maxVol = volSlider ? parseInt(volSlider.value) / 100 : 1.0;
        bootAudioEl.volume = maxVol;
        bootAudioEl.loop = false;
        bootAudioEl.play().catch(e => console.warn('Boot sound failed:', e));
    } catch(e) {}
}

// After boot: crossfade HTML5 Audio out, Web Audio API gapless loop in at 35%
function fadeOutBootSound() {
    if (!bootAudioEl) return;
    const volSlider = document.getElementById('boot-volume');
    const maxVol = volSlider ? parseInt(volSlider.value) / 100 : 1.0;
    const targetVol = maxVol * 0.35;

    // Start the gapless Web Audio loop
    startBootLoop(targetVol);

    // Fade out the HTML5 Audio element over 4 seconds
    const startVol = bootAudioEl.volume;
    const fadeSteps = 80;
    const fadeInterval = 4000 / fadeSteps;
    let step = 0;
    const fade = setInterval(() => {
        step++;
        if (bootAudioEl) {
            bootAudioEl.volume = startVol * Math.max(0, 1 - step / fadeSteps);
        }
        if (step >= fadeSteps) {
            clearInterval(fade);
            if (bootAudioEl) { bootAudioEl.pause(); bootAudioEl = null; }
        }
    }, fadeInterval);
}

async function startBootLoop(vol) {
    try {
        bootLoopCtx = new (window.AudioContext || window.webkitAudioContext)();
        const response = await fetch('/static/boot.wav');
        const arrayBuffer = await response.arrayBuffer();
        const buffer = await bootLoopCtx.decodeAudioData(arrayBuffer);

        bootLoopGain = bootLoopCtx.createGain();
        bootLoopGain.gain.setValueAtTime(0, bootLoopCtx.currentTime);
        bootLoopGain.connect(bootLoopCtx.destination);

        bootLoopSource = bootLoopCtx.createBufferSource();
        bootLoopSource.buffer = buffer;
        bootLoopSource.loop = true; // Web Audio API = gapless loop
        bootLoopSource.connect(bootLoopGain);
        bootLoopSource.start(0);

        // Fade in over 2 seconds to the target volume
        bootLoopGain.gain.linearRampToValueAtTime(vol, bootLoopCtx.currentTime + 2);
    } catch(e) {
        console.warn('Boot loop failed:', e);
    }
}

function stopBootLoop() {
    if (bootLoopGain && bootLoopCtx) {
        try {
            bootLoopGain.gain.linearRampToValueAtTime(0, bootLoopCtx.currentTime + 0.5);
            setTimeout(() => {
                if (bootLoopSource) { try { bootLoopSource.stop(); } catch(e) {} bootLoopSource = null; }
            }, 600);
        } catch(e) {}
    }
}

function playSoundFile(url) {
    try {
        const a = new Audio(url);
        const volSlider = document.getElementById('boot-volume');
        a.volume = volSlider ? parseInt(volSlider.value) / 100 : 1.0;
        a.play().catch(e => console.warn('Sound failed:', e));
    } catch(e) {}
}

function playGlitchSound() {
    try {
        const a = new Audio('/static/glitch.wav');
        a.volume = 0.12 + Math.random() * 0.12;
        a.playbackRate = 0.8 + Math.random() * 0.6;
        a.play().catch(() => {});
    } catch(e) {}
}

function playSpikeSound() {
    try {
        const a = new Audio('/static/spike.wav');
        a.volume = 0.15 + Math.random() * 0.15;
        a.playbackRate = 0.9 + Math.random() * 0.3;
        a.play().catch(() => {});
    } catch(e) {}
}

async function powerOn() {
    powered = true;

    document.getElementById('lever-container').classList.add('on');
    await delay(200);

    const indicator = document.getElementById('power-indicator');
    for (let i = 0; i < 5; i++) {
        indicator.classList.toggle('on');
        await delay(80 + Math.random() * 120);
    }
    indicator.classList.add('on');

    staticEffect.setIntensity(0.5);
    await delay(100);
    staticEffect.setIntensity(0.02);
    await delay(50);
    staticEffect.setIntensity(0.4);
    flickerEffect.glitchScreen();
    playGlitchSound();
    await delay(150);

    const app = document.getElementById('app');
    app.style.transition = 'none';
    for (let i = 0; i < 6; i++) {
        app.classList.toggle('powered');
        await delay(40 + Math.random() * 80);
    }
    app.classList.add('powered');
    app.style.transition = '';

    const title = document.getElementById('title');
    const orig = title.textContent;
    const g = '█▓▒░╠╣╚╝┼┤├┬┴╬▄▀';
    for (let i = 0; i < 4; i++) {
        title.textContent = orig.split('').map(c =>
            Math.random() > 0.5 ? g[Math.floor(Math.random() * g.length)] : c
        ).join('');
        await delay(60);
    }
    title.textContent = orig;

    staticEffect.setIntensity(0.15);
    document.getElementById('status-dot').classList.add('booting');
    document.getElementById('status-text').textContent = 'BOOTING...';
    document.getElementById('boot-terminal').classList.add('visible');
    document.getElementById('chat-messages').classList.remove('visible');

    // Reset progress bar
    document.getElementById('boot-progress-fill').style.width = '0%';

    // Start ambient hum
    if (ambientHum) ambientHum.start();

    // Lights flicker before stabilizing (like old fluorescent tubes)
    await flickerEffect.lightsFlicker();
    await flickerEffect.bootFlicker();
    staticEffect.setIntensity(0.06);

    startBoot();
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ AUDIO ============

function unlockAudio() {
    if (document.getElementById('chad-audio')) return;
    const el = document.createElement('audio');
    el.id = 'chad-audio';
    el.preload = 'auto';
    document.body.appendChild(el);
    el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    el.play().catch(() => {});
}

function playAudio(url) {
    const el = document.getElementById('chad-audio');
    if (!el) return;
    el.onplay = () => { if (chadAvatar) chadAvatar.startTalking(); };
    el.onended = () => { if (chadAvatar) chadAvatar.stopTalking(); };
    el.onpause = () => { if (chadAvatar) chadAvatar.stopTalking(); };
    el.onerror = () => { if (chadAvatar) chadAvatar.stopTalking(); };
    el.src = url;
    el.play().catch(() => { if (chadAvatar) chadAvatar.stopTalking(); });
}

function stopAudio() {
    const el = document.getElementById('chad-audio');
    if (el) { el.pause(); el.currentTime = 0; }
    if (chadAvatar) chadAvatar.stopTalking();
}

// ============ BOOT ============

function startBoot() {
    document.getElementById('boot-log').innerHTML = '';
    const ws = new WebSocket(`ws://${window.location.host}/ws/boot`);

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'log') {
            addBootLine(data.content);
            // Update main progress bar
            if (data.progress) {
                document.getElementById('boot-progress-fill').style.width =
                    Math.round(data.progress * 100) + '%';
            }
            // Chaotic audio-visual glitches during boot
            if (Math.random() > 0.4) {
                staticEffect.spike(0.1 + Math.random() * 0.2);
                flickerEffect.flicker(1);
                if (Math.random() > 0.5) playGlitchSound();
            }
            if (Math.random() > 0.7) {
                flickerEffect.glitchScreen();
            }
        } else if (data.type === 'ready') {
            document.getElementById('boot-progress-fill').style.width = '100%';
            bootComplete();
        } else if (data.type === 'error') {
            addBootLine('[FATAL] Boot failed. Chad refuses to wake up.', 'error');
            document.getElementById('status-text').textContent = 'ERROR';
            document.getElementById('status-dot').classList.remove('booting');
        }
    };
    ws.onerror = () => {
        addBootLine('[FATAL] Cannot connect to server.', 'error');
    };
}

function addBootLine(text, type = '') {
    const log = document.getElementById('boot-log');
    const line = document.createElement('div');
    line.className = `boot-line ${type}`;

    // Add mini progress bar to each line
    const bar = document.createElement('div');
    bar.className = 'line-bar';
    const fill = document.createElement('div');
    fill.className = 'line-bar-fill';
    bar.appendChild(fill);

    const span = document.createElement('span');
    span.textContent = text;

    line.appendChild(bar);
    line.appendChild(span);

    if (text.includes('OK') || text.includes('ONLINE') || text.includes('MAXIMUM')) {
        line.classList.add('success');
    } else if (text.includes('FAIL') || text.includes('ERR')) {
        line.classList.add('error');
    }

    log.appendChild(line);
    document.getElementById('boot-terminal').scrollTop =
        document.getElementById('boot-terminal').scrollHeight;
}

function bootComplete() {
    booted = true;
    // Mark boot completion for glitch tapering system
    if (typeof bootCompletedAt !== 'undefined') bootCompletedAt = Date.now();
    // Slowly fade out the looping boot sound over 4 seconds
    fadeOutBootSound();
    staticEffect.setIntensity(0.2);
    flickerEffect.bootFlicker().then(() => staticEffect.setIntensity(0.04));
    playGlitchSound();
    // Extra glitch burst right at boot completion (intense then tapering)
    for (let i = 0; i < 5; i++) {
        setTimeout(() => flickerEffect.glitchScreen(), i * 200 + Math.random() * 100);
    }

    setTimeout(() => {
        document.getElementById('boot-terminal').classList.remove('visible');
        document.getElementById('chat-messages').classList.add('visible');
        document.getElementById('status-dot').classList.remove('booting');
        document.getElementById('status-dot').classList.add('online');
        document.getElementById('status-text').textContent = 'ONLINE — HOSTILE';
        document.getElementById('chat-input').disabled = false;
        document.getElementById('send-btn').disabled = false;
        document.getElementById('shutup-btn').disabled = false;
        document.getElementById('chat-input').focus();
        if (chadAvatar) chadAvatar.wake();
        connectChat();
        addMessage('system', '[ ChadGPT is online. He is not pleased about this. ]');
        flickerEffect.glitchScreen();
        playGlitchSound();

        // Load available models for settings
        loadModelList();
    }, 800);
}

// ============ CHAT ============

function connectChat() {
    chatWs = new WebSocket(`ws://${window.location.host}/ws/chat`);
    chatWs.onmessage = (event) => handleChatMessage(JSON.parse(event.data));
    chatWs.onclose = () => { if (booted) setTimeout(connectChat, 2000); };
}

function handleChatMessage(data) {
    switch (data.type) {
        case 'token':
            appendToCurrentResponse(data.content);
            // Subtle static spike on each token batch
            if (Math.random() > 0.85) staticEffect.spike(0.04, 60);
            break;
        case 'audio': playAudio(data.url); break;
        case 'done': finishResponse(); break;
        case 'error': addMessage('system', `[ Error: ${data.content} ]`); finishResponse(); break;
    }
}

function sendMessage() {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if (!msg || !chatWs || chatWs.readyState !== WebSocket.OPEN || isStreaming) return;

    addMessage('user', msg);
    input.value = '';
    chatWs.send(JSON.stringify({ message: msg }));
    isStreaming = true;
    document.getElementById('send-btn').disabled = true;
    createResponsePlaceholder();

    // Message send: visual glitch burst + static spike
    flickerEffect.glitchBurst(3);
    staticEffect.spike(0.15, 200);
    playGlitchSound();
    // Bump ambient hum briefly
    if (ambientHum && ambientHum.active) {
        ambientHum.setVolume(0.15);
        setTimeout(() => ambientHum.setVolume(0.08), 500);
    }

    setTimeout(() => { if (isStreaming) finishResponse(); }, 120000);
}

function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
}

function addMessage(type, content) {
    const c = document.getElementById('chat-messages');
    const m = document.createElement('div');
    m.className = `message ${type}`;
    m.textContent = content;
    c.appendChild(m);
    c.scrollTop = c.scrollHeight;
}

function createResponsePlaceholder() {
    const c = document.getElementById('chat-messages');
    const m = document.createElement('div');
    m.className = 'message chad';
    m.id = 'current-response';
    const s = document.createElement('span');
    s.id = 'response-text';
    m.appendChild(s);
    const cur = document.createElement('span');
    cur.textContent = '█';
    cur.style.animation = 'cursor-blink 0.7s step-end infinite';
    cur.id = 'response-cursor';
    m.appendChild(cur);
    c.appendChild(m);
    c.scrollTop = c.scrollHeight;
}

function appendToCurrentResponse(token) {
    const s = document.getElementById('response-text');
    if (s) {
        s.textContent += token;
        document.getElementById('chat-messages').scrollTop =
            document.getElementById('chat-messages').scrollHeight;
    }
}

function finishResponse() {
    isStreaming = false;
    document.getElementById('send-btn').disabled = false;
    const cur = document.getElementById('response-cursor');
    if (cur) cur.remove();
    const r = document.getElementById('current-response');
    if (r) r.removeAttribute('id');
    const s = document.getElementById('response-text');
    if (s) s.removeAttribute('id');
    // Subtle glitch on response complete
    flickerEffect.glitchScreen();
}

// ============ POWER OFF ============

function powerOff() {
    powered = false;
    booted = false;
    flickerEffect.bootFlicker();
    playGlitchSound();

    document.getElementById('lever-container').classList.remove('on');
    document.getElementById('power-indicator').classList.remove('on');
    document.getElementById('app').classList.remove('powered');
    document.getElementById('status-dot').classList.remove('online', 'booting');
    document.getElementById('status-text').textContent = 'OFFLINE';
    document.getElementById('chat-input').disabled = true;
    document.getElementById('send-btn').disabled = true;
    document.getElementById('shutup-btn').disabled = true;
    document.getElementById('boot-terminal').classList.remove('visible');
    document.getElementById('chat-messages').classList.remove('visible');
    document.getElementById('boot-log').innerHTML = '';
    document.getElementById('chat-messages').innerHTML = '';

    if (chatWs) { chatWs.close(); chatWs = null; }
    stopAudio();
    if (bootAudioEl) { bootAudioEl.pause(); bootAudioEl = null; }
    stopBootLoop();
    if (chadAvatar) chadAvatar.sleep();
    if (ambientHum) ambientHum.stop();
    staticEffect.setIntensity(0.04);
    flickerEffect.glitchScreen();
}

// ============ SHUT UP ============

async function shutUp() {
    if (!booted) return;
    stopAudio();
    flickerEffect.glitchBurst(4);
    staticEffect.spike(0.2, 300);
    playGlitchSound();
    try {
        const resp = await fetch('/api/shutup', { method: 'POST' });
        const data = await resp.json();
        addMessage('chad', data.message);
        if (data.audio_url) setTimeout(() => playAudio(data.audio_url), 300);
    } catch (err) {
        addMessage('system', '[ Chad is too angry to respond ]');
    }
}

// ============ SETTINGS ============

function toggleSettings() {
    document.getElementById('settings-panel').classList.toggle('open');
    flickerEffect.flicker(1);
}

async function loadModelList() {
    try {
        const resp = await fetch('/api/models');
        const data = await resp.json();
        const select = document.getElementById('llm-select');
        select.innerHTML = '';
        for (const m of data.models) {
            const opt = document.createElement('option');
            opt.value = m.name;
            const sizeMB = Math.round(m.size / 1024 / 1024);
            opt.textContent = `${m.name} (${sizeMB}MB)`;
            select.appendChild(opt);
        }
    } catch(e) {}
}

async function switchLLM() {
    const model = document.getElementById('llm-select').value;
    if (!model) return;
    const status = document.getElementById('llm-status');
    status.textContent = 'SWITCHING...';
    status.style.color = 'var(--amber)';
    try {
        const resp = await fetch('/api/model/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model }),
        });
        const data = await resp.json();
        status.textContent = data.ok ? data.message : 'ERROR: ' + data.error;
        status.style.color = data.ok ? 'var(--green)' : 'var(--red)';
    } catch(e) {
        status.textContent = 'FAILED';
        status.style.color = 'var(--red)';
    }
    setTimeout(() => { status.textContent = ''; }, 5000);
}

async function applyVoiceSettings() {
    const engine = document.getElementById('tts-engine').value;
    const settings = {
        engine: engine,
        voice: document.getElementById('voice-select')?.value || 'am_michael',
        speed: parseFloat(document.getElementById('voice-speed')?.value || 0.95),
        angry_speed: 0.85,
        lang_code: document.getElementById('lang-code')?.value || 'a',
        chaos: parseInt(document.getElementById('voice-chaos').value),
        custom_instruct: document.getElementById('custom-instruct')?.value || '',
        pitch_shift: parseInt(document.getElementById('voice-pitch')?.value || 5),
        temperature: parseFloat(document.getElementById('voice-temp')?.value || 0.9),
        qwen3_speaker: document.getElementById('qwen3-speaker')?.value || 'aiden',
    };

    const status = document.getElementById('settings-status');
    status.textContent = 'APPLYING...';
    status.style.color = 'var(--amber)';

    try {
        const resp = await fetch('/api/voice/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings),
        });
        const data = await resp.json();
        status.textContent = data.ok ? data.message : 'ERROR';
        status.style.color = data.ok ? 'var(--green)' : 'var(--red)';
    } catch(e) {
        status.textContent = 'FAILED';
        status.style.color = 'var(--red)';
    }
    setTimeout(() => { status.textContent = ''; }, 4000);
}

// Slider value displays
document.addEventListener('DOMContentLoaded', () => {
    const bind = (id, displayId, suffix = '') => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', () => {
            document.getElementById(displayId).textContent = el.value + suffix;
        });
    };
    bind('voice-speed', 'speed-val');
    bind('angry-speed', 'angry-speed-val');
    bind('voice-chaos', 'chaos-val', '%');
    bind('voice-pitch', 'pitch-val');
    bind('voice-temp', 'temp-val');
    bind('boot-volume', 'boot-vol-val', '%');

    // Auto-select lang code
    const voiceSelect = document.getElementById('voice-select');
    if (voiceSelect) {
        voiceSelect.addEventListener('change', () => {
            document.getElementById('lang-code').value =
                voiceSelect.value.startsWith('bm_') ? 'b' : 'a';
        });
    }

    // Engine toggle: show/hide Kokoro vs Qwen3 settings
    const engineSelect = document.getElementById('tts-engine');
    if (engineSelect) {
        engineSelect.addEventListener('change', () => {
            const isQwen = engineSelect.value === 'qwen3';
            document.getElementById('kokoro-settings').style.display = isQwen ? 'none' : 'block';
            document.getElementById('qwen3-advanced').style.display = isQwen ? 'block' : 'none';
        });
    }
});
