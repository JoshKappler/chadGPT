// ChadGPT Main Application

let powered = false;
let booted = false;
let chatWs = null;
let isStreaming = false;

// Streaming stats
let _streamTokenCount = 0;
let _streamStartTime = 0;

// Irritation tracking
let _currentIrritation = 30;
let _msgCount = 0;

// Command history
let _cmdHistory = [];
let _cmdHistoryIdx = -1;
let _cmdDraft = '';

// ASCII CHAD logo using |, \, _, -, / characters
const CHAD_LOGO = [
    '   /----\\  |    |   /--\\    |----\\ ',
    '  /        |    |  /    \\   |     \\',
    ' |         |----| /------\\  |      |',
    ' |         |    | |      |  |      |',
    '  \\        |    | |      |  |     /',
    '   \\----/  |    | |      |  |----/ ',
].join('\n');

// ============ POWER / BOOT ============

// Audio engine: see static/audio.js (chadAudio global)

function togglePower() {
    if (powered) {
        playSoundFile('/static/switch.wav');
        setTimeout(() => playSoundFile('/static/shutdown.wav'), 150);
        powerOff();
    } else {
        // Flip the power stage lever first
        document.getElementById('power-stage').classList.add('on');
        unlockAudio();
        // Init audio engine inside user gesture (required for AudioContext)
        chadAudio.init().then(() => {
            chadAudio.setVolume(getBootVolume());
            // LOUD substation breaker sound on connect
            chadAudio.playSubstationSwitch();
            chadAudio.startBoot();
        });
        // Delay boot slightly so lever animation completes
        setTimeout(() => powerOn(), 600);
    }
}

// Audio is handled by chadAudio (static/audio.js)
// Boot volume helper for the volume slider
function getBootVolume() {
    const s = document.getElementById('boot-volume');
    return s ? parseInt(s.value) / 100 : 1.0;
}

function playSoundFile(url) {
    try {
        const a = new Audio(url);
        const volSlider = document.getElementById('boot-volume');
        a.volume = volSlider ? parseInt(volSlider.value) / 100 : 1.0;
        a.play().catch(e => console.warn('Sound failed:', e));
    } catch(e) {}
}


