// ChadGPT 3D Head - Michelangelo's David

class ChadAvatar {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.isTalking = false;
        this.mood = 'dormant';
        this.headMesh = null;
        this.allMeshes = [];
        this.statusEl = document.getElementById('avatar-status');
        this.wakeRequested = false;
        this.modelLoaded = false;

        if (!this.container) { console.error('CHAD3D: no container'); return; }
        if (typeof THREE === 'undefined') { console.error('CHAD3D: THREE not loaded'); return; }
        if (typeof THREE.GLTFLoader === 'undefined') { console.error('CHAD3D: GLTFLoader not loaded'); return; }

        console.log('CHAD3D: init, THREE r' + THREE.REVISION);
        this.initScene();
        this.loadHead();
        this.animate();
    }

    _log(msg) {
        console.log('CHAD3D: ' + msg);
        if (this.statusEl) this.statusEl.textContent = '[ ' + msg + ' ]';
    }

    initScene() {
        this.scene = new THREE.Scene();
        const rect = this.container.getBoundingClientRect();
        const w = Math.max(Math.round(rect.width), 100);
        const h = Math.max(Math.round(rect.height), 100);
        console.log('CHAD3D: container', w, 'x', h);

        this.camera = new THREE.PerspectiveCamera(40, w / h, 0.01, 500);
        this.camera.position.set(0, 0, 5.5);
        this.camera.lookAt(0, 0, 0);

        // CRITICAL: alpha must be false — CSS overlay blend modes make transparent canvases invisible
        this.renderer = new THREE.WebGLRenderer({ alpha: false, antialias: true });
        this.renderer.setSize(w, h);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        // Start with bright green to prove canvas is visible, then switch to dark
        this.renderer.setClearColor(0x003300, 1);
        this.container.appendChild(this.renderer.domElement);

        // Ensure canvas fills container properly
        this.renderer.domElement.style.display = 'block';
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';

        // Delayed resize to handle flex layout timing
        setTimeout(() => this.onResize(), 100);
        setTimeout(() => this.onResize(), 500);

        this.headGroup = new THREE.Group();
        this.scene.add(this.headGroup);

        // Strong green lighting from multiple angles
        this.scene.add(new THREE.AmbientLight(0x004400, 0.8));
        const key = new THREE.DirectionalLight(0x00ff41, 2.0);
        key.position.set(-3, 5, 8);
        this.scene.add(key);
        const fill = new THREE.DirectionalLight(0x00cc33, 1.0);
        fill.position.set(5, -2, 4);
        this.scene.add(fill);
        const back = new THREE.PointLight(0x00ff41, 1.5, 50);
        back.position.set(0, 2, -5);
        this.scene.add(back);

        window.addEventListener('resize', () => this.onResize());
    }

    loadHead() {
        const loader = new THREE.GLTFLoader();
        this._log('loading...');

        loader.load('/static/head.glb',
            (gltf) => {
                console.log('CHAD3D: GLB loaded, children:', gltf.scene.children.length);
                try {
                    this.setupModel(gltf.scene);
                } catch (e) {
                    console.error('CHAD3D: setupModel CRASHED:', e, e.stack);
                    this._log('SETUP ERROR: ' + e.message);
                }
            },
            (xhr) => {
                if (xhr.total > 0) {
                    const pct = Math.round(xhr.loaded / xhr.total * 100);
                    if (pct === 50 || pct === 100) this._log('load ' + pct + '%');
                }
            },
            (err) => {
                console.error('CHAD3D: GLB load error:', err);
                this._log('LOAD ERROR');
            }
        );
    }

    setupModel(model) {
        const material = new THREE.MeshPhongMaterial({
            color: 0x00aa2a,
            emissive: 0x003300,
            specular: 0x44ff66,
            shininess: 90,
            transparent: true,
            opacity: 0.85,
            side: THREE.DoubleSide,
        });

        let meshCount = 0;
        model.traverse((node) => {
            if (node.isMesh) {
                node.geometry.computeVertexNormals();
                node.material = material.clone();
                this.allMeshes.push(node);
                if (!this.headMesh) this.headMesh = node;
                meshCount++;
            }
        });

        console.log('CHAD3D:', meshCount, 'meshes found');
        if (meshCount === 0) { this._log('NO MESHES'); return; }

        // Add model to headGroup
        this.headGroup.add(model);

        // CRITICAL: Update world matrices from the SCENE ROOT
        // This ensures the entire parent chain is fresh before we compute bounds
        this.scene.updateMatrixWorld(true);

        // Log the mesh node's world matrix to verify transforms are applied
        if (this.headMesh) {
            const m = this.headMesh.matrixWorld.elements;
            console.log('CHAD3D: mesh matrixWorld diagonal:', m[0].toFixed(6), m[5].toFixed(6), m[10].toFixed(6));
            console.log('CHAD3D: mesh matrixWorld translation:', m[12].toFixed(3), m[13].toFixed(3), m[14].toFixed(3));
            // If diagonal is ~1.0 and translation is ~0, transforms NOT applied (identity matrix)
            // If diagonal is ~0.003 and translation is ~(7, -30, 175), transforms ARE applied
            const isIdentity = Math.abs(m[0] - 1) < 0.01 && Math.abs(m[5] - 1) < 0.01;
            if (isIdentity) {
                console.warn('CHAD3D: WARNING - mesh worldMatrix appears to be IDENTITY! Transforms may not be applied.');
            }
        }

        // Compute bounding box via MANUAL vertex traversal
        // (more reliable than Box3.setFromObject across Three.js versions)
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        const _v = new THREE.Vector3();
        let vtxCount = 0;

        model.traverse((node) => {
            if (node.isMesh && node.geometry.attributes.position) {
                const pos = node.geometry.attributes.position;
                for (let i = 0; i < pos.count; i++) {
                    _v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
                    _v.applyMatrix4(node.matrixWorld);
                    if (_v.x < minX) minX = _v.x;
                    if (_v.y < minY) minY = _v.y;
                    if (_v.z < minZ) minZ = _v.z;
                    if (_v.x > maxX) maxX = _v.x;
                    if (_v.y > maxY) maxY = _v.y;
                    if (_v.z > maxZ) maxZ = _v.z;
                    vtxCount++;
                }
            }
        });

        console.log('CHAD3D: traversed', vtxCount, 'vertices');

        let cx, cy, cz, sizeX, sizeY, sizeZ, maxDim;
        let usedFallback = false;

        if (vtxCount > 0 && isFinite(minX) && isFinite(maxX)) {
            cx = (minX + maxX) / 2;
            cy = (minY + maxY) / 2;
            cz = (minZ + maxZ) / 2;
            sizeX = maxX - minX;
            sizeY = maxY - minY;
            sizeZ = maxZ - minZ;
            maxDim = Math.max(sizeX, sizeY, sizeZ);
            console.log('CHAD3D: bbox min:', minX.toFixed(3), minY.toFixed(3), minZ.toFixed(3));
            console.log('CHAD3D: bbox max:', maxX.toFixed(3), maxY.toFixed(3), maxZ.toFixed(3));
            console.log('CHAD3D: bbox center:', cx.toFixed(3), cy.toFixed(3), cz.toFixed(3));
            console.log('CHAD3D: bbox size:', sizeX.toFixed(3), sizeY.toFixed(3), sizeZ.toFixed(3));
            console.log('CHAD3D: maxDim:', maxDim.toFixed(4));
        }

        // Fallback to HARDCODED values from GLB binary analysis
        // The Sketchfab head.glb has a root node matrix that places the model at:
        //   center ≈ (7.28, -30.31, 175.39) with size ≈ (0.49, 0.68, 0.50)
        if (!maxDim || maxDim < 0.001 || !isFinite(maxDim)) {
            console.warn('CHAD3D: dynamic bbox FAILED, using hardcoded fallback');
            cx = 7.283; cy = -30.308; cz = 175.391;
            sizeX = 0.49; sizeY = 0.68; sizeZ = 0.50;
            maxDim = 0.68;
            usedFallback = true;
        }

        // If the bounding box center is near origin and size is huge (>100),
        // the world matrix was identity (transforms not applied).
        // In that case, the raw mesh spans (-0.02, -200, 0.01) to (133, -0.03, 138).
        // We still center and scale it, just with different values.
        if (maxDim > 100) {
            console.log('CHAD3D: large maxDim detected — raw mesh coordinates (transforms not applied)');
            // This is fine — we'll center and scale the raw mesh
        }

        // Scale to fill ~3.0 units in view
        const targetSize = 3.0;
        const s = targetSize / maxDim;

        // Center the model at origin
        model.position.set(-cx, -cy, -cz);
        model.position.y += sizeY * 0.05; // nudge face up slightly
        this.headGroup.scale.set(s, s, s);

        // Camera
        this.camera.position.set(0, 0.2, 5.5);
        this.camera.lookAt(0, 0, 0);
        this.camera.updateProjectionMatrix();

        // Rotation to face camera
        // The Sketchfab David's root node includes a ~180° X rotation.
        // After that rotation, the face points along +Z if the raw face was along -Z,
        // or along -Z if the raw face was along +Z.
        // Math.PI around Y flips between these. We try PI first.
        // If the user sees the back of the head, change to 0.
        this.headGroup.rotation.y = 0;

        console.log('CHAD3D: === SETUP COMPLETE ===');
        console.log('CHAD3D: scale:', s.toFixed(4), 'fallback:', usedFallback);
        console.log('CHAD3D: model.position:', model.position.x.toFixed(2), model.position.y.toFixed(2), model.position.z.toFixed(2));

        this.modelLoaded = true;

        // Handle wake timing: if wake() was called before model finished loading,
        // go directly to full opacity instead of staying dim
        if (this.wakeRequested) {
            console.log('CHAD3D: wake was already requested, applying full opacity');
            this.setOpacity(1);
            this.mood = 'annoyed';
            if (this.statusEl) {
                this.statusEl.textContent = '[ ONLINE — IRRITATED ]';
                this.statusEl.style.color = '#00ff41';
            }
        } else {
            // Dormant: 35% opacity (was 15%, too dim with overlays)
            this.setOpacity(0.35);
        }

        this._log('READY');
    }

    setOpacity(factor) {
        const f = Math.max(factor, 0.08);
        for (const mesh of this.allMeshes) {
            mesh.material.opacity = 0.85 * f;
            mesh.material.emissive.setRGB(0, 0.13 * f, 0);
        }
    }

    startTalking() {
        this.isTalking = true;
        this.mood = 'talking';
        if (this.statusEl) {
            this.statusEl.textContent = '[ SPEAKING ]';
            this.statusEl.style.color = '#00ff41';
        }
    }

    stopTalking() {
        this.isTalking = false;
        this.mood = 'annoyed';
        if (this.statusEl) this.statusEl.textContent = '[ ANNOYED ]';
    }

    wake() {
        this.wakeRequested = true;
        this.mood = 'annoyed';

        if (!this.modelLoaded || this.allMeshes.length === 0) {
            // Model hasn't loaded yet — setupModel will check wakeRequested
            console.log('CHAD3D: wake() deferred (model not loaded yet)');
            return;
        }

        this._log('waking up');
        let p = 0;
        const fadeIn = () => {
            p += 0.025;
            if (p >= 1) {
                this.setOpacity(1);
                if (this.statusEl) {
                    this.statusEl.textContent = '[ ONLINE — IRRITATED ]';
                    this.statusEl.style.color = '#00ff41';
                }
                return;
            }
            this.setOpacity(p);
            requestAnimationFrame(fadeIn);
        };
        fadeIn();
    }

    sleep() {
        this.mood = 'dormant';
        this.isTalking = false;
        this.wakeRequested = false;
        this.setOpacity(0.35);
        if (this.statusEl) {
            this.statusEl.textContent = '[ DORMANT ]';
            this.statusEl.style.color = '#004d00';
        }
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        if (!this.renderer) return;
        const t = Date.now() * 0.001;

        const baseY = 0;
        if (this.mood !== 'dormant') {
            this.headGroup.rotation.y = baseY + Math.sin(t * 0.3) * 0.1;
            this.headGroup.rotation.x = Math.sin(t * 0.2) * 0.02;
        } else {
            // Wider dormant oscillation so user can confirm head exists
            this.headGroup.rotation.y = baseY + Math.sin(t * 0.1) * 0.2;
            this.headGroup.rotation.x = 0;
        }

        if (this.allMeshes.length > 0) {
            if (this.mood === 'talking') {
                const pulse = Math.sin(t * 6) * 0.2 + 0.8;
                for (const m of this.allMeshes) {
                    m.material.emissive.setRGB(0, 0.05 + pulse * 0.15, 0);
                    m.material.opacity = 0.75 + pulse * 0.12;
                }
                this.headGroup.rotation.x = Math.sin(t * 8) * 0.01 + Math.sin(t * 0.2) * 0.02;
            } else if (this.mood === 'annoyed') {
                for (const m of this.allMeshes) {
                    m.material.emissive.setRGB(0, 0.13, 0);
                    m.material.opacity = 0.85;
                }
            }
        }

        this.renderer.render(this.scene, this.camera);
    }

    onResize() {
        if (!this.container || !this.renderer || !this.camera) return;
        const rect = this.container.getBoundingClientRect();
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        if (w > 10 && h > 10) {
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(w, h);
        }
    }
}

let chadAvatar;

// Initialize immediately — script is at bottom of body so DOM is ready
// Also add DOMContentLoaded fallback in case it hasn't fired yet
function initChad() {
    if (chadAvatar) return; // already initialized
    const el = document.getElementById('three-container');
    if (!el) {
        console.error('CHAD3D: three-container not found!');
        return;
    }
    try {
        chadAvatar = new ChadAvatar('three-container');
    } catch (e) {
        console.error('CHAD3D FATAL:', e);
        const s = document.getElementById('avatar-status');
        if (s) s.textContent = '[ FATAL: ' + e.message + ' ]';
    }
}

// Try immediately
initChad();
// Fallback: try again on DOMContentLoaded
document.addEventListener('DOMContentLoaded', initChad);
// Last resort: try on window load
window.addEventListener('load', initChad);
