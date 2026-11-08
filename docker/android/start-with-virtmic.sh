#!/bin/sh
# Starts PulseAudio with a null sink "virtmic" (its monitor = the emulator's microphone), then the emulator
# of the HQarroum base image. Setscout plays fragments into virtmic over TCP (port 4713).

# 1. PulseAudio. Clear leftovers of a previous run first: after an emulator crash the container restarts with
#    stale pid/lock files and PulseAudio refuses to start ("Daemon startup failed").
pulseaudio --kill 2>/dev/null || true
rm -rf /tmp/pulse-* /tmp/pulse.sock /root/.config/pulse /run/pulse /var/run/pulse 2>/dev/null || true
if pulseaudio -D --exit-idle-time=-1 \
     --load="module-null-sink sink_name=virtmic sink_properties=device.description=virtmic" \
     --load="module-native-protocol-unix socket=/tmp/pulse.sock auth-anonymous=1" \
     --load="module-native-protocol-tcp port=4713 auth-anonymous=1"; then
  sleep 1
  pactl -s unix:/tmp/pulse.sock set-default-source virtmic.monitor || true
  # the emulator (QEMU) finds PulseAudio through these
  export PULSE_SERVER=unix:/tmp/pulse.sock QEMU_AUDIO_DRV=pa
else
  echo "setscout: PulseAudio start mislukt — emulator start zonder virtuele microfoon" >&2
fi

# 2. The base script starts the emulator with -no-window (headless build, no working PulseAudio).
#    EMULATOR_WINDOW=offscreen (default): normal build with Qt's offscreen platform, so audio works.
#    EMULATOR_WINDOW=none: keep the base image's -no-window (fallback if offscreen misbehaves).
START=/opt/start-emulator.sh
if [ "${EMULATOR_WINDOW:-offscreen}" = offscreen ]; then
  sed 's/ -no-window / /' /opt/start-emulator.sh > /tmp/start-emulator.sh && chmod +x /tmp/start-emulator.sh
  START=/tmp/start-emulator.sh
  export QT_QPA_PLATFORM=offscreen
fi

# 3. Host audio as microphone; guest Vulkan off — the software GPU (SwiftShader) crashed the emulator
#    with a segfault when Play Store/Chromium used Vulkan.
export EXTRA_FLAGS="-allow-host-audio -feature -Vulkan ${EXTRA_FLAGS:-}"
exec "$START" "$@"