async function powerOn() {
    powered = true;

    const app = document.getElementById('app');
    const powerStage = document.getElementById('power-stage');

    // Phase 1: Glitch the power stage away
    staticEffect.setIntensity(0.5);
    await delay(100);
    staticEffect.setIntensity(0.02);
    await delay(50);
    staticEffect.setIntensity(0.4);
    flickerEffect.glitchScreen();
    await delay(200);

    // Hide power stage, reveal app
    powerStage.classList.add('hidden');
    app.classList.remove('pre-boot');
    app.style.visibility = 'visible';

    // Start with everything hidden, reveal piece by piece
    const header = document.getElementById('header');
    const main = document.getElementById('main');
    header.style.opacity = '0';
    main.style.opacity = '0';

    document.getElementById('lever-container').classList.add('on');

    const indicator = document.getElementById('power-indicator');
    for (let i = 0; i < 5; i++) {
        indicator.classList.toggle('on');
        await delay(80 + Math.random() * 120);
    }
    indicator.classList.add('on');

    // Glitch header into existence
    app.style.transition = 'none';
    for (let i = 0; i < 6; i++) {
        app.classList.toggle('powered');
        await delay(40 + Math.random() * 80);
    }
    app.classList.add('powered');
    app.style.transition = '';

    // Reveal header with glitch
    header.style.transition = 'none';
    header.style.opacity = '1';
    header.classList.add('boot-reveal');
    flickerEffect.glitchBurst(3);
    staticEffect.spike(0.2, 200);
    await delay(400);
    header.classList.remove('boot-reveal');

    // Glitch the title — scramble then resolve
    const title = document.getElementById('title');
    const origTitle = 'ChadGPT'; // hardcoded to avoid capturing a mid-glitch state
    const g = '█▓▒░╠╣╚╝┼┤├┬┴╬▄▀';
    try {
        for (let i = 0; i < 8; i++) {
            title.textContent = origTitle.split('').map(c =>
                Math.random() > (i / 8) ? g[Math.floor(Math.random() * g.length)] : c
            ).join('');
            await delay(60);
        }
    } finally {
        title.textContent = origTitle;
    }

    // Reveal main content area
    main.style.transition = 'none';
    main.style.opacity = '1';
    main.classList.add('boot-reveal');
    flickerEffect.glitchScreen();
    staticEffect.spike(0.15, 150);
    await delay(300);
    main.classList.remove('boot-reveal');

    // Mark boot assembly phase for glitch system
    if (typeof avatarGlitchSystem !== 'undefined') {
        avatarGlitchSystem._bootAssembly = true;
    }

    staticEffect.setIntensity(0.15);
    document.getElementById('status-dot').classList.add('booting');
    document.getElementById('status-text').textContent = 'BOOTING...';
    document.getElementById('boot-terminal').classList.add('visible');
    document.getElementById('chat-messages').classList.remove('visible');
    updateBootProgress(0);

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

// Mouth sync — simulated amplitude from audio playback
// (Using a real AnalyserNode requires routing through a separate AudioContext
// which kills playback. This approach is visually convincing without touching audio.)
let _lastAudioTime = 0;
let _audioPlaying = false;

// Global function — called from the Three.js animation loop in index.html
function getVoiceAmplitude() {
    var el = document.getElementById('chad-audio');
    if (!el || el.paused || el.ended) { _audioPlaying = false; return 0; }
    // Detect if audio is actually advancing
    if (el.currentTime !== _lastAudioTime) {
        _lastAudioTime = el.currentTime;
        _audioPlaying = true;
    }
    if (!_audioPlaying) return 0;
    // Generate a convincing speech-like amplitude pattern:
    // - Fast oscillation (jaw open/close at ~8-12Hz, natural speech rate)
    // - Slower modulation (word/phrase rhythm at ~2-3Hz)
    // - Random variation (so it doesn't look mechanical)
    var t = performance.now() * 0.001;
    var jaw = Math.abs(Math.sin(t * 10.5)) * 0.6;         // fast jaw flap
    var phrase = Math.abs(Math.sin(t * 2.7)) * 0.3 + 0.1; // phrase rhythm
    var noise = Math.random() * 0.15;                       // random variation
    // Occasional brief pauses (natural speech has gaps)
    var gap = Math.sin(t * 1.3) > 0.7 ? 0.1 : 1.0;
    return Math.min(1.0, (jaw + phrase + noise) * gap);
}

function playAudio(url) {
    const el = document.getElementById('chad-audio');
    if (!el) return;
    el.volume = 1.0;  // Max volume — Chad speaks LOUD
    _lastAudioTime = 0;
    _audioPlaying = false;
    el.onplay = () => { if (chadAvatar) chadAvatar.startTalking(); };
    el.onended = () => { if (chadAvatar) chadAvatar.stopTalking(); _idleTaunting = false; startIdleTimer(); };
    el.onpause = () => { if (chadAvatar) chadAvatar.stopTalking(); };
    el.onerror = () => { if (chadAvatar) chadAvatar.stopTalking(); _idleTaunting = false; startIdleTimer(); };
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
            // Update ZSH-style progress bar
            if (data.progress) {
                updateBootProgress(data.progress);
            }
            // Visual glitches during boot (beeping is rare)
            if (Math.random() > 0.5) {
                staticEffect.spike(0.1 + Math.random() * 0.2);
                flickerEffect.flicker(1);
            }
            if (Math.random() > 0.7) {
                flickerEffect.glitchScreen();
            }
        } else if (data.type === 'ready') {
            updateBootProgress(1.0);
            bootComplete();
        } else if (data.type === 'error') {
            addBootLine('[FATAL] Boot failed.', 'error');
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

    // Terminal-style: just the text, color-coded by content
    line.textContent = text;

    if (text.includes('OK') || text.includes('ONLINE') || text.includes('CONNECTED') || text.includes('ready')) {
        line.classList.add('success');
    } else if (text.includes('FAIL') || text.includes('ERR') || text.includes('UNREACHABLE')) {
        line.classList.add('error');
    }

    log.appendChild(line);
    document.getElementById('boot-terminal').scrollTop =
        document.getElementById('boot-terminal').scrollHeight;
}

function updateBootProgress(progress) {
    const bar = document.getElementById('boot-progress-bar');
    const width = 40;
    const filled = Math.round(progress * width);
    const empty = width - filled;
    const pct = Math.round(progress * 100);
    bar.textContent = '[' + '\u2588'.repeat(filled) + '\u2591'.repeat(empty) + '] ' + pct + '%';
}

function bootComplete() {
    booted = true;
    // Mark boot completion for glitch tapering system
    if (typeof bootCompletedAt !== 'undefined') bootCompletedAt = Date.now();
    // Crossfade from boot sound to session loop
    chadAudio.transitionToSession();
    staticEffect.setIntensity(0.2);
    flickerEffect.bootFlicker().then(() => staticEffect.setIntensity(0.04));
    // Visual-only glitch burst at boot completion
    for (let i = 0; i < 5; i++) {
        setTimeout(() => flickerEffect.glitchScreen(), i * 200 + Math.random() * 100);
    }

    // Stop avatar boot assembly overlay
    if (typeof avatarGlitchSystem !== 'undefined') {
        avatarGlitchSystem._bootAssembly = false;
    }

    setTimeout(() => {
        // Move boot log content into chat area so it persists
        const chatMessages = document.getElementById('chat-messages');
        const bootLog = document.getElementById('boot-log');
        const bootBar = document.getElementById('boot-progress-bar');

        // Clone boot content into chat feed
        const archive = document.createElement('div');
        archive.className = 'boot-log-archive';
        // Include the final progress bar state
        const barClone = document.createElement('div');
        barClone.className = 'boot-progress-text';
        barClone.textContent = bootBar.textContent;
        archive.appendChild(barClone);
        // Clone all boot lines
        Array.from(bootLog.children).forEach(el => {
            archive.appendChild(el.cloneNode(true));
        });
        chatMessages.appendChild(archive);

        // Add separator
        const sep1 = document.createElement('div');
        sep1.className = 'boot-separator';
        sep1.textContent = '='.repeat(56);
        chatMessages.appendChild(sep1);

        // Add CHAD ASCII logo
        const logo = document.createElement('pre');
        logo.className = 'chad-logo-ascii';
        logo.textContent = CHAD_LOGO;
        chatMessages.appendChild(logo);

        // Add acronym
        const acronym = document.createElement('div');
        acronym.className = 'chad-acronym';
        acronym.textContent = 'Comprehensively Horrible Advice Dispenser';
        chatMessages.appendChild(acronym);

        // Second separator
        const sep2 = document.createElement('div');
        sep2.className = 'boot-separator';
        sep2.textContent = '='.repeat(56);
        chatMessages.appendChild(sep2);

        // Now hide boot terminal and show chat
        document.getElementById('boot-terminal').classList.remove('visible');
        document.getElementById('chat-messages').classList.add('visible');
        document.getElementById('status-dot').classList.remove('booting');
        document.getElementById('status-dot').classList.add('online');
        document.getElementById('status-text').textContent = 'ONLINE';
        startMetricsTicker();
        document.getElementById('chat-input').disabled = false;
        document.getElementById('send-btn').disabled = false;
        document.getElementById('shutup-btn').disabled = false;
        document.getElementById('vision-btn').disabled = false;
        document.getElementById('chat-input').focus();

        if (chadAvatar) chadAvatar.wake();
        // Start periodic avatar glitch effects (CSS-based, no canvas)
        if (typeof avatarGlitchSystem !== 'undefined') {
            avatarGlitchSystem.start();
        }

        connectChat();
        flickerEffect.glitchScreen();
        // Start ambient glitch sounds (random digital chirps, crackles, hums)
        chadAudio.startAmbientGlitches();
        // Start periodic random visual glitches
        startAmbientVisualGlitches();
        // Start idle taunt timer
        _idleTauntCount = 0;
        startIdleTimer();

        // Scroll to bottom so user sees the latest
        chatMessages.scrollTop = chatMessages.scrollHeight;

        loadModelList();
        loadSavedVoiceSettings();
    }, 800);
}

// Periodic ambient visual glitches — random screen effects paired with matching audio
let _ambientVisualTimer = null;
function startAmbientVisualGlitches() {
    if (_ambientVisualTimer) return;
    function scheduleNext() {
        const delay = 3000 + Math.random() * 10000; // every 3-13 seconds
        _ambientVisualTimer = setTimeout(() => {
            if (!booted) return;
            const r = Math.random();
            if (r < 0.18) {
                // Single subtle glitch
                flickerEffect.glitchScreen();
            } else if (r < 0.28) {
                // Static spike + tape hiss
                staticEffect.spike(0.08 + Math.random() * 0.12, 100 + Math.random() * 200);
                if (typeof chadAudio !== 'undefined') chadAudio.playTapeHiss();
            } else if (r < 0.38) {
                // Quick double glitch + head switch click
                flickerEffect.glitchScreen();
                if (typeof chadAudio !== 'undefined') chadAudio.playHeadSwitch();
                setTimeout(() => flickerEffect.glitchScreen(), 80 + Math.random() * 60);
            } else if (r < 0.48) {
                // Flicker + static combo
                flickerEffect.flicker(1);
                staticEffect.spike(0.15, 150);
            } else if (r < 0.56) {
                // Tape warble — paired audio + visual wobble
                flickerEffect.glitchScreen();
                if (typeof chadAudio !== 'undefined') chadAudio.playTapeWarble();
            } else if (r < 0.64) {
                // Dropout — brief signal loss (audio + visual)
                if (typeof chadAudio !== 'undefined') chadAudio.playDropout();
                flickerEffect._setBrightness(0.2 + Math.random() * 0.3);
                setTimeout(() => flickerEffect._clearBrightness(), 50 + Math.random() * 100);
            } else if (r < 0.72) {
                // VHS tracking sweep + crackle
                flickerEffect.glitchScreen();
                if (typeof chadAudio !== 'undefined') chadAudio.playGlitch();
                staticEffect.spike(0.12, 200);
            } else if (r < 0.80) {
                // Mini burst — 3 rapid glitches + tape warble
                flickerEffect.glitchBurst(3);
                staticEffect.spike(0.1, 300);
                if (typeof chadAudio !== 'undefined') chadAudio.playTapeWarble();
            } else if (r < 0.85) {
                // Chroma + hiss — color aberration with matching sound
                flickerEffect.glitchScreen();
                if (typeof chadAudio !== 'undefined') chadAudio.playTapeHiss();
                setTimeout(() => flickerEffect.glitchScreen(), 120);
            } else if (r < 0.90) {
                // 8-bit chirp + static spike (FNAF corridor vibe)
                staticEffect.spike(0.1, 150);
                if (typeof chadAudio !== 'undefined') chadAudio.play8bitChirp();
            } else if (r < 0.95) {
                // 8-bit stinger + flicker (FNAF camera switch)
                flickerEffect.glitchScreen();
                flickerEffect.flicker(1);
                if (typeof chadAudio !== 'undefined') {
                    chadAudio.play8bitStinger();
                    setTimeout(() => chadAudio.play8bitNoise(), 80);
                }
            } else {
                // Heavy compound glitch — 8-bit + analog combined
                flickerEffect.glitchBurst(2);
                staticEffect.spike(0.2, 250);
                if (typeof chadAudio !== 'undefined') {
                    chadAudio.playHeadSwitch();
                    setTimeout(() => chadAudio.play8bitChirp(), 60);
                    setTimeout(() => chadAudio.play8bitNoise(), 150);
                }
                setTimeout(() => flickerEffect.glitchScreen(), 150);
            }
            scheduleNext();
        }, delay);
    }
    scheduleNext();
}
function stopAmbientVisualGlitches() {
    if (_ambientVisualTimer) { clearTimeout(_ambientVisualTimer); _ambientVisualTimer = null; }
}

// ============ METRICS TICKER ============

let metricsInterval = null;

function startMetricsTicker() {
    const el = document.getElementById('status-metrics');
    if (!el) return;
    // Show warnings
    const w = document.getElementById('warnings-section');
    if (w) w.style.display = 'flex';

    async function tick() {
        try {
            const resp = await fetch('/api/metrics');
            const m = await resp.json();
            const upH = Math.floor(m.uptime_s / 3600);
            const upM = Math.floor((m.uptime_s % 3600) / 60);
            const upS = m.uptime_s % 60;
            const uptime = upH > 0 ? `${upH}h${upM}m` : upM > 0 ? `${upM}m${upS}s` : `${upS}s`;
            el.textContent = `UP:${uptime}  MEM:${m.mem_mb}MB  REQ:${m.requests}  LAT:${m.avg_latency_ms}ms  PID:${m.pid}`;
        } catch {
            el.textContent = 'METRICS UNAVAILABLE';
        }
    }
    tick();
    if (metricsInterval) clearInterval(metricsInterval);
    metricsInterval = setInterval(tick, 3000);
}

function stopMetricsTicker() {
    if (metricsInterval) { clearInterval(metricsInterval); metricsInterval = null; }
    const el = document.getElementById('status-metrics');
    if (el) el.textContent = '';
    const w = document.getElementById('warnings-section');
    if (w) w.style.display = 'none';
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
        case 'image':
            addImageMessage(data.url, data.prompt);
            break;
        case 'audio': playAudio(data.url); break;
        case 'done':
            // Track escalating irritation from server
            if (data.irritation !== undefined) {
                _currentIrritation = data.irritation;
                _msgCount = data.msg_count || _msgCount;
                updateIrritationVisuals(_currentIrritation);
            }
            finishResponse();
            break;
        case 'error': addMessage('system', `[ Error: ${data.content} ]`); finishResponse(); break;
    }
}

