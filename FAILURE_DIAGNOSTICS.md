# Failure diagnosis and notification behavior

## Candidate validation outcomes

The final checks maintain a structured `variables.user.validation_report` with `outcome`, the current/failing `stage`, completed checks, recovery diagnostics, and the failure code. Complete candidates that reach final validation are kept in quarantine on rejected or inconclusive results. Earlier failures and incomplete outputs are removed by the existing scratch cleanup nodes.

- `passed`: every required check completed successfully.
- `recovered`: QSV verification failed, a full strict software video decode passed, and all remaining checks passed. The encode itself is not repeated.
- `rejected`: the candidate violated a required property, such as a retained stream count, HDR metadata, frame count, timing, payload, or a recognized software decode error. This alone does not identify a corrupt source.
- `inconclusive`: verification could not establish the result, for example because a process could not start, timed out, ran out of resources, or the necessary source measurements were unavailable. This is a request to inspect/retry the check, without a claim that the media is damaged.

Rejected and inconclusive results keep the original, follow the failed-flow route, and remain Tdarr errors. Their notification categories are distinct. The original must still pass the identity check immediately before replacement.

### Decoder verification fallback

The final video decode uses QSV only for the codec/pixel-format combinations already admitted by the flow's QSV capability policy. If that verification fails, including a zero exit with error-level diagnostics, the flow makes exactly one full software decode attempt using `-xerror`. A clean CPU result records a recovery and proceeds to retained-audio verification. If CPU verification also fails, recognized bitstream diagnostics reject the candidate; tool failures and unrecognized diagnostics are inconclusive. A timeout or killed process takes precedence over incidental corruption text in its stderr.

Successful retained-audio verification still uses one combined decode. The specific TrueHD `quant_step_size larger than huff_lsbs` diagnostic is tolerated only when the decode process exits successfully, matching the source precheck; other diagnostics remain subject to the normal checks. A combined failure is isolated by candidate audio track. A recognized candidate decode failure prompts a strict recheck only of the corresponding source video/audio track, with the original identity checked around that source decode. Only an independently confirmed source failure authorizes the existing targeted Arr corruption search. An inconclusive or candidate-only report explicitly disables that action, even if its diagnostic text resembles a source-corruption reason.

Resource, device, permission, and I/O diagnostics take precedence over generic “error while decoding” wording, including during the original source precheck. PGS extraction preserves process failure details. Missing source ASS/SSA timestamps or unavailable packet hashes make the comparison inconclusive; a candidate that newly loses usable timestamps or changes a measured payload is still rejected.

This change does not rewrite HDR metadata, widen timing tolerances, or add an encode retry. Known HDR QSV clamp risks continue to select the existing SVT-AV1 route before encoding. Local regression coverage includes real complete software decoding of synthetic candidate media after a simulated QSV device failure; it does not substitute for a full-length Arc/Tdarr production run.

## Source-corruption search policy

### Multiple video tracks and zero-frame extras

The 2026-11-04 `Bye Bye, Earth - S01E05` job stopped before encoding because FFprobe reported two AV1 video tracks. In the read-only test-container probe, stream 0 produced a frame; stream 1 produced no frames through clean EOF, despite packet entries and a contradictory zero-duration Matroska tag. Strict software decode samples of stream 0 failed around 850, 1100, and 1360 seconds with malformed AV1 OBU diagnostics, including `Invalid repeated frame header OBU` and `Invalid data found when processing input`. This is source bitstream damage, not an Arc driver error. The old all-or-nothing multiple-video guard hid that source failure, so the production job did not reach its corruption search path.

The V15 candidate now probes each additional video stream with FFmpeg limited to its first decoded frame. A clean `frame=0` result at EOF is the only case ignored. Any decoded frame, decoder stderr, nonzero exit, or missing progress result keeps the original. The selected primary stream then still receives the complete source scan, which can classify the AV1 OBU error and request the exact Sonarr episode search under the existing item-match policy. This behavior has local integration coverage; this specific source has not yet run end-to-end through a newly imported Tdarr test flow. The inspection itself did not write to the media file or submit an Arr search.

