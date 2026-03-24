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

        // Multiple VHS corruption bands (more frequent)
        const numBands = Math.random() > 0.4 ? Math.floor(1 + Math.random() * 3) : 0;
        const bands = [];
        for (let b = 0; b < numBands; b++) {
            bands.push({
                y: Math.floor(Math.random() * h),
                h: Math.floor(1 + Math.random() * 3),
            });
        }

        for (let y = 0; y < h; y++) {
            let inBand = false;
            for (const band of bands) {
                if (y >= band.y && y < band.y + band.h) { inBand = true; break; }
            }
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                if (inBand) {
                    const val = 120 + Math.random() * 135;
                    data[i] = val; data[i+1] = val * 0.85; data[i+2] = val * 0.7;
                    data[i+3] = 180;
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
        this.brightnessOverlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:997;pointer-events:none;background:#000;opacity:0;transition:none;';
        document.body.appendChild(this.brightnessOverlay);
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

    glitchScreen() {
        const app = document.getElementById('app');
        const glitchType = Math.floor(Math.random() * 10);

        switch (glitchType) {
            case 0: // Classic transform glitch
                app.classList.add('glitch-text');
                setTimeout(() => app.classList.remove('glitch-text'), 300);
                break;

            case 1: // Color channel split (RGB offset)
                app.style.textShadow = `${-3 + Math.random()*6}px 0 rgba(255,0,0,0.5), ${-3 + Math.random()*6}px 0 rgba(0,0,255,0.5)`;
                setTimeout(() => { app.style.textShadow = ''; }, 150 + Math.random() * 200);
                break;

            case 2: // Horizontal tear (clip-path)
                {
                    const tearY = Math.random() * 100;
                    const tearH = 3 + Math.random() * 15;
                    app.style.clipPath = `polygon(0 0, 100% 0, 100% ${tearY}%, ${5+Math.random()*10}% ${tearY}%, ${5+Math.random()*10}% ${tearY+tearH}%, 100% ${tearY+tearH}%, 100% 100%, 0 100%)`;
                    setTimeout(() => { app.style.clipPath = ''; }, 80 + Math.random() * 120);
                }
                break;

            case 3: // Invert flash — use overlay with mix-blend-mode instead of CSS filter
                {
                    const invertOverlay = document.createElement('div');
                    invertOverlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:996;pointer-events:none;background:#fff;mix-blend-mode:difference;';
                    document.body.appendChild(invertOverlay);
                    setTimeout(() => invertOverlay.remove(), 50 + Math.random() * 80);
                }
                break;

            case 4: // Scale distortion (transform is safe — doesn't rasterize WebGL)
                {
                    const sx = 1 + (Math.random() - 0.5) * 0.04;
                    const sy = 1 + (Math.random() - 0.5) * 0.04;
                    app.style.transform = `scale(${sx}, ${sy})`;
                    setTimeout(() => { app.style.transform = ''; }, 100 + Math.random() * 150);
                }
                break;

            case 5: // Skew (transform is safe)
                {
                    const skew = (Math.random() - 0.5) * 4;
                    app.style.transform = `skewX(${skew}deg)`;
                    setTimeout(() => { app.style.transform = ''; }, 80 + Math.random() * 100);
                }
                break;

            case 6: // VHS tracking error — wavy horizontal offset bands
                {
                    const bands = document.createElement('div');
                    bands.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;pointer-events:none;overflow:hidden;';
                    const numBands = 1 + Math.floor(Math.random() * 3);
                    let html = '';
                    for (let i = 0; i < numBands; i++) {
                        const bandY = Math.random() * 85;
                        const bandH = 3 + Math.random() * 12;
                        const offset = (Math.random() - 0.5) * 40;
                        html += `<div style="position:absolute;top:${bandY}%;height:${bandH}%;left:0;right:0;transform:translateX(${offset}px);background:rgba(0,255,65,0.04);border-top:1px solid rgba(0,255,65,0.15);border-bottom:1px solid rgba(0,255,65,0.15);"></div>`;
                    }
                    bands.innerHTML = html;
                    document.body.appendChild(bands);
                    setTimeout(() => bands.remove(), 120 + Math.random() * 180);
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
                        setTimeout(() => { app.style.transition = ''; }, 200);
                    }, 60 + Math.random() * 80);
                }
                break;

            case 8: // WAVY LINES — horizontal sine distortion
                {
                    const waveOverlay = document.createElement('div');
                    waveOverlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9998;pointer-events:none;overflow:hidden;';
                    let strips = '';
                    const stripH = 3 + Math.random() * 5;
                    const baseY = Math.random() * 70;
                    for (let i = 0; i < 8; i++) {
                        const y = baseY + i * stripH;
                        const xOff = Math.sin(i * 0.8) * (4 + Math.random() * 8);
                        strips += `<div style="position:absolute;top:${y}%;height:${stripH}%;left:0;right:0;transform:translateX(${xOff}px);background:rgba(0,255,65,0.03);"></div>`;
                    }
                    waveOverlay.innerHTML = strips;
                    document.body.appendChild(waveOverlay);
                    setTimeout(() => waveOverlay.remove(), 100 + Math.random() * 200);
                }
                break;

            case 9: // FULL STATIC BLAST — brief moment of heavy static
                if (typeof staticEffect !== 'undefined') {
                    staticEffect.spike(0.3, 100 + Math.random() * 100);
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

// Ambient Hum Audio Controller — uses Web Audio API for gapless looping
class AmbientHum {
    constructor() {
        this.ctx = null;
        this.buffer = null;
        this.source = null;
        this.gainNode = null;
        this.active = false;
    }

    async start() {
        if (this.active) return;
        try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            const response = await fetch('/static/hum.wav');
            const arrayBuffer = await response.arrayBuffer();
            this.buffer = await this.ctx.decodeAudioData(arrayBuffer);

            this.gainNode = this.ctx.createGain();
            this.gainNode.gain.setValueAtTime(0, this.ctx.currentTime);
            this.gainNode.connect(this.ctx.destination);

            this.source = this.ctx.createBufferSource();
            this.source.buffer = this.buffer;
            this.source.loop = true;
            this.source.connect(this.gainNode);
            this.source.start(0);

            this.active = true;
            // Smooth fade in over 2 seconds — louder fan presence
            // Louder hum — user wants ongoing sketchy ambience
            this.gainNode.gain.linearRampToValueAtTime(0.30, this.ctx.currentTime + 2);
        } catch(e) {
            console.warn('AmbientHum: failed:', e);
        }
    }

    stop() {
        if (!this.active || !this.ctx) return;
        try {
            this.gainNode.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.5);
            setTimeout(() => {
                if (this.source) { try { this.source.stop(); } catch(e) {} this.source = null; }
                this.active = false;
            }, 600);
        } catch(e) { this.active = false; }
    }

    setVolume(v) {
        if (this.gainNode && this.ctx) {
            this.gainNode.gain.linearRampToValueAtTime(
                Math.max(0, Math.min(1, v)),
                this.ctx.currentTime + 0.05
            );
        }
    }
}

// Initialize effects
let staticEffect, flickerEffect, ambientHum;
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
    ambientHum = new AmbientHum();

    // === VHS SYSTEM NOISE ===

    // Frequent static glitches
    setInterval(() => {
        const m = glitchMultiplier();
        if (Math.random() < 0.4 * m) flickerEffect.flicker(1);
    }, 1500);

    // Visual glitches with VHS artifacts
    setInterval(() => {
        const m = glitchMultiplier();
        if (Math.random() < 0.3 * m) {
            flickerEffect.glitchScreen();
        }
    }, 2000);

    // Heavy glitch bursts
    setInterval(() => {
        const m = glitchMultiplier();
        if (Math.random() < 0.12 * m) {
            flickerEffect.flicker(Math.floor(Math.random() * 3) + 2, 60);
            flickerEffect.glitchScreen();
            if (typeof playGlitchSound === 'function') playGlitchSound();
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

    // Brightness dips — use overlay instead of CSS filter
    setInterval(() => {
        if (Math.random() > 0.88 && flickerEffect) {
            const brightness = 0.3 + Math.random() * 0.4;
            flickerEffect._setBrightness(brightness);
            setTimeout(() => flickerEffect._clearBrightness(), 60 + Math.random() * 100);
        }
    }, 3000);

    // Static intensity fluctuation
    setInterval(() => {
        if (staticEffect.running) {
            const base = 0.06;
            const variance = Math.random() * 0.04;
            staticEffect.setIntensity(base + variance);
        }
    }, 500);

    // Channel roll (rare but dramatic — transform is safe)
    setInterval(() => {
        if (Math.random() > 0.95) {
            const app = document.getElementById('app');
            const rollAmount = 30 + Math.random() * 60;
            app.style.transition = 'none';
            app.style.transform = `translateY(${rollAmount}px)`;
            if (typeof playGlitchSound === 'function') playGlitchSound();
            setTimeout(() => {
                app.style.transition = 'transform 0.2s ease-out';
                app.style.transform = '';
                setTimeout(() => { app.style.transition = ''; }, 250);
            }, 80);
        }
    }, 8000);
});