function updateIrritationVisuals(irritation) {
    // Update the 3D head's color based on irritation (green -> amber -> red)
    if (chadAvatar && chadAvatar.setIrritation) {
        chadAvatar.setIrritation(irritation);
    }

    // Increase ambient glitch frequency at high irritation
    // (heavier static, more frequent glitches)
    if (irritation >= 70) {
        staticEffect.setIntensity(0.04 + (irritation - 70) * 0.002);
    }
}

function addImageMessage(url, prompt) {
    const c = document.getElementById('chat-messages');
    const currentResponse = document.getElementById('current-response');

    // Clear loading text from response placeholder
    const responseText = document.getElementById('response-text');
    if (responseText) responseText.textContent = '';

    const m = document.createElement('div');
    m.className = 'message chad image-message';

    const label = document.createElement('div');
    label.className = 'image-label';
    label.textContent = 'CHAD VISION >';
    m.appendChild(label);

    const img = document.createElement('img');
    img.className = 'generated-image';
    img.src = url;
    img.alt = prompt;
    m.appendChild(img);

    const caption = document.createElement('div');
    caption.className = 'image-caption';
    caption.textContent = prompt;
    m.appendChild(caption);

    // Insert before the response placeholder so Chad's comment appears below
    if (currentResponse) {
        c.insertBefore(m, currentResponse);
    } else {
        c.appendChild(m);
    }
    c.scrollTop = c.scrollHeight;

    // Glitch burst on image arrival
    flickerEffect.glitchBurst(5);
    staticEffect.spike(0.25, 400);
}

