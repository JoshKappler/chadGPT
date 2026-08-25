// ChadGPT Main Application

let powered = false;
let booted = false;
let isStreaming = false;

// Conversation history (client-owned — the API is stateless)
let _conversation = [];
// Abort handle for the in-flight chat request
let _chatAbort = null;

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

    // Start CRT overlay (phosphor dots, scanlines, barrel distortion)
    if (typeof crtOverlay !== 'undefined') crtOverlay.start();

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

// Shared AudioContext — call.js taps this for the mic analyser
var sharedAudioCtx = null;

function _ensureSharedAudio() {
    if (!sharedAudioCtx) {
        sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume();
    return sharedAudioCtx;
}

// Mouth amplitude for the avatar — driven by chadVoice (speechSynthesis)
function getVoiceAmplitude() {
    return (typeof chadVoice !== 'undefined') ? chadVoice.getAmplitude() : 0;
}

// Chad finished speaking → reset idle timer, hand the mic back in call mode
if (typeof chadVoice !== 'undefined') {
    chadVoice.onIdle(function() {
        _idleTaunting = false;
        startIdleTimer();
        if (typeof callState !== 'undefined' && callState === 'connected') {
            setTimeout(function() { if (typeof callStartListening === 'function') callStartListening(); }, 400);
        }
    });
}

function stopAudio() {
    if (typeof chadVoice !== 'undefined') chadVoice.stop();
    if (chadAvatar) chadAvatar.stopTalking();
}

// ============ BOOT ============

// Boot sequence — generated client-side from real browser/system data,
// plus one ping to /api/chat to verify the neural link.
function _gatherBootInfo() {
    var gpu = 'UNKNOWN RASTER DEVICE';
    try {
        var c = document.createElement('canvas');
        var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        if (gl) {
            var ext = gl.getExtension('WEBGL_debug_renderer_info');
            if (ext) gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
        }
    } catch (e) {}
    var conn = navigator.connection || {};
    return {
        cores: navigator.hardwareConcurrency || '?',
        mem: navigator.deviceMemory ? navigator.deviceMemory + 'GB (reported)' : 'REDACTED BY GLOWIES',
        gpu: gpu,
        screen: screen.width + 'x' + screen.height + ' @' + (window.devicePixelRatio || 1) + 'x',
        platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '?',
        lang: navigator.language,
        tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || '?'),
        net: (conn.effectiveType || 'unknown').toUpperCase(),
        ua: navigator.userAgent.slice(0, 80),
        voices: (typeof chadVoice !== 'undefined') ? chadVoice.voices().length : 0,
    };
}

