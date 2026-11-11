# Tdarr Arc AV1 Flow

V15 is a single-pass Tdarr flow for encoding eligible video with Intel Arc Quick Sync AV1. It applies audio and subtitle policies, validates the source and candidate, and only replaces the library file after the candidate passes its checks.

## At a glance

```mermaid
flowchart TD
    A[File enters flow] --> B{ISO?}
    B -- Yes --> C[Delete ISO]
    C --> D[Request Arr rescan and send warning]
    B -- No --> E{Exact force-fresh override?}
    E -- Yes --> F[Remove quarantine for this path; bypass marker]
    E -- No --> G{Candidate matches path and source SHA-256?}
    G -- Yes --> H[Copy candidate to scratch; bypass marker]
    G -- No --> I{Completion marker present?}
    I -- Yes --> J[Keep file and send info notice]
    I -- No --> K[Header, Arc device, and configuration guards]
    F --> L[Rebuild source expectations]
    H --> L
    K --> L
    L --> M{Source prechecks pass?}
    M -- No --> N[Keep original]
    M -- Yes --> O{Revalidating a stored candidate?}
    O -- Yes --> P[Run current candidate size and final validation; skip encoding]
    O -- No --> Q[One Arc QSV AV1 encode at ICQ 22]
    Q --> R{Candidate is smaller?}
    R -- Yes --> S[Candidate validation; stop early on mismatch]
    R -- No --> T[Seek-heal remux using source video]
    T --> S
    P --> U{Current validation passes?}
    S --> U
    U -- Yes --> V[Recheck original and replace]
    V --> W[Remove quarantine only after replacement succeeds]
    U -- No --> X[Keep original; store or update complete candidate in quarantine]
    X --> Y{Known source corruption confirmed?}
    Y -- Yes --> Z[Request targeted Arr search]
    Y -- No --> AA[No search request]
    Z --> AB[Send failure notice]
    AA --> AB
    W --> AC[Send success notice]
```

For the full node-by-node view, see [the flow diagram](flow-diagram.md).

## Processing policy

| Area | V15 behavior |
| --- | --- |
| Video encode | One Arc QSV AV1 attempt for each eligible video, using global ICQ 22. HDR sources whose mastering green-y falls in the documented Intel QSV clamp range route directly to one software SVT-AV1 encode at CRF 28; strict output HDR checks still apply. The Arc device defaults to `/dev/dri/renderD129`. |
| Larger encode result | Discard the encode attempt and stream-copy the source video through the seek-healing remux. The remux has no source-size cap; it can replace the source when full validation passes. |
| Source scan | Header-only pixel/depth, aspect-ratio, Arc device access, ICQ, 12-bit, and applicable HDR color checks run first. Supported Dolby Vision routes validate required Level 6 metadata before the full CPU frame, color/HDR, timestamp, and corruption scan. The scan stops on a decisive failure; eligible clean sources are still scanned end to end. Retained audio is checked and decoded before the encode. |
| Candidate checks | Full frame/timeline, stream/color/HDR/subtitle, and strict A/V decode checks guard replacement. Supported video uses Arc QSV verification with one full software decode retry if QSV fails; other codecs use software directly. Results distinguish passed, recovered, rejected, and inconclusive checks. |
| Failed candidate | A complete candidate that reaches final validation and fails is retained in quarantine. Requeueing the unchanged source re-runs source prechecks and current candidate validation without encoding. |
| Audio | Keep English, Japanese, Spanish, Italian, and undetermined tracks. Preserve selected audio streams by copy, then run timing and decode checks. |
| Subtitles | Preserve styled ASS/SSA streams by copy. Validate subtitle packet counts and timing; retain PGS payloads and validate extracted segments. Muxing uses a ten-second interleave bound so sparse subtitle packets cannot hold output open indefinitely. |
| Notifications | Send success/failure notices, an info notice for already-processed files, and a warning when an ISO is deleted and an Arr rescan is requested. |
| Arr searches | Route a targeted search only when the flow confirms known source corruption. A queued search does not guarantee a replacement download. |

