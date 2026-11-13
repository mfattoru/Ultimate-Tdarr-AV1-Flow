# Failure diagnosis and notification behavior

## Source-corruption search policy

### Invalid H.264 NAL units

`[Video guard] ffprobe exited 0 but emitted stderr` with `Invalid NAL unit size`, `Error splitting the input into NAL units`, or `missing picture in access unit` comes from the flow's CPU source-frame scan. For tagged progressive SDR and verified static HDR10 longer than 16 seconds, that scan starts with 5-second samples at the beginning, middle, and end. Other color/HDR routes and short or non-progressive-tagged inputs still use a full source scan before encoding. If a sample scan fails, the flow falls back to a full source scan before reporting the failure. A zero exit code does not make an error-level bitstream diagnostic clean: the decoder emitted corruption errors, so the guard keeps the source. This points to damaged source video/container data, not an AV1 encode failure.

The flow requests a targeted replacement search for this source-scan signature only after matching the exact file to an Arr item: Sonarr `EpisodeSearch` for episodes or Radarr `MoviesSearch` for movies. The original is left in place. No file is deleted or moved, and no monitoring settings are changed. A successful API response means the search was queued, not that it found or accepted a replacement; quality-profile and upgrade rules still apply. If the file cannot be mapped or no replacement arrives, inspect playback and search manually.

The named Prince of Tennis episode was present in the isolated test library and is H.264. Re-running the same full-frame ffprobe scan returned exit code 0 but wrote 156 stderr lines, including the quoted invalid-NAL-size, missing-picture, and NAL-splitting errors. This confirms the V13 source guard would stop before encoding for this file. The source mount remained read-only.

The same check was repeated for `Sample Sports Series - S02E17 - Sample Episode WEBDL-1080p.mkv`. Its full-frame ffprobe scan returned exit code 0 with 246 stderr lines, including the exact NAL-size and missing-picture errors from the Tdarr job. A separate strict video decode (`ffmpeg -v error -xerror ... -f null -`) exited 183 and reported `corrupt decoded frame` and `Invalid data found when processing input`. This confirms the file has actual source bitstream errors; the zero ffprobe exit code only means ffprobe recovered far enough to finish the scan.

The review's description of these messages as ordinary non-fatal notices is incorrect: both scans use `-v error`, and the strict decode independently fails. Two affected episodes from the same series are evidence of a recurring issue with those source files/release, but they do not establish that virtually every H.264 WEB-DL in the library has it. The unrelated WEB-DL samples reached during this check were already AV1, so they were not valid H.264 comparisons. Keep the guard fail-closed and do not blanket-ignore stderr. Recognized video bitstream errors from this source scan can request an item-scoped Sonarr or Radarr search; the source is never deleted.

### Other video/audio decode failures

The source frame scan recognizes a narrow list of data-corruption diagnostics across codecs, including malformed NAL/OBU data, corrupt decoded frames, missing access-unit pictures, invalid bitstreams, and truncated packets. On sampled routes, a hard encode or output-validation failure triggers a full CPU source scan for diagnosis. A recognized corruption signature can request an item-scoped Arr search; a generic validation failure or unrecognized diagnostic does not. It does not turn every non-empty FFprobe stderr message into an Arr search.

V14 also fully decodes every retained source audio track before encoding. Language filtering and existing same-language redundancy pruning run first, so tracks intentionally removed by policy are not checked or copied. FFmpeg uses `-xerror`; a non-zero exit or a recognized audio-bitstream corruption diagnostic keeps the original. Confirmed source audio corruption can request a targeted Arr search after exact item matching. A zero-exit diagnostic is logged but does not fail the precheck unless it matches a known audio-corruption signature. The completed candidate still receives a full decode of retained audio plus the existing source/output audio timeline checks before replacement. A seek-heal remux can repair container timestamps/indexes, but cannot reconstruct damaged compressed audio packets.

If candidate video/audio decoding fails, the flow also strictly decodes the corresponding original video and retained audio streams. A search is requested only if recognized source corruption is confirmed. If the source decodes cleanly, or the failure looks like an encoder, mux, unsupported-format, driver, or other output-only problem, the flow keeps the original without searching Arr.

Episodes require an exact Sonarr episode match; movies require an exact Radarr movie-file match. A queued search may still produce no replacement if no qualifying release is available or accepted by the profile.

### Video presentation timestamp validation

The first sampled-precheck candidate used FFprobe intervals ending with `start%+5`. FFprobe can seek backward to a preceding keyframe and count that five-second duration from the seek result, leaving only part of the requested window or none of it. The candidate then compared the partial source interval with five seconds of output frames, causing false frame-count mismatches such as `100 source, 120 output` or `0 source, 119 output`. The local fix uses an absolute end timestamp for each interval. A long-GOP local reproduction failed before the fix with sample counts `[120, 60, 0]` for three expected 120-frame windows, then passed with `[120, 120, 120]` after the fix. This validates the interval fix with local FFmpeg 8.1; it has not yet been verified on the Unraid Tdarr node.

