# Arc AV1 flow V11 — review export

`flow.json` is a private export containing credentials inherited from the supplied workflow. It has not been imported or assigned to a Tdarr library; the installed workflow will continue to behave as before until this V11 export is imported and assigned. Rotate the Discord webhook previously exposed in tool output and configure the new one before using the export. The failure notifier can read `TDARR_DISCORD_WEBHOOK` from the node environment; the export also contains the inherited default.

## HDR and Dolby Vision

The Arc encodes supported HDR content as 10-bit AV1 and validates the resulting color signals and metadata. The following paths are implemented, subject to the checks described below:

- HDR10: retain PQ/BT.2020 and matching static mastering and content-light metadata.
- HLG: retain HLG/BT.2020 signaling.
- HDR10+: convert the verified HDR10-compatible base to static HDR10, removing HDR10+ dynamic metadata.
- Single-layer HEVC Dolby Vision 8.1 with a verified HDR10-compatible base: convert to static HDR10, removing Dolby Vision metadata.
- HEVC Dolby Vision Profile 7 with a verified Blu-ray HDR10 base and validated HDR metadata: encode the HDR10 base and discard the enhancement layer and Dolby Vision metadata. For FEL titles, discarding the enhancement layer also loses its picture detail.
- Single-layer HEVC Dolby Vision 8.4 with a verified HLG-compatible base: retain the HLG base and remove Dolby Vision metadata. This is HLG, not an HDR10 conversion.

These downgrades are included in the job log and success notification. HDR10 requires consistent mastering and content-light metadata. When Dolby 8.1 or Profile 7 has no usable content-light data, the flow may derive it from Dolby Level 6 only after checking the complete extracted metadata and its agreement with mastering luminance. Temporary RPU/CSV files are removed on normal completion, although a crash may leave them behind.

**This export does not yet encode every HDR or Dolby Vision file.** Profile 5, unverified Profile 7 variants, AV1 Dolby Vision, combined Dolby Vision/HDR10+, HDR Vivid, and other unverified or conflicting signals are held and reported; the original remains. Missing or contradictory metadata can also prevent processing of otherwise compatible profiles. In particular, the Dolby 8.1 library sample with conflicting BT.709 tags cannot safely be relabeled as HDR10. Supporting additional variants needs verified conversion and output metadata handling; guessing HDR metadata is not a verified conversion.

For video with no known color transfer, primaries or matrix, the flow attempts an encode and checks that those fields remain unspecified, as requested. This cannot detect HDR whose signaling is entirely missing, and clients may interpret untagged video differently.

## Quality and size

QSV ICQ increases as quality decreases. SDR attempts are ICQ 19 then 23 for 1080p, and 19, 23, then 26 above 1080p. HDR 4K attempts use ICQ 18 then the provisionally approved 22; 720p and 1080p HDR use 19, and SD HDR uses 18. ICQ 22 was checked for file size but not for HDR perceptual quality, so these values are not a guarantee for every title or viewing condition.

The whole output must be strictly smaller than the original and pass validation. If it cannot meet the quality floor, the original remains. AV1 inputs are eligible, but completed V4, V5, V6, V7, V8, V9 and V11 markers prevent repeated processing of the flow's own outputs. No permanent recovery copy is made. The existing audio and subtitle selection rules remain in place.

## Live progress

The worker percentage and FPS are updated from FFmpeg's machine-readable output while an Arc encoding attempt runs. The percentage estimates the current attempt from processed time and source duration, and resets when the flow retries at another ICQ value or switches decode mode. It is not a percentage of the complete workflow: source inspection happens before the encode, and validation, cleanup and replacement happen afterward. The reported encode percentage stays below 100 until Tdarr advances the flow. Invalid or missing source duration prevents a meaningful percentage. If the worker update callback fails, encoding continues normally.

The progress updates have been exercised with a real disposable Arc encode and a simulated Tdarr callback, but the live Tdarr UI has not yet been verified with this export.

## Concurrency and cache

The flow no longer holds a lock for the entire job. Each job reserves estimated output space in a shared ledger; a short mutex protects only reservation updates, so multiple jobs can encode concurrently when space permits. The ledger deliberately counts all reservations against each candidate, including paths that may alias the same Unraid storage; that may underuse distinct disks but avoids assuming they are independent. Disk-backed cache is required; tmpfs/RAM is not selected.

