# V13 codec coverage preflight — 2026-11-02

## Candidate changes

- The early source guard now reaches the existing CPU conversion path for listed 4:2:2 and 4:4:4 YUV formats.
- The source gate accepts listed 4:2:0, 4:2:2, and 4:4:4 YUV pixel formats up to 12-bit, plus 8-bit `yuvj422p` and `yuvj444p`. RGB, alpha, unlisted formats, and anything above 12-bit remain held.
- Tagged SDR 12-bit is decoded on CPU, error-diffused to P010 (10-bit 4:2:0), then sent to Arc QSV AV1 encoding. Twelve-bit HDR, Dolby Vision, and untagged video remain held.
- For SDR, direct QSV decode is limited to H.264 8-bit 4:2:0 and HEVC/AV1 8- or 10-bit 4:2:0. Other source codecs and formats take CPU decode/conversion; AV1 encoding still uses Arc QSV.
- Interlaced video and multiple primary video streams remain held.

## Local FFmpeg matrix

Command: `python3 work/tdarr-flow-v12/codec_matrix.py`

Environment: FFmpeg 8.1 on the local Mac, using software decoders and `libsvtav1` for output. Every generated source was decoded, normalized with `format=p010le`, encoded as AV1 10-bit 4:2:0, and muxed using the source extension. The script checks the output codec, pixel format, and known color-range preservation. It is not an Arc QSV hardware test.

**Result: 14 passed, 4 held, 0 conversion failures, 0 missing source encoders.**

Passed source paths:

- H.264 8-bit, HEVC Main10/Main12 tagged SDR, AV1 Main10, VP8, VP9 10-bit, MPEG-2, MPEG-4 Part 2, ProRes 422 10-bit, and FFV1 9/10-bit 4:2:2/4:4:4.
- 4:2:2 and 4:4:4 samples converted to `yuv420p10le`.
- A full-range 4:2:2 sample retained `pc` range; limited-range samples retained `tv` range.
- Matroska and WebM muxes passed. AVI muxing worked at the FFmpeg level for the tested sample, but no playback device was tested.
- A tagged SDR HEVC 12-bit sample converted to AV1 10-bit 4:2:0 with `tv` range preserved.

Held output paths:

- **H.264 MP4 and MPEG-4 AVI with no color tags or range:** FFmpeg's AV1 output signaled `tv` while the source stream and decoded frames had no known range. The V13 untagged-color validator rejects that result and retains the original rather than guessing a range. The MP4 mux itself succeeded.
- **MPEG-2 transport stream:** FFmpeg exited successfully but the output contained no video stream. V13's output validation rejects it and retains the original.
- **ProRes MOV:** FFmpeg's MOV muxer rejected AV1. V13 retains the original and reports the failure.

The untagged-range behavior is still a coverage limit: preserving a missing source range is not equivalent to tagging the output as limited range. Changing that policy would require an explicit decision to accept a default range for such sources.

## Tdarr-flow integration tests

The Node integration harness generated real FFV1 4:2:2/4:4:4, MPEG-2, and HEVC 12-bit samples, ran the actual V13 policy and routing code, and intercepted the external encode process. It verified that the command selects CPU decode/normalization and still requests `av1_qsv`; it also verified that tagged SDR 12-bit adds `-sws_dither ed` and that 12-bit HDR is held. These tests validate command selection and guards, not QSV execution.

The isolated Tdarr container is running on Unraid, but its imported flow remains V12; the V13 candidate was not run as an end-to-end Tdarr job. This turn's live Arc checks exercised HDR/Dolby Vision encode branches only. Live Arc validation for the broader 4:2:2/4:4:4 and tagged SDR 12-bit codec paths remains pending. The container was not recreated, and `/mnt/media` was mounted read-only.
