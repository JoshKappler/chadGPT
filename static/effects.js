// TV Static Effect
class StaticEffect {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.running = false;
        this.intensity = 0.06;
        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    resize() {
        this.canvas.width = Math.floor(window.innerWidth / 3);
        this.canvas.height = Math.floor(window.innerHeight / 3);
    }

    start() { this.running = true; this.draw(); }
    stop() { this.running = false; }

    setIntensity(val) {
        this.intensity = val;
        this.canvas.style.opacity = val;
    }

    spike(amount = 0.15, duration = 120) {
        const orig = this.intensity;
        this.setIntensity(orig + amount);
        setTimeout(() => this.setIntensity(orig), duration);
    }

    draw() {
        if (!this.running) return;
        requestAnimationFrame(() => this.draw());

        const w = this.canvas.width;
        const h = this.canvas.height;
        const imageData = this.ctx.createImageData(w, h);
        const data = imageData.data;

        // VHS corruption bands (horizontal noise streaks)
        const numBands = Math.random() > 0.3 ? Math.floor(1 + Math.random() * 4) : 0;
        const bands = [];
        for (let b = 0; b < numBands; b++) {
            bands.push({
                y: Math.floor(Math.random() * h),
                h: Math.floor(1 + Math.random() * 4),
                bright: Math.random() > 0.5,
            });
        }

        // Tape dropout band (random horizontal blackout)
        const hasDropout = Math.random() > 0.92;
        const dropoutY = hasDropout ? Math.floor(Math.random() * h) : -1;
        const dropoutH = hasDropout ? Math.floor(2 + Math.random() * 6) : 0;

        // Head switch bar at bottom
        const headSwitchH = Math.random() > 0.85 ? Math.floor(1 + Math.random() * 3) : 0;

        for (let y = 0; y < h; y++) {
            let inBand = false;
            let bandBright = false;
            for (const band of bands) {
                if (y >= band.y && y < band.y + band.h) { inBand = true; bandBright = band.bright; break; }
            }
            const inDropout = hasDropout && y >= dropoutY && y < dropoutY + dropoutH;
            const inHeadSwitch = headSwitchH > 0 && y >= h - headSwitchH;

            // Per-line horizontal jitter (tape wobble)
            const lineJitter = Math.random() > 0.95 ? Math.floor((Math.random() - 0.5) * 4) : 0;

            for (let x = 0; x < w; x++) {
                const sx = Math.max(0, Math.min(w - 1, x + lineJitter));
                const i = (y * w + sx) * 4;
                if (inDropout) {
                    // Black with faint noise
                    const v = Math.random() * 20;
                    data[i] = v; data[i+1] = v; data[i+2] = v;
                    data[i+3] = 220;
                } else if (inHeadSwitch) {
                    // Bright noisy bar
                    const val = 150 + Math.random() * 105;
                    data[i] = val * 0.3; data[i+1] = val; data[i+2] = val * 0.3;
                    data[i+3] = 200;
                } else if (inBand) {
                    if (bandBright) {
                        const val = 120 + Math.random() * 135;
                        data[i] = val; data[i+1] = val * 0.85; data[i+2] = val * 0.7;
                        data[i+3] = 180;
                    } else {
                        // Dark corruption band
                        const val = Math.random() * 40;
                        data[i] = val; data[i+1] = val; data[i+2] = val;
                        data[i+3] = 200;
                    }
                } else {
                    const val = Math.random() * 255;
                    data[i] = val; data[i+1] = val; data[i+2] = val;
                    data[i+3] = 255;
                }
            }
        }
        this.ctx.putImageData(imageData, 0, 0);
    }
}

// Flicker & Glitch Effects
//
// IMPORTANT: CSS `filter` on an ancestor of a WebGL canvas causes the browser
// to rasterize the canvas into a bitmap before applying the filter. On many
// browser/GPU combos this blanks the canvas permanently. All brightness/invert
// effects now use overlay divs instead of `app.style.filter`.
class FlickerEffect {
    constructor(overlayId) {
        this.overlay = document.getElementById(overlayId);
        // Create a persistent brightness overlay for simulating filter effects
        // without actually using CSS filter (which kills WebGL canvases)
        this.brightnessOverlay = document.createElement('div');
        this.brightnessOverlay.id = 'brightness-overlay';
        this.brightnessOverlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:997;pointer-events:none;background:#000;opacity:0;transition:none;';
        (document.getElementById('crt-screen') || document.body).appendChild(this.brightnessOverlay);
    }

    // Simulate brightness(X) by overlaying black at opacity (1 - X)
    // e.g. brightness(0.3) → 70% black overlay
    _setBrightness(val) {
        const darkness = Math.max(0, Math.min(1, 1 - val));
        this.brightnessOverlay.style.opacity = darkness;
    }

    _clearBrightness() {
        this.brightnessOverlay.style.opacity = '0';
    }

