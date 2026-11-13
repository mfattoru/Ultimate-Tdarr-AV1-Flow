# V15 live test report — 2026-11-03

## Test setup and safety boundary

- V15 was built as `ArcAV1_SinglePass_UnattendedV15` with 17 plugins and imported into the existing `tdarr-flow-live-test-20261102` test instance.
- The live jobs below used the earlier imported V15 revision. The current local V15 export has since been changed to environment-only Arr configuration and rebuilt, but that sanitized export has **not** been imported into Tdarr. The test instance still contains the earlier flow copy with embedded Arr settings; do not queue more jobs on it until that flow is updated. No Arr request was sent during this audit.
- The `V15 Live Test` library is assigned to that flow and scans only `/test/v15-source`.
- The test container's `/mnt/media` mount was confirmed read-only. All V15 input copies and outputs remained under `/test` or `/dev/shm`.
- The container has a Discord webhook configured and no Arr environment variables. The earlier imported flow nevertheless contained static Arr settings, so the absence of environment variables alone does not make that old copy safe to run. No Arr request was sent during this audit. Discord results below are live test notifications from the earlier V15 live run.
- Arc QSV was addressed as `/dev/dri/renderD129`. The test container was not recreated, and production Tdarr, libraries, and media were not modified.

## End-to-end Tdarr jobs

| Case | Input and route | Outcome | Notification |
| --- | --- | --- | --- |
| Malformed H.264 | Sample Sports Series S05E12, 264,431,975 bytes; full CPU source scan | The source scan found malformed H.264 NAL units and stopped before encoding. The original remained in place. | Discord failure arrived with a human-readable source-corruption category. Arr search was not attempted because test Arr credentials are disabled. |
| Dolby Vision Profile 7 | `Sample HDR Film-p7.mkv`, 125,996,583 bytes; Arc AV1 ICQ 22, HDR10-compatible base | AV1 Main10, 3840×2160, PQ/BT.2020; 21,920,460 bytes (82.6% smaller). Static mastering and content-light metadata passed validation; Dolby Vision metadata was absent as expected for the HDR10 fallback. | Discord success arrived. |
| Dolby Vision Profile 8.1 | `soul-p81.mkv`, 106,355,854 bytes; Arc AV1 ICQ 22, HDR10 fallback | AV1 Main10; 6,545,324 bytes (93.85% smaller). Output passed full validation; static HDR metadata matched the selected fallback and Dolby Vision metadata was absent. | Discord success arrived. |
| Synthetic HLG | `synthetic-hlg.mkv`, 6,589,120 bytes | The AV1 encode was not smaller, so V15 source-video seek-heal remuxed. Final size was 6,589,174 bytes (+54); HLG/BT.2020 signaling remained and output validation passed. This was a metadata-route smoke test, not a real-content HLG encode. | Discord success arrived. |
| AV1 stream-policy fallback | Sample Adventure Series S15E39, 180,676,660 bytes; 720p AV1 source | The single ICQ 22 attempt was not smaller. V15 ran its source-video seek-heal remux without a source-relative size cap. It retained AV1 video, Japanese E-AC-3, English/Spanish SubRip, and passed validation at 180,676,725 bytes (+65). | Discord “Size Bloat Fallback Success” arrived. |
| HDR10+ | `birds-hdr10plus.mkv`, 167,234,814 bytes; full source scan and Arc AV1 ICQ 22 | Encode produced 11,605,199 bytes, but full output validation rejected it: `HDR mastering metadata conflicts with decoded frames`. The candidate was discarded and the original remained untouched. | Discord validation-failure alert arrived. |

The local V15 Node suite now passes **153/153 tests**. The sanitized V15 flow export rebuilt successfully and contains 17 plugins. Tests cover both Arr plugin nodes, environment-only settings, exact mocked Sonarr/Radarr request payloads, ISO warning content, already-processed info delivery, and best-effort handling when Discord delivery fails. No Arr or Discord service was contacted by these new local tests. A local export scan found no embedded Arr host, Arr API key, or Discord webhook. This verifies code-level policy and synthetic/integration cases in addition to the live Tdarr jobs above; it does not mean every codec/container combination was exercised end to end.

## HDR10+ metadata investigation

The source's decoded frames report mastering display green-y as `39850/50000` (0.797); the encoded AV1 frames report `50000/65536` (about 0.763). The output container-level mastering and content-light records look correct, but the decoded-frame metadata conflicts, so V15 correctly refuses replacement. The P7/P8.1 sources that passed use green-y `34500/50000` (0.69), below this clamp.

I reproduced the same output and coordinate with two controlled QSV commands: CPU decode plus QSV VPP, and CPU decode plus QSV upload with VPP bypassed. Both produced 11,605,166-byte outputs with the same mismatch. The live V15 path also reproduced the rejection. This rules out the source QSV decoder and QSV VPP as the cause. Intel's [VPL GPU Runtime issue #372](https://github.com/intel/vpl-gpu-rt/issues/372) documents the same AV1 mastering chromaticity clamp at 0.762940 and states that values need to reach at least 0.840000; the measured V15 value is exactly the reported clamp. This identifies the root cause as the Intel QSV/oneVPL AV1 HDR metadata path, not V15's source scan or output validator. It is not safe to waive the frame-level check based on the container tags alone.

No code change was made for this case, consistent with the instruction to leave driver/runtime bugs alone. The output remains held and the source is preserved. The test does not establish whether a newer runtime fixes the behavior.

## Not tested or still limited

- The sanitized local export could not be imported into the running test instance during this audit: the browser's local-file URL policy blocked the file handoff. The previously imported V15 copy remains in the test database and contains legacy static Arr settings. No jobs were started on that stale copy after discovering the mismatch. Update the existing test flow in Tdarr before further live jobs; do not delete any flows.
- HDR10+ has one source fixture, and its QSV AV1 output fails strict static-metadata validation as described above.
- No genuine HLG source or Dolby Vision Profile 8.4 source was available. The synthetic HLG job exercised the safe remux fallback, not an encoded HLG result. Profile 8.4 remains held.
- These jobs did not measure HDR picture quality or VMAF, verify Jellyfin playback, or test every client, stream layout, and subtitle/audio codec.
- Test Arr environment variables are unset, so exact Sonarr/Radarr request routing was not sent to a live Arr server. Mock tests pass. ISO deletion/refetch and already-processed Discord notifications, cache-denial, cancellation, and two simultaneous Tdarr workers were not exercised end to end in this run.
- Full CPU source and output scans remain in place. Live UI FPS/progress was not captured for each individual scan/remux/postcheck stage.

## Release assessment

The isolated test build demonstrates that the primary V15 flow, notifications, full source guard, supported DV fallback routes, and non-smaller AV1 remux fallback work on representative live files. V15 is **not production-ready yet**: the HDR10+ fixture is safely rejected, and several planned operational branches still need live exercise. Keep V15 confined to the test library until HDR10+ is either made to produce matching frame metadata through a supported runtime or explicitly held by policy, and the remaining release-gate tests are completed.