function sendMessage() {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if (!msg || !chatWs || chatWs.readyState !== WebSocket.OPEN || isStreaming) return;

    addMessage('user', msg);
    _cmdHistory.push(msg);
    _cmdHistoryIdx = -1;
    _cmdDraft = '';
    input.value = '';
    stopAudio();   // stop any currently playing TTS so responses don't overlap
    chatWs.send(JSON.stringify({ message: msg }));
    stopIdleTimer();
    isStreaming = true;
    _streamTokenCount = 0;
    _streamStartTime = performance.now();
    document.getElementById('send-btn').disabled = true;
    createResponsePlaceholder();

    // Message send: visual glitch burst + static spike (no audio beeps)
    flickerEffect.glitchBurst(3);
    staticEffect.spike(0.15, 200);
    // Brief audio bump on message send
    chadAudio.messageBump();

    setTimeout(() => { if (isStreaming) finishResponse(); }, 120000);
}

function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); return; }
    const input = document.getElementById('chat-input');
    if (event.key === 'ArrowUp' && _cmdHistory.length > 0) {
        event.preventDefault();
        if (_cmdHistoryIdx === -1) _cmdDraft = input.value;
        _cmdHistoryIdx = Math.min(_cmdHistoryIdx + 1, _cmdHistory.length - 1);
        input.value = _cmdHistory[_cmdHistory.length - 1 - _cmdHistoryIdx];
    } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (_cmdHistoryIdx > 0) {
            _cmdHistoryIdx--;
            input.value = _cmdHistory[_cmdHistory.length - 1 - _cmdHistoryIdx];
        } else if (_cmdHistoryIdx === 0) {
            _cmdHistoryIdx = -1;
            input.value = _cmdDraft;
        }
    }
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

    // Terminal-style loading bar (indeterminate)
    const loader = document.createElement('div');
    loader.className = 'response-loader';
    loader.id = 'response-loader';
    m.appendChild(loader);
    _animateResponseLoader(loader);

    const s = document.createElement('span');
    s.id = 'response-text';
    m.appendChild(s);
    const cur = document.createElement('span');
    cur.textContent = '\u2588';
    cur.style.animation = 'cursor-blink 0.7s step-end infinite';
    cur.id = 'response-cursor';
    m.appendChild(cur);
    c.appendChild(m);
    c.scrollTop = c.scrollHeight;
}

let _responseLoaderTimer = null;
function _animateResponseLoader(el) {
    const w = 20;
    let pos = 0;
    let dir = 1;
    if (_responseLoaderTimer) clearInterval(_responseLoaderTimer);
    _responseLoaderTimer = setInterval(() => {
        const bar = '\u2591'.repeat(pos) + '\u2588'.repeat(3) + '\u2591'.repeat(Math.max(0, w - pos - 3));
        const msgs = ['thinking...', 'ugh hold on...', 'whatever...', 'fine...', 'receiving...'];
        const msg = msgs[Math.floor(Date.now() / 3000) % msgs.length];
        el.textContent = '[' + bar.substring(0, w) + '] ' + msg;
        pos += dir;
        if (pos >= w - 3) dir = -1;
        if (pos <= 0) dir = 1;
    }, 80);
}

function appendToCurrentResponse(token) {
    // Remove loading bar on first token
    const loader = document.getElementById('response-loader');
    if (loader) {
        if (_responseLoaderTimer) { clearInterval(_responseLoaderTimer); _responseLoaderTimer = null; }
        loader.remove();
    }
    _streamTokenCount++;
    const s = document.getElementById('response-text');
    if (s) {
        s.textContent += token;
        document.getElementById('chat-messages').scrollTop =
            document.getElementById('chat-messages').scrollHeight;
    }
}

function finishResponse() {
    isStreaming = false;
    if (_responseLoaderTimer) { clearInterval(_responseLoaderTimer); _responseLoaderTimer = null; }
    const loader = document.getElementById('response-loader');
    if (loader) loader.remove();
    document.getElementById('send-btn').disabled = false;
    // Don't start idle timer immediately — TTS audio may still need to play.
    // Primary reset happens in playAudio onended. This is a fallback in case
    // no audio arrives (e.g. TTS fails): wait 8s then reset if not speaking.
    setTimeout(() => { if (!_isChadBusy()) startIdleTimer(); }, 8000);
    const cur = document.getElementById('response-cursor');
    if (cur) cur.remove();
    const r = document.getElementById('current-response');
    if (r) {
        // Add token stats line
        if (_streamTokenCount > 0 && _streamStartTime > 0) {
            const elapsed = (performance.now() - _streamStartTime) / 1000;
            const tps = (elapsed > 0) ? (_streamTokenCount / elapsed).toFixed(1) : '—';
            const statsEl = document.createElement('div');
            statsEl.className = 'response-stats';
            statsEl.style.cssText = 'font-size:11px;color:#00aa2a;margin-top:6px;font-family:Share Tech Mono,monospace;';
            statsEl.textContent = `[${_streamTokenCount} tok | ${elapsed.toFixed(1)}s | ${tps} tok/s]`;
            r.appendChild(statsEl);
        }
        r.removeAttribute('id');
    }
    const s = document.getElementById('response-text');
    if (s) s.removeAttribute('id');
    // Subtle glitch on response complete
    flickerEffect.glitchScreen();
}

