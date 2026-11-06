# V15 HDR hybrid and audio timestamp tests — 2026-11-05

## Scope

The existing isolated container `tdarr-flow-live-test-20261102` was already running. These were direct FFmpeg/FFprobe checks against read-only media under `/mnt/media`; output candidates were written only under `/test/v15-fixes-20261105`. No Tdarr flow was imported or run, because the test instance still contains the older import with embedded Arr settings. No production media or production flow was changed.

## Sample Feature Film DTS audio repair

Source: `/path/to/source-video.mkv`, audio stream 1. Candidate: `/test/v15-fixes-20261105/sample-film-audio-implemented.mka`.

The test ran a full audio-only stream-copy remux using the same `setts` expression added to the local V15 builder:

```text
ffmpeg -hide_banner -y -v warning -xerror -i <source> -map 0:1 -c:a copy \
  -bsf:a 'setts=pts=if(eq(PTS\,NOPTS)\,NOPTS\,PTS+if(eq(PREV_OUTDTS\,NOPTS)\,0\,max(0\,PREV_OUTDTS+1-DTS))):dts=if(eq(DTS\,NOPTS)\,NOPTS\,if(eq(PREV_OUTDTS\,NOPTS)\,DTS\,max(DTS\,PREV_OUTDTS+1)))' \
  -max_interleave_delta 0 -avoid_negative_ts make_zero <candidate.mka>
```

The remux exited 0 in 5.97 seconds. Full source/output packet comparison and a full FFmpeg audio decode produced:

- 560,854 source packets and 560,854 output packets.
- 2,617 backward transitions plus 62 equal-DTS transitions (2,679 non-increasing transitions total); largest backward step 74 ms.
- The V15 analyzer's tick-based simulation predicted 11,640 packets adjusted and a maximum shift of 75 ms, below the configured 100 ms limit.
- Zero output non-increasing DTS transitions and zero packet payload SHA-256 mismatches.
- Full candidate audio decode passed with `-xerror` in 9.75 seconds.

The implementation scans all retained source audio packet DTS values before encoding, with worker progress across the audio-scan and audio-decode phases. When a track contains an actual backward transition, it applies the strict timestamp filter only when all source packets carry DTS and the predicted shift stays within 100 ms; equal-only transitions do not trigger the repair. Missing DTS combined with a backward sequence, a repair above the bound, a packet-count change, or non-increasing candidate DTS rejects the candidate. This is a timestamp-only repair: the compressed audio packet payloads remain stream-copied. It does not re-encode or reconstruct damaged audio.

## Sample Feature Film Dolby Vision 8.1 + HDR10+ hybrid

Source: `/path/to/source-video.mkv`. Candidate: `/test/v15-fixes-20261105/Sample Feature Film-hybrid-hdr10-implemented-8s.mkv`.

The 8-second Arc QSV sample used `sidedata=mode=delete:type=DYNAMIC_HDR_PLUS,vpp_qsv`, AV1 QSV ICQ 22, and source-matching HDR10 color tags. It exited 0 in 1.28 seconds. Output probing found:

- AV1 with `tv` range, `bt2020nc` matrix, `smpte2084` transfer, and `bt2020` primaries.
- Mastering-display metadata matching the source within the V15 numeric tolerance; the largest field difference was `0.0000221`.
- Content-light values matched exactly (`MaxCLL 1000`, `MaxFALL 1`).
- Dolby Vision RPU/metadata and HDR10+ dynamic metadata absent from the candidate's decoded frames.
- All 192 candidate frames in the capped output carried the expected static HDR metadata without dynamic side data.

The 8-second source read interval returned 191 frames while the capped candidate contained 192 because of the interval boundary. This sample is therefore an encode and metadata smoke test, not a frame-count/timestamp pass or full V15 job. The actual V15 route still performs its full source frame scan, verifies decoded HDR10+ signaling, and requires full candidate frame/timestamp and HDR checks before replacement.

### Follow-up: current Arc QSV path without the metadata-removal filter

To distinguish a format/encoder limitation from the explicit fallback filter, a second 8-second sample used the flow's QSV hardware decode, `vpp_qsv=format=p010`, and `av1_qsv` encode path with no `sidedata=delete` filter. The source interval carried HDR10+ metadata on 191 frames; the AV1 candidate had zero HDR10+ frames and zero Dolby Vision frame metadata. The candidate still had static HDR10 signaling: `tv` range, BT.2020 primaries/matrix, PQ transfer, mastering-display metadata, and content-light metadata (MaxCLL 1000, MaxFALL 1).

