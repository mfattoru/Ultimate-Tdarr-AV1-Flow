# Arc preset and audio-check benchmark — 2026-11-04

## Scope

Ran in the existing `tdarr-flow-live-test-20261102` container on the Intel Arc QSV device. The test input was the read-only 1080p HEVC Main 10 sample `Sample Adventure Series - S07E06 - Sample Episode! Sample Episode! WEBRip-1080p v2.mkv` (348,191,672 bytes, 1,440.189 seconds), with two E-AC-3 audio tracks. Outputs and temporary excerpts were written under `/test/bench-speed/codex-20261104/`; production media and the production flow were not changed.

The same Arc QSV ICQ 22 command shape and input were used for both presets. Each preset was run once, so these numbers are a direct sample comparison, not a repeated-run statistical benchmark. The source is 1080p SDR; HDR and Dolby Vision were not tested here.

## Preset result

| Preset | Encode time | Output size | Size vs source | 15-second VMAF TV 3H mean | 15-second VMAF Phone 5H mean |
| --- | ---: | ---: | ---: | ---: | ---: |
| `slow` | 80.060 s | 408,057,965 B | +17.2% | 97.0377 | 98.0639 |
| `medium` | 83.133 s | 410,885,641 B | +18.0% | 97.0794 | 98.0867 |

`medium` took 3.8% longer and produced a 0.69% larger output. Its VMAF scores were only about 0.04 points higher on TV and 0.02 points higher on phone for the tested 15-second excerpt. Both outputs exceed the source size, so the flow's size guard would discard either AV1 output and use the validated source-video remux fallback. This sample provides no speed or size reason to change V15 from `slow`.

## Audio-check result

Compared full-file software audio decodes, repeated three times per mode. “Sequential” is the current per-track FFmpeg invocation pattern; “combined” maps both retained audio streams into one FFmpeg invocation. Reported times are medians.

| Stage | Sequential | Combined | Saved |
| --- | ---: | ---: | ---: |
| Source precheck, 2 tracks | 2.105 s | 1.241 s | 0.864 s (41.0%) |
| Candidate audio validation, 2 tracks | 1.999 s | 1.310 s | 0.689 s (34.5%) |
| Combined per file | 4.104 s | 2.551 s | 1.553 s (37.8%) |

The measurement covers only audio checks; it excludes the video scans, video encode, stream comparisons, and muxing. It is a small end-to-end saving for this file, but the implementation preserves full source and candidate audio decodes while cutting one FFmpeg launch per retained track in the common case. On a combined source decode failure, V15 falls back to one-track-at-a-time decodes to identify the failing stream. If individual streams all pass but the combined command fails, it fails closed as an audio guard and does not classify the source as corrupt.

## V15 decision

- Keep the `slow` Arc preset. `medium` did not deliver the intended speed improvement in this run.
- Batch source precheck audio decodes and candidate audio validation decodes. Integration tests verify both batching and per-stream isolation after a failed source batch.
- No preset-specific HDR or Dolby Vision decision follows from this SDR test.
- No full Tdarr job was run: the live test instance still has a stale imported flow with embedded legacy Arr settings. The change is in the local V15 review export only; production and the test instance flow were not modified.

## Slower-than-slow follow-up

Repeated the matched full-file test in the same container with the next slower QSV preset. This run used the same source, ICQ 22, stream maps, color tags, and Arc device for both presets. The one-run wall times vary from the earlier comparison, so compare the two values in this matched pair.

| Preset | Encode time | Output size | Size vs source |
| --- | ---: | ---: | ---: |
| `slow` | 68.345 s | 408,057,958 B | +17.2% |
| `slower` | 118.162 s | 402,077,531 B | +15.5% |

`slower` took 49.817 seconds longer (+72.9%) and produced an output 5,980,427 bytes smaller (−1.47%). Both outputs remain larger than the 348,191,672-byte source, so the production size guard would reject both and use the remux fallback.

For quality, compared three aligned 15-second, 10-bit excerpts at 300, 600, and 900 seconds with the same Netflix VMAF 0.6.1 model (359–360 frames per excerpt). The installed CLI could not load the newer TV/phone VMAF 1.0.16 models because its build lacks a required feature extractor, so these are relative scores from the compatible standard model, not the prior TV/phone model scores.

| Source position | `slow` mean / harmonic | `slower` mean / harmonic | Mean delta |
| --- | ---: | ---: | ---: |
| 300 s | 97.1276 / 97.0582 | 97.1647 / 97.0969 | +0.0371 |
| 600 s | 96.0989 / 96.0708 | 96.1084 / 96.0809 | +0.0094 |
| 900 s | 95.7965 / 95.7929 | 95.7903 / 95.7867 | −0.0062 |

Across the three equally sized excerpts, `slower` averaged only about **+0.013 VMAF** (about +0.014 harmonic), with the third scene slightly favoring `slow`. That is not a meaningful or consistent quality gain for a 73% encode-time increase. Keep `slow`; there is no reason to change the V15 preset based on this sample.

