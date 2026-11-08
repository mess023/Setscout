"""Setscout <-> Dejavu (bcollazo fork: SQLAlchemy, so SQLite and no database server).

    python dejavu_cli.py index <db.sqlite> <file> [<file> ...]   -> {"indexed": n}
    python dejavu_cli.py query <db.sqlite> <clip.wav>             -> {"path", "confidence", "offset"} or null

Dejavu's hashes depend on the sample rate (FFT bins), and Setscout's fragments are 16 kHz while music files
are 44.1/48 kHz, so every input is first converted to 44.1 kHz mono with ffmpeg (in DEJAVU_TMP).
The full file path is stored as the song name, so Setscout can read the tags of the matched file.
"""
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.environ.get("DEJAVU_HOME", "/opt/dejavu"))
os.environ.setdefault("MPLBACKEND", "Agg")

from dejavu import Dejavu  # noqa: E402
from dejavu.recognize import FileRecognizer  # noqa: E402

TMP = os.environ.get("DEJAVU_TMP") or tempfile.gettempdir()
os.makedirs(TMP, exist_ok=True)


def to44k(path):
    fd, out = tempfile.mkstemp(suffix=".wav", dir=TMP)
    os.close(fd)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", out], check=True)
    return out


cmd, db = sys.argv[1], sys.argv[2]
djv = Dejavu(dburl="sqlite:///" + os.path.abspath(db))
if cmd == "index":
    for f in sys.argv[3:]:
        wav = to44k(f)
        try:
            djv.fingerprint_file(wav, song_name=os.path.abspath(f))
        finally:
            os.remove(wav)
    print(json.dumps({"indexed": len(sys.argv) - 3}))
elif cmd == "query":
    wav = to44k(sys.argv[3])
    try:
        m = djv.recognize(FileRecognizer, wav)
    finally:
        os.remove(wav)
    print(json.dumps(m and {"path": m["song_name"], "confidence": m["confidence"], "offset": m["offset_seconds"]}))
else:
    sys.exit("usage: dejavu_cli.py index|query <db> <files>")
