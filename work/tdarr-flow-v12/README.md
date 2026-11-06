# Tdarr Arc AV1 flow V13

V13 uses one global QSV ICQ value (`22`) for every eligible video. The value can be overridden for the whole node with `TDARR_QSV_ICQ`; the default remains 22. This export is a candidate for the isolated Tdarr test library. Production Tdarr and production media were not changed.

See [flow-diagram.md](flow-diagram.md) for the node sequence, encode and remux branches, and Discord notices.

## HDR and Dolby Vision

The flow verifies input frame and stream signaling before it selects an HDR path. It encodes verified HDR10 and HLG, converts HDR10+ to its static HDR10 base, converts verified Dolby Vision 8.1 and Profile 7 HDR10-compatible base layers to HDR10, and preserves the HLG base for Dolby Vision 8.4. Dolby Vision Profile 7 enhancement-layer detail and Dolby dynamic metadata are discarded on the HDR10 path. The success notice describes any conversion. Direct live Arc smoke tests passed for Profile 7, Profile 8.1, HDR10+, and synthetic HLG; see [HDR_LIVE_VALIDATION.md](HDR_LIVE_VALIDATION.md) for scope and limits.

For correctly signaled HDR10, absent mastering-display and/or content-light metadata remains absent. The flow preserves each static metadata item that exists and rejects output that invents or drops one. It does not fill unknown values with Dolby Level 6 data on ordinary HDR10 files; the Level 6 fallback remains limited to the verified Dolby Vision routes.

Profile 5, unverified Dolby Vision variants, conflicting color tags, hybrid Dolby Vision/HDR10+, and other unverified dynamic-HDR signals are held and reported. They are not guessed or relabeled. Tagged SDR 12-bit sources are converted to 10-bit with error-diffusion dithering. Twelve-bit HDR/Dolby Vision and untagged 12-bit video remain held pending a verified color path.

Untagged SDR video keeps transfer, primaries, and matrix unspecified. For supported YUV formats with no range in the stream, decoded frames, or MediaInfo, the flow assumes limited `tv` range and writes that range tag on both AV1 encodes and seek-heal remuxes. Explicit or observed full range is preserved; `yuvj422p` and `yuvj444p` imply full `pc` range when other range metadata is absent. Conflicting or unrecognized range metadata is held. This is a documented convention for otherwise untagged SDR YUV, not recovered source metadata; HDR, Dolby Vision, RGB, and unsupported formats do not use this default.

Partially tagged SDR is also supported when the video stream has a recognized BT.709, BT.601/SMPTE 170M, or BT.470 BG matrix and no HDR/Dolby Vision signaling. Missing transfer or primaries remain unspecified. MediaInfo matrix values are normalized against FFprobe equivalents (including `BT.601` ↔ `smpte170m`); a real disagreement or unrecognized matrix remains held.

These partial-tag cases receive a full CPU frame scan before encoding because the missing transfer tag prevents the faster sampled precheck. The decoded frames are checked for PQ, HLG, or BT.2020 signaling before the source is accepted as SDR.

## Source codec and pixel-format coverage

The flow converts supported 4:2:2 and 4:4:4 input to 10-bit 4:2:0 before AV1 encoding. It accepts listed planar YUV 4:2:0, 4:2:2, and 4:4:4 formats up to 12-bit, plus 8-bit full-range `yuvj422p` and `yuvj444p`. The guard still holds RGB, alpha, pixel formats outside the list, and sources above 12-bit. Interlaced video and multiple primary video streams are held.

Arc QSV encoding remains mandatory. For SDR, direct QSV decoding is limited to H.264 8-bit 4:2:0 and HEVC/AV1 8- or 10-bit 4:2:0. Other source codecs and high-depth or non-4:2:0 sources use CPU decode/conversion followed by Arc QSV encoding. HDR/Dolby Vision continue to use their existing guarded routes.

The local codec/container preflight and exact limits are in [CODEC_COVERAGE.md](CODEC_COVERAGE.md). It uses software AV1, not the Arc encoder; the broader 4:2:2/4:4:4 and tagged SDR 12-bit paths still need an Arc-node smoke test before production. The FFmpeg version also rejected AV1 in MOV and did not write an AV1 video stream to MPEG-TS, so those combinations fail validation and keep the original.

## Source precheck and deferred diagnosis

The source stream's `field_order` tag does not decide whether decoded frames are interlaced. A full decoded-frame scan does. The Blue's Clues S04E21 log showed a non-progressive stream tag but no interlaced decoded frames; the old code then reused the source stream as the “output” argument to an aspect-ratio helper, which incorrectly raised `Output has interlaced field order` before encoding. The candidate now checks source aspect ratio separately, while the output still must report progressive or unknown field order. Non-progressive-tagged sources continue to take the full scan; decoded interlaced frames remain held.

