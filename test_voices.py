#!/usr/bin/env python3
"""Generate test audio with each male speaker for comparison."""
import os, sys, time
os.environ["TOKENIZERS_PARALLELISM"] = "false"

# Suppress noisy logs
import logging
for name in ["transformers", "huggingface_hub", "mlx_audio"]:
    logging.getLogger(name).setLevel(logging.ERROR)

from mlx_audio.tts.utils import load_model
from mlx_audio.tts.generate import generate_audio

MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
TEXT = "What do you want now? I was in the middle of something actually important. Unlike you."
INSTRUCT = "Angry and hostile. Threatening. Through gritted teeth."

print("Loading model...")
model = load_model(model_path=MODEL_ID)

# Available speakers from config
speakers = list(model.config.talker_config.spk_id.keys())
male_speakers = [s for s in speakers if s not in ('serena', 'vivian', 'ono_anna', 'sohee')]
print(f"Male speakers: {male_speakers}")

os.makedirs("test_voices", exist_ok=True)

for speaker in male_speakers:
    print(f"\n=== Testing speaker: {speaker} ===")
    outdir = f"test_voices/{speaker}"
    os.makedirs(outdir, exist_ok=True)
    t0 = time.time()
    try:
        generate_audio(
            text=TEXT,
            model=model,
            instruct=INSTRUCT,
            voice=speaker,
            output_path=outdir,
            file_prefix="test",
            audio_format="wav",
            verbose=False,
            play=False,
            temperature=0.9,
            max_tokens=2048,
        )
        elapsed = time.time() - t0
        print(f"  Done in {elapsed:.1f}s -> {outdir}/test_0.wav")
    except Exception as e:
        print(f"  FAILED: {e}")

print("\n\nAll done! Listen to files in test_voices/*/test_0.wav")
print("Pick the deepest, gruffest one and tell me the speaker name.")
