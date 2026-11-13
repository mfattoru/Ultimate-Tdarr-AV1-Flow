# Tdarr Arc AV1 V15 design

**Updated:** 2026-11-12
**Design state:** local 17-plugin candidate; includes Option 1A DV/HDR10 Level 6 conflict handling and `dovi5_hdr10` Profile 5 → HDR10 conversion via Vulkan `libplacebo` + `dovi_tool` Level 6/9 metadata synthesis, passing `314/314` automated tests and a 150-frame live container smoke check.
**Deployment state:** the latest sanitized local export has not been imported into Tdarr. The test instance still contains an older V15 import with legacy static Arr settings. Production state is not assessed or changed by this document update.

## Intent

Run one Arc QSV AV1 encode for each eligible video while preserving a validated original whenever the encode, remux, or checks do not produce a safe replacement. Keep the flow unattended, explain its decisions through Tdarr progress/status and Discord, and keep Arr searches limited to confirmed source corruption.

## Processing design

1. **Identify and classify the input.** Handle ISO images through the approved delete-and-rescan path. Before the completion-marker shortcut, honor the exact-path `arc_force_fresh_path` library variable or locate a quarantined candidate that matches the canonical source path and SHA-256. Reuse candidates only after current source checks. Probe stream layout, codec, pixel format, color, HDR, and Dolby Vision before processing.
2. **Preflight the source.** Run the full CPU frame/color/HDR/timestamp scan and fully decode retained source audio. This scan is intentionally whole-file: the sampled-window experiment caused false frame-count failures in live use. Precheck progress is included in the worker percentage.
3. **Encode on Arc.** Use the Arc device (`/dev/dri/renderD129` by default, configurable with `TDARR_ARC_DEVICE`) for one AV1 QSV encode at global ICQ 22 by default (`TDARR_QSV_ICQ` can override it) and the tested `slow` preset. Direct QSV decode is used only on tested SDR codec/format paths; supported fallback inputs decode/convert on CPU and still encode on Arc.
4. **Apply the size fallback.** Keep a smaller AV1 output only after all checks pass. If the encode is not smaller, discard that attempt and seek-heal remux the original video with the normal audio/subtitle handling. The remux has no source-relative size cap; shared scratch reservations and filesystem/RAM floors bound its growth.
5. **Validate before replacement.** Fully compare source and candidate frame counts and normalized frame timestamps; verify streams and color/HDR metadata; compare audio/subtitle timelines and subtitle payloads; and strictly decode candidate video on Arc and audio on CPU. ASS/SSA stays styled and copied, with only bounded backward timestamp repair. On every final-validation failure, preserve a complete candidate in quarantine when storage succeeds and keep the original. A later run of the same path and source hash repeats the current source checks and final validation without another encode. Request an Arr search only when recognized corruption is independently confirmed in the source.
6. **Finish visibly.** Report phase-specific worker status/progress, release job-owned scratch and capacity reservations, remove a quarantined candidate only after replacement succeeds, rescan after a successful replacement, and send the corresponding Discord success, failure, already-processed information, or ISO-deletion warning notice.

The [flow diagram](flow-diagram.md) shows the branches. Detailed media, notification, and safety rules are in [README.md](../../README.md); the release checklist and implementation history are in [V15_PLAN.md](../plans/V15_PLAN.md) and [IMPLEMENTATION_LOG.md](../plans/IMPLEMENTATION_LOG.md).

## Media and HDR policy

