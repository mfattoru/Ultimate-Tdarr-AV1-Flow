# V6: concurrent jobs, PGS validation and failure notifications

Work in a separate export; never change the live Tdarr workflow or library. Preserve original input and accepted audio/subtitle behavior, use the Arc and bounded quality values, require smaller output, and do not keep permanent recovery copies.

1. Reproduce the reported V3 failure: compare remuxed PGS segment payloads and timestamps with the source. Implement a packetization-independent PGS content and timeline validator; add regression tests for same-content regrouping and missing/retimed segments.
2. Route both controlled failures and unexpected flow errors through a deduplicating Discord failure notification; retain the actual reason in flow variables and keep failure status if notification fails. Test with mock HTTPS only.
3. Replace the whole-job capacity lock with per-filesystem reservations guarded by a short mutex. Preserve cleanup ownership and recoverability; handle /dev/shm and disk independently, concurrency, low space and crashes conservatively.
4. Investigate supported HDR/Dolby paths; enable only conversions whose pixel transform and output metadata can be validated. Preserve user-approved HDR10 fallback and report unsupported or unverified variants rather than destroying originals.
5. Run unit and integration regressions, disposable node tests for PGS and Arc, independent review, and document live-deployment limits.
6. Preserve styled ASS/SSA subtitle tracks in Matroska: stream-copy them without SRT conversion, validate their output codec/packet count/timeline, and separately confirm Jellyfin playback on the TV and phone.

---

# V15 Resilience & Compatibility Plan (Out-of-Order ASS, Video Timestamp Quantization, Dynamic-HDR Seek-Heal Stream-Copy Preservation)

## Change Categorization
- **In-Place Behavioral & Feature Enhancements**:
  1. **Chronological ASS/SSA Subtitle Normalization & Multiset Validation** (`Overlord - S01E08` and general Matroska anime/remuxes).
  2. **Video Timestamp Quantization Tolerance & Input DTS Preservation** (`Street Fighter (2026)` and general B-frame / VFR-origin WebRips).
  3. **Dynamic-HDR Seek-Heal Stream-Copy Preservation** (`Challengers (2024)` and compact 4K WEB-DLs): Allow dynamic HDR routes (`dovi81_hdr10`, `dovi7_hdr10`, `hdr10plus_hdr10`, `dovi81_hdr10plus_hdr10`, `dovi7_hdr10plus_hdr10`) to use the `seek-heal` source-video stream-copy remux (`ArcAV1_SeekHeal_V15`) when `ICQ 22` reaches the quality floor, and validate that stream-copied candidates preserve their exact source Dolby Vision RPU and HDR10+ dynamic metadata frame counts alongside static HDR metadata.

## Files Affected
- [`subtitle_timing.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/subtitle_timing.js):
  - Extend `createSubtitleTimingPrecheck` / packet analysis to identify which retained ASS/SSA streams contain out-of-order packets (`backwardPackets > 0` or `maxAdjustmentSeconds > 0`).
  - Add helper to reconstruct/normalize an out-of-order Matroska ASS/SSA stream into a temporary `.ass` subtitle input (ordered by `ReadOrder` so FFmpeg's `assdec` emits packets in chronological `pts` order while preserving `[Script Info]`, `[V4+ Styles]`, event payloads, `pts`, and `duration`).
  - Update `validateCopiedSubtitlePackets` so out-of-order source ASS/SSA streams are validated against the chronologically sorted output packets (verifying exact packet count, monotonic output PTS/DTS, payload integrity, and per-event timestamp/duration fidelity within `maxRepairSeconds`), while monotonic source tracks retain strict index-by-index validation.
- [`policy.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/policy.js):
  - Update `compareVideoTimestamps` to:
    1. Tolerate Matroska timebase quantization ties / sub-frame jitter (`<= 0.002s` / 2 ms step between adjacent frames) when the source advances, while still enforcing the strict `0.050s` (50 ms) cumulative presentation drift bound (`|(a[i]-a[0]) - (b[i]-b[0])| <= 0.050`).
    2. Include exact `source[i-1] -> source[i]` and `output[i-1] -> output[i]` timestamps in `video_timestamp_order_changed` when a genuine backward jump (`> 0.002s`) occurs.
