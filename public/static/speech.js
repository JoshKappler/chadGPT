// chadVoice — Chad's voice via the browser's speechSynthesis.
// Replaces the old server-side TTS pipeline (Qwen3/Kokoro) with a
// per-sentence utterance queue, simulated mouth amplitude for the avatar,
// and an onIdle hook so call mode / idle taunts know when Chad shuts up.

var chadVoice = (function () {
    'use strict';

    var queue = [];
    var speaking = false;
    var generation = 0;        // bumped on stop() so stale onend callbacks are ignored
    var _amp = 0;
    var _lastBoundary = 0;
    var _idleHooks = [];

    var cfg = {
        voiceName: localStorage.getItem('chad_voice') || '',
        pitch: parseFloat(localStorage.getItem('chad_pitch') || '0.6'),
        rate: parseFloat(localStorage.getItem('chad_rate') || '1.05'),
        volume: parseFloat(localStorage.getItem('chad_volume') || '1.0'),
    };

    var supported = ('speechSynthesis' in window) && ('SpeechSynthesisUtterance' in window);

    function voices() {
        return supported ? speechSynthesis.getVoices() : [];
    }

    // Prefer an explicit pick, then deep US-English male-ish voices.
    function pickVoice() {
        var list = voices();
        if (!list.length) return null;
        if (cfg.voiceName) {
            for (var i = 0; i < list.length; i++) {
                if (list[i].name === cfg.voiceName) return list[i];
            }
        }
        var prefs = ['Microsoft David', 'Microsoft Mark', 'Microsoft Guy', 'Google US English', 'Daniel', 'Alex'];
        for (var p = 0; p < prefs.length; p++) {
            for (var j = 0; j < list.length; j++) {
                if (list[j].name.indexOf(prefs[p]) >= 0) return list[j];
            }
        }
        for (var k = 0; k < list.length; k++) {
            if (list[k].lang && list[k].lang.indexOf('en') === 0) return list[k];
        }
        return list[0];
    }

    function cleanText(text) {
        text = String(text || '');
        text = text.replace(/\*[^*]+\*/g, '');            // *actions*
        text = text.replace(/[#`_]/g, ' ');
        text = text.replace(/[\u{1f300}-\u{1faff}\u{2700}-\u{27bf}\u{fe00}-\u{fe0f}]/gu, '');
        return text.trim();
    }

    function speak(text) {
        text = cleanText(text);
        if (!text || !supported) return;
        queue.push(text);
        pump();
    }

    function pump() {
        if (speaking) return;
        if (queue.length === 0) { fireIdle(); return; }
        var text = queue.shift();
        var gen = generation;
        var u = new SpeechSynthesisUtterance(text);
        var v = pickVoice();
        if (v) u.voice = v;
        u.pitch = cfg.pitch;
        u.rate = cfg.rate;
        u.volume = cfg.volume;

        speaking = true;
        _lastBoundary = Date.now();
        u.onstart = function () {
            if (gen !== generation) return;
            _lastBoundary = Date.now();
            if (typeof chadAvatar !== 'undefined' && chadAvatar) chadAvatar.startTalking();
        };
        u.onboundary = function () {
            if (gen !== generation) return;
            _lastBoundary = Date.now();
            _amp = 0.45 + Math.random() * 0.4;
        };
        function done() {
            if (gen !== generation) return;
            speaking = false;
            _amp = 0;
            pump();
        }
        u.onend = done;
        u.onerror = done;
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
        queue = [];
        speaking = false;
        _amp = 0;
        if (supported) speechSynthesis.cancel();
        fireIdle();
    }

    function busy() {
        return speaking || queue.length > 0 ||
            (supported && (speechSynthesis.speaking || speechSynthesis.pending));
    }

    // Simulated mouth amplitude: pulses on word boundaries, flutters between.
    function getAmplitude() {
        if (!busy() || !speaking) return 0;
        // Some voices never fire onboundary — keep the mouth moving regardless
        var t = Date.now() / 1000;
        var flutter = 0.3 + 0.25 * Math.abs(Math.sin(t * 9)) + 0.15 * Math.abs(Math.sin(t * 23));
        _amp = Math.max(_amp * 0.92, flutter * 0.8);
        return Math.min(1, _amp);
    }

    function setConfig(patch) {
        if (patch.voiceName !== undefined) cfg.voiceName = patch.voiceName;
        if (patch.pitch !== undefined) cfg.pitch = Math.min(2, Math.max(0.1, parseFloat(patch.pitch) || 0.6));
        if (patch.rate !== undefined) cfg.rate = Math.min(2, Math.max(0.5, parseFloat(patch.rate) || 1.05));
        if (patch.volume !== undefined) cfg.volume = Math.min(1, Math.max(0, parseFloat(patch.volume) || 1));
        localStorage.setItem('chad_voice', cfg.voiceName);
        localStorage.setItem('chad_pitch', String(cfg.pitch));
        localStorage.setItem('chad_rate', String(cfg.rate));
        localStorage.setItem('chad_volume', String(cfg.volume));
    }

    function onIdle(fn) { _idleHooks.push(fn); }

    // Chrome loads voices async — nudge the list early.
    if (supported && speechSynthesis.onvoiceschanged === null) {
        speechSynthesis.onvoiceschanged = function () {};
    }

    return {
        speak: speak,
        stop: stop,
        busy: busy,
        getAmplitude: getAmplitude,
        setConfig: setConfig,
        getConfig: function () { return { voiceName: cfg.voiceName, pitch: cfg.pitch, rate: cfg.rate, volume: cfg.volume }; },
        voices: voices,
        onIdle: onIdle,
        supported: supported,
    };
})();