### Invalid H.264 NAL units

`[Video guard] ffprobe exited 0 but emitted stderr` with `Invalid NAL unit size`, `Error splitting the input into NAL units`, or `missing picture in access unit` comes from the flow's CPU source-frame scan. V15 performs a complete CPU source-frame scan for every eligible file before encoding, including progressive SDR and static HDR10. It does not use sample windows or a sample-only fallback. A zero exit code does not make an error-level bitstream diagnostic clean: the decoder emitted corruption errors, so the guard keeps the source. This points to damaged source video/container data, not an AV1 encode failure.

The flow requests a targeted replacement search for this source-scan signature only after matching the exact file to an Arr item: Sonarr `EpisodeSearch` for episodes or Radarr `MoviesSearch` for movies. The original is left in place. No file is deleted or moved, and no monitoring settings are changed. A successful API response means the search was queued, not that it found or accepted a replacement; quality-profile and upgrade rules still apply. If the file cannot be mapped or no replacement arrives, inspect playback and search manually.

The source scanner can already label a diagnostic as `[Source media corruption]`. The engine normalizes repeated leading labels before saving the failure reason, so logs and Discord details show one category prefix. Earlier V15 logs could repeat this label several times; that was formatting duplication, not multiple scans or repeated failures.

The named Prince of Tennis episode was present in the isolated test library and is H.264. Re-running the same full-frame ffprobe scan returned exit code 0 but wrote 156 stderr lines, including the quoted invalid-NAL-size, missing-picture, and NAL-splitting errors. This confirms the V15 source guard would stop before encoding for this file. The source mount remained read-only.

The same check was repeated for `Sample Sports Series - S02E17 - Sample Episode WEBDL-1080p.mkv`. Its full-frame ffprobe scan returned exit code 0 with 246 stderr lines, including the exact NAL-size and missing-picture errors from the Tdarr job. A separate strict video decode (`ffmpeg -v error -xerror ... -f null -`) exited 183 and reported `corrupt decoded frame` and `Invalid data found when processing input`. This confirms the file has actual source bitstream errors; the zero ffprobe exit code only means ffprobe recovered far enough to finish the scan.

In the 2026-11-04 V15 job log for that episode, the precheck stopped before AV1 encoding. The video stream's reported duration (5:32) also disagreed with the audio and subtitle durations (about 22:07), consistent with a damaged or truncated video stream. Sonarr Anime accepted an exact one-episode `EpisodeSearch` request (HTTP 201); `arr_refetch_status: not_attempted` refers to the separate ISO-rescan action and does not negate the corruption search. The original stayed in place. The log also records `[Failure notification] Sent.` and `failure_notified: true`, indicating the configured webhook accepted the message. The repeated category label in that job was a display defect fixed in the local V15 builder.

The review's description of these messages as ordinary non-fatal notices is incorrect: both scans use `-v error`, and the strict decode independently fails. Two affected episodes from the same series are evidence of a recurring issue with those source files/release, but they do not establish that virtually every H.264 WEB-DL in the library has it. The unrelated WEB-DL samples reached during this check were already AV1, so they were not valid H.264 comparisons. Keep the guard fail-closed and do not blanket-ignore stderr. Recognized video bitstream errors from this source scan can request an item-scoped Sonarr or Radarr search; the source is never deleted.

### Other video/audio decode failures

The source frame scan recognizes a narrow list of data-corruption diagnostics across codecs, including malformed NAL/OBU data, corrupt decoded frames, missing access-unit pictures, invalid bitstreams, and truncated packets. Because the full source scan has already run, a hard encode or output-validation failure does not repeat the entire FFprobe scan. A recognized corruption signature can request an item-scoped Arr search; a generic validation failure or unrecognized diagnostic does not. It does not turn every non-empty FFprobe stderr message into an Arr search.