`TDARR_RESERVATION_ROOT` defaults to `/transcode_cache` and must be an existing directory shared by all cooperating V11 workers, with working atomic directory creation. `TDARR_DEDICATED_CACHE` or the `dedicated_cache_dir` user variable can select a preferred cache. `TDARR_MIN_FREE_SPACE_MB` or `min_cache_free_mb` sets the free-space floor; the default is 20,480 MiB. All participating V11 jobs must use the same ledger. Older flows, unrelated applications, other workers with a different ledger, temporary Dolby metadata, and destination-side replacement space are outside the coordination. Each FFmpeg encode runs under Linux `prlimit` with a hard per-process file-size limit equal to the original file size. If an output reaches that limit, the flow discards the attempt and tries the next allowed ICQ value; if the quality floor is reached, the original remains. `prlimit` must be installed and usable or the job fails closed. This limit covers each file written by the encoder process, not a filesystem quota for all processes or all files in a job. The V6 soft limit could be exceeded, so V6 workers sharing the ledger do not provide the same guarantee; finish or stop those jobs before relying on the V11 budget.

A crash can leave a stale reservation or `.tdarr-av1-reservations.lock`. Verify that no affected jobs are active before manually removing stale ledger records or the lock. Never remove an active job's reservation.

## Validation, notifications and limitations

The engine checks source identity, complete output decode, video frame counts and timestamps, color signaling, selected tracks, output size and related properties. PGS subtitles are checked by matching actual subtitle segments and timestamps, rather than comparing container packet counts, which can change during a lossless remux. Other selected subtitle and audio streams are checked for their track properties and endpoints; this does not prove every interior event remains synchronized. Full frame scans and output decoding add CPU, memory, I/O and time. Perceptual quality and every possible metadata defect cannot be guaranteed. The source identity check and Tdarr's subsequent replacement are separate operations, so a simultaneous external writer can still race the replacement.

Failures route through a Discord notification with the engine's reason when available. A quality-floor failure says no smaller output was achieved; it does not report a fabricated FFmpeg exit code. Unexpected errors can have only a generic reason; a hard worker crash may prevent notification, and delivery has no durable retry queue. The notification and error routing have been tested with mocks, not by sending a real Discord message or through the live Tdarr lifecycle. After importing and configuring the webhook, test a controlled failure in Tdarr. Never post the private export or webhook publicly.

ISO deletion and the Arr rescan branch are retained. The alert says to check the Arr rescan log; a rescan is not a search and does not guarantee a replacement download.

The node needs `prlimit`, `mediainfo`, `ffprobe`, `ffmpeg`, `dovi_tool`, and an accessible Intel Arc render device; the default is `/dev/dri/renderD129`. Software decoding is allowed while AV1 encoding uses the Arc.

## Verification

Build with `python3 work/tdarr-flow-v11/build.py`. Run the Node test files in this directory with `node --test work/tdarr-flow-v11/{flow,pgs,reservations,failure_notify,policy,integration,progress}.test.js`. Test data and notification endpoints are mocked or disposable.

A recreated full remux of the affected episode preserved all 2,529 PGS segments and their adjusted timestamps despite a change in packet grouping. A disposable 35-second excerpt of that episode passed the flow at ICQ 23, from 12,100,121 to 9,078,516 bytes, keeping its color tags unspecified. Two disposable Arc jobs ran concurrently with two reservations. Synthetic HDR10+ clips with and without B-frames passed the HDR10 fallback; their test metadata was not derived from the pictures, so this is not a perceptual validation. A Dolby 8.4 HLG reference passed the conversion checks after its disposable source was padded with an inert attachment to exercise the smaller-file success branch; without that padding the encoded video exceeded the source and the quality floor correctly retained the original. No library file was replaced in these tests. V9 additionally passed a disposable four-second Profile 7 Sample HDR Film clip at ICQ 18 (28,361,531 to 10,940,872 bytes), retaining its HDR metadata while dropping the Dolby enhancement layer and metadata. A disposable Profile 7 Matrix clip revealed that the FFmpeg/Arc encoding path changed mastering green-y from 0.797 to about 0.763; validation rejected the output and kept the original. This can affect other HDR files with similar mastering values and has not yet been corrected.

## Node structure

V11 keeps the Arc encode, attempt state and output validation inside one engine node. Input, original recheck, replacement, cleanup, Arr rescan and notifications are separate nodes. This maintains a single owner for the temporary output and reservation. Further separation can improve visibility and maintainability, but needs a versioned per-job state contract and tests for errors, worker restarts and cleanup between every stage; moving code into nodes alone does not increase safety or concurrency.

A disposable Profile 7 excerpt was modified to remove the source content-light metadata while preserving Dolby RPUs and restoring its actual mastering information in the container. All 112 extracted Dolby Level 6 records matched, the flow restored MaxCLL 992 and MaxFALL 120, and the output shrank from 28,364,363 to 10,940,707 bytes. The source sample was unchanged. This was a video-only test; it is not a perceptual-quality evaluation.

A second disposable sample deliberately changed the container mastering luminance while retaining the original Level 6 values. The flow detected the conflict before replacement and retained the source.
