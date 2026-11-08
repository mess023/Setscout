"""Setscout NAFP worker: neural audio fingerprinting with the pretrained NeuralFP / PeakNetFP checkpoints.

Runs in its own container (TensorFlow 2.15 needs Python <= 3.11). Setscout talks to it over the compose network:

    GET  /health                       -> {"ok": true, "models": [...], "indexed": {"neuralfp": n, ...}}
    POST /index?model=neuralfp         JSON {"files": ["/music/a.mp3", ...]}  -> {"indexed": n}
    POST /query?model=neuralfp         body = audio bytes (Setscout's 16 kHz wav) -> {"path", "score", "offset"} | null

Index per model in $NAFP_DATA/<model>/: one .npy of 128-d embeddings per file (1 s windows, 0.5 s hop) + files.json.
Search: FAISS inner product over all windows, then each query window votes for (file, offset); best vote wins.
score = share of query windows that agree on that file and offset (0..1). CPU only.
"""
import hashlib
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np

HOME = os.environ.get("PEAKNETFP_HOME", "/opt/peaknetfp")
sys.path.insert(0, HOME)
DATA = os.environ.get("NAFP_DATA", "/data/nafp")
PORT = int(os.environ.get("NAFP_PORT", "8099"))
FS, WIN, HOP = 8000, 8000, 4000  # 1 s window, 0.5 s hop at 8 kHz (fixed by the checkpoints)
CONFIGS = {"neuralfp": "neuralfp.yaml", "peaknetfp": "peaknetfp.yaml"}
LOCK = threading.Lock()
_embedders, _search = {}, {}


def find_checkpoint_dir(name):
    """The Zenodo tarball's layout isn't documented: find the folder <name>/ that holds a 'checkpoint' file."""
    for root, _dirs, files in os.walk(os.path.join(HOME, "ckpt")):
        if os.path.basename(root) == name and "checkpoint" in files:
            return root
    raise FileNotFoundError(f"checkpoint '{name}' not found under {HOME}/ckpt")


def embedder(name):
    if name in _embedders:
        return _embedders[name]
    import tensorflow as tf
    import yaml
    n = int(os.environ.get("NAFP_THREADS", "0"))
    if n:
        tf.config.threading.set_intra_op_parallelism_threads(n)
    cfg = yaml.safe_load(open(os.path.join(HOME, "config", CONFIGS[name])))
    from model.fp.melspec.melspectrogram import get_melspec_layer
    from model.fp.nnfp import get_fingerprinter
    mel, fp = get_melspec_layer(cfg, trainable=False), get_fingerprinter(cfg, trainable=False)
    ckpt = tf.train.latest_checkpoint(find_checkpoint_dir(cfg["CHECKPOINT_NAME"]))
    tf.train.Checkpoint(model=fp).restore(ckpt).expect_partial()
    peaks = None
    if cfg["MODEL"]["ARCH"] == "pointnet2":
        from model.trainer import get_peaks_from_mel as peaks

    @tf.function
    def run(x):  # (B, 1, 8000) float32
        m = mel(x)
        return fp(peaks(m, cfg) if peaks else m)

    def embed(frames):
        out = [run(tf.constant(frames[i:i + 256])).numpy() for i in range(0, len(frames), 256)]
        e = np.concatenate(out).astype("float32")
        return e / np.maximum(np.linalg.norm(e, axis=1, keepdims=True), 1e-9)

    _embedders[name] = embed
    return embed


