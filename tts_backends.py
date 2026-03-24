"""TTS backend abstraction for ChadGPT."""
import io
import logging
import os
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path

logger = logging.getLogger("chadgpt")
tts_lock = threading.Lock()

# Pitch shift: semitones to lower the voice (positive = deeper)
PITCH_SHIFT_SEMITONES = 5


@contextmanager
def suppress_stdout():
    """Suppress stdout prints from noisy libraries."""
    old_stdout = sys.stdout
    sys.stdout = io.StringIO()
    try:
        yield
    finally:
        sys.stdout = old_stdout


def deepen_voice(audio_path: str, semitones: int = PITCH_SHIFT_SEMITONES):
    """Pitch-shift audio DOWN to make the voice deeper and gruffer.

    Uses resampling: stretches the waveform which lowers pitch and slows speech.
    This gives a natural deep/gravelly effect.
    """
    try:
        import numpy as np
        import soundfile as sf
        from scipy.signal import resample

        data, sr = sf.read(audio_path)
        if len(data) == 0:
            return

        # Stretch factor: >1 = slower and deeper
        stretch = 2 ** (semitones / 12)  # 5 semitones → ~1.335x stretch
        new_length = int(len(data) * stretch)
        shifted = resample(data, new_length)

        # Clip to prevent any artifacts
        shifted = np.clip(shifted, -1.0, 1.0)

        sf.write(audio_path, shifted.astype(np.float32), sr)
        logger.info(f"[TTS] Pitch shifted -{semitones} semitones ({len(data)} → {new_length} samples)")
    except Exception as e:
        logger.warning(f"[TTS] Pitch shift failed (non-fatal): {e}")

# Emotion presets: maps irritation level to voice instruct descriptions
# Short, punchy emotional directions work best with Qwen3-TTS CustomVoice.
EMOTION_PRESETS = [
    (0, 15, "Bored and dismissive. Monotone. Disdainful."),
    (16, 35, "Annoyed and contemptuous. Sneering. Mocking."),
    (36, 55, "Angry and hostile. Threatening. Through gritted teeth."),
    (56, 75, "Furious. Shouting with rage. Aggressive and intimidating."),
    (76, 100, "Screaming with unhinged fury. Explosive rage. Absolutely unhinged."),
]

def get_instruct(irritation: int, angry: bool = False) -> str:
    """Get voice instruct string from irritation level."""
    level = min(100, irritation + 30) if angry else irritation
    level = max(0, min(100, level))
    for lo, hi, instruct in EMOTION_PRESETS:
        if lo <= level <= hi:
            return instruct
    return EMOTION_PRESETS[-1][2]


class KokoroBackend:
    """Fast, flat Kokoro TTS. No real emotion."""

    def __init__(self):
        self.pipeline = None

    def init(self, lang_code='a'):
        try:
            from kokoro import KPipeline
            self.pipeline = KPipeline(lang_code=lang_code)
            # Warm up
            list(self.pipeline('test', voice='am_michael'))
            logger.info("Kokoro TTS loaded.")
            return True
        except Exception as e:
            logger.error(f"Kokoro failed: {e}")
            return False

    @property
    def ready(self):
        return self.pipeline is not None

    def synthesize(self, text: str, output_path: str, voice_config: dict, angry: bool = False) -> bool:
        if not self.ready:
            return False
        try:
            import numpy as np
            import soundfile as sf

            speed = voice_config.get("angry_speed", 0.85) if angry else voice_config.get("speed", 0.95)
            voice = voice_config.get("voice", "am_michael")
            t0 = time.time()
            with tts_lock:
                chunks = [audio for _, _, audio in self.pipeline(
                    text, voice=voice, speed=speed
                )]
            if not chunks:
                return False
            sf.write(output_path, np.concatenate(chunks), 24000)
            t_gen = time.time() - t0
            logger.info(f"[TTS:Kokoro] {len(text)} chars in {t_gen:.1f}s")
            return True
        except Exception as e:
            logger.error(f"[TTS:Kokoro] synth failed: {e}")
            return False


