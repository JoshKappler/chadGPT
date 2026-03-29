// ============ CHAD CALL — rotary phone dialer + voice call ============

var callState = 'idle'; // idle | dialing_screen | ringing | connected | ending
var _callTimer = null;
var _callStartTime = 0;
var _callMicStream = null;
var _callAnalyserMic = null;
var _callAnalyserChad = null;
var _callAudioCtx = null;
var _callChadSource = null;
var _callAnimFrame = null;
var _callAutoMicTimer = null;
var _callRecognition = null;
var _callRecognizing = false;
var _callRingTimer = null;
var _callTranscript = '';
var _chadImg = null;
var _chadImgLoaded = false;
var _chadGreenCanvas = null;  // green CRT processed avatar
var _chadEdgeCanvas = null;   // Sobel edge contours

// Chad's phone number: 666-2423 (666-CHAD)
var CHAD_NUMBER = '6662423';
var CHAD_NUMBER_DISPLAY = '666-CHAD';
var _dialedDigits = '';

// Preload chad image and build green CRT + edge canvases
(function() {
    _chadImg = new Image();
    _chadImg.onload = function() {
        _chadImgLoaded = true;
        _buildCallAvatar(_chadImg);
    };
    _chadImg.src = '/static/chad.jpg';
})();

function _buildCallAvatar(img) {
    var size = 400; // render at fixed size, scale when drawing
    // Face-centered square crop
    var cropSide = Math.min(img.width, img.height) * 0.85;
    var faceCX = img.width * 0.58;
    var faceCY = img.height * 0.38;
    var sx = Math.max(0, Math.min(img.width - cropSide, faceCX - cropSide / 2));
    var sy = Math.max(0, Math.min(img.height - cropSide, faceCY - cropSide / 2));

    // --- Green monochrome ---
    _chadGreenCanvas = document.createElement('canvas');
    _chadGreenCanvas.width = size; _chadGreenCanvas.height = size;
    var gCtx = _chadGreenCanvas.getContext('2d');
    gCtx.drawImage(img, sx, sy, cropSide, cropSide, 0, 0, size, size);
    var gData = gCtx.getImageData(0, 0, size, size);
    var d = gData.data;
    for (var i = 0; i < d.length; i += 4) {
        var lum = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
        d[i]   = lum * 0.03;
        d[i+1] = lum * 0.90;
        d[i+2] = lum * 0.18;
    }
    gCtx.putImageData(gData, 0, 0);

    // --- Sobel edge detection ---
    _chadEdgeCanvas = document.createElement('canvas');
    _chadEdgeCanvas.width = size; _chadEdgeCanvas.height = size;
    var eCtx = _chadEdgeCanvas.getContext('2d');
    var src = gData.data;
    var dst = new Uint8ClampedArray(src.length);
    for (var y = 1; y < size - 1; y++) {
        for (var x = 1; x < size - 1; x++) {
            var c = 1;
            var tl = src[((y-1)*size+(x-1))*4+c], tc = src[((y-1)*size+x)*4+c], tr = src[((y-1)*size+(x+1))*4+c];
            var ml = src[(y*size+(x-1))*4+c],                                      mr = src[(y*size+(x+1))*4+c];
            var bl = src[((y+1)*size+(x-1))*4+c], bc = src[((y+1)*size+x)*4+c], br = src[((y+1)*size+(x+1))*4+c];
            var gx = -tl + tr - 2*ml + 2*mr - bl + br;
            var gy = -tl - 2*tc - tr + bl + 2*bc + br;
            var mag = Math.sqrt(gx*gx + gy*gy);
            mag = mag > 18 ? Math.min(255, mag * 1.8) : 0;
            var di = (y * size + x) * 4;
            dst[di]   = mag * 0.05;
            dst[di+1] = mag;
            dst[di+2] = mag * 0.25;
            dst[di+3] = mag > 0 ? 255 : 0;
        }
    }
    eCtx.putImageData(new ImageData(dst, size, size), 0, 0);
}

// ---- Sound Effects ----

var _phoneSounds = {};
function _loadSound(name) {
    if (!_phoneSounds[name]) {
        _phoneSounds[name] = new Audio('/static/sounds/' + name + '.wav');
    }
    return _phoneSounds[name];
}