V15 scans retained audio packet DTS order and then fully decodes every retained source audio track before encoding. Language filtering and existing same-language redundancy pruning run first, so tracks intentionally removed by policy are not checked or copied. FFmpeg uses `-xerror`; a non-zero exit or a recognized audio-bitstream corruption diagnostic keeps the original. Confirmed source audio corruption can request a targeted Arr search after exact item matching. A zero-exit diagnostic is logged but does not fail the precheck unless it matches a known audio-corruption signature. The completed candidate still receives a full decode of retained audio plus the existing source/output audio timeline checks before replacement. A seek-heal remux can repair container timestamps/indexes, but cannot reconstruct damaged compressed audio packets.

If candidate video/audio decoding fails, the flow also strictly decodes the corresponding original video and retained audio streams. A search is requested only if recognized source corruption is confirmed. If the source decodes cleanly, or the failure looks like an encoder, mux, unsupported-format, driver, or other output-only problem, the flow keeps the original without searching Arr.

Episodes require an exact Sonarr episode match; movies require an exact Radarr movie-file match. A queued search may still produce no replacement if no qualifying release is available or accepted by the profile.

### Video presentation timestamp validation

The earlier V14 sampled-precheck candidate used FFprobe intervals ending with `start%+5`. FFprobe can seek backward to a preceding keyframe, so the requested interval could contain only part of the expected five seconds or no frames. The resulting sample-to-output comparisons caused false frame-count failures. Although a local absolute-end-time regression passed, live jobs still failed widely; reverting to the prior full-scan flow resolved the issue. V15 removes sampling instead of relying on that optimization.

After encoding, V15 scans every candidate frame and compares the full source and output timelines. Frame counting is independent of the optional `interlaced_frame` field. The check fails closed if a checked frame timestamp is missing, timestamp counts differ, full frame counts differ, or normalized timestamps differ by more than 50 ms.

The `Untagged output color range changed` diagnostic is separate from source corruption. It means the candidate range tag did not match the range expected by policy; by itself, it does not prove the source pixels were converted incorrectly or that the source is damaged. The local candidate now assigns limited `tv` range to untagged SDR YUV only when stream metadata, decoded frames, and MediaInfo provide no range. Explicit or observed full range is kept, and `yuvj422p`/`yuvj444p` are treated as full-range formats. The AV1 encode and seek-heal remux both receive the resolved range tag. Primaries, transfer, and matrix remain unspecified. This default does not apply to HDR/Dolby Vision, RGB, unsupported pixel formats, or conflicting/unrecognized range data. It records a conventional assumption; it does not recover missing source metadata.

The failure detail reports source/output frame counts, timestamp counts, and the first frame indexes with missing or invalid timestamps. This is an output validation failure, not proof that the source is corrupt; it does not trigger an Arr search. The candidate is discarded and the original is kept. Later packet-timeline and full video/audio decode checks run only after the per-frame timestamp comparison passes.

### Output frame count differs

The 2026-11-02 rerun for *Sample Fantasy Series - S02E11* reported 33,984 source frames and 33,749 output frames: 235 fewer frames in the candidate. The source was HEVC Main 10 at 1920×1080, and the AV1 candidate was 32.2% smaller, but it was rejected and the original retained. This proves the candidate did not preserve the scanned frame count; it does not by itself prove source corruption. The per-frame guard stopped validation before packet-timeline and full-decode checks, and the job log confirms the Discord failure notification was sent. No Arr search was triggered.

The V15 candidate retains the prior `-fps_mode:v passthrough` fix on Arc encodes, because FFmpeg's automatic frame-sync mode can drop or duplicate frames depending on the selected mode and muxer. This setting is intended to pass each decoded frame with its timestamp; the source/output frame and timestamp guards remain active. The exact episode has not yet been rerun with this setting, so this is a candidate fix rather than a live-verified result.

