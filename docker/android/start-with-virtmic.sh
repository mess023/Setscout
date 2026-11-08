#!/bin/sh
# PulseAudio with a null sink "virtmic". Its monitor is the default source, which the emulator
# uses as microphone (-allow-host-audio). Setscout plays fragments into it over TCP (port 4713).
set -e
pulseaudio -D --exit-idle-time=-1 \
  --load="module-null-sink sink_name=virtmic sink_properties=device.description=virtmic" \
  --load="module-native-protocol-tcp port=4713 auth-anonymous=1"
sleep 1
pactl set-default-source virtmic.monitor

# The base image starts the emulator with -no-audio by default; the mic needs host audio instead.
export EXTRA_FLAGS="${EXTRA_FLAGS:--allow-host-audio}"
exec /opt/start-emulator.sh "$@"
