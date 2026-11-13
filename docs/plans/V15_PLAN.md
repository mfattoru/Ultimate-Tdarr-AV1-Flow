# Tdarr Arc AV1 V15 Candidate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build and verify a separate V15 Tdarr candidate that keeps the existing approved encode and safety behavior, removes the failed sampled source check, fixes process-diagnostic handling, and speeds strict output video validation with the Arc.

**Architecture:** Copy V14 into a new local revision folder and make changes only in that copy. Keep the full source frame/color/timestamp scan on CPU, keep Arc QSV as the encoder, use Arc QSV for strict output video decode, and keep audio validation on CPU. Preserve the size-guard remux, bounded capacity reservations, stream policies, notifications, and Arr matching.

**Tech Stack:** Node.js, Python 3, FFmpeg/FFprobe, Intel Arc QSV, Tdarr Flow JSON, Unraid test container.

**Spec:** [V15_DESIGN.md](../architecture/V15_DESIGN.md)

## Global Constraints

- Preserve the production flow and every older local revision; create V15 under work/tdarr-flow-v15.
- Use the already-running test container only; do not recreate it.
- Test media and generated outputs stay under /test. Keep /mnt/media read-only and do not write to production libraries.
- Arc encoding remains mandatory for every eligible video. The default device is /dev/dri/renderD129; TDARR_ARC_DEVICE remains configurable.
- Keep one encode at ICQ 22. If it is not smaller, discard it and try a source-video stream-copy seek-healing remux.
- The remux has no source-relative size cap. Its only write limit is capacity granted by the RAM/disk reservation ledger. A larger remux may replace the source only after full validation.
- Do not create permanent recovery copies, add a whole-job mutex, change audio/subtitle selection, or change the existing HDR/Dolby Vision transforms without user approval.
- Keep full source and candidate frame/timing/color/HDR checks. Do not restore the sampled precheck that failed in live use.
- Treat unsupported or unverified inputs conservatively, keep the original on failed validation, and do not submit an Arr request for an output-only failure.
- Keep Discord webhooks and Arr credentials in environment configuration, never in flow JSON.
- Production import is a separate final action requiring the user's approval after the candidate and test report are reviewable.

## Review Focus

1. Full source frame scans must not recreate the previous sampled-window frame-count failures; assert full counts and normalized timestamps on both source and candidate.
2. FFprobe/FFmpeg returning status 0 with harmless stderr must not fail by itself, while recognized malformed source bitstreams must still be reported as source corruption.
3. A QSV output-decode failure must not be mislabeled as source damage unless strict source decoding reproduces a recognized corruption signature.
4. Untagged, partially tagged, full-range, HDR10, HDR10+, HLG, and Dolby Vision metadata must preserve their existing decisions; Profile 8.4 remains a release gate pending the user's answer and a genuine fixture.
5. RAM/disk reservations, concurrent jobs, remux growth, cleanup, and Discord/Arr branches must remain safe and observable under success, failure, and cancellation.

---

### Task 1: Create an isolated V15 revision

**Files:**
- Create: work/tdarr-flow-v15/ (copy the V14 candidate and its base assets, tests, and documentation)
- Modify: work/tdarr-flow-v15/build.py
- Modify: work/tdarr-flow-v15/README.md
- Test: work/tdarr-flow-v15/flow.test.js
- Test: work/tdarr-flow-v15/policy.test.js

- [ ] Copy V14 to work/tdarr-flow-v15 without moving or deleting V14 or archived revisions.
- [ ] Set the flow ID to ArcAV1_SinglePass_UnattendedV15, the review name to V15, and success/remux markers to V15. Keep recognition of prior V14 and earlier completion markers.
- [ ] Build flow.json from the copied builder and assert the flow ID, name, node count, edges, marker values, and required environment-variable references.
- [ ] Add a regression that an input carrying a V14 completion marker returns the already-processed outcome and does not encode again.
- [ ] Run the V15 local flow-structure checks and confirm the V14 export and directory are unchanged.

