# Android emulator with Google Play + a virtual microphone for Setscout's "Google Zoek een nummer" method.
#
# Base: HQarroum/docker-android (MIT), built with the Play Store system image, because
# login + the Google app need Play. Build that base first (see README.md in this folder):
#   docker build -t setscout-android-base --build-arg IMG_TYPE=google_apis_playstore --build-arg API_LEVEL=33 \
#     https://github.com/HQarroum/docker-android.git
ARG BASE=setscout-android-base:latest
FROM ${BASE}

USER root
RUN apt-get update && apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils \
    && rm -rf /var/lib/apt/lists/*
COPY start-with-virtmic.sh /opt/start-with-virtmic.sh
RUN chmod +x /opt/start-with-virtmic.sh

EXPOSE 5555 4713
ENTRYPOINT ["/opt/start-with-virtmic.sh"]
