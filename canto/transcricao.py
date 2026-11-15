"""MelodIA · transcrição de voz cantada: notas, ornamentos, efeitos vocais e letra alinhada no tempo.

1) altura com o Harvest (WORLD), correção de oitava e descarte de rouquidão/respiração;
2) sílabas cantadas pelos vales de energia e pelas consoantes (trechos sem voz);
3) dentro de cada sílaba, patamares de altura = notas; deslizes de entrada (scoop), quedas (fall),
   vibrato e notas curtíssimas viram ORNAMENTOS da nota principal, não notas novas;
4) letra com o tempo de cada palavra (Whisper local) e encaixe sílaba a sílaba nas notas que soam
   naquele momento: notas extras dentro da palavra = melisma; som fora das palavras = efeito vocal.
"""
import math, re, os, threading, time
import numpy as np

HOP = 10.0  # ms

def midi(f): return 12 * np.log2(np.maximum(f, 1e-9) / 440.0) + 69

# ------------------------------------------------------------------ sílabas (igual ao app)
VW = 'aeiouáéíóúâêôãõàü'
_SYL = re.compile('[^' + VW + ']*[' + VW + ']+(?:[nrsmlz](?![' + VW + ']))?')
_DG = (('nh', '\u0272'), ('lh', '\u028e'), ('ch', '\u0283'), ('qu', 'q\u02b7'), ('gu', 'g\u02b7'))
def syl_word(w):
    w = re.sub('[^a-záéíóúâêôãõàçü]', '', w.lower())
    if not w: return []
    for a_, b_ in _DG[:3]: w = w.replace(a_, b_)  # dígrafos não se separam (ca-mi-nho, fi-lho, cho-ro)
    out = _SYL.findall(w)
    out = [o for o in out]
    if out:
        rest = w[len(''.join(out)):]
        if rest: out[-1] += rest
    else: out = [w]
    back = lambda x: x.replace('\u0272', 'nh').replace('\u028e', 'lh').replace('\u0283', 'ch')
    return [back(o) for o in out]
def _unused(w):
    out = _SYL.findall(w)
    if not out: return [w]
    rest = w[len(''.join(out)):]
    if rest: out[-1] += rest
    return out

# ------------------------------------------------------------------ altura e energia
def pitch_track(pw, x, fs):
    x = np.asarray(x, np.float64)
    f0, t = pw.harvest(x, fs, f0_floor=65.0, f0_ceil=1000.0, frame_period=HOP)
    hop = int(round(fs * HOP / 1000))
    n = len(f0); e = np.zeros(n)
    for i in range(n):
        seg = x[i * hop:(i + 1) * hop]
        e[i] = np.sqrt(np.mean(seg ** 2) + 1e-12) if len(seg) else 1e-6
    edb = 20 * np.log10(e + 1e-9)
    m = np.where(f0 > 0, midi(f0), np.nan)
    # correção de oitava e descarte de rouquidão: compara com a mediana móvel de ~1,2 s
    v = ~np.isnan(m); k = 60
    if v.sum() > 20:
        med = np.full(n, np.nan)
        idx = np.where(v)[0]
        for i in range(n):
            a = np.searchsorted(idx, i - k); b = np.searchsorted(idx, i + k)
            if b > a: med[i] = np.median(m[idx[a:b]])
        for i in range(n):
            if not v[i] or np.isnan(med[i]): continue
            d = m[i] - med[i]
            if abs(d) > 8.5:
                for o in (-12, 12, -24, 24):
                    if abs(d + o) < 4: m[i] += o; break
                else: m[i] = np.nan
    # voz fraca demais = ruído/respiração
    floor = np.nanpercentile(edb, 92) - 38 if np.isfinite(edb).any() else -80
    m[edb < floor] = np.nan
    return t, m, edb

def _smooth(a, k=5):
    out = a.copy(); h = k // 2
    for i in range(len(a)):
        w = a[max(0, i - h):i + h + 1]; w = w[~np.isnan(w)]
        out[i] = np.median(w) if len(w) else np.nan
    return out

# ------------------------------------------------------------------ sílabas cantadas e notas
def syllable_segments(m, edb, min_len=6):
    """Trechos sonoros separados por silêncio, consoantes surdas ou vales de energia."""
    v = ~np.isnan(m); n = len(m); segs = []; i = 0
    es = np.convolve(np.nan_to_num(edb, nan=-90), np.ones(5) / 5, mode='same')
    while i < n:
        if not v[i]: i += 1; continue
        j = i
        while j < n and (v[j] or (j + 1 < n and v[j + 1] and j - i > 2)): j += 1
        # divide por vales de energia (sílabas emendadas, sem consoante surda)
        cuts = [i]
        for k in range(i + 6, j - 6):
            win = es[k - 6:k + 7]
            if es[k] == win.min() and min(es[k - 6:k].max(), es[k + 1:k + 7].max()) - es[k] >= 4.5: cuts.append(k)
        cuts.append(j)
        for a, b in zip(cuts, cuts[1:]):
            if b - a >= min_len: segs.append((a, b))
        i = j
    return segs

