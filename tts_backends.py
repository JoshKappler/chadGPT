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


def _build_atempo_chain(factor: float) -> str:
    """Build chained atempo filters since each is limited to 0.5-2.0."""
    parts = []
    remaining = factor
    while remaining > 2.0:
        parts.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        parts.append("atempo=0.5")
        remaining /= 0.5
    if abs(remaining - 1.0) > 0.001:
        parts.append(f"atempo={remaining:.6f}")
    return ",".join(parts) if parts else "atempo=1.0"


def deepen_voice(audio_path: str, semitones: int = PITCH_SHIFT_SEMITONES):
    """Pitch-shift audio without changing tempo using ffmpeg.

    Positive semitones = deeper voice.
    Negative semitones = higher voice.
    Uses asetrate to shift pitch, atempo to restore original tempo.
    """
    if semitones == 0:
        return
    tmp_path = audio_path + ".pitched.wav"
    try:
        import soundfile as sf
        data, sr = sf.read(audio_path)
        if len(data) == 0:
            return

        factor = 2 ** (abs(semitones) / 12)

        if semitones > 0:
            # Pitch DOWN: lower asetrate → deeper + slower, then atempo speeds back up
            new_rate = max(1000, int(sr / factor))
            tempo_fix = factor
        else:
            # Pitch UP: higher asetrate → higher + faster, then atempo slows back down
            new_rate = int(sr * factor)
            tempo_fix = 1.0 / factor

        atempo_chain = _build_atempo_chain(tempo_fix)
        af_filter = f"asetrate={new_rate},{atempo_chain},aresample={sr}"

        result = subprocess.run(
            ["ffmpeg", "-y", "-i", audio_path, "-af", af_filter, tmp_path],
            capture_output=True, timeout=30,
        )
        if result.returncode == 0 and os.path.exists(tmp_path):
            os.replace(tmp_path, audio_path)
            direction = "down" if semitones > 0 else "up"
            logger.info(f"[TTS] Pitch shifted {semitones} semitones ({direction}) via ffmpeg")
            return

        logger.warning(f"[TTS] ffmpeg failed: {result.stderr.decode()[:200]}")
    except FileNotFoundError:
        logger.warning("[TTS] ffmpeg not found, falling back to resample")
    except Exception as e:
        logger.warning(f"[TTS] ffmpeg pitch error: {e}")
    finally:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass

    # Fallback: simple resample (changes tempo too, but better than nothing)
    try:
        import numpy as np
        import soundfile as sf
        from scipy.signal import resample as scipy_resample

        data, sr = sf.read(audio_path)
        if len(data) == 0:
            return
        factor = 2 ** (abs(semitones) / 12)
        if semitones > 0:
            new_length = int(len(data) * factor)  # stretch = deeper + slower
        else:
            new_length = int(len(data) / factor)  # compress = higher + faster
        shifted = scipy_resample(data, new_length)
        shifted = np.clip(shifted, -1.0, 1.0)
        sf.write(audio_path, shifted.astype(np.float32), sr)
        logger.info(f"[TTS] Pitch shifted {semitones} semitones via resample (fallback)")
    except Exception as e:
        logger.warning(f"[TTS] Pitch shift failed completely: {e}")


def add_echo(audio_path: str, delay_ms: int = 80, decay: float = 0.35, taps: int = 3):
    """Add a short slapback echo/reverb to give a cavernous, godlike quality.

    Multiple taps at increasing delays create a reverb-like tail.
    """
    try:
        import numpy as np
        import soundfile as sf

        data, sr = sf.read(audio_path)
        if len(data) == 0:
            return

        # Extend the buffer so echo tails don't get cut off
        tail_samples = int(sr * delay_ms * (taps + 1) / 1000)
        if data.ndim == 1:
            result = np.zeros(len(data) + tail_samples, dtype=np.float32)
            result[:len(data)] = data
        else:
            result = np.zeros((len(data) + tail_samples, data.shape[1]), dtype=np.float32)
            result[:len(data)] = data

        for i in range(1, taps + 1):
            offset = int(sr * delay_ms * i / 1000)
            gain = decay ** i
            end = min(offset + len(data), len(result))
            src_len = end - offset
            result[offset:end] += data[:src_len] * gain

        # Normalize to prevent clipping
        peak = np.max(np.abs(result))
        if peak > 0.95:
            result = result * (0.95 / peak)

        sf.write(audio_path, result.astype(np.float32), sr)
        logger.info(f"[TTS] Echo added: {taps} taps, {delay_ms}ms delay, {decay} decay")
    except Exception as e:
        logger.warning(f"[TTS] Echo failed (non-fatal): {e}")


