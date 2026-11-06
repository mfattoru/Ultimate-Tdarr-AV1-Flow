# Tdarr Arc AV1 V15 design

**Updated:** 2026-11-04  
**Design state:** implemented as a local 17-plugin candidate; selected live behavior has been exercised in the existing isolated test instance.  
**Deployment state:** the latest sanitized local export has not been imported into Tdarr. The test instance still contains an older V15 import with legacy static Arr settings. Production state is not assessed or changed by this document update.

## Intent

Run one Arc QSV AV1 encode for each eligible video while preserving a validated original whenever the encode, remux, or checks do not produce a safe replacement. Keep the flow unattended, explain its decisions through Tdarr progress/status and Discord, and keep Arr searches limited to confirmed source corruption.

## Processing design

1. **Identify and classify the input.** Handle ISO images through the approved delete-and-rescan path. Stop early with an information notice for files already carrying a recognized completion marker. Probe stream layout, codec, pixel format, color, HDR, and Dolby Vision before processing.
2. **Preflight the source.** Run the full CPU frame/color/HDR/timestamp scan and fully decode retained source audio. This scan is intentionally whole-file: the sampled-window experiment caused false frame-count failures in live use. Precheck progress is included in the worker percentage.
3. **Encode on Arc.** Use the Arc device (`/dev/dri/renderD129` by default, configurable with `TDARR_ARC_DEVICE`) for one AV1 QSV encode at global ICQ 22 by default (`TDARR_QSV_ICQ` can override it) and the tested `slow` preset. Direct QSV decode is used only on tested SDR codec/format paths; supported fallback inputs decode/convert on CPU and still encode on Arc.
4. **Apply the size fallback.** Keep a smaller AV1 output only after all checks pass. If the encode is not smaller, discard that attempt and seek-heal remux the original video with the normal audio/subtitle handling. The remux has no source-relative size cap; shared scratch reservations and filesystem/RAM floors bound its growth.
5. **Validate before replacement.** Fully compare source and candidate frame counts and normalized frame timestamps; verify streams and color/HDR metadata; compare audio/subtitle timelines and subtitle payloads; and strictly decode candidate video on Arc and audio on CPU. ASS/SSA stays styled and copied, with only bounded backward timestamp repair. If a candidate fails, retain the original. Request an Arr search only when recognized corruption is independently confirmed in the source.
6. **Finish visibly.** Report phase-specific worker status/progress, release job-owned scratch and capacity reservations, rescan after a successful replacement, and send the corresponding Discord success, failure, already-processed information, or ISO-deletion warning notice.

The [flow diagram](flow-diagram.md) shows the branches. Detailed media, notification, and safety rules are in [README.md](README.md); the release checklist and implementation history are in [V15_PLAN.md](V15_PLAN.md) and [IMPLEMENTATION_LOG.md](IMPLEMENTATION_LOG.md).

## Media and HDR policy

- Keep the current audio language selection and pruning behavior, stream-copy retained audio, and validate it by full decode. Keep ASS/SSA rather than converting styled tracks to SRT; preserve the existing subtitle selection rules.
- Preserve HDR/Dolby Vision metadata guards. HDR10 and HLG routes, HDR10+ static-base handling, and Dolby Vision Profile 7/8.1 HDR10-compatible fallback routes have representative tests. A short Sample Feature Film hybrid sample now supports only single-layer DV 8.1 plus HDR10+ with a verified HDR10 base; it still needs a full V15 job. Profile 8.4, Profile 5, conflicting hybrid signals, and other unverified variants remain held.
- Do not convert or relabel color solely to make a file pass. Retain unspecified tags for untagged SDR; apply the documented limited-range convention only to eligible untagged SDR YUV inputs.
- Do not create permanent recovery copies or serialize all jobs behind a whole-job lock. Keep per-job capacity reservations and exact byte comparison only when file identity suggests an Unraid Mover relocation.

## Quality decision and evidence

ICQ 22 remains provisional. The available SDR VMAF examples scored 96.62 TV / 97.66 phone for a sample from a full Sample Anime Series output, and 96.61 / 98.02 for the Sample 4K Film excerpt. The Sample 4K Film ICQ 22 encode was about 4% larger than its source-video remux, demonstrating why the no-size-win fallback is needed. A fresh matched HDR10 Sample HDR Film excerpt scored 106.18 against a 106.09 HDR model self-check; this is one controlled encode sample, not a general HDR quality guarantee.

Raw VMAF JSON results, the captured encode/extraction/scoring logs, model checksums, and a local file-hash manifest are now kept in [`evidence/vmaf/`](evidence/vmaf/README.md). The interpretation and sample methodology are in [QUALITY_DECISION.md](QUALITY_DECISION.md). HDR route and metadata outcomes are in [HDR_LIVE_VALIDATION.md](HDR_LIVE_VALIDATION.md), and codec path coverage is in [CODEC_COVERAGE.md](CODEC_COVERAGE.md).

## Validation boundary and remaining release gates

The live results in [LIVE_TEST_REPORT.md](LIVE_TEST_REPORT.md) came from the earlier imported V15 revision: representative Dolby Vision Profile 7/8.1 encodes, synthetic HLG remux, AV1 size-fallback remux, malformed H.264 source detection, and an HDR10+ output safely rejected by metadata validation. Those results prove those exact cases on that imported revision; they do not prove the latest sanitized export is running in Tdarr.

The latest local export uses environment-only Arr configuration. The test Tdarr instance still contains the earlier import with legacy embedded Arr settings, so the sanitized export needs to replace it before more end-to-end jobs. Mock tests cover Arr routing and request bodies, but live Arr requests, ISO deletion/refetch notice, already-processed notice, cache-denial, cancellation, and simultaneous jobs have not all been exercised end to end. Genuine HLG and Dolby Vision Profile 8.4 samples are unavailable. HDR10+ AV1 output remains rejected on the tested Arc runtime because decoded-frame mastering metadata is clamped; the strict validator is intentionally retained.

The user confirmed on 2026-11-04 that phase-specific labels change in Tdarr's test Status column. That UI check did not import the latest sanitized export or start a new test job.

V15 is therefore a reviewable candidate, not a production-ready release. Keep production unchanged until the sanitized export is imported into the existing test instance, the remaining release gates are exercised safely, and the candidate is reviewed.