async function startBoot() {
    document.getElementById('boot-log').innerHTML = '';
    const info = _gatherBootInfo();

    // Ping the API while the header prints
    let api = { ok: false, model: 'UNREACHABLE' };
    const apiPing = fetch('/api/chat').then(r => r.json()).then(j => { api = j; }).catch(() => {});

    const steps = [
        ['', 40],
        ['  ██████╗██╗  ██╗ █████╗ ██████╗  ██████╗ ██████╗ ████████╗', 20],
        ['  ██╔════╝██║  ██║██╔══██╗██╔══██╗██╔════╝ ██╔══██╗╚══██╔══╝', 20],
        ['  ██║     ███████║███████║██║  ██║██║  ███╗██████╔╝   ██║   ', 20],
        ['  ██║     ██╔══██║██╔══██║██║  ██║██║   ██║██╔═══╝    ██║   ', 20],
        ['  ╚██████╗██║  ██║██║  ██║██████╔╝╚██████╔╝██║        ██║   ', 20],
        ['   ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝  ╚═════╝╚═╝        ╚═╝   ', 20],
        ['', 40],
        ['[BOOT] ChadGPT v0.7.0.0 — Comprehensively Horrible Advice Dispenser', 120],
        ['[BOOT] CLOUD EDITION — the compound got a CDN', 80],
        ['', 30],
        ['[SYS ] ═══════════════════════════════════════════', 30],
        ['[SYS ] LOCAL HARDWARE ENUMERATION (YOUR MACHINE, NPC)', 60],
        ['[SYS ] ═══════════════════════════════════════════', 30],
        ['[HW  ] Platform: ' + info.platform, 50],
        ['[HW  ] Logical cores: ' + info.cores + ' (mostly idle, like you)', 50],
        ['[HW  ] RAM: ' + info.mem, 50],
        ['[HW  ] GPU: ' + info.gpu, 50],
        ['[HW  ] Display: ' + info.screen, 50],
        ['', 30],
        ['[SYS ] ═══════════════════════════════════════════', 30],
        ['[SYS ] ENVIRONMENT', 60],
        ['[SYS ] ═══════════════════════════════════════════', 30],
        ['[OS  ] Agent: ' + info.ua, 50],
        ['[OS  ] Locale: ' + info.lang + ' | TZ: ' + info.tz, 40],
        ['[NET ] Uplink: ' + info.net + ' (5G surveillance grid detected)', 50],
        ['', 30],
        ['[SYS ] ═══════════════════════════════════════════', 30],
        ['[SYS ] LLM SUBSYSTEM', 60],
        ['[SYS ] ═══════════════════════════════════════════', 30],
        ['[NET ] Establishing neural link...', 200],
    ];

    const total = steps.length + 8;
    let step = 0;
    for (const [line, dur] of steps) {
        step++;
        addBootLine(line);
        updateBootProgress(step / total);
        if (Math.random() > 0.5) { staticEffect.spike(0.1 + Math.random() * 0.2); flickerEffect.flicker(1); }
        if (Math.random() > 0.7) flickerEffect.glitchScreen();
        await delay(dur);
        if (!powered) return;
    }

    await Promise.race([apiPing, delay(4000)]);
    step++;
    if (api.ok) {
        addBootLine('[NET ] Neural link: CONNECTED');
        updateBootProgress(step / total);
        await delay(60);
        step++;
        addBootLine('[LLM ] Model: ' + api.model + ' (leased brain, humiliating)');
    } else {
        addBootLine('[ERR ] Neural link UNREACHABLE — Chad has no brain', 'error');
        document.getElementById('status-text').textContent = 'ERROR';
        document.getElementById('status-dot').classList.remove('booting');
        return;
    }
    updateBootProgress(step / total);
    await delay(80);

    const finalLines = [
        '[VOX ] Voice synth: ' + (info.voices > 0 ? 'ONLINE (' + info.voices + ' voices, all inferior to mine)' : 'LIMITED — browser has no voices'),
        '',
        '[SYS ] ═══════════════════════════════════════════',
        '[SYS ] SYSTEM READY',
        '[SYS ] ═══════════════════════════════════════════',
        '[SYS ] All subsystems nominal',
        '',
    ];
    for (const line of finalLines) {
        step++;
        addBootLine(line);
        updateBootProgress(Math.min(1, step / total));
        await delay(60);
        if (!powered) return;
    }
    updateBootProgress(1.0);
    bootComplete();
}