For progressive SDR and verified static HDR10 videos longer than 16 seconds with a stream transfer tag, the pre-encode source check decodes three 5-second CPU samples at the beginning, middle, and end. This replaces the full source frame scan before an encode for those routes. Short videos and anything classified as HDR10+, Dolby Vision, HLG, untagged, ambiguous, partially tagged SDR, or non-progressive-tagged retain the full CPU source scan because dynamic HDR metadata or unsafe frames may occur outside short samples.

If a sample scan fails, the flow retries with a full CPU source scan before reporting the source-side failure. If the sampled source/output timeline comparison fails, the flow performs a full source scan and compares its complete frame count and timestamp sequence with the candidate’s already-complete output scan. It proceeds only if that full comparison passes; a confirmed source-corruption signature can trigger the existing item-scoped Arr search. A hard encode failure or another output-validation failure still keeps the original unless the candidate passes every check.

Each sample interval uses an absolute end timestamp. FFprobe may seek back to a preceding keyframe, so a relative `+5` duration can stop before the requested five-second window is complete. The long-GOP regression check covers middle and final windows.

The optimization applies only to the source precheck. Every candidate still receives the full output stream/timeline checks and a full strict video/audio decode before replacement. For sampled source routes, frame-timestamp comparison checks the corresponding start/middle/end windows; dynamic, ambiguous, and other full-scan routes compare the complete source and candidate timelines. No HDR or Dolby Vision encode/conversion behavior changed. This is a local V13 candidate change; it has not yet been imported into Tdarr or live-verified.

On sampled routes, a source frame loss outside those windows will not be caught by exact whole-file source/candidate frame matching unless it also causes a decode, timing, or other validation failure. Restoring exhaustive whole-file frame matching requires a full source frame scan on successful candidates, which gives back most of the CPU work this change defers.

## One ICQ and the larger-output fallback

Each eligible source gets one Arc AV1 encode at ICQ 22. If that output is smaller than the source and passes the full validation, it is accepted. A hard encoder or decode error remains a failure; it does not claim to have repaired corrupt elementary-stream data.

If the AV1 output is equal to or larger than the source, the flow discards it and remuxes the original video stream with seek-healing mux flags while applying the normal audio, subtitle, chapter, and metadata handling. The remux is not required to be smaller than the source: it may replace the source when the complete output validates, even if mux overhead makes it larger. It has a capacity-derived scratch limit from the cache reservation, so it cannot grow without bound and consume the cache; that limit is independent of the input file size. Failure to finish within the reserved capacity or failure of validation retains the original and sends a failure notice.

The encode is still attempted only once. When it reaches the source-size cap, the engine reports that result and the size-guard branch reports the remux transition. The earlier `[Arc AV1] No smaller output at ICQ 22` line duplicated the outer fallback message; the current generated candidate removes that redundant summary.

During a seek-heal remux, the flow watches the output size and asks the shared reservation ledger for more space before it reaches its current limit. It keeps 512 MiB of write-ahead headroom and requests capacity in up-to-1-GiB increments, shrinking the request if the cache has less spare capacity. The worker's `prlimit` file-size cap is raised only after the reservation succeeds. If the request cannot be granted, the flow stops the remux, removes its partial file, and keeps the source. The configured cache and host-RAM safety floors remain protected.

The local V13 candidate's Arc AV1 encode now uses `-fps_mode:v passthrough` so FFmpeg forwards each decoded frame's timestamp instead of applying automatic output sync. The candidate must still match the source frame count and normalized per-frame timestamps before it can replace the original. The seek-heal remux can fix container indexes, packet timestamps, and seek behavior; it cannot reconstruct damaged compressed video or audio packets, which still need a successful decode and validation. Before Tdarr replaces the original, the flow freshly probes the candidate; checks video stream count, codec, dimensions, aspect ratio, completion marker, color/HDR route metadata, audio/subtitle counts and codecs; compares video frame timestamps and stream timelines; verifies subtitle packet counts and timing (and PGS segment payloads); then fully decodes the candidate's video and audio with FFmpeg. Frame counting is independent of optional interlace metadata, and timing failures report source/output frame and timestamp counts. Subtitle streams receive structural/timeline checks rather than a full rendered decode. These checks catch file-level and stream-level failures; they cannot guarantee subjective picture quality or playback behavior in every player.

If the final candidate decode reports non-monotonic DTS, the candidate remains rejected and the original stays in place. This identifies an output timing/muxing problem; it does not by itself prove source corruption or request an Arr search. The failure notice includes strict source decode findings where available, so a replacement search is reserved for recognized source corruption.

No permanent recovery copy is created. Existing audio and subtitle selection/normalization rules remain in place. A validated source-video remux gets a V13 marker so the flow does not repeatedly encode it.

## Styled subtitle preservation

