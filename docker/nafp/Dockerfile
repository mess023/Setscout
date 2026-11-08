# Setscout NAFP worker — neural audio fingerprinting (NeuralFP / PeakNetFP), CPU only.
# Separate image because TensorFlow 2.15 (what the checkpoints were made with) needs Python <= 3.11.
# Code: guillemcortes/peaknetfp (CC BY-NC-SA 4.0, non-commercial). Checkpoints: Zenodo 15782389 (MIT).
FROM python:3.11.18-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg sox curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# versions from the project's environment.yml (TF 2.15.1, kapre 0.3.7, numpy < 2), CPU builds
# kapre 0.3.7's metadata claims numpy>=2, which conflicts with TF 2.15 (numpy<2) → install it without deps
RUN pip install --no-cache-dir "tensorflow-cpu==2.15.1" "numpy<2" "sox==1.4.1" \
      "faiss-cpu==1.8.0.post1" pyyaml pandas matplotlib click \
    && pip install --no-cache-dir --no-deps "kapre==0.3.7"

ARG PEAKNETFP_COMMIT=d55071a644f20fd6448fb8ed33c0c115769fb7a5
RUN mkdir -p /opt/peaknetfp \
    && curl -fsSL https://github.com/guillemcortes/peaknetfp/archive/${PEAKNETFP_COMMIT}.tar.gz \
       | tar -xz --strip-components=1 -C /opt/peaknetfp

# Pretrained checkpoints (155 MB). md5 is what Zenodo publishes; sha256 pinned after the first CI build.
ARG CKPT_MD5=df23e1556a206fd72bfa99d0724d241f
ARG CKPT_SHA256=
RUN curl -fsSL -o /tmp/ckpt.tar.gz "https://zenodo.org/api/records/15782389/files/peaknetfp_checkpoints.tar.gz/content" \
    && echo "${CKPT_MD5}  /tmp/ckpt.tar.gz" | md5sum -c - \
    && echo "checkpoint sha256: $(sha256sum /tmp/ckpt.tar.gz | cut -d' ' -f1)" \
    && if [ -n "${CKPT_SHA256}" ]; then echo "${CKPT_SHA256}  /tmp/ckpt.tar.gz" | sha256sum -c -; fi \
    && mkdir -p /opt/peaknetfp/ckpt && tar -xzf /tmp/ckpt.tar.gz -C /opt/peaknetfp/ckpt && rm /tmp/ckpt.tar.gz \
    && find /opt/peaknetfp/ckpt -maxdepth 4 | head -40

COPY nafp_worker.py /app/nafp_worker.py
ENV PEAKNETFP_HOME=/opt/peaknetfp NAFP_DATA=/data/nafp NAFP_PORT=8099 TF_CPP_MIN_LOG_LEVEL=2 MPLBACKEND=Agg

# Build-time functional test for both models: two synthetic "tracks" (different pink noise + tones) indexed at
# 44.1 kHz, a 16 kHz excerpt of track B (from 15 s) must come back as track B at ~15 s.
RUN cd /tmp \
    && ffmpeg -v error -f lavfi -i "anoisesrc=d=40:c=pink:seed=3" -f lavfi -i "sine=f=330:d=40" -filter_complex amix=inputs=2 -ar 44100 a.wav \
    && ffmpeg -v error -f lavfi -i "anoisesrc=d=40:c=pink:seed=11" -f lavfi -i "aevalsrc=0.4*sin(2*PI*(220+110*sin(0.7*t))*t):d=40" -filter_complex amix=inputs=2 -ar 44100 b.wav \
    && ffmpeg -v error -ss 15 -t 10 -i b.wav -ar 16000 -ac 1 q.wav \
    && for m in neuralfp peaknetfp; do \
         NAFP_DATA=/tmp/nafp python /app/nafp_worker.py index $m /tmp/a.wav /tmp/b.wav \
         && NAFP_DATA=/tmp/nafp python /app/nafp_worker.py query $m /tmp/q.wav | tee /tmp/r.json \
         && python -c "import json,sys; r=json.load(open('/tmp/r.json')); assert r and r['path']=='/tmp/b.wav' and abs(r['offset']-15)<=1 and r['score']>=0.3, r; print('$m ok', r)" \
         || exit 1; \
       done \
    && rm -rf /tmp/nafp /tmp/*.wav /tmp/r.json

EXPOSE 8099
CMD ["python", "/app/nafp_worker.py"]
