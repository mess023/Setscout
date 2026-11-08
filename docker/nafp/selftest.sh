#!/bin/sh
# Build-time functional test for the NAFP worker (no music needed).
# Two synthetic "tracks": a non-repeating sequence of tones (new pseudo-random pitch every 250 ms) plus a little
# pink noise, indexed at 44.1 kHz. A 16 kHz excerpt of track B from 15 s (like Setscout sends) must come back as
# track B. NeuralFP must also get the offset right (±1 s, score ≥ 0.3); PeakNetFP's result is printed — its
# offsets on synthetic audio were unreliable, so only the file is checked there.
set -e
cd /tmp
tones() { # $1 = seed constant
  echo "0.5*sin(2*PI*(200+700*(sin(floor(t*4)*$1)*43758.5453-floor(sin(floor(t*4)*$1)*43758.5453)))*t)"
}
ffmpeg -v error -f lavfi -i "aevalsrc=$(tones 12.9898):d=40" -f lavfi -i "anoisesrc=d=40:c=pink:seed=3:a=0.05" -filter_complex amix=inputs=2 -ar 44100 a.wav
ffmpeg -v error -f lavfi -i "aevalsrc=$(tones 78.233):d=40" -f lavfi -i "anoisesrc=d=40:c=pink:seed=11:a=0.05" -filter_complex amix=inputs=2 -ar 44100 b.wav
ffmpeg -v error -ss 15 -t 10 -i b.wav -ar 16000 -ac 1 q.wav
for m in neuralfp peaknetfp; do
  # a broken file in the middle of the batch: only that one may fail, the others must be indexed
  echo "not audio" > /tmp/broken.mp3
  NAFP_DATA=/tmp/nafp python /app/nafp_worker.py index $m /tmp/a.wav /tmp/broken.mp3 /tmp/b.wav > /tmp/i.json
  python - "$m" <<'PY'
import json, sys
r = json.load(open("/tmp/i.json"))
assert r["indexed"] == 2 and [f["file"] for f in r["failed"]] == ["/tmp/broken.mp3"], (sys.argv[1], r)
PY
  NAFP_DATA=/tmp/nafp python /app/nafp_worker.py query $m /tmp/q.wav > /tmp/r.json
  python - "$m" <<'PY'
import json, sys
m, r = sys.argv[1], json.load(open("/tmp/r.json"))
assert r and r["path"] == "/tmp/b.wav", (m, r)
if m == "neuralfp":
    assert abs(r["offset"] - 15) <= 1 and r["score"] >= 0.3, (m, r)
print(m, "ok", r)
PY
done
rm -rf /tmp/nafp /tmp/*.wav /tmp/broken.mp3 /tmp/r.json /tmp/i.json