### Task 2: Restore full source and candidate timeline checks

**Files:**
- Modify: work/tdarr-flow-v15/build.py
- Modify: work/tdarr-flow-v15/policy.js
- Modify: work/tdarr-flow-v15/policy.test.js
- Modify: work/tdarr-flow-v15/integration.test.js
- Modify: work/tdarr-flow-v15/flow.test.js
- Modify: work/tdarr-flow-v15/README.md
- Modify: work/tdarr-flow-v15/flow-diagram.md

- [ ] Add tests asserting that every eligible source receives a full frame scan before encoding and that candidate validation compares complete source/output frame counts and normalized PTS.
- [ ] Add regression inputs with long GOPs and non-integer frame rates. Assert exact full counts and PTS comparison, not three selected windows.
- [ ] Remove sample eligibility, sample-window estimates, sampled timeline comparison, and sample-only full-scan fallback from the V15 builder and policy. Keep the source scan on CPU because this FFprobe build cannot use the Arc device.
- [ ] Keep progress updates during the full scan; use the known total-frame estimate when available and report FPS only when measured.
- [ ] Keep the full candidate frame/color/HDR inspection and full timestamp checks. Do not replace the FFprobe scan with the slower-to-parse QSV showinfo experiment.
- [ ] Run the policy, integration, and structure tests. Expected result: every eligible path has a full source scan and full source/output timestamp comparison; no sample-window branch remains in V15.

### Task 3: Correct process exit and stderr handling

**Files:**
- Modify: work/tdarr-flow-v15/build.py
- Modify: work/tdarr-flow-v15/policy.js
- Modify: work/tdarr-flow-v15/pgs.js
- Modify: work/tdarr-flow-v15/policy.test.js
- Modify: work/tdarr-flow-v15/pgs.test.js
- Modify: work/tdarr-flow-v15/integration.test.js

- [ ] Add process-wrapper tests for status 0 with benign stderr, non-zero exit, timeout, and a known malformed H.264 NAL diagnostic.
- [ ] Change the shared timeline runner to decide process success from spawn/timeout/exit status. Preserve stderr as diagnostic output instead of rejecting every zero-exit command that wrote to stderr.
- [ ] In the full source frame scan, classify recognized NAL/bitstream corruption signatures as source corruption even if FFprobe exits 0; keep benign decoder notices nonfatal when the scan completed and returned valid frames.
- [ ] Keep non-zero scanner/tool failures as safety failures. Do not classify them as source corruption unless the known corruption pattern is present.
- [ ] Change PGS extraction to use its exit status for process success and let segment payload/timing validation detect missing, altered, or retimed content. A benign zero-exit warning must not skip validation or fail by itself.
- [ ] Verify notification text shows the concise human-readable category and the original diagnostic, and that Arr search is requested only for recognized corruption in the original source.
- [ ] Run policy, PGS, integration, and notification tests. Expected result: benign stderr passes; malformed source is classified and routes to item-scoped search; output-only and utility failures retain the original without a source search.

### Task 4: Use Arc for strict candidate video decode

**Files:**
- Modify: work/tdarr-flow-v15/build.py
- Modify: work/tdarr-flow-v15/progress.js
- Modify: work/tdarr-flow-v15/integration.test.js
- Modify: work/tdarr-flow-v15/progress.test.js
- Modify: work/tdarr-flow-v15/flow.test.js