- [`progress.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/progress.js):
  - Update `runSingleQuality` (or add bounded quality step-up `qualitySteps`, e.g. `[quality, quality + 2, quality + 4]` capped at `51`) when an AV1 encode hits `quality_floor` (`size >= sourceSize`) so compact sources (especially dynamic HDR routes that cannot fall back to stream-copy `seek_heal_remux`) can step up ICQ to produce a smaller valid AV1 output.
- [`build.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build.py) & [`build_additions.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build_additions.py):
  - **Stale Quarantine Self-Healing (Preflight)**:
    - Before running the full CPU source frame scan, if `quarantinedCandidate` is loaded:
      - Retire/remove the quarantined candidate and proceed with a fresh encode if `quarantinedCandidate.kind === 'seek_heal_remux'` and preflight detects a dynamic HDR route (`preflightDoviRoute` or HDR10+ signaling where `mustRetainOriginalAtQualityFloor` applies).
      - Retire/remove the quarantined candidate and proceed with a fresh encode if the source requires retained attachments (`retainedAttachmentStreams.length > 0`) that are missing from the quarantined candidate, or if the source has out-of-order ASS/SSA packets that the quarantined candidate corrupted via `setts`.
  - **Out-of-Order ASS Normalization in FFmpeg Pipeline**:
    - When `createSubtitleTimingPrecheck` detects an ASS/SSA stream whose packets are out of chronological order, extract/normalize that stream into a job-scoped temporary `.ass` file in the scratch directory and map it into FFmpeg (`-i normalized.ass -c:s:<idx> copy`) without applying the destructive `setts=max(PTS,PREV_OUTPTS)` clamp.
  - **FFmpeg Input Timestamp Flags**:
    - Use `-fflags +genpts` on normal video encodes (preserving valid input container DTS for B-frame streams) and reserve `+igndts` only for `forceStreamCopy` (`seek_heal_remux`) and Dolby RPU annex-B extraction.
- **Test Files (`*.test.js`)**:
  - [`subtitle_timing.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/subtitle_timing.test.js): Add unit & FFmpeg integration tests for out-of-order ASS subtitle normalization and chronological multiset validation (including the exact `5.000s` -> `1.860s` pattern from `Overlord - S01E08`).
  - [`hdr_route.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/hdr_route.test.js) / [`validation_resilience.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/validation_resilience.test.js): Add tests for `compareVideoTimestamps` 1–2 ms quantization ties vs. true backward jumps, ICQ step-up on `quality_floor`, and preflight retirement of incompatible quarantined candidates.
- [`flow.json`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/flow.json) & [`FAILURE_DIAGNOSTICS.md`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/docs/architecture/FAILURE_DIAGNOSTICS.md):
  - Rebuild `flow.json` via `python3 build.py` and document the updated behavior.

## Step-by-Step Execution Path (TDD)
1. **Red Phase (Write Failing Tests)**:
   - Add failing tests in `subtitle_timing.test.js` for out-of-order ASS packet normalization and chronological validation.
   - Add failing tests in `validation_resilience.test.js` / `hdr_route.test.js` for:
     - `compareVideoTimestamps` allowing 1 ms Matroska quantization ties while rejecting true backward jumps with full timestamp details in the error message.
     - `runSingleQuality` stepping up ICQ (`+2`, `+4`) when the base ICQ hits the source-size cap (`quality_floor`).
     - Preflight quarantine self-healing (retiring `seek_heal_remux` on dynamic HDR routes and retiring candidates missing attachments / having `setts`-clamped ASS tracks).
2. **Green Phase (Implement Production Logic)**:
   - Implement the changes in `subtitle_timing.js`, `policy.js`, `progress.js`, `build.py`, and `build_additions.py`.
3. **Refactor & Verify**:
   - Rebuild `flow.json` via `python3 build.py`.
   - Run the complete test suite to verify 100% pass rate and zero regressions.
   - Update `FAILURE_DIAGNOSTICS.md`.

---

# V15 HDR Fixes: Dolby Level 6 Conflict Fallback & Dolby Vision Profile 5 -> HDR10 Path

