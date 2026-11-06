#!/usr/bin/env python3
"""Exercise local FFmpeg decode -> 10-bit 4:2:0 AV1 encode -> same-container mux."""
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

CASES = [
    # label, encoder, source pixel format, extension, video args, audio encoder, color args
    ("H.264 8-bit Matroska", "libx264", "yuv420p", ".mkv", ["-preset", "ultrafast", "-crf", "32"], "aac", []),
    ("H.264 8-bit MP4", "libx264", "yuv420p", ".mp4", ["-preset", "ultrafast", "-crf", "32"], "aac", []),
    ("HEVC Main10", "libx265", "yuv420p10le", ".mkv", ["-preset", "ultrafast", "-crf", "32", "-x265-params", "log-level=error:pools=1"], "aac", []),
    ("HEVC Main12 tagged SDR", "libx265", "yuv420p12le", ".mkv", ["-preset", "ultrafast", "-crf", "32", "-x265-params", "log-level=error:pools=1"], "aac", ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]),
    ("AV1 Main10", "libsvtav1", "yuv420p10le", ".mkv", ["-preset", "12", "-crf", "42", "-svtav1-params", "lp=1:log-level=0"], "aac", []),
    ("VP9 10-bit", "libvpx-vp9", "yuv420p10le", ".webm", ["-deadline", "realtime", "-cpu-used", "8", "-crf", "45", "-b:v", "0"], "libopus", []),
    ("VP8 8-bit", "libvpx", "yuv420p", ".webm", ["-deadline", "realtime", "-cpu-used", "8", "-crf", "40", "-b:v", "0"], "libopus", []),
    ("MPEG-2 Matroska", "mpeg2video", "yuv420p", ".mkv", ["-q:v", "5"], "aac", []),
    ("MPEG-2 Transport Stream", "mpeg2video", "yuv420p", ".ts", ["-q:v", "5"], "aac", []),
    ("MPEG-4 Part 2 Matroska", "mpeg4", "yuv420p", ".mkv", ["-q:v", "5"], "aac", []),
    ("MPEG-4 Part 2 AVI", "mpeg4", "yuv420p", ".avi", ["-q:v", "5"], "libmp3lame", []),
    ("ProRes 422 10-bit Matroska", "prores_ks", "yuv422p10le", ".mkv", ["-profile:v", "3"], "aac", []),
    ("ProRes 422 10-bit MOV", "prores_ks", "yuv422p10le", ".mov", ["-profile:v", "3"], "pcm_s16le", []),
    ("FFV1 4:2:2 10-bit", "ffv1", "yuv422p10le", ".mkv", [], "aac", []),
    ("FFV1 4:2:2 9-bit", "ffv1", "yuv422p9le", ".mkv", [], "aac", []),
    ("FFV1 4:4:4 10-bit", "ffv1", "yuv444p10le", ".mkv", [], "aac", []),
    ("FFV1 4:4:4 9-bit", "ffv1", "yuv444p9le", ".mkv", [], "aac", []),
    ("FFV1 full-range 4:2:2", "ffv1", "yuvj422p", ".mkv", [], "aac", ["-color_range", "pc"]),
]


def run(args, timeout=90):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)


def probe(file):
    result = run([FFPROBE, "-v", "error", "-show_streams", "-of", "json", str(file)])
    if result.returncode:
        raise RuntimeError(result.stderr.strip()[-600:])
    return json.loads(result.stdout)


def first_frame(file):
    result = run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_frames", "-read_intervals", "%+#1",
                  "-show_entries", "frame=color_range,color_transfer,color_primaries,color_space", "-of", "json", str(file)])
    if result.returncode:
        return {}
    return (json.loads(result.stdout).get("frames") or [{}])[0]


def encoders():
    result = run([FFMPEG, "-hide_banner", "-encoders"])
    return result.stdout + result.stderr


def make_source(folder, case):
    label, encoder, pixel, ext, vopts, audio, color_args = case
    source = folder / (encoder.replace("/", "_") + pixel + ext)
    args = [FFMPEG, "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x192:rate=12:duration=1",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest", "-vf", f"format={pixel}",
            "-c:v", encoder, *vopts, "-pix_fmt", pixel, "-color_range", "pc" if pixel.startswith("yuvj") else "tv",
            *color_args, "-c:a", audio, str(source)]
    result = run(args)
    if result.returncode:
        raise RuntimeError(result.stderr.strip()[-600:])
    return source


