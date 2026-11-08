# Setscout NAFP worker — neural audio fingerprinting (NeuralFP / PeakNetFP), CPU only.
# Separate image because TensorFlow 2.15 (what the checkpoints were made with) needs Python <= 3.11.
# Code: guillemcortes/peaknetfp (CC BY-NC-SA 4.0, non-commercial). Checkpoints: Zenodo 15782389 (MIT).
FROM python:3.11.18-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg sox curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# versions from the project's environment.yml (TF 2.15.1, kapre 0.3.7, numpy < 2), CPU builds
# kapre 0.3.7's metadata claims numpy>=2, which conflicts with TF 2.15 (numpy<2) → install it without deps
RUN pip install --no-cache-dir "tensorflow-cpu==2.15.1" "numpy<2" "sox==1.4.1" \
      "faiss-cpu==1.8.0.post1" scipy librosa wavio pyyaml pandas matplotlib click \
    && pip install --no-cache-dir --no-deps "kapre==0.3.7"

ARG PEAKNETFP_COMMIT=d55071a644f20fd6448fb8ed33c0c115769fb7a5
RUN mkdir -p /opt/peaknetfp \
    && curl -fsSL https://github.com/guillemcortes/peaknetfp/archive/${PEAKNETFP_COMMIT}.tar.gz \
       | tar -xz --strip-components=1 -C /opt/peaknetfp

# Pretrained checkpoints (155 MB): md5 as published by Zenodo, sha256 pinned (measured in CI).
ARG CKPT_MD5=df23e1556a206fd72bfa99d0724d241f
ARG CKPT_SHA256=03f3d6d7c066194110a045753a63bf415bf4fbc8814c81d7ec24363081150120
RUN curl -fsSL -o /tmp/ckpt.tar.gz "https://zenodo.org/api/records/15782389/files/peaknetfp_checkpoints.tar.gz/content" \
    && echo "${CKPT_MD5}  /tmp/ckpt.tar.gz" | md5sum -c - \
    && echo "checkpoint sha256: $(sha256sum /tmp/ckpt.tar.gz | cut -d' ' -f1)" \
    && if [ -n "${CKPT_SHA256}" ]; then echo "${CKPT_SHA256}  /tmp/ckpt.tar.gz" | sha256sum -c -; fi \
    && mkdir -p /opt/peaknetfp/ckpt && tar -xzf /tmp/ckpt.tar.gz -C /opt/peaknetfp/ckpt && rm /tmp/ckpt.tar.gz \
    && find /opt/peaknetfp/ckpt -maxdepth 4 | head -40

COPY nafp_worker.py /app/nafp_worker.py
ENV PEAKNETFP_HOME=/opt/peaknetfp NAFP_DATA=/data/nafp NAFP_PORT=8099 TF_CPP_MIN_LOG_LEVEL=2 MPLBACKEND=Agg

# Build-time functional test (synthetic audio, both models) — see selftest.sh
COPY selftest.sh /app/selftest.sh
RUN sh /app/selftest.sh

EXPOSE 8099
CMD ["python", "/app/nafp_worker.py"]