## Change Categorization
- **In-Place Behavioral Change (`Pirates` Option 1A)**: Update `resolveHdrLight` in `policy.js` so Dolby Vision HDR10-compatible fallback routes (`dovi81_hdr10`, `dovi7_hdr10`, `dovi81_hdr10plus_hdr10`, `dovi7_hdr10plus_hdr10`) do not borrow conflicting Level 6 `MaxCLL`/`MaxFALL` when the verified HDR10 base layer omits CLL (or sets `0,0`) and Level 6 mastering luminance differs from the HDR10 base. Instead, omit CLL (`override: null`), emit a structured warning, and proceed with encoding the verified HDR10 base layer without CLL.
- **New Feature Addition (`Dune` `dovi5_hdr10` Route)**: Add a dedicated `dovi5_hdr10` route converting verified Dolby Vision Profile 5 (`dvhe.05`, full-range IPT-PQ-c2 with no HDR10 base layer) to limited-range BT.2020 PQ HDR10 AV1 via Vulkan `libplacebo` (`apply_dolbyvision=true`) + `dovi_tool` Level 6 / Level 9 static HDR10 metadata synthesis.

## Files Affected
- [`policy.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/policy.js):
  - Update `resolveHdrLight` for Option 1A Level 6 luminance conflict handling + `warning` field.
  - Add `isVerifiedDolbyProfile5Config`, `parseDolbyLevel9`, `summarizeLevel9Rows`, `extractDolbyProfile5HdrMetadata`, `formatMasteringDisplayArg`, and `buildDovi5HdrTarget`.
  - Update `preflightDolbyHdrRoute` and `determineHdrRoute` to admit and verify `dovi5_hdr10`.
- [`progress.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/progress.js):
  - Allow optional `env` override in `runLimitedFfmpeg` so FFmpeg inherits Intel Vulkan ICD variables without mutating global container environment.
- [`build.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build.py):
  - Log `resolveHdrLight` warnings on Option 1A fallback.
  - Enforce `dovi5_hdr10` preflight capability gate (`libplacebo` filter + `/usr/share/vulkan/icd.d/intel_icd.json`) and extract RPU Level 6 + Level 9 metadata before the full source scan.
  - Configure CPU decode + Vulkan `libplacebo` filter (`apply_dolbyvision=true:colorspace=bt2020nc:color_primaries=bt2020:color_trc=smpte2084:range=tv:tonemapping=clip:peak_detect=false:format=p010le` / `yuv420p10le` for SVT-AV1 fallback) + `sidedata=mode=delete:type=DOVI_METADATA` (+ `CONTENT_LIGHT_LEVEL` strip when CLL is absent/0,0), `-mastering_display` / `-content_light` before `-i`, `VK_ICD_FILENAMES` / `VK_DRIVER_FILES` override, and strict HDR10 + `dovi5_hdr10` stream-copy fallback validation.
- [`flow_test_runtime.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/flow_test_runtime.js), [`policy.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/policy.test.js), [`progress.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/progress.test.js), [`flow.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/flow.test.js): TDD unit and flow-wiring tests.
- [`README.md`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/README.md), [`V15_DESIGN.md`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/docs/architecture/V15_DESIGN.md), [`HDR_LIVE_VALIDATION.md`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/docs/reports/HDR_LIVE_VALIDATION.md), [`FAILURE_DIAGNOSTICS.md`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/docs/architecture/FAILURE_DIAGNOSTICS.md), and regenerated [`flow.json`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/flow.json).

## Step-by-Step Execution Path (TDD)
1. **Red Phase**: Update conflicting Level 6 tests in `policy.test.js` and add failing unit/wiring tests for Option 1A warnings, `dovi5_hdr10` classification/Level 9 synthesis, `runLimitedFfmpeg` `env` propagation, and flow wiring; run `node --test *.test.js`.
2. **Green Phase**: Implement logic in `policy.js`, `progress.js`, `build.py`, and `flow_test_runtime.js`, update docs, and run `python3 build.py`.
3. **Verify**: Run `node --test *.test.js` to confirm all tests pass, smoke-verify `dovi5_hdr10` in the Unraid test container if appropriate, and author `walkthrough.md`.

