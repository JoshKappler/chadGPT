/**
 * CRT Post-Processing Overlay
 *
 * Fullscreen WebGL canvas that renders CRT "glass" effects on top of all content:
 *   - RGB phosphor shadow mask (visible sub-pixel dot pattern)
 *   - Scanlines with subtle wobble
 *   - Barrel distortion vignette (simulates curved tube glass)
 *   - Chromatic aberration at screen edges
 *   - Screen curvature darkening
 *   - Subtle horizontal color bleed
 *
 * The canvas uses pointer-events:none and composites via CSS blend mode.
 * It does NOT capture or distort page content — it renders patterns that
 * create the illusion of curved CRT glass when layered on top.
 */

var crtOverlay = (function() {
    'use strict';

    var canvas, gl, program, vao;
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
    // This is a pure OVERLAY — it darkens and tints but never masks content.
    // Actual screen curvature is handled by an SVG displacement filter on the DOM.
    var FRAG_SRC = [
        'precision mediump float;',
        'uniform vec2 uResolution;',
        'uniform float uTime;',
        '',
        'void main() {',
        '    vec2 uv = gl_FragCoord.xy / uResolution;',
        '    uv.y = 1.0 - uv.y;',
        '    vec2 px = uv * uResolution;',
        '',
        '    float alpha = 0.0;',
        '    vec3 color = vec3(0.0);',
        '',
        '    // --- Scanlines ---',
        '    // Every 3rd pixel row darkens. Slight horizontal wobble over time.',
        '    float scanY = px.y + sin(uTime * 0.3 + uv.x * 3.0) * 0.5;',
        '    float scanPhase = mod(scanY, 3.0) / 3.0;',
        '    float scanline = smoothstep(0.4, 0.6, scanPhase) * 0.18;',
        '',
        '    // --- RGB Phosphor Shadow Mask ---',
        '    // Triangular shadow mask: RGB dot triads offset every other row.',
        '    float maskScale = 3.0;',
        '    float row = floor(px.y / maskScale);',
        '    float xOffset = mod(row, 2.0) * maskScale * 1.5;',
        '    float subPixel = mod(px.x + xOffset, maskScale * 3.0);',
        '',
        '    vec3 phosphor;',
        '    if (subPixel < maskScale) {',
        '        phosphor = vec3(1.0, 0.15, 0.15);',
        '    } else if (subPixel < maskScale * 2.0) {',
        '        phosphor = vec3(0.15, 1.0, 0.15);',
        '    } else {',
        '        phosphor = vec3(0.15, 0.15, 1.0);',
        '    }',
        '',
        '    // Soften phosphor edges',
        '    float withinSub = mod(subPixel, maskScale);',
        '    float pEdge = smoothstep(0.0, 1.2, withinSub) * smoothstep(maskScale, maskScale - 1.2, withinSub);',
        '    phosphor = mix(vec3(0.4), phosphor, pEdge * 0.65 + 0.35);',
        '',
        '    // --- CRT tube vignette ---',
        '    // Barrel-shaped darkening: stronger at corners, follows curved glass profile.',
        '    vec2 centered = uv - 0.5;',
        '    // Barrel curve: r^2 + r^4 gives the characteristic CRT falloff',
        '    float r2 = dot(centered, centered);',
        '    float barrel = r2 + r2 * r2 * 0.6;',
        '    float vig = 1.0 - barrel * 2.2;',
        '    vig = clamp(vig, 0.0, 1.0);',
        '    vig = pow(vig, 0.7);',
        '    float cornerDark = pow(1.0 - vig, 2.0) * 0.55;',
        '',
        '    // --- Chromatic aberration at edges ---',
        '    float edgeDist = length(centered) * 2.0;',
        '    float chroma = smoothstep(0.5, 1.0, edgeDist) * 0.006;',
        '',
        '    // --- Combine ---',
        '    float phosphorLum = (phosphor.r + phosphor.g + phosphor.b) / 3.0;',
        '    float phosphorDark = mix(1.0, phosphorLum, 0.15);',
        '',
        '    alpha = (1.0 - phosphorDark) + scanline + cornerDark;',
        '    alpha = clamp(alpha, 0.0, 0.65);',
        '',
        '    // Phosphor color tint',
        '    color = (vec3(1.0) - phosphor) * 0.03;',
        '',
        '    // Chromatic aberration fringe',
        '    color.r += chroma * 3.0;',
        '    color.b += chroma * 2.0;',
        '',
        '    // --- Interlace shimmer ---',
        '    float interlace = mod(floor(px.y) + floor(uTime * 30.0), 2.0);',
        '    alpha += interlace * 0.008;',
        '',
        '    // --- Subtle vertical hold breathing ---',
        '    float breathe = sin(uTime * 0.7) * 0.002 + sin(uTime * 1.3 + uv.y * 6.0) * 0.001;',
        '    alpha += abs(breathe) * 0.2;',
        '',
        '    gl_FragColor = vec4(color, alpha);',
        '}',
    ].join('\n');

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
