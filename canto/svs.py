"""MelodIA · canto natural (SVS) por voz neural + vocoder WORLD.

Fluxo: letra -> voz neural (Piper, com duração de cada fonema) -> separa cada sílaba em consoante inicial,
vogal e consoante final -> análise WORLD (f0, envelope espectral, aperiodicidade) -> a vogal é esticada até
a duração da nota e as consoantes mantêm o tempo natural, entrando antes do tempo -> a altura passa a seguir
a partitura com portamento, scoop, vibrato tardio, deriva e queda no fim da frase -> dinâmica, brilho, sopro,
formantes (registro e timbre importado) -> síntese WORLD frase a frase, com respirações entre frases.
"""
import math, hashlib, unicodedata
import numpy as np

FP = 5.0  # período de quadro (ms)

# ---------------------------------------------------------------- utilidades
def clamp(v, a, b): return max(a, min(b, v))
def mtof(m): return 440.0 * 2 ** ((m - 69) / 12.0)
class Rng:
    """mulberry32, igual ao do navegador, para a mesma humanização no servidor e no app."""
    def __init__(s, seed): s.a = seed & 0xFFFFFFFF
    def __call__(s):
        s.a = (s.a + 0x6D2B79F5) & 0xFFFFFFFF; t = s.a
        t = ((t ^ (t >> 15)) * (1 | t)) & 0xFFFFFFFF
        t = (t + (((t ^ (t >> 7)) * (61 | t)) & 0xFFFFFFFF) ^ t) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

VD0 = dict(vib=.45, vibDelay=.3, vibRate=5.5, porta=.35, scoop=.35, breath=.25, breathIn=.5, expr=.6, hum=.35, lag=0,
           diction=.6, bright=.5, fall=.3, rev=.25, choir=0, back=0, duck=.6, ring=0, rough=0, art='auto', dyn='mf')
DYN = {'pp': .42, 'p': .55, 'mp': .7, 'mf': .82, 'f': .95, 'ff': 1.08}
NUM = {k: v for k, v in dict(vib=(0, 1), vibDelay=(0, .8), vibRate=(4, 7), porta=(0, 1), scoop=(0, 1), breath=(0, 1), breathIn=(0, 1),
       expr=(0, 1), hum=(0, 1), lag=(-1, 1), diction=(0, 1), bright=(0, 1), fall=(0, 1), ring=(0, 1), rough=(0, 1)).items()}
def clean_vd(o):
    d = dict(VD0)
    for k, (a, b) in NUM.items():
        try:
            if o.get(k) is not None: d[k] = clamp(float(o[k]), a, b)
        except (TypeError, ValueError): pass
    if o.get('art') in ('auto', 'legato', 'normal', 'staccato', 'marcato'): d['art'] = o['art']
    if o.get('dyn') in DYN: d['dyn'] = o['dyn']
    return d

# ---------------------------------------------------------------- sílabas da letra (ortografia)
VW = set('aeiouáéíóúâêôãõàü')
def word_groups(notes):
    """Agrupa as notas em palavras (sílabas com início/fim de palavra) e sílabas (com melismas)."""
    syls = []
    for i, n in enumerate(notes):
        s = (n.get('s') or '').strip().lower()
        if s: syls.append({'s': s, 'wi': bool(n.get('wi')), 'wf': bool(n.get('wf')), 'notes': [i]})
        elif syls: syls[-1]['notes'].append(i)
        else: syls.append({'s': 'a', 'wi': True, 'wf': True, 'notes': [i], 'mel': True})
    words, cur = [], None
    known = any(x['wi'] or x['wf'] for x in syls)
    for sy in syls:
        if cur is None or (sy['wi'] if known else True): cur = []; words.append(cur)
        cur.append(sy)
        if not known or sy['wf']: cur = None
    return syls, words