### Subtitle packet count is lower in the output

`Output subtitle packet count 4027 is less than source 4028 for stream 3` is raised after the encode, while validating the new candidate. The candidate is rejected and the original remains. This says that the candidate has a different subtitle packet count; it does not say that the source itself is damaged.

Recommended action: inspect the affected subtitle track/cues and the encode/mux result. Do not delete or request an Arr replacement from this count mismatch alone. Keep the check conservative until the output's subtitle content is shown to be equivalent.

## Oversized ASS/SSA subtitle encoding errors

`Subtitle encoding failed`, `Error encoding a frame: Buffer too small`, or a related SRT encoder error means FFmpeg could not convert a subtitle event. ASS/SSA tracks can contain very large vector drawings; flattening them to SubRip may fail or lose styling. Matroska ASS/SSA tracks are now stream-copied in their original format, and the success notice reports how many were preserved. If this error appears for a non-Matroska input, the flow's conversion path still needs a compatible target or a specific supported conversion. The original remains in place.

For Jellyfin, set **Burn subtitles** to **Only Image Formats (VobSub, PGS, SUB)** on the TV and phone, and turn **Always burn-in subtitle when transcoding** off. Avoid **Auto** if you want to prevent burn-in of certain ASS/SSA tracks. Confirm that each client renders the styled subtitles; unsupported or complex tracks can still cause video transcoding.

## Non-monotonic ASS/SSA subtitle timestamps

`Non-monotonic DTS` while Matroska is muxing a copied ASS/SSA track means the subtitle packets arrive in backward timestamp order; it does not by itself prove source-media corruption. V15 keeps the ASS/SSA payloads and stream-copies them, clamping only backward PTS/DTS to the previous timestamp while preserving equal timestamps. It then compares every packet hash and count and checks each packet's PTS/DTS movement against the 0.5-second limit. That limit measures a mux timestamp change relative to the source and video timeline, not subtitle-to-speech synchronization. A larger change or any payload/count mismatch discards the candidate and keeps the original. This output-timing failure does not trigger an Arr search. The job log reports the stream and maximum correction when a bounded repair succeeds.

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

Each message keeps a shortened technical detail block. No live Discord notification was sent during the earlier revisions; notifier unit tests use a mocked HTTPS endpoint. V15 live webhook verification is part of its test-container run. The isolated Tdarr container still has V12 imported until the V15 test import and live run are completed; the V15 webhook has not yet been exercised live.

## Strict stderr checks

V15 treats a successful process exit as success even if FFmpeg or FFprobe wrote diagnostic text to stderr. The source-frame scanner separately classifies recognized corruption diagnostics emitted at `-v error`; those fail the source guard even when FFprobe exits 0. PGS extraction still fails closed on a non-zero exit. Sample Sports Series NAL messages are error-level decoder diagnostics, and the independent strict decode confirmed source corruption; they are not harmless informational notices.

## Candidate decode reports non-monotonic DTS

Sample Fantasy Series S02E11 notice showed `Application provided invalid, non monotonically increasing dts to muxer` during the candidate's full video/audio decode check. FFmpeg exited 0, but the validator treats any stderr from this strict check as a failure, so the candidate was discarded and the original kept. The message comes from the null-output muxer receiving repeated or out-of-order decode timestamps; it is a timing/muxing diagnostic, not proof by itself that the source bitstream is corrupt.

The preceding frame-count, per-frame presentation-timestamp, and packet-timeline checks had passed before this final decode step. Strict source decodes did not match a recognized source-corruption signature, so this warning alone should not trigger a Sonarr/Radarr search. The screenshot does not include the source decode diagnostics or FFmpeg command, so it cannot show whether the source had a similar timestamp warning or whether the running candidate included the local `-fps_mode:v passthrough` change. The local V15 builder now includes the source decode result in this failure detail and presents the DTS case as an output-timing warning; this reporting update has not been live-verified in Tdarr.

