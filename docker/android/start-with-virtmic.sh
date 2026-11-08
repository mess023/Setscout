#!/bin/sh
# Starts PulseAudio with a null sink "virtmic" (its monitor = the emulator's microphone), a virtual X display,
# then the emulator of the HQarroum base image. Setscout plays fragments into virtmic over TCP (port 4713).
AVD_DIR="${ANDROID_AVD_HOME:-/data}"

# 0. Leftovers of a crashed run: the container restarts with stale locks and the emulator then refuses
#    ("Running multiple emulators with the same AVD"), PulseAudio and Xvfb likewise.
find "$AVD_DIR" -maxdepth 2 -name '*.lock' -exec rm -rf {} + 2>/dev/null || true
pulseaudio --kill 2>/dev/null || true
rm -rf /tmp/pulse-* /tmp/pulse.sock /root/.config/pulse /run/pulse /var/run/pulse /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true

# 1. PulseAudio (unix socket for the emulator, TCP for Setscout)
if pulseaudio -D --exit-idle-time=-1 \
     --load="module-null-sink sink_name=virtmic sink_properties=device.description=virtmic" \
     --load="module-native-protocol-unix socket=/tmp/pulse.sock auth-anonymous=1" \
     --load="module-native-protocol-tcp port=4713 auth-anonymous=1"; then
  sleep 1
  pactl -s unix:/tmp/pulse.sock set-default-source virtmic.monitor || true
  export PULSE_SERVER=unix:/tmp/pulse.sock QEMU_AUDIO_DRV=pa
else
  echo "setscout: PulseAudio start mislukt — emulator start zonder virtuele microfoon" >&2
fi

# 2. Display. The base script starts the emulator with -no-window (headless build: no working PulseAudio,
#    "Could not init 'pa' audio driver"). The windowed build needs a real X display (without one it
#    segfaults: "cannot get x11 display info"), so give it a virtual one with Xvfb.
#    EMULATOR_WINDOW=xvfb (default) | none (base image's headless mode, no microphone)
START=/opt/start-emulator.sh
if [ "${EMULATOR_WINDOW:-xvfb}" = xvfb ]; then
  Xvfb :99 -screen 0 1280x2048x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  sleep 2
  export DISPLAY=:99
  sed 's/ -no-window / /' /opt/start-emulator.sh > /tmp/start-emulator.sh && chmod +x /tmp/start-emulator.sh
  START=/tmp/start-emulator.sh
fi

# 2b. Optional GPU mode override (base default: swiftshader_indirect = host-side software GPU via gfxstream).
#     EMULATOR_GPU=guest renders entirely inside Android (slower, avoids the host GPU layer) if the emulator
#     keeps segfaulting.
if [ -n "${EMULATOR_GPU:-}" ]; then
  [ "$START" = /opt/start-emulator.sh ] && cp /opt/start-emulator.sh /tmp/start-emulator.sh && START=/tmp/start-emulator.sh
  sed -i "s/-gpu \"\$GPU_MODE\"/-gpu \"$EMULATOR_GPU\"/" "$START" && chmod +x "$START"
  echo "setscout: GPU-modus $EMULATOR_GPU" >&2
fi

# 3. Host audio as microphone; guest Vulkan off — the software GPU (SwiftShader) crashed the emulator
#    with a segfault when Play Store/Chromium used Vulkan.
export EXTRA_FLAGS="-allow-host-audio -feature -Vulkan ${EXTRA_FLAGS:-}"
exec "$START" "$@"