This confirms that the current end-to-end Arc QSV flow does not preserve HDR10+ or Dolby Vision dynamic metadata even when the explicit removal filter is omitted. It does not isolate whether the metadata is dropped by QSV decode, `vpp_qsv`, or `av1_qsv`; it establishes the behavior of the actual pipeline. The same 8-second boundary mismatch applies, so this remains a metadata behavior check rather than a full V15 validation or HDR quality test. Candidate: `/test/v15-fixes-20261105/Sample Feature Film-qsv-no-strip-8s.mkv`.

The local V15 policy now admits only the explicitly identified single-layer DV Profile 8.1 source with RPU present, no enhancement layer, HDR10 compatibility ID 1, HEVC/PQ/BT.2020, limited range, and MediaInfo HDR10 compatibility. It removes HDR10+ frame metadata during the encode and then requires the output to pass the existing strict HDR10 validator. The existing pure HDR10+ mastering-coordinate failure remains guarded. The short sample does not establish HDR perceptual quality or general support for other hybrid profiles.

## Investigation: preserving HDR10+ with Arc QSV

The test container uses FFmpeg `N-128195-g914e454559`, built with `libvpl`, `libaom`, and `av1_qsv`. Its `av1_qsv` help exposes generic `qsv_params`, but no HDR10+ or per-frame metadata option. Upstream FFmpeg's QSV AV1 encoder callback handles mastering-display and content-light metadata, but not `AV_FRAME_DATA_DYNAMIC_HDR_PLUS`; its libaom AV1 encoder explicitly serializes that dynamic side data into AV1 T.35 metadata OBUs. The FFmpeg changelog describes HDR10+ AV1 passthrough with `libaom-av1`, not QSV. See [QSV AV1 encoder source](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/qsvenc_av1.c), [libaom AV1 encoder source](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/libaomenc.c), and [FFmpeg changelog](https://github.com/FFmpeg/FFmpeg/blob/master/Changelog).

The review's suggested `setpts`/filter/`qsv_params` method does not provide a dynamic HDR10+ injection route. `setpts` changes timestamps; FFmpeg's `metadata` filter edits ordinary frame metadata and `sidedata` only selects/deletes side data. Intel's `mfxPayload` documentation lists MPEG-2, AVC, and HEVC payload types, not AV1 metadata OBUs. The generic QSV parameter dictionary configures encoder parameters; it is not a JSON-to-per-frame OBU injector.

Two bounded alternatives were tested:

