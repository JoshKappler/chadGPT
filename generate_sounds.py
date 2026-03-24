#!/usr/bin/env python3
"""Generate sound effects for ChadGPT."""
import numpy as np
import struct

def write_wav(filename, samples, sample_rate=44100):
    samples = np.clip(samples, -1, 1)
    int_samples = (samples * 32767).astype(np.int16)
    data_size = len(int_samples) * 2
    with open(filename, 'wb') as f:
        f.write(b'RIFF')
        f.write(struct.pack('<I', 36 + data_size))
        f.write(b'WAVE')
        f.write(b'fmt ')
        f.write(struct.pack('<IHHIIHH', 16, 1, 1, sample_rate, sample_rate * 2, 2, 16))
        f.write(b'data')
        f.write(struct.pack('<I', data_size))
        f.write(int_samples.tobytes())

def generate_boot_sound():
    sr = 44100
    n = int(sr * 5.5)
    t = np.arange(n) / sr
    audio = np.zeros(n)
    rng = np.random.RandomState(42)

    # HEAVY BREAKER CLUNK
    env = np.exp(-t * 15) * (t < 0.3)
    audio += rng.randn(n) * env * 0.7
    audio += np.sin(t * 80 * 2 * np.pi) * env * 0.5

    # ELECTRICAL SURGE
    m2 = (t > 0.08) & (t < 0.5)
    t2 = np.where(m2, t - 0.08, 0)
    audio += rng.randn(n) * np.exp(-t2 * 8) * m2 * 0.35

    # FAN SPIN-UP
    m3 = (t > 0.3) & (t < 5.0)
    t3 = np.where(m3, (t - 0.3) / 4.7, 0)
    freq_fan = 3 + t3 * 55
    phase_fan = np.cumsum(freq_fan / sr * m3) * 2 * np.pi
    audio += (np.sin(phase_fan) * 0.3 + rng.randn(n) * 0.1) * t3 * 0.3 * m3

    # ASCENDING POWER TONES
    for i, freq in enumerate([60, 120, 240, 480, 960]):
        start = 0.4 + i * 0.3
        m = (t > start) & (t < start + 1.5)
        tt = np.where(m, t - start, 0)
        env_t = np.where(tt < 0.12, tt / 0.12,
                np.where(tt < 0.5, 1.0, np.exp(-(tt - 0.5) * 3))) * m
        ramp = np.minimum(tt / 0.5, 1.0)
        f = freq * 0.4 + freq * 0.6 * ramp
        phase = np.cumsum(f / sr * m) * 2 * np.pi
        audio += np.sin(phase) * env_t * (0.1 / (i * 0.5 + 1))

    # CAPACITOR WHINE
    m5 = (t > 0.8) & (t < 4.0)
    t5 = np.where(m5, t - 0.8, 0)
    cap_f = 1500 * np.power(6.0, np.minimum(t5 / 3.2, 1.0))
    cap_phase = np.cumsum(cap_f / sr * m5) * 2 * np.pi
    cap_env = np.where(t5 < 0.7, t5 / 0.7,
              np.where(t5 < 2.5, 1.0, np.exp(-(t5 - 2.5) * 3))) * m5
    audio += np.sin(cap_phase) * cap_env * 0.04

    # TESLA COIL ARCS / SPARKS
    for _ in range(14):
        at = 0.6 + rng.random() * 3.5
        al = 0.006 + rng.random() * 0.04
        ma = (t > at) & (t < at + al)
        ta = np.where(ma, t - at, 0)
        audio += rng.randn(n) * np.exp(-ta / al * 3) * ma * (0.3 + rng.random() * 0.3)

    # TRANSFORMER HUM
    m7 = (t > 0.3) & (t < 5.0)
    t7 = np.where(m7, t - 0.3, 0)
    hum_env = np.minimum(t7 / 1.2, 1.0) * np.where(t7 > 4.2, np.exp(-(t7 - 4.2) * 3), 1.0) * m7
    audio += (np.sin(t * 60 * 2 * np.pi) * 0.06 + np.sin(t * 120 * 2 * np.pi) * 0.03) * hum_env

    # RELAY CLICKS
    for ct in [0.5, 0.9, 1.4, 2.0, 2.8, 3.5, 4.2]:
        mc = (t > ct) & (t < ct + 0.02)
        tc = np.where(mc, t - ct, 0)
        audio += rng.randn(n) * np.exp(-tc * 80) * mc * 0.45

    # BUZZING (intermittent electrical buzz)
    for bz_start in [1.5, 2.5, 3.8]:
        bz_dur = 0.15 + rng.random() * 0.3
        mb = (t > bz_start) & (t < bz_start + bz_dur)
        tb = np.where(mb, t - bz_start, 0)
        buzz = np.sin(tb * 120 * 2 * np.pi) * 0.3 + rng.randn(n) * 0.1
        bz_env = np.where(tb < 0.02, tb / 0.02, np.where(tb > bz_dur - 0.02, (bz_dur - tb) / 0.02, 1.0)) * mb
        audio += buzz * bz_env * 0.2

    peak = np.max(np.abs(audio))
    if peak > 0:
        audio = audio / peak * 0.9
    return audio

def generate_shutdown_sound():
    sr = 44100
    n = int(sr * 2.5)
    t = np.arange(n) / sr
    audio = np.zeros(n)

    # Descending whine
    m1 = t < 2.0
    f_down = 600 * np.power(20 / 600, np.minimum(t / 2.0, 1.0))
    phase = np.cumsum(f_down / sr * m1) * 2 * np.pi
    audio += np.sin(phase) * np.maximum(1 - t / 2.2, 0) * m1 * 0.35

    # Fan spin-down
    m2 = (t > 0.15) & (t < 2.2)
    t2 = np.where(m2, (t - 0.15) / 2.05, 0)
    fan_f = 45 * (1 - t2)
    fan_phase = np.cumsum(np.where(m2, fan_f, 0) / sr) * 2 * np.pi
    audio += (np.sin(fan_phase) * 0.25 + np.random.randn(n) * 0.04) * (1 - t2) * m2 * 0.3

    # Relay clunk
    m3 = (t > 1.0) & (t < 1.25)
    t3 = np.where(m3, t - 1.0, 0)
    audio += np.random.randn(n) * np.exp(-t3 * 18) * m3 * 0.7

    peak = np.max(np.abs(audio))
    if peak > 0:
        audio = audio / peak * 0.9
    return audio

def generate_glitch_sound():
    """Short glitch/static burst for UI glitch effects."""
    sr = 44100
    n = int(sr * 0.15)
    t = np.arange(n) / sr
    rng = np.random.RandomState(77)

    audio = rng.randn(n) * np.exp(-t * 20) * 0.4
    audio += np.sin(t * 3000 * 2 * np.pi) * np.exp(-t * 30) * 0.2
    audio += np.sin(t * 60 * 2 * np.pi) * np.exp(-t * 15) * 0.15

    peak = np.max(np.abs(audio))
    if peak > 0:
        audio = audio / peak * 0.7
    return audio

if __name__ == '__main__':
    write_wav('static/boot.wav', generate_boot_sound())
    print('Generated static/boot.wav')
    write_wav('static/shutdown.wav', generate_shutdown_sound())
    print('Generated static/shutdown.wav')
    write_wav('static/glitch.wav', generate_glitch_sound())
    print('Generated static/glitch.wav')