Do not suppress the DTS message or accept the candidate on exit code 0 alone. Review the full Tdarr log and source decode detail before changing timestamp handling. The duplicate `[Safety check failed]` prefix in the screenshot is a formatting issue; current local output collapses repeated prefixes.

## Four 2026-11-04 movie logs

All four jobs kept the original. Each log contains `[Failure notification] Sent.`, so these failures were reported successfully; the attachments do not show a Discord delivery failure.

### Die Another Day — stream-copy remux cannot repair the opening DTS sequence

The full source precheck and retained-audio decode passed. The ICQ 22 AV1 encode did not meet the source-size cap, so the flow tried its source-video seek-heal remux. FFmpeg then rejected the opening video packets with non-monotonic DTS. A read-only packet probe shows DTS missing on the first few packets, and a 15-second test remux with `-copytb 1` failed with the same mux error. This does not prove the compressed video cannot decode—the encode had already processed it—but the current stream-copy path cannot safely write this timestamp sequence. Keep the original and do not trigger Arr search from this fallback error alone. No timestamp rewrite has been validated for this source.

### Skyfall — Dolby Level 6 has no content-light values

The source is Dolby Vision Profile 7 with a verified HDR10-compatible base and mastering metadata. An eight-second RPU export reports Level 6 mastering luminance `1000/1` and `1/10000`, with `MaxCLL=0` and `MaxFALL=0`; the source frame also carries `0/0` content-light values. Zero/zero means those light values are unspecified, not a usable measurement. A short Arc QSV encode retained the mastering data but emitted synthetic frame-level `1/1` content-light data unless that input side data was deleted. The local V15 candidate now recognizes the zero pair as unknown, checks the Level 6 mastering values against the source, and removes unknown content-light side data before encoding. It still rejects partial/invalid values or any output that invents nonzero CLL/FALL. The eight-second QSV sample passed this filter behavior; a full Tdarr replacement of Skyfall has not been run.

### The Batman — the old four-hour absolute scan limit expired

The 80.2 GB source precheck began at `06:07:11Z` and FFprobe timed out at `10:07:12Z`, exactly four hours later. No source corruption diagnostic was reported and encoding had not started. This is a scan-duration limit, not evidence that the file is damaged. The local V15 candidate allows scans up to 12 hours, but terminates a child that produces no output for 30 minutes. The original remains safe if either limit is reached. This large source was not rescanned end to end because that would take several hours.

### Spider-Man — missing source SAR was interpreted as an error

The source probe reports 1920×1040 but no sample or display aspect ratio. A 20-second Arc QSV sample retains those dimensions and outputs SAR `1:1` (DAR `24:13`), matching FFmpeg's square-pixel default for the untagged source. The previous validator rejected it solely because the source SAR field was empty. The local V15 rule now permits only this explicit `1:1` output when width and height are unchanged; known anamorphic SAR changes and missing/unknown output SAR remain rejected. The 20-second sample confirms the specific case, not a full-file validation.

### The Batman (2022) — audio packet timestamp guard

The 80.2 GB Remux-2160p source completed its full CPU source scan in about 4 hours 19 minutes. Both retained source audio tracks passed full software decode. The single Arc QSV ICQ 22 encode then completed in about 36 minutes and produced a 14.18 GB candidate. Candidate validation failed at `22:00:52Z` with `audio timeline has 1 packets with missing timestamps`; the job log records that the Discord failure notice was sent and the candidate cache was removed.

That old log does not identify the audio stream or whether the missing PTS was in the source or candidate. Since cleanup removed the candidate, it cannot be determined retrospectively. The updated validator reads both PTS and DTS, uses DTS only for audio packets lacking PTS, and compares any remaining missing timestamp packet ordinals between source and candidate. A candidate-only regression still fails with the stream and packet identified. The complete frame and timeline checks remain in place. No media job has been run with this update, so this particular file still needs a Tdarr run to confirm its source/candidate packet values and total runtime.