    flicker(count = 1, interval = 150) {
        let i = 0;
        const doFlicker = () => {
            if (i >= count) return;
            this.overlay.classList.add('flicker');
            setTimeout(() => {
                this.overlay.classList.remove('flicker');
                i++;
                if (i < count) setTimeout(doFlicker, interval + Math.random() * 100);
            }, 100 + Math.random() * 100);
        };
        doFlicker();
    }

    // Lights flickering before turning on fully
    // Uses overlay instead of CSS filter to avoid blanking WebGL canvas
    async lightsFlicker() {
        for (let i = 0; i < 12; i++) {
            const brightness = Math.random() * 0.7;
            this._setBrightness(brightness);
            await new Promise(r => setTimeout(r, 40 + Math.random() * 80));
            this._clearBrightness();
            await new Promise(r => setTimeout(r, 20 + Math.random() * 60));
        }
        // Final flickers settling to full
        for (let i = 0; i < 4; i++) {
            this._setBrightness(0.6 + Math.random() * 0.4);
            await new Promise(r => setTimeout(r, 30 + Math.random() * 40));
        }
        this._clearBrightness();
    }

    bootFlicker() {
        return new Promise(resolve => {
            let count = 0;
            const doFlicker = () => {
                if (count >= 8) { resolve(); return; }
                this.overlay.style.opacity = (Math.random() * 0.15).toString();
                this.overlay.style.background = Math.random() > 0.5 ? '#00ff41' : 'white';
                setTimeout(() => {
                    this.overlay.style.opacity = '0';
                    count++;
                    setTimeout(doFlicker, 50 + Math.random() * 150);
                }, 30 + Math.random() * 70);
            };
            doFlicker();
        });
    }

    // Save scroll positions of all scroll containers to prevent glitch artifacts
    // from displacing the user's scroll position
    _saveScrollPositions() {
        const ids = ['chat-messages', 'boot-terminal', 'vision-output'];
        const saved = {};
        for (const id of ids) {
            const el = document.getElementById(id);
            if (el) saved[id] = el.scrollTop;
        }
        return saved;
    }

    _restoreScrollPositions(saved) {
        for (const [id, pos] of Object.entries(saved)) {
            const el = document.getElementById(id);
            if (el) el.scrollTop = pos;
        }
    }