def notes_in_segment(m, a, b, t):
    """Patamares de altura dentro de uma sílaba; deslizes e vibrato viram ornamentos."""
    ms = _smooth(m[a:b], 5); n = b - a
    plats = []; s = 0
    while s < n:
        if np.isnan(ms[s]): s += 1; continue
        e = s + 1; ref = ms[s]; vals = [ms[s]]
        while e < n:
            x = ms[e]
            if np.isnan(x): break
            med = float(np.median(vals[-12:]))
            if abs(x - med) > 0.85:
                # muda de patamar só se a nova altura se sustenta por ≥ 60 ms
                look = ms[e:e + 6]; look = look[~np.isnan(look)]
                if len(look) >= 5 and np.all(np.abs(look - np.median(look)) < 0.7) and abs(np.median(look) - med) > 0.85: break
            vals.append(x); e += 1
        plats.append([s, e]); s = e
    notes = []
    for s, e in plats:
        seg = ms[s:e]; seg = seg[~np.isnan(seg)]
        if len(seg) < 3: continue
        L = len(seg); core = seg[int(L * .25):max(int(L * .25) + 1, int(L * .8))]
        pitch = float(np.median(core)); orn = []
        head = seg[:max(2, int(L * .25))]; tail = seg[int(L * .8):]
        if len(head) and pitch - head.min() > 1.2 and head.argmin() < len(head) / 2: orn.append('scoop')
        if len(tail) > 1 and pitch - tail[-1] > 1.5: orn.append('fall')
        if L >= 25:
            dev = core - np.convolve(core, np.ones(9) / 9, mode='same')
            zc = np.sum(np.diff(np.sign(dev[4:-4])) != 0) / max(1e-9, (len(core) - 8) * HOP / 1000) / 2
            if 3.5 < zc < 9 and np.std(dev[4:-4]) > .18: orn.append('vib')
        notes.append({'a': a + s, 'b': a + e, 'm': pitch, 'orn': orn})
    # notas curtíssimas (< 80 ms) = ornamento (apojatura/nota de graça) da vizinha mais longa
    out = []
    for i, nt in enumerate(notes):
        dur = (nt['b'] - nt['a']) * HOP / 1000
        if dur < .08 and len(notes) > 1:
            j = i + 1 if i + 1 < len(notes) else i - 1
            tgt = notes[j]
            if abs(tgt['m'] - nt['m']) <= 3:
                tgt.setdefault('grace', []).append(round(nt['m']))
                if j > i: tgt['a'] = nt['a']
                else: tgt['b'] = nt['b']
                continue
        out.append(nt)
    return out

def extract_notes(m, edb, t):
    segs = syllable_segments(m, edb); notes = []
    for si, (a, b) in enumerate(segs):
        for k, nt in enumerate(notes_in_segment(m, a, b, t)):
            nt['seg'] = si; nt['first'] = k == 0
            nt['e'] = float(np.nanmax(edb[nt['a']:nt['b']])) if nt['b'] > nt['a'] else -90.0
            notes.append(nt)
    out = []
    for nt in notes:
        t0 = nt['a'] * HOP / 1000; d = (nt['b'] - nt['a']) * HOP / 1000
        out.append({'t': round(t0, 3), 'd': round(d, 3), 'm': int(round(nt['m'])), 'mf': round(nt['m'], 2), 'seg': nt['seg'], 'first': nt['first'],
                    'orn': nt['orn'] + (['grace'] if nt.get('grace') else []), 'grace': nt.get('grace', []), 'e': round(nt['e'], 1)})
    return out, segs

