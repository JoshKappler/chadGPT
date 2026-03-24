// ChadGPT 3D Head — iframe bridge
// WebGL renders inside chad_head.html iframe (isolated from parent CSS/JS)
// This script sizes the iframe and provides the chadAvatar API

var chadAvatar = null;

(function() {
    var iframe = document.getElementById('chad-iframe');
    var container = document.getElementById('three-container');
    if (!iframe || !container) {
        console.error('CHAD3D bridge: missing iframe or container');
        return;
    }

    // Measure container and set EXPLICIT pixel dimensions on iframe
    // (CSS height:100% inside flex can be unreliable — explicit is safer)
    function sizeIframe() {
        var rect = container.getBoundingClientRect();
        var w = Math.round(rect.width);
        var h = Math.round(rect.height);
        if (w > 10 && h > 10) {
            iframe.style.width = w + 'px';
            iframe.style.height = h + 'px';
            // Also tell the iframe its real size so it can resize the renderer
            try {
                if (iframe.contentWindow) {
                    iframe.contentWindow.postMessage({cmd:'resize', w:w, h:h}, '*');
                }
            } catch(e) {}
        }
    }

    // Size immediately (layout should be computed since we're at bottom of body)
    sizeIframe();

    // Re-size on window resize
    window.addEventListener('resize', sizeIframe);

    // Poll a few times for flex layout settling
    setTimeout(sizeIframe, 100);
    setTimeout(sizeIframe, 300);
    setTimeout(sizeIframe, 1000);
    setTimeout(sizeIframe, 3000);

    // Also re-size when iframe loads (it might have been 0 initially)
    iframe.addEventListener('load', function() {
        sizeIframe();
        // Re-send size a bit later too
        setTimeout(sizeIframe, 200);
    });

    function send(cmd) {
        try {
            if (iframe.contentWindow) {
                iframe.contentWindow.postMessage({cmd: cmd}, '*');
            }
        } catch(e) {}
    }

    chadAvatar = {
        wake:         function() { send('wake'); },
        sleep:        function() { send('sleep'); },
        startTalking: function() { send('startTalking'); },
        stopTalking:  function() { send('stopTalking'); }
    };

    window.addEventListener('message', function(e) {
        if (e.data && e.data.type === 'chad3d-ready') {
            var s = document.getElementById('avatar-status');
            if (s) s.textContent = '[ READY ]';
            console.log('CHAD3D bridge: iframe ready');
        }
    });
})();