function playSound(name, volume) {
    var snd = _loadSound(name);
    snd.currentTime = 0;
    snd.volume = volume || 0.7;
    snd.play().catch(function(){});
    return snd;
}

var _ringAudio = null;
var _ringLoop = null;
function phoneRingStart() {
    _ringAudio = _loadSound('phone_ring');
    _ringAudio.volume = 0.5;
    _ringAudio.currentTime = 0;
    _ringAudio.play().catch(function(){});
    _ringLoop = setInterval(function() {
        if (_ringAudio) {
            _ringAudio.currentTime = 0;
            _ringAudio.play().catch(function(){});
        }
    }, 8000);
}

function phoneRingStop() {
    if (_ringLoop) { clearInterval(_ringLoop); _ringLoop = null; }
    if (_ringAudio) { _ringAudio.pause(); _ringAudio.currentTime = 0; _ringAudio = null; }
}

// Play N clicks for a rotary dial digit return
function playDialClicks(digit) {
    var n = digit === 0 ? 10 : digit;
    for (var i = 0; i < n; i++) {
        setTimeout(function() {
            playSound('dial_click', 0.5);
        }, i * 65);
    }
}

function _callCtx() {
    // Reuse the shared AudioContext from app.js when available
    if (typeof sharedAudioCtx !== 'undefined' && sharedAudioCtx) {
        _callAudioCtx = sharedAudioCtx;
    }
    if (!_callAudioCtx) _callAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_callAudioCtx.state === 'suspended') _callAudioCtx.resume();
    return _callAudioCtx;
}

function phoneLineCrackle() {
    var ctx = _callCtx();
    var now = ctx.currentTime;
    for (var i = 0; i < 3; i++) {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = 'square';
        o.frequency.value = 800 + Math.random() * 400;
        var t = now + Math.random() * 0.5;
        g.gain.setValueAtTime(0.015, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.015);
        o.connect(g); g.connect(ctx.destination);
        o.start(t); o.stop(t + 0.02);
    }
}

// ---- Rotary Dial ----

var _rotaryState = {
    dragging: false,
    prevMouseAngle: 0,   // last raw atan2 mouse angle (for delta calc)
    cumRotation: 0,      // accumulated clockwise rotation in radians
    currentAngle: 0,     // = cumRotation (used by drawRotaryDial)
    maxRotation: 0,      // max allowed rotation for current digit
    selectedDigit: -1,
    returning: false,
    returnAngle: 0,
    hoverDigit: -1
};

// Digit positions on a rotary dial (counter-clockwise from finger stop)
// Real rotary phone: 1 closest to finger stop, 0 furthest away
// Digits go COUNTER-CLOCKWISE (decreasing angle) from stop
var DIAL_DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
var FINGER_STOP_ANGLE = Math.PI * 0.42; // finger stop position (~4:30 on clock)
var DIGIT_ARC = Math.PI * 1.67; // total arc the 10 digits span (~300°)
var DIGIT_SPACING = DIGIT_ARC / 10; // angle between each digit

function getDigitAngle(digit) {
    var idx = DIAL_DIGITS.indexOf(digit);
    // Counter-clockwise from the finger stop (subtract angle)
    return FINGER_STOP_ANGLE - (idx + 1) * DIGIT_SPACING;
}

function getDialAngleFromMouse(canvas, x, y) {
    var rect = canvas.getBoundingClientRect();
    var cx = rect.width / 2;
    var cy = rect.height / 2;
    var dx = x - rect.left - cx;
    var dy = y - rect.top - cy;
    return Math.atan2(dy, dx);
}

function getDigitFromPosition(canvas, x, y) {
    var rect = canvas.getBoundingClientRect();
    var cx = rect.width / 2;
    var cy = rect.height / 2;
    var dx = x - rect.left - cx;
    var dy = y - rect.top - cy;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var radius = Math.min(rect.width, rect.height) * 0.38;

    // Must be near the digit ring
    if (dist < radius * 0.65 || dist > radius * 1.15) return -1;

    var angle = Math.atan2(dy, dx);
    if (angle < 0) angle += Math.PI * 2;

    // Find closest digit
    var closest = -1;
    var closestDist = 999;
    for (var i = 0; i < DIAL_DIGITS.length; i++) {
        var da = getDigitAngle(DIAL_DIGITS[i]);
        if (da < 0) da += Math.PI * 2;
        var diff = Math.abs(angle - da);
        if (diff > Math.PI) diff = Math.PI * 2 - diff;
        if (diff < closestDist && diff < 0.2) {
            closest = DIAL_DIGITS[i];
            closestDist = diff;
        }
    }
    return closest;
}