def exercise(folder, case):
    label, encoder, pixel, ext, *_ = case
    source = make_source(folder, case)
    source_video = next((s for s in probe(source)["streams"] if s.get("codec_type") == "video"), None)
    if not source_video:
        return "FAIL", "generated source has no video stream"
    source_frame = first_frame(source)
    source_range = source_video.get("color_range")
    if source_range in (None, "unknown", "unspecified"):
        source_range = source_frame.get("color_range")
    pixel_matches = source_video.get("pix_fmt") == pixel
    full_range_422 = pixel == "yuvj422p" and source_video.get("pix_fmt") == "yuv422p" and source_range == "pc"
    if not pixel_matches and not full_range_422:
        return "FAIL", f"source pixel format is {source_video.get('pix_fmt')}, expected {pixel}"

    output = folder / f"normalized_{encoder}_{pixel}{ext}"
    args = [FFMPEG, "-hide_banner", "-v", "error", "-i", str(source), "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", "format=p010le"]
    if "12" in pixel:
        args += ["-sws_dither", "ed"]
    args += ["-c:v", "libsvtav1", "-preset", "12", "-crf", "40",
            "-svtav1-params", "lp=1:log-level=0", "-c:a", "copy", "-y", str(output)]
    result = run(args)
    if result.returncode:
        return "HOLD", "same-container AV1 mux failed: " + result.stderr.strip()[-400:].replace("\n", " | ")

    output_video = next((s for s in probe(output)["streams"] if s.get("codec_type") == "video"), None)
    if not output_video:
        return "HOLD", "container exited successfully but produced no video stream"
    if output_video.get("codec_name") != "av1":
        return "FAIL", f"output codec is {output_video.get('codec_name')}, expected AV1"
    if output_video.get("pix_fmt") != "yuv420p10le":
        return "FAIL", f"normalized output pixel format is {output_video.get('pix_fmt')}, expected yuv420p10le"
    output_range = output_video.get("color_range")
    color_fields = ("color_primaries", "color_transfer", "color_space")
    source_is_untagged = all(source_video.get(field) in (None, "unknown", "unspecified")
                             and source_frame.get(field) in (None, "unknown", "unspecified") for field in color_fields)
    if source_is_untagged and source_range in (None, "unknown", "unspecified") and output_range not in (None, "unknown", "unspecified"):
        return "HOLD", f"untagged source range is unspecified, but AV1 output signals {output_range}"
    if source_range not in (None, "unknown", "unspecified") and output_range != source_range:
        return "FAIL", f"color range changed from {source_range} to {output_range}"
    return "PASS", f"{source_video['codec_name']} {pixel} -> AV1 yuv420p10le; range {source_range or 'unspecified'} -> {output_range or 'unspecified'}; {ext[1:]} mux ok"


def main():
    version = run([FFMPEG, "-version"]).stdout.splitlines()[0]
    available = encoders()
    print(version)
    print("Check: local software decode + format=p010le + SVT-AV1 + same-container mux; no Arc/QSV device is used.")
    results = []
    with tempfile.TemporaryDirectory(prefix="tdarr-codec-matrix-") as temp:
        folder = Path(temp)
        for case in CASES:
            label, encoder = case[0], case[1]
            if encoder not in available:
                results.append((label, "SKIP", f"source encoder {encoder} is not in this FFmpeg build"))
                continue
            try:
                status, detail = exercise(folder, case)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                status, detail = "FAIL", str(error).strip()[-500:].replace("\n", " | ")
            results.append((label, status, detail))
    for label, status, detail in results:
        print(f"{status:4} | {label:26} | {detail}")
    passed = sum(status == "PASS" for _, status, _ in results)
    failed = sum(status == "FAIL" for _, status, _ in results)
    held = sum(status == "HOLD" for _, status, _ in results)
    skipped = sum(status == "SKIP" for _, status, _ in results)
    print(f"SUMMARY | {passed} passed, {held} held, {failed} failures, {skipped} unavailable encoders")
    return 1 if failed or skipped else 0


if __name__ == "__main__":
    raise SystemExit(main())