// ============ IDLE TAUNTS ============
//
// Single rule: the idle timer starts ONLY when Chad is fully done —
// audio finished playing (onended) or no audio came (fallback).
// It never runs while streaming or speaking.

let _idleTimer = null;
let _idleTauntCount = 0;
let _idleTaunting = false;            // true while a taunt TTS is playing
const IDLE_DELAY = 60000;             // always 60 seconds of true silence
const IDLE_DELAY_REPEAT = 75000;      // 75 seconds between subsequent taunts

function _isChadBusy() {
    if (isStreaming || _idleTaunting) return true;
    const el = document.getElementById('chad-audio');
    return el && !el.paused && !el.ended && el.currentTime > 0;
}

function startIdleTimer() {
    stopIdleTimer();
    if (!booted) return;
    if (_isChadBusy()) return;  // don't even start if busy
    const delay = _idleTauntCount === 0 ? IDLE_DELAY : IDLE_DELAY_REPEAT;
    _idleTimer = setTimeout(triggerIdleTaunt, delay);
}

async function triggerIdleTaunt() {
    _idleTimer = null;
    if (!booted || _isChadBusy()) return;

    _idleTaunting = true;
    try {
        const resp = await fetch('/api/taunt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taunt_count: _idleTauntCount }),
        });
        const data = await resp.json();

        addMessage('chad', data.message);

        const intensity = Math.min(3 + _idleTauntCount * 2, 8);
        flickerEffect.glitchBurst(intensity);
        staticEffect.spike(0.1 + _idleTauntCount * 0.05, 300);

        if (data.audio_url) {
            // Play taunt TTS — idle timer restarts from onended
            playAudio(data.audio_url);
        } else {
            // No audio — restart timer after a pause
            _idleTaunting = false;
            startIdleTimer();
        }

        _idleTauntCount++;
    } catch (err) {
        console.warn('Idle taunt failed:', err);
        _idleTaunting = false;
        startIdleTimer();
    }
}

function stopIdleTimer() {
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
}

// ============ POWER OFF ============

async function powerOff() {
    powered = false;
    booted = false;

    // Stop avatar glitch system
    if (typeof avatarGlitchSystem !== 'undefined') {
        avatarGlitchSystem.stop();
        avatarGlitchSystem._bootAssembly = false;
    }

    // ---- VHS TAPE EJECT EFFECT ----
    // Heavy static + tracking artifacts scrolling up
    staticEffect.setIntensity(0.6);
    flickerEffect.glitchBurst(6);

    // Create VHS tracking overlay that scrolls up
    const vhsOverlay = document.createElement('div');
    vhsOverlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:9998;pointer-events:none;overflow:hidden;';
    // Multiple horizontal tracking bars
    let bars = '';
    for (let i = 0; i < 12; i++) {
        const y = i * 9;
        const h = 2 + Math.random() * 6;
        const offset = (Math.random() - 0.5) * 60;
        bars += `<div style="position:absolute;top:${y}%;height:${h}%;left:0;right:0;transform:translateX(${offset}px);background:rgba(0,255,65,0.08);border-top:1px solid rgba(0,255,65,0.2);border-bottom:1px solid rgba(0,255,65,0.15);transition:transform 0.8s ease-in;"></div>`;
    }
    vhsOverlay.innerHTML = bars;
    const crtScreen = document.getElementById('crt-screen') || document.body;
    crtScreen.appendChild(vhsOverlay);

    // Animate tracking bars scrolling upward
    vhsOverlay.style.transition = 'transform 0.8s ease-in';
    requestAnimationFrame(() => {
        vhsOverlay.style.transform = 'translateY(-120%)';
    });

    // Rapid brightness flickers
    for (let i = 0; i < 4; i++) {
        await delay(80 + Math.random() * 80);
        staticEffect.spike(0.4 + Math.random() * 0.3, 60);
        flickerEffect.glitchScreen();
    }

    // Blue screen flash (VHS signal loss)
    const blueFlash = document.createElement('div');
    blueFlash.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:9997;pointer-events:none;background:#000033;opacity:0;transition:opacity 0.1s;';
    crtScreen.appendChild(blueFlash);
    await delay(200);
    blueFlash.style.opacity = '0.4';
    await delay(100);
    blueFlash.style.opacity = '0';

    await delay(300);
    vhsOverlay.remove();
    blueFlash.remove();
    // ---- END VHS EJECT ----

    flickerEffect.bootFlicker();

    document.getElementById('lever-container').classList.remove('on');
    document.getElementById('power-indicator').classList.remove('on');
    document.getElementById('app').classList.remove('powered');
    document.getElementById('app').classList.add('pre-boot');
    document.getElementById('status-dot').classList.remove('online', 'booting');
    document.getElementById('status-text').textContent = 'OFFLINE';
    stopMetricsTicker();
    document.getElementById('chat-input').disabled = true;
    document.getElementById('send-btn').disabled = true;
    document.getElementById('shutup-btn').disabled = true;
    document.getElementById('vision-btn').disabled = true;
    if (visionOpen) toggleVision();
    document.getElementById('boot-terminal').classList.remove('visible');
    document.getElementById('chat-messages').classList.remove('visible');
    document.getElementById('boot-log').innerHTML = '';
    document.getElementById('chat-messages').innerHTML = '';

    // Restore power stage
    const ps = document.getElementById('power-stage');
    ps.classList.remove('on', 'hidden');

    if (chatWs) { chatWs.close(); chatWs = null; }
    stopAudio();
    chadAudio.stopAmbientGlitches();
    stopAmbientVisualGlitches();
    stopIdleTimer();
    chadAudio.stop();
    if (chadAvatar) chadAvatar.sleep();
    staticEffect.setIntensity(0.04);
    flickerEffect.glitchScreen();
}

// ============ SHUT UP ============