function drawRotaryDial(canvas) {
    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 2;
    var w = canvas.width = canvas.offsetWidth * dpr;
    var h = canvas.height = canvas.offsetHeight * dpr;
    var cx = w / 2, cy = h / 2;
    var radius = Math.min(w, h) * 0.38; // digit ring radius
    var holeRadius = radius * 0.13; // finger hole size

    ctx.clearRect(0, 0, w, h);

    // Scanlines
    ctx.fillStyle = 'rgba(0, 20, 0, 0.1)';
    for (var sl = 0; sl < h; sl += 4) ctx.fillRect(0, sl, w, 1);

    var rotationOffset = _rotaryState.returning ? _rotaryState.returnAngle : (_rotaryState.dragging ? _rotaryState.cumRotation : 0);

    // Outer bezel ring
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.22, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 255, 65, 0.2)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Dial plate (fixed, doesn't rotate)
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.18, 0, Math.PI * 2);
    ctx.fillStyle = '#060a06';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 255, 65, 0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Rotating dial face
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.12, 0, Math.PI * 2);
    ctx.fillStyle = '#080c08';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 255, 65, 0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Finger stop — metal bumper bar on the fixed plate
    // Drawn as a raised rectangular tab on the outer ring
    var stopAngle = FINGER_STOP_ANGLE - 0.04;
    var stopInner = radius * 1.02;
    var stopOuter = radius * 1.2;
    var stopWidth = 0.08; // angular width in radians

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(stopAngle);
    // Metal bumper shape
    ctx.beginPath();
    ctx.moveTo(stopInner, -stopOuter * stopWidth);
    ctx.lineTo(stopOuter, -stopOuter * stopWidth * 0.7);
    ctx.lineTo(stopOuter, stopOuter * stopWidth * 0.7);
    ctx.lineTo(stopInner, stopOuter * stopWidth);
    ctx.closePath();
    // Metallic gradient look
    ctx.fillStyle = '#444';
    ctx.fill();
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Highlight on top edge
    ctx.beginPath();
    ctx.moveTo(stopInner + 2, -stopOuter * stopWidth + 1);
    ctx.lineTo(stopOuter - 2, -stopOuter * stopWidth * 0.7 + 1);
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Shadow on bottom edge
    ctx.beginPath();
    ctx.moveTo(stopInner + 2, stopOuter * stopWidth - 1);
    ctx.lineTo(stopOuter - 2, stopOuter * stopWidth * 0.7 - 1);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // Digit holes + labels (both on the rotating dial — spin together)
    ctx.font = 'bold ' + (holeRadius * 1.0) + 'px "VT323", "Share Tech Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < DIAL_DIGITS.length; i++) {
        var digit = DIAL_DIGITS[i];
        var angle = getDigitAngle(digit) + rotationOffset;
        var hx = cx + Math.cos(angle) * radius;
        var hy = cy + Math.sin(angle) * radius;

        var isHover = (_rotaryState.hoverDigit === digit && !_rotaryState.dragging && !_rotaryState.returning);
        var isSelected = (_rotaryState.selectedDigit === digit && _rotaryState.dragging);

        // Hole shadow (depth effect)
        ctx.beginPath();
        ctx.arc(hx + 1, hy + 1, holeRadius, 0, Math.PI * 2);
        ctx.fillStyle = '#000';
        ctx.fill();

        // Hole
        ctx.beginPath();
        ctx.arc(hx, hy, holeRadius, 0, Math.PI * 2);
        if (isSelected) {
            ctx.fillStyle = 'rgba(0, 255, 65, 0.3)';
            ctx.strokeStyle = '#00ff41';
        } else if (isHover) {
            ctx.fillStyle = '#0a1a0a';
            ctx.strokeStyle = '#00ff41';
        } else {
            ctx.fillStyle = '#030503';
            ctx.strokeStyle = 'rgba(0, 255, 65, 0.35)';
        }
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Inner rim highlight (makes hole look concave)
        ctx.beginPath();
        ctx.arc(hx, hy, holeRadius - 2, Math.PI * 0.8, Math.PI * 1.8);
        ctx.strokeStyle = 'rgba(0, 255, 65, 0.12)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Digit label inside the hole (rotates with dial — like Rolls-Royce hubcaps)
        ctx.save();
        ctx.translate(hx, hy);
        ctx.rotate(angle + Math.PI / 2); // rotate so text faces outward from center
        ctx.fillStyle = isSelected ? '#00ff41' : (isHover ? '#00ff41' : 'rgba(0, 255, 65, 0.7)');
        ctx.fillText(String(digit), 0, 0);
        ctx.restore();
    }

    // Center hub
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = '#060906';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 255, 65, 0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Center label
    ctx.fillStyle = '#00ff41';
    ctx.font = 'bold ' + (radius * 0.1) + 'px "VT323", "Share Tech Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CHADGPT', cx, cy - radius * 0.05);
    ctx.font = (radius * 0.07) + 'px "Share Tech Mono", monospace';
    ctx.fillStyle = 'rgba(0, 255, 65, 0.45)';
    ctx.fillText('TELECOM', cx, cy + radius * 0.09);
}

