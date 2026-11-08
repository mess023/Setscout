# Setscout — image for TrueNAS SCALE (custom app) or any Docker host.
# Contains every tool the methods can use: ffmpeg, fpcalc (Chromaprint), Python + audfprint/essentia,
# Java (Panako), Olaf, Dejavu (SQLite).
#
#   docker build -t setscout .
#   docker compose up -d
FROM node:26.13.0-trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libchromaprint-tools python3 python3-venv default-jre-headless ca-certificates curl \
      adb pulseaudio-utils \
    && rm -rf /var/lib/apt/lists/*

# Python tools in a venv (Debian blocks system-wide pip). Setscout finds python3 via PATH.
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir numpy scipy docopt joblib psutil essentia
ENV PATH="/opt/venv/bin:$PATH"

# audfprint (dpwe, MIT) — the original Python version, see the report for why
RUN mkdir -p /app/tools/audfprint \
    && curl -fsSL https://github.com/dpwe/audfprint/archive/refs/heads/master.tar.gz \
       | tar -xz --strip-components=1 -C /app/tools/audfprint

# Olaf v3.3.3 (AGPL-3.0) prebuilt CLI
RUN mkdir -p /opt/olaf \
    && curl -fsSL https://github.com/JorenSix/Olaf/releases/download/v3.3.3/olaf_cli-linux-x86_64.tar.gz | tar -xz -C /opt/olaf \
    && ln -s "$(find /opt/olaf -type f -name 'olaf*' -perm -u+x | head -n1)" /usr/local/bin/olaf

# Panako 2.1 (AGPL-3.0, Java) + a tiny launcher so the method can call `panako`
RUN mkdir -p /opt/panako \
    && curl -fsSL -o /opt/panako/panako.jar https://github.com/JorenSix/Panako/releases/download/joss/Panako-2.1-all.jar \
    && printf '#!/bin/sh\nexec java --add-opens=java.base/java.nio=ALL-UNNAMED --add-opens=java.base/sun.nio.ch=ALL-UNNAMED -jar /opt/panako/panako.jar "$@"\n' > /usr/local/bin/panako && chmod +x /usr/local/bin/panako

# Dejavu: bcollazo fork (MIT) of worldveil/dejavu — SQLAlchemy, so SQLite instead of a MySQL/Postgres server.
# 2020 code; patched for Python 3.13 / numpy 2 / SQLAlchemy 2 (fromstring, Binary, scipy.ndimage submodules,
# audioop via audioop-lts, PyAudio only needed for microphone mode). Pinned commit; functional test below.
ARG DEJAVU_COMMIT=11be7f109c8f5addedbc9f660bab383bace07d7d
COPY docker/dejavu_patch.py /tmp/dejavu_patch.py
RUN /opt/venv/bin/pip install --no-cache-dir matplotlib pydub audioop-lts SQLAlchemy sqlalchemy-utils tenacity six \
    && mkdir -p /opt/dejavu \
    && curl -fsSL https://github.com/bcollazo/dejavu/archive/${DEJAVU_COMMIT}.tar.gz | tar -xz --strip-components=1 -C /opt/dejavu \
    && python3 /tmp/dejavu_patch.py /opt/dejavu/dejavu && rm /tmp/dejavu_patch.py

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY cli.mjs server.mjs ./
COPY lib ./lib
COPY ui ./ui
COPY tools/essentia_bpmkey.py tools/dejavu_cli.py ./tools/

# Build-time check that the patched Dejavu really fingerprints and recognises: 44.1 kHz reference, 16 kHz query
# fragment like Setscout sends (synthetic pink noise, no music needed)
RUN cd /tmp && ffmpeg -v error -f lavfi -i "anoisesrc=d=30:c=pink:seed=7" -ar 44100 -ac 1 ref.wav \
    && ffmpeg -v error -ss 12 -t 8 -i ref.wav -ar 16000 q.wav \
    && python3 /app/tools/dejavu_cli.py index /tmp/dj.sqlite /tmp/ref.wav \
    && python3 /app/tools/dejavu_cli.py query /tmp/dj.sqlite /tmp/q.wav > /tmp/dj.json \
    && python3 -c "import json; m=json.load(open('/tmp/dj.json')); assert m and m['path']=='/tmp/ref.wav' and abs(m['offset']-12)<1.5, m; print('dejavu ok', m)" \
    && rm -f /tmp/ref.wav /tmp/q.wav /tmp/dj.sqlite /tmp/dj.json

ENV HOST=0.0.0.0 PORT=3847 NO_OPEN=1 \
    SETSCOUT_DATA=/data SETSCOUT_EXPORT_DIR=/exports SETSCOUT_ROOTS=/sets:/music:/exports SETSCOUT_TMP=/tmp/setscout
VOLUME ["/data"]
EXPOSE 3847
USER node
CMD ["node", "server.mjs"]
