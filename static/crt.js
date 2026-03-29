/**
 * CRT Post-Processing Overlay
 *
 * Fullscreen WebGL canvas that renders CRT "glass" effects on top of all content:
 *   - RGB phosphor dot pattern (round dots with dark gaps)
 *   - Heavy scanlines with wobble
 *   - Strong barrel-curve vignette (simulates curved tube glass)
 *   - Visible chromatic aberration at screen edges
 *   - Interlace shimmer and vertical hold breathing
 *
 * The canvas uses pointer-events:none and composites via alpha blending.
 * It does NOT capture or distort page content — it renders patterns that
 * create the illusion of old CRT glass when layered on top.
 */

var crtOverlay = (function() {
    'use strict';

    var canvas, gl, program;
    var uTime, uResolution;
    var startTime = Date.now();
    var _animFrame = null;
    var _enabled = true;

    // ---- Shaders ----

    var VERT_SRC = [
        'attribute vec2 aPos;',
        'void main() {',
        '    gl_Position = vec4(aPos, 0.0, 1.0);',
        '}',
    ].join('\n');

    // Fragment shader: all CRT effects in one pass.
    // Pure overlay — darkens and tints content underneath.
    var FRAG_SRC = `
precision mediump float;
uniform vec2 uResolution;
uniform float uTime;

void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    uv.y = 1.0 - uv.y;
    vec2 px = uv * uResolution;

    float alpha = 0.0;
    vec3 color = vec3(0.0);

    // --- Scanlines (heavy, clearly visible) ---
    float scanY = px.y + sin(uTime * 0.4 + uv.x * 4.0) * 0.8;
    float scanPhase = mod(scanY, 3.0) / 3.0;
    float scanline = smoothstep(0.3, 0.7, scanPhase) * 0.28;

    // --- RGB Phosphor Shadow Mask (round dots with dark gaps) ---
    float maskScale = 4.0; // 4px per dot = chunkier, more visible
    float row = floor(px.y / maskScale);
    float xOffset = mod(row, 2.0) * maskScale * 1.5;
    float subPixel = mod(px.x + xOffset, maskScale * 3.0);

    // Which sub-pixel color
    vec3 phosphor;
    if (subPixel < maskScale) {
        phosphor = vec3(1.0, 0.0, 0.0);
    } else if (subPixel < maskScale * 2.0) {
        phosphor = vec3(0.0, 1.0, 0.0);
    } else {
        phosphor = vec3(0.0, 0.0, 1.0);
    }

    // Round dot shape — dark gaps between phosphor dots
    float withinSubX = mod(subPixel, maskScale);
    float withinSubY = mod(px.y, maskScale);
    float dx = withinSubX / maskScale - 0.5;
    float dy = withinSubY / maskScale - 0.5;
    float dotDist = sqrt(dx * dx + dy * dy);
    float dotMask = 1.0 - smoothstep(0.28, 0.48, dotDist);
    phosphor *= dotMask;

    // --- CRT tube vignette (strong barrel-curve edge darkening) ---
    vec2 centered = uv - 0.5;
    float r2 = dot(centered, centered);
    float barrel = r2 + r2 * r2 * 0.8;
    float vig = 1.0 - barrel * 3.5;
    vig = clamp(vig, 0.0, 1.0);
    vig = pow(vig, 0.5);
    float cornerDark = pow(1.0 - vig, 1.6) * 0.9;

    // --- Chromatic aberration (visible color fringing at edges) ---
    float edgeDist = length(centered) * 2.0;
    float chroma = smoothstep(0.25, 0.85, edgeDist);

    // --- Combine ---
    // Phosphor: darken where dots are off (gaps between round dots)
    float phosphorLum = (phosphor.r + phosphor.g + phosphor.b) / 3.0;
    float phosphorDark = (1.0 - phosphorLum) * 0.25;

    alpha = phosphorDark + scanline + cornerDark;
    alpha = clamp(alpha, 0.0, 0.88);

    // Chromatic aberration: visible red/cyan fringe at screen edges
    color.r += chroma * 0.08;
    color.b += chroma * 0.05;

    // Phosphor color tint (subtle color cast from dot pattern)
    color += (vec3(1.0) - phosphor) * 0.015;

    // --- Interlace shimmer (every other line flickers) ---
    float interlace = mod(floor(px.y) + floor(uTime * 30.0), 2.0);
    alpha += interlace * 0.025;

    // --- Vertical hold breathing (screen subtly wobbles) ---
    float breathe = sin(uTime * 0.5) * 0.004 + sin(uTime * 1.1 + uv.y * 8.0) * 0.002;
    alpha += abs(breathe) * 0.4;

    gl_FragColor = vec4(color, alpha);
}
`;

    // ---- WebGL setup ----

    function initGL() {
        canvas = document.createElement('canvas');
        canvas.id = 'crt-overlay';
        canvas.style.cssText = [
            'position:absolute',
            'top:0', 'left:0',
            'width:100%', 'height:100%',
            'pointer-events:none',
            'z-index:1001',   // above static overlay (1000) but below glitch temps
        ].join(';');

        var screen = document.getElementById('crt-screen');
        if (!screen) return false;
        screen.appendChild(canvas);

        gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
        if (!gl) {
            console.warn('[CRT] WebGL not available');
            return false;
        }

        // Compile shaders
        var vs = compileShader(gl.VERTEX_SHADER, VERT_SRC);
        var fs = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
        if (!vs || !fs) return false;

        program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('[CRT] Link error:', gl.getProgramInfoLog(program));
            return false;
        }

        gl.useProgram(program);

        // Fullscreen quad
        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1,  1, -1,  -1, 1,
            -1,  1,  1, -1,   1, 1,
        ]), gl.STATIC_DRAW);

        var aPos = gl.getAttribLocation(program, 'aPos');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        uTime = gl.getUniformLocation(program, 'uTime');
        uResolution = gl.getUniformLocation(program, 'uResolution');

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        resize();
        window.addEventListener('resize', resize);

        return true;
    }

    function compileShader(type, src) {
        var s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error('[CRT] Shader error:', gl.getShaderInfoLog(s));
            return null;
        }
        return s;
    }

    function resize() {
        if (!canvas) return;
        var dpr = window.devicePixelRatio || 1;
        var w = canvas.clientWidth * dpr;
        var h = canvas.clientHeight * dpr;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
    }

    // ---- Render loop ----

    function render() {
        if (!_enabled || !gl) return;
        _animFrame = requestAnimationFrame(render);

        resize();
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(uTime, (Date.now() - startTime) / 1000.0);
        gl.uniform2f(uResolution, canvas.width, canvas.height);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // ---- Public API ----

    function start() {
        if (_animFrame) return;
        _enabled = true;
        if (!gl && !initGL()) return;
        render();
    }

    function stop() {
        _enabled = false;
        if (_animFrame) {
            cancelAnimationFrame(_animFrame);
            _animFrame = null;
        }
    }

    function setEnabled(val) {
        _enabled = !!val;
        if (_enabled && !_animFrame) start();
        if (!_enabled) stop();
    }

    return {
        start: start,
        stop: stop,
        setEnabled: setEnabled,
    };
})();