# ------------------------------------------------------------------ letra alinhada às notas
def align(notes, words):
    """words: [{'w','start','end'}]. Marca cada nota como sílaba, melisma ou efeito vocal."""
    for n in notes: n.update(s='', kind='efeito', word=-1, wi=False, wf=False)
    if not words:
        return notes
    for wi_, w in enumerate(words):
        ss = syl_word(w['w'])
        if not ss: continue
        a, b = w['start'] - .12, w['end'] + .08
        idx = [i for i, n in enumerate(notes) if a <= n['t'] + min(.06, n['d'] / 2) < b and notes[i]['word'] < 0]
        if not idx:
            # palavra sem nota própria (falada muito rápido): cola na nota mais próxima
            near = min(range(len(notes)), key=lambda i: abs(notes[i]['t'] - w['start'])) if notes else None
            if near is not None and abs(notes[near]['t'] - w['start']) < .5 and notes[near]['word'] < 0: idx = [near]
            else: continue
        # grupos de notas por sílaba cantada (segmento); cada grupo recebe uma sílaba
        groups = []
        for i in idx:
            if groups and notes[groups[-1][-1]]['seg'] == notes[i]['seg']: groups[-1].append(i)
            else: groups.append([i])
        while len(groups) > len(ss) and len(groups) > 1:
            # junta o grupo mais curto ao vizinho: vira melisma da sílaba anterior
            durs = [sum(notes[i]['d'] for i in g) for g in groups]; k = int(np.argmin(durs[1:])) + 1
            groups[k - 1] += groups.pop(k)
        sylls = list(ss)
        if len(sylls) > len(groups):
            # mais sílabas que sílabas cantadas: divide notas longas ou junta sílabas na última
            extra = len(sylls) - len(groups); flat = [i for g in groups for i in g]
            if len(flat) >= len(sylls): groups = [[i] for i in flat[:len(sylls) - 1]] + [flat[len(sylls) - 1:]]
            else:
                groups = [[i] for i in flat]; sylls = sylls[:len(groups) - 1] + [''.join(sylls[len(groups) - 1:])]
        for k, g in enumerate(groups):
            for j, i in enumerate(g):
                notes[i].update(word=wi_, kind='silaba' if j == 0 else 'melisma', s=sylls[k] if j == 0 else '',
                                wi=(k == 0 and j == 0), wf=(k == len(groups) - 1 and j == 0))
    return notes

def vocables(notes):
    """Efeitos vocais fora das palavras: escolhe uma sílaba neutra pela altura/energia/duração."""
    for i, n in enumerate(notes):
        if n['kind'] != 'efeito': continue
        prev = notes[i - 1] if i else None
        if prev and prev['kind'] in ('silaba', 'melisma') and prev['seg'] == n['seg']:
            n['kind'] = 'melisma'; n['s'] = ''; continue
        n['s'] = 'hm' if n['e'] < np.median([x['e'] for x in notes]) - 9 else ('ô' if n['d'] > .35 else 'tá' if n['d'] < .16 else 'ê')
    return notes

# ------------------------------------------------------------------ Whisper local (faster-whisper)
_W = {'model': None, 'name': None, 'last': 0}
_WLOCK = threading.Lock()
def whisper_words(x16, model_name='base', root=None, progress=None):
    from faster_whisper import WhisperModel
    with _WLOCK:
        if _W['model'] is None or _W['name'] != model_name:
            if progress: progress(.12, 'Carregando o reconhecimento de voz (%s)' % model_name)
            _W['model'] = WhisperModel(model_name, device='cpu', compute_type='int8', cpu_threads=1, download_root=root)
            _W['name'] = model_name
        _W['last'] = time.time(); mdl = _W['model']
    segs, info = mdl.transcribe(np.asarray(x16, np.float32), language='pt', word_timestamps=True, vad_filter=True,
                                beam_size=2, condition_on_previous_text=False, initial_prompt='Letra de música cantada em português.')
    words = []; dur = len(x16) / 16000.0
    for s in segs:
        if progress: progress(.15 + .45 * min(1, s.end / max(1, dur)), 'Reconhecendo a letra · %d:%02d' % (int(s.end) // 60, int(s.end) % 60))
        for w in (s.words or []):
            tx = w.word.strip()
            if re.sub('[^A-Za-zÀ-ÿ]', '', tx): words.append({'w': tx, 'start': round(float(w.start), 3), 'end': round(float(w.end), 3), 'p': round(float(w.probability), 2)})
    return words, info.language
def whisper_idle(sec=600):
    if _W['model'] is not None and time.time() - _W['last'] > sec:
        with _WLOCK: _W['model'] = None; _W['name'] = None
        import gc; gc.collect()

# ------------------------------------------------------------------ andamento (para o app quantizar)
def tempo(notes):
    on = np.array([n['t'] for n in notes if n['kind'] != 'melisma' or n['first']])
    if len(on) < 8: return 100
    best, be = 100, 1e9
    for bpm in np.arange(60, 160.5, .5):
        g = 60.0 / bpm / 2; ph = (on / g) % 1; ph = np.minimum(ph, 1 - ph)
        e = float(np.mean(ph)) + (0.004 if bpm < 72 or bpm > 145 else 0)
        if e < be: be, best = e, bpm
    return float(round(best))

def transcribe_song(pw, x16, fs, words=None, progress=None):
    if progress: progress(.62, 'Medindo a altura da voz')
    t, m, edb = pitch_track(pw, x16, fs)
    if progress: progress(.78, 'Separando sílabas, notas e ornamentos')
    notes, segs = extract_notes(m, edb, t)
    notes = vocables(align(notes, words or []))
    stats = {k: sum(1 for n in notes if n['kind'] == k) for k in ('silaba', 'melisma', 'efeito')}
    stats['ornamentos'] = sum(len(n['orn']) for n in notes); stats['silabasCantadas'] = len(segs)
    return {'notes': notes, 'bpm': tempo(notes), 'stats': stats}
