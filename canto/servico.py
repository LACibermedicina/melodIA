"""Serviço interno de canto natural (só escuta em 127.0.0.1). Quem fala com ele é o server.js do MelodIA.

POST /render  {lines:[{id,notes,alpha}], bpm, vd, voice, seed, ref, outdir, base, progress, gpu}
GET  /status
Um trabalho por vez (a VPS tem 1 CPU); os demais esperam na fila do server.js."""
import json, os, sys, time, threading, traceback, wave, subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import svs, gpu, transcricao
from tts import load_tts
try:
    import pyworld as pw
except ImportError:  # testes locais com o adaptador ctypes
    sys.path.insert(0, os.environ.get('PYWORLD_SHIM', '')); import pyworld as pw

MODELS = os.environ.get('CANTO_MODELS', os.path.join(os.path.dirname(__file__), 'modelos'))
if os.environ.get('CANTO_TTS_TEST') == 'flite':  # só para testes locais
    from flite_tts import FliteTTS; TTS = FliteTTS()
else:
    TTS = load_tts(MODELS)
LOCK = threading.Lock()
STATE = {'busy': False, 'done': 0, 'started': time.time()}

def read_wav(path):
    try:
        w = wave.open(path); sr = w.getframerate(); ch = w.getnchannels(); sw = w.getsampwidth()
        raw = w.readframes(w.getnframes()); w.close()
        x = np.frombuffer(raw, {2: np.int16, 4: np.int32, 1: np.uint8}[sw]).astype(np.float64)
        x = (x - 128) / 128 if sw == 1 else x / (32768.0 if sw == 2 else 2147483648.0)
        if ch > 1: x = x.reshape(-1, ch).mean(1)
        return x, sr
    except Exception:
        p = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', '44100', '-f', 's16le', '-'], capture_output=True, check=True)
        return np.frombuffer(p.stdout, np.int16) / 32768.0, 44100