### Original-file snapshot changes and Unraid Mover

The guard still rejects a source path, size, or modification-time change, and it rejects a changed file when exact content verification fails. Unraid Mover can copy a source from the cache pool to the array during a long Tdarr job; that changes the device/inode and `ctime` even though the media bytes, path, size, and modification time stay the same. Since Tdarr reads through `/mnt/user` while Mover's in-use check examines the physical cache path, its open handle is not visible to Mover's `fuser` check.

V15 retains a read-only handle to the original for the duration of the engine. When the backing identity changes but the stable path/size/mtime conditions still match, the engine compares the retained original and current path byte-for-byte. Only an exact match is treated as a Mover relocation; any byte difference or comparison error keeps the existing rejection. The comparison also records a SHA-256 so the final pre-replacement recheck can verify a later relocation without weakening the guard. Whole-file comparison and its extra read run only after identity drift, not for every job. If Tdarr cannot access the old handle or the source changes while the comparison runs, the output is rejected and the original remains.

### PGS subtitle validation cost

PGS checks compare extracted SUP segment payloads and timestamps. The V15 candidate now batches all selected PGS tracks into a single FFmpeg demux pass for the source and another for the candidate, instead of launching one full-file extraction per PGS track. This reduces repeated reads for files with many PGS tracks. The batching change has not yet been exercised in a live Tdarr media job; any extraction error remains fail-closed and keeps the original.

### Source audio has backward or duplicate DTS

The V15 precheck scans packet DTS values for every retained audio stream before encoding. Equal DTS values can be valid because packet cadence may be finer than the stream time base; equal-only streams are preserved and do not trigger repair. Only actual backward DTS transitions trigger the timestamp-only correction. The `setts` filter then enforces strictly increasing DTS for the repaired track. Repair is allowed only when every packet has DTS, the stream time base is valid, and the largest predicted correction is at most 100 ms. The encoded audio packets remain copied. The candidate must retain the exact packet count, have strictly increasing DTS on repaired tracks, pass the audio timeline checks, and decode cleanly. Missing DTS or a missing time base in a source with backward transitions, a predicted shift above 100 ms, or any failed output check keeps the original. This timing repair alone does not prove source audio corruption and does not request an Arr search. The Sample Feature Film and Sample Feature Film test-container results are recorded in [HDR_AUDIO_REPAIR_TEST_REPORT.md](HDR_AUDIO_REPAIR_TEST_REPORT.md). A full Tdarr job with the refreshed export has not been run.

#### Red One (2024) — TrueHD timestamp repair exceeds the limit

The 53.96 GB `Remux-2160p` job completed the full source frame/HDR scan in about 49 minutes 52 seconds. The retained English stream `0:1` is 8-channel TrueHD + Atmos with a `1/1000` time base. Its packet DTS scan predicted up to 1,476.45 seconds (24 minutes 36 seconds) of correction, far beyond the 100 ms limit. The guard stopped before the full software audio decode and before AV1 encoding; the original stayed in place and no Arr search was requested. Discord accepted the failure notification.

That correction was reported by the old analyzer and does not establish either backward DTS or damaged TrueHD payload. The Sample Feature Film investigation later showed that equal DTS values on this same 1/1000 time base can create a large synthetic correction with zero backward transitions. A read-only Red One scan in the test container examined the first 1,032,582 packets (about 14m 20s of media): it found 172,097 equal transitions and zero backward transitions. I stopped it before the full 53.96 GB file was scanned because it required a long array read. So Red One shows the same tie pattern in the portion checked, but its complete DTS history remains unverified. The refreshed V15 analyzer will bypass equal-only sections; rerun the full packet scan only if this specific file is reprocessed for diagnosis. See the job log supplied on 2026-11-05 for the original measurements and the Sample Feature Film follow-up in [HDR_AUDIO_REPAIR_TEST_REPORT.md](HDR_AUDIO_REPAIR_TEST_REPORT.md).
