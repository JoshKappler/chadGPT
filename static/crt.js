/**
 * CRT Post-Processing Overlay
 *
 * Fullscreen WebGL canvas rendering CRT glass effects on top of all content.
 * Pure alpha overlay — darkens only, never adds opaque color.
 */

var crtOverlay = (function() {
    'use strict';

    var canvas, gl, program;
    var uTime, uResolution;
    var startTime = Date.now();
    var _animFrame = null;
    var _enabled = true;

    var VERT_SRC = 'attribute vec2 aPos; void main(){gl_Position=vec4(aPos,0.0,1.0);}';

    var FRAG_SRC = `
precision mediump float;
uniform vec2 uResolution;
uniform float uTime;

void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    uv.y = 1.0 - uv.y;
    vec2 px = uv * uResolution;

    // ---- Scanlines ----
    // Every 2px: 1px lit, 1px dark. Slight wobble.
    float scanY = px.y + sin(uTime * 0.3 + uv.x * 5.0) * 0.4;
    float scanBand = mod(scanY, 2.0);
    float scanline = step(1.0, scanBand) * 0.15;

    // ---- Phosphor dot grid ----
    // Subtle RGB phosphor texture. Visible on close inspection but
    // doesn't obscure content. 3px pitch, triangular offset.
    float pitch = 3.0;
    float pRow = floor(px.y / pitch);
    float pOff = mod(pRow, 2.0) * pitch * 0.5;
    float pCol = mod(px.x + pOff, pitch * 3.0) / pitch;
    // Darken the gaps between phosphor columns
    float gapX = mod(px.x + pOff, pitch);
    float gapY = mod(px.y, pitch);
    float gap = step(pitch - 0.6, gapX) + step(pitch - 0.6, gapY);
    float phosphor = gap * 0.06;

    // ---- Vignette (dark edges, pure black) ----
    vec2 c = uv - 0.5;
    float r2 = dot(c, c);
    // Barrel-shaped: r^2 + r^4 for CRT curve profile
    float v = r2 * 1.8 + r2 * r2 * 2.5;
    float vignette = clamp(v, 0.0, 1.0);
    // Pow to shape the falloff — most of screen is clear, edges darken fast
    vignette = pow(vignette, 0.8) * 0.7;

    // ---- Combine: all effects are just darkening (black with alpha) ----
    float dark = scanline + phosphor + vignette;

    // Interlace: alternate lines shimmer very slightly
    float interlace = mod(floor(px.y) + floor(uTime * 25.0), 2.0) * 0.01;
    dark += interlace;

    dark = clamp(dark, 0.0, 0.92);

    // Output pure black with varying alpha — darkens the content underneath
    gl_FragColor = vec4(0.0, 0.0, 0.0, dark);
}
`;

    function initGL() {
        canvas = document.createElement('canvas');
        canvas.id = 'crt-overlay';
        canvas.style.cssText =
            'position:absolute;top:0;left:0;width:100%;height:100%;' +
            'pointer-events:none;z-index:1001';

        var screen = document.getElementById('crt-screen');
        if (!screen) return false;
        screen.appendChild(canvas);

        gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
        if (!gl) { console.warn('[CRT] WebGL not available'); return false; }

        var vs = compile(gl.VERTEX_SHADER, VERT_SRC);
        var fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
        if (!vs || !fs) return false;

        program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('[CRT] Link:', gl.getProgramInfoLog(program));
            return false;
        }
        gl.useProgram(program);

        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1
        ]), gl.STATIC_DRAW);
        var a = gl.getAttribLocation(program, 'aPos');
        gl.enableVertexAttribArray(a);
        gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);

        uTime = gl.getUniformLocation(program, 'uTime');
        uResolution = gl.getUniformLocation(program, 'uResolution');

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        resize();
        window.addEventListener('resize', resize);
        return true;
    }

    function compile(type, src) {
        var s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error('[CRT] Shader:', gl.getShaderInfoLog(s));
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

    return {
        start: function() {
            if (_animFrame) return;
            _enabled = true;
            if (!gl && !initGL()) return;
            render();
        },
        stop: function() {
            _enabled = false;
            if (_animFrame) { cancelAnimationFrame(_animFrame); _animFrame = null; }
        },
        setEnabled: function(v) {
            _enabled = !!v;
            if (_enabled && !_animFrame) this.start();
            if (!_enabled) this.stop();
        },
    };
})();