def change_speed(audio_path: str, speed: float = 1.0):
    """Change playback speed without changing pitch using ffmpeg atempo filter."""
    if abs(speed - 1.0) < 0.05:
        return  # close enough to 1.0, skip
    tmp_path = audio_path + ".speed.wav"
    try:
        atempo_chain = _build_atempo_chain(speed)
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", audio_path, "-af", atempo_chain, tmp_path],
            capture_output=True, timeout=30,
        )
        if result.returncode == 0 and os.path.exists(tmp_path):
            os.replace(tmp_path, audio_path)
            logger.info(f"[TTS] Speed adjusted to {speed:.2f}x via ffmpeg")
            return
        logger.warning(f"[TTS] ffmpeg speed failed: {result.stderr.decode()[:200]}")
    except FileNotFoundError:
        logger.warning("[TTS] ffmpeg not found, cannot adjust speed")
    except Exception as e:
        logger.warning(f"[TTS] Speed adjust failed: {e}")
    finally:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass


def trim_trailing_silence(audio_path: str, threshold: float = 0.01, keep_ms: int = 80):
    """Trim trailing silence from audio, keeping a small tail for natural spacing."""
    try:
        import numpy as np
        import soundfile as sf

        data, sr = sf.read(audio_path)
        if len(data) == 0:
            return
        abs_data = np.max(np.abs(data), axis=-1) if data.ndim > 1 else np.abs(data)
        # Find last sample above threshold
        loud = np.where(abs_data > threshold)[0]
        if len(loud) == 0:
            return
        last_loud = loud[-1]
        keep_samples = int(sr * keep_ms / 1000)
        end = min(last_loud + keep_samples, len(data))
        if end < len(data) - sr // 10:  # only trim if >100ms of silence
            sf.write(audio_path, data[:end].astype(np.float32), sr)
            trimmed_ms = (len(data) - end) * 1000 // sr
            logger.info(f"[TTS] Trimmed {trimmed_ms}ms trailing silence")
    except Exception as e:
        logger.warning(f"[TTS] Trim silence failed (non-fatal): {e}")


def boost_volume(audio_path: str, target_peak: float = 0.98):
    """Normalize + compress audio so Chad is always LOUD."""
    try:
        import numpy as np
        import soundfile as sf

        data, sr = sf.read(audio_path)
        if len(data) == 0:
            return
        data = np.array(data, dtype=np.float32)  # ensure writable copy
        peak = np.max(np.abs(data))
        if peak < 0.001:
            return  # truly empty, nothing to amplify

        # Step 1: Soft-knee compression — reduce dynamic range so quiet parts are louder
        threshold = 0.3
        ratio = 3.0  # 3:1 compression above threshold
        abs_data = np.abs(data)
        mask = abs_data > threshold
        if np.any(mask):
            # Compress samples above threshold
            over = abs_data[mask] - threshold
            compressed = threshold + over / ratio
            data[mask] = np.sign(data[mask]) * compressed

        # Step 2: Normalize to target peak
        peak = np.max(np.abs(data))
        if peak > 0.01 and peak < target_peak:
            gain = target_peak / peak
            data = data * gain

        data = np.clip(data, -1.0, 1.0)
        sf.write(audio_path, data.astype(np.float32), sr)
        logger.info(f"[TTS] Volume boosted + compressed to peak {target_peak:.2f}")
    except Exception as e:
        logger.warning(f"[TTS] Volume boost failed (non-fatal): {e}")


