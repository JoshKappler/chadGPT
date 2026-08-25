// chadVoice, Chad's voice via /api/tts (ElevenLabs, server-side key).
// Sentences are fetched as mp3 the moment they're queued (so generation
// overlaps playback) and played through a shared <audio> element wired
// into wawa-lipsync, which yields amplitude and band energies for the
// avatar. There is NO fallback voice: a synthesis failure is surfaced
// loudly in the chat feed and the console.

var chadVoice = (function () {
    'use strict';

    // Populated from GET /api/tts; empty until the server answers
    var VOICES = [];
    if (window.fetch) {
        fetch('/api/tts').then(function (r) { return r.json(); }).then(function (j) {
            if (j && j.voices && j.voices.length) {
                VOICES = j.voices;
                if (typeof populateVoiceList === 'function') populateVoiceList();
            } else if (j && j.error) {
                loudFail('voice backend down: ' + j.error);
            }
        }).catch(function () {});
    }

    var queue = [];            // { text, promise, abort }
    var playing = false;
    var generation = 0;        // bumped on stop() so stale callbacks are ignored
    var _audioBroken = false;  // no Audio/AudioContext in this browser
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

    function loudFail(msg) {
        console.error('[chadVoice] ' + msg);
        if (typeof addMessage === 'function') {
            addMessage('error', '[VOX FAULT] ' + msg);
        }
    }

    function ensureAudio() {
        if (audioEl) return true;
        if (_audioBroken) return false;
        try {
            audioEl = new Audio();
            var W = window['Wawa-lipsync'];
            if (W && W.Lipsync) lipsync = new W.Lipsync();
            else console.warn('[chadVoice] wawa-lipsync missing; mouth will not move');
            return true;
        } catch (e) {
            _audioBroken = true;
            loudFail('this browser cannot play audio: ' + e.message);
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
            body: JSON.stringify({ text: text, voice: cfg.voiceName || undefined }),
        }).then(function (r) {
            if (!r.ok) {
                return r.json().catch(function () { return {}; }).then(function (j) {
                    throw new Error(j.error || ('tts ' + r.status));
                });
            }
            return r.blob();
        });
    }

    function speak(text) {
        text = cleanText(text);
        if (!text || !window.fetch || !ensureAudio()) return;
        var abort = new AbortController();
        var item = {
            text: text,
            abort: abort,
            promise: fetchTTS(text, abort).catch(function (e) {
                if (e.name !== 'AbortError') loudFail('synthesis failed: ' + e.message);
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
            if (!blob) { done(); return; }
            if (_lastUrl) { URL.revokeObjectURL(_lastUrl); _lastUrl = null; }
            _lastUrl = URL.createObjectURL(blob);
            audioEl.src = _lastUrl;
            audioEl.volume = cfg.volume;
            // Pitch shifts via playbackRate (preservesPitch off); the speed
            // slider rides the same knob since the API takes no speed param
            if (Math.abs(cfg.pitch - 1.0) > 0.01) {
                audioEl.preservesPitch = false;
                audioEl.playbackRate = cfg.pitch * cfg.rate;
            } else {
                audioEl.preservesPitch = true;
                audioEl.playbackRate = cfg.rate;
            }
            audioEl.onended = function () { if (gen === generation) done(); };
            audioEl.onerror = function () {
                if (gen !== generation) return;
                loudFail('audio element refused the clip');
                done();
            };
            try { if (lipsync) lipsync.connectAudio(audioEl); } catch (e) { lipsync = null; }
            audioEl.play().then(function () {
                if (gen !== generation) return;
                if (typeof chadAvatar !== 'undefined' && chadAvatar) chadAvatar.startTalking();
                if (lipsync && !_rafId) _rafId = requestAnimationFrame(analyseLoop);
            }).catch(function (e) {
                if (gen !== generation) return;
                loudFail('playback blocked: ' + e.message);
                done();
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
        playing = false;
        _amp = 0;
        _viseme = '';
        _bands = [];
        fireIdle();
    }

    function busy() {
        return playing || queue.length > 0;
    }

    function getAmplitude() {
        return playing ? _amp : 0;
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