After encoding, the flow scans the candidate's full FFprobe `frame` timeline. It compares the full source and output timelines on full-scan routes, and the matching beginning/middle/end sample windows on sampled SDR/static-HDR10 routes. Frame counting is independent of the optional `interlaced_frame` field, so a missing interlace value no longer silently drops that frame and its timestamp from the count. The check still fails closed if a checked frame timestamp is missing, timestamp counts do not match, the sampled-window frame counts differ, the full-route frame counts differ, or normalized timestamps differ by more than 50 ms.

The `Untagged output color range changed` diagnostic is separate from source corruption. It means the candidate range tag did not match the range expected by policy; by itself, it does not prove the source pixels were converted incorrectly or that the source is damaged. The local candidate now assigns limited `tv` range to untagged SDR YUV only when stream metadata, decoded frames, and MediaInfo provide no range. Explicit or observed full range is kept, and `yuvj422p`/`yuvj444p` are treated as full-range formats. The AV1 encode and seek-heal remux both receive the resolved range tag. Primaries, transfer, and matrix remain unspecified. This default does not apply to HDR/Dolby Vision, RGB, unsupported pixel formats, or conflicting/unrecognized range data. It records a conventional assumption; it does not recover missing source metadata.

The failure detail reports source/output frame counts, timestamp counts, and the first frame indexes with missing or invalid timestamps. This is an output validation failure, not proof that the source is corrupt; it does not trigger an Arr search. The candidate is discarded and the original is kept. Later packet-timeline and full video/audio decode checks run only after the per-frame timestamp comparison passes.

### Output frame count differs

The 2026-11-02 rerun for *Sample Fantasy Series - S02E11* reported 33,984 source frames and 33,749 output frames: 235 fewer frames in the candidate. The source was HEVC Main 10 at 1920×1080, and the AV1 candidate was 32.2% smaller, but it was rejected and the original retained. This proves the candidate did not preserve the scanned frame count; it does not by itself prove source corruption. The per-frame guard stopped validation before packet-timeline and full-decode checks, and the job log confirms the Discord failure notification was sent. No Arr search was triggered.

The V14 candidate retains the V13 `-fps_mode:v passthrough` fix on Arc encodes, because FFmpeg's automatic frame-sync mode can drop or duplicate frames depending on the selected mode and muxer. This setting is intended to pass each decoded frame with its timestamp; the source/output frame and timestamp guards remain active. The exact episode has not yet been rerun with this setting, so this is a candidate fix rather than a live-verified result.

### Subtitle packet count is lower in the output

`Output subtitle packet count 4027 is less than source 4028 for stream 3` is raised after the encode, while validating the new candidate. The candidate is rejected and the original remains. This says that the candidate has a different subtitle packet count; it does not say that the source itself is damaged.

Recommended action: inspect the affected subtitle track/cues and the encode/mux result. Do not delete or request an Arr replacement from this count mismatch alone. Keep the check conservative until the output's subtitle content is shown to be equivalent.

## Oversized ASS/SSA subtitle encoding errors

`Subtitle encoding failed`, `Error encoding a frame: Buffer too small`, or a related SRT encoder error means FFmpeg could not convert a subtitle event. ASS/SSA tracks can contain very large vector drawings; flattening them to SubRip may fail or lose styling. Matroska ASS/SSA tracks are now stream-copied in their original format, and the success notice reports how many were preserved. If this error appears for a non-Matroska input, the flow's conversion path still needs a compatible target or a specific supported conversion. The original remains in place.

For Jellyfin, set **Burn subtitles** to **Only Image Formats (VobSub, PGS, SUB)** on the TV and phone, and turn **Always burn-in subtitle when transcoding** off. Avoid **Auto** if you want to prevent burn-in of certain ASS/SSA tracks. Confirm that each client renders the styled subtitles; unsupported or complex tracks can still cause video transcoding.

## Cache capacity failures during seek-heal remux

`[Cache reservation]` or `Insufficient available capacity to grow reservation` means the remux approached its current output limit but could not reserve more space while protecting the configured cache and host-RAM floors. The flow stops FFmpeg, removes the partial candidate, and keeps the original. Clear or expand the selected scratch cache, then retry. This is a cache-capacity failure, not evidence that the source is corrupt.

The remux file-size limit grows only after the shared reservation ledger grants capacity. That ledger coordinates Tdarr jobs using it; it cannot control unrelated writers, filesystem quotas, or storage remounts. An external writer can still cause a write failure, which keeps the original.

## Worker canceled by the user

`Cancelled worker: user` is Tdarr reporting that its worker was canceled. It is not an FFmpeg exit code or evidence that the transcode failed. In the WorldEnd S01E06 log, the Arc encode reached its size cap, the seek-heal remux completed, and the worker was canceled while candidate validation was running. The log contains no completed validation result, so the candidate was not approved for replacement; the original should remain. Because Tdarr stops the worker outside the flow, downstream cleanup and Discord notification nodes are not guaranteed to run.