    glitchScreen() {
        const app = document.getElementById('app');
        const glitchType = Math.floor(Math.random() * 17);
        const savedScroll = this._saveScrollPositions();

        const restore = () => this._restoreScrollPositions(savedScroll);

        switch (glitchType) {
            case 0: // Classic transform glitch
                app.classList.add('glitch-text');
                setTimeout(() => { app.classList.remove('glitch-text'); restore(); }, 300);
                break;

            case 1: // Color channel split (RGB offset)
                app.style.textShadow = `${-3 + Math.random()*6}px 0 rgba(255,0,0,0.5), ${-3 + Math.random()*6}px 0 rgba(0,0,255,0.5)`;
                setTimeout(() => { app.style.textShadow = ''; restore(); }, 150 + Math.random() * 200);
                break;

            case 2: // Horizontal tear (clip-path)
                {
                    const tearY = Math.random() * 100;
                    const tearH = 3 + Math.random() * 15;
                    app.style.clipPath = `polygon(0 0, 100% 0, 100% ${tearY}%, ${5+Math.random()*10}% ${tearY}%, ${5+Math.random()*10}% ${tearY+tearH}%, 100% ${tearY+tearH}%, 100% 100%, 0 100%)`;
                    setTimeout(() => { app.style.clipPath = ''; restore(); }, 80 + Math.random() * 120);
                }
                break;

            case 3: // Invert flash — use overlay with mix-blend-mode instead of CSS filter
                {
                    const invertOverlay = document.createElement('div');
                    invertOverlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:996;pointer-events:none;background:#fff;mix-blend-mode:difference;';
                    (document.getElementById('crt-screen') || document.body).appendChild(invertOverlay);
                    setTimeout(() => { invertOverlay.remove(); restore(); }, 50 + Math.random() * 80);
                }
                break;

            case 4: // Scale distortion (transform is safe — doesn't rasterize WebGL)
                {
                    const sx = 1 + (Math.random() - 0.5) * 0.04;
                    const sy = 1 + (Math.random() - 0.5) * 0.04;
                    app.style.transform = `scale(${sx}, ${sy})`;
                    setTimeout(() => { app.style.transform = ''; restore(); }, 100 + Math.random() * 150);
                }
                break;

            case 5: // Skew (transform is safe)
                {
                    const skew = (Math.random() - 0.5) * 4;
                    app.style.transform = `skewX(${skew}deg)`;
                    setTimeout(() => { app.style.transform = ''; restore(); }, 80 + Math.random() * 100);
                }
                break;

            case 6: // VHS tracking error — wavy horizontal offset bands
                {
                    const bands = document.createElement('div');
                    bands.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:9999;pointer-events:none;overflow:hidden;';
                    const numBands = 1 + Math.floor(Math.random() * 3);
                    let html = '';
                    for (let i = 0; i < numBands; i++) {
                        const bandY = Math.random() * 85;
                        const bandH = 3 + Math.random() * 12;
                        const offset = (Math.random() - 0.5) * 40;
                        html += `<div style="position:absolute;top:${bandY}%;height:${bandH}%;left:0;right:0;transform:translateX(${offset}px);background:rgba(0,255,65,0.04);border-top:1px solid rgba(0,255,65,0.15);border-bottom:1px solid rgba(0,255,65,0.15);"></div>`;
                    }
                    bands.innerHTML = html;
                    (document.getElementById('crt-screen') || document.body).appendChild(bands);
                    setTimeout(() => { bands.remove(); restore(); }, 120 + Math.random() * 180);
                }
                break;

            case 7: // CHANNEL ROLL — entire screen scrolls vertically (transform is safe)
                {
                    const rollDir = Math.random() > 0.5 ? 1 : -1;
                    const rollAmount = 15 + Math.random() * 40;
                    app.style.transition = 'none';
                    app.style.transform = `translateY(${rollDir * rollAmount}px)`;
                    setTimeout(() => {
                        app.style.transition = 'transform 0.15s ease-out';
                        app.style.transform = '';
                        setTimeout(() => { app.style.transition = ''; restore(); }, 200);
                    }, 60 + Math.random() * 80);
                }
                break;

            case 8: // WAVY LINES — horizontal sine distortion
                {
                    const waveOverlay = document.createElement('div');
                    waveOverlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:9998;pointer-events:none;overflow:hidden;';
                    let strips = '';
                    const stripH = 3 + Math.random() * 5;
                    const baseY = Math.random() * 70;
                    for (let i = 0; i < 8; i++) {
                        const y = baseY + i * stripH;
                        const xOff = Math.sin(i * 0.8) * (4 + Math.random() * 8);
                        strips += `<div style="position:absolute;top:${y}%;height:${stripH}%;left:0;right:0;transform:translateX(${xOff}px);background:rgba(0,255,65,0.03);"></div>`;
                    }
                    waveOverlay.innerHTML = strips;
                    (document.getElementById('crt-screen') || document.body).appendChild(waveOverlay);
                    setTimeout(() => { waveOverlay.remove(); restore(); }, 100 + Math.random() * 200);
                }
                break;

            case 9: // FULL STATIC BLAST — brief moment of heavy static
                if (typeof staticEffect !== 'undefined') {
                    staticEffect.spike(0.3, 100 + Math.random() * 100);
                }
                // Static doesn't affect layout, but restore anyway
                setTimeout(restore, 200);
                break;

            case 10: // VHS TAPE TRACKING — horizontal bars sweep up screen
                {
                    const vhsWrap = document.createElement('div');
                    vhsWrap.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:9998;pointer-events:none;overflow:hidden;';
                    let vhsBars = '';
                    const barCount = 3 + Math.floor(Math.random() * 5);
                    for (let i = 0; i < barCount; i++) {
                        const y = 100 + i * (100 / barCount); // start below viewport
                        const h = 2 + Math.random() * 8;
                        const xOff = (Math.random() - 0.5) * 50;
                        vhsBars += `<div style="position:absolute;top:${y}%;height:${h}%;left:0;right:0;transform:translateX(${xOff}px);background:rgba(0,255,65,0.07);border-top:1px solid rgba(0,255,65,0.2);border-bottom:1px solid rgba(0,255,65,0.12);"></div>`;
                    }
                    vhsWrap.innerHTML = vhsBars;
                    (document.getElementById('crt-screen') || document.body).appendChild(vhsWrap);
                    // Sweep upward
                    vhsWrap.style.transition = 'transform 0.6s ease-in';
                    requestAnimationFrame(() => {
                        vhsWrap.style.transform = 'translateY(-220%)';
                    });
                    // Static spike during sweep
                    if (typeof staticEffect !== 'undefined') {
                        staticEffect.spike(0.15, 400);
                    }
                    setTimeout(() => { vhsWrap.remove(); restore(); }, 700);
                }
                break;

            case 11: // CHROMA ABERRATION — RGB channel offset like misaligned CRT guns
                {
                    const chromaOverlay = document.createElement('div');
                    chromaOverlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:9997;pointer-events:none;overflow:hidden;';
                    const xOff = 2 + Math.random() * 6;
                    const yOff = (Math.random() - 0.5) * 3;
                    chromaOverlay.innerHTML = `
                        <div style="position:absolute;top:0;left:${-xOff}px;right:${xOff}px;bottom:0;background:rgba(255,0,0,0.06);mix-blend-mode:screen;transform:translateY(${yOff}px);"></div>
                        <div style="position:absolute;top:0;left:${xOff}px;right:${-xOff}px;bottom:0;background:rgba(0,0,255,0.06);mix-blend-mode:screen;transform:translateY(${-yOff}px);"></div>
                    `;
                    (document.getElementById('crt-screen') || document.body).appendChild(chromaOverlay);
                    setTimeout(() => { chromaOverlay.remove(); restore(); }, 150 + Math.random() * 200);
                }
                break;

            case 12: // TAPE DROPOUT — horizontal black bands (signal loss on worn tape)
                {
                    const dropWrap = document.createElement('div');
                    dropWrap.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:9998;pointer-events:none;overflow:hidden;';
                    const numDrops = 1 + Math.floor(Math.random() * 4);
                    let dropHtml = '';
                    for (let i = 0; i < numDrops; i++) {
                        const y = Math.random() * 95;
                        const h = 0.5 + Math.random() * 3;
                        const noiseAlpha = 0.3 + Math.random() * 0.4;
                        dropHtml += `<div style="position:absolute;top:${y}%;height:${h}%;left:0;right:0;background:linear-gradient(90deg, rgba(0,0,0,${noiseAlpha}) 0%, rgba(10,10,10,${noiseAlpha*0.8}) 30%, rgba(0,0,0,${noiseAlpha}) 60%, rgba(20,20,20,${noiseAlpha*0.6}) 100%);"></div>`;
                    }
                    dropWrap.innerHTML = dropHtml;
                    (document.getElementById('crt-screen') || document.body).appendChild(dropWrap);
                    setTimeout(() => { dropWrap.remove(); restore(); }, 80 + Math.random() * 150);
                }
                break;

            case 13: // HEAD SWITCH NOISE — thick noisy bar at bottom of screen (VHS head switch artifact)
                {
                    const headBar = document.createElement('div');
                    const barH = 3 + Math.random() * 8;
                    headBar.style.cssText = `position:absolute;bottom:0;left:0;right:0;height:${barH}%;z-index:9998;pointer-events:none;overflow:hidden;background:linear-gradient(180deg, transparent 0%, rgba(0,255,65,0.08) 20%, rgba(255,255,255,0.04) 50%, rgba(0,0,0,0.6) 80%, #000 100%);`;
                    // Add random horizontal offset strips within the bar
                    let strips = '';
                    for (let i = 0; i < 6; i++) {
                        const sy = i * 16;
                        const xo = (Math.random() - 0.5) * 80;
                        strips += `<div style="position:absolute;top:${sy}%;height:16%;left:0;right:0;transform:translateX(${xo}px);background:rgba(0,255,65,0.05);border-top:1px solid rgba(0,255,65,0.1);"></div>`;
                    }
                    headBar.innerHTML = strips;
                    (document.getElementById('crt-screen') || document.body).appendChild(headBar);
                    setTimeout(() => { headBar.remove(); restore(); }, 120 + Math.random() * 200);
                }
                break;

            case 14: // TAPE WARBLE — wobbly horizontal distortion like a warped cassette
                {
                    const t0 = performance.now();
                    const dur = 200 + Math.random() * 300;
                    const freq = 8 + Math.random() * 15;
                    const amp = 3 + Math.random() * 8;
                    function wobbleFrame() {
                        const elapsed = performance.now() - t0;
                        if (elapsed > dur) { app.style.transform = ''; restore(); return; }
                        const progress = elapsed / dur;
                        const decay = 1 - progress;
                        const xOff = Math.sin(elapsed / 1000 * freq * Math.PI * 2) * amp * decay;
                        const yOff = Math.cos(elapsed / 1000 * freq * 0.7 * Math.PI * 2) * (amp * 0.3) * decay;
                        app.style.transform = `translate(${xOff}px, ${yOff}px)`;
                        requestAnimationFrame(wobbleFrame);
                    }
                    wobbleFrame();
                }
                break;

            case 15: // COLOR BLEED — green/white smear across random horizontal band
                {
                    const bleedWrap = document.createElement('div');
                    bleedWrap.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:9997;pointer-events:none;overflow:hidden;';
                    const bleedY = Math.random() * 90;
                    const bleedH = 2 + Math.random() * 8;
                    const bleedDir = Math.random() > 0.5 ? 1 : -1;
                    const smearPx = 20 + Math.random() * 60;
                    bleedWrap.innerHTML = `<div style="position:absolute;top:${bleedY}%;height:${bleedH}%;left:0;right:0;background:linear-gradient(${bleedDir > 0 ? '90deg' : '270deg'}, transparent 0%, rgba(0,255,65,0.12) 30%, rgba(200,255,200,0.06) 60%, transparent 100%);transform:translateX(${bleedDir * smearPx}px);filter:blur(2px);"></div>`;
                    (document.getElementById('crt-screen') || document.body).appendChild(bleedWrap);
                    setTimeout(() => { bleedWrap.remove(); restore(); }, 100 + Math.random() * 150);
                }
                break;

            case 16: // VERTICAL HOLD SLIP — screen jumps vertically then snaps back like bad V-hold
                {
                    const slipAmt = 40 + Math.random() * 120;
                    const slipDir = Math.random() > 0.5 ? 1 : -1;
                    app.style.transition = 'none';
                    app.style.transform = `translateY(${slipDir * slipAmt}px)`;
                    // Brief white flash at seam
                    const seam = document.createElement('div');
                    const seamY = slipDir > 0 ? 0 : 100;
                    seam.style.cssText = `position:absolute;top:${seamY - 2}%;left:0;right:0;height:4%;z-index:9999;pointer-events:none;background:rgba(255,255,255,0.08);`;
                    (document.getElementById('crt-screen') || document.body).appendChild(seam);
                    setTimeout(() => {
                        app.style.transition = 'transform 0.12s ease-out';
                        app.style.transform = '';
                        seam.remove();
                        setTimeout(() => { app.style.transition = ''; restore(); }, 150);
                    }, 40 + Math.random() * 60);
                }
                break;
        }
    }