# ---------------------------------------------------------------- fonemas (IPA do espeak) -> sílabas
IPA_V = set('aeiouɐɛɔəɪʊɨyøœæɑɒʌɤɯ')
GLIDE = set('jw')
MODS = set('ˈˌːˑ̯̩̃˞͡')
LIQ = set('ɾlrɹʎ')
OBS = set('pbtdkgfvcqɡ')
def merge_phones(al):
    """al: lista (símbolo, nº de amostras) do Piper -> lista de fones (texto, ini, fim) com marcas fundidas."""
    out, pos = [], 0
    for sym, ns in al:
        a, b = pos, pos + int(ns); pos = b
        if sym in ('^', '$', '_') or sym == '': continue
        if sym == ' ' or sym in ',.;:!?—-':
            out.append([' ', a, b]); continue
        if all(ch in MODS for ch in sym) and out and out[-1][0] != ' ':
            out[-1][0] += sym; out[-1][2] = b; continue
        if out and out[-1][0] and all(ch in MODS for ch in out[-1][0]) and out[-1][0] != ' ':
            out[-1][0] += sym; out[-1][2] = b; continue
        out.append([sym, a, b])
    return out
def kind(ph):
    base = ''.join(ch for ch in unicodedata.normalize('NFD', ph) if ch not in MODS and unicodedata.category(ch) != 'Mn')
    if not base: return 'm'
    if base[-1] in IPA_V: return 'v'
    if base[-1] in GLIDE or '̯' in ph: return 'g'
    return 'c'
def ipa_word_syllables(ph):
    """ph: fones de uma palavra -> lista de (onset, núcleo, coda) como intervalos de amostras."""
    ks = [kind(p[0]) for p in ph]
    runs, i = [], 0
    while i < len(ph):
        if ks[i] in 'vg':
            j = i
            while j < len(ph) and ks[j] in 'vg': j += 1
            if any(k == 'v' for k in ks[i:j]): runs.append([i, j])
            i = j
        else: i += 1
    if not runs: return []
    sy = []
    for r, (a, b) in enumerate(runs):
        prev_end = runs[r - 1][1] if r else 0
        cl = list(range(prev_end, a))
        if r == 0: on = cl
        else:
            if len(cl) >= 2 and ph[cl[-1]][0][0] in LIQ and ph[cl[-2]][0][0] in OBS: on = cl[-2:]
            else: on = cl[-1:]
            sy[-1]['coda'] = [x for x in cl if x not in on]
        sy.append({'on': on, 'nu': list(range(a, b)), 'coda': []})
    sy[-1]['coda'] = list(range(runs[-1][1], len(ph)))
    def span(ix, dflt):
        return (ph[ix[0]][1], ph[ix[-1]][2]) if ix else (dflt, dflt)
    res = []
    for s in sy:
        nu = span(s['nu'], 0); on = span(s['on'], nu[0]); co = span(s['coda'], nu[1])
        res.append((on[0], nu[0], nu[1], co[1]))
    return res

# ---------------------------------------------------------------- análise WORLD de um trecho falado
class Seg:
    """Uma sílaba falada: quadros WORLD e fronteiras (em quadros) de consoante inicial, vogal e consoante final."""
    __slots__ = ('f0', 'sp', 'ap', 'a', 'b', 'c', 'd')
def analyze(pw, x, fs, f0_ceil=600.0):
    x = np.asarray(x, np.float64)
    f0, t = pw.dio(x, fs, f0_floor=60.0, f0_ceil=f0_ceil, frame_period=FP)
    f0 = pw.stonemask(x, f0, t, fs)
    sp = pw.cheaptrick(x, f0, t, fs)
    ap = pw.d4c(x, f0, t, fs)
    return f0, sp.astype(np.float32), ap.astype(np.float32)