ASS and SSA subtitle tracks in Matroska inputs are stream-copied as ASS/SSA; they are not converted to SRT. This avoids the FFmpeg SRT encoder buffer failure seen with large anime sign drawings and vector events. The output checks the subtitle codec, packet count, and timeline before replacement. The success embed reports how many styled tracks were preserved. SubRip conversion remains for the other supported subtitle formats under the existing rules.

Jellyfin can keep ASS/SSA as selectable tracks in MKV, but the client must render the style. On the TV and phone, set **Burn subtitles** to **Only Image Formats (VobSub, PGS, SUB)** and turn **Always burn-in subtitle when transcoding** off. Avoid **Auto** if you want to prevent burn-in of certain ASS/SSA tracks. Test the actual file on each client; an unsupported or complex track can still trigger video transcoding.

## Why ICQ 22

ICQ 22 remains the one global value, provisionally. Earlier matched excerpt comparisons showed ICQ 22 was 27–34% smaller than ICQ 20, with SSIM changes from −0.00023 to −0.00055. Live SDR checks at ICQ 22 scored about 96.6 on the Netflix 1080p TV model and 97.7–98.0 on its phone model across anime and live-action samples. A fresh matched HDR10 excerpt from an 80 GB source scored 106.18 on the Netflix 4K HDR model and retained static HDR metadata. This supports ICQ 22 for the tested SDR and HDR10 clips, not every source or HDR route.

| Sample | ICQ 20 size / SSIM | ICQ 22 size / SSIM | ICQ 22 change |
| --- | ---: | ---: | ---: |
| 1080p SDR, 60 s | 15.61 MB / 0.90665 | 11.23 MB / 0.90611 | 28% smaller; SSIM −0.00055 |
| 1056×800 SDR, 60 s | 8.76 MB / 0.86150 | 6.43 MB / 0.86127 | 27% smaller; SSIM −0.00023 |
| 4K HDR10, 30 s | 31.02 MB / 0.99520 | 20.49 MB / 0.99477 | 34% smaller; SSIM −0.00043 |

VMAF model versions, sample details, measurements, and the remaining HDR/Dolby Vision limits are recorded in [QUALITY_DECISION.md](QUALITY_DECISION.md). The flow description also carries the short decision rationale so it remains visible after import into Tdarr.

## Progress and concurrent jobs

The worker percentage reports source inspection, FFmpeg progress, output inspection, and decode validation. In the live V13 run, the full Sample Adventure Series sample advanced through the node percentage during encode and validation rather than staying at 0% until completion. The local candidate now reports FPS for encode, stream-copy remux, frame scans, and postcheck decode; when FFmpeg reports zero during stream copy or decoding, it derives FPS from frame-count deltas. Metadata-only work has no frame rate to report. This FPS change has passed local tests but has not yet been verified in the Tdarr UI. CLI, preset, process-reason, source-size, live output-size, and estimated final-size details persist across validation updates, so the Tdarr worker panel can keep showing them after FFmpeg exits. The final-size estimate uses current output bytes and media progress, so it settles as the encode advances.

There is no whole-job mutex. Jobs reserve estimated output capacity in a shared ledger; the short mutex only protects reservation updates and growth. `/dev/shm` is preferred when both its free space and system RAM headroom satisfy the reservation; otherwise the configured disk cache is used. `TDARR_RESERVATION_ROOT` must identify an existing directory shared by cooperating workers. Capacity checks coordinate cooperating Tdarr jobs, but unrelated writers, filesystem quotas, or remounts can still cause a write failure; in that case the original remains. Current reservation records identify the worker host and PID namespace (override with a unique `TDARR_RESERVATION_HOST_ID` if needed), heartbeat every 30 seconds while the engine is running, and name only that job's scratch directory. On SIGTERM/SIGINT, the worker kills tracked FFmpeg/FFprobe process groups and removes its recorded scratch directory; the next admission removes its dead same-host reservation. A hard-killed worker's reservation is reclaimed on the next admission; other leases expire after 15 minutes without a heartbeat. Legacy V2 records have no host/workspace lease and are left for manual inspection.

The node requires `prlimit`, `ffmpeg`, `ffprobe`, `mediainfo`, `dovi_tool`, and access to the Arc device. The default device is `/dev/dri/renderD129`; `TDARR_ARC_DEVICE` can override it. AV1 encoding always uses the Arc, while CPU decoding is allowed for sources that need it.

## Notifications and ISO handling

The webhook is read from `TDARR_DISCORD_WEBHOOK`; it is not embedded in the flow JSON. V13 sends success and failure embeds, an information notice when a file already has a completion marker, and a warning after deleting an ISO and requesting an Arr rescan. A rescan request does not guarantee a replacement download; matching and search settings still apply.