Current flow reservations carry a worker-host identity, a 30-second heartbeat, and the exact job scratch directory. On `SIGTERM` or `SIGINT`, the flow kills its tracked FFmpeg/FFprobe process groups and removes only that job's recorded scratch directory; the reservation record is reclaimed on the next cache admission. A hard-killed worker is reclaimed on the next admission, or an abandoned live lease expires after 15 minutes without a heartbeat. Existing V2 records from the earlier candidate lack that ownership data, so this cleanup fix applies to future jobs; inspect legacy reservations before removing them. The stopped test container was not restarted, and this cancellation has not been reproduced live.

## Missing optional HDR10 static metadata

Correctly signaled HDR10 does not require fabricated mastering-display or content-light values. If either is absent in the source, the flow leaves it absent; if the source contains one, output validation requires it to survive. A color conflict or unsupported HDR route is still held. Dolby Vision Level 6 values are used only on the existing verified Dolby Vision fallback routes, not to fill ordinary HDR10 gaps.

## Sample Anime Series source check

The episode was present in the isolated test container at:

`/path/to/source-video.mkv`

The `/mnt/media` mount is read-only. FFprobe counted 4,028 packets in source ASS stream 3 (`Signs & Songs (Bakaizer)`). A standalone FFmpeg stream-copy remux of that source stream to Matroska, using the flow's timestamp flags, exited 0 and retained all 4,028 packets. This is evidence against the source being corrupt in the way the failed check suggests. The failed flow output itself was not available for cue-by-cue comparison, so this does not identify which output packet differed.

For comparison, extracting the same source stream to an `.ass` file yielded 3,988 packets. Packet counts can change when subtitle data is remuxed to a different container; that is why the standalone `.ass` count is not used to judge source damage. The source-to-output failure was Matroska-to-Matroska and still warrants a conservative output rejection.

The candidate's ASS/SSA policy was then checked against this full source in the existing isolated test container. Both Matroska ASS tracks (streams 3 and 4) were stream-copied to a scratch Matroska output with FFmpeg exit 0. The source/output packet counts matched: 4,028 for “Signs & Songs (Bakaizer)” and 4,354 for “Full Subtitles (Bakaizer).” This validates FFmpeg's copy path for the real tracks, but it was a subtitle-only scratch remux, not the full candidate Tdarr encode. The local integration suite separately verifies the generated Arc command uses one AV1 encode with ASS/SSA mapped as `copy`.

## Updated Discord messages

The notifier now reports:

- **Confirmed source video/audio corruption:** identifies whether corruption was found in the original stream and reports whether an item-scoped Sonarr/Radarr search was queued or why it was skipped.
- **Per-frame timing validation:** says when source/output frame timing could not be confirmed, confirms the candidate was discarded and the original kept, and includes counts plus missing frame indexes when available. This check alone does not trigger an Arr search.
- **Subtitle packet mismatch:** shows the missing-packet count and stream index, confirms the candidate was discarded and the original kept, and says not to treat that check alone as proof of source damage.
- **Other safety-check failures:** says the candidate failed validation, preserves the original-state qualification when known, and points to the technical details and Tdarr log.

Each message keeps a shortened technical detail block. No notification was sent to Discord while developing this change; the notifier tests use a mocked HTTPS endpoint. The isolated Tdarr container still has V12 imported, so the updated V13 webhook has not yet been exercised live.

## Strict stderr checks

The V13 frame scanner and PGS extractor both treat non-empty stderr as failure even when FFmpeg/ffprobe exits 0. This is true. Both commands run at `-v error`, however, so Sample Sports Series NAL messages are actual decoder errors rather than ordinary informational notices. The PGS rule can still reject a recoverable extraction error; there is no concrete PGS sample showing a benign error-level message in this test. Keep the PGS check fail-closed unless a reproducible false positive justifies narrowing it.

## Candidate decode reports non-monotonic DTS

Sample Fantasy Series S02E11 notice showed `Application provided invalid, non monotonically increasing dts to muxer` during the candidate's full video/audio decode check. FFmpeg exited 0, but the validator treats any stderr from this strict check as a failure, so the candidate was discarded and the original kept. The message comes from the null-output muxer receiving repeated or out-of-order decode timestamps; it is a timing/muxing diagnostic, not proof by itself that the source bitstream is corrupt.

The preceding frame-count, per-frame presentation-timestamp, and packet-timeline checks had passed before this final decode step. Strict source decodes did not match a recognized source-corruption signature, so this warning alone should not trigger a Sonarr/Radarr search. The screenshot does not include the source decode diagnostics or FFmpeg command, so it cannot show whether the source had a similar timestamp warning or whether the running candidate included the local `-fps_mode:v passthrough` change. The local V13 builder now includes the source decode result in this failure detail and presents the DTS case as an output-timing warning; this reporting update has not been live-verified in Tdarr.

Do not suppress the DTS message or accept the candidate on exit code 0 alone. Review the full Tdarr log and source decode detail before changing timestamp handling. The duplicate `[Safety check failed]` prefix in the screenshot is a formatting issue; current local output collapses repeated prefixes.