function initRotaryDial() {
    var canvas = document.getElementById('rotary-canvas');
    if (!canvas) return;

    drawRotaryDial(canvas);

    // Helper: shortest signed angular difference (handles ±π wrap)
    function angleDelta(from, to) {
        var d = to - from;
        while (d > Math.PI)  d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        return d;
    }

    canvas.addEventListener('mousemove', function(e) {
        if (_rotaryState.returning) return;
        if (_rotaryState.dragging) {
            var mouseAngle = getDialAngleFromMouse(canvas, e.clientX, e.clientY);
            // Accumulate delta (handles atan2 wrap at ±π)
            var delta = angleDelta(_rotaryState.prevMouseAngle, mouseAngle);
            _rotaryState.prevMouseAngle = mouseAngle;
            _rotaryState.cumRotation += delta;
            // On a real phone you drag CLOCKWISE (positive in screen coords)
            // Clamp: no counter-clockwise past start, no past finger stop
            if (_rotaryState.cumRotation < 0) _rotaryState.cumRotation = 0;
            if (_rotaryState.cumRotation > _rotaryState.maxRotation) _rotaryState.cumRotation = _rotaryState.maxRotation;
            _rotaryState.currentAngle = _rotaryState.cumRotation;
            drawRotaryDial(canvas);
        } else {
            var prev = _rotaryState.hoverDigit;
            _rotaryState.hoverDigit = getDigitFromPosition(canvas, e.clientX, e.clientY);
            if (_rotaryState.hoverDigit !== prev) drawRotaryDial(canvas);
            canvas.style.cursor = _rotaryState.hoverDigit >= 0 ? 'pointer' : 'default';
        }
    });

    canvas.addEventListener('mousedown', function(e) {
        if (_rotaryState.returning) return;
        var digit = getDigitFromPosition(canvas, e.clientX, e.clientY);
        if (digit < 0) return;
        _rotaryState.dragging = true;
        _rotaryState.selectedDigit = digit;
        _rotaryState.prevMouseAngle = getDialAngleFromMouse(canvas, e.clientX, e.clientY);
        _rotaryState.cumRotation = 0;
        // Max rotation = angular distance from this digit to the finger stop (clockwise)
        var digitA = getDigitAngle(digit);
        var dist = FINGER_STOP_ANGLE - digitA;
        while (dist < 0) dist += Math.PI * 2;
        _rotaryState.maxRotation = dist + 0.1; // small overshoot allowance
        _rotaryState.currentAngle = 0;
        playSound('dial_stop', 0.4);
        drawRotaryDial(canvas);
    });

    function handleRelease() {
        if (!_rotaryState.dragging) return;
        _rotaryState.dragging = false;
        var digit = _rotaryState.selectedDigit;
        _rotaryState.selectedDigit = -1;

        var dragAngle = _rotaryState.cumRotation;

        // Must drag at least 30% of the way to the stop to count
        var digitA = getDigitAngle(digit);
        var requiredDist = FINGER_STOP_ANGLE - digitA;
        while (requiredDist < 0) requiredDist += Math.PI * 2;

        if (dragAngle > requiredDist * 0.3) {
            // Valid dial — animate spring-back return with clicks
            _rotaryState.returning = true;
            _rotaryState.returnAngle = dragAngle;
            playDialClicks(digit);

            var returnDuration = (digit === 0 ? 10 : digit) * 65 + 100;
            var startReturn = dragAngle;
            var startTime = Date.now();

            function animateReturn() {
                var elapsed = Date.now() - startTime;
                var progress = Math.min(1, elapsed / returnDuration);
                var eased = 1 - Math.pow(1 - progress, 2);
                _rotaryState.returnAngle = startReturn * (1 - eased);
                drawRotaryDial(canvas);

                if (progress < 1) {
                    requestAnimationFrame(animateReturn);
                } else {
                    _rotaryState.returning = false;
                    _rotaryState.returnAngle = 0;
                    drawRotaryDial(canvas);
                    onDigitDialed(digit);
                }
            }
            animateReturn();
        } else {
            _rotaryState.currentAngle = 0;
            drawRotaryDial(canvas);
        }
    }

    canvas.addEventListener('mouseup', handleRelease);

    canvas.addEventListener('mouseleave', function() {
        if (_rotaryState.dragging) {
            handleRelease();
        }
        _rotaryState.hoverDigit = -1;
        drawRotaryDial(canvas);
    });
}

