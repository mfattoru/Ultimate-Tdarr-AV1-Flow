# Arc AV1 unattended V4 — SDR draft

This is a separate reviewable flow export. It has **not** been imported, assigned to a Tdarr library, or deployed. It contains credentials from the supplied flow; keep it private. Rotate the embedded Discord webhook because it was exposed in tool output during this review, then update the exported flow with the new webhook before using it.

## What is implemented

For eligible, clearly signaled SDR sources, including AV1 from older versions, Arc encoding starts at ICQ 19 and uses these whole-file retry sequences: 1080p SDR 19 → 23; larger SDR 19 → 23 → 26. SD uses 18 and 720p uses 19, with no further retry; these smaller tiers have not been calibrated. Higher ICQ is lower quality. The tested values are starting hypotheses from two six-second scenes per source, not a guarantee of quality for the whole library. The resulting file must be strictly smaller than the original including audio, subtitles, and container overhead. If all attempts reach the floor without a smaller output, or a validation or encoder check fails, the flow fails the job and keeps the original. It never falls back to a larger stream-copy remux.

A current-version AV1 completion marker avoids repeated lossy generations; it is checked from a fresh input probe and verified in the output before replacement. If a later remux removes the marker, the file can be processed again. The candidate uses the configurable Arc device (default `/dev/dri/renderD129`), preserves the existing audio and subtitle choices and the ISO deletion plus Arr scan route, and makes no permanent recovery copy. More than one video stream is rejected rather than discarded. Sources using chroma above 4:2:0, greater than 10-bit precision, interlacing, unknown aspect ratio, or ambiguous field order (except AV1) are also held until a suitable path is verified.

Validation checks original identity, output size, codec, selected streams, video dimensions, frame counts, sample aspect ratio, selected stream timelines, SDR color tags present on the source, output decode, and marker. Frame counting and full decoding add substantial time, and may reject valid unusual media. These checks do not prove visual quality or catch every possible defect. The V3 original and destination checks still have a race before Tdarr's separate replacement operation; avoid other writers changing library files during processing.

## HDR and Dolby Vision are not enabled

**The requested fully unattended HDR/Dolby Vision policy is incomplete.** All identified HDR, Dolby Vision, and ambiguous or untagged color inputs currently fail before encoding, keeping the original. This includes HDR10 and HDR10+. Merely copying color tags or comparing static mastering metadata cannot prove that all dynamic HDR/Dolby Vision data has been detected or safely converted. A profile 8 library sample also has conflicting color metadata.

A disposable HDR10 sample was successfully encoded and checked in a prototype before this stricter guard was enabled. The approved provisional 4K HDR sequence 18 → 22 and static HDR10 validation are present in the draft, but are unreachable until dynamic metadata detection and the Dolby Vision/HDR10 fallback are verified. ICQ 22 was tested for HDR file size only, not perceptual HDR quality. HLG and other HDR formats need verified paths as well.

## Cache and limitations

See `../tdarr-flow-v3/README.md` for cache locking, cleanup, free-space limits, ISO/Arr semantics, and the replacement race. `mediainfo` and `ffprobe` must be installed on the node. An unavailable or uncertain media probe fails the job. The capacity lock only coordinates flows using its protocol; a crashed job can leave a stale lock. The marker terminal and Tdarr replacement lifecycle have not been exercised in a live Tdarr flow.

## Verification

Build with `python3 work/tdarr-flow-v4/build.py`; run `node --test work/tdarr-flow-v4/policy.test.js work/tdarr-flow-v4/integration.test.js`. The tests use disposable local files and mock the actual QSV invocation. In addition, a disposable synthetic SDR clip was processed by the full draft engine on the real Arc and passed its checks; a preliminary HDR10 clip test applied to the earlier prototype, not the current guarded flow. The V3 regression suite was run separately; it is not a substitute for running this draft in Tdarr.
