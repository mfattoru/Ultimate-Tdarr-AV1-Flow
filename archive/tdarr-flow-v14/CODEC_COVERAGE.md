# Arc AV1 codec coverage report — 2026-11-03

## Decision summary

- **Verified on the Arc test node with direct FFmpeg runs:** H.264 8-bit 4:2:0 and HEVC/AV1 Main10 direct-QSV examples; CPU-decode-to-Arc examples for VP8/VP9, MPEG-2/4 Part 2, ProRes, FFV1, and every actual source pixel format in the candidate allowlist except the unavailable `yuv420p8` alias. Outputs decoded on Arc with complete generated frame counts.
- **Color evidence:** limited and full range remained `tv` and `pc`; BT.709, BT.470 BG, and SMPTE 170M matrix tags survived the CPU fallback; real BT.709 HEVC tags survived both direct QSV and CPU-decode-to-QSV examples. HDR10, HDR10+, synthetic HLG, Dolby Vision Profile 7, and Profile 8.1 were exercised; see the HDR section for the conversion rules and limitations.
- **Input-container evidence:** MP4, MOV, and MPEG-TS H.264/AAC examples, plus AVI MPEG-4/MP3, were read, encoded to MKV, and strictly decoded. MKV/WebM examples also passed. These are representative combinations, not every codec/container pairing.
- **Still held or unverified:** RGB/alpha, interlaced video, >12-bit, 12-bit HDR/DV, unrecognized pixel formats, multiple primary video streams, Dolby Vision Profile 5, hybrid/conflicting dynamic-HDR, and genuine Profile 8.4. The current candidate applies an explicit range convention to untagged SDR YUV; untagged 12-bit remains held.
- These were direct FFmpeg runs and remux checks in the existing test container. It still imports V12, so this report is **not** an end-to-end V14 Tdarr job or production verification.

## Candidate changes

- The early source guard now reaches the existing CPU conversion path for listed 4:2:2 and 4:4:4 YUV formats.
- The source gate accepts listed 4:2:0, 4:2:2, and 4:4:4 YUV pixel formats up to 12-bit, plus 8-bit `yuvj422p` and `yuvj444p`. RGB, alpha, unlisted formats, and anything above 12-bit remain held.
- Tagged SDR 12-bit is decoded on CPU, error-diffused to P010 (10-bit 4:2:0), then sent to Arc QSV AV1 encoding. Twelve-bit HDR/Dolby Vision and untagged 12-bit video remain held. Untagged SDR YUV uses the explicit range policy described in the V14 README.
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

The isolated Tdarr container is running on Unraid, but its imported flow remains V12; the V13 candidate was not run as an end-to-end Tdarr job. The original preflight left Arc validation of 4:2:2/4:4:4 and tagged SDR 12-bit paths pending; the direct Arc checks added below now cover representative CPU-conversion paths for those formats. The container was not recreated, and `/mnt/media` was mounted read-only.

## Isolated Arc QSV coverage supplement — 2026-11-03

These additional tests ran in the existing `tdarr-flow-live-test-20261102` container on `/dev/dri/renderD129`. Inputs and generated outputs stayed in `/test`; `/mnt/media` remained read-only. They exercised FFmpeg commands directly, not a complete Tdarr flow job. The container's imported flow remains V12, so these results validate codec paths and output checks, not V14 node wiring, replacement, or notification behavior.

### Arc encode and decode paths

- A clean synthetic H.264 Constrained Baseline 8-bit 4:2:0 source completed direct QSV decode, `vpp_qsv` conversion, and `av1_qsv` encode. The 48-frame AV1 Main 10-bit output decoded on Arc. The real H.264 fixture in the top-level corpus is malformed and is not evidence against clean H.264 support: strict decode failed on both the source and its stream-copy remux with FFmpeg's invalid-data error.
- Full Arc decode passed on both source and stream-copy remux for the clean top-level AV1 and HEVC samples: AV1 Main 10-bit SDR, HEVC Main10 720p and 1080p, AV1 Main 10-bit 4K HDR10, and an untagged AV1 Main 10-bit sample. The full output decode also passed on the previously generated AV1 outputs for Dolby Vision Profile 7, Profile 8.1, HDR10+, and synthetic HLG.
- The CPU-decode-to-Arc-encode path passed for synthetic VP8 8-bit, VP9 10-bit, MPEG-2, MPEG-4 Part 2, ProRes 422 10-bit, and HEVC Main12 SDR sources. Every output was AV1 `yuv420p10le`, had all 24 generated frames, and passed strict Arc decode.
- FFV1-backed Arc conversion tests passed for every source pixel format in the candidate allowlist that this FFmpeg build can generate: `nv12`, `p010`/`p010le`, `yuv420p`, `yuv420p9le`, `yuv420p10le`, `yuv420p12le`, 8/9/10/12-bit 4:2:2 and 4:4:4, and `yuvj422p`/`yuvj444p`. Each produced AV1 `yuv420p10le`, all 24 frames, and passed strict Arc decode. Limited-range inputs stayed `tv`; full-range inputs stayed `pc`. The alias `yuv420p8` is not recognized by this FFmpeg build; ordinary 8-bit input is reported as `yuv420p`.
- Additional 4:2:0 full-range input was reported by FFprobe as `yuv420p` plus `pc` range, encoded successfully, and retained `pc`. BT.709, BT.470 BG, and SMPTE 170M matrix tags survived the candidate CPU-fallback filter; a real BT.709 HEVC source retained its full BT.709 color tags on both direct QSV and CPU-decode-to-QSV encode routes.