- Keep the current audio language selection and pruning behavior, stream-copy retained audio, and validate it by full decode. Keep ASS/SSA rather than converting styled tracks to SRT; preserve the existing subtitle selection rules.
- Preserve HDR/Dolby Vision metadata guards. HDR10 and HLG routes, HDR10+ static-base handling, Dolby Vision Profile 7/8.1 (+ HDR10+ hybrid) HDR10-compatible fallback routes, and verified Dolby Vision Profile 5 (`dovi5_hdr10`) via Vulkan `libplacebo` + `dovi_tool` Level 6/Level 9 static metadata synthesis are supported with strict output validation. On DV 7/8.1 HDR10-compatible routes when base CLL is absent/`0,0` and Dolby Level 6 mastering luminance conflicts with the HDR10 base, a warning is logged and CLL is omitted rather than failing or borrowing mismatched Level 6 CLL. Profile 8.4, unverified Profile 5 variants (or hosts without `libplacebo`/Intel Vulkan ICD), conflicting hybrid signals, and other unverified variants remain held.
- For HDR10, supplement missing FFprobe mastering and content-light side data only from stream-sourced MediaInfo fields with a recognized primaries label and exact parseable luminance values. Reject disagreements between MediaInfo and FFprobe, and keep the strict output comparison against the completed source record.
- Do not convert or relabel color solely to make a file pass. Retain unspecified tags for untagged SDR; apply the documented limited-range convention only to eligible untagged SDR YUV inputs.
- Keep complete candidates that fail final validation under `${TDARR_RESERVATION_ROOT}/tdarr-av1-quarantine` (default `/transcode_cache/tdarr-av1-quarantine`) with source/candidate hashes and bounded validation diagnostics. Keep this directory outside all scanned libraries; the engine rejects it when it falls inside the current library root. Require the exact canonical source path and matching content hash before reuse; keep the quarantine copy until successful replacement, an exact-path `arc_force_fresh_path` run, or manual removal. Do not prune by age. Cross-filesystem quarantine copies use the existing capacity ledger and preserve configured free-space floors.
- Do not serialize all jobs behind a whole-job lock. Keep per-job capacity reservations and exact byte comparison only when file identity suggests an Unraid Mover relocation.

## Quality decision and evidence

ICQ 22 remains provisional. The available SDR VMAF examples scored 96.62 TV / 97.66 phone for a sample from a full Sample Anime Series output, and 96.61 / 98.02 for the Sample 4K Film excerpt. The Sample 4K Film ICQ 22 encode was about 4% larger than its source-video remux, demonstrating why the no-size-win fallback is needed. A fresh matched HDR10 Sample HDR Film excerpt scored 106.18 against a 106.09 HDR model self-check; this is one controlled encode sample, not a general HDR quality guarantee.

Raw VMAF JSON results, the captured encode/extraction/scoring logs, model checksums, and a local file-hash manifest are now kept in [`evidence/vmaf/`](../../evidence/vmaf/README.md). The interpretation and sample methodology are in [QUALITY_DECISION.md](QUALITY_DECISION.md). HDR route and metadata outcomes are in [HDR_LIVE_VALIDATION.md](../reports/HDR_LIVE_VALIDATION.md), and codec path coverage is in [CODEC_COVERAGE.md](CODEC_COVERAGE.md).

## Validation boundary and remaining release gates

The live results in [LIVE_TEST_REPORT.md](../reports/LIVE_TEST_REPORT.md) came from the earlier imported V15 revision: representative Dolby Vision Profile 7/8.1 encodes, synthetic HLG remux, AV1 size-fallback remux, malformed H.264 source detection, and an HDR10+ output safely rejected by metadata validation. Those results prove those exact cases on that imported revision; they do not prove the latest sanitized export is running in Tdarr.

A 2026-11-10 test-container job for a 61.79 GiB Pirates of the Caribbean HDR10 source completed the full source checks and a smaller QSV AV1 encode, then correctly rejected the candidate at `hdr_color`: FFprobe had not exposed source mastering side data, while the candidate contained it. The original was kept. That job also tried to rename its candidate from `/temp` into `/transcode_cache` and hit `EXDEV`, so the candidate was not retained. The local flow now strips unverified mastering side data and its quarantine helper copies across filesystems with SHA-256 verification; both changes still need to be confirmed in a newly imported test flow.

The latest local export uses environment-only Arr configuration. The test Tdarr instance still contains the earlier import with legacy embedded Arr settings, so the sanitized export needs to replace it before more end-to-end jobs. The new quarantine/revalidation behavior has not been imported or exercised end to end. Mock tests cover Arr routing and request bodies, but live Arr requests, ISO deletion/refetch notice, already-processed notice, cache-denial, cancellation, and simultaneous jobs have not all been exercised end to end. Genuine HLG and Dolby Vision Profile 8.4 samples are unavailable. HDR10+ AV1 output remains rejected on the tested Arc runtime because decoded-frame mastering metadata is clamped; the strict validator is intentionally retained.

The user confirmed on 2026-11-04 that phase-specific labels change in Tdarr's test Status column. That UI check did not import the latest sanitized export or start a new test job.

V15 is therefore a reviewable candidate, not a production-ready release. Keep production unchanged until the sanitized export is imported into the existing test instance, the remaining release gates are exercised safely, and the candidate is reviewed.