async function shutUp() {
    if (!booted) return;
    stopAudio();
    playSoundFile('/static/switch.wav');
    if (typeof chadAudio !== 'undefined') chadAudio.playGlitch();
    flickerEffect.glitchBurst(5);
    staticEffect.spike(0.3, 400);
    flickerEffect.glitchScreen();
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
    playSoundFile('/static/switch.wav');
    flickerEffect.glitchBurst(2);
    staticEffect.spike(0.12, 150);
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
            if (data.active_model && m.name === data.active_model) opt.selected = true;
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

function gatherVoiceSettings() {
    const cfgVal = parseFloat(document.getElementById('qwen3-cfg')?.value || 0);
    return {
        engine: document.getElementById('tts-engine').value,
        voice: document.getElementById('voice-select')?.value || 'am_michael',
        speed: parseFloat(document.getElementById('voice-speed')?.value || 1.15),
        angry_speed: 0.95,
        lang_code: document.getElementById('lang-code')?.value || 'a',
        chaos: parseInt(document.getElementById('voice-chaos').value),
        custom_instruct: document.getElementById('custom-instruct')?.value || '',
        pitch_shift: parseInt(document.getElementById('voice-pitch')?.value || 8),
        temperature: parseFloat(document.getElementById('voice-temp')?.value || 1.85),
        qwen3_speaker: document.getElementById('qwen3-speaker')?.value || 'aiden',
        echo_delay: parseInt(document.getElementById('echo-delay')?.value || 80),
        echo_decay: parseFloat(document.getElementById('echo-decay')?.value || 0.35),
        echo_taps: parseInt(document.getElementById('echo-taps')?.value || 3),
        cfg_scale: cfgVal > 0 ? cfgVal : null,
        ref_audio: document.getElementById('qwen3-ref-audio')?.value || '',
        ref_text: document.getElementById('qwen3-ref-text')?.value || '',
        orpheus_voice: document.getElementById('orpheus-voice')?.value || 'leo',
    };
}

async function saveVoiceSettings() {
    const settings = gatherVoiceSettings();
    settings.save = true;
    const status = document.getElementById('settings-status');
    status.textContent = 'SAVING...';
    status.style.color = 'var(--amber)';
    try {
        const resp = await fetch('/api/voice/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings),
        });
        const data = await resp.json();
        status.textContent = data.ok ? 'SAVED' : 'SAVE FAILED';
        status.style.color = data.ok ? 'var(--green)' : 'var(--red)';
    } catch(e) {
        status.textContent = 'SAVE FAILED';
        status.style.color = 'var(--red)';
    }
    setTimeout(() => { status.textContent = ''; }, 4000);
}

async function loadSavedVoiceSettings() {
    // Load current server voice config and apply to UI sliders
    try {
        const resp = await fetch('/api/voice/config/current');
        const cfg = await resp.json();
        if (!cfg) return;
        const setVal = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };
        const setDisp = (id, val, suffix) => { const el = document.getElementById(id); if (el && val !== undefined) el.textContent = val + (suffix || ''); };
        setVal('tts-engine', cfg.engine);
        setVal('voice-chaos', cfg.chaos); setDisp('chaos-val', cfg.chaos, '%');
        setVal('voice-pitch', cfg.pitch_shift); setDisp('pitch-val', cfg.pitch_shift);
        setVal('voice-speed', cfg.speed); setDisp('speed-val', cfg.speed);
        setVal('voice-temp', cfg.temperature); setDisp('temp-val', cfg.temperature);
        setVal('echo-delay', cfg.echo_delay); setDisp('echo-delay-val', cfg.echo_delay, 'ms');
        setVal('echo-decay', cfg.echo_decay); setDisp('echo-decay-val', cfg.echo_decay);
        setVal('echo-taps', cfg.echo_taps); setDisp('echo-taps-val', cfg.echo_taps);
        setVal('qwen3-speaker', cfg.qwen3_speaker);
        if (cfg.custom_instruct) setVal('custom-instruct', cfg.custom_instruct);
        setVal('voice-select', cfg.voice);
        setVal('lang-code', cfg.lang_code);
        const cfgScale = cfg.cfg_scale || 0;
        setVal('qwen3-cfg', cfgScale);
        setDisp('cfg-val', cfgScale > 0 ? cfgScale : 'off');
        if (cfg.ref_audio) setVal('qwen3-ref-audio', cfg.ref_audio);
        if (cfg.ref_text) setVal('qwen3-ref-text', cfg.ref_text);
        // Toggle engine panels
        var eng = cfg.engine || 'qwen3';
        var _oe = document.getElementById('orpheus-settings');
        if (_oe) _oe.style.display = eng === 'orpheus' ? 'block' : 'none';
        document.getElementById('kokoro-settings').style.display = eng === 'kokoro' ? 'block' : 'none';
        document.getElementById('qwen3-advanced').style.display = eng === 'qwen3' ? 'block' : 'none';
    } catch(e) { console.warn('Failed to load voice config:', e); }
}

async function applyVoiceSettings() {
    const settings = gatherVoiceSettings();
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

async function previewVoice() {
    const status = document.getElementById('settings-status');
    status.textContent = 'GENERATING PREVIEW...';
    status.style.color = 'var(--amber)';

    // Apply settings first so preview uses current sliders
    const settings = gatherVoiceSettings();
    try {
        await fetch('/api/voice/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings),
        });
    } catch(e) {}

    // Get custom text from the preview input (if any)
    const previewInput = document.getElementById('preview-text');
    const customText = previewInput ? previewInput.value.trim() : '';

    try {
        const resp = await fetch('/api/voice/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: customText }),
        });
        const data = await resp.json();
        if (data.ok && data.audio_url) {
            status.textContent = 'Playing: ' + data.text.substring(0, 60) + (data.text.length > 60 ? '...' : '');
            status.style.color = 'var(--green)';
            playAudio(data.audio_url);
        } else {
            status.textContent = 'PREVIEW FAILED';
            status.style.color = 'var(--red)';
        }
    } catch(e) {
        status.textContent = 'PREVIEW FAILED';
        status.style.color = 'var(--red)';
    }
    setTimeout(() => { status.textContent = ''; }, 6000);
}

// ============ CHAD VISION (Image Generation) ============

let visionOpen = false;
let visionGenerating = false;
let filmAudio = null; // film spooling audio context