# Emotion presets: maps irritation level to voice instruct descriptions
# The 1.7B CustomVoice model fully supports instruct for emotional control.
EMOTION_PRESETS = [
    (0, 15, "Deep male voice, calm."),
    (16, 35, "Deep male voice, cold."),
    (36, 55, "Deep male voice, angry."),
    (56, 75, "Deep male voice, very angry."),
    (76, 100, "Deep male voice, furious."),
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

            # Apply same pitch shift + echo as Qwen3 so fallback doesn't sound different
            pitch = voice_config.get("pitch_shift", PITCH_SHIFT_SEMITONES)
            if pitch != 0:
                deepen_voice(output_path, semitones=pitch)
            echo_delay = voice_config.get("echo_delay", 80)
            echo_decay = voice_config.get("echo_decay", 0.35)
            echo_taps = voice_config.get("echo_taps", 3)
            if echo_taps > 0 and echo_decay > 0:
                add_echo(output_path, delay_ms=echo_delay, decay=echo_decay, taps=echo_taps)

            boost_volume(output_path)
            return True
        except Exception as e:
            logger.error(f"[TTS:Kokoro] synth failed: {e}")
            return False


class Qwen3TTSBackend:
    """Qwen3-TTS via mlx-audio. Genuine emotional voice."""

    MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"

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

            import re as _re

            irritation = voice_config.get("chaos", 30)
            custom_instruct = voice_config.get("custom_instruct", "").strip()
            instruct = custom_instruct if custom_instruct else get_instruct(irritation, angry)

            from mlx_audio.tts.generate import generate_audio
            speaker = voice_config.get("qwen3_speaker", "aiden")
            temp = voice_config.get("temperature", 0.9)
            speed = voice_config.get("speed", 1.0)

            # Optional Qwen3-specific params
            cfg_scale = voice_config.get("cfg_scale", None)
            ref_audio = voice_config.get("ref_audio", "").strip() or None
            ref_text = voice_config.get("ref_text", "").strip() or None

            logger.info(f"[TTS:Qwen3] instruct={instruct[:60]}... | voice={speaker} | {len(text)} chars, speed={speed}")

            # Split text into sentences to prevent the model from degenerating
            # into breathing/gasping on long inputs. The 0.6B model loses coherence
            # after ~2-3 sentences in a single generation.
            sentences = _re.split(r'(?<=[.!?])\s+', text.strip())
            # Merge very short fragments with the previous sentence
            chunks = []
            for s in sentences:
                if chunks and len(chunks[-1]) < 40:
                    chunks[-1] += ' ' + s
                else:
                    chunks.append(s)

            logger.info(f"[TTS:Qwen3] split into {len(chunks)} chunks: {[len(c) for c in chunks]}")

            import numpy as np
            import soundfile as sf
            all_audio = []
            sr = 24000  # default sample rate in case all chunks fail before assigning
            t0 = time.time()

            # Hold tts_lock for the entire synthesis to prevent concurrent GPU access
            with tts_lock:
                for ci, chunk in enumerate(chunks):
                    if not chunk.strip():
                        continue
                    chunk_dir = tempfile.mkdtemp(prefix="qwen3tts_")
                    # Generous max_tokens per chunk — 12Hz * 30sec = 360 tokens for a sentence,
                    # but use 4000 to be safe with slow/emotional speech
                    gen_kwargs = dict(
                        text=chunk,
                        model=self.model,
                        instruct=instruct,
                        voice=speaker,
                        output_path=chunk_dir,
                        file_prefix="chad",
                        audio_format="wav",
                        verbose=False,
                        play=False,
                        temperature=temp,
                        max_tokens=4000,
                    )
                    if cfg_scale:
                        gen_kwargs["cfg_scale"] = cfg_scale
                    if ref_audio:
                        gen_kwargs["ref_audio"] = ref_audio
                    if ref_text:
                        gen_kwargs["ref_text"] = ref_text

                    try:
                        with suppress_stdout():
                            generate_audio(**gen_kwargs)
                        chunk_path = Path(chunk_dir)
                        wavs = sorted(chunk_path.glob("*.wav"))
                        if wavs:
                            data, sr = sf.read(str(wavs[0]))
                            all_audio.append(data)
                            logger.info(f"[TTS:Qwen3] chunk {ci+1}/{len(chunks)}: {len(chunk)} chars → {len(data)/sr:.1f}s audio")
                        else:
                            logger.warning(f"[TTS:Qwen3] chunk {ci+1}/{len(chunks)}: no WAV produced")
                    except Exception as e:
                        logger.warning(f"[TTS:Qwen3] chunk {ci+1} failed: {e}")
                    finally:
                        shutil.rmtree(chunk_dir, ignore_errors=True)

            t_gen = time.time() - t0
            logger.info(f"[TTS:Qwen3] all chunks generated in {t_gen:.1f}s")

            if not all_audio:
                logger.error("[TTS:Qwen3] no audio chunks produced")
                return False

            # Concatenate all chunks
            combined = np.concatenate(all_audio)
            sf.write(output_path, np.asarray(combined, dtype=np.float32), sr)

            # Post-processing pipeline
            # 1. Speed adjustment (Qwen3 ignores the speed param, so do it here)
            if abs(speed - 1.0) >= 0.05:
                change_speed(output_path, speed)

            # 2. Pitch-shift voice
            pitch = voice_config.get("pitch_shift", PITCH_SHIFT_SEMITONES)
            if pitch != 0:
                deepen_voice(output_path, semitones=pitch)

            # 3. Echo/reverb
            echo_delay = voice_config.get("echo_delay", 80)
            echo_decay = voice_config.get("echo_decay", 0.35)
            echo_taps = voice_config.get("echo_taps", 3)
            if echo_taps > 0 and echo_decay > 0:
                add_echo(output_path, delay_ms=echo_delay, decay=echo_decay, taps=echo_taps)

            # 4. Boost volume
            boost_volume(output_path)
            wav_size = Path(output_path).stat().st_size
            logger.info(f"[TTS:Qwen3] output: {wav_size/1024:.0f}KB WAV ({len(chunks)} chunks, {t_gen:.1f}s gen)")
            return True
        except Exception as e:
            logger.error(f"[TTS:Qwen3] synth failed: {e}")
            return False


    def synthesize_sentence(self, text: str, output_path: str, voice_config: dict, angry: bool = False) -> bool:
        """Synthesize a single sentence with post-processing.
        Used by the streaming TTS pipeline to process sentences as they arrive.
        Long text is split at clause boundaries to prevent the model from
        degenerating on long inputs."""
        if not self.ready:
            return False
        try:
            import re as _re
            import shutil
            import tempfile

            import numpy as np
            import soundfile as sf

            text = text.strip()
            if not text:
                return False

            irritation = voice_config.get("chaos", 30)
            custom_instruct = voice_config.get("custom_instruct", "").strip()
            instruct = custom_instruct if custom_instruct else get_instruct(irritation, angry)

            from mlx_audio.tts.generate import generate_audio
            speaker = voice_config.get("qwen3_speaker", "aiden")
            temp = voice_config.get("temperature", 0.9)
            speed = voice_config.get("speed", 1.0)

            cfg_scale = voice_config.get("cfg_scale", None)
            ref_audio = voice_config.get("ref_audio", "").strip() or None
            ref_text = voice_config.get("ref_text", "").strip() or None

            # Split long text into chunks at clause boundaries to prevent
            # the model from cutting off or degenerating
            MAX_CHUNK_CHARS = 200
            if len(text) > MAX_CHUNK_CHARS:
                # Split at commas, semicolons, colons, dashes, or sentence-enders
                parts = _re.split(r'(?<=[,;:\-—.!?])\s+', text)
                chunks = []
                for p in parts:
                    if chunks and len(chunks[-1]) + len(p) + 1 <= MAX_CHUNK_CHARS:
                        chunks[-1] += ' ' + p
                    else:
                        chunks.append(p)
            else:
                chunks = [text]

            logger.info(f"[TTS:Qwen3] sentence synth: {len(text)} chars → {len(chunks)} chunk(s)")

            all_audio = []
            sr = 24000

            # Hold tts_lock for the entire sentence to prevent concurrent GPU access
            # between chunks (Metal can crash if two generate_audio calls interleave)
            with tts_lock:
                for ci, chunk in enumerate(chunks):
                    if not chunk.strip():
                        continue
                    chunk_dir = tempfile.mkdtemp(prefix="qwen3tts_")
                    gen_kwargs = dict(
                        text=chunk,
                        model=self.model,
                        instruct=instruct,
                        voice=speaker,
                        output_path=chunk_dir,
                        file_prefix="chad",
                        audio_format="wav",
                        verbose=False,
                        play=False,
                        temperature=temp,
                        max_tokens=4000,
                    )
                    if cfg_scale:
                        gen_kwargs["cfg_scale"] = cfg_scale
                    if ref_audio:
                        gen_kwargs["ref_audio"] = ref_audio
                    if ref_text:
                        gen_kwargs["ref_text"] = ref_text

                    try:
                        with suppress_stdout():
                            generate_audio(**gen_kwargs)
                        chunk_path = Path(chunk_dir)
                        wavs = sorted(chunk_path.glob("*.wav"))
                        if wavs:
                            data, chunk_sr = sf.read(str(wavs[0]))
                            sr = chunk_sr
                            all_audio.append(data)
                            logger.info(f"[TTS:Qwen3] sentence chunk {ci+1}/{len(chunks)}: {len(chunk)} chars → {len(data)/sr:.1f}s")
                        else:
                            logger.warning(f"[TTS:Qwen3] sentence chunk {ci+1}/{len(chunks)}: no WAV produced")
                    except Exception as e:
                        logger.warning(f"[TTS:Qwen3] sentence chunk {ci+1}/{len(chunks)} failed: {e}")
                    finally:
                        shutil.rmtree(chunk_dir, ignore_errors=True)

            if not all_audio:
                return False

            combined = np.concatenate(all_audio) if len(all_audio) > 1 else all_audio[0]
            sf.write(output_path, np.asarray(combined, dtype=np.float32), sr)

            # Post-processing pipeline (same as full synthesize)
            if abs(speed - 1.0) >= 0.05:
                change_speed(output_path, speed)
            pitch = voice_config.get("pitch_shift", PITCH_SHIFT_SEMITONES)
            if pitch != 0:
                deepen_voice(output_path, semitones=pitch)
            echo_delay = voice_config.get("echo_delay", 80)
            echo_decay = voice_config.get("echo_decay", 0.35)
            echo_taps = voice_config.get("echo_taps", 3)
            if echo_taps > 0 and echo_decay > 0:
                add_echo(output_path, delay_ms=echo_delay, decay=echo_decay, taps=echo_taps)
            boost_volume(output_path)

            logger.info(f"[TTS:Qwen3] sentence done: {len(text)} chars → {Path(output_path).stat().st_size/1024:.0f}KB")
            return True
        except Exception as e:
            logger.error(f"[TTS:Qwen3] sentence synth failed: {e}")
            return False


class SayFallback:
    """macOS say command fallback."""

    @property
    def ready(self):
        return True

    def init(self):
        return True

    def synthesize(self, text: str, output_path: str, voice_config: dict, angry: bool = False) -> bool:
        aiff_path = output_path.replace(".wav", ".aiff")
        try:
            rate = "160" if angry else "175"
            subprocess.run(
                ["say", "-v", "Daniel", "-r", rate, "-o", aiff_path, text],
                check=True, timeout=30,
            )
            subprocess.run(
                ["afconvert", "-f", "WAVE", "-d", "LEI16", aiff_path, output_path],
                check=True, timeout=10,
            )
            return True
        except Exception as e:
            logger.error(f"say fallback failed: {e}")
            return False
        finally:
            Path(aiff_path).unlink(missing_ok=True)