class Qwen3TTSBackend:
    """Qwen3-TTS via mlx-audio. Genuine emotional voice."""

    MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"

    def __init__(self):
        self.model = None
        self.model_id = self.MODEL_ID

    def init(self, model_id=None):
        if model_id:
            self.model_id = model_id
        try:
            from mlx_audio.tts.utils import load_model
            logger.info(f"Loading Qwen3-TTS: {self.model_id}...")
            self.model = load_model(model_path=self.model_id)
            logger.info("Qwen3-TTS loaded.")
            return True
        except Exception as e:
            logger.error(f"Qwen3-TTS failed: {e}")
            return False

    @property
    def ready(self):
        return self.model is not None

    def synthesize(self, text: str, output_path: str, voice_config: dict, angry: bool = False) -> bool:
        if not self.ready:
            return False
        try:
            import shutil
            import tempfile

            irritation = voice_config.get("chaos", 30)
            custom_instruct = voice_config.get("custom_instruct", "").strip()
            instruct = custom_instruct if custom_instruct else get_instruct(irritation, angry)

            logger.info(f"[TTS:Qwen3] instruct={instruct[:60]}... | voice={voice_config.get('qwen3_speaker','eric')} | {len(text)} chars")

            # generate_audio writes to a DIRECTORY, creating {dir}/{prefix}_0.wav
            tmp_dir = tempfile.mkdtemp(prefix="qwen3tts_")

            from mlx_audio.tts.generate import generate_audio
            speaker = voice_config.get("qwen3_speaker", "aiden")
            temp = voice_config.get("temperature", 0.9)
            t0 = time.time()
            with tts_lock, suppress_stdout():
                generate_audio(
                    text=text,
                    model=self.model,
                    instruct=instruct,
                    voice=speaker,
                    output_path=tmp_dir,
                    file_prefix="chad",
                    audio_format="wav",
                    verbose=False,
                    play=False,
                    temperature=temp,
                    max_tokens=2048,
                )
            t_gen = time.time() - t0
            logger.info(f"[TTS:Qwen3] generate_audio took {t_gen:.1f}s")

            # Find the generated wav file and move it to the expected output_path
            tmp_path = Path(tmp_dir)
            wavs = sorted(tmp_path.glob("*.wav"))
            if wavs:
                shutil.move(str(wavs[0]), output_path)
                shutil.rmtree(tmp_dir, ignore_errors=True)

                # Pitch-shift the voice DOWN to make it deeper and gruffer
                pitch = voice_config.get("pitch_shift", PITCH_SHIFT_SEMITONES)
                if pitch > 0:
                    deepen_voice(output_path, semitones=pitch)

                wav_size = Path(output_path).stat().st_size
                logger.info(f"[TTS:Qwen3] output: {wav_size/1024:.0f}KB WAV (pitch-shifted)")
                return True

            logger.error("[TTS:Qwen3] produced no output file")
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return False
        except Exception as e:
            logger.error(f"[TTS:Qwen3] synth failed: {e}")
            return False


class SayFallback:
    """macOS say command fallback."""

    @property
    def ready(self):
        return True

    def init(self):
        return True

    def synthesize(self, text: str, output_path: str, voice_config: dict, angry: bool = False) -> bool:
        try:
            rate = "160" if angry else "175"
            aiff_path = output_path.replace(".wav", ".aiff")
            subprocess.run(
                ["say", "-v", "Daniel", "-r", rate, "-o", aiff_path, text],
                check=True, timeout=30,
            )
            subprocess.run(
                ["afconvert", "-f", "WAVE", "-d", "LEI16", aiff_path, output_path],
                check=True, timeout=10,
            )
            Path(aiff_path).unlink(missing_ok=True)
            return True
        except Exception as e:
            logger.error(f"say fallback failed: {e}")
            return False
