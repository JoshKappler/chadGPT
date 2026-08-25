// chadVoice, Chad's voice via /api/tts (OpenAI speech, server-side key).
// Sentences are fetched as mp3 the moment they're queued (so generation
// overlaps playback) and played through a shared <audio> element wired
// into wawa-lipsync, which yields real-time visemes, band energies and
// volume for the avatar. Falls back to browser speechSynthesis if the
// endpoint is missing or errors, so the site never goes mute.

var chadVoice = (function () {
    'use strict';

    // Fallback list; the live list comes from GET /api/tts (backend-dependent)
    var VOICES = [
        { name: 'ash', lang: 'neural' },
        { name: 'cedar', lang: 'neural' },
        { name: 'onyx', lang: 'neural' },
    ];
    if (window.fetch) {
        fetch('/api/tts').then(function (r) { return r.json(); }).then(function (j) {
            if (j && j.voices && j.voices.length) {
                VOICES = j.voices;
                if (typeof populateVoiceList === 'function') populateVoiceList();
            }
        }).catch(function () {});
    }

    var queue = [];            // { text, promise, abort }
    var playing = false;
    var generation = 0;        // bumped on stop() so stale callbacks are ignored
    var fallbackMode = false;  // capability flag: no Audio/AudioContext at all
    var _ttsFailedAt = 0;      // last endpoint failure; retried after a cooldown
    var _idleHooks = [];
    var _amp = 0;
    var _viseme = '';
    var _bands = [];
    var _rafId = null;

    var audioEl = null;
    var lipsync = null;
    var _lastUrl = null;

    var cfg = {
        voiceName: localStorage.getItem('chad2_voice') || '',
        pitch: parseFloat(localStorage.getItem('chad2_pitch') || '1.0'),
        rate: parseFloat(localStorage.getItem('chad2_rate') || '1.0'),
        volume: parseFloat(localStorage.getItem('chad2_volume') || '1.0'),
    };

    var synthSupported = ('speechSynthesis' in window) && ('SpeechSynthesisUtterance' in window);

    function ensureAudio() {
        if (audioEl) return true;
        try {
            audioEl = new Audio();
            var W = window['Wawa-lipsync'];
            if (W && W.Lipsync) lipsync = new W.Lipsync();
            return true;
        } catch (e) {
            console.warn('[chadVoice] audio init failed:', e.message);
            fallbackMode = true;
            return false;
        }
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
            return r.blob();
        });
    }

    function speak(text) {
        text = cleanText(text);
        if (!text) return;
        if (fallbackMode || (Date.now() - _ttsFailedAt < 30000) || !window.fetch || !ensureAudio()) {
            queue.push({ text: text, promise: Promise.resolve(null), abort: null });
            pump();
            return;
        }
        var abort = new AbortController();
        var item = {
            text: text,
            abort: abort,
            promise: fetchTTS(text, abort).catch(function (e) {
                if (e.name !== 'AbortError') {
                    console.warn('[chadVoice] TTS failed, retrying endpoint in 30s:', e.message);
                    _ttsFailedAt = Date.now();
                }
                return null;
            }),
        };
        queue.push(item);
        pump();
    }

    // Per-frame lipsync analysis while the element plays
    function analyseLoop() {
        _rafId = null;
        if (!playing || !lipsync) return;
        try {
            lipsync.processAudio();
            _viseme = lipsync.viseme || '';
            var f = lipsync.features;
            if (f) {
                _amp = Math.max(_amp * 0.8, Math.min(1, (f.volume || 0) * 2.2));
                _bands = f.bands || [];
            }
        } catch (e) {}
        _rafId = requestAnimationFrame(analyseLoop);
    }

    function pump() {
        if (playing) return;
        if (queue.length === 0) { fireIdle(); return; }
        playing = true;
        var item = queue.shift();
        var gen = generation;
        item.promise.then(function (blob) {
            if (gen !== generation) return;
            if (!blob || !audioEl) { speakFallback(item.text, gen); return; }
            if (_lastUrl) { URL.revokeObjectURL(_lastUrl); _lastUrl = null; }
            _lastUrl = URL.createObjectURL(blob);
            audioEl.src = _lastUrl;
            audioEl.volume = cfg.volume;
            if (Math.abs(cfg.pitch - 1.0) > 0.01) {
                audioEl.preservesPitch = false;
                audioEl.playbackRate = cfg.pitch;
            } else {
                audioEl.preservesPitch = true;
                audioEl.playbackRate = 1.0;
            }
            audioEl.onended = function () { if (gen === generation) done(); };
            audioEl.onerror = function () { if (gen === generation) done(); };
            try { if (lipsync) lipsync.connectAudio(audioEl); } catch (e) { lipsync = null; }
            audioEl.play().then(function () {
                if (gen !== generation) return;
                if (typeof chadAvatar !== 'undefined' && chadAvatar) chadAvatar.startTalking();
                if (lipsync && !_rafId) _rafId = requestAnimationFrame(analyseLoop);
            }).catch(function () {
                if (gen === generation) speakFallback(item.text, gen);
            });
        });
    }

    function done() {
        playing = false;
        _amp = 0;
        _viseme = '';
        _bands = [];
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
        if (audioEl) {
            try { audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load(); } catch (e) {}
        }
        if (_lastUrl) { URL.revokeObjectURL(_lastUrl); _lastUrl = null; }
        if (synthSupported) speechSynthesis.cancel();
        playing = false;
        _amp = 0;
        _viseme = '';
        _bands = [];
        fireIdle();
    }

    function busy() {
        return playing || queue.length > 0 ||
            (synthSupported && (speechSynthesis.speaking || speechSynthesis.pending));
    }

    function getAmplitude() {
        if (!busy()) return 0;
        if (playing && lipsync && _viseme) return _amp;
        if (!playing) return 0;
        // Fallback path has no analyser: simulated flutter keeps the mouth moving
        var t = Date.now() / 1000;
        var flutter = 0.3 + 0.25 * Math.abs(Math.sin(t * 9)) + 0.15 * Math.abs(Math.sin(t * 23));
        _amp = Math.max(_amp * 0.92, flutter * 0.8);
        return Math.min(1, _amp);
    }

    // Current viseme string ('viseme_aa', 'viseme_PP', ...) or '' when unknown
    function getViseme() {
        return (playing && lipsync) ? _viseme : '';
    }

    // Frequency band energies (roughly 0..1) or [] when unavailable
    function getBands() {
        if (!playing || !lipsync || !_bands.length) return [];
        var out = new Array(_bands.length);
        for (var i = 0; i < _bands.length; i++) {
            out[i] = Math.min(1, Math.max(0, _bands[i] * 2.5));
        }
        return out;
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
        getViseme: getViseme,
        getBands: getBands,
        setConfig: setConfig,
        getConfig: function () { return { voiceName: cfg.voiceName, pitch: cfg.pitch, rate: cfg.rate, volume: cfg.volume }; },
        voices: function () { return VOICES; },
        onIdle: onIdle,
        supported: true,
    };
})();
