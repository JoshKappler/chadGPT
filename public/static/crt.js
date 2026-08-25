/**
 * CRT Post-Processing Overlay
 *
 * Fullscreen WebGL canvas rendering CRT glass effects on top of all content:
 * scanlines, phosphor dot grid, vignette darkening, interlace shimmer.
 * Pure alpha overlay — only darkens, never adds color.
 */

var crtOverlay = (function() {
    'use strict';

    var canvas, gl, program;
    var uTime, uResolution;
    var startTime = Date.now();
    var _animFrame = null;
    var _enabled = true;

    var VERT_SRC = 'attribute vec2 a;void main(){gl_Position=vec4(a,0,1);}';

    var FRAG_SRC = `
precision mediump float;
uniform vec2 uRes;
uniform float uTime;

void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    uv.y = 1.0 - uv.y;
    vec2 px = uv * uRes;

    // Scanlines: every 2px, 1px dark band
    float scanY = px.y + sin(uTime * 0.3 + uv.x * 5.0) * 0.4;
    float scan = step(1.0, mod(scanY, 2.0)) * 0.13;

    // Phosphor gap grid: thin dark lines at 3px pitch
    float pitch = 3.0;
    float pRow = floor(px.y / pitch);
    float gx = step(pitch - 0.6, mod(px.x + mod(pRow, 2.0) * pitch * 0.5, pitch));
    float gy = step(pitch - 0.6, mod(px.y, pitch));
    float phosphor = (gx + gy) * 0.05;

    // Vignette: barrel-curve darkening
    vec2 c = uv - 0.5;
    float r2 = dot(c, c);
    float v = r2 * 1.8 + r2 * r2 * 2.5;
    float vig = pow(clamp(v, 0.0, 1.0), 0.8) * 0.65;

    // Interlace shimmer
    float interlace = mod(floor(px.y) + floor(uTime * 25.0), 2.0) * 0.01;

    float dark = scan + phosphor + vig + interlace;
    gl_FragColor = vec4(0.0, 0.0, 0.0, clamp(dark, 0.0, 0.9));
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
        if (!gl) return false;

        var vs = compile(gl.VERTEX_SHADER, VERT_SRC);
        var fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
        if (!vs || !fs) return false;

        program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
        gl.useProgram(program);

        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1
        ]), gl.STATIC_DRAW);
        var a = gl.getAttribLocation(program, 'a');
        gl.enableVertexAttribArray(a);
        gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);

        uTime = gl.getUniformLocation(program, 'uTime');
        uResolution = gl.getUniformLocation(program, 'uRes');

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
            console.error('[CRT]', gl.getShaderInfoLog(s));
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