- [ ] Add tests asserting candidate video health decode initializes QSV on TDARR_ARC_DEVICE and defaults to /dev/dri/renderD129.
- [ ] Add tests asserting copied audio is still fully decoded by FFmpeg on CPU and candidate decode failures do not trigger Arr search unless strict source decode finds recognized corruption.
- [ ] Add the QSV device and AV1 hardware-decode arguments to the strict candidate video decode only. Keep full frame/timing/color scans and audio decode behavior separate.
- [ ] Keep status code and recognized diagnostic handling consistent with Task 3. A QSV initialization/driver error is an output validation failure, not proof the source is corrupt.
- [ ] Keep progress percentage and FPS reporting for the strict video decode and for stream-copy remux. Ensure metadata-only validation does not claim a frame rate.
- [ ] Benchmark the same AV1 candidate on CPU and QSV strict decode. The existing reference is about 79 seconds on CPU and 20 seconds on Arc; accept the change only if every tested output fully decodes and the run is measurably faster.
- [ ] Run all progress and integration regressions. Expected result: QSV handles candidate video decode, CPU handles audio decode, and validation failures still retain the source.

### Task 5: Recheck capacity, RAM scratch, and concurrent-job safety

**Files:**
- Modify: work/tdarr-flow-v15/build.py
- Modify: work/tdarr-flow-v15/reservations.js
- Modify: work/tdarr-flow-v15/reservations.test.js
- Modify: work/tdarr-flow-v15/progress.js
- Modify: work/tdarr-flow-v15/flow.test.js

- [ ] Add tests for getFreeSpaceMB using statfs available-block and block-size values, verifying conversion to MB happens exactly once and invalid capacity fails closed.
- [ ] Verify /dev/shm is selected only when both filesystem capacity and host MemAvailable satisfy the reservation; otherwise select the configured disk cache.
- [ ] Keep the short reservation-ledger lock only. Add/retain two-worker tests proving jobs can proceed concurrently without spending the same free capacity twice.
- [ ] Verify remux growth can exceed source size only after reservation growth succeeds, protects configured floors, and terminates/removes the partial output when growth is denied.
- [ ] Verify every success/failure/error path releases its own reservation and scratch directory without deleting another job's files. Preserve SIGTERM/cancellation cleanup and stale-lease recovery.
- [ ] Run reservation and progress tests. Expected result: no global job lock, no unbounded remux, correct RAM/disk selection, and no permanent recovery copy.

### Task 6: Preserve media, notification, and supported-format policies

**Files:**
- Modify: work/tdarr-flow-v15/build.py
- Modify: work/tdarr-flow-v15/policy.js
- Modify: work/tdarr-flow-v15/arr_action.js
- Modify: work/tdarr-flow-v15/already_notify.js
- Modify: work/tdarr-flow-v15/failure_notify.js
- Modify: work/tdarr-flow-v15/pgs.js
- Modify: work/tdarr-flow-v15/policy.test.js
- Modify: work/tdarr-flow-v15/integration.test.js
- Modify: work/tdarr-flow-v15/failure_notify.test.js
- Modify: work/tdarr-flow-v15/success_notify.test.js
- Modify: work/tdarr-flow-v15/CODEC_COVERAGE.md
- Modify: work/tdarr-flow-v15/HDR_LIVE_VALIDATION.md

- [ ] Keep ICQ 22 global and attempt one encode for each eligible video, including AV1. Verify a non-smaller AV1 result takes the source-video remux branch once.
- [ ] Keep English, Japanese, Spanish, Italian, undetermined, and the existing conditional Chinese behavior; keep the current stream-copy and redundancy-pruning rules. Do not change subtitle selection or ASS/SSA preservation.
- [ ] Keep PGS segment/payload/timeline validation and test packet regrouping, missing/changed/retimed segments, truncation, and PTS wrap.
- [ ] Keep the existing HDR10, HDR10+, HLG, Dolby Vision 7/8.1, color-range, untagged SDR, and metadata rules. Keep the passed codec/pixel-format/container paths and all existing guard holds; do not widen support based only on synthetic SDR tests.
- [ ] Resolve the Profile 8.4 release branch using the user's answer. Recommended default: hold it and report it as unverified until a genuine sample passes the HLG-base route. If the current route is retained provisionally, label it unverified and do not claim complete Profile 8.4 support.
- [ ] Verify Discord success/failure, already-processed information, and ISO-delete warning messages. Test ISO deletion only against a disposable /test fixture. Test Arr selection and request payloads against a local/mock endpoint because test-container Arr credentials are disabled.
- [ ] Run media policy, notification, PGS, and integration tests. Expected result: user-approved policies and user-readable notices remain intact, exact path matching chooses the correct Arr, and only recognized source corruption requests search.