function onDigitDialed(digit) {
    _dialedDigits += String(digit);
    updateDialDisplay();

    // Check if number matches — show CALL button instead of auto-calling
    if (_dialedDigits === CHAD_NUMBER) {
        var callBtn = document.getElementById('dial-call');
        if (callBtn) callBtn.style.display = '';
    } else if (_dialedDigits.length >= CHAD_NUMBER.length) {
        // Wrong number
        var display = document.getElementById('dial-number-display');
        if (display) {
            display.textContent = 'WRONG NUMBER';
            display.style.color = '#ff3333';
        }
        setTimeout(function() {
            _dialedDigits = '';
            updateDialDisplay();
            var d = document.getElementById('dial-number-display');
            if (d) d.style.color = '';
        }, 1500);
    }
}

function updateDialDisplay() {
    var display = document.getElementById('dial-number-display');
    if (!display) return;
    var formatted = '';
    for (var i = 0; i < _dialedDigits.length; i++) {
        if (i === 3) formatted += '-';
        formatted += _dialedDigits[i];
    }
    // Pad with underscores
    var remaining = CHAD_NUMBER.length - _dialedDigits.length;
    if (remaining > 0) {
        if (_dialedDigits.length <= 3) {
            for (var j = _dialedDigits.length; j < 3; j++) formatted += '_';
            formatted += '-';
            for (var k = 0; k < 4; k++) formatted += '_';
        } else {
            for (var l = 0; l < remaining; l++) formatted += '_';
        }
    }
    display.textContent = formatted;
}

// ---- Call Screen (after dialing) ----

function setupCallAnalysers() {
    var ctx = _callCtx();

    if (!_callAnalyserChad) {
        // Ensure shared audio context + source are set up (from app.js)
        if (typeof _ensureSharedAudio === 'function') _ensureSharedAudio();
        if (typeof sharedChadSource !== 'undefined' && sharedChadSource) {
            try {
                _callChadSource = sharedChadSource;
                _callAnalyserChad = ctx.createAnalyser();
                _callAnalyserChad.fftSize = 256;
                _callChadSource.connect(_callAnalyserChad);
            } catch(e) {
                console.warn('[CALL] Chad analyser connect failed:', e.message);
            }
        }
        // If shared source isn't available yet, retry next frame — don't try
        // to create a second MediaElementSource (causes InvalidStateError)
    }

    if (!_callMicStream) {
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
            _callMicStream = stream;
            var source = ctx.createMediaStreamSource(stream);
            _callAnalyserMic = ctx.createAnalyser();
            _callAnalyserMic.fftSize = 256;
            source.connect(_callAnalyserMic);
        }).catch(function(e) {
            console.warn('[CALL] Mic access denied:', e);
        });
    }
}

function getAudioLevel(analyser) {
    if (!analyser) return 0;
    var data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    var sum = 0;
    for (var i = 0; i < data.length; i++) sum += data[i];
    return sum / data.length / 255;
}

