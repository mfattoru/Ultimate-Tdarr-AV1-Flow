# Tdarr Arc AV1 V15 Candidate Design

**Status:** proposed design; no flow code or Tdarr configuration has been changed for V15.

## Intent

Prepare a production-ready successor to the current Arc AV1 flow by carrying forward the user-approved encode, remux, media-selection, HDR/Dolby Vision, storage, Arr, and Discord behavior while removing the source-scan optimization that produced repeated false frame-count failures in live use. The candidate must be validated in the already-running isolated Tdarr test container before production import is considered.

## Goals

- Attempt one Arc QSV AV1 encode at ICQ 22 for every file that passes the existing safety and format guards, including files already encoded as AV1.
- Use /dev/dri/renderD129 by default for Arc work and allow TDARR_ARC_DEVICE to override the device.
- Keep the complete source frame, timestamp, color, and HDR scan before encoding. Do not use the three-window source scan until its false mismatch behavior is fixed and tested end to end.
- Retain the candidate’s existing direct-QSV decode routes for tested 8-bit H.264 4:2:0 and 8-/10-bit HEVC/AV1 4:2:0 SDR inputs. Use CPU decode and conversion for other supported codecs and formats, then encode on Arc.
- Keep complete candidate stream, timing, metadata, subtitle, and health validation. Use Arc QSV for strict candidate video decode where verified; decode audio on CPU.
- Accept an AV1 candidate only when it is smaller than its source and passes validation. If it is not smaller, discard it and stream-copy the source video through the seek-healing remux. The remux has no source-size ceiling; its only limit is the granted scratch-space reservation. It may replace the source, including with a larger file, only after all output checks pass.
- Keep the existing no-recovery-copy policy, RAM-first bounded scratch selection, per-filesystem capacity reservations, and concurrent-job support without a whole-job mutex.
- Preserve the current audio language-selection and pruning behavior, retained audio stream copy, full source audio decode check, ASS/SSA preservation, PGS validation, progress reporting, failure messages, and item-scoped Arr search policy.
- Preserve ISO deletion followed by an Arr rescan request and a Discord warning. An already-processed file ends with a Discord information notice and no encode.
- Keep the existing HDR/Dolby Vision route behavior and metadata checks. Do not broaden routes based only on SDR codec tests.

## Coverage-derived policy

- Arc path tests passed for representative H.264, HEVC, AV1, VP8, VP9, MPEG-2, MPEG-4 Part 2, ProRes, and FFV1 inputs. The test coverage report records exact fixtures, pixel formats, color tags, and container combinations.
- Every actual pixel format in the candidate allowlist was exercised through CPU conversion and Arc encoding except the yuv420p8 alias, which this FFmpeg build does not recognize. RGB, alpha, interlaced, greater-than-12-bit, and unrecognized formats remain held.
- MP4, MOV, and MPEG-TS H.264/AAC inputs, and one AVI MPEG-4/MP3 input, encoded to MKV and passed strict output decode. MKV remains the output container. A failed standalone AV1 MOV/MPEG-TS output test is not a reason to change the MKV flow.
- Existing successful HDR/DV evidence covers HDR10, HDR10+, synthetic HLG, and genuine Dolby Vision Profile 7 and 8.1 examples. No genuine Profile 8.4 sample is available. The V15 release gate requires either a genuine Profile 8.4 sample that validates the current HLG-base route or a reviewed decision to hold that route. Profile 5 and unverified/conflicting dynamic-HDR remain held.
- These are representative Arc/FFmpeg paths, not proof for every codec profile, demuxer combination, malformed file, or Jellyfin client.

## Goals excluded from this revision

- Do not change the global ICQ 22 quality decision.
- Do not change audio languages, audio codecs, subtitle selection, or HDR/Dolby Vision transforms.
- Do not add VMAF or subjective picture-quality evaluation to every file.
- Do not import a candidate into production or write to the production media library during testing.
- Do not recreate the existing test container. Its media mount remains read-only at /mnt/media; test fixtures and generated files stay under /test.
- Do not hardcode Discord credentials or Arr API keys in the flow export.

## Test and deployment boundary

The existing test container currently imports V12, so the direct FFmpeg coverage report does not prove V14/V15 node wiring, replacement, or notifications. V15 must be built as a separate local revision, imported only into that existing test container, and exercised using its isolated /test library. Arr requests are not live-testable with the test container's current disabled credentials; test path-to-Arr routing and request payloads with a local/mock endpoint. Production import is a separate final action and requires explicit user approval after review of the candidate export and test results.