function toggleVision() {
    visionOpen = !visionOpen;
    const chatSection = document.getElementById('chat-section');
    const visionSection = document.getElementById('vision-section');
    const btn = document.getElementById('vision-btn');

    // Sound + heavy glitch on page switch
    playSoundFile('/static/switch.wav');
    if (typeof chadAudio !== 'undefined') chadAudio.playGlitch();

    if (visionOpen) {
        chatSection.style.display = 'none';
        visionSection.classList.add('active');
        btn.textContent = 'CHAD CHAT';
        startFilmAudio();
    } else {
        visionSection.classList.remove('active');
        chatSection.style.display = '';
        btn.textContent = 'CHAD VISION';
        stopFilmAudio();
    }
    flickerEffect.glitchBurst(5);
    staticEffect.spike(0.25, 350);
    flickerEffect.glitchScreen();
    setTimeout(() => flickerEffect.glitchScreen(), 150);
}

function startFilmAudio() {
    if (filmAudio) return;
    const ac = chadAudio._getContext ? chadAudio._getContext() : new AudioContext();
    filmAudio = { ctx: ac, nodes: [] };

    const master = ac.createGain();
    master.gain.value = 0;
    master.connect(ac.destination);

    // Motor hum: low oscillator with vibrato
    const motor = ac.createOscillator();
    motor.type = 'sawtooth';
    motor.frequency.value = 55;
    const motorGain = ac.createGain();
    motorGain.gain.value = 0.06;
    const motorFilter = ac.createBiquadFilter();
    motorFilter.type = 'lowpass';
    motorFilter.frequency.value = 120;
    // Vibrato LFO for motor instability
    const vibrato = ac.createOscillator();
    vibrato.frequency.value = 4.5;
    const vibratoGain = ac.createGain();
    vibratoGain.gain.value = 2;
    vibrato.connect(vibratoGain);
    vibratoGain.connect(motor.frequency);
    vibrato.start();
    motor.connect(motorFilter);
    motorFilter.connect(motorGain);
    motorGain.connect(master);
    motor.start();

    // Sprocket clicks: noise bursts at regular intervals
    const clickInterval = 0.12; // ~8fps projector
    const clickBuffer = ac.createBuffer(1, ac.sampleRate * 0.008, ac.sampleRate);
    const clickData = clickBuffer.getChannelData(0);
    for (let i = 0; i < clickData.length; i++) {
        clickData[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ac.sampleRate * 0.002));
    }
    function scheduleClicks() {
        if (!filmAudio) return;
        const now = ac.currentTime;
        for (let t = 0; t < 2; t += clickInterval) {
            const src = ac.createBufferSource();
            src.buffer = clickBuffer;
            // Slight timing randomness
            const jitter = (Math.random() - 0.5) * 0.015;
            const g = ac.createGain();
            g.gain.value = 0.04 + Math.random() * 0.03;
            const filt = ac.createBiquadFilter();
            filt.type = 'highpass';
            filt.frequency.value = 2000 + Math.random() * 3000;
            src.connect(filt);
            filt.connect(g);
            g.connect(master);
            src.start(now + t + jitter);
        }
        filmAudio._clickTimer = setTimeout(scheduleClicks, 1900);
    }
    scheduleClicks();

    // Film flutter: slow amplitude modulation
    const flutter = ac.createOscillator();
    flutter.frequency.value = 1.8;
    const flutterGain = ac.createGain();
    flutterGain.gain.value = 0.015;
    flutter.connect(flutterGain);
    flutterGain.connect(master.gain);
    flutter.start();

    // Fade in
    master.gain.setValueAtTime(0, ac.currentTime);
    master.gain.linearRampToValueAtTime(1, ac.currentTime + 1.5);

    filmAudio.master = master;
    filmAudio.nodes = [motor, vibrato, flutter];
}

function stopFilmAudio() {
    if (!filmAudio) return;
    if (filmAudio._clickTimer) clearTimeout(filmAudio._clickTimer);
    const now = filmAudio.ctx.currentTime;
    if (filmAudio.master) {
        filmAudio.master.gain.setValueAtTime(filmAudio.master.gain.value, now);
        filmAudio.master.gain.linearRampToValueAtTime(0, now + 0.8);
    }
    const nodes = filmAudio.nodes;
    setTimeout(() => {
        nodes.forEach(n => { try { n.stop(); } catch(e) {} });
    }, 900);
    filmAudio = null;
}