## Video formats and HDR

The tested SDR paths include H.264, HEVC, AV1, VP8/VP9, MPEG-2, MPEG-4 Part 2, ProRes, and FFV1 samples. The flow accepts listed planar YUV 4:2:0, 4:2:2, and 4:4:4 formats up to 12-bit when a supported color path is established. Unsupported pixel formats, RGB/alpha, interlaced video, and unverified color combinations are held with the original retained.

HDR handling is deliberately signal-aware:

- Verified HDR10 and HLG use their guarded encode paths.
- HDR10+ is converted using its static HDR10 base; dynamic HDR10+ metadata is not retained.
- Verified Dolby Vision Profile 7 HDR10-compatible base layers and Profile 8.1 paths produce HDR10. A Profile 7 plus HDR10+ hybrid is accepted only with verified BL/EL/RPU presence and compatibility ID 6; Profile 8.1 plus HDR10+ still requires its verified single-layer HDR10 base. Dolby Vision and HDR10+ dynamic metadata, and Profile 7 enhancement-layer detail, are discarded; static HDR10 metadata is validated before replacement.
- For HDR10, stream-sourced MediaInfo mastering and content-light fields can fill missing FFprobe side data when their values parse exactly and the primaries label is recognized. Any existing FFprobe values must agree, and the encoded candidate must still match the completed source record; unknown or conflicting metadata is not guessed.
- A decoded CLL pair of `0/0` means unspecified; the flow does not treat it as conflicting with CLL values taken from Dolby Level 6.
- Profile 5, unverified hybrids, and unvalidated Profile 8.4 inputs are held.
- Missing color data is not invented except for the documented limited-range default on supported untagged SDR YUV.

See [codec coverage](CODEC_COVERAGE.md) and [HDR validation](HDR_LIVE_VALIDATION.md) for tested cases and remaining limits.

## Runtime configuration

Configure these variables in the Tdarr node/container environment:

| Variable | Purpose |
| --- | --- |
| `TDARR_ARC_DEVICE` | Arc render device; defaults to `/dev/dri/renderD129`. |
| `TDARR_QSV_ICQ` | Global QSV quality value; defaults to `22`. |
| `TDARR_DECODE_THREADS` | CPU decode threads per job; defaults to `4`, accepted range `1–16`. `TDARR_PRECHECK_THREADS` is a compatibility alias. |
| `TDARR_DISCORD_WEBHOOK` | Discord notification endpoint. |
| `TDARR_ARR_RADARR_URL`, `TDARR_ARR_RADARR_API_KEY` | Radarr endpoint and key. |
| `TDARR_ARR_SONARR_TV_URL`, `TDARR_ARR_SONARR_TV_API_KEY` | TV Sonarr endpoint and key. |
| `TDARR_ARR_SONARR_ANIME_URL`, `TDARR_ARR_SONARR_ANIME_API_KEY` | Anime Sonarr endpoint and key. |

Unset Arr settings disable that target. The local `.env` is ignored by Git and does not load automatically in Tdarr; `.env.example` lists the variable names without values. Keep production secrets in the Tdarr node environment.

## Progress and scratch space

The worker reports progress during the source scan, audio checks, Arc encode, seek-heal remux, output scan, and decode validation. The Status field changes to show the current phase. Metadata-only work has no meaningful FPS value.

Candidate validation records its stage, outcome, and bounded diagnostics in `variables.user.validation_report`. A QSV verification failure can recover only after a clean, complete software decode and all remaining checks pass; this retries verification without another encode. Success notices identify that recovery. A confirmed mismatch is **rejected**. A tool failure or unavailable measurement is **inconclusive**, requiring review. Both retain the original and preserve the complete candidate in quarantine when it reached final validation. Retained audio decode accepts the known TrueHD `quant_step_size larger than huff_lsbs` diagnostic only when FFmpeg exits successfully; other diagnostics remain subject to the normal checks. Earlier failures and incomplete outputs still use normal scratch cleanup. Tdarr marks failed jobs as errors, while the job reason and notification explain which outcome occurred. Diagnostics survive cache cleanup in the job log, variables, and quarantine manifest.