### Task 7: Build and live-verify the V15 candidate in the existing test container

**Files:**
- Modify: work/tdarr-flow-v15/flow.json
- Modify: work/tdarr-flow-v15/README.md
- Modify: work/tdarr-flow-v15/flow-diagram.md
- Modify: work/tdarr-flow-v15/CODEC_COVERAGE.md
- Create: work/tdarr-flow-v15/LIVE_TEST_REPORT.md

- [ ] Build the V15 flow with the V15-local builder and run every local Node test file. Expected result: all tests pass and the export ID/name/markers are V15.
- [ ] Import V15 only into the existing tdarr-flow-live-test-20261102 container. Confirm its library points to /test, /mnt/media is still read-only, Arr targets are disabled or mocked, and Discord credentials remain in the container environment rather than the export.
- [ ] Exercise small and large SDR sources, 720p/1080p/4K, H.264/HEVC/AV1 direct-QSV cases, CPU fallback codec/pixel-format cases, full/limited and partial color tags, and the verified HDR/DV samples recorded in CODEC_COVERAGE.md.
- [ ] Exercise the malformed H.264 source, benign FFprobe/FFmpeg stderr, a candidate output decode failure, a subtitle validation failure, and a cache-growth denial. Confirm correct human-readable Discord classification and correct Arr-search eligibility without calling production Arr services.
- [ ] Exercise smaller AV1 success, larger/equal AV1 followed by a fully validated seek-heal remux, the already-processed information notice, and ISO deletion plus warning using only disposable /test files.
- [ ] Run at least two jobs concurrently and inspect RAM/disk reservations, scratch cleanup, progress percentage, and FPS during scan, encode, remux, and output decode in the Tdarr UI.
- [ ] Record per-case input/output sizes, ICQ, duration, route, frame counts, metadata, validation outcome, notification outcome, and any remaining limits in LIVE_TEST_REPORT.md. Do not call the flow production-ready if any candidate replaces an original without every check passing.
- [ ] Keep production Tdarr and media untouched. Present the V15 JSON, report, and updated Mermaid diagram for final user review; production import happens only after explicit approval.

### Task 8: Repair non-monotonic copied ASS/SSA timestamps

**Evidence:** [SUBTITLE_MUX_TEST_REPORT.md](../reports/SUBTITLE_MUX_TEST_REPORT.md) reproduces the Sample Anime Series S14E27 failure in the existing test container. Source ASS stream 3 contains one timestamp inversion (2.450 s followed by 2.140 s). The current command applies the `setts` clamp to PGS only, so Matroska exits 234 while muxing the copied ASS stream. Applying the PTS/DTS clamp to that copied ASS track made both a copy-only remux and a real Arc AV1 encode complete. The test preserved every subtitle payload; it moved only the out-of-order cue by 0.311 s. `-fflags +sortdts` did not repair the failure.

**Files:**
- Modify: `work/tdarr-flow-v15/build.py` and `work/tdarr-flow-v15/build_additions.py` to add the filter to copied text subtitle tracks and embed timing validation.
- Create: `work/tdarr-flow-v15/subtitle_timing.js` and `work/tdarr-flow-v15/subtitle_timing.test.js`.
- Modify: `work/tdarr-flow-v15/integration.test.js`, `work/tdarr-flow-v15/flow.test.js`, `work/tdarr-flow-v15/README.md`, `work/tdarr-flow-v15/FAILURE_DIAGNOSTICS.md`, `work/tdarr-flow-v15/flow-diagram.md`, and the rebuilt `flow.json`.
- Test: a generated, small Matroska fixture with an ASS timestamp inversion; then the read-only Sample Anime Series source in the existing test container.

