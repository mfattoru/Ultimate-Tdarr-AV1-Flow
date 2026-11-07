# HDR and Dolby Vision live validation — 2026-11-03

## Current V15 end-to-end results

These jobs ran through the V15 Tdarr flow in the existing `tdarr-flow-live-test-20261102` container on Arc QSV `/dev/dri/renderD129`. The V15 library scans only `/test/v15-source`; production media is mounted read-only. Inputs and candidates are test copies.

| Input | V15 result | Validation |
| --- | --- | --- |
| Genuine Dolby Vision Profile 7, `Sample HDR Film-p7.mkv` | Arc AV1 Main10, 3840×2160, PQ/BT.2020; 21,920,460 bytes from 125,996,583 bytes | Passed. Static mastering and content-light metadata matched; Dolby Vision metadata was absent after the HDR10-compatible fallback. |
| Genuine Dolby Vision Profile 8.1 fixture | Arc AV1 Main10; 6,545,324 bytes from 106,355,854 bytes | Passed. Static HDR metadata matched the selected fallback; Dolby Vision metadata was absent. |
| HDR10+, `birds-hdr10plus.mkv` | Arc AV1 candidate: 11,605,199 bytes from 167,234,814 bytes | Rejected. Candidate decoded-frame mastering display metadata conflicts with the source; original was retained and Discord failure notice arrived. |
| Synthetic HLG, `synthetic-hlg.mkv` | Size guard selected source-video seek-heal remux; 6,589,174 bytes from 6,589,120 bytes | Passed as an HLG/BT.2020 metadata-preserving remux. This does not verify an encoded HLG output. |

### Dolby Vision 8.1 + HDR10+ hybrid test — 2026-11-05

An anonymized single-layer HEVC Dolby Vision Profile 8.1 stream with HDR10-compatible base-layer signaling and HDR10+ Profile B metadata was tested. The read-only original remained on `/mnt/media`; a capped 8-second Arc QSV sample was written under `/test/v15-fixes-20261105/`.

- The Arc QSV AV1 sample completed in 1.28 seconds. Output color tags remained limited-range BT.2020 non-constant matrix, PQ, and BT.2020 primaries.
- FFprobe found only mastering-display and content-light frame side data in the output; Dolby Vision RPU/metadata and HDR10+ dynamic metadata were absent. Numeric mastering values matched within V15's existing tolerance (maximum field delta `0.0000221`); content-light values matched exactly.
- The capped command's source/output frame windows differed by one frame at the exact 8-second boundary (191 source interval frames, 192 candidate frames). Therefore this was a metadata/encode smoke test, not a frame-count or full-flow validation. A production replacement remains guarded by V15's full-file timestamp and frame-count checks.
- This test did not measure HDR perceptual quality. It does not establish support for other hybrid profiles or static metadata outside the tested values. The Intel QSV HDR10+ mastering clamp remains a risk; a route that fails the strict metadata validator will retain the original. Pure HDR10+ behavior remains unchanged and continues to reject the known incompatible mastering case.

The local V15 policy now permits only the positively identified single-layer DV 8.1, RPU-present, enhancement-layer-absent, HDR10-compatible, HEVC/PQ/BT.2020 limited-range hybrid to continue past a cheap metadata preflight. It still performs the full source scan, verifies decoded HDR10+ signaling, removes HDR10+ and Dolby Vision dynamic metadata during conversion, and runs the existing strict output HDR10 validation. Other hybrids remain held.

A follow-up 8-second encode using the same Arc QSV decode, `vpp_qsv`, and `av1_qsv` path without the explicit metadata-removal filter still produced zero HDR10+ and Dolby Vision frame metadata. Static HDR10 signaling remained. This verifies that the current pipeline itself does not preserve the dynamic metadata; it does not identify which QSV stage drops it. Details and the candidate path are in [HDR_AUDIO_REPAIR_TEST_REPORT.md](HDR_AUDIO_REPAIR_TEST_REPORT.md).

A 48-frame 4K `libaom-av1` encode with `-dolbyvision 1` preserved both source Dolby Vision metadata and HDR10+ metadata exactly in FFprobe's parsed per-frame structures. The output was AV1 Dolby Vision Profile 10 with HDR10 compatibility ID 1, and its full decode passed. It took 6.4 seconds for about 2 seconds of source video at `-cpu-used 8 -crf 40` (about 0.31× real time); this was a metadata proof, not a quality test. The earlier injector prototypes still fail their metadata checks. No change was made to V15. See [HDR_AUDIO_REPAIR_TEST_REPORT.md](HDR_AUDIO_REPAIR_TEST_REPORT.md) for the timing caveats, candidate path, and remaining production/device validation.

See [HDR_AUDIO_REPAIR_TEST_REPORT.md](HDR_AUDIO_REPAIR_TEST_REPORT.md) for the exact test commands, output paths, and logs.

### Hybrid policy failures and corrections — 2026-11-06

Three production-log sources exposed two false rejections and one safe fallback case:

- A Dolby Vision Profile 8.1 + HDR10+ source was misclassified as containing unsupported dynamic HDR because the detector searched serialized MediaInfo, including the free-text title. The title contained an abbreviated SMPTE ST 2094 label that remained after HDR10+ text was stripped.
- A verified Dolby Vision Profile 7 + HDR10+ source was rejected because the policy had no route for this hybrid.
- A Profile 7 source had valid HDR10 mastering data but unknown content-light values (`0/0`). The Dolby Vision Level 6 mastering values are unrelated when its content-light values are unknown, so comparing those luminance values against the HDR10 base caused a false conflict.

The policy now classifies dynamic HDR from structured MediaInfo HDR fields and decoded frame side data, ignoring free-text titles. It permits a Profile 7 + HDR10+ fallback only when the stream is HEVC, limited-range PQ/BT.2020, and its Dolby Vision configuration confirms Profile 7 with BL, EL, and RPU present and compatibility ID 6. Decoded frames must still confirm HDR10+ before the route is selected. For Level 6 `0/0` content-light values, the flow preserves valid HDR10 mastering metadata and omits content-light metadata instead of comparing or inventing values. Every route still runs the full source scan and strict HDR10 output checks.

Two additional live Profile 7 sources (one plain HDR10-compatible base, one HDR10+ hybrid) failed after 71–85 minutes with `HDR light metadata conflicts with decoded frames`. Read-only one-second probes in the existing test container showed `max_content=0` and `max_average=0` on the decoded frames. FFmpeg uses that pair to mean the CLL is unspecified; the frame collector had treated it as real metadata and compared it against the valid Level 6-derived value. The collector now ignores only the `0/0` placeholder while retaining checks for actual nonzero frame metadata. The sources were kept. Discord delivery succeeded for both jobs. The one-second probes confirm the false mismatch trigger; the full flow has not been rerun on these large sources.

The three source classes were exercised in the existing test container with isolated 120-frame Arc QSV samples using the flow's QSV decode, filter, and AV1 encode path. All produced AV1 with limited-range PQ/BT.2020 signaling. The Profile 7 source with unknown content light retained mastering metadata and omitted content-light metadata; the Profile 7 + HDR10+ and Profile 8.1 + HDR10+ samples retained static HDR10 metadata while their HDR10+ and Dolby Vision frame side data were absent. Temporary outputs were removed after probing. These are metadata/encode smoke tests, not full-flow replacement validation, full-file decode tests, or HDR visual-quality assessments.

### HDR10+ rejection details

The source frame scan reports green-y mastering chromaticity `39850/50000` (0.797). The candidate's decoded AV1 frame reports `50000/65536` (about `0.763`), while output container-level mastering and content-light records appear correct. V15 rejects the mismatch rather than accepting the container-level record alone. The Profile 7 and 8.1 inputs that passed use green-y `34500/50000` (0.69), below the observed limit.

Two controlled test-container QSV encodes reproduced the same mismatch: CPU decode with QSV VPP, and CPU decode with VPP bypassed before Arc upload. Both yielded 11,605,166-byte candidates with the same bad frame metadata. The V15 job also rejected its Arc-produced candidate. This rules out the QSV source decoder and VPP filter as the source of the mismatch. Intel VPL GPU Runtime issue [#372](https://github.com/intel/vpl-gpu-rt/issues/372) documents the same AV1 mastering chromaticity clamp at 0.762940 and states the range needs to reach at least 0.840000. The measured output is exactly the reported clamp, identifying the Intel QSV/oneVPL AV1 HDR metadata path as the root cause.

FFmpeg's documented `av1_metadata` bitstream filter can modify AV1 color-description fields, but its documented options do not include mastering-display chromaticity rewriting. FFmpeg 8.1's QSV AV1 encoder passes mastering-display frame side data into the oneVPL encode control. [FFmpeg AV1 bitstream filter documentation](https://www.ffmpeg.org/ffmpeg-bitstream-filters.html), [FFmpeg QSV encoder source](https://www.ffmpeg.org/doxygen/8.1/qsvenc__av1_8c_source.html).

No flow code change was made, consistent with the instruction to leave driver/runtime bugs alone. The validator remains strict and the original stays safe.

## Scope and limitations

- The Profile 7 and 8.1 tests show successful fallback behavior on these exact fixtures, not every profile variant or stream arrangement.
- There is no genuine HLG or Dolby Vision Profile 8.4 fixture. Profile 8.4 remains held pending a real sample.
- The synthetic HLG job took the remux branch, so encoded HLG output still lacks a V15 end-to-end result.
- HDR picture quality was not assessed with VMAF or visual comparison. All HDR jobs are safety/metadata checks, not a perceptual quality certification.
- The tested pure HDR10+ fixture is still not safely encodable on this QSV AV1 path because of the mastering-coordinate clamp. The separately tested DV 8.1/HDR10+ hybrid passed a short HDR10 metadata smoke test, but has not passed a full V15 job.

See [LIVE_TEST_REPORT.md](LIVE_TEST_REPORT.md) for the complete V15 live test summary.