def decode(src, data=None):
    """Any audio (path, or bytes on stdin) -> float32 mono 8 kHz."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0" if data is not None else src,
                        "-ac", "1", "-ar", str(FS), "-f", "f32le", "pipe:1"],
                       input=data, capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype="float32")


def frames(sig):
    if len(sig) < WIN:
        sig = np.pad(sig, (0, WIN - len(sig)))
    n = 1 + (len(sig) - WIN) // HOP
    return np.stack([sig[i * HOP:i * HOP + WIN] for i in range(n)])[:, None, :]


def store(name):
    d = os.path.join(DATA, name)
    os.makedirs(d, exist_ok=True)
    f = os.path.join(d, "files.json")
    files = json.load(open(f)) if os.path.exists(f) else {}
    return d, f, files


def index(name, paths):
    """Each file on its own: one unreadable file must not cost the rest of the batch."""
    d, f, files = store(name)
    embed = embedder(name)
    done, failed = 0, []
    for p in paths:
        try:
            e = embed(frames(decode(p)))
            npy = hashlib.sha1(p.encode()).hexdigest() + ".npy"
            np.save(os.path.join(d, npy), e)
            files[p] = {"npy": npy, "n": int(len(e))}
            json.dump(files, open(f, "w"))
            done += 1
        except subprocess.CalledProcessError as ex:
            failed.append({"file": p, "error": "ffmpeg: " + ex.stderr.decode(errors="replace").strip()[-200:]})
        except Exception as ex:
            failed.append({"file": p, "error": f"{type(ex).__name__}: {ex}"[:300]})
    _search.pop(name, None)  # rebuild the search index on the next query
    return {"indexed": done, "failed": failed}


def searcher(name):
    """ponytail: flat inner-product index in RAM (~1 KB per second of music, i.e. ~0.7 GB per 1,000 tracks);
    switch to faiss IVF-PQ if collections get much larger."""
    if name in _search:
        return _search[name]
    import faiss
    d, _f, files = store(name)
    paths, embs, rowfile, rowtime = list(files), [], [], []
    for i, p in enumerate(paths):
        e = np.load(os.path.join(d, files[p]["npy"]))
        embs.append(e)
        rowfile.append(np.full(len(e), i))
        rowtime.append(np.arange(len(e)) * HOP / FS)
    if not embs:
        return None
    idx = faiss.IndexFlatIP(embs[0].shape[1])
    idx.add(np.concatenate(embs))
    _search[name] = (idx, paths, np.concatenate(rowfile), np.concatenate(rowtime))
    return _search[name]


def query(name, audio, k=10):
    s = searcher(name)
    if not s:
        return None
    idx, paths, rowfile, rowtime = s
    q = embedder(name)(frames(decode(None, audio)))
    _sim, nn = idx.search(q, k)
    votes = {}
    for i, row in enumerate(nn):
        seen = set()
        for r in row:
            if r < 0:
                continue
            key = (int(rowfile[r]), int(round((rowtime[r] - i * HOP / FS) / (HOP / FS))))
            if key not in seen:
                seen.add(key)
                votes[key] = votes.get(key, 0) + 1
    if not votes:
        return None
    (fi, slot), n = max(votes.items(), key=lambda kv: kv[1])
    return {"path": paths[fi], "score": round(n / len(q), 3), "offset": slot * HOP / FS}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path != "/health":
            return self._send(404, {"error": "not found"})
        indexed = {m: len(store(m)[2]) for m in CONFIGS}
        self._send(200, {"ok": True, "models": list(CONFIGS), "indexed": indexed})

    def do_POST(self):
        u = urlparse(self.path)
        name = parse_qs(u.query).get("model", ["neuralfp"])[0]
        if name not in CONFIGS:
            return self._send(400, {"error": f"unknown model {name}"})
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            with LOCK:  # one TensorFlow job at a time
                if u.path == "/index":
                    return self._send(200, index(name, json.loads(body)["files"]))
                if u.path == "/query":
                    return self._send(200, query(name, body))
            self._send(404, {"error": "not found"})
        except subprocess.CalledProcessError as e:
            self._send(422, {"error": "ffmpeg: " + e.stderr.decode(errors="replace").strip()[-300:]})
        except Exception as e:  # report, keep serving
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    if len(sys.argv) > 1:  # CLI for the build-time test: index <model> <files...> | query <model> <file>
        cmd, name = sys.argv[1], sys.argv[2]
        if cmd == "index":
            print(json.dumps(index(name, sys.argv[3:])))
        else:
            print(json.dumps(query(name, open(sys.argv[3], "rb").read())))
    else:
        print(f"NAFP worker on :{PORT}, data in {DATA}", flush=True)
        HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