    // Rapid multi-glitch burst (for message send)
    glitchBurst(count = 3) {
        for (let i = 0; i < count; i++) {
            setTimeout(() => this.glitchScreen(), i * 60 + Math.random() * 40);
        }
    }
}

// ============================================================
// AVATAR GLITCH SYSTEM — Periodic glitch effects on Chad's 3D head
// ============================================================

class AvatarGlitchSystem {
    constructor() {
        this.container = document.getElementById('three-container');
        this.canvas = null;
        this.ctx = null;
        this.active = false;
        this.intervalId = null;
        this.matrixColumns = [];
    }

    start() {
        if (this.active) return;
        this.active = true;
        this._scheduleNext();
    }

    stop() {
        this.active = false;
        this._assembling = false;
        if (this.intervalId) clearTimeout(this.intervalId);
        if (this.canvas) {
            this.canvas.classList.remove('active');
            if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
    }

    // Assembly reveal: CSS glitch effects during wake-up
    assemblyReveal(duration, onDone) {
        if (!this.container) { if (onDone) onDone(); return; }
        this._assembling = true;
        var self = this;
        var startTime = Date.now();

        function step() {
            if (!self._assembling) { if (onDone) onDone(); return; }
            var elapsed = Date.now() - startTime;
            var progress = Math.min(1, elapsed / duration);

            // Periodic CSS glitch effects during assembly
            if (Math.random() > 0.7) self._flickerGlitch();
            if (Math.random() > 0.85) self._vhsWobble();
            if (Math.random() > 0.9) self._rgbSplit();

            if (progress >= 1) {
                self._assembling = false;
                if (onDone) onDone();
                return;
            }
            requestAnimationFrame(step);
        }
        step();
    }

    _scheduleNext() {
        if (!this.active) return;
        const delay = 5000 + Math.random() * 10000;
        this.intervalId = setTimeout(() => {
            this._doGlitch();
            this._scheduleNext();
        }, delay);
    }

    _doGlitch() {
        if (!this.container) return;
        // Only use CSS-based glitch effects (no canvas overlay needed)
        const type = Math.floor(Math.random() * 3);
        switch (type) {
            case 0: this._flickerGlitch(); break;
            case 1: this._vhsWobble(); break;
            case 2: this._rgbSplit(); break;
        }
    }

    _flickerGlitch() {
        this.container.classList.add('avatar-flicker');
        setTimeout(() => this.container.classList.remove('avatar-flicker'), 450);
    }

    _vhsWobble() {
        this.container.classList.add('avatar-vhs-wobble');
        setTimeout(() => this.container.classList.remove('avatar-vhs-wobble'), 400);
    }

    _rgbSplit() {
        this.container.classList.add('avatar-rgb-split');
        setTimeout(() => this.container.classList.remove('avatar-rgb-split'), 200);
    }

    _matrixRain() {
        if (!this.ctx || !this.canvas) return;
        this._sizeCanvas();
        this.canvas.classList.add('active');
        const w = this.canvas.width;
        const h = this.canvas.height;
        const fontSize = 10;
        const cols = Math.floor(w / fontSize);
        const drops = new Array(cols).fill(0).map(() => Math.random() * -20);
        const chars = '01アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン';
        let frames = 0;
        const maxFrames = 40;

        const draw = () => {
            if (frames >= maxFrames) {
                this.canvas.classList.remove('active');
                return;
            }
            this.ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
            this.ctx.fillRect(0, 0, w, h);
            this.ctx.fillStyle = '#00ff41';
            this.ctx.font = fontSize + 'px monospace';

            for (let i = 0; i < cols; i++) {
                if (drops[i] >= 0) {
                    const char = chars[Math.floor(Math.random() * chars.length)];
                    const brightness = Math.random();
                    this.ctx.fillStyle = brightness > 0.8 ? '#ffffff' : (brightness > 0.4 ? '#00ff41' : '#004d00');
                    this.ctx.fillText(char, i * fontSize, drops[i] * fontSize);
                }
                if (drops[i] * fontSize > h && Math.random() > 0.97) drops[i] = 0;
                drops[i] += 0.5 + Math.random() * 0.5;
            }
            frames++;
            requestAnimationFrame(draw);
        };
        draw();
    }

    _staticBurst() {
        if (!this.ctx || !this.canvas) return;
        this._sizeCanvas();
        this.canvas.classList.add('active');
        const w = this.canvas.width;
        const h = this.canvas.height;
        let frames = 0;

        const draw = () => {
            if (frames >= 8) {
                this.ctx.clearRect(0, 0, w, h);
                this.canvas.classList.remove('active');
                return;
            }
            const imageData = this.ctx.createImageData(w, h);
            const d = imageData.data;
            for (let i = 0; i < d.length; i += 4) {
                const v = Math.random() * 255;
                d[i] = v * 0.2;
                d[i + 1] = v * 0.8 + 50;
                d[i + 2] = v * 0.2;
                d[i + 3] = 120 + Math.random() * 80;
            }
            this.ctx.putImageData(imageData, 0, 0);
            frames++;
            setTimeout(() => requestAnimationFrame(draw), 30);
        };
        draw();
    }

    _binaryFlash() {
        if (!this.ctx || !this.canvas) return;
        this._sizeCanvas();
        this.canvas.classList.add('active');
        const w = this.canvas.width;
        const h = this.canvas.height;
        let frames = 0;

        const draw = () => {
            if (frames >= 12) {
                this.ctx.clearRect(0, 0, w, h);
                this.canvas.classList.remove('active');
                return;
            }
            this.ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            this.ctx.fillRect(0, 0, w, h);
            this.ctx.font = '11px monospace';

            for (let y = 0; y < h; y += 14) {
                for (let x = 0; x < w; x += 9) {
                    if (Math.random() > 0.3) {
                        const b = Math.random();
                        this.ctx.fillStyle = b > 0.9 ? '#fff' : (b > 0.5 ? '#00ff41' : '#003300');
                        this.ctx.fillText(Math.random() > 0.5 ? '1' : '0', x, y);
                    }
                }
            }
            frames++;
            setTimeout(() => requestAnimationFrame(draw), 60);
        };
        draw();
    }

    _scanlineRoll() {
        if (!this.ctx || !this.canvas) return;
        this._sizeCanvas();
        this.canvas.classList.add('active');
        const w = this.canvas.width;
        const h = this.canvas.height;
        let offset = 0;
        let frames = 0;

        const draw = () => {
            if (frames >= 20) {
                this.ctx.clearRect(0, 0, w, h);
                this.canvas.classList.remove('active');
                return;
            }
            this.ctx.clearRect(0, 0, w, h);
            // Rolling thick scanline band
            const bandH = 30 + Math.random() * 20;
            const y = (offset % (h + bandH)) - bandH;
            const grad = this.ctx.createLinearGradient(0, y, 0, y + bandH);
            grad.addColorStop(0, 'rgba(0, 255, 65, 0)');
            grad.addColorStop(0.3, 'rgba(0, 255, 65, 0.15)');
            grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.08)');
            grad.addColorStop(0.7, 'rgba(0, 255, 65, 0.15)');
            grad.addColorStop(1, 'rgba(0, 255, 65, 0)');
            this.ctx.fillStyle = grad;
            this.ctx.fillRect(0, y, w, bandH);
            offset += 8 + Math.random() * 4;
            frames++;
            requestAnimationFrame(draw);
        };
        draw();
    }