def write_wav(path, y, fs):
    tmp = path + '.tmp'
    w = wave.open(tmp, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(fs)
    w.writeframes((np.clip(y, -1, 1) * 32767).astype(np.int16).tobytes()); w.close(); os.replace(tmp, path)

def job(b):
    t0 = time.time(); prog = b.get('progress')
    def progress(f, msg):
        if prog:
            try:
                with open(prog + '.tmp', 'w', encoding='utf-8') as fh: json.dump({'p': round(float(f), 3), 'msg': msg}, fh)
                os.replace(prog + '.tmp', prog)
            except Exception: pass
    progress(.02, 'Preparando a voz')
    voice = b.get('voice') or {}; vd = b.get('vd') or {}; ref = b.get('ref')
    timbre, note = None, ''
    if ref and os.path.exists(ref):
        try:
            x, sr = read_wav(ref); timbre = svs.load_ref(pw, TTS, ref, sr, x)
            if timbre: note = 'timbre importado (formantes ×%.2f)' % timbre['alpha']
        except Exception as e: note = 'amostra de voz ilegível (%s)' % e
    files, start, fs, gpu_used, gpu_err = {}, 0.0, TTS.sample_rate, False, ''
    lines = b.get('lines') or []
    for li, ln in enumerate(lines):
        def pr(f, msg, li=li): progress((li + f) / len(lines) * (.85 if b.get('gpu') else 1), msg + (' (2ª voz)' if ln.get('id') == 'harm' else ''))
        y, fs, start = svs.render_line(pw, TTS, ln.get('notes') or [], b.get('bpm', 100), vd, voice, int(b.get('seed') or 1) + li * 7,
                                       timbre=timbre, progress=pr, alpha_extra=float(ln.get('alpha') or 1.0), ar=float(b.get('ar') or .9))
        path = os.path.join(b['outdir'], '%s_%s.wav' % (b['base'], ln.get('id', 'lead')))
        write_wav(path, y, fs); files[ln.get('id', 'lead')] = os.path.basename(path)
        if b.get('gpu') and ref and gpu.provider() and ln.get('id', 'lead') == 'lead':
            progress(.88, 'Convertendo o timbre na GPU externa')
            try:
                conv = gpu.convert(path, ref)
                x, sr = read_wav(conv); n0 = int(round(len(y) / fs * sr))
                x = np.pad(x, (0, max(0, n0 - len(x))))[:n0]
                x = x / (np.abs(x).max() + 1e-9) * .89
                write_wav(path, x, sr); gpu_used = True; fs = sr
            except Exception as e:
                gpu_err = str(e)[:200]
    progress(1, 'Pronto')
    st = dict(svs.STATS)
    STATE['done'] += 1
    return {'files': files, 'start': start, 'fs': fs, 'ms': int((time.time() - t0) * 1000), 'engine': TTS.name,
            'alignments': bool(getattr(TTS, 'alignments', False)), 'timbre': note, 'gpu': gpu_used, 'gpuError': gpu_err,
            'palavras': {'alinhadas': st['al'], 'silaba_a_silaba': st['fb'], 'exemplos': st['fbw'][-6:]}}

def job_tr(b):
    """Transcrição de voz cantada: notas + ornamentos + efeitos + letra alinhada no tempo."""
    t0 = time.time(); prog = b.get('progress')
    def progress(f, msg):
        if prog:
            try:
                with open(prog + '.tmp', 'w', encoding='utf-8') as fh: json.dump({'p': round(float(f), 3), 'msg': msg}, fh)
                os.replace(prog + '.tmp', prog)
            except Exception: pass
    progress(.03, 'Lendo a gravação')
    x, sr = read_wav(b['wav'])
    if sr != 16000:
        from scipy.signal import resample_poly
        import math as _m
        g = _m.gcd(16000, sr); x = resample_poly(x, 16000 // g, sr // g); sr = 16000
    x = x[:16000 * 600]
    words, asr, err = [], '', ''
    if b.get('asr', True):
        try:
            words, lang = transcricao.whisper_words(x, os.environ.get('CANTO_ASR_MODEL', 'base'), os.path.join(MODELS, 'whisper'), progress)
            asr = 'whisper-' + os.environ.get('CANTO_ASR_MODEL', 'base')
        except Exception as e:
            err = str(e)[:200]; traceback.print_exc()
    R = transcricao.transcribe_song(pw, x, sr, words, progress)
    R.update(words=words, asr=asr, asrError=err, dur=round(len(x) / sr, 2), ms=int((time.time() - t0) * 1000))
    progress(1, 'Pronto')
    return R

class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == '/status':
            return self._send(200, {'ok': True, 'tts': TTS.name, 'alignments': bool(getattr(TTS, 'alignments', False)),
                                    'gpu': gpu.provider(), 'busy': STATE['busy'], 'done': STATE['done']})
        self._send(404, {'error': 'não encontrado'})
    def do_POST(self):
        if self.path not in ('/render', '/transcrever'): return self._send(404, {'error': 'não encontrado'})
        try:
            n = int(self.headers.get('Content-Length') or 0)
            if n > 8 * 1048576: return self._send(413, {'error': 'pedido grande demais'})
            b = json.loads(self.rfile.read(n) or b'{}')
            with LOCK:
                STATE['busy'] = True
                try: r = job_tr(b) if self.path == '/transcrever' else job(b)
                finally: STATE['busy'] = False
            self._send(200, r)
        except Exception as e:
            traceback.print_exc(); self._send(500, {'error': str(e)[:300]})

if __name__ == '__main__':
    port = int(os.environ.get('CANTO_PORT', '3290'))
    print('Canto natural em 127.0.0.1:%d · voz %s · alinhamento %s · GPU externa: %s' % (port, TTS.name, getattr(TTS, 'alignments', False), gpu.provider() or 'não'), flush=True)
    def _idle():
        while True:
            time.sleep(60)
            try: transcricao.whisper_idle(600)
            except Exception: pass
    threading.Thread(target=_idle, daemon=True).start()
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