function drawCallScreen() {
    var canvas = document.getElementById('call-canvas');
    if (!canvas || callState === 'dialing_screen') return;
    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 2;
    var w = canvas.width = canvas.offsetWidth * dpr;
    var h = canvas.height = canvas.offsetHeight * dpr;
    var cx = w / 2, cy = h / 2;
    var baseRadius = Math.min(w, h) * 0.2;

    var chadLevel = getAudioLevel(_callAnalyserChad);
    var micLevel = getAudioLevel(_callAnalyserMic);
    // Chad is "speaking" if audio is audible OR if the audio queue is still playing
    var chadQueueActive = (typeof _audioPlaying_queue !== 'undefined') && _audioPlaying_queue;
    var isChadSpeaking = chadLevel > 0.05 || chadQueueActive;
    var activeLevel = isChadSpeaking ? Math.max(chadLevel, 0.08) : micLevel;

    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(0, 20, 0, 0.15)';
    for (var sl = 0; sl < h; sl += 4) ctx.fillRect(0, sl, w, 1);

    var time = Date.now() / 1000;

    // Pulsing rings
    for (var ring = 7; ring >= 0; ring--) {
        var ringOffset = ring * 15;
        var pulse = activeLevel * 40 + Math.sin(time * 3 + ring * 0.7) * 4;
        var r = baseRadius + 10 + ringOffset + pulse;
        var alpha = (0.45 - ring * 0.05) * (0.3 + activeLevel * 0.7);
        if (alpha < 0.01) continue;

        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = isChadSpeaking
            ? 'rgba(0, 255, 65, ' + alpha + ')'
            : 'rgba(0, 180, 255, ' + alpha + ')';
        ctx.lineWidth = 2.5 - ring * 0.25;
        if (ring > 5 && Math.random() > 0.92) {
            ctx.setLineDash([4, 8 + Math.random() * 12]);
        } else {
            ctx.setLineDash([]);
        }
        ctx.stroke();
    }

    // Waveform ring
    if (activeLevel > 0.02) {
        var analyser = isChadSpeaking ? _callAnalyserChad : _callAnalyserMic;
        if (analyser) {
            var waveData = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteTimeDomainData(waveData);
            ctx.beginPath();
            var waveRadius = baseRadius + 6;
            for (var i = 0; i < waveData.length; i++) {
                var angle = (i / waveData.length) * Math.PI * 2;
                var amp = (waveData[i] - 128) / 128;
                var wr = waveRadius + amp * 25;
                var wx = cx + Math.cos(angle) * wr;
                var wy = cy + Math.sin(angle) * wr;
                if (i === 0) ctx.moveTo(wx, wy); else ctx.lineTo(wx, wy);
            }
            ctx.closePath();
            ctx.strokeStyle = isChadSpeaking ? 'rgba(0, 255, 65, 0.6)' : 'rgba(0, 180, 255, 0.5)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([]);
            ctx.stroke();
        }
    }

    // Avatar — green CRT glitch style (same as main page), clipped to circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, baseRadius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (_chadGreenCanvas && _chadEdgeCanvas) {
        var imgSize = baseRadius * 2;
        var dx = cx - baseRadius, dy = cy - baseRadius;
        // Dark base
        ctx.fillStyle = '#050505';
        ctx.fillRect(dx, dy, imgSize, imgSize);
        // Green monochrome layer (dim)
        ctx.globalAlpha = 0.45;
        ctx.drawImage(_chadGreenCanvas, dx, dy, imgSize, imgSize);
        // Edge contour layer (bright wireframe)
        ctx.globalAlpha = 0.9;
        ctx.drawImage(_chadEdgeCanvas, dx, dy, imgSize, imgSize);
        ctx.globalAlpha = 1.0;
        // Scanlines
        ctx.fillStyle = 'rgba(0,0,0,0.08)';
        for (var scY = dy; scY < dy + imgSize; scY += 3) ctx.fillRect(dx, scY, imgSize, 1);
    } else {
        ctx.fillStyle = '#0a0f0a';
        ctx.fillRect(cx - baseRadius, cy - baseRadius, baseRadius * 2, baseRadius * 2);
    }
    ctx.restore();

    // Border glow
    ctx.beginPath();
    ctx.arc(cx, cy, baseRadius, 0, Math.PI * 2);
    ctx.strokeStyle = isChadSpeaking ? 'rgba(0, 255, 65, 0.9)' : 'rgba(0, 255, 65, 0.5)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([]);
    ctx.stroke();

    if (activeLevel > 0.05) {
        ctx.beginPath();
        ctx.arc(cx, cy, baseRadius + 1, 0, Math.PI * 2);
        ctx.strokeStyle = isChadSpeaking
            ? 'rgba(0, 255, 65, ' + (activeLevel * 0.5) + ')'
            : 'rgba(0, 180, 255, ' + (activeLevel * 0.4) + ')';
        ctx.lineWidth = 4;
        ctx.stroke();
    }

    ctx.font = 'bold ' + (baseRadius * 0.25) + 'px "VT323", "Share Tech Mono", monospace';
    ctx.fillStyle = '#00ff41';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('C H A D G P T', cx, cy + baseRadius + 35);

    if (callState === 'connected') {
        var chadThinking = (typeof isStreaming !== 'undefined') && isStreaming && !isChadSpeaking;
        var who, statusColor;
        if (isChadSpeaking) {
            who = 'CHAD IS SPEAKING';
            statusColor = '#00ff41';
        } else if (chadThinking) {
            who = 'CHAD IS THINKING...';
            statusColor = '#ffaa00';
        } else if (_callRecognizing) {
            who = 'LISTENING...';
            statusColor = '#00b4ff';
        } else {
            who = 'YOUR TURN';
            statusColor = '#00b4ff';
        }
        ctx.font = (baseRadius * 0.14) + 'px "Share Tech Mono", monospace';
        ctx.fillStyle = statusColor;
        ctx.fillText(who, cx, cy + baseRadius + 60);

        // Progress bar while Chad is thinking
        if (chadThinking) {
            var barW = baseRadius * 1.4;
            var barH = 6;
            var barX = cx - barW / 2;
            var barY = cy + baseRadius + 72;
            // Track border
            ctx.strokeStyle = 'rgba(255, 170, 0, 0.4)';
            ctx.lineWidth = 1;
            ctx.strokeRect(barX, barY, barW, barH);
            // Animated fill — indeterminate bounce
            var progress = (Math.sin(time * 2.5) * 0.5 + 0.5);
            var fillW = barW * 0.35;
            var fillX = barX + progress * (barW - fillW);
            ctx.fillStyle = 'rgba(255, 170, 0, 0.7)';
            ctx.fillRect(fillX, barY + 1, fillW, barH - 2);
            // Glow
            ctx.shadowColor = '#ffaa00';
            ctx.shadowBlur = 6;
            ctx.fillRect(fillX, barY + 1, fillW, barH - 2);
            ctx.shadowBlur = 0;
        }
    }

    if (callState === 'connected' && Math.random() > 0.985) phoneLineCrackle();

    _callAnimFrame = requestAnimationFrame(drawCallScreen);
}