- **FFmpeg libaom software encode:** 48 source frames and 48 output frames carried HDR10+ metadata. FFprobe's complete per-frame dynamic-metadata structures matched the source exactly. The 2-second 4K test encoded at about 0.381× real time with `libaom-av1`, `-cpu-used 8`, and `-crf 40`. This is a metadata-preservation proof, not a quality comparison. The earlier Arc sample reported 7.49× real time over its 8-second encode, so the observed libaom path is much slower; these were not controlled encoder-quality or throughput benchmarks. Candidate: `/test/v15-fixes-20261105/Sample Feature Film-libaom-hdrplus-2s.mkv`.
- **QSV encode plus external AV1 injector:** an experimental IVF-only Python fork received 48 source JSON scenes and a 48-frame QSV AV1 stream. Its output exposed HDR10+ side data on only 35 frames to FFprobe, and its extracted first-scene values differed from the source. The fork appends metadata after each frame OBU, while the [AOMedia HDR10+ AV1 specification](https://aomediacodec.github.io/av1-hdr10plus/) requires one metadata OBU before the associated visible frame header. This prototype is not safe to use. Candidate: `/test/v15-fixes-20261105/Sample Feature Film-qsv-first48-hdr10plus.ivf`.
- **Custom QSV OBU-insertion proof of concept:** a temporary script matched the 48 QSV IVF packets to 48 libaom donor packets by IVF timestamp and inserted one raw HDR10+ OBU before the first frame OBU in each QSV packet. FFprobe decoded 48 frames, but found HDR10+ on only 36; metadata PTS and per-frame metadata did not exactly match the source. The packets are not uniformly one-frame/one-OBU units: 12 packets contained multiple `OBU_FRAME` OBUs (six with two and six with four), and packet-level insertion does not establish correct association with every displayed frame. A separate FFprobe check found one decoded frame per reported packet position, but that does not expose which of multiple frame OBUs is visible or prove metadata association. The prototype is not safe to use. Candidates: `/test/v15-fixes-20261105/Sample Feature Film-qsv-first48-hdr10plus-poc.ivf` and `/test/v15-fixes-20261105/Sample Feature Film-qsv-first48-hdr10plus-poc.mkv`.

### Follow-up: software AV1 encode preserving both dynamic formats

The test container's FFmpeg build exposes `-dolbyvision` on `libaom-av1`. A bounded 48-frame encode of the same source used `libaom-av1`, `-dolbyvision 1`, `-cpu-used 8`, and `-crf 40` in one pass. It took 6.414 seconds for about 2 seconds of 4K video (about 0.31x real time) and produced `/test/v15-fixes-20261105/Sample Feature Film-libaom-both-dv-hdr10plus-48f.mkv`.

Validation on this short candidate:

- 48 input and 48 output frames.
- FFprobe parsed both HDR10+ and Dolby Vision metadata on all 48 output frames. The parsed per-frame HDR10+ structures and Dolby Vision metadata structures exactly matched the source on all 48 frames.
- The AV1 output carried a Dolby Vision Profile 10 configuration with HDR10 compatibility ID 1. This is a profile conversion from the HEVC source's Profile 8.1, not preservation of the same codec profile.
- Full candidate decode passed with `ffmpeg -xerror`; MediaInfo recognized AV1 Dolby Vision Profile 10. MediaInfo did not report HDR10+ in its summary, despite FFprobe parsing HDR10+ on every frame, so playback and independent metadata inspection remain necessary.

The short software test is a metadata/decoder proof, not a quality or production-readiness test. `-crf 40` was used to keep the experiment bounded and is not a recommended production quality setting. It encoded at about 0.31x real time; compared with the earlier Arc sample's roughly 7.5x, this suggests around 24x slower video encoding, but the runs used different settings and lengths. As a rough encoder-only estimate, that is about 3.2 hours per source hour on the software path versus about 8 minutes per source hour on the Arc sample. Full precheck, audio/subtitle processing, and safety validation add time to either route.

This establishes a promising per-file software fallback for the tested DV 8.1 + HDR10+ hybrid. It does not establish that the production Tdarr FFmpeg build exposes the same encoder option, that the user's TV/Jellyfin path plays AV1 Dolby Vision Profile 10 correctly, or that a quality setting can meet the flow's size/quality goals. Dolby lists Profile 10 as 10-bit AV1 carried with T.35 metadata OBUs and an EMDF wrapper; playback support is device-dependent. See [Dolby's profile table](https://ott.dolby.com/OnDelKits/Dolby_Vision_Online_Delivery_Kit/v1/Documentation/Specs/Visio_Profiles/help_files/topics/c_dovi_profiles.html) and [FFmpeg's AV1 Dolby Vision support changes](https://github.com/FFmpeg/FFmpeg/blob/master/Changelog).

### Comparison: FFmpeg's SVT-AV1 encoder

The same container also has FFmpeg `libsvtav1` and its `-dolbyvision` option. A 48-frame test with `-preset 8 -crf 40 -dolbyvision 1` took 2.444 seconds, faster than libaom, and output Dolby Vision Profile 10 metadata on all 48 decoded frames. However, FFprobe found no HDR10+ metadata in that candidate, so this FFmpeg/SVT build does not preserve both formats through the tested route. Candidate: `/test/v15-fixes-20261105/Sample Feature Film-svtav1-both-dv-hdr10plus-48f.mkv`.

The separate [SVT-AV1-HDR fork](https://github.com/gavinljj/svt-av1-hdr) advertises `--dolby-vision-rpu` and `--hdr10plus-json`, but requires a custom build with libdovi and HDR10+ support enabled; it does not provide first-party binaries. It may be a faster software route for both formats, but has not been built or tested here, so its runtime and output safety are unknown.

### HandBrake route check

The running production `tdarr` container has `/usr/bin/HandBrakeCLI`, version 1.11.2. Its CLI lists both `svt_av1_10bit` and `qsv_av1_10bit`, and exposes `--hdr-dynamic-metadata all`. HandBrake's documentation lists SVT-AV1, but not QSV AV1, for both HDR10+ and Dolby Vision dynamic metadata. So preserving both uses the CPU SVT-AV1 encoder; the Arc QSV option is not the supported dual-metadata route. See [HandBrake HDR encoding support](https://handbrake.fr/docs/en/latest/technical/hdr.html) and the [CLI metadata/encoder options](https://github.com/HandBrake/HandBrake-docs/blob/master/source/docs/en/latest/cli/command-line-reference.markdown).

HandBrake 1.11.2 was also tested in the isolated Tdarr test container on the same hybrid source, using `svt_av1_10bit`, preset 8, quality 40, and `--hdr-dynamic-metadata all`. A 48-frame stop request produced 49 frames because the CLI stop boundary is inclusive; the first 48 frames were compared against the source. FFprobe found exact per-frame equality for HDR10+ and Dolby Vision metadata across those 48 frames; the candidate had both metadata types on all 49 frames and was recognized as Dolby Vision Profile 10 with HDR10 compatibility ID 1. Full decode passed. Candidate: `/test/v15-fixes-20261105/Sample Feature Film-handbrake-svt-both-48f.mkv`.

The HandBrake run took 7.083 seconds for about 2 seconds of video (about 0.29x real time), roughly 3.4 hours per source hour if that short sample scales. That is similar to the tested libaom route and much slower than the Arc sample. These timings are approximate and use test quality settings; quality was not evaluated. The test was video-only, so it does not establish how HandBrake's audio/subtitle selection would match the current flow's language and ASS-preservation rules. The production container was only inspected; no production encode or flow change was made.

Conclusion: the Arc QSV path still has no verified way to preserve HDR10+ or Dolby Vision dynamic metadata. Both the test container's FFmpeg/libaom path and HandBrake/SVT-AV1 preserved both formats on the tested hybrid sample, but at a large CPU speed cost and as AV1 Dolby Vision Profile 10. HandBrake is installed in production, so a per-file route is technically available; it still needs full-flow integration and validation for audio, subtitles, quality, size, target playback, and full-file safety.

## Local regression coverage

The builder now has unit coverage for DTS order analysis, missing DTS handling, repair limits, the exact FFmpeg filter expression, the DV 8.1/HDR10+ preflight, route classification, output packet count/order checks, and the generated HDR conversion path. This report records direct media tests only; the refreshed flow has not been imported into Tdarr.

### Follow-up: Sample Feature Film TrueHD duplicate DTS values

The 2026-11-05 production log was for `/path/to/source-video.mkv` (44,128,019,044 bytes). It failed before video encoding because the TrueHD/Atmos stream 0:2 uses a 1/1000 time base and contains many equal DTS values. The previous analyzer treated each tie as requiring a new 1 ms tick, reporting up to 1,501,783 ms of correction even though a full stream scan found zero backwards transitions. The reported correction was accumulated synthetic drift, not a 25-minute defect in the source.

An isolated 10-second stream-copy remux in `tdarr-flow-live-test-20261102` used the production flow's `-fflags +genpts+igndts`, `-max_interleave_delta 0`, and `-avoid_negative_ts make_zero` options. Source and candidate each had 11,999 TrueHD packets from 0.000 to 9.999 seconds, with 1,999 equal-DTS transitions, zero backwards transitions, and zero FFmpeg warnings. This confirms that equal DTS values at this time-base resolution are accepted by the tested FFmpeg/Matroska path without timestamp correction.

V15 now treats equal-only DTS as valid and skips the repair filter when there is no actual backwards transition. For a track with a true backwards transition, the existing strict `setts` repair remains in use, with its 100 ms bound, packet-count check, strict output DTS check, and full audio decode. A trial non-strict filter was rejected: on the Sample Feature Film source it retained packet count but created 11,462 equal output DTS transitions and generated repeated non-monotonic timestamp diagnostics during decode. The existing strict repair is retained for that case.

The regenerated flow remains local and has not been imported into Tdarr. The Sample Feature Film result is a short stream-copy test, not a full 2-hour flow run or a production FFmpeg comparison; the full source DTS scan was from the production job log.