    _sizeCanvas() {
        // No-op: canvas overlay removed to avoid WebGL conflicts
    }
}

// ============================================================
// IMAGE GENERATION ANIMATION — Canvas pixel assembly effect
// ============================================================

class ImageGenAnimation {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.running = false;
        this.phase = 'static'; // static -> assembling -> reveal
        this.pixelData = null;
        this.revealMask = null;
        this.frame = 0;
    }

    start() {
        this.running = true;
        this.phase = 'static';
        this.frame = 0;
        this.canvas.width = 256;
        this.canvas.height = 256;
        this._animate();
    }

    stop() {
        this.running = false;
    }

    snapToImage(imgUrl) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                this.phase = 'reveal';
                this.canvas.width = 256;
                this.canvas.height = 256;
                // Draw the final image to get pixel data
                this.ctx.drawImage(img, 0, 0, 256, 256);
                this.pixelData = this.ctx.getImageData(0, 0, 256, 256);
                this.revealMask = new Uint8Array(256 * 256); // 0 = hidden, 1 = revealed
                this.frame = 0;
                this._animateReveal(resolve);
            };
            img.onerror = () => {
                this.running = false;
                resolve();
            };
            img.src = imgUrl;
        });
    }

    _animate() {
        if (!this.running || this.phase === 'reveal') return;
        requestAnimationFrame(() => this._animate());

        const w = this.canvas.width;
        const h = this.canvas.height;
        const imageData = this.ctx.createImageData(w, h);
        const d = imageData.data;
        this.frame++;

        if (this.phase === 'static') {
            // Phase 1: TV static with rolling matrix numbers
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const i = (y * w + x) * 4;
                    const v = Math.random() * 180;
                    d[i] = v * 0.15;
                    d[i + 1] = v * 0.6;
                    d[i + 2] = v * 0.15;
                    d[i + 3] = 255;
                }
            }

            // Rolling code bands
            const numBands = 2 + Math.floor(Math.random() * 3);
            for (let b = 0; b < numBands; b++) {
                const bandY = (this.frame * 3 + b * 60) % (h + 40) - 20;
                const bandH = 8 + Math.random() * 12;
                for (let y = Math.max(0, Math.floor(bandY)); y < Math.min(h, Math.floor(bandY + bandH)); y++) {
                    for (let x = 0; x < w; x++) {
                        const i = (y * w + x) * 4;
                        // Green-tinted bright band
                        d[i] = 0;
                        d[i + 1] = 100 + Math.random() * 155;
                        d[i + 2] = 0;
                        d[i + 3] = 200;
                    }
                }
            }

            // Sporadic pixel clusters (foreshadowing image assembly)
            if (this.frame > 15) {
                const clusterCount = Math.min(this.frame - 15, 80);
                for (let c = 0; c < clusterCount; c++) {
                    const cx = Math.floor(Math.random() * w);
                    const cy = Math.floor(Math.random() * h);
                    const size = 1 + Math.floor(Math.random() * 3);
                    for (let dy = 0; dy < size; dy++) {
                        for (let dx = 0; dx < size; dx++) {
                            const px = cx + dx;
                            const py = cy + dy;
                            if (px < w && py < h) {
                                const i = (py * w + px) * 4;
                                // Random colored pixels
                                d[i] = Math.random() * 200;
                                d[i + 1] = 100 + Math.random() * 155;
                                d[i + 2] = Math.random() * 100;
                                d[i + 3] = 255;
                            }
                        }
                    }
                }
            }

            this.ctx.putImageData(imageData, 0, 0);

            // Overlay rolling numbers
            if (this.frame % 3 === 0) {
                this.ctx.font = '10px monospace';
                const numRows = 3 + Math.floor(Math.random() * 5);
                for (let r = 0; r < numRows; r++) {
                    const y = (this.frame * 2 + r * 30) % (h + 20);
                    const brightness = Math.random();
                    this.ctx.fillStyle = brightness > 0.7 ? '#00ff41' : '#003300';
                    let line = '';
                    for (let c = 0; c < 30; c++) {
                        line += Math.random() > 0.5 ? '1' : '0';
                    }
                    this.ctx.fillText(line, Math.random() * 20, y);
                }
            }
        }
    }

    _animateReveal(onDone) {
        if (!this.running || !this.pixelData) {
            onDone();
            return;
        }

        const w = 256, h = 256;
        const totalPixels = w * h;
        const revealPerFrame = Math.floor(totalPixels / 15); // Reveal in ~15 frames

        // Reveal random chunks of pixels
        for (let i = 0; i < revealPerFrame; i++) {
            const idx = Math.floor(Math.random() * totalPixels);
            this.revealMask[idx] = 1;
        }

        // Build the frame
        const display = this.ctx.createImageData(w, h);
        const src = this.pixelData.data;
        const dst = display.data;

        for (let i = 0; i < totalPixels; i++) {
            const pi = i * 4;
            if (this.revealMask[i]) {
                // Show real pixel
                dst[pi] = src[pi];
                dst[pi + 1] = src[pi + 1];
                dst[pi + 2] = src[pi + 2];
                dst[pi + 3] = src[pi + 3];
            } else {
                // Static noise
                const v = Math.random() * 150;
                dst[pi] = v * 0.15;
                dst[pi + 1] = v * 0.5;
                dst[pi + 2] = v * 0.15;
                dst[pi + 3] = 255;
            }
        }

        this.ctx.putImageData(display, 0, 0);
        this.frame++;

        // Check if mostly revealed
        let revealed = 0;
        for (let i = 0; i < totalPixels; i++) {
            if (this.revealMask[i]) revealed++;
        }

        if (revealed >= totalPixels * 0.95) {
            // Final snap: draw the full image
            this.ctx.putImageData(this.pixelData, 0, 0);
            this.running = false;

            // Glitch burst on completion
            if (typeof flickerEffect !== 'undefined') {
                flickerEffect.glitchBurst(4);
            }
            if (typeof staticEffect !== 'undefined') {
                staticEffect.spike(0.3, 300);
            }

            onDone();
        } else {
            // Add VHS tracking artifacts during reveal
            if (Math.random() > 0.6) {
                const bandY = Math.floor(Math.random() * h);
                const bandH = 2 + Math.floor(Math.random() * 6);
                const offset = Math.floor((Math.random() - 0.5) * 20);
                this.ctx.drawImage(this.canvas, 0, bandY, w, bandH, offset, bandY, w, bandH);
            }

            requestAnimationFrame(() => this._animateReveal(onDone));
        }
    }
}