// ---- Timer ----

function startCallTimer() {
    _callStartTime = Date.now();
    updateCallTimer();
}

function updateCallTimer() {
    if (callState !== 'connected') return;
    var elapsed = Math.floor((Date.now() - _callStartTime) / 1000);
    var min = String(Math.floor(elapsed / 60)).padStart(2, '0');
    var sec = String(elapsed % 60).padStart(2, '0');
    var el = document.getElementById('call-timer');
    if (el) el.textContent = min + ':' + sec;
    _callTimer = setTimeout(updateCallTimer, 1000);
}

// ---- Speech Recognition ----

function callStartListening() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) return;
    if (_callRecognizing || callState !== 'connected') return;

    // Set recognizing immediately so the canvas shows "LISTENING..." without
    // waiting for the async onstart callback (eliminates "YOUR TURN" flicker)
    _callRecognizing = true;

    if (!_callRecognition) {
        var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        _callRecognition = new SR();
        _callRecognition.continuous = false;
        _callRecognition.interimResults = true;
        _callRecognition.lang = 'en-US';

        _callRecognition.onstart = function() { _callRecognizing = true; };
        _callRecognition.onresult = function(event) {
            var transcript = '';
            for (var i = event.resultIndex; i < event.results.length; i++) {
                transcript += event.results[i][0].transcript;
            }
            _callTranscript = transcript;
            var el = document.getElementById('call-transcript');
            if (el) el.textContent = transcript;

            if (event.results[event.results.length - 1].isFinal) {
                _callRecognition.stop();
                if (transcript.trim() && callState === 'connected') {
                    // If Chad is mid-response, wait for streaming to finish before sending
                    function _trySendCallMessage() {
                        if (typeof isStreaming !== 'undefined' && isStreaming) {
                            setTimeout(_trySendCallMessage, 500);
                            return;
                        }
                        var input = document.getElementById('chat-input');
                        if (input) { input.value = transcript; sendMessage(); }
                    }
                    _trySendCallMessage();
                    var tel = document.getElementById('call-transcript');
                    if (tel) tel.textContent = '';
                }
            }
        };
        _callRecognition.onend = function() { _callRecognizing = false; };
        _callRecognition.onerror = function(event) {
            _callRecognizing = false;
            // Retry on any recoverable error during a call, not just no-speech
            if (callState === 'connected') {
                var retryDelay = event.error === 'no-speech' ? 500 : 1500;
                setTimeout(function() { callStartListening(); }, retryDelay);
            }
        };
    }
    try { _callRecognition.start(); } catch(e) { _callRecognizing = false; }
}

