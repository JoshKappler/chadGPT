// chadVoice, Chad's voice via /api/tts (OpenAI speech, server-side key).
// Sentences are fetched as mp3 the moment they're queued (so generation
// overlaps playback), played through Web Audio, with mouth amplitude read
// from a live analyser. Falls back to browser speechSynthesis if the
// endpoint is missing or errors, so the site never goes mute.

var chadVoice = (function () {
    'use strict';

    var VOICES = [
        { name: 'cedar', lang: 'deep, natural' },
        { name: 'ash', lang: 'deep, gritty' },
        { name: 'onyx', lang: 'deep, classic' },
        { name: 'echo', lang: 'male' },
        { name: 'verse', lang: 'male' },
        { name: 'marin', lang: 'natural' },
        { name: 'ballad', lang: 'smooth' },
    ];

    var queue = [];            // { text, promise, abort }
    var playing = false;
    var generation = 0;        // bumped on stop() so stale callbacks are ignored
    var fallbackMode = false;  // flipped after a TTS failure, session-sticky
    var _idleHooks = [];
    var _amp = 0;

    var ctx = null, analyser = null, gainNode = null, currentSource = null;
    var _timeData = null;

    var cfg = {
        voiceName: localStorage.getItem('chad2_voice') || '',
        pitch: parseFloat(localStorage.getItem('chad2_pitch') || '1.0'),
        rate: parseFloat(localStorage.getItem('chad2_rate') || '1.0'),
        volume: parseFloat(localStorage.getItem('chad2_volume') || '1.0'),
    };

    var synthSupported = ('speechSynthesis' in window) && ('SpeechSynthesisUtterance' in window);

    function ensureCtx() {
        if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { fallbackMode = true; return; }
        ctx = new AC();
        gainNode = ctx.createGain();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        _timeData = new Uint8Array(analyser.fftSize);
        gainNode.connect(analyser);
        analyser.connect(ctx.destination);
    }

    function cleanText(text) {
        text = String(text || '');
        text = text.replace(/\*[^*]+\*/g, '');
        text = text.replace(/[#`_]/g, ' ');
        text = text.replace(/[\u{1f300}-\u{1faff}\u{2700}-\u{27bf}\u{fe00}-\u{fe0f}]/gu, '');
        return text.trim();
    }

    function fetchTTS(text, abort) {
        return fetch('/api/tts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: abort.signal,
            body: JSON.stringify({ text: text, voice: cfg.voiceName || undefined, speed: cfg.rate }),
        }).then(function (r) {
            if (!r.ok) throw new Error('tts ' + r.status);
            return r.arrayBuffer();
        });
    }

    function speak(text) {
        text = cleanText(text);
        if (!text) return;
        if (fallbackMode || !window.fetch) {
            queue.push({ text: text, promise: Promise.resolve(null), abort: null });
            pump();
            return;
        }
        ensureCtx();
        var abort = new AbortController();
        var item = {
            text: text,
            abort: abort,
            promise: fetchTTS(text, abort).catch(function (e) {
                if (e.name !== 'AbortError') {
                    console.warn('[chadVoice] TTS failed, falling back to speechSynthesis:', e.message);
                    fallbackMode = true;
                }
                return null;
            }),
        };
        queue.push(item);
        pump();
    }

    function pump() {
        if (playing) return;
        if (queue.length === 0) { fireIdle(); return; }
        playing = true;
        var item = queue.shift();
        var gen = generation;
        item.promise.then(function (buf) {
            if (gen !== generation) return;
            if (!buf || !ctx) { speakFallback(item.text, gen); return; }
            ctx.decodeAudioData(buf.slice(0), function (audio) {
                if (gen !== generation) return;
                var src = ctx.createBufferSource();
                src.buffer = audio;
                src.playbackRate.value = cfg.pitch;
                gainNode.gain.value = cfg.volume;
                src.connect(gainNode);
                src.onended = function () { if (gen === generation) done(); };
                currentSource = src;
                if (typeof chadAvatar !== 'undefined' && chadAvatar) chadAvatar.startTalking();
                src.start();
            }, function () {
                if (gen === generation) speakFallback(item.text, gen);
            });
        });
    }

    function done() {
        playing = false;
        currentSource = null;
        _amp = 0;
        pump();
    }

    function speakFallback(text, gen) {
        if (!synthSupported) { if (gen === generation) done(); return; }
        var u = new SpeechSynthesisUtterance(text);
        var list = speechSynthesis.getVoices();
        for (var i = 0; i < list.length; i++) {
            if (list[i].lang && list[i].lang.indexOf('en') === 0) { u.voice = list[i]; break; }
        }
        u.pitch = 0.6;
        u.rate = Math.min(2, Math.max(0.5, cfg.rate * 1.05));
        u.volume = cfg.volume;
        u.onstart = function () {
            if (gen !== generation) return;
            if (typeof chadAvatar !== 'undefined' && chadAvatar) chadAvatar.startTalking();
        };
        function fin() { if (gen === generation) done(); }
        u.onend = fin;
        u.onerror = fin;
        speechSynthesis.speak(u);
    }

    function fireIdle() {
        if (typeof chadAvatar !== 'undefined' && chadAvatar) chadAvatar.stopTalking();
        for (var i = 0; i < _idleHooks.length; i++) {
            try { _idleHooks[i](); } catch (e) {}
        }
    }

    function stop() {
        generation++;
        for (var i = 0; i < queue.length; i++) {
            if (queue[i].abort) { try { queue[i].abort.abort(); } catch (e) {} }
        }
        queue = [];
        if (currentSource) { try { currentSource.stop(); } catch (e) {} currentSource = null; }
        if (synthSupported) speechSynthesis.cancel();
        playing = false;
        _amp = 0;
        fireIdle();
    }

    function busy() {
        return playing || queue.length > 0 ||
            (synthSupported && (speechSynthesis.speaking || speechSynthesis.pending));
    }

    // Real amplitude from the analyser; simulated flutter on the fallback path.
    function getAmplitude() {
        if (!busy()) return 0;
        if (currentSource && analyser) {
            analyser.getByteTimeDomainData(_timeData);
            var sum = 0;
            for (var i = 0; i < _timeData.length; i++) {
                var d = (_timeData[i] - 128) / 128;
                sum += d * d;
            }
            var rms = Math.sqrt(sum / _timeData.length);
            _amp = Math.max(_amp * 0.85, Math.min(1, rms * 4));
            return _amp;
        }
        if (!playing) return 0;
        var t = Date.now() / 1000;
        var flutter = 0.3 + 0.25 * Math.abs(Math.sin(t * 9)) + 0.15 * Math.abs(Math.sin(t * 23));
        _amp = Math.max(_amp * 0.92, flutter * 0.8);
        return Math.min(1, _amp);
    }

    function setConfig(patch) {
        if (patch.voiceName !== undefined) cfg.voiceName = patch.voiceName;
        if (patch.pitch !== undefined) cfg.pitch = Math.min(2, Math.max(0.5, parseFloat(patch.pitch) || 1.0));
        if (patch.rate !== undefined) cfg.rate = Math.min(1.5, Math.max(0.5, parseFloat(patch.rate) || 1.0));
        if (patch.volume !== undefined) cfg.volume = Math.min(1, Math.max(0, parseFloat(patch.volume) || 1));
        localStorage.setItem('chad2_voice', cfg.voiceName);
        localStorage.setItem('chad2_pitch', String(cfg.pitch));
        localStorage.setItem('chad2_rate', String(cfg.rate));
        localStorage.setItem('chad2_volume', String(cfg.volume));
    }

    function onIdle(fn) { _idleHooks.push(fn); }

    return {
        speak: speak,
        stop: stop,
        busy: busy,
        getAmplitude: getAmplitude,
        setConfig: setConfig,
        getConfig: function () { return { voiceName: cfg.voiceName, pitch: cfg.pitch, rate: cfg.rate, volume: cfg.volume }; },
        voices: function () { return VOICES; },
        onIdle: onIdle,
        supported: true,
    };
})();
