/**
 * ChadGPT Audio Engine
 *
 * Architecture:
 *   AudioContext
 *     └─ masterGain (volume slider)
 *          ├─ bootGain ──────→ bootSource   (boot.wav, one-shot)
 *          ├─ sessionGain ───→ sessionSource (loop.wav, loop=true, gapless)
 *          └─ glitchGain ───→ [one-shot glitch sources on demand]
 *
 * Lifecycle:
 *   init()                → create AudioContext + fetch/decode all buffers
 *   startBoot()           → play boot.wav at full volume, pre-start session at 0
 *   transitionToSession() → crossfade: boot→0, session→sessionLevel over 3s
 *   playGlitch()          → random short glitch/spike sound
 *   setVolume(v)          → master volume (0-1)
 *   stop()                → fade out everything, cleanup
 */

var chadAudio = (function () {
    // --- State ---
    var ctx = null;
    var masterGain = null;
    var bootGain = null;
    var sessionGain = null;
    var glitchGain = null;
    var bootSource = null;
    var sessionSource = null;

    // Decoded AudioBuffers (loaded once, reused)
    var buffers = { boot: null, loop: null, glitch: null, spike: null };

    // Config
    var SESSION_LEVEL = 0.30; // session volume relative to master
    var FADE_TIME = 3.0;      // boot→session crossfade seconds

    // --- Helpers ---
    function log(msg) { console.log('[AUDIO] ' + msg); }

    async function fetchBuffer(url) {
        var resp = await fetch(url);
        var arrayBuf = await resp.arrayBuffer();
        return await ctx.decodeAudioData(arrayBuf);
    }

    // --- Public API ---

    async function init() {
        if (ctx) {
            // Reuse existing context (handles multiple power cycles)
            if (ctx.state === 'suspended') await ctx.resume();
            log('context resumed (reuse)');
            return;
        }

        ctx = new (window.AudioContext || window.webkitAudioContext)();
        log('context created, state=' + ctx.state);

        // Master gain → destination
        masterGain = ctx.createGain();
        masterGain.gain.value = 1.0;
        masterGain.connect(ctx.destination);

        // Layer gains → master
        bootGain = ctx.createGain();
        bootGain.gain.value = 0;
        bootGain.connect(masterGain);

        sessionGain = ctx.createGain();
        sessionGain.gain.value = 0;
        sessionGain.connect(masterGain);

        glitchGain = ctx.createGain();
        glitchGain.gain.value = 1.0;
        glitchGain.connect(masterGain);

        // Fetch and decode all audio buffers in parallel
        try {
            var results = await Promise.all([
                fetchBuffer('/static/boot.wav'),
                fetchBuffer('/static/loop.wav'),
                fetchBuffer('/static/glitch.wav'),
                fetchBuffer('/static/spike.wav'),
            ]);
            buffers.boot = results[0];
            buffers.loop = results[1];
            buffers.glitch = results[2];
            buffers.spike = results[3];
            log('all buffers decoded: boot=' + buffers.boot.duration.toFixed(1) + 's, loop=' + buffers.loop.duration.toFixed(1) + 's');
        } catch (e) {
            log('buffer decode error: ' + e.message);
        }
    }

    function startBoot() {
        if (!ctx || !buffers.boot || !buffers.loop) {
            log('startBoot: not ready');
            return;
        }

        // Stop any existing sources
        _stopSources();

        var now = ctx.currentTime;
        var bootDur = buffers.boot.duration;

        // --- Boot source: plays once ---
        bootSource = ctx.createBufferSource();
        bootSource.buffer = buffers.boot;
        bootSource.loop = false;
        bootSource.connect(bootGain);

        // Boot fades in quickly, then slowly fades out over its full duration
        // so it blends gradually into the session loop
        bootGain.gain.setValueAtTime(0, now);
        bootGain.gain.linearRampToValueAtTime(1.0, now + 0.3);         // quick fade in
        bootGain.gain.setValueAtTime(1.0, now + 3);                     // hold full for 3s
        bootGain.gain.linearRampToValueAtTime(0.15, now + bootDur);     // slow fade to 15%

        bootSource.start(0);
        log('boot started, dur=' + bootDur.toFixed(1) + 's (fading over full duration)');

        // --- Session loop: starts alongside boot, fading IN over boot duration ---
        // So the loop is already present and rising while boot plays
        sessionSource = ctx.createBufferSource();
        sessionSource.buffer = buffers.loop;
        sessionSource.loop = true;
        sessionSource.connect(sessionGain);

        sessionGain.gain.setValueAtTime(0, now);
        sessionGain.gain.linearRampToValueAtTime(SESSION_LEVEL * 0.5, now + bootDur * 0.5);  // half level at midpoint
        sessionGain.gain.linearRampToValueAtTime(SESSION_LEVEL, now + bootDur);               // full session level by boot end

        sessionSource.start(0);
        log('session loop rising alongside boot (0 → ' + SESSION_LEVEL + ' over ' + bootDur.toFixed(1) + 's)');
    }

    function transitionToSession() {
        if (!ctx) return;
        var now = ctx.currentTime;

        // Boot is already fading on its own schedule from startBoot().
        // Now finish it off: whatever level it's at, fade to 0 over FADE_TIME.
        if (bootGain) {
            bootGain.gain.cancelScheduledValues(now);
            bootGain.gain.setValueAtTime(bootGain.gain.value, now);
            bootGain.gain.linearRampToValueAtTime(0, now + FADE_TIME);
        }

        // Session should already be near SESSION_LEVEL from the ramp in startBoot().
        // Ensure it's exactly at the target.
        if (sessionGain) {
            sessionGain.gain.cancelScheduledValues(now);
            sessionGain.gain.setValueAtTime(sessionGain.gain.value, now);
            sessionGain.gain.linearRampToValueAtTime(SESSION_LEVEL, now + FADE_TIME);
        }

        log('transition: boot→0, session→' + SESSION_LEVEL + ' over ' + FADE_TIME + 's');

        // Clean up boot source after fade completes
        setTimeout(function () {
            if (bootSource) {
                try { bootSource.stop(); } catch (e) {}
                bootSource = null;
                log('boot source stopped');
            }
        }, (FADE_TIME + 0.5) * 1000);
    }

    function playGlitch() {
        if (!ctx || !glitchGain) return;

        // Pick random buffer
        var buf = Math.random() > 0.5 ? buffers.glitch : buffers.spike;
        if (!buf) return;

        var src = ctx.createBufferSource();
        src.buffer = buf;
        // Randomize pitch/rate for variety
        src.playbackRate.value = 0.7 + Math.random() * 0.8; // 0.7 – 1.5
        // Random volume (subtle)
        var g = ctx.createGain();
        g.gain.value = 0.05 + Math.random() * 0.15;
        src.connect(g);
        g.connect(glitchGain);
        src.start(0);
        // Auto-cleanup
        src.onended = function () { g.disconnect(); };
    }

    function setVolume(v) {
        if (masterGain && ctx) {
            masterGain.gain.setValueAtTime(Math.max(0, Math.min(1, v)), ctx.currentTime);
        }
    }

    function playSubstationSwitch() {
        // Synthesized high-voltage breaker/contactor sound
        // Loud mechanical CLUNK + electrical buzz + arc crackle
        if (!ctx) return;
        var now = ctx.currentTime;
        var out = ctx.destination; // bypass master gain — this should be LOUD

        // 1. Heavy mechanical CLUNK — low-freq transient
        var clunkBuf = ctx.createBuffer(1, ctx.sampleRate * 0.15, ctx.sampleRate);
        var clunkData = clunkBuf.getChannelData(0);
        for (var i = 0; i < clunkData.length; i++) {
            var t = i / ctx.sampleRate;
            // Sharp attack, quick decay, low frequency
            clunkData[i] = Math.sin(t * 80 * Math.PI * 2) * Math.exp(-t * 30) * 0.9;
            // Add some metallic ring
            clunkData[i] += Math.sin(t * 220 * Math.PI * 2) * Math.exp(-t * 50) * 0.3;
            clunkData[i] += Math.sin(t * 440 * Math.PI * 2) * Math.exp(-t * 70) * 0.15;
        }
        var clunkSrc = ctx.createBufferSource();
        clunkSrc.buffer = clunkBuf;
        var clunkGain = ctx.createGain();
        clunkGain.gain.value = 0.8;
        clunkSrc.connect(clunkGain);
        clunkGain.connect(out);
        clunkSrc.start(now);

        // 2. Electrical arc buzz — harsh filtered noise burst
        var arcLen = ctx.sampleRate * 0.4;
        var arcBuf = ctx.createBuffer(1, arcLen, ctx.sampleRate);
        var arcData = arcBuf.getChannelData(0);
        for (var i = 0; i < arcLen; i++) {
            var t = i / ctx.sampleRate;
            // Noise modulated by 60Hz hum (mains frequency)
            var hum = Math.sin(t * 60 * Math.PI * 2);
            var noise = (Math.random() * 2 - 1);
            // Fast attack, medium decay
            var env = Math.exp(-t * 6) * (1 - Math.exp(-t * 200));
            arcData[i] = noise * hum * env * 0.5;
            // Add some 120Hz buzz harmonics
            arcData[i] += Math.sin(t * 120 * Math.PI * 2) * env * 0.3;
            arcData[i] += Math.sin(t * 180 * Math.PI * 2) * env * 0.15;
        }
        var arcSrc = ctx.createBufferSource();
        arcSrc.buffer = arcBuf;
        var arcFilter = ctx.createBiquadFilter();
        arcFilter.type = 'bandpass';
        arcFilter.frequency.value = 200;
        arcFilter.Q.value = 1.5;
        var arcGain = ctx.createGain();
        arcGain.gain.value = 0.7;
        arcSrc.connect(arcFilter);
        arcFilter.connect(arcGain);
        arcGain.connect(out);
        arcSrc.start(now + 0.02);

        // 3. Crackle tail — random pops
        var crackleLen = ctx.sampleRate * 0.6;
        var crackleBuf = ctx.createBuffer(1, crackleLen, ctx.sampleRate);
        var crackleData = crackleBuf.getChannelData(0);
        for (var i = 0; i < crackleLen; i++) {
            var t = i / ctx.sampleRate;
            // Random sharp transients
            if (Math.random() < 0.008) {
                var pop = (Math.random() > 0.5 ? 1 : -1) * (0.3 + Math.random() * 0.5);
                for (var j = 0; j < Math.min(80, crackleLen - i); j++) {
                    crackleData[i + j] = pop * Math.exp(-j / 15);
                }
            }
            crackleData[i] *= Math.exp(-t * 4); // overall decay
        }
        var crackleSrc = ctx.createBufferSource();
        crackleSrc.buffer = crackleBuf;
        var crackleGain = ctx.createGain();
        crackleGain.gain.value = 0.5;
        crackleSrc.connect(crackleGain);
        crackleGain.connect(out);
        crackleSrc.start(now + 0.05);
    }

    function messageBump() {
        if (!sessionGain || !ctx) return;
        var now = ctx.currentTime;
        var current = sessionGain.gain.value;
        sessionGain.gain.setValueAtTime(current, now);
        sessionGain.gain.linearRampToValueAtTime(Math.min(1, current * 1.5), now + 0.05);
        sessionGain.gain.linearRampToValueAtTime(current, now + 0.5);
    }

    function stop() {
        if (!ctx) return;
        var now = ctx.currentTime;

        // Quick fade out
        if (masterGain) {
            masterGain.gain.setValueAtTime(masterGain.gain.value, now);
            masterGain.gain.linearRampToValueAtTime(0, now + 0.3);
        }

        // Stop sources after fade
        setTimeout(function () {
            _stopSources();
            // Reset gains for next power cycle
            if (bootGain) bootGain.gain.value = 0;
            if (sessionGain) sessionGain.gain.value = 0;
            if (masterGain) masterGain.gain.value = 1.0;
            log('stopped');
        }, 400);
    }

    function _stopSources() {
        if (bootSource) { try { bootSource.stop(); } catch (e) {} bootSource = null; }
        if (sessionSource) { try { sessionSource.stop(); } catch (e) {} sessionSource = null; }
    }

    // --- Keyboard clack synthesis ---
    // Generates varied mechanical key sounds from noise bursts + resonant filter
    // Connects directly to AudioContext destination (not through master gain)
    // so ambient music doesn't drown it out
    function playKeyClack() {
        if (!ctx) return;

        var now = ctx.currentTime;

        // Longer noise burst for more audible click
        var duration = 0.025 + Math.random() * 0.035; // 25-60ms
        var sampleRate = ctx.sampleRate;
        var frameCount = Math.floor(sampleRate * duration);
        var noiseBuffer = ctx.createBuffer(1, frameCount, sampleRate);
        var data = noiseBuffer.getChannelData(0);
        for (var i = 0; i < frameCount; i++) {
            var env = Math.exp(-i / (frameCount * 0.25));
            data[i] = (Math.random() * 2 - 1) * env;
        }

        var src = ctx.createBufferSource();
        src.buffer = noiseBuffer;

        // Bandpass filter — vary center frequency for different key sounds
        var filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 1500 + Math.random() * 3500; // 1.5-5kHz
        filter.Q.value = 1.0 + Math.random() * 2;

        // Resonant body thud for bottom-out
        var thudOsc = ctx.createOscillator();
        thudOsc.type = 'sine';
        thudOsc.frequency.value = 60 + Math.random() * 80; // 60-140Hz
        var thudGain = ctx.createGain();
        thudGain.gain.setValueAtTime(0.25, now);
        thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        thudOsc.connect(thudGain);
        // Connect directly to destination, bypassing master gain
        thudGain.connect(ctx.destination);
        thudOsc.start(now);
        thudOsc.stop(now + 0.05);

        var clickGain = ctx.createGain();
        clickGain.gain.value = 0.35 + Math.random() * 0.2; // 0.35-0.55 — loud and clear
        src.connect(filter);
        filter.connect(clickGain);
        // Connect directly to destination so ambient doesn't mask it
        clickGain.connect(ctx.destination);
        src.start(now);
        src.onended = function() { clickGain.disconnect(); filter.disconnect(); thudGain.disconnect(); };
    }

    // --- Tape warble sound (wobbly pitch variation like a worn cassette) ---
    function playTapeWarble() {
        if (!ctx) return;
        var now = ctx.currentTime;
        var dur = 0.2 + Math.random() * 0.4;
        // Detuned oscillator pair for chorus/warble
        var osc1 = ctx.createOscillator();
        var osc2 = ctx.createOscillator();
        osc1.type = 'sine';
        osc2.type = 'sine';
        var baseFreq = 80 + Math.random() * 200;
        osc1.frequency.value = baseFreq;
        osc2.frequency.value = baseFreq * (1.01 + Math.random() * 0.03);
        // Wobble LFO on osc1
        var lfo = ctx.createOscillator();
        lfo.frequency.value = 4 + Math.random() * 12;
        var lfoGain = ctx.createGain();
        lfoGain.gain.value = 5 + Math.random() * 15;
        lfo.connect(lfoGain);
        lfoGain.connect(osc1.frequency);
        lfo.start(now);
        lfo.stop(now + dur);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.03 + Math.random() * 0.03, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + dur);
        osc1.connect(g);
        osc2.connect(g);
        g.connect(masterGain);
        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + dur);
        osc2.stop(now + dur);
    }

    // --- Head switch click (sharp transient like VHS head switching) ---
    function playHeadSwitch() {
        if (!ctx) return;
        var now = ctx.currentTime;
        var dur = 0.015;
        var sampleRate = ctx.sampleRate;
        var frameCount = Math.floor(sampleRate * dur);
        var buf = ctx.createBuffer(1, frameCount, sampleRate);
        var data = buf.getChannelData(0);
        // Sharp transient click
        for (var i = 0; i < frameCount; i++) {
            data[i] = (i < frameCount * 0.3 ? 1 : -1) * Math.exp(-i / (frameCount * 0.1)) * (0.5 + Math.random() * 0.5);
        }
        var src = ctx.createBufferSource();
        src.buffer = buf;
        var g = ctx.createGain();
        g.gain.value = 0.08 + Math.random() * 0.06;
        var hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 800;
        src.connect(hp);
        hp.connect(g);
        g.connect(masterGain);
        src.start(now);
    }

    // --- Tape hiss burst (short burst of filtered noise like tape oxide) ---
    function playTapeHiss() {
        if (!ctx) return;
        var now = ctx.currentTime;
        var dur = 0.1 + Math.random() * 0.3;
        var sampleRate = ctx.sampleRate;
        var frameCount = Math.floor(sampleRate * dur);
        var buf = ctx.createBuffer(1, frameCount, sampleRate);
        var data = buf.getChannelData(0);
        for (var i = 0; i < frameCount; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.5;
        }
        var src = ctx.createBufferSource();
        src.buffer = buf;
        var bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 4000 + Math.random() * 6000;
        bp.Q.value = 0.5;
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.02 + Math.random() * 0.03, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + dur);
        src.connect(bp);
        bp.connect(g);
        g.connect(masterGain);
        src.start(now);
    }

    // --- 8-bit glitch sounds (FNAF-style) ---

    // Bitcrusher: reduces sample resolution for that crunchy NES sound
    function bitcrush(data, bits) {
        var step = Math.pow(0.5, bits);
        for (var i = 0; i < data.length; i++) {
            data[i] = step * Math.floor(data[i] / step + 0.5);
        }
    }

    // FNAF-style distorted chirp — rapid pitch sweep through square wave
    function play8bitChirp() {
        if (!ctx) return;
        var now = ctx.currentTime;
        var dur = 0.08 + Math.random() * 0.15;
        var sr = ctx.sampleRate;
        var len = Math.floor(sr * dur);
        var buf = ctx.createBuffer(1, len, sr);
        var data = buf.getChannelData(0);
        var startFreq = 200 + Math.random() * 1800;
        var endFreq = 50 + Math.random() * 3000;
        for (var i = 0; i < len; i++) {
            var t = i / sr;
            var progress = i / len;
            var freq = startFreq + (endFreq - startFreq) * progress;
            // Square wave
            var phase = (t * freq) % 1;
            data[i] = (phase < 0.5 ? 0.6 : -0.6) * Math.exp(-progress * 3);
        }
        bitcrush(data, 4 + Math.floor(Math.random() * 3)); // 4-6 bit crush
        var src = ctx.createBufferSource();
        src.buffer = buf;
        var g = ctx.createGain();
        g.gain.value = 0.04 + Math.random() * 0.06;
        src.connect(g);
        g.connect(masterGain);
        src.start(now);
        src.onended = function() { g.disconnect(); };
    }

    // NES noise channel burst — the classic "kshh" static used in FNAF jumpscare buildups
    function play8bitNoise() {
        if (!ctx) return;
        var now = ctx.currentTime;
        var dur = 0.05 + Math.random() * 0.2;
        var sr = ctx.sampleRate;
        var len = Math.floor(sr * dur);
        var buf = ctx.createBuffer(1, len, sr);
        var data = buf.getChannelData(0);
        // NES-style LFSR noise (15-bit linear feedback shift register)
        var lfsr = 1;
        var period = 4 + Math.floor(Math.random() * 60); // sample-and-hold period
        var val = 0;
        for (var i = 0; i < len; i++) {
            if (i % period === 0) {
                var bit = ((lfsr >> 1) ^ lfsr) & 1;
                lfsr = (lfsr >> 1) | (bit << 14);
                val = (lfsr & 1) ? 0.5 : -0.5;
            }
            data[i] = val * Math.exp(-(i / len) * 4);
        }
        bitcrush(data, 3 + Math.floor(Math.random() * 2));
        var src = ctx.createBufferSource();
        src.buffer = buf;
        var g = ctx.createGain();
        g.gain.value = 0.03 + Math.random() * 0.05;
        src.connect(g);
        g.connect(masterGain);
        src.start(now);
        src.onended = function() { g.disconnect(); };
    }

    // FNAF corridor ambience — low bitcrushed drone with wobble
    function play8bitDrone() {
        if (!ctx) return;
        var now = ctx.currentTime;
        var dur = 0.3 + Math.random() * 0.5;
        var sr = ctx.sampleRate;
        var len = Math.floor(sr * dur);
        var buf = ctx.createBuffer(1, len, sr);
        var data = buf.getChannelData(0);
        var freq = 40 + Math.random() * 80; // low drone
        for (var i = 0; i < len; i++) {
            var t = i / sr;
            var progress = i / len;
            // Triangle wave with slow pitch wobble
            var wobble = Math.sin(t * 3) * 8;
            var phase = ((t * (freq + wobble)) % 1);
            data[i] = (phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4) * 0.5;
            // Amplitude envelope: fade in and out
            var env = Math.sin(progress * Math.PI);
            data[i] *= env;
        }
        bitcrush(data, 5);
        var src = ctx.createBufferSource();
        src.buffer = buf;
        var g = ctx.createGain();
        g.gain.value = 0.03 + Math.random() * 0.04;
        src.connect(g);
        g.connect(masterGain);
        src.start(now);
        src.onended = function() { g.disconnect(); };
    }

    // FNAF power-flicker stinger — rapid descending arpeggio
    function play8bitStinger() {
        if (!ctx) return;
        var now = ctx.currentTime;
        var sr = ctx.sampleRate;
        var noteCount = 3 + Math.floor(Math.random() * 4);
        var noteDur = 0.03 + Math.random() * 0.04;
        var totalLen = Math.floor(sr * noteDur * noteCount);
        var buf = ctx.createBuffer(1, totalLen, sr);
        var data = buf.getChannelData(0);
        var baseFreq = 800 + Math.random() * 1200;
        for (var n = 0; n < noteCount; n++) {
            var noteStart = Math.floor(n * noteDur * sr);
            var noteEnd = Math.floor((n + 1) * noteDur * sr);
            var freq = baseFreq * Math.pow(0.75, n); // descending
            for (var i = noteStart; i < noteEnd && i < totalLen; i++) {
                var t = (i - noteStart) / sr;
                var phase = (t * freq) % 1;
                // Pulse wave (25% duty cycle — classic chiptune)
                data[i] = (phase < 0.25 ? 0.5 : -0.5) * Math.exp(-t * 20);
            }
        }
        bitcrush(data, 4);
        var src = ctx.createBufferSource();
        src.buffer = buf;
        var g = ctx.createGain();
        g.gain.value = 0.04 + Math.random() * 0.05;
        src.connect(g);
        g.connect(masterGain);
        src.start(now);
        src.onended = function() { g.disconnect(); };
    }

    // --- Dropout silence (brief volume dip simulating signal loss) ---
    function playDropout() {
        if (!ctx || !sessionGain) return;
        var now = ctx.currentTime;
        var current = sessionGain.gain.value;
        var dropDur = 0.05 + Math.random() * 0.15;
        sessionGain.gain.setValueAtTime(current, now);
        sessionGain.gain.linearRampToValueAtTime(current * 0.1, now + 0.01);
        sessionGain.gain.linearRampToValueAtTime(current, now + dropDur);
    }

    // --- Ambient glitch sounds (periodic random noises) ---
    var _ambientInterval = null;
    function startAmbientGlitches() {
        if (_ambientInterval) return;
        function scheduleNext() {
            var nextDelay = 2000 + Math.random() * 6000;
            _ambientInterval = setTimeout(function() {
                if (!ctx) { scheduleNext(); return; }
                var r = Math.random();
                if (r < 0.15) {
                    // Digital chirp
                    var osc = ctx.createOscillator();
                    osc.type = 'square';
                    osc.frequency.value = 200 + Math.random() * 2000;
                    var g = ctx.createGain();
                    g.gain.setValueAtTime(0.02 + Math.random() * 0.04, ctx.currentTime);
                    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
                    osc.connect(g);
                    g.connect(masterGain);
                    osc.start(ctx.currentTime);
                    osc.stop(ctx.currentTime + 0.08);
                } else if (r < 0.30) {
                    // Static crackle
                    playGlitch();
                } else if (r < 0.40) {
                    // Low hum pulse
                    var osc = ctx.createOscillator();
                    osc.type = 'sine';
                    osc.frequency.value = 50 + Math.random() * 30;
                    var g = ctx.createGain();
                    g.gain.setValueAtTime(0.03, ctx.currentTime);
                    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
                    osc.connect(g);
                    g.connect(masterGain);
                    osc.start(ctx.currentTime);
                    osc.stop(ctx.currentTime + 0.3);
                } else if (r < 0.55) {
                    // Tape warble
                    playTapeWarble();
                } else if (r < 0.65) {
                    // Head switch click
                    playHeadSwitch();
                } else if (r < 0.75) {
                    // Tape hiss burst
                    playTapeHiss();
                } else if (r < 0.82) {
                    // Dropout (brief signal loss)
                    playDropout();
                } else if (r < 0.87) {
                    // 8-bit chirp (FNAF-style)
                    play8bitChirp();
                } else if (r < 0.91) {
                    // NES noise burst
                    play8bitNoise();
                } else if (r < 0.95) {
                    // 8-bit low drone
                    play8bitDrone();
                } else if (r < 0.98) {
                    // 8-bit descending stinger
                    play8bitStinger();
                }
                // else: silence
                scheduleNext();
            }, nextDelay);
        }
        scheduleNext();
    }

    function stopAmbientGlitches() {
        if (_ambientInterval) { clearTimeout(_ambientInterval); _ambientInterval = null; }
    }

    return {
        init: init,
        startBoot: startBoot,
        transitionToSession: transitionToSession,
        playGlitch: playGlitch,
        playKeyClack: playKeyClack,
        playTapeWarble: playTapeWarble,
        playHeadSwitch: playHeadSwitch,
        playTapeHiss: playTapeHiss,
        playDropout: playDropout,
        play8bitChirp: play8bitChirp,
        play8bitNoise: play8bitNoise,
        play8bitDrone: play8bitDrone,
        play8bitStinger: play8bitStinger,
        startAmbientGlitches: startAmbientGlitches,
        stopAmbientGlitches: stopAmbientGlitches,
        setVolume: setVolume,
        messageBump: messageBump,
        playSubstationSwitch: playSubstationSwitch,
        stop: stop,
    };
})();