function callStopListening() {
    _callRecognizing = false;
    if (_callRecognition) { try { _callRecognition.stop(); } catch(e) {} }
}

function callCheckAutoMic() {
    if (callState !== 'connected') return;
    if (!_isChadBusy() && !_callRecognizing) callStartListening();
    _callAutoMicTimer = setTimeout(callCheckAutoMic, 500);
}

// ---- State Machine ----

function toggleCall() {
    if (callState === 'idle') {
        showDialScreen();
    } else {
        endCall();
    }
}

function showDialScreen() {
    callState = 'dialing_screen';
    _dialedDigits = '';

    var overlay = document.getElementById('call-overlay');
    if (overlay) overlay.style.display = 'flex';

    // Show dial screen, hide call screen
    var dialScreen = document.getElementById('dial-screen');
    var callScreen = document.getElementById('call-screen');
    if (dialScreen) dialScreen.style.display = 'flex';
    if (callScreen) callScreen.style.display = 'none';

    // Hide CALL button until number is dialed
    var callBtn = document.getElementById('dial-call');
    if (callBtn) callBtn.style.display = 'none';

    updateDialDisplay();
    initRotaryDial();
}

function transitionToRinging() {
    callState = 'ringing';

    // Switch screens
    var dialScreen = document.getElementById('dial-screen');
    var callScreen = document.getElementById('call-screen');
    if (dialScreen) dialScreen.style.display = 'none';
    if (callScreen) callScreen.style.display = 'flex';

    var status = document.getElementById('call-status');
    if (status) status.textContent = 'R I N G I N G . . .';
    document.getElementById('call-timer').textContent = '--:--';
    document.getElementById('call-transcript').textContent = '';

    setupCallAnalysers();
    phoneRingStart();
    drawCallScreen();

    // Pick up after ring
    _callRingTimer = setTimeout(function() {
        if (callState !== 'ringing') return;
        phoneRingStop();
        playSound('phone_pickup', 0.8);

        callState = 'connected';
        if (status) {
            status.textContent = 'C O N N E C T E D';
            status.classList.add('connected');
        }

        startCallTimer();

        var input = document.getElementById('chat-input');
        if (input) { input.value = '*phone rings* Hello?'; sendMessage(); }

        callCheckAutoMic();
    }, 5500);
}

function endCall() {
    if (callState === 'idle') return;

    var prevState = callState;
    callState = 'ending';

    phoneRingStop();
    callStopListening();
    if (_callAutoMicTimer) { clearTimeout(_callAutoMicTimer); _callAutoMicTimer = null; }
    if (_callTimer) { clearTimeout(_callTimer); _callTimer = null; }
    if (_callRingTimer) { clearTimeout(_callRingTimer); _callRingTimer = null; }

    stopAudio();

    if (_callMicStream) {
        _callMicStream.getTracks().forEach(function(t) { t.stop(); });
        _callMicStream = null;
        _callAnalyserMic = null;
    }

    if (_callAnimFrame) { cancelAnimationFrame(_callAnimFrame); _callAnimFrame = null; }

    if (prevState === 'connected' || prevState === 'ringing') {
        playSound('phone_hangup', 0.9);
    }

    // Close overlay immediately
    var overlay = document.getElementById('call-overlay');
    if (overlay) overlay.style.display = 'none';
    callState = 'idle';
}