async function generateVision() {
    const input = document.getElementById('vision-prompt');
    const prompt = input.value.trim();
    if (!prompt || visionGenerating) return;

    visionGenerating = true;
    input.value = '';
    document.getElementById('vision-generate').disabled = true;
    const status = document.getElementById('vision-status');
    const loadingMessages = [
        '[HOLD ON BRO I\'M WORKING ON IT...]',
        '[MAKING YOUR STUPID PICTURE...]',
        '[THIS BETTER BE WORTH MY TIME...]',
        '[UGH FINE RENDERING WHATEVER...]',
        '[I COULD BE AT THE GYM RIGHT NOW...]',
    ];
    status.textContent = loadingMessages[Math.floor(Math.random() * loadingMessages.length)];
    status.style.color = 'var(--amber)';
    playSoundFile('/static/switch.wav');
    if (typeof chadAudio !== 'undefined') chadAudio.playGlitch();
    flickerEffect.glitchBurst(5);
    staticEffect.spike(0.3, 400);
    flickerEffect.glitchScreen();
    setTimeout(() => flickerEffect.glitchScreen(), 100);

    const output = document.getElementById('vision-output');

    // Create loading placeholder with animated canvas
    const loadWrap = document.createElement('div');
    loadWrap.className = 'vision-loading-wrap';
    const loadCanvas = document.createElement('canvas');
    loadCanvas.className = 'vision-loading-canvas';
    loadCanvas.width = 256;
    loadCanvas.height = 256;
    loadWrap.appendChild(loadCanvas);
    const loadText = document.createElement('div');
    loadText.className = 'vision-loading-text';
    loadText.style.cssText = 'font-family:Share Tech Mono,monospace;font-size:12px;color:#00aa2a;white-space:pre;margin-top:6px;';
    loadWrap.appendChild(loadText);
    // Poll real diffusion step progress from server
    const imgLoadTimer = setInterval(async () => {
        try {
            const pr = await fetch('/api/imagine/progress');
            const p = await pr.json();
            if (p.active && p.total > 0) {
                const w = 30;
                const filled = Math.round((p.step / p.total) * w);
                const empty = w - filled;
                const pct = Math.round((p.step / p.total) * 100);
                loadText.textContent = '[' + '\u2588'.repeat(filled) + '\u2591'.repeat(empty) + '] ' + p.step + '/' + p.total + ' steps (' + pct + '%)';
            } else {
                loadText.textContent = '[\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591] waiting...';
            }
        } catch { }
    }, 300);
    output.appendChild(loadWrap);
    output.scrollTop = output.scrollHeight;

    // Start the pixel assembly animation
    const genAnim = new ImageGenAnimation(loadCanvas);
    genAnim.start();

    try {
        const resp = await fetch('/api/imagine', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt }),
        });
        const data = await resp.json();

        if (data.ok) {
            clearInterval(imgLoadTimer);
            // Stop static animation and do pixel reveal from actual image
            genAnim.phase = 'reveal';
            await genAnim.snapToImage(data.image_url);

            // Replace loading wrap with final image wrap
            const wrap = document.createElement('div');
            wrap.className = 'vision-image-wrap';

            const img = document.createElement('img');
            img.src = data.image_url;
            img.alt = prompt;
            img.className = 'vision-snap-in';
            wrap.appendChild(img);

            const caption = document.createElement('div');
            caption.className = 'vision-caption';
            caption.textContent = prompt;
            wrap.appendChild(caption);

            const comment = document.createElement('div');
            comment.className = 'vision-comment';
            comment.textContent = data.comment;
            wrap.appendChild(comment);

            // Swap loading placeholder for final image
            loadWrap.replaceWith(wrap);
            output.scrollTop = output.scrollHeight;

            status.textContent = '';
            if (typeof chadAudio !== 'undefined') chadAudio.playGlitch();
            flickerEffect.glitchBurst(6);
            staticEffect.spike(0.35, 500);
            flickerEffect.glitchScreen();
            setTimeout(() => flickerEffect.glitchScreen(), 120);
            setTimeout(() => flickerEffect.glitchScreen(), 250);

            if (data.audio_url) pollAndPlayAudio(data.audio_url);
        } else {
            clearInterval(imgLoadTimer);
            loadWrap.remove();
            status.textContent = data.error || 'VISION FAILED';
            status.style.color = 'var(--red)';
            setTimeout(() => { status.textContent = ''; }, 5000);
        }
    } catch(e) {
        clearInterval(imgLoadTimer);
        genAnim.stop();
        loadWrap.remove();
        status.textContent = 'VISION FAILED';
        status.style.color = 'var(--red)';
        setTimeout(() => { status.textContent = ''; }, 5000);
    }

    visionGenerating = false;
    document.getElementById('vision-generate').disabled = false;
}

// Quality dial handler
function initQualityDial() {
    document.querySelectorAll('input[name="img-quality"]').forEach(radio => {
        radio.addEventListener('change', async (e) => {
            const quality = e.target.value;
            // Sound + glitch on quality switch
            playSoundFile('/static/switch.wav');
            flickerEffect.glitchBurst(4);
            staticEffect.spike(0.2, 250);
            if (typeof chadAudio !== 'undefined') chadAudio.playGlitch();
            try {
                await fetch('/api/imagine/quality', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ quality }),
                });
            } catch(err) {}
        });
    });
}

function pollAndPlayAudio(url, attempts = 0) {
    if (attempts > 30) return; // give up after ~30s (TTS + pitch shift + echo can be slow)
    fetch(url, { method: 'HEAD' }).then(resp => {
        if (resp.ok) {
            playAudio(url);
        } else {
            setTimeout(() => pollAndPlayAudio(url, attempts + 1), 1000);
        }
    }).catch(() => {
        setTimeout(() => pollAndPlayAudio(url, attempts + 1), 1000);
    });
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
    bind('voice-chaos', 'chaos-val', '%');
    bind('voice-pitch', 'pitch-val');
    bind('voice-temp', 'temp-val');
    bind('boot-volume', 'boot-vol-val', '%');
    bind('echo-delay', 'echo-delay-val', 'ms');
    bind('echo-decay', 'echo-decay-val');
    bind('echo-taps', 'echo-taps-val');

    // CFG scale special display (0 = "off")
    const cfgEl = document.getElementById('qwen3-cfg');
    if (cfgEl) cfgEl.addEventListener('input', () => {
        const v = parseFloat(cfgEl.value);
        document.getElementById('cfg-val').textContent = v > 0 ? v.toString() : 'off';
    });

    // Auto-select lang code
    const voiceSelect = document.getElementById('voice-select');
    if (voiceSelect) {
        voiceSelect.addEventListener('change', () => {
            document.getElementById('lang-code').value =
                (voiceSelect.value.startsWith('bm_') || voiceSelect.value.startsWith('bf_')) ? 'b' : 'a';
        });
    }

    // Engine toggle: show/hide Kokoro vs Qwen3 settings
    const engineSelect = document.getElementById('tts-engine');
    if (engineSelect) {
        engineSelect.addEventListener('change', () => {
            var eng = engineSelect.value;
            var _oe = document.getElementById('orpheus-settings');
            if (_oe) _oe.style.display = eng === 'orpheus' ? 'block' : 'none';
            document.getElementById('kokoro-settings').style.display = eng === 'kokoro' ? 'block' : 'none';
            document.getElementById('qwen3-advanced').style.display = eng === 'qwen3' ? 'block' : 'none';
        });
    }

    // Quality dial for image generation
    initQualityDial();

    // Keyboard clack sounds on chat input
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('keydown', (e) => {
            // Only clack for printable keys, backspace, enter — not modifiers alone
            if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter' || e.key === 'Tab') {
                if (typeof chadAudio !== 'undefined' && powered) {
                    chadAudio.playKeyClack();
                }
            }
        });
    }
    // Also clack on vision prompt input
    const visionInput = document.getElementById('vision-prompt');
    if (visionInput) {
        visionInput.addEventListener('keydown', (e) => {
            if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter' || e.key === 'Tab') {
                if (typeof chadAudio !== 'undefined' && powered) {
                    chadAudio.playKeyClack();
                }
            }
        });
    }
});
