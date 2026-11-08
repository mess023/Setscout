# Setscout — image for TrueNAS SCALE (custom app) or any Docker host.
# Contains every tool the methods can use: ffmpeg, fpcalc (Chromaprint), Python + audfprint/essentia,
# Java (Panako), Olaf. Dejavu is left out: it needs a separate MySQL/Postgres container.
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
    && /opt/venv/bin/pip install --no-cache-dir numpy scipy docopt joblib psutil essentia "yt-dlp[default]"
ENV PATH="/opt/venv/bin:$PATH"

# Deno: JavaScript runtime yt-dlp needs for YouTube (method "YouTube-tracklist"). Pinned + checksum-verified.
ARG DENO_VERSION=2.9.8
ARG DENO_SHA256=e890975bc2549807bbcc0b584ffafda72cc7c93349dd99c80483dd784f6c4609
RUN curl -fsSL -o /tmp/deno.zip https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip \
    && echo "${DENO_SHA256}  /tmp/deno.zip" | sha256sum -c - \
    && python3 -c "import zipfile; zipfile.ZipFile('/tmp/deno.zip').extract('deno', '/usr/local/bin')" \
    && chmod +x /usr/local/bin/deno && rm /tmp/deno.zip

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

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY cli.mjs server.mjs ./
COPY lib ./lib
COPY ui ./ui
COPY tools/essentia_bpmkey.py ./tools/

ENV HOST=0.0.0.0 PORT=3847 NO_OPEN=1 \
    SETSCOUT_DATA=/data SETSCOUT_EXPORT_DIR=/exports SETSCOUT_ROOTS=/sets:/music:/exports SETSCOUT_TMP=/tmp/setscout
VOLUME ["/data"]
EXPOSE 3847
USER node
CMD ["node", "server.mjs"]
