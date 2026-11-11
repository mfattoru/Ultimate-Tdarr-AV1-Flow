#!/bin/sh
set -eu

lib=/opt/tdarr-vpl-pr385/lib/libmfx-gen.so.1.2.17
sha=77f91fd1eac836a1f63f96daa692697a6168d03f56305e6dd21ca89206fc3f2d
device=${TDARR_ARC_DEVICE:-/dev/dri/renderD129}
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

[ "${ONEVPL_PRIORITY_PATH:-}" = /opt/tdarr-vpl-pr385/lib ] || fail 'VPL priority path is not configured'
[ -r "$lib" ] && [ "$(sha256sum "$lib" | awk '{print $1}')" = "$sha" ] || fail 'patched VPL runtime is missing or has the wrong checksum'
[ -r "$device" ] && [ -w "$device" ] || fail "Arc render device is not readable and writable: $device"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
out="$tmp/smoke.mkv"
if ! LD_DEBUG=libs ffmpeg -hide_banner -loglevel error -xerror \
  -init_hw_device "vaapi=va:$device" -init_hw_device qsv=hw@va -filter_hw_device hw \
  -f lavfi -i testsrc2=size=1280x720:rate=24:duration=1 \
  -vf 'format=p010le,hwupload=extra_hw_frames=64' -frames:v 24 -an \
  -c:v av1_qsv -preset slow -global_quality 28 -y "$out" >/dev/null 2>"$tmp/loader.log"; then
  tail -n 20 "$tmp/loader.log" >&2 || true
  fail 'QSV AV1 smoke encode failed'
fi
grep -F "calling init: $lib" "$tmp/loader.log" >/dev/null || fail 'ffmpeg did not load the patched VPL runtime'
info=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,nb_read_frames -count_frames -of default=noprint_wrappers=1 "$out") || fail 'ffprobe could not read the output'
printf '%s\n' "$info" | grep -qx 'codec_name=av1' || fail "unexpected output codec: $info"
printf '%s\n' "$info" | grep -qx 'nb_read_frames=24' || fail "unexpected output frame count: $info"
printf 'PASS: QSV AV1 encoded 24 frames on %s and loaded the patched VPL runtime\n' "$device"
