"""Conversão opcional de timbre por GPU externa (Seed-VC, conversão de canto zero-shot condicionada pela altura).

O canto já sai afinado e com a interpretação do WORLD; aqui só se troca o timbre pelo da amostra importada.
Ligue com CANTO_GPU no .env:
  CANTO_GPU=hf         usa um Space do Hugging Face com Seed-VC (CANTO_GPU_SPACE, padrão Plachta/Seed-VC; HF_TOKEN opcional)
  CANTO_GPU=replicate  usa um modelo do Replicate (REPLICATE_API_TOKEN, CANTO_GPU_REPLICATE_VERSION e
                       CANTO_GPU_REPLICATE_INPUT, um JSON com {source} e {reference} nos campos de áudio)
Se falhar, o serviço entrega o canto WORLD (que já tem o timbre aproximado) e avisa o motivo."""
import json, os, time, urllib.request, tempfile, shutil

def provider():
    p = os.environ.get('CANTO_GPU', '').strip().lower()
    if p == 'hf': return 'hf'
    if p == 'replicate' and os.environ.get('REPLICATE_API_TOKEN') and os.environ.get('CANTO_GPU_REPLICATE_VERSION'): return 'replicate'
    return ''

def convert(src_wav, ref_wav, timeout=300):
    """Devolve o caminho de um WAV convertido (ou levanta exceção)."""
    p = provider()
    if p == 'hf': return _hf(src_wav, ref_wav)
    if p == 'replicate': return _replicate(src_wav, ref_wav, timeout)
    raise RuntimeError('GPU externa não configurada')

def _hf(src, ref):
    from gradio_client import Client, handle_file
    space = os.environ.get('CANTO_GPU_SPACE', 'Plachta/Seed-VC')
    tok = os.environ.get('HF_TOKEN') or None
    try: cl = Client(space, hf_token=tok, verbose=False)
    except TypeError: cl = Client(space, hf_token=tok)
    api = cl.view_api(return_format='dict', print_info=False)
    eps = dict(api.get('named_endpoints', {}))
    pick = os.environ.get('CANTO_GPU_ENDPOINT', '')
    def score(name, ep):
        ps = ep.get('parameters', []); labels = ' '.join(str(x.get('label', '')) for x in ps).lower()
        aud = sum(1 for x in ps if 'audio' in str(x.get('component', '')).lower() or 'filepath' in json.dumps(x.get('type', '')).lower())
        return (aud >= 2) * 10 + ('f0' in labels) * 5 + ('diffusion' in labels) * 2 + ('svc' in name or 'sing' in labels) * 1
    name = pick or max(eps, key=lambda n: score(n, eps[n])) if eps else None
    if not name: raise RuntimeError('Space sem endpoints utilizáveis')
    args, n_audio = [], 0
    for prm in eps[name].get('parameters', []):
        lab = str(prm.get('label', '')).lower(); comp = str(prm.get('component', '')).lower()
        if 'audio' in comp or 'file' in comp:
            args.append(handle_file(src if n_audio == 0 else ref)); n_audio += 1
        elif 'diffusion' in lab: args.append(int(os.environ.get('CANTO_GPU_STEPS', '30')))
        elif 'length' in lab: args.append(1.0)
        elif 'cfg' in lab or 'rate' in lab: args.append(.7)
        elif 'auto' in lab and 'f0' in lab: args.append(False)
        elif 'f0' in lab or 'pitch condition' in lab: args.append(True)
        elif 'semi' in lab or 'pitch' in lab or 'shift' in lab: args.append(0)
        elif 'checkbox' in comp: args.append(False)
        else: args.append(prm.get('parameter_default', prm.get('example_input')))
    res = cl.predict(*args, api_name=name)
    files = []
    def walk(r):
        if isinstance(r, str) and os.path.exists(r): files.append(r)
        elif isinstance(r, dict):
            for k in ('path', 'name', 'value'): walk(r.get(k))
        elif isinstance(r, (list, tuple)):
            for x in r: walk(x)
    walk(res)
    if not files: raise RuntimeError('Space não devolveu áudio')
    return files[-1]

def _replicate(src, ref, timeout):
    tok = os.environ['REPLICATE_API_TOKEN']; H = {'Authorization': 'Bearer ' + tok}
    def up(path):
        b = open(path, 'rb').read(); bd = '----melodia%d' % int(time.time() * 1000)
        body = ('--%s\r\nContent-Disposition: form-data; name="content"; filename="%s"\r\nContent-Type: audio/wav\r\n\r\n' % (bd, os.path.basename(path))).encode() + b + ('\r\n--%s--\r\n' % bd).encode()
        rq = urllib.request.Request('https://api.replicate.com/v1/files', data=body, headers=dict(H, **{'Content-Type': 'multipart/form-data; boundary=' + bd}))
        return json.load(urllib.request.urlopen(rq, timeout=120))['urls']['get']
    tmpl = os.environ.get('CANTO_GPU_REPLICATE_INPUT', '{"source_audio":"{source}","target_audio":"{reference}","f0_condition":true}')
    inp = json.loads(tmpl.replace('{source}', up(src)).replace('{reference}', up(ref)))
    rq = urllib.request.Request('https://api.replicate.com/v1/predictions', data=json.dumps({'version': os.environ['CANTO_GPU_REPLICATE_VERSION'], 'input': inp}).encode(),
                                headers=dict(H, **{'Content-Type': 'application/json', 'Prefer': 'wait=60'}))
    pr = json.load(urllib.request.urlopen(rq, timeout=90)); t0 = time.time()
    while pr.get('status') not in ('succeeded', 'failed', 'canceled'):
        if time.time() - t0 > timeout: raise RuntimeError('Tempo esgotado na GPU externa')
        time.sleep(3); pr = json.load(urllib.request.urlopen(urllib.request.Request(pr['urls']['get'], headers=H), timeout=60))
    if pr['status'] != 'succeeded': raise RuntimeError('GPU externa falhou: %s' % (pr.get('error') or pr['status']))
    out = pr['output']; out = out[-1] if isinstance(out, list) else (out.get('audio') if isinstance(out, dict) else out)
    f = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    with urllib.request.urlopen(urllib.request.Request(out, headers=H), timeout=120) as r: shutil.copyfileobj(r, f)
    f.close(); return f.name