**Interfaces:**
- `readSubtitlePackets(ffprobe, file, streamIndex) -> Promise<Array<{pts: number|null, dts: number|null, duration: number|null, payloadHash: string}>>` reads packet-order timestamps, packet duration, and SHA-256 payload hashes for a retained copied text subtitle stream.
- `validateCopiedSubtitlePackets(sourcePackets, outputPackets, globalShiftSeconds, maxRepairSeconds = 0.5) -> {packetCount: number, adjustedPackets: number, maxAdjustmentSeconds: number}` requires equal counts and identical payload hashes, monotonic output PTS/DTS, and no per-packet PTS adjustment beyond 0.5 seconds after the video timeline shift. It throws a safety error for missing timestamps or larger changes.

- [x] Reproduce the 2.450 s to 2.140 s timestamp inversion using the known Sample Anime Series S14E27 source; the unmodified copy-only mux failed with non-monotonic DTS. A separate synthetic malformed Matroska file was unnecessary because the exact production-shaped input reproduced the issue.
- [x] Add the existing PTS/DTS `setts` clamp to copied ASS/SSA streams in `appendAudioAndSubArgs`. Keep ASS/SSA stream-copy behavior and payloads; do not convert them to SRT. Keep the existing PGS filter and PGS segment validator unchanged. Do not add a second encode or retry pass.
- [x] Add tests for clean ASS/SSA timing remaining unchanged, one 0.310 s backward-timestamp correction succeeding, a correction above 0.5 s being rejected, output PTS/DTS monotonicity, packet-count equality, and payload-hash equality. Keep SRT-converted subtitles on their current path.
- [x] Add the packet reader and validator to the generated monolithic engine. Validate each copied ASS/SSA track after muxing, using the same source/output video timeline shift already used by `verifyVideoTimeline`. Use the 0.5-second repair limit for ASS/SSA stream endpoints too: the existing 0.1-second generic endpoint check rejects the confirmed 0.311-second repair. A failed subtitle check discards the candidate, retains the original, and remains an output-validation failure with no Arr search.
- [x] Run the local subtitle, integration, and flow structure tests; rebuild `flow.json`; assert the PGS filter, subtitle language selection, and Arc encoder arguments are unchanged. Full local suite after the source-error label fix: 161/161 tests passed.
- [x] Run the exact Sample Anime Series source through a direct V15-generated Arc FFmpeg command in the existing test container. It exited 0; full QSV video and CPU audio decodes passed; decoded video count matched at 43,959; ASS payload/count and PGS segment checks passed; max ASS correction was 0.311 s. Details are in `SUBTITLE_MUX_TEST_REPORT.md`.
- [x] Keep the original on every failure. Do not request Arr search for timestamp normalization or output validation failures; only the existing recognized-source-corruption rules may request a search.

**Still required before calling Task 8 live-verified:** import the sanitized export into the test instance, confirm its library is `/test` and Arr actions are disabled or mocked, then run one complete Tdarr job and inspect replacement and notification behavior. This was not attempted because the imported flow is stale and still has legacy Arr settings. No production flow or media was changed.

## Completion Criteria

V15 is ready for production review only when the full source/candidate scans pass on the representative matrix, copied ASS/SSA timestamp repair preserves payloads and remains within its 0.5-second bound, the zero-exit stderr regressions behave as specified, strict Arc video and CPU audio checks pass, RAM/disk reservations remain safe under concurrent jobs, all test-only notifications and Arr-routing mocks pass, and the full Tdarr test-container job replaces files only after all checks. Any unverified format or route stays guarded and documented. Production import is not part of this plan's implementation work.