Stream, frame-count, color/HDR, payload, and timing requirements retain their existing tolerances. Missing source timestamps can make comparison inconclusive; timestamps newly lost from an otherwise complete candidate are a rejection. Candidate-only failures and inconclusive checks cannot trigger an Arr corruption search. A source search after a decode rejection requires an independent strict decode failure on the corresponding source track.

Jobs coordinate scratch capacity through shared reservations rather than a single-job lock. `/dev/shm` is preferred when capacity and host-RAM headroom allow it; otherwise the configured disk cache is used. Each job records its own scratch directory and reservation heartbeat.

## Candidate quarantine and fresh re-encoding

Complete candidates that fail final validation are kept with a small manifest under `${TDARR_RESERVATION_ROOT}/tdarr-av1-quarantine`; when `TDARR_RESERVATION_ROOT` is unset, this is `/transcode_cache/tdarr-av1-quarantine`. Keep this directory outside every scanned media library; the engine rejects a path that falls under the current library root. Quarantine is not automatically pruned. The manifest binds the candidate to the canonical source path and source SHA-256, and records the candidate SHA-256, completion marker, encode/remux type, and latest validation report. Cross-filesystem copies reserve destination capacity. If a direct rename reports `EXDEV`, the flow falls back to a reserved copy and verifies its SHA-256 before installation. If quarantine storage still cannot be completed safely, the original stays in place and the normal scratch cleanup runs.

When the same source path and content are queued again, the flow still rebuilds its current source expectations and runs the current candidate size and final validation policy. It copies the quarantined candidate into job scratch before validation, so a failed retry or replacement cannot consume the quarantine copy. After replacement succeeds, the success cleanup removes that candidate and manifest. A changed source hash will not reuse an older candidate.

To discard the stored candidate and force a new encode for one file, open the target library in Tdarr's **Libraries** UI and set the library variable `arc_force_fresh_path` to the exact node-visible source path. Requeue that file once, then clear the variable. It removes quarantine entries for that exact path and bypasses the completion-marker shortcut for that run. The setting persists until cleared, so leave it unset for ordinary jobs.

Quarantine has no age-based cleanup. To purge all retained candidates manually, stop jobs that use the cache and remove the contents of `/transcode_cache/tdarr-av1-quarantine` (or the corresponding directory under `TDARR_RESERVATION_ROOT`).

## Quality evidence and limits

ICQ 22 is the current provisional value. It was selected from representative SDR and HDR tests and should not be read as a guarantee for every codec, source, or display. VMAF results and captured test evidence are in [`evidence/vmaf/`](evidence/vmaf/README.md); source titles and media paths have been anonymized.

The evidence uses short matched excerpts, not full-length viewing tests. VMAF is model-based, HDR scores can exceed 100, and HDR scores are not directly comparable to SDR scores. Review [the quality decision](QUALITY_DECISION.md) for methodology and limitations.

## Build and references

From the repository root:

```sh
python3 build.py
node --test *.test.js
```

The builder regenerates `flow.json`. V12 and V14 snapshots and older archives are under [`work/`](work/). Useful references:

- [Failure diagnostics](FAILURE_DIAGNOSTICS.md)
- [Subtitle mux validation](SUBTITLE_MUX_TEST_REPORT.md)
- [Audio and HDR repair results](HDR_AUDIO_REPAIR_TEST_REPORT.md)
- [Live test scope](LIVE_TEST_REPORT.md)
- [Performance benchmark](PERFORMANCE_BENCHMARK_2026-11-04.md)
- [Precheck thread benchmark](PRECHECK_THREAD_BENCHMARK_2026-11-05.md)

The test reports cover specific samples and routes. They do not claim an exhaustive codec matrix or a full end-to-end production validation of every input combination.