// ============================================================
// BOOT REVEAL — Progressive element appearance with glitch effects
// ============================================================

function bootRevealElement(el, delayMs) {
    return new Promise(resolve => {
        setTimeout(() => {
            el.style.visibility = 'visible';
            el.classList.add('boot-reveal');
            el.addEventListener('animationend', () => {
                el.classList.remove('boot-reveal');
                resolve();
            }, { once: true });
            // Safety timeout
            setTimeout(resolve, 800);
        }, delayMs);
    });
}

// Initialize effects
let staticEffect, flickerEffect;
let avatarGlitchSystem;
// Boot settling: glitches are intense right after boot, then taper
let bootCompletedAt = 0;

// Get glitch probability multiplier based on time since boot
function glitchMultiplier() {
    if (!bootCompletedAt) return 1.0; // pre-boot: normal
    const elapsed = (Date.now() - bootCompletedAt) / 1000;
    if (elapsed < 3) return 3.0;   // first 3s: intense
    if (elapsed < 6) return 2.0;   // 3-6s: high
    if (elapsed < 10) return 1.5;  // 6-10s: moderate
    return 1.0;                     // after 10s: normal
}

window.addEventListener('DOMContentLoaded', () => {
    staticEffect = new StaticEffect('static-overlay');
    staticEffect.start();
    flickerEffect = new FlickerEffect('flicker-overlay');
    avatarGlitchSystem = new AvatarGlitchSystem();

    // === VHS CASSETTE SYSTEM NOISE ===

    // Frequent static glitches + occasional VHS sound
    setInterval(() => {
        const m = glitchMultiplier();
        if (Math.random() < 0.4 * m) {
            flickerEffect.flicker(1);
            if (typeof chadAudio !== 'undefined') {
                const s = Math.random();
                if (s < 0.15) chadAudio.playGlitch();
                else if (s < 0.25) chadAudio.playTapeHiss();
                else if (s < 0.32) chadAudio.playHeadSwitch();
            }
        }
    }, 1500);

    // Visual glitches with VHS artifacts + matched audio
    setInterval(() => {
        const m = glitchMultiplier();
        if (Math.random() < 0.3 * m) {
            flickerEffect.glitchScreen();
            if (typeof chadAudio !== 'undefined') {
                const s = Math.random();
                if (s < 0.2) chadAudio.playGlitch();
                else if (s < 0.35) chadAudio.playTapeWarble();
                else if (s < 0.45) chadAudio.playHeadSwitch();
            }
        }
    }, 2000);

    // Heavy glitch bursts — compound audio
    setInterval(() => {
        const m = glitchMultiplier();
        if (Math.random() < 0.12 * m) {
            flickerEffect.flicker(Math.floor(Math.random() * 3) + 2, 60);
            flickerEffect.glitchScreen();
            if (typeof chadAudio !== 'undefined') {
                chadAudio.playGlitch();
                setTimeout(() => chadAudio.playTapeWarble(), 80);
            }
        }
    }, 6000);

    // VHS tracking wobble (transform is safe for WebGL)
    setInterval(() => {
        const m = glitchMultiplier();
        if (Math.random() < 0.15 * m) {
            const app = document.getElementById('app');
            app.style.transform = `translateX(${(Math.random()-0.5)*10}px)`;
            setTimeout(() => { app.style.transform = ''; }, 40 + Math.random() * 80);
        }
    }, 2000);

    // Brightness dips / tape dropout — use overlay instead of CSS filter
    setInterval(() => {
        if (Math.random() > 0.85 && flickerEffect) {
            const brightness = 0.3 + Math.random() * 0.4;
            flickerEffect._setBrightness(brightness);
            if (typeof chadAudio !== 'undefined' && Math.random() < 0.4) chadAudio.playDropout();
            setTimeout(() => flickerEffect._clearBrightness(), 60 + Math.random() * 100);
        }
    }, 3000);

    // Static intensity fluctuation (tape oxide hiss level)
    setInterval(() => {
        if (staticEffect.running) {
            const base = 0.06;
            const variance = Math.random() * 0.04;
            staticEffect.setIntensity(base + variance);
        }
    }, 500);

    // Channel roll (rare but dramatic — with audio)
    setInterval(() => {
        if (Math.random() > 0.95) {
            const app = document.getElementById('app');
            const rollAmount = 30 + Math.random() * 60;
            app.style.transition = 'none';
            app.style.transform = `translateY(${rollAmount}px)`;
            if (typeof chadAudio !== 'undefined') {
                chadAudio.playHeadSwitch();
                chadAudio.playTapeWarble();
            }
            setTimeout(() => {
                app.style.transition = 'transform 0.2s ease-out';
                app.style.transform = '';
                setTimeout(() => { app.style.transition = ''; }, 250);
            }, 80);
        }
    }, 8000);
});
