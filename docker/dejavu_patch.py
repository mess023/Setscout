"""Patch bcollazo/dejavu (2020, pinned commit) for Python 3.13 / numpy 2 / SQLAlchemy 2 / SciPy 2.

Each replacement must match, so the image build fails loudly if the source ever differs.
Usage: python3 dejavu_patch.py /opt/dejavu/dejavu
"""
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
PATCHES = {
    "database.py": [("Boolean, Binary, ForeignKey", "Boolean, ForeignKey")],  # Binary removed in SQLAlchemy 1.4; unused
    "decoder.py": [("np.fromstring(", "np.frombuffer(")],                     # fromstring removed in numpy 2
    "wavio.py": [("_np.fromstring(", "_np.frombuffer("), (".tostring()", ".tobytes()")],
    "fingerprint.py": [("scipy.ndimage.filters", "scipy.ndimage"), ("scipy.ndimage.morphology", "scipy.ndimage")],
    "recognize.py": [  # PyAudio is only needed for microphone recognition, which Setscout doesn't use
        ("\nimport pyaudio\n", "\ntry:\n    import pyaudio\nexcept ImportError:\n    pyaudio = None\n"),
        ("default_format = pyaudio.paInt16", "default_format = 8  # pyaudio.paInt16"),
    ],
}
for name, reps in PATCHES.items():
    f = root / name
    src = f.read_text(encoding="utf-8")
    for old, new in reps:
        assert old in src, f"{name}: '{old}' not found"
        src = src.replace(old, new)
    f.write_text(src, encoding="utf-8")
    print("patched", name)