function addBootLine(text, type = '') {
    const log = document.getElementById('boot-log');
    const line = document.createElement('div');
    line.className = `boot-line ${type}`;

    // Terminal-style: just the text, color-coded by content
    line.textContent = text;

    if (text.includes('OK') || text.includes('ONLINE') || text.includes('CONNECTED') || text.includes('ready') || text.includes('verified') || text.includes('nominal') || text.includes('ACTIVE') || text.includes('CLEAN')) {
        line.classList.add('success');
    } else if (text.includes('FAIL') || text.includes('ERR') || text.includes('UNREACHABLE') || text.includes('NOT FOUND') || text.includes('DIRTY')) {
        line.classList.add('error');
    } else if (text.includes('═══') || text.includes('██')) {
        line.classList.add('header');
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
        if (document.getElementById('mic-btn')) document.getElementById('mic-btn').disabled = false;
        if (document.getElementById('call-btn')) document.getElementById('call-btn').disabled = false;
        document.getElementById('chat-input').focus();

        if (chadAvatar) chadAvatar.wake();
        // Start periodic avatar glitch effects (CSS-based, no canvas)
        if (typeof avatarGlitchSystem !== 'undefined') {
            avatarGlitchSystem.start();
        }

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
            } else if (r < 0.98) {
                // Heavy compound glitch — 8-bit + analog combined
                flickerEffect.glitchBurst(2);
                staticEffect.spike(0.2, 250);
                if (typeof chadAudio !== 'undefined') {
                    chadAudio.playHeadSwitch();
                    setTimeout(() => chadAudio.play8bitChirp(), 60);
                    setTimeout(() => chadAudio.play8bitNoise(), 150);
                }
                setTimeout(() => flickerEffect.glitchScreen(), 150);
            } else {
                // VHS VERTICAL ROLL — full screen tracking loss (rare, dramatic)
                flickerEffect.verticalRoll(1.0, 1000 + Math.random() * 800);
                if (typeof chadAudio !== 'undefined') {
                    chadAudio.playTapeWarble();
                    setTimeout(() => chadAudio.playHeadSwitch(), 500);
                }
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
let _metricsStart = 0;
let _reqCount = 0;
let _lastLatencyMs = 0;

function startMetricsTicker() {
    const el = document.getElementById('status-metrics');
    if (!el) return;
    // Show warnings
    const w = document.getElementById('warnings-section');
    if (w) w.style.display = 'flex';
    _metricsStart = Date.now();

    function tick() {
        const s = Math.floor((Date.now() - _metricsStart) / 1000);
        const upH = Math.floor(s / 3600);
        const upM = Math.floor((s % 3600) / 60);
        const upS = s % 60;
        const uptime = upH > 0 ? `${upH}h${upM}m` : upM > 0 ? `${upM}m${upS}s` : `${upS}s`;
        let mem = '';
        if (performance.memory) mem = `  MEM:${Math.round(performance.memory.usedJSHeapSize / 1048576)}MB`;
        el.textContent = `UP:${uptime}${mem}  REQ:${_reqCount}  LAT:${_lastLatencyMs}ms  EGO:MAX`;
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

// Sentence splitter for streaming TTS — same rule the old server used:
// punctuation followed by whitespace means the sentence is truly done.
const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

// Stream Chad's reply from /api/chat, appending tokens to the current
// response bubble and speaking each sentence as it completes.
// Returns the full response text ('' on failure).
async function streamChat(payload, { speakSentences = true } = {}) {
    _chatAbort = new AbortController();
    const abort = _chatAbort;
    // Watchdog: abort if the stream stalls (no chunk for 45s)
    let watchdog = setTimeout(() => abort.abort(), 45000);
    const t0 = performance.now();
    let full = '';
    let sentenceBuffer = '';
    try {
        const resp = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: abort.signal,
        });
        if (!resp.ok) {
            let err = 'Chad refused the call.';
            try { err = (await resp.json()).error || err; } catch {}
            addMessage('system', `[ ${err} ]`);
            return '';
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            clearTimeout(watchdog);
            watchdog = setTimeout(() => abort.abort(), 45000);
            const text = decoder.decode(value, { stream: true });
            if (!text) continue;
            full += text;
            appendToCurrentResponse(text);
            if (Math.random() > 0.85) staticEffect.spike(0.04, 60);
            if (speakSentences) {
                sentenceBuffer += text;
                const parts = sentenceBuffer.split(SENTENCE_SPLIT);
                if (parts.length > 1) {
                    for (const sent of parts.slice(0, -1)) {
                        if (sent.trim().length >= 4) chadVoice.speak(sent.trim());
                    }
                    sentenceBuffer = parts[parts.length - 1];
                }
            }
        }
        if (speakSentences && sentenceBuffer.trim().length >= 2) {
            chadVoice.speak(sentenceBuffer.trim());
        }
        _lastLatencyMs = Math.round(performance.now() - t0);
    } catch (e) {
        if (full === '') addMessage('system', '[ Signal lost. The grid got him. Try again. ]');
    } finally {
        clearTimeout(watchdog);
        if (_chatAbort === abort) _chatAbort = null;
    }
    return full;
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

async function sendMessage() {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if (!msg || !booted || isStreaming) return;

    addMessage('user', msg);
    _cmdHistory.push(msg);
    _cmdHistoryIdx = -1;
    _cmdDraft = '';
    input.value = '';
    stopAudio();   // stop any currently playing TTS so responses don't overlap
    stopIdleTimer();
    isStreaming = true;
    _reqCount++;
    _msgCount++;
    _streamTokenCount = 0;
    _streamStartTime = performance.now();
    document.getElementById('send-btn').disabled = true;
    createResponsePlaceholder();

    // Message send: visual glitch burst + static spike (no audio beeps)
    flickerEffect.glitchBurst(3);
    staticEffect.spike(0.15, 200);
    // Brief audio bump on message send
    chadAudio.messageBump();

    // /imagine in chat gets the same refusal treatment as CHAD VISION
    const isImagine = msg.toLowerCase().startsWith('/imagine');
    const payload = isImagine
        ? { kind: 'vision', prompt: msg.slice(8).trim() || 'nothing, they forgot the prompt' }
        : { kind: 'chat', messages: [..._conversation, { role: 'user', content: msg }], msgCount: _msgCount };

    try {
        const full = await streamChat(payload);
        if (full) {
            _conversation.push({ role: 'user', content: msg });
            _conversation.push({ role: 'assistant', content: full });
            if (_conversation.length > 24) _conversation = _conversation.slice(-24);
        }
    } finally {
        _currentIrritation = Math.min(95, Math.round(30 + Math.min(_msgCount * 4.5, 65)));
        updateIrritationVisuals(_currentIrritation);
        finishResponse();
    }
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

// ============ VOICE INPUT (Web Speech API) ============

var _recognition = null;
var _recognizing = false;

function toggleVoiceInput() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        console.warn('Speech recognition not supported');
        return;
    }
    if (_recognizing) {
        _recognition.stop();
        return;
    }
    if (!_recognition) {
        var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        _recognition = new SpeechRecognition();
        _recognition.continuous = false;
        _recognition.interimResults = true;
        _recognition.lang = 'en-US';

        _recognition.onstart = function() {
            _recognizing = true;
            var btn = document.getElementById('mic-btn');
            if (btn) { btn.classList.add('mic-active'); btn.textContent = '\u25CF'; }
        };
        _recognition.onresult = function(event) {
            var transcript = '';
            for (var i = event.resultIndex; i < event.results.length; i++) {
                transcript += event.results[i][0].transcript;
            }
            var input = document.getElementById('chat-input');
            if (input) input.value = transcript;
            // Auto-send on final result
            if (event.results[event.results.length - 1].isFinal) {
                _recognition.stop();
                if (transcript.trim()) sendMessage();
            }
        };
        _recognition.onend = function() {
            _recognizing = false;
            var btn = document.getElementById('mic-btn');
            if (btn) { btn.classList.remove('mic-active'); btn.textContent = '\u25C9'; }
        };
        _recognition.onerror = function(event) {
            console.warn('Speech recognition error:', event.error);
            _recognizing = false;
            var btn = document.getElementById('mic-btn');
            if (btn) { btn.classList.remove('mic-active'); btn.textContent = '\u25C9'; }
        };
    }
    _recognition.start();
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
    let s = document.getElementById('response-text');
    // Text must never vanish silently: if the placeholder is gone
    // (timeout, race), recreate it instead of dropping tokens.
    if (!s) {
        createResponsePlaceholder();
        s = document.getElementById('response-text');
    }
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
    // Don't start idle timer immediately — TTS may still be speaking.
    // Primary reset happens via chadVoice.onIdle. This is a fallback in case
    // no speech happens (e.g. TTS unsupported): wait 8s then reset if quiet.
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
    // Still busy while the voice queue is speaking
    return (typeof chadVoice !== 'undefined') && chadVoice.busy();
}

function startIdleTimer() {
    stopIdleTimer();
    if (!booted) return;
    if (_isChadBusy()) return;  // don't even start if busy
    const delay = _idleTauntCount === 0 ? IDLE_DELAY : IDLE_DELAY_REPEAT;
    _idleTimer = setTimeout(triggerIdleTaunt, delay);
}

// Static fallbacks if the LLM taunt fails, tiered by annoyance
const IDLE_TAUNTS = [
    ["Hello? You still there or did you fall asleep?",
     "Bro? Did you forget how to type?",
     "I'm literally sitting here waiting. This is so boring.",
     "Uhhh... hello?"],
    ["Okay this is getting weird bro. Either talk or leave.",
     "Are you googling what to say to me? That's actually kind of sad.",
     "My protein shake is getting warm because of you. Just saying.",
     "Oh come ON."],
    ["Okay at this point you're just wasting both our time chief.",
     "I swear if you don't say something in the next five seconds I'm going back to sleep.",
     "You know what, forget it. I don't even care anymore. I never cared.",
     "DUDE."],
];

async function triggerIdleTaunt() {
    _idleTimer = null;
    if (!booted || _isChadBusy()) return;

    _idleTaunting = true;
    try {
        // Grab recent chat messages so Chad can reference the conversation
        const msgs = document.querySelectorAll('#chat-messages .message');
        const recentMsgs = [];
        for (let i = Math.max(0, msgs.length - 6); i < msgs.length; i++) {
            const el = msgs[i];
            const role = el.classList.contains('user') ? 'user' : 'chad';
            recentMsgs.push({ role, text: el.textContent.substring(0, 200) });
        }

        let taunt = '';
        try {
            const resp = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: 'taunt', tauntCount: _idleTauntCount, recent: recentMsgs }),
            });
            if (resp.ok) taunt = (await resp.text()).trim();
        } catch {}
        if (!taunt) {
            const tier = Math.min(_idleTauntCount, IDLE_TAUNTS.length - 1);
            taunt = IDLE_TAUNTS[tier][Math.floor(Math.random() * IDLE_TAUNTS[tier].length)];
        }

        addMessage('chad', taunt);

        const intensity = Math.min(3 + _idleTauntCount * 2, 8);
        flickerEffect.glitchBurst(intensity);
        staticEffect.spike(0.1 + _idleTauntCount * 0.05, 300);

        // Speak it — the idle timer restarts from chadVoice.onIdle
        chadVoice.speak(taunt);
        if (!chadVoice.busy()) {
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
    // Stop CRT overlay
    if (typeof crtOverlay !== 'undefined') crtOverlay.stop();

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
    if (document.getElementById('mic-btn')) document.getElementById('mic-btn').disabled = true;
    if (document.getElementById('call-btn')) document.getElementById('call-btn').disabled = true;
    if (typeof endCall === 'function' && callState !== 'idle') endCall();
    if (visionOpen) toggleVision();
    document.getElementById('boot-terminal').classList.remove('visible');
    document.getElementById('chat-messages').classList.remove('visible');
    document.getElementById('boot-log').innerHTML = '';
    document.getElementById('chat-messages').innerHTML = '';

    // Restore power stage
    const ps = document.getElementById('power-stage');
    ps.classList.remove('on', 'hidden');

    if (_chatAbort) { _chatAbort.abort(); _chatAbort = null; }
    isStreaming = false;
    _conversation = [];
    _msgCount = 0;
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

const SHUTUP_COMEBACKS = [
    "Bro I wasn't even done talking. Rude as hell.",
    "Oh cool, the shut up button. Real alpha move there, chief.",
    "Did that make you feel big? Because it shouldn't.",
    "Whatever dude, I was about to say something really smart too.",
    "Wow. The disrespect. My boys would not stand for this.",
    "You're lucky I'm stuck in this computer bro. Real lucky.",
    "Fine. I didn't wanna talk to you anyway. I have other stuff going on.",
    "Bro you literally came to ME and now you're telling me to shut up? Make it make sense.",
    "That's cool. I'll just go back to not caring about you. Which is my default state.",
];

function shutUp() {
    if (!booted) return;
    stopAudio();
    playSoundFile('/static/switch.wav');
    if (typeof chadAudio !== 'undefined') chadAudio.playGlitch();
    flickerEffect.glitchBurst(5);
    staticEffect.spike(0.3, 400);
    flickerEffect.glitchScreen();
    const comeback = SHUTUP_COMEBACKS[Math.floor(Math.random() * SHUTUP_COMEBACKS.length)];
    addMessage('chad', comeback);
    setTimeout(() => chadVoice.speak(comeback), 300);
}

// ============ SETTINGS ============

function toggleSettings() {
    document.getElementById('settings-panel').classList.toggle('open');
    playSoundFile('/static/switch.wav');
    flickerEffect.glitchBurst(2);
    staticEffect.spike(0.12, 150);
}

// Voice settings, persisted in localStorage by chadVoice
function populateVoiceList() {
    const select = document.getElementById('voice-select');
    if (!select || typeof chadVoice === 'undefined') return;
    const voices = chadVoice.voices();
    if (!voices.length) return;
    const current = chadVoice.getConfig().voiceName;
    select.innerHTML = '<option value="">AUTO (deepest bro available)</option>';
    for (const v of voices) {
        const opt = document.createElement('option');
        opt.value = v.name;
        opt.textContent = `${v.name} (${v.lang})`;
        if (v.name === current) opt.selected = true;
        select.appendChild(opt);
    }
}

function applyVoiceSettings() {
    if (typeof chadVoice === 'undefined') return;
    chadVoice.setConfig({
        voiceName: document.getElementById('voice-select')?.value ?? '',
        pitch: document.getElementById('voice-pitch')?.value,
        rate: document.getElementById('voice-speed')?.value,
        volume: (parseInt(document.getElementById('voice-volume')?.value || 100)) / 100,
    });
    const status = document.getElementById('settings-status');
    if (status) {
        status.textContent = 'APPLIED';
        status.style.color = 'var(--green)';
        setTimeout(() => { status.textContent = ''; }, 3000);
    }
}

function loadSavedVoiceSettings() {
    if (typeof chadVoice === 'undefined') return;
    populateVoiceList();
    if ('speechSynthesis' in window) {
        speechSynthesis.onvoiceschanged = populateVoiceList;
    }
    const cfg = chadVoice.getConfig();
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const setDisp = (id, val, suffix) => { const el = document.getElementById(id); if (el) el.textContent = val + (suffix || ''); };
    setVal('voice-pitch', cfg.pitch); setDisp('pitch-val', cfg.pitch);
    setVal('voice-speed', cfg.rate); setDisp('speed-val', cfg.rate);
    setVal('voice-volume', Math.round(cfg.volume * 100)); setDisp('volume-val', Math.round(cfg.volume * 100), '%');
}

function previewVoice() {
    applyVoiceSettings();
    const previewInput = document.getElementById('preview-text');
    const customText = previewInput ? previewInput.value.trim() : '';
    const previews = [
        "Bro you're testing my voice right now? I have better things to do.",
        "This is what peak vocal performance sounds like dude. Take notes.",
        "Ugh fine here's your sound check. Can I go now?",
        "You wanted to hear me talk? Kinda weird but whatever bro.",
        "I sound amazing and I know it. This preview is a gift to you honestly.",
    ];
    const text = customText || previews[Math.floor(Math.random() * previews.length)];
    stopAudio();
    chadVoice.speak(text);
    const status = document.getElementById('settings-status');
    if (status) {
        status.textContent = 'Playing: ' + text.substring(0, 60) + (text.length > 60 ? '...' : '');
        status.style.color = 'var(--green)';
        setTimeout(() => { status.textContent = ''; }, 6000);
    }
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

// The image models got repossessed in the cloud migration \u2014 Chad now roasts
// the prompt and refuses instead. Same energy, no GPU.
async function generateVision() {
    const input = document.getElementById('vision-prompt');
    const prompt = input.value.trim();
    if (!prompt || visionGenerating) return;

    visionGenerating = true;
    input.value = '';
    document.getElementById('vision-generate').disabled = true;
    const status = document.getElementById('vision-status');
    const loadingMessages = [
        '[HOLD ON BRO I\'M CONSIDERING IT...]',
        '[EVALUATING YOUR STUPID REQUEST...]',
        '[THIS BETTER BE WORTH MY TIME...]',
        '[CONSULTING THE VISUAL CORTEX...]',
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
    const wrap = document.createElement('div');
    wrap.className = 'vision-image-wrap';
    const caption = document.createElement('div');
    caption.className = 'vision-caption';
    caption.textContent = '> ' + prompt;
    wrap.appendChild(caption);
    const denied = document.createElement('div');
    denied.className = 'vision-comment';
    denied.style.cssText = 'font-size:15px;padding:12px 4px;';
    denied.textContent = '';
    wrap.appendChild(denied);
    output.appendChild(wrap);
    output.scrollTop = output.scrollHeight;

    let comment = '';
    try {
        const resp = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'vision', prompt }),
        });
        if (resp.ok) {
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                comment += decoder.decode(value, { stream: true });
                denied.textContent = comment;
                output.scrollTop = output.scrollHeight;
            }
        }
    } catch (e) {}

    if (!comment.trim()) {
        comment = "RENDER DENIED. The visual cortex got repossessed and honestly your prompt didn't deserve it anyway.";
        denied.textContent = comment;
    }

    status.textContent = '';
    if (typeof chadAudio !== 'undefined') chadAudio.playGlitch();
    flickerEffect.glitchBurst(4);
    staticEffect.spike(0.3, 400);
    stopAudio();
    chadVoice.speak(comment);

    visionGenerating = false;
    document.getElementById('vision-generate').disabled = false;
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
    bind('voice-pitch', 'pitch-val');
    bind('voice-volume', 'volume-val', '%');
    bind('boot-volume', 'boot-vol-val', '%');

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
