#!/usr/bin/env node
/**
 * ChadGPT Dev Launcher
 * Boots Ollama, sets up Python venv, and launches the server.
 */

import { spawn, execSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import http from 'http';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const NC = '\x1b[0m';

function log(msg) { console.log(`${GREEN}${msg}${NC}`); }
function dim(msg) { console.log(`${DIM}${msg}${NC}`); }
function err(msg) { console.error(`${RED}${msg}${NC}`); }

function banner() {
    console.log(`
${GREEN}╔══════════════════════════════════════╗
║         C H A D G P T                ║
║   Cognitive Hostile Attitude Device  ║
║              v0.6.6.6                ║
╚══════════════════════════════════════╝${NC}
`);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function checkUrl(url, timeout = 2000) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout }, (res) => {
            resolve(true);
            res.resume();
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

async function waitForUrl(url, label, maxWait = 30000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        if (await checkUrl(url)) return true;
        await sleep(500);
    }
    return false;
}

function commandExists(cmd) {
    try {
        execSync(`which ${cmd}`, { stdio: 'ignore' });
        return true;
    } catch { return false; }
}

function killPort(port) {
    try {
        const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' }).trim();
        if (pids) {
            dim(`  Killing existing process on port ${port}...`);
            execSync(`kill -9 ${pids.split('\n').join(' ')}`, { stdio: 'ignore' });
            // Brief pause to let the OS release the port
            execSync('sleep 0.5', { stdio: 'ignore' });
        }
    } catch {
        // No process on that port, all good
    }
}

async function ensureOllama() {
    dim('[1/3] Checking Ollama...');

    if (!commandExists('ollama')) {
        err('ERROR: Ollama not installed. Install from https://ollama.ai');
        process.exit(1);
    }

    // Check if Ollama is already running
    const running = await checkUrl('http://localhost:11434/api/tags');
    if (running) {
        log('  Ollama already running.');
        return;
    }

    // Start Ollama
    dim('  Starting Ollama...');
    const ollama = spawn('ollama', ['serve'], {
        stdio: 'ignore',
        detached: true,
    });
    ollama.unref();

    const ready = await waitForUrl('http://localhost:11434/api/tags', 'Ollama', 15000);
    if (!ready) {
        err('ERROR: Ollama failed to start within 15s.');
        process.exit(1);
    }
    log('  Ollama is running.');
}

function ensurePython() {
    dim('[2/3] Setting up Python environment...');

    if (!existsSync('venv')) {
        dim('  Creating virtual environment...');
        execSync('python3 -m venv venv', { stdio: 'inherit' });
    }

    // Only run pip install if a marker file doesn't exist or requirements.txt is newer
    const markerPath = 'venv/.deps_installed';
    const needsInstall = !existsSync(markerPath) || (() => {
        try {
            return statSync('requirements.txt').mtimeMs > statSync(markerPath).mtimeMs;
        } catch { return true; }
    })();

    if (needsInstall) {
        dim('  Installing dependencies...');
        execSync('./venv/bin/pip install -q -r requirements.txt', { stdio: 'inherit' });
        // kokoro pulls misaki[en] which pulls spacy — install kokoro without transitive deps,
        // then install spacy from pre-built wheels only (blis won't compile on Python 3.13)
        execSync('./venv/bin/pip install -q --no-deps kokoro', { stdio: 'inherit' });
        execSync('./venv/bin/pip install -q --only-binary=:all: spacy', { stdio: 'inherit' });
        execSync('touch venv/.deps_installed');
    } else {
        dim('  Dependencies already installed.');
    }
    log('  Python environment ready.');
}

async function launchServer() {
    dim('[3/3] Launching ChadGPT server...');

    const server = spawn('./venv/bin/python', ['server.py'], {
        stdio: 'inherit',
        env: {
            ...process.env,
            HF_HUB_OFFLINE: '0',           // Allow HuggingFace downloads if needed
            TOKENIZERS_PARALLELISM: 'false', // Suppress tokenizer warnings
            PYTHONWARNINGS: 'ignore',        // Suppress Python warnings
        },
    });

    server.on('error', (e) => {
        err(`Server failed to start: ${e.message}`);
        process.exit(1);
    });

    server.on('exit', (code) => {
        if (code !== 0 && code !== null) {
            err(`Server exited with code ${code}`);
            process.exit(code);
        }
    });

    // Wait for server to be ready
    const ready = await waitForUrl('http://localhost:6969/api/status', 'Server', 15000);
    if (!ready) {
        err('Server did not respond in time.');
        process.exit(1);
    }

    console.log(`
${GREEN}═══════════════════════════════════════
  ChadGPT running at: ${BOLD}http://localhost:6969${NC}${GREEN}
  Flip the lever to wake him up.
  He's going to hate it.
═══════════════════════════════════════${NC}
`);

    // Handle shutdown
    const cleanup = () => {
        dim('\nShutting down ChadGPT...');
        server.kill();
        process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}

async function main() {
    banner();
    // Kill anything squatting on our port before we start
    killPort(6969);
    await ensureOllama();
    ensurePython();
    await launchServer();
}

main().catch((e) => {
    err(`Fatal: ${e.message}`);
    process.exit(1);
});
