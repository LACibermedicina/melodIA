"""Vozes faladas que alimentam o canto. Padrão: Piper (VITS em ONNX, MIT) com a duração de cada fonema.
Plano B: espeak-ng (formantes), só para o serviço não parar se o modelo neural faltar."""
import os, subprocess, tempfile, wave
import numpy as np

class PiperTTS:
    base_f = 1.0  # a voz faber é masculina: fator de formantes de referência
    def __init__(self, model_path, length_scale=1.22):
        from piper import PiperVoice, SynthesisConfig
        self.alignments = True
        try:
            self.v = PiperVoice.load(model_path, include_alignments=True)
        except Exception:
            self.v = PiperVoice.load(model_path); self.alignments = False
        self.cfg = SynthesisConfig(length_scale=length_scale, noise_scale=.45, noise_w_scale=.55, normalize_audio=True)
        self.sample_rate = int(self.v.config.sample_rate)
        self.key = 'piper:' + os.path.basename(model_path) + ':%.2f' % length_scale
        self.name = os.path.basename(model_path).replace('.onnx', '')
    def speak(self, text):
        xs, al = [], []
        for ch in self.v.synthesize(text, syn_config=self.cfg, include_alignments=self.alignments):
            xs.append(np.asarray(ch.audio_float_array, np.float32))
            if getattr(ch, 'phoneme_alignments', None):
                al.extend((a.phoneme, a.num_samples) for a in ch.phoneme_alignments)
            else: al = None
        x = np.concatenate(xs) if xs else np.zeros(1, np.float32)
        return x, (al if al else None)

class EspeakTTS:
    base_f = 1.0
    def __init__(self, voice='pt-br'):
        self.voice = voice; self.sample_rate = 22050; self.key = 'espeak:' + voice; self.name = 'espeak-ng ' + voice
        subprocess.run(['espeak-ng', '--version'], check=True, capture_output=True)
    def speak(self, text):
        with tempfile.NamedTemporaryFile(suffix='.wav') as f:
            subprocess.run(['espeak-ng', '-v', self.voice, '-s', '120', '-w', f.name, text], check=True, capture_output=True)
            w = wave.open(f.name); sr = w.getframerate(); x = np.frombuffer(w.readframes(w.getnframes()), np.int16) / 32768.0
        if sr != self.sample_rate:
            from scipy.signal import resample_poly
            x = resample_poly(x, self.sample_rate, sr)
        return x.astype(np.float32), None

def load_tts(model_dir):
    """Escolhe a melhor voz disponível na pasta de modelos."""
    pref = ['pt_BR-faber-medium.onnx', 'pt_BR-cadu-medium.onnx', 'pt_BR-jeff-medium.onnx']
    for name in pref + sorted(os.listdir(model_dir) if os.path.isdir(model_dir) else []):
        p = os.path.join(model_dir, name)
        if name.endswith('.onnx') and os.path.isfile(p) and os.path.isfile(p + '.json'):
            try: return PiperTTS(p)
            except Exception as e: print('Piper indisponível (%s): %s' % (name, e), flush=True)
    return EspeakTTS()
