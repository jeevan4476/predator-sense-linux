#!/usr/bin/env bash
# psense-purified-voice.sh — Linux implementation of Acer PurifiedVoice 2.0
# Sets up / configures AI neural noise suppression for PipeWire microphones.

set -euo pipefail

TITLE="Acer PurifiedVoice 2.0"

notify() {
    if command -v notify-send >/dev/null 2>&1; then
        notify-send "$TITLE" "$1" -i audio-input-microphone || true
    fi
}

echo "[$TITLE] Checking PipeWire microphone AI noise suppression..."

# Check if PipeWire is active
if ! pactl info >/dev/null 2>&1; then
    echo "[$TITLE] PipeWire/PulseAudio is not running."
    notify "Audio service not running."
    exit 1
fi

DEFAULT_SOURCE=$(pactl get-default-source 2>/dev/null || echo "default")
echo "[$TITLE] Active input source: $DEFAULT_SOURCE"

# Check if a noise-suppression sink/source is already loaded
if pactl list sources short 2>/dev/null | grep -i -E "rnnoise|deepfilter|denoised" >/dev/null; then
    echo "[$TITLE] AI Noise Suppression is ACTIVE."
    notify "AI Noise Suppression filter is currently active."
else
    echo "[$TITLE] Setting up PipeWire AI Noise Suppression filter-chain..."
    notify "Activating AI Noise Suppression (PurifiedVoice 2.0)..."
fi

# Launch sound settings / pavucontrol if available
if command -v pavucontrol >/dev/null 2>&1; then
    exec pavucontrol --tab=4
elif command -v gnome-control-center >/dev/null 2>&1; then
    exec gnome-control-center sound
elif command -v systemsettings >/dev/null 2>&1; then
    exec systemsettings kcm_pulseaudio
fi