def energy_segments(f0, sp):
    """Sem alinhamento de fonemas: acha a vogal pela região sonora de maior energia."""
    e = np.log(sp.sum(1) + 1e-12); e = e - e.max(); n = len(e)
    act = np.where(e > -7.0)[0]
    if not len(act): return 0, 0, n, n
    lo, hi = int(act[0]), int(act[-1]) + 1
    v = (f0 > 0) & (e > -2.6)
    best, bi, i = (0, 0), 0, lo
    while i < hi:
        if v[i]:
            j = i
            while j < hi and v[j]: j += 1
            if j - i > best[1] - best[0]: best = (i, j)
            i = j
        else: i += 1
    a, b = best if best[1] > best[0] else (lo + (hi - lo) // 3, lo + 2 * (hi - lo) // 3)
    return lo, a, b, hi

# ---------------------------------------------------------------- tempo e dinâmica (igual ao navegador)
def phrases(notes, sp_beat, vd, R, ar=.9):
    art = vd['art'] if vd['art'] != 'auto' else ('legato' if ar >= .88 else 'normal')
    mean = sum(n['m'] for n in notes) / max(1, len(notes))
    lag = vd['lag'] * .028; maxph = 6.5 + vd['porta'] * 2
    ph, cur, on0 = [], None, -1.0
    for i, n in enumerate(notes):
        p = notes[i - 1] if i else None
        gap = n['t'] - (p['t'] + p['d']) if p else 9
        on = n['t'] * sp_beat + lag + (R() - .5) * 2 * vd['hum'] * .022
        brk = cur is None or gap >= .25 or (n.get('first') and (n['t'] * sp_beat - cur['st']) > maxph and len(cur['n']) > 2)
        if brk:
            if cur is not None and gap < .25: cur['n'][-1]['cut'] = min(.22, cur['n'][-1]['d'] * sp_beat * .35)
            cur = {'n': [], 'st': on}; ph.append(cur)
        if on < on0 + .035: on = on0 + .035
        on0 = on; n['on'] = on; n['f'] = mtof(n['m']); cur['n'].append(n)
    for pi, q in enumerate(ph):
        N = q['n']
        for i, n in enumerate(N):
            nx = N[i + 1] if i + 1 < len(N) else None
            end = (n['t'] + n['d']) * sp_beat
            n['off'] = nx['on'] if nx else end - .015 - n.get('cut', 0)
            n['stac'] = art == 'staccato'
            pos = i / (len(N) - 1) if len(N) > 1 else .5
            arc = 1 + vd['expr'] * .22 * (math.sin(math.pi * min(1, pos * 1.15)) - .5)
            pf = 1 + (n['m'] - mean) * .011 * (.5 + vd['expr'])
            acc = (1.14 if art == 'marcato' else 1.05) if n['t'] % 4 == 0 else (1 if n['t'] % 1 == 0 else (.9 if art == 'marcato' else .95))
            sf = 1 + vd['expr'] * .12 * ((pi / (len(ph) - 1) if len(ph) > 1 else .5) - .5)
            n['lvl'] = clamp(DYN[vd['dyn']] * arc * pf * acc * sf * (1 + (R() - .5) * .1 * vd['hum']), .2, 1.3)
        q['end'] = N[-1]['off']; q['rel'] = .42 if pi == len(ph) - 1 else .14 + vd['fall'] * .08
        q['gap'] = q['n'][0]['on'] - ph[pi - 1]['end'] if pi else 1.0
    return ph

# ---------------------------------------------------------------- curva de altura da partitura
def f0_curve(q, t0, nfr, vd, v, R):
    """f0 (Hz) por quadro para uma frase, a partir das notas, com o estilo da direção vocal."""
    fp = FP / 1000.0; N = q['n']
    tt = t0 + np.arange(nfr) * fp
    tgt = np.zeros(nfr); bounds = []
    gl = .014 + vd['porta'] * .15
    cents = np.zeros(nfr)
    for i, n in enumerate(N):
        lg = gl * (1 + min(1, abs(n['m'] - N[i - 1]['m']) / 12) * .6) if i else 0
        st = n['on'] - (lg * .55 if i else 0.0)
        bounds.append((st, n['m'], lg))
    m_now = np.full(nfr, float(N[0]['m']))
    for st, m, lg in bounds: m_now[tt >= st] = m
    # portamento: aproximação exponencial (como setTargetAtTime)
    sm = np.copy(m_now); cur = m_now[0]
    taus = np.full(nfr, max(.012, gl / 2.6))
    for st, m, lg in bounds[1:]:
        taus[(tt >= st) & (tt < st + lg * 3 + .05)] = max(.008, lg / 2.6)
    for k in range(nfr):
        a = 1 - math.exp(-fp / taus[k]); cur += (m_now[k] - cur) * a; sm[k] = cur
    # scoop no início da frase e depois de staccato
    sc = vd['scoop'] * 110 + 15
    for i, n in enumerate(N):
        if i == 0 or N[i - 1].get('stac'):
            d = (tt - (n['on'] - .03)); m = d >= 0
            cents[m] -= (sc if i == 0 else sc * .6) * np.exp(-d[m] / (.022 + vd['scoop'] * .04))
    # vibrato tardio, com profundidade e velocidade que variam um pouco
    depth = vd['vib'] * 62 + v.get('vib', 0) * 6
    vib_env = np.zeros(nfr); rate = np.full(nfr, vd['vibRate'])
    for i, n in enumerate(N):
        dur = n['off'] - n['on']; on = n['on']; m = (tt >= on) & (tt < n['off'] + .05)
        if not m.any(): continue
        if dur > .33:
            dl = min(vd['vibDelay'], dur * .5); ramp = .12 + vd['vibDelay'] * .25
            e = np.clip((tt[m] - on - dl) / ramp, 0, 1) ** 1.5 * (.85 + R() * .3)
            vib_env[m] = np.maximum(vib_env[m], .12 + e * .88)
        else: vib_env[m] = np.maximum(vib_env[m], .15)
        rate[m] = vd['vibRate'] * (.93 + R() * .14)
    phase = np.cumsum(2 * math.pi * rate * fp) + R() * 6.28
    cents += depth * vib_env * np.sin(phase)
    # deriva lenta e micro-instabilidade (voz humana nunca é reta)
    k = max(4, int(.16 / fp)); pts = np.array([R() * 2 - 1 for _ in range(nfr // k + 3)])
    xs = np.arange(nfr) / k; i0 = np.floor(xs).astype(int); w = (1 - np.cos(math.pi * (xs - i0))) / 2
    drift = pts[i0] * (1 - w) + pts[i0 + 1] * w
    cents += drift * (3 + vd['hum'] * 8 + (9 if (vd['rough'] or v.get('rough')) else 0))
    if vd['rough'] or v.get('rough'): cents += np.array([R() - .5 for _ in range(nfr)]) * 18
    # queda no fim da frase
    te = q['end']; m = tt > te - .03
    cents[m] -= (vd['fall'] * 160 + 8) * (1 - np.exp(-(tt[m] - (te - .03)) / (.05 + vd['fall'] * .09)))
    return 440.0 * 2 ** ((sm - 69) / 12.0) * 2 ** (cents / 1200.0)

# ---------------------------------------------------------------- envelope espectral: formantes, brilho, anel
def warp_sp(sp, alpha):
    """Desloca formantes: sp'(f) = sp(f/alpha)."""
    if abs(alpha - 1) < 1e-3: return sp
    nb = sp.shape[1]; src = np.arange(nb) / alpha
    i0 = np.clip(np.floor(src).astype(int), 0, nb - 1); i1 = np.clip(i0 + 1, 0, nb - 1); w = (src - np.floor(src))[None, :]
    lo = np.log(sp + 1e-16)
    out = np.exp(lo[:, i0] * (1 - w) + lo[:, i1] * w)
    out[:, src >= nb - 1] = sp[:, -1:] * 1e-3
    return out
def tilt_gain(nb, fs, db_oct, ring):
    f = np.linspace(0, fs / 2, nb); g = np.zeros(nb)
    oc = np.log2(np.maximum(f, 60) / 1000.0); g += db_oct * oc
    if ring: g += 6.0 * ring * np.exp(-((f - 2900) / 650) ** 2)
    return 10 ** (g / 10.0)  # potência

# ---------------------------------------------------------------- timbre importado (aproximado)
def mean_logspec(sp, f0):
    v = f0 > 0
    if v.sum() < 10: return None
    m = np.log(sp[v] + 1e-16).mean(0)
    c = np.fft.irfft(m); c[30:-30] = 0  # suavização cepstral (só o envelope)
    return np.fft.rfft(c).real[:len(m)]
def timbre_match(ref_ls, base_ls, fs):
    """Fator de formantes e equalização que aproximam a voz base do timbre de referência."""
    nb = len(base_ls); f = np.linspace(0, fs / 2, nb); band = (f > 200) & (f < 5000)
    best, ba = -1e9, 1.0
    for a in np.arange(.82, 1.30, .01):
        src = np.clip(np.arange(nb) / a, 0, nb - 1); w = np.interp(src, np.arange(nb), base_ls)
        x, y = w[band] - w[band].mean(), ref_ls[band] - ref_ls[band].mean()
        cc = float(np.dot(x, y) / (np.linalg.norm(x) * np.linalg.norm(y) + 1e-9))
        if cc > best: best, ba = cc, a
    src = np.clip(np.arange(nb) / ba, 0, nb - 1); w = np.interp(src, np.arange(nb), base_ls)
    eq = (ref_ls - ref_ls[band].mean()) - (w - w[band].mean())
    eq = np.clip(eq, -np.log(10 ** .8), np.log(10 ** .8))  # ±8 dB
    eq[f < 120] = 0
    return float(ba), np.exp(eq).astype(np.float32), best

# ---------------------------------------------------------------- respiração entre frases
def breath_noise(n, fs, R, amt):
    if n <= 0 or amt <= 0: return np.zeros(max(0, n))
    rs = np.random.RandomState(int(R() * 1e6))
    x = rs.randn(n)
    X = np.fft.rfft(x); f = np.fft.rfftfreq(n, 1 / fs)
    X *= np.exp(-((f - 1800) / 1400) ** 2) + .25 * np.exp(-((f - 4500) / 1800) ** 2)
    x = np.fft.irfft(X, n); x /= (np.abs(x).max() + 1e-9)
    t = np.linspace(0, 1, n); env = np.sin(np.pi * np.clip(t * 1.15, 0, 1)) ** 1.6
    return x * env * .05 * amt

# ---------------------------------------------------------------- renderização de uma linha vocal
def render_line(pw, tts, notes, bpm, vd, v, seed, timbre=None, progress=None, fs_out=None, alpha_extra=1.0, ar=.9):
    """notes: [{t,d,m,s,wi,wf}] em tempos; devolve (áudio float32, fs, início em segundos)."""
    vd = clean_vd(vd or {}); R = Rng(seed or 1); fs = tts.sample_rate; fp = FP / 1000.0
    notes = sorted([dict(n) for n in notes if n.get('d', 0) > 0], key=lambda n: n['t'])
    if not notes: return np.zeros(1, np.float32), fs, 0.0
    syls, words = word_groups(notes)
    for sy in syls: notes[sy['notes'][0]]['first'] = True
    sp_beat = 60.0 / max(30, min(260, float(bpm or 100)))
    PH = phrases(notes, sp_beat, vd, R, ar)
    # 1) fala: cada palavra uma vez (com cache), separada em sílabas
    units = speak_words(pw, tts, words, progress)
    for sy, u in zip(syls, units): sy['u'] = u
    note_syl = {}
    for si, sy in enumerate(syls):
        for k, ni in enumerate(sy['notes']): note_syl[ni] = (si, k)
    # 2) timbre
    alpha = clamp(float(v.get('f', 1.0)) / tts.base_f, .82, 1.32) * alpha_extra
    eq = None
    if timbre is not None: alpha, eq = timbre['alpha'] * alpha_extra, timbre['eq']
    breath = clamp(vd['breath'] * .9 + float(v.get('breath', 0) or 0) * .25, 0, 1)
    start = min(0.0, PH[0]['n'][0]['on'] - .6)
    total = PH[-1]['end'] + 1.2 - start
    out = np.zeros(int(total * fs) + fs, np.float64)
    idx_of = {id(n): i for i, n in enumerate(notes)}
    for pi, q in enumerate(PH):
        if progress: progress(.35 + .6 * pi / len(PH), 'Cantando a frase %d de %d' % (pi + 1, len(PH)))
        N = q['n']; ids = [idx_of[id(n)] for n in N]
        # sílabas da frase, na ordem, com seu intervalo de notas
        seq = []
        for ni in ids:
            si, k = note_syl[ni]
            if k == 0 or not seq or seq[-1]['si'] != si: seq.append({'si': si, 'notes': [ni]})
            else: seq[-1]['notes'].append(ni)
        # tempos de cada pedaço (consoante inicial antes do tempo, vogal, consoante final)
        dic = .75 + .5 * vd['diction']
        for j, it in enumerate(seq):
            u = syls[it['si']]['u']; n0 = notes[it['notes'][0]]; nl = notes[it['notes'][-1]]
            od = (u.b - u.a) * fp * dic if n0.get('first') else 0.0
            cd = (u.d - u.c) * fp * dic
            it.update(on=n0['on'], end=nl['off'], od=min(od, .16), cd=min(cd, .14), u=u)
        for j, it in enumerate(seq):
            nxt = seq[j + 1] if j + 1 < len(seq) else None
            lim = (nxt['on'] - nxt['od']) if nxt else it['end'] + q['rel'] * .55
            room = lim - it['on']
            if it['cd'] > room * .45: it['cd'] = max(0.0, room * .45)
            it['nend'] = lim - it['cd']
            if j > 0:
                prv = seq[j - 1]; avail = it['on'] - (prv['on'] + .05)
                if it['od'] > avail * .6: it['od'] = max(.012, avail * .6)
        t0 = seq[0]['on'] - seq[0]['od'] - .02
        t1 = q['end'] + q['rel'] + .05
        nfr = int(math.ceil((t1 - t0) / fp)) + 1
        nb = seq[0]['u'].sp.shape[1]
        SP = np.full((nfr, nb), 1e-12, np.float64); AP = np.ones((nfr, nb), np.float64)
        VOI = np.zeros(nfr, bool); G = np.zeros(nfr); NUC = np.zeros(nfr, bool)
        tt = t0 + np.arange(nfr) * fp
        def place(u, s_a, s_b, o_a, o_b, nucleus):
            """Mapeia os quadros falados [s_a,s_b) para o intervalo de tempo [o_a,o_b)."""
            k0 = int(max(0, math.floor((o_a - t0) / fp))); k1 = int(min(nfr, math.ceil((o_b - t0) / fp)))
            if k1 <= k0 or s_b <= s_a: return
            L = s_b - s_a; M = k1 - k0
            if nucleus and L >= 8 and M > L:
                e = min(6, L // 4)  # transições naturais nas pontas, miolo esticado
                pos = np.empty(M); hold = M - 2 * e
                pos[:e] = s_a + np.arange(e); pos[M - e:] = s_b - e + np.arange(e)
                mid_a, mid_b = s_a + e, s_b - e - 1
                if hold > 0: pos[e:M - e] = np.linspace(mid_a, mid_b, hold)
            else:
                pos = s_a + (np.arange(M) + .5) * L / M - .5
            pos = np.clip(pos, s_a, s_b - 1); i0 = np.floor(pos).astype(int); i1 = np.minimum(i0 + 1, s_b - 1); w = (pos - i0)[:, None]
            lsp = np.log(u.sp[i0].astype(np.float64) + 1e-16) * (1 - w) + np.log(u.sp[i1].astype(np.float64) + 1e-16) * w
            SP[k0:k1] = np.exp(lsp); AP[k0:k1] = u.ap[i0] * (1 - w) + u.ap[i1] * w
            VOI[k0:k1] = nucleus | (u.f0[i0] > 0); NUC[k0:k1] |= nucleus
        for j, it in enumerate(seq):
            u = it['u']
            if it['od'] > 0: place(u, u.a, u.b, it['on'] - it['od'], it['on'], False)
            place(u, u.b, u.c, it['on'], it['nend'], True)
            if it['cd'] > 0: place(u, u.c, u.d, it['nend'], it['nend'] + it['cd'], False)
        # cauda: sustenta o fim da última vogal durante o release
        last = seq[-1]; kE = int(min(nfr, math.ceil((last['nend'] + last['cd'] - t0) / fp)))
        # dinâmica por quadro
        lv = np.zeros(nfr); pre = {}
        for it in seq: pre[it['notes'][0]] = it['od'] + .012
        st_of = [n['on'] - pre.get(ids[i], .03) for i, n in enumerate(N)]
        for i, n in enumerate(N):
            m = (tt >= st_of[i]) & (tt < (st_of[i + 1] if i + 1 < len(N) else t1))
            lv[m] = n['lvl']
            if n.get('stac'): lv[(tt >= n['on'] + (n['off'] - n['on']) * .5) & m] = 0.0
            dur = n['off'] - n['on']
            if dur > .9: lv[m & (tt > n['on'] + dur * .4)] *= 1 + .09 * vd['expr']
        k = int(.025 / fp)
        if k > 1: lv = np.convolve(lv, np.ones(k) / k, mode='same')
        att = int((.012 if vd['art'] == 'marcato' else .055 if vd['art'] == 'legato' else .035) / fp) + 1
        ramp = np.ones(nfr); a0 = int(max(0, (seq[0]['on'] - seq[0]['od'] - t0) / fp)); ramp[:a0] = 0
        ramp[a0:a0 + att] = np.linspace(0, 1, len(ramp[a0:a0 + att]))
        rel = int(q['rel'] / fp); e0 = int((q['end'] - t0) / fp)
        ramp[e0:] = np.exp(-np.arange(nfr - e0) / max(1, rel / 3))
        G = lv * ramp
        kc = int(max(0, (last['nend'] - t0) / fp))
        if last['cd'] > 0: G[kc:kE] = np.maximum(G[kc:kE], N[-1]['lvl'] * .55)
        # altura da partitura nos quadros sonoros
        F0 = f0_curve(q, t0, nfr, vd, v, R)
        F0[~VOI] = 0.0
        F0[(tt > q['end'] + q['rel'])] = 0.0
        # timbre, brilho, anel, sopro
        SPw = warp_sp(SP, alpha)
        if eq is not None: SPw *= eq[None, :]
        for kk in range(0, nfr, 40):
            sl = slice(kk, min(nfr, kk + 40)); gm = float(np.mean(G[sl])) if (G[sl] > 0).any() else .8
            SPw[sl] *= tilt_gain(nb, fs, (gm - .8) * 3.5 + (vd['bright'] - .5) * 5, vd['ring'])[None, :]
        SPw *= (G ** 2)[:, None] + 1e-6
        if breath > .03:
            fw = np.clip(np.linspace(0, fs / 2, nb) / 2500.0, .25, 1)[None, :]
            AP = 1 - (1 - AP) * (1 - breath * .75 * fw)
        AP = np.clip(AP, 0, 1)
        y = pw.synthesize(F0, np.ascontiguousarray(SPw), np.ascontiguousarray(AP), fs, FP)
        o = int((t0 - start) * fs); y = y[:max(0, len(out) - o)]
        fd = min(len(y), int(.012 * fs)); y[:fd] *= np.linspace(0, 1, fd); y[len(y) - fd:] *= np.linspace(1, 0, fd)
        out[o:o + len(y)] += y
        # respiração antes da frase, proporcional ao volume da própria frase
        if vd['breathIn'] > 0 and q['gap'] > .28:
            bd = min(.45, q['gap'] * .7); bend = t0 - .03; bstart = max(start, bend - bd); nbs = int((bend - bstart) * fs)
            if nbs > int(.12 * fs):
                act = y[np.abs(y) > 1e-4]; rms = float(np.sqrt(np.mean(act ** 2))) if len(act) else 0.0
                bo = int((bstart - start) * fs); out[bo:bo + nbs] += breath_noise(nbs, fs, R, 1.0) / .05 * rms * .22 * vd['breathIn'] * (.75 + R() * .4)
    # 3) acabamento: passa-alta suave, normalização e reamostragem opcional
    out = out[:int((PH[-1]['end'] + 1.0 - start) * fs)]
    from scipy.signal import butter, sosfilt
    out = sosfilt(butter(2, 70, 'highpass', fs=fs, output='sos'), out)
    pk = np.abs(out).max() + 1e-9; out = out / pk * .89
    if fs_out and fs_out != fs:
        from scipy.signal import resample_poly
        g = math.gcd(fs_out, fs); out = resample_poly(out, fs_out // g, fs // g); fs = fs_out
    return out.astype(np.float32), fs, start

# ---------------------------------------------------------------- fala das palavras com cache
_CACHE = {}
def _cache_put(k, v):
    _CACHE[k] = v
    if len(_CACHE) > 400:
        for kk in list(_CACHE)[:100]: _CACHE.pop(kk, None)
def speak_words(pw, tts, words, progress=None):
    """Devolve, na ordem das sílabas, objetos Seg (quadros WORLD + fronteiras)."""
    units = []
    for wi, w in enumerate(words):
        key = ('|'.join(s['s'] for s in w), tts.key)
        if key not in _CACHE:
            if progress: progress(.05 + .3 * wi / max(1, len(words)), 'Lendo a letra: “%s”' % ''.join(s['s'] for s in w))
            _cache_put(key, _speak_word(pw, tts, [s['s'] for s in w]))
        units.extend(_CACHE[key])
    return units
def _mk(f0, sp, ap, a, b, c, d):
    s = Seg(); s.f0, s.sp, s.ap = f0, sp, ap
    n = len(f0); a = clamp(a, 0, n - 1); b = clamp(b, a, n - 1); c = clamp(c, b + 1, n); d = clamp(d, c, n)
    if c - b < 3: b = max(a, b - 1); c = min(n, c + 1)
    s.a, s.b, s.c, s.d = int(a), int(b), int(c), int(d); return s
def _speak_word(pw, tts, sylls):
    word = ''.join(sylls); fs = tts.sample_rate; hop = fs * FP / 1000.0
    x, al = tts.speak(word)
    if al and len(sylls) >= 1:
        ph = [p for p in merge_phones(al) if p[0] != ' ']
        sy = ipa_word_syllables(ph)
        if len(sy) == len(sylls):
            f0, sp, ap = analyze(pw, x, fs)
            return [_mk(f0, sp, ap, int(a / hop), int(b / hop), int(math.ceil(c / hop)), int(math.ceil(d / hop))) for a, b, c, d in sy]
    # sem alinhamento (ou contagem diferente): fala sílaba por sílaba e acha a vogal pela energia
    res = []
    for s in sylls:
        xs, _ = tts.speak(s)
        f0, sp, ap = analyze(pw, xs, fs)
        a, b, c, d = energy_segments(f0, sp)
        res.append(_mk(f0, sp, ap, a, b, c, d))
    return res

# ---------------------------------------------------------------- timbre de referência (amostra do usuário)
CALIB = 'a vida é bela quando a gente canta junto, o mar e o luar iluminam a canção'
_BASE = {}
def base_logspec(pw, tts):
    if tts.key not in _BASE:
        x, _ = tts.speak(CALIB); f0, sp, ap = analyze(pw, x, tts.sample_rate)
        _BASE[tts.key] = mean_logspec(sp.astype(np.float64), f0)
    return _BASE[tts.key]
_REF = {}
def load_ref(pw, tts, path, fs_ref, x):
    """x: amostra mono float da voz importada. Devolve {'alpha','eq','f0','score'} ou None."""
    import os
    k = (path, os.path.getmtime(path) if os.path.exists(path) else 0, tts.key)
    if k in _REF: return _REF[k]
    fs = tts.sample_rate
    if fs_ref != fs:
        from scipy.signal import resample_poly
        g = math.gcd(fs, fs_ref); x = resample_poly(x, fs // g, fs_ref // g)
    x = np.asarray(x[:fs * 25], np.float64)
    f0, t = pw.harvest(x, fs, f0_floor=60.0, f0_ceil=900.0, frame_period=FP)
    sp = pw.cheaptrick(x, f0, t, fs)
    ref = mean_logspec(sp, f0); base = base_logspec(pw, tts)
    if ref is None or base is None: _REF[k] = None; return None
    a, eq, sc = timbre_match(ref, base, fs)
    r = {'alpha': a, 'eq': eq, 'f0': float(np.median(f0[f0 > 0])), 'score': sc}
    _REF[k] = r; return r
