// chad3d.js — GigaChad green CRT display with edge-detected contour lines
// Renders the actual GigaChad image as a green phosphor CRT with
// Sobel edge contours for a "wireframe scan" aesthetic.
// Mouth animation during TTS, mouse parallax, irritation color shift.

var chadAvatar = null;

(function() {
    'use strict';

    var container = document.getElementById('three-container');
    var statusEl  = document.getElementById('avatar-status');
    if (!container) return;

    // ================================================================
    //  CANVAS SETUP
    // ================================================================

    var canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width  = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);
    var ctx = canvas.getContext('2d');

    // ================================================================
    //  STATE
    // ================================================================

    var greenImg   = null;   // offscreen: green monochrome image
    var edgeImg    = null;   // offscreen: Sobel edge contours
    var modelLoaded = false;

    var mood          = 'dormant';
    var wakeRequested = false;
    var _smoothAmp    = 0;
    var irritationLevel = 0;
    var _brightness   = 0.15;
    var _targetBright = 0.15;
    var _colorR = 0, _colorG = 1, _colorB = 0.25;

    // Crop coordinates (set after image loads)
    var cropX = 0, cropY = 0, cropW = 0, cropH = 0;

    // Mouth geometry measured on chad.jpg itself (fractions of the source
    // image), mapped through the live crop each frame so it stays glued to
    // his actual lips at any canvas size.
    var MOUTH_IMG = {
        cx:       0.582,   // mouth center x
        lipY:     0.550,   // lip separation line y
        halfW:    0.032,   // half-width of the lips
        lowerLipY: 0.577,  // bottom of lower lip
        chinY:    0.670,   // bottom of chin
        jawHalfW: 0.060    // half-width of jaw at lip level
    };

    // Viseme targets driven by wawa-lipsync: open (jaw), width (spread), round (pursing)
    var VISEME_SHAPES = {
        viseme_sil: { open: 0.00, width: 0.30, round: 0.20 },
        viseme_PP:  { open: 0.03, width: 0.30, round: 0.15 },
        viseme_FF:  { open: 0.15, width: 0.50, round: 0.15 },
        viseme_TH:  { open: 0.20, width: 0.45, round: 0.20 },
        viseme_DD:  { open: 0.28, width: 0.50, round: 0.20 },
        viseme_kk:  { open: 0.30, width: 0.45, round: 0.25 },
        viseme_CH:  { open: 0.25, width: 0.55, round: 0.35 },
        viseme_SS:  { open: 0.18, width: 0.60, round: 0.10 },
        viseme_nn:  { open: 0.15, width: 0.45, round: 0.15 },
        viseme_RR:  { open: 0.22, width: 0.50, round: 0.40 },
        viseme_aa:  { open: 0.90, width: 0.60, round: 0.40 },
        viseme_E:   { open: 0.55, width: 0.80, round: 0.15 },
        viseme_I:   { open: 0.40, width: 0.75, round: 0.10 },
        viseme_O:   { open: 0.65, width: 0.45, round: 0.85 },
        viseme_U:   { open: 0.45, width: 0.30, round: 0.95 }
    };
    var _mouth = { open: 0, width: 0.3, round: 0.2 };
    var MOUTH_DEBUG = /[?&]mouthdebug/.test(location.search);

    // Mouse
    var mouseX = 0, mouseY = 0, smoothX = 0, smoothY = 0;
    document.addEventListener('mousemove', function(e) {
        mouseX = (e.clientX / window.innerWidth)  * 2 - 1;
        mouseY = (e.clientY / window.innerHeight) * 2 - 1;
    });

    // ================================================================
    //  SIZING
    // ================================================================

    function sizeCanvas() {
        var r = container.getBoundingClientRect();
        var w = Math.floor(Math.max(r.width, 100));
        var h = Math.floor(Math.max(r.height, 100));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width  = w;
            canvas.height = h;
        }
    }
    sizeCanvas();
    window.addEventListener('resize', function() {
        sizeCanvas();
        if (modelLoaded) rebuildOffscreen();
    });
    setTimeout(sizeCanvas, 300);
    setTimeout(function() { sizeCanvas(); if (modelLoaded) rebuildOffscreen(); }, 1000);

    // ================================================================
    //  IMAGE LOADING & PROCESSING
    // ================================================================

    if (statusEl) statusEl.textContent = '[ LOADING... ]';

    var srcImg = new Image();
    srcImg.onload = function() {
        computeCrop(srcImg);
        rebuildOffscreen();
        modelLoaded = true;

        if (wakeRequested) {
            _targetBright = 1.0;
            if (statusEl) { statusEl.textContent = '[ ONLINE ]'; statusEl.style.color = '#00ff41'; }
        } else {
            if (statusEl) statusEl.textContent = '[ READY ]';
        }
        console.log('[CHAD3D] GigaChad CRT display ready');
    };
    srcImg.onerror = function() {
        console.error('[CHAD3D] chad.jpg failed');
        if (statusEl) statusEl.textContent = '[ IMG ERROR ]';
    };
    srcImg.src = '/static/chad.jpg?' + Date.now();

    // ----------------------------------------------------------------
    //  Compute crop: portrait region centered on face
    // ----------------------------------------------------------------
    function computeCrop(img) {
        var faceCX = img.width  * 0.60;   // face center X
        var faceCY = img.height * 0.40;   // face center Y

        var aspect = canvas.height / Math.max(canvas.width, 1);

        cropW = img.width * 0.48;
        cropH = cropW * aspect;

        if (cropH > img.height * 0.97) {
            cropH = img.height * 0.97;
            cropW = cropH / aspect;
        }

        cropX = faceCX - cropW * 0.48;
        cropY = faceCY - cropH * 0.33;

        cropX = Math.max(0, Math.min(img.width  - cropW, cropX));
        cropY = Math.max(0, Math.min(img.height - cropH, cropY));
    }

    // ----------------------------------------------------------------
    //  Build offscreen canvases (green image + edge map)
    // ----------------------------------------------------------------
    function rebuildOffscreen() {
        if (!srcImg.complete || !srcImg.width) return;
        var w = canvas.width, h = canvas.height;

        // --- Green monochrome ---
        greenImg = document.createElement('canvas');
        greenImg.width = w;  greenImg.height = h;
        var gCtx = greenImg.getContext('2d');
        gCtx.drawImage(srcImg, cropX, cropY, cropW, cropH, 0, 0, w, h);

        var gData = gCtx.getImageData(0, 0, w, h);
        var d = gData.data;
        for (var i = 0; i < d.length; i += 4) {
            var lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
            d[i]     = lum * 0.03;    // R
            d[i + 1] = lum * 0.90;    // G
            d[i + 2] = lum * 0.18;    // B
        }
        gCtx.putImageData(gData, 0, 0);

        // --- Sobel edge detection → contour lines ---
        edgeImg = document.createElement('canvas');
        edgeImg.width = w;  edgeImg.height = h;
        var eCtx = edgeImg.getContext('2d');

        // Use the green channel of the processed image for edges
        var src = gData.data;
        var dst = new Uint8ClampedArray(src.length);

        for (var y = 1; y < h - 1; y++) {
            for (var x = 1; x < w - 1; x++) {
                var c = 1;  // sample green channel
                var tl = src[((y-1)*w+(x-1))*4+c], tc = src[((y-1)*w+x)*4+c], tr = src[((y-1)*w+(x+1))*4+c];
                var ml = src[(y*w+(x-1))*4+c],                                  mr = src[(y*w+(x+1))*4+c];
                var bl = src[((y+1)*w+(x-1))*4+c], bc = src[((y+1)*w+x)*4+c], br = src[((y+1)*w+(x+1))*4+c];

                var gx = -tl + tr - 2*ml + 2*mr - bl + br;
                var gy = -tl - 2*tc - tr + bl + 2*bc + br;
                var mag = Math.sqrt(gx * gx + gy * gy);

                // Threshold + brighten edges
                mag = mag > 18 ? Math.min(255, mag * 1.8) : 0;

                var di = (y * w + x) * 4;
                dst[di]     = mag * 0.05;
                dst[di + 1] = mag;
                dst[di + 2] = mag * 0.25;
                dst[di + 3] = mag > 0 ? 255 : 0;
            }
        }

        eCtx.putImageData(new ImageData(dst, w, h), 0, 0);

        console.log('[CHAD3D] Offscreen rebuilt: ' + w + 'x' + h);
    }

    // ================================================================
    //  GRID OVERLAY (drawn each frame — very fast)
    // ================================================================

    var GRID_SPACE = 20;
    var GRID_ALPHA = 0.07;

    function drawGrid(w, h, alpha) {
        ctx.strokeStyle = 'rgba(0,255,65,' + (alpha * _brightness).toFixed(3) + ')';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        for (var gx = 0; gx < w; gx += GRID_SPACE) { ctx.moveTo(gx, 0); ctx.lineTo(gx, h); }
        for (var gy = 0; gy < h; gy += GRID_SPACE) { ctx.moveTo(0, gy); ctx.lineTo(w, gy); }
        ctx.stroke();
    }

    // ================================================================
    //  SCANLINES
    // ================================================================

    var scanCanvas = null;
    function ensureScanlines(w, h) {
        if (scanCanvas && scanCanvas.width === w && scanCanvas.height === h) return;
        scanCanvas = document.createElement('canvas');
        scanCanvas.width = w; scanCanvas.height = h;
        var sc = scanCanvas.getContext('2d');
        sc.fillStyle = 'rgba(0,0,0,0.1)';
        for (var sy = 0; sy < h; sy += 3) sc.fillRect(0, sy, w, 1);
    }

    // ================================================================
    //  RENDER LOOP
    // ================================================================

    (function animate() {
        requestAnimationFrame(animate);

        var t  = Date.now() * 0.001;
        var cw = canvas.width, ch = canvas.height;

        // Brightness easing
        _brightness += (_targetBright - _brightness) * 0.06;

        // Mouse smoothing
        smoothX += (mouseX - smoothX) * 0.04;
        smoothY += (mouseY - smoothY) * 0.04;

        // Voice amplitude, fast attack and slower release
        if (mood === 'talking') {
            var raw = (typeof getVoiceAmplitude === 'function') ? getVoiceAmplitude() : 0;
            _smoothAmp += (raw - _smoothAmp) * (raw > _smoothAmp ? 0.55 : 0.18);
        } else {
            _smoothAmp *= 0.8;
        }
        var amp = _smoothAmp;

        // Viseme-driven mouth state (wawa-lipsync via chadVoice)
        var vis = (mood === 'talking' && typeof chadVoice !== 'undefined' && chadVoice.getViseme)
            ? chadVoice.getViseme() : '';
        var vTarget = VISEME_SHAPES[vis];
        if (!vTarget) {
            vTarget = (mood === 'talking' && amp > 0.03)
                ? { open: Math.min(1, amp * 1.3), width: 0.5, round: 0.3 }
                : VISEME_SHAPES.viseme_sil;
        }
        var openTarget = vis ? vTarget.open * (0.35 + Math.min(1, amp * 1.6) * 0.65) : vTarget.open;
        _mouth.open  += (openTarget     - _mouth.open)  * 0.45;
        _mouth.width += (vTarget.width  - _mouth.width) * 0.30;
        _mouth.round += (vTarget.round  - _mouth.round) * 0.30;

        // --- Clear ---
        ctx.fillStyle = '#050505';
        ctx.fillRect(0, 0, cw, ch);

        if (!modelLoaded) return;

        // --- Compute offsets ---
        var parallaxX, parallaxY, swayX, swayY;

        if (mood === 'dormant') {
            parallaxX = smoothX * 3;
            parallaxY = smoothY * 2;
            swayX = Math.sin(t * 0.1) * 3;
            swayY = 0;
        } else {
            parallaxX = smoothX * 8;
            parallaxY = smoothY * 5;
            swayX = Math.sin(t * 0.3) * 1.5;
            swayY = Math.sin(t * 0.2) * 0.8;
        }

        var speechX = _mouth.open * Math.sin(t * 5) * 1.5;
        var speechY = _mouth.open * Math.sin(t * 7) * 1;
        var ox = parallaxX + swayX + speechX;
        var oy = parallaxY + swayY + speechY;

        var breathS = 1 + (mood !== 'dormant' ? Math.sin(t * 1.2) * 0.003 : 0);

        // --- Draw base green image (dim) ---
        ctx.save();
        ctx.globalAlpha = _brightness * 0.45;

        var cx = cw / 2, cy = ch / 2;
        ctx.translate(cx + ox, cy + oy);
        ctx.scale(breathS, breathS);
        ctx.translate(-cx, -cy);

        ctx.drawImage(greenImg, 0, 0, cw, ch);
        ctx.restore();

        // --- Draw edge contour lines (bright — this is the "wireframe") ---
        ctx.save();
        ctx.globalAlpha = _brightness * 0.9;

        ctx.translate(cx + ox, cy + oy);
        ctx.scale(breathS, breathS);
        ctx.translate(-cx, -cy);

        ctx.drawImage(edgeImg, 0, 0, cw, ch);
        ctx.restore();

        // --- Mouth animation: viseme-shaped opening + jaw drop, mapped from image space ---
        if ((_mouth.open > 0.015 || MOUTH_DEBUG) && greenImg && cropW > 0) {
            var iw  = srcImg.width, ih = srcImg.height;
            var sxf = cw / cropW, syf = ch / cropH;
            var mcx     = (MOUTH_IMG.cx * iw - cropX) * sxf;
            var lipPx   = (MOUTH_IMG.lipY * ih - cropY) * syf;
            var lowLipPx = (MOUTH_IMG.lowerLipY * ih - cropY) * syf;
            var chinPx  = (MOUTH_IMG.chinY * ih - cropY) * syf;
            var lipHW   = MOUTH_IMG.halfW * iw * sxf;
            var jawHW   = MOUTH_IMG.jawHalfW * iw * sxf;
            var narrowHW = jawHW * 0.6;
            var jawH    = chinPx - lipPx;
            var openAmt = _mouth.open * jawH * 0.22;  // px of jaw drop

            ctx.save();
            ctx.translate(cx + ox, cy + oy);
            ctx.scale(breathS, breathS);
            ctx.translate(-cx, -cy);

            // Organic jaw/chin clip path (rounded trapezoid), bottom extendable
            function jawPath(extend) {
                ctx.beginPath();
                var top  = lipPx;
                var bot  = chinPx + extend;
                var mid  = top + (bot - top) * 0.55;
                ctx.moveTo(mcx - jawHW, top);
                ctx.lineTo(mcx + jawHW, top);
                ctx.bezierCurveTo(
                    mcx + jawHW,       mid,
                    mcx + narrowHW * 1.3, bot - jawH * 0.15,
                    mcx + narrowHW,    bot
                );
                ctx.quadraticCurveTo(mcx, bot + jawH * 0.06, mcx - narrowHW, bot);
                ctx.bezierCurveTo(
                    mcx - narrowHW * 1.3, bot - jawH * 0.15,
                    mcx - jawHW,       mid,
                    mcx - jawHW,       top
                );
                ctx.closePath();
            }

            // 1. Erase the jaw region plus the drop allowance
            ctx.save();
            jawPath(openAmt);
            ctx.clip();
            ctx.fillStyle = '#050505';
            ctx.fillRect(0, 0, cw, ch);

            // 2. Redraw the jaw stretched downward, anchored at the lip line,
            //    so the chin drops without exposing a gap band
            ctx.globalAlpha = _brightness * 0.45;
            ctx.drawImage(greenImg,
                mcx - jawHW - 2, lipPx, jawHW * 2 + 4, jawH + 4,
                mcx - jawHW - 2, lipPx, jawHW * 2 + 4, jawH + 4 + openAmt);
            ctx.globalAlpha = _brightness * 0.9;
            ctx.drawImage(edgeImg,
                mcx - jawHW - 2, lipPx, jawHW * 2 + 4, jawH + 4,
                mcx - jawHW - 2, lipPx, jawHW * 2 + 4, jawH + 4 + openAmt);
            ctx.restore();

            // 3. Viseme-shaped mouth opening: width from lip spread, height
            //    from openness, roundness pulls it circular
            var mw = lipHW * 2 * (0.68 + _mouth.width * 0.5) * (1 - _mouth.round * 0.35);
            var mh = Math.max(1.5, _mouth.open * (lowLipPx - lipPx) * 2.2 + openAmt * 0.7);
            if (_mouth.open > 0.02) {
                ctx.beginPath();
                ctx.ellipse(mcx, lipPx + mh * 0.42, mw / 2, mh / 2, 0, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(3,4,3,' + Math.min(0.95, 0.5 + _mouth.open).toFixed(2) + ')';
                ctx.fill();
                ctx.strokeStyle = 'rgba(0,255,65,' + (0.35 * _brightness).toFixed(2) + ')';
                ctx.lineWidth = 1;
                ctx.stroke();
            }

            // Debug overlay: mouth box, jaw path, current viseme
            if (MOUTH_DEBUG) {
                ctx.strokeStyle = '#ff00ff';
                ctx.lineWidth = 1;
                ctx.strokeRect(mcx - lipHW, lipPx - 4, lipHW * 2, (lowLipPx - lipPx) + 8);
                jawPath(0);
                ctx.stroke();
                ctx.fillStyle = '#ff00ff';
                ctx.font = '12px monospace';
                ctx.fillText((vis || 'no-viseme') + ' open=' + _mouth.open.toFixed(2), mcx - 60, lipPx - 12);
            }

            ctx.restore();
        }

        // --- Irritation color overlay ---
        if (irritationLevel > 35 && _brightness > 0.1) {
            var iFrac = (irritationLevel - 35) / 65;
            ctx.save();
            ctx.globalAlpha = iFrac * 0.25 * _brightness;
            ctx.globalCompositeOperation = 'screen';
            ctx.fillStyle = 'rgb(' +
                Math.round(_colorR * 180) + ',' +
                Math.round(_colorG * 60)  + ',' +
                Math.round(_colorB * 30)  + ')';
            ctx.fillRect(0, 0, cw, ch);
            ctx.restore();
        }

        // --- Grid overlay ---
        drawGrid(cw, ch, GRID_ALPHA);

        // --- Scanlines ---
        ensureScanlines(cw, ch);
        ctx.drawImage(scanCanvas, 0, 0);

        // --- Vignette ---
        var vg = ctx.createRadialGradient(cx, cy, Math.min(cw, ch) * 0.25, cx, cy, Math.max(cw, ch) * 0.72);
        vg.addColorStop(0, 'rgba(0,0,0,0)');
        vg.addColorStop(1, 'rgba(0,0,0,0.55)');
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, cw, ch);

    })();

    // ================================================================
    //  COLOR HELPERS
    // ================================================================

    function getIrritationColor(level) {
        if (level < 40) return { r: 0, g: 1.0, b: 0.25 };
        if (level < 70) {
            var t = (level - 40) / 30;
            return { r: t, g: 1.0 - t * 0.4, b: 0.25 * (1 - t) };
        }
        var t2 = (level - 70) / 30;
        return { r: 1.0, g: 0.6 - t2 * 0.5, b: 0 };
    }

    function setIrritationColors(level) {
        var c = getIrritationColor(level);
        _colorR = c.r; _colorG = c.g; _colorB = c.b;
    }

    // ================================================================
    //  PUBLIC API
    // ================================================================

    chadAvatar = {
        wake: function() {
            wakeRequested = true;
            mood = 'annoyed';
            _targetBright = 1.0;
            if (modelLoaded && statusEl) {
                statusEl.textContent = '[ ONLINE ]';
                statusEl.style.color = '#00ff41';
            }
        },

        sleep: function() {
            mood = 'dormant';
            wakeRequested = false;
            irritationLevel = 0;
            setIrritationColors(0);
            _targetBright = 0.15;
            if (statusEl) { statusEl.textContent = '[ DORMANT ]'; statusEl.style.color = '#004d00'; }
        },

        startTalking: function() { mood = 'talking'; },
        stopTalking:  function() { mood = 'annoyed'; },

        setIrritation: function(level) {
            irritationLevel = Math.max(0, Math.min(100, level));
            setIrritationColors(irritationLevel);

            if (statusEl && mood !== 'dormant') {
                var lbl;
                if (irritationLevel < 40)       lbl = '[ ONLINE ]';
                else if (irritationLevel < 55)  lbl = '[ ANNOYED ]';
                else if (irritationLevel < 70)  lbl = '[ IRRITATED ]';
                else if (irritationLevel < 85)  lbl = '[ PISSED ]';
                else                             lbl = '[ FURIOUS ]';
                statusEl.textContent = lbl;

                var c = getIrritationColor(irritationLevel);
                statusEl.style.color = 'rgb(' +
                    Math.round(c.r * 255) + ',' +
                    Math.round(c.g * 255) + ',' +
                    Math.round(c.b * 255) + ')';
            }
        }
    };

    console.log('[CHAD3D] CRT display initialized, loading image...');
})();