Failure embeds distinguish source media corruption from output, subtitle, cache, and encoder failures. Known video bitstream errors from the pre-encode frame scan can request a search; if output video/audio decoding fails, the flow strictly decodes the corresponding original streams and requests a search only when known corruption is reproduced in the source. Arr routing selects the first recognized library-root path segment: `anime` uses the Anime Sonarr, `tv`/`shows`/`series` uses the TV Sonarr, and `movies`/`movie`/`films` uses Radarr. It then resolves the Arr item from its configured path, the library-folder name, or the media filename. Matched episodes use a Sonarr `EpisodeSearch`; matched movies use a Radarr `MoviesSearch`. For movies, the filename must match the movie file in Radarr; for episodes, the filename or its SxxEyy label must resolve to episode IDs in the matched Sonarr series. Unmatched paths or files do not submit a search. The original remains in place; the flow does not delete or move it, change monitoring, or launch a broad series/movie search. Arr profile and upgrade rules may decline same-quality replacements, so a queued search does not guarantee a replacement. Subtitle packet mismatches, output timing mismatches, cache failures, unsupported formats, HDR/color issues, and encoder/driver failures do not trigger an Arr search. Source and output checks are documented in [FAILURE_DIAGNOSTICS.md](FAILURE_DIAGNOSTICS.md), with the ordered workflow in [flow-diagram.md](flow-diagram.md).

The webhook was added only to the isolated test container. Discord showed the already-processed information notice, a successful size-fallback notice, and a malformed-video failure notice during this test. The ISO-deletion warning branch has not yet been exercised live. The test container's Arr API keys/targets are disabled, so Arr rescans were not exercised. Production services and media were not targeted.

## VMAF validation and remaining limits

The isolated test container now has Netflix VMAF v1 SDR and HDR JSON models under `/test/models/netflix-vmaf-v1` and the standalone `libvmaf` CLI under `/test/tools/netflix-vmaf-source/libvmaf/build/tools/vmaf`. Its persistent reports are under `/test/reports/vmaf`. The test container’s bundled FFmpeg could not load VMAF v1 feature definitions, so the standalone Netflix CLI was built inside the test container. The production container and production library were not changed.

The full 24.5-minute Sample Anime Series V13 output measured 266,987,652 bytes versus 208,986,458 bytes for the source (−21.7%). Its first 60 seconds scored 96.62 on TV 3H and 97.66 on phone 5H. A second sample used the 2.59-hour, 1.51 GB Sample 4K Film source: a 60-second Arc QSV ICQ 22 encode scored 96.61 / 98.02 on a 30-second excerpt. The encoded excerpt was 4% larger than a source-video remux, so the flow’s bloat fallback would retain the original video.

The HDR model self-comparison scored 106.09. A fresh 45-second Arc QSV ICQ 22 encode from the 80.0 GB, 3840×1608, 10-bit HDR10 Sample HDR Film source scored 106.18 mean / 106.18 harmonic on a matched 20-second excerpt (478 common frames). The score ranged from 105.48 to 106.59, and the output retained mastering-display and content-light metadata. This is a controlled QSV encode, not an end-to-end Tdarr replacement.

A second large-source check used a 102.7 GB 4K Sample HDR Film source with Dolby Vision Profile 8 and HDR10+ signaling. Its controlled ICQ 22 encode scored 100.19 mean / 100.14 harmonic on a matched 20-second excerpt. The flow holds this hybrid Dolby Vision/HDR10+ combination, so this result does not validate an eligible flow route.

The earlier short Sample HDR Film test pair scored 0.00, and the earlier Sample HDR Film Profile 7 pair scored 0.27. Their exact frame provenance was not re-established; retain those results as unresolved pair checks, not as measurements of the fresh Sample HDR Film encode. Direct Arc route/metadata smoke tests now cover Dolby Vision Profile 7, Profile 8.1, HDR10+, and synthetic HLG; they did not measure HDR picture quality and did not run as a V13 Tdarr job. No genuine HLG or Dolby Vision 8.4 source was found in the test library’s 212 named 2160p videos. See [HDR_LIVE_VALIDATION.md](HDR_LIVE_VALIDATION.md). VMAF is model-based and does not replace viewing checks on the TV and phone.

The tests cover representative excerpts, not entire films, every codec profile, color profile, track layout, or corruption type. Current evidence supports ICQ 22 provisionally for the tested SDR and HDR10 excerpts. Other HDR and Dolby Vision routes remain unresolved.

## Build and local checks

Regenerate the flow with `python3 work/tdarr-flow-v12/build.py`. The builder's V3 base template and capacity-lock source are copied under `base/`, so this current candidate is self-contained. Older revision folders are grouped under `work/tdarr-flow-archive/`. Local unit and integration coverage lives beside the builder and covers the quality policy, size guard, progress reporting, reservations, validation, and notification branches. The isolated live test is separate from the production library.