### HDR, remux, and subtitle evidence

- The test corpus includes genuine HEVC Dolby Vision Profile 7 and Profile 8.1 samples, an HEVC HDR10+ sample, and a synthetic HLG clip. Stream-copy remuxes preserved the video payload hashes, video stream metadata (including Dolby Vision side-data records), and packet counts exactly. Arc strict decode passed on each source, remux, and the previously generated AV1 conversion output.
- The prior direct Arc conversion tests documented in [HDR_LIVE_VALIDATION.md](HDR_LIVE_VALIDATION.md) passed for Profile 7 to HDR10, Profile 8.1 to HDR10, HDR10+ to HDR10, and synthetic HLG. There is still no genuine Dolby Vision 8.4 fixture; Profile 8.4 must remain unverified. Profile 5 and hybrid or unrecognized dynamic-HDR combinations remain held by policy.
- Across the ordinary top-level fixture remuxes, mapped audio, subtitle, and main-video packet hashes and normalized timelines matched. One H.264 sample also has an attached PNG cover image; the remux intentionally omits that attached picture, so only its total all-stream packet count differs.
- The standalone ASS fixture was stream-copied without subtitle conversion: source and output each had 4,028 packets and identical ASS payload hashes. This supports the passthrough path and avoids the SRT encoder buffer failure. It is not a live Jellyfin playback test or a 50 MB ASS stress fixture.

### Frame-scan performance and limits

This FFprobe build rejects `-init_hw_device`, so it cannot directly perform the existing `-show_frames` scan on QSV. An FFmpeg QSV decode followed by `hwdownload,format=p010le,showinfo` produced a full frame log and correct final count/color tags, but took 158 seconds for the 24-minute HEVC sample (34,528 frames) and 167 seconds for the 23-minute AV1 sample (33,200 frames). The 4K HDR10 excerpt took 6 seconds for 466 frames and reported BT.2020/PQ plus its content-light metadata. On the HEVC sample, the earlier CPU FFprobe scan took 214 seconds, so the GPU-backed showinfo path saved 56 seconds but still requires a new log parser and CPU download of every frame.

These measurements support Arc QSV for strict full video decode, but do not justify replacing the flow's frame-level color, dynamic-HDR, and timestamp checks with a new `showinfo` parser. Keep the full frame scan for those checks, especially on HDR/Dolby Vision routes. The V14 sampled source-precheck optimization is not validated by this codec matrix: the previous live attempt produced widespread sampled-window frame-count mismatches, and reverting to the prior full-scan flow resolved them. Keep the full source scan in production until the sample-window logic passes an end-to-end test. No genuine HLG or Dolby Vision 8.4 source, clean H.264 library file, interlaced source, RGB/alpha source, or 12-bit HDR source was tested. The test results do not expand the flow's guards for those cases.

### Input-container coverage supplement — 2026-11-03

Small synthetic inputs exercised the installed container's input demux, Arc encode, Matroska mux, and strict output decode paths. These are direct FFmpeg checks in the existing test container, not complete Tdarr jobs.

| Input container and sample | Route | Result |
| --- | --- | --- |
| MP4, H.264 8-bit 4:2:0 with AAC | Direct QSV decode, Arc AV1 encode, AAC stream copy to MKV, strict video/audio decode | Passed |
| MOV, H.264 8-bit 4:2:0 with AAC | Direct QSV decode, Arc AV1 encode, AAC stream copy to MKV, strict video/audio decode | Passed |
| MPEG-TS, H.264 8-bit 4:2:0 with AAC | Direct QSV decode, Arc AV1 encode, AAC stream copy to MKV, strict video/audio decode | Passed |
| AVI, MPEG-4 Part 2 with MP3 | CPU decode/conversion, Arc AV1 encode, MP3 stream copy to MKV, strict video/audio decode | Passed |

The AVI result validates the CPU-fallback route for this MPEG-4/MP3 sample. It does not establish support for every AVI codec/audio pairing; an H.264-in-AVI test fixture could not be created successfully. An initial AVI test with AAC was rejected by the AVI muxer, so it was not counted as a flow failure.

The tested flow output container is Matroska. Standalone AV1 output tests do not justify using MPEG-TS or MOV as output containers: the tested MPEG-TS file had no usable AV1 video stream, and the MOV muxer wrote no output for the video-only fixture. Neither combination is used by this flow, which writes MKV.

### Coverage boundary

The tested codec names and pixel formats are representative supported paths, not an exhaustive list of all FFmpeg decoders, bitstream profiles, malformed inputs, or muxer combinations. The current candidate's source gate explicitly holds pixel formats outside its allowlist, RGB/alpha, >12-bit, interlaced video, multiple primary video streams, 12-bit HDR/Dolby Vision, Dolby Vision Profile 5, and unverified or conflicting dynamic-HDR signaling. Dolby Vision Profile 8.4 has no genuine fixture and remains unverified. Do not widen those guards based on the successful SDR conversion tests.

The accepted pixel-format names were exercised except for the alias `yuv420p8`, which this FFmpeg build does not recognize. This does not cover every AVI codec pairing or every audio/subtitle codec. Existing audio coverage includes AAC, AC-3, E-AC-3, and Opus; styled ASS stream-copy was checked with a small fixture. These results do not establish playback compatibility for all Jellyfin clients or large ASS/PGS stress cases.

Correction to older coverage wording above: clean H.264 is tested with a synthetic fixture, and HLG is tested with a synthetic fixture. No clean H.264 library file or genuine HLG source was available. No 12-bit HDR, interlaced, RGB, or alpha source was tested.
