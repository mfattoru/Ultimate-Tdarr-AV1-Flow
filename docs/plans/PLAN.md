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

---

# V15 Notification & Arr Offline Resilience Hardening Plan

## Change Categorization
- **Feature Addition / Non-Breaking Resilience Hardening** (with minor in-place behavioral refinements to `discord_success` and Arr HTTP stream handling):
  - No changes to flow topology, edge handles, output numbers (`outputNumber`), embed payloads, or environment variable names (`TDARR_DISCORD_WEBHOOK`, `TDARR_ARR_*`).
  - Refines `discord_success` delivery to match the defensive transport guarantees already enforced in `already_notify.js` and `failure_notify.js` (response stream error handling, wall-clock timeout, explicit webhook URL/protocol checks, and `args.jobLog` reporting), and closes the same response-stream error gap in `notify_arr` / `arr_action.js`.

## Files Affected
- [`src/discord_webhook.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/discord_webhook.js) *(new shared helper)*:
  - Provide a single hardened `sendDiscordWebhook(webhookUrl, payload, options)` helper used across all Discord notification nodes:
    - Validate `TDARR_DISCORD_WEBHOOK` presence and `https:` protocol before opening sockets, returning structured non-throwing failure status without logging webhook credentials/tokens.
    - Pass full `URL` (`protocol`, `hostname`, `port`, `pathname`, `search`) to `https.request`.
    - Attach both `request.on('error')` and `response.on('error')` so mid-stream socket resets when Unraid/internet drops cannot raise an unhandled `EventEmitter` `'error'`.
    - Enforce both an explicit wall-clock `setTimeout` (guarded with `typeof clearTimeout === 'function'` fallback safety) and `request.setTimeout` so stalled DNS lookups or sockets always settle within the configured budget.
    - Support bounded retries (`maxRetries`, `429` `retry_after` capped to a safe ceiling, `5xx`/network/timeout backoff) with an optional `maxTotalWaitMs` cap so offline retries never stall a Tdarr worker indefinitely.
    - Log sanitized diagnostics via `args.jobLog` (with `console` fallback).
- [`src/already_notify.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/already_notify.js) & [`src/failure_notify.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/failure_notify.js):
  - Delegate HTTPS POST delivery to `sendDiscordWebhook` (`retries: 1`, `timeoutMs: 10000`), removing duplicated `https.request` boilerplate while preserving existing log messages, `user.failure_notified` retry semantics, and `outputNumber` (`1` / `2`) contracts.
- [`scripts/build.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build.py) & [`scripts/build_additions.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build_additions.py):
  - Bundle `src/discord_webhook.js` into `discord_success`, `already_completed`, `notify_failure`, and `notify_failure_on_error`.
  - Update `discord_success` to call `sendDiscordWebhook` (3 bounded attempts, `15000` ms per-attempt timeout, `args.jobLog` + `console` logging, never throwing or failing the flow).
  - Harden `notify_arr` (in `build.py`) with `res.on("error", ...)` and a wall-clock `setTimeout` guard alongside `req.setTimeout(10000)`.
- [`src/arr_action.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/arr_action.js):
  - Add `res.on('error', ...)` and a wall-clock `setTimeout` guard to `request(...)` so mid-response Arr/Unraid disconnects settle cleanly as non-fatal failures.
- [`scripts/run-coverage.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/run-coverage.js):
  - Add `src/discord_webhook.js` to `--test-coverage-include` so the shared transport helper meets the >=90% line/function coverage gate.
- **Test Files**:
  - [`tests/discord_webhook.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/discord_webhook.test.js) *(new)*: Unit tests covering missing/non-HTTPS webhook, DNS/network errors (`ENOTFOUND`, `EHOSTUNREACH`, `ECONNREFUSED`), pre-connect wall-clock timeout, mid-response `res` `'error'` event, HTTP `429` retry + cap, `5xx` retry exhaustion, and secret redaction in logs.
  - [`tests/success_notify.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/success_notify.test.js): Add offline tests on the built `discord_success` plugin verifying network errors, response-stream `error`, timeouts, missing/invalid `TDARR_DISCORD_WEBHOOK`, and HTTP 5xx never throw and always return `outputNumber: 1`.
  - [`tests/already_notify.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/already_notify.test.js), [`tests/failure_notify.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/failure_notify.test.js), [`tests/arr_action.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/arr_action.test.js): Update VM test harnesses if needed for the shared helper and add mid-response `res` `'error'` regression tests.
- [`flow.json`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/flow.json):
  - Regenerate via `python3 scripts/build.py`.

## Step-by-Step Execution Path (TDD)
1. **Red Phase**:
   - Add failing unit tests in `tests/discord_webhook.test.js` for `sendDiscordWebhook` error/timeout/retry/stream-reset/redaction cases.
   - Add failing offline/error-stream tests in `tests/success_notify.test.js` (missing webhook, `http://` webhook, network failure, response stream `'error'`, timeout) and mid-response `'error'` test in `tests/arr_action.test.js`.
   - Run `npm test` to confirm the new tests fail as expected.
2. **Green Phase**:
   - Implement `src/discord_webhook.js`.
   - Refactor `src/already_notify.js` and `src/failure_notify.js` to use `sendDiscordWebhook`.
   - Update `src/arr_action.js`, `scripts/build.py`, `scripts/build_additions.py`, and `scripts/run-coverage.js`.
   - Rebuild `flow.json` with `python3 scripts/build.py`.
3. **Refactor & Verify**:
   - Run `make check` (`python3 scripts/build.py`, `npm run test:coverage`, and `git diff --check`) and confirm all tests and >=90% coverage thresholds pass.

---

# V15 WCG-SDR, Dolby Vision 8.6, Proactive SVT-AV1 & Failure Alert Polish Plan

## Change Categorization
All four changes are approved in-place enhancements/bug fixes triggered from the production log diagnosis of [`GU38OXc-log.txt`](file:///Users/mfattoru/Downloads/GU38OXc-log.txt) and [`w2H4THa-log.txt`](file:///Users/mfattoru/Downloads/w2H4THa-log.txt):
1. **WCG-SDR (`BT.2020` + `bt2020-10` / `bt2020-12` / `bt709` SDR) Support — Feature Addition:**
   - Admits genuine wide-color-gamut SDR sources (such as BT.2020 10-bit anime/mastered SDR without PQ/HLG/dynamic-HDR/mastering/CLL signals) instead of misclassifying/holding them as unrecognized HDR or failing MediaInfo `"BT.2020 (10-bit)"` normalization.
2. **Dolby Vision Profile 8 `dv_bl_signal_compatibility_id === 6` ("Blu-ray / HDR10") Support — Feature Addition:**
   - Admits Dolby Vision Profile 8 (`BL+RPU`, `el_present_flag=0`) with `dv_bl_signal_compatibility_id === 6` alongside `1` only when base-layer HEVC PQ/BT.2020/`tv` metadata and MediaInfo `HDR_Format_Compatibility` containing `HDR10` are independently verified; all unverified `id` values (`0`, `2`, `3`, `4`) and non-HDR10 `id=6` streams remain rejected.
3. **Proactive `libsvtav1` Routing on QSV Green-y Clamp Risk — In-Place Behavioral Change:**
   - Replaces the reactive-only workflow (full `av1_qsv` encode -> strict rejection -> `libsvtav1` retry) with proactive direct routing to `libsvtav1` (`CRF 28`) when `isQsvHdrMasteringClampRisk(hdrSource)` is already known true in preflight, while retaining `validateQsvWithSvtHdrClampFallback` as defense-in-depth (and for any quarantined QSV candidate). Requires updating existing reactive-only assertions in `tests/flow.test.js` and `tests/policy.test.js`.
4. **Failure Notifier & Controlled-Failure Error-Hook Polish — In-Place Hardening:**
   - Adds a dedicated `video_color_signaling` (`[Video guard]`) warning classification in `src/failure_notify.js` so color/transfer/guard holds do not fall through to generic `processing_failure` (`❌ error`).
   - Marks `args.variables.flowFailed = true` in `src/failure_notify.js` once notification delivery has succeeded (or was already recorded), preventing Tdarr's `fail_flow` (`DeNiX Enhanced Fail Flow`) from needlessly invoking `on_flow_error` -> `cleanup_on_error` -> `notify_failure_on_error` after controlled failure cleanup and alerting have already succeeded.

## Files Affected
- [`src/policy.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/policy.js):
  - **WCG-SDR:**
    - Extract/share a canonical SDR transfer normalizer covering `'bt709'`, `'smpte170m'`, `'bt470bg'`, `'bt470m'`, `'gamma22'`, `'gamma28'`, `'smpte240m'`, `'iec6196621'`, plus **`bt2020-10`** (`'bt202010'`, `'bt202010bit'`) and **`bt2020-12`** (`'bt202012'`, `'bt202012bit'`).
    - Update `classifyVideo(video, info)` so `bt2020` primaries/color space alone does NOT set the HDR hint when transfer is an explicit SDR transfer (including `bt2020-10` / `bt2020-12`) and there are no PQ (`smpte2084`), HLG (`arib-std-b67`), ST 2086/2094/2100, `HDR_Format`, mastering display, content light, or dynamic HDR signals. Keep `bt2020` with unknown/missing transfer or any HDR signal as `'unsupported'`.
    - Update `validateMediaInfoHdrColors(video, info)` transfer/matrix/primaries mappings to include `bt202010` / `bt202010bit` -> `'bt2020-10'`, `bt202012` / `bt202012bit` -> `'bt2020-12'`, and standard SDR aliases (`smpte170m`, `bt601`, `bt470bg`, `bt470m`, `gamma22`, `gamma28`, `iec6196621`, `srgb`, `smpte240m`).
    - Update `validateSdrFrameSignaling(basic, scan, sourceVideo)` to continue rejecting frame-level HDR transfers (`smpte2084`, `arib-std-b67`), and allow observed `bt2020` primaries/matrix for verified SDR only when the stream is not a `bt709`/narrow-gamut stream unexpectedly reporting `bt2020` (i.e. when source metadata itself carries `bt2020` or WCG-SDR transfer).
    - Update `effectiveSdrSource(video, info, scan)` fallback map to recognize `bt202010` / `bt202010bit` (`'bt2020-10'`) and `bt202012` / `bt202012bit` (`'bt2020-12'`).
  - **DV8 `id=6`:**
    - Add a single shared helper `isVerifiedHdr10CompatibleDv8(dovi, info)` requiring `dv_profile === 8`, `bl_present_flag === 1`, `el_present_flag === 0`, `rpu_present_flag === 1`, and either `dv_bl_signal_compatibility_id === 1` OR (`dv_bl_signal_compatibility_id === 6` AND `/\bhdr10\b/i.test(String(info?.HDR_Format_Compatibility || ''))`).
    - Use `isVerifiedHdr10CompatibleDv8` uniformly across `preflightHybridHdr`, `preflightDolbyHdrRoute`, and `determineHdrRoute`.
- [`scripts/build.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build.py) (patches over [`src/base/flow-template-v3.json`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/base/flow-template-v3.json)):
  - **WCG-SDR:**
    - Patch `const isHdr = isHlg || isPq || isBt2020 || isDovi;` to `const isHdr = isHlg || isPq || isDovi;` so WCG-SDR (`bt2020` without PQ/HLG/DoVi) is not classified as HDR in template tier sizing or `-color_trc smpte2084` injection.
    - Gate `validateMediaInfoHdrColors(mainVideo, preflightInfoVideo)` so WCG-SDR (`bt2020` color space/primaries/transfer) is also validated against MediaInfo alongside HDR streams.
    - When `!isHdr && hdrClass === "sdr"`, emit explicit `-color_primaries`, `-color_trc`, `-colorspace`, and `-color_range` flags from `sdrSource` whenever those values are explicitly known (non-unknown/unspecified), preserving `bt2020` / `bt2020-10` / `bt2020nc` / `tv` across QSV/FFmpeg encoding and `validateSdrColor`.
    - Pass `mainVideo` as 3rd arg to `validateSdrFrameSignaling(preflightBasic, frameScan, mainVideo)` (and similarly in `src/policy.js` inside `validateOutput`).
  - **Proactive SVT-AV1:**
    - Update `softwareHdrFallback` initialization to `quarantinedCandidate?.kind === "svt_av1_encode" || (!quarantinedCandidate && qsvHdrClampRetryEligible)`.
    - Differentiate logging/mode when `softwareHdrFallback` comes from quarantine revalidation (`"Software SVT-AV1 HDR candidate revalidation"`) vs proactive routing (`"Software SVT-AV1 HDR encode (proactive QSV green-y clamp avoidance)"`).
- [`src/failure_notify.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/failure_notify.js):
  - Add a dedicated `video_color_signaling` (`severity: 'warning'`) branch in `humanizeFailure` for `[Video guard]` color, transfer, aspect ratio, pixel format, and interlaced hold messages so they produce accurate warning embeds without suggesting source corruption or generic error status.
  - Set `args.variables.flowFailed = true` when `user.failure_notified === true` (both after successful webhook delivery and on the already-notified early return), suppressing redundant `on_flow_error` execution after controlled failures while keeping `on_flow_error` retries active if delivery failed.
- **Test Files:**
  - [`tests/policy.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/policy.test.js):
    - Add unit tests for WCG-SDR (`BT.2020` + `bt2020-10`/`bt2020-12` + `BT.2020 (10-bit)` MediaInfo) acceptance and preservation via `validateSdrColor`, plus rejection of `BT.2020` with unknown transfer, contradicting MediaInfo PQ/BT.709, or PQ/HLG/HDR10+ signals.
    - Add unit tests for DV8 `dv_bl_signal_compatibility_id === 6` acceptance with `HDR10` compatibility (and DV8.6 + HDR10+ hybrid) and rejection when `HDR10` compatibility is absent.
    - Update clamp-routing unit coverage if needed while preserving reactive `validateQsvWithSvtHdrClampFallback` tests.
  - [`tests/flow.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/flow.test.js):
    - Update `known Intel QSV HDR mastering clamp...` test to verify proactive SVT-AV1 routing on `qsvHdrClampRetryEligible`, WCG-SDR non-HDR `-color_trc` emission (never `smpte2084`), and reactive fallback retention.
  - [`tests/failure_notify.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/failure_notify.test.js):
    - Add tests for `[Video guard]` color/MediaInfo hold categorization (`warning` embed, accurate file state/action) and `args.variables.flowFailed === true` on successful delivery vs unset on failed/missing delivery.
  - [`tests/integration.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/integration.test.js):
    - Add an end-to-end integration test with a real synthetic `bt2020` + `bt2020-10` WCG-SDR fixture and verify full pass-through encoding, validation, and output color tags (`libsvtav1` mock/transcode path), plus verify controlled failure sets `variables.flowFailed === true` after `notify_failure`.
- [`flow.json`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/flow.json):
  - Rebuild deterministically via `python3 scripts/build.py`.

## Step-by-Step Execution Path (TDD)
1. **Red Phase:**
   - Add failing tests across `tests/policy.test.js`, `tests/failure_notify.test.js`, `tests/flow.test.js`, and `tests/integration.test.js` covering WCG-SDR (`bt2020-10`, MediaInfo `"BT.2020 (10-bit)"`, negative guards), DV8 `id=6` (with and without `HDR10` compatibility), proactive SVT-AV1 green-y routing, `[Video guard]` color humanization, and `flowFailed = true` propagation.
   - Run `npm test` and verify the new assertions fail as expected.
2. **Green Phase:**
   - Implement WCG-SDR and DV8 `id=6` updates in `src/policy.js`.
   - Implement `humanizeFailure` video color/guard classification and `flowFailed = true` propagation in `src/failure_notify.js`.
   - Update `scripts/build.py` for WCG-SDR `isHdr`/color flags/MediaInfo validation and proactive `libsvtav1` routing on `qsvHdrClampRetryEligible`.
   - Regenerate `flow.json` via `python3 scripts/build.py`.
   - Run `npm test` to confirm all tests turn green.
3. **Refactor & Verify:**
   - Review shared helpers (SDR transfer maps, `isVerifiedHdr10CompatibleDv8`) to ensure zero duplication and clean readability.
   - Run `python3 scripts/build.py`, full `npm test` (and check `package.json` for coverage script if present), and `git diff --check`.

---

# V15 Timestamp-Isolated Video Decode Recovery & Null-Muxer Hardening Plan

## Goal
Fix false-negative `video_decode` (`decode_unverified`) holds when a verified candidate MKV preserves pre-existing Matroska packet DTS ties (`candidate.outputDtsNonIncreasingCount <= source.outputDtsNonIncreasingCount`) and FFmpeg's `-f null -` muxer emits non-monotonic DTS warnings (`OMe5KdY`), while hardening `handleNullMuxTimestamp` so unrelated stderr errors cannot be masked by `timestamp-isolated` recovery.

## Change Categorization
- **Bug Fix (Behavior Modification):** Not a new user-facing feature or breaking external API change, though it modifies existing internal `video_decode` acceptance behavior in-place for candidates whose source already contains tied packet DTS values (`outputDtsNonIncreasingCount > 0`).

## Affected Files
1. `src/validation.js`
   - Extract a shared benign-QSV-init line predicate so `isBenignQsvInitializationDiagnostic` and a new `isNullMuxDtsOnlyDiagnostic(text)` helper reuse the same `libva info:` / `driver() returns 0` rules without duplicating logic.
   - In `isNullMuxDtsOnlyDiagnostic(text)`, require at least one `[null @ 0x[0-9a-f]+] Application provided invalid, non monotonically increasing dts to muxer` line and verify every non-empty line matches either a null-muxer DTS warning, a benign QSV initialization line, or the `... diagnostics truncated ...` separator from `runTimelineProcess`.
   - Update `handleNullMuxTimestamp` in `verifyCandidateDecodes` to gate on `isNullMuxDtsOnlyDiagnostic(detail)` (in addition to `!validationDecodeInfrastructure(error)` and `!isCorruption('video')(detail)`) before retrying with `runVideo('timestamp-isolated')`.
2. `scripts/build.py`
   - Update `candidatePacketTimestampsVerified` passed to `verifyCandidateDecodes` inside `verifyVideoTimeline` from:
     `durationHints?.strictCandidateFrames===true && b.totalPackets>0 && b.missingDtsCount===0 && b.outputDtsNonIncreasingCount===0`
     to:
     `durationHints?.strictCandidateFrames===true && a.totalPackets>0 && b.totalPackets>0 && b.missingDtsCount===0 && b.outputDtsNonIncreasingCount<=a.outputDtsNonIncreasingCount`
     (safe because `validateVideoPacketDts(a,b)` has already enforced `b.outputDtsNonIncreasingCount <= a.outputDtsNonIncreasingCount`, and `strictCandidateFrames === true` has verified strictly increasing finite PTS across every decoded frame).
3. `tests/validation.test.js`
   - Add unit tests for `verifyCandidateDecodes` covering:
     - QSV `libva info:` + `[null @ 0x...]` DTS lines recovering cleanly via `timestamp-isolated` when `candidatePacketTimestampsVerified: true`.
     - Mixed diagnostics containing a `[null @ 0x...]` DTS line alongside an unrecognized non-corruption error line NOT falling back to `timestamp-isolated`.
4. `tests/integration.test.js`
   - Add an integration test verifying a source and candidate with matched non-zero DTS ties (`outputDtsNonIncreasingCount > 0`, `strictCandidateFrames === true`) where QSV `-f null -` emits `libva info:` + `[null @ 0x...]` DTS warnings recovers via `timestamp-isolated` decode and approves the candidate.
5. `flow.json`
   - Regenerate deterministically via `python3 scripts/build.py`.

## Step-by-Step Execution Path (TDD)
1. **Red (Failing Tests First):**
   - Add the new unit tests in `tests/validation.test.js` and integration test in `tests/integration.test.js`.
   - Run `npm test` and confirm the new tests fail for the expected reasons.
2. **Green (Minimal Implementation):**
   - Implement `isNullMuxDtsOnlyDiagnostic` (sharing line predicates with `isBenignQsvInitializationDiagnostic`) and wire it into `handleNullMuxTimestamp` in `src/validation.js`.
   - Update `candidatePacketTimestampsVerified` in `scripts/build.py`.
   - Run `python3 scripts/build.py` and `npm test` to confirm all tests pass.
3. **Refactor & Verify:**
   - Ensure helper predicates are concise, non-duplicated, and handle truncated diagnostic banners cleanly.
   - Run `python3 scripts/build.py`, `npm run test:coverage`, and `git diff --check`.

---

# V15 Quarantined DTS-Tie Verification & MBAFF Progressive Field-Order Plan

## Goal
Resolve two independent failures observed in [`BvDiJPV-log.txt`](file:///Users/mfattoru/Downloads/BvDiJPV-log.txt) (*How to Train Your Dragon (2025) Bluray-2160p.mkv*) and [`hucUFsn-log.txt`](file:///Users/mfattoru/Downloads/hucUFsn-log.txt) (*Stick Man (2015) Remux-1080p.mkv*):
1. **`BvDiJPV-log.txt` (`decode_unverified` despite matched DTS & passed `frames` stage):** Align `strictCandidateFrames` in candidate timeline validation with `compareVideoTimestamps` so candidates whose frame PTS passed `compareVideoTimestamps` and whose packet DTS passed `validateVideoPacketDts` (`missingDtsCount === 0`, `outputDtsNonIncreasingCount <= source.outputDtsNonIncreasingCount`) can recover via `timestamp-isolated` decode instead of short-circuiting on strict monotonicity (`value > all[index - 1]`).
2. **`hucUFsn-log.txt` (`Output has interlaced field order` on progressive MBAFF source):** Route sources with verified-progressive decoded frames (`frameScan.interlaced === 0`) and interlaced stream `field_order` tags (`tt`/`bb`/`tb`/`bt`) through Hybrid CPU decode (`setfield=mode=prog`) + explicit progressive container/encoder signaling (`-field_order progressive`), and retire stale quarantined candidates that previously failed with `Output has interlaced field order`.

## Change Categorization
- **Bug Fix (Behavior Modification):** Modifies existing in-place behavior in two areas:
  1. `strictCandidateFrames` in candidate `video_decode` recovery accepts any candidate whose frame timestamps already passed `compareVideoTimestamps` rather than rejecting source-matched ties / 2 ms quantization ties / single recovered glitches.
  2. Sources carrying interlaced container/stream `field_order` metadata (`tt`/`bb`/`tb`/`bt`) with `frameScan.interlaced === 0` are encoded via Hybrid CPU decode (`setfield=mode=prog`) with `-field_order progressive`, and stale quarantined candidates that failed for `Output has interlaced field order` are retired for fresh encode instead of endlessly revalidating an interlaced-tagged output.

## Affected Files
1. `src/policy.js`
   - Extract `isInterlacedFieldOrderTag(video)` (returning `true` when `field_order` is non-empty and not in `['progressive', 'unknown']`) and reuse it inside `validateAspect(..., checkOutputFieldOrder = true)` so validation and encoding share one predicate.
   - Add `hasVerifiedCandidateFrameTimestamps(sourceScan, outputScan)` wrapping finite-array checks and `compareVideoTimestamps(sourceScan, outputScan)` cleanly without swallowing corrupt/missing scans.
   - Extend `composeVideoFilterChain(baseFilter, options)` with `options.normalizeProgressiveFieldOrder` to prepend `setfield=mode=prog` before pixel-format / HDR metadata filters in CPU/Hybrid filter chains.
   - Export `hasVerifiedCandidateFrameTimestamps` and `isInterlacedFieldOrderTag` in the policy test exports.
2. `scripts/build.py`
   - Update `strictCandidateFrames` passed from `verifyVideoTimeline` into `verifyCandidateDecodes` to use `hasVerifiedCandidateFrameTimestamps(expected.sourceFrameScan, outputFrameScan)`.
   - Include `isInterlacedFieldOrderTag(mainVideo)` in `needsProactiveHybrid` so H.264/HEVC MBAFF/PAFF progressive streams tagged `tt`/`bb`/`tb`/`bt` decode on CPU and normalize frames via `setfield=mode=prog`.
   - Pass `normalizeProgressiveFieldOrder: (useHybrid || useSoftwareFallback) && isInterlacedFieldOrderTag(mainVideo)` to `composeVideoFilterChain(...)` and push `"-field_order", "progressive"` to `cmdArgs` on non-copy encodes (`!doCopyVideo`).
   - When `findQuarantineCandidate` returns an entry rejected for `'Output has interlaced field order'` (or whose video stream probes as `isInterlacedFieldOrderTag(...)`), call `removeQuarantineCandidate(quarantinedCandidate)`, log retirement, and clear `quarantinedCandidate` prior to the fresh-encode GPU device check so stale interlaced-tagged candidates re-encode cleanly.
3. `tests/policy.test.js`
   - Add unit tests for `isInterlacedFieldOrderTag`, `hasVerifiedCandidateFrameTimestamps` (including `compareVideoTimestamps`-permitted source PTS ties, sub-frame quantization ties, single isolated glitches on >=1000 frames, and rejected regressions/missing scans), and `composeVideoFilterChain(..., { normalizeProgressiveFieldOrder: true })`.
   - Add a real-FFmpeg regression test (skipped cleanly if FFmpeg is unavailable) encoding an interlaced-tagged H.264 stream with `setfield=mode=prog` + `-field_order progressive` and asserting `field_order === 'progressive'`.
4. `tests/integration.test.js`
   - Add integration/structural tests verifying:
     - Candidates with matched non-zero packet DTS (`1560 <= 1560`, `missingDtsCount === 0`) and `compareVideoTimestamps`-verified frame PTS ties satisfy `strictCandidateFrames` / `candidatePacketTimestampsVerified` and recover via `timestamp-isolated` decode.
     - Generated `flow.json` routes `isInterlacedFieldOrderTag(mainVideo)` sources through Hybrid `setfield=mode=prog` + `-field_order progressive` and retires quarantined candidates rejected for `Output has interlaced field order`.
5. `flow.json`
   - Regenerate deterministically via `python3 scripts/build.py`.

## Step-by-Step Execution Path (TDD)
1. **Red (Failing Tests First):** Add failing unit & integration tests in `tests/policy.test.js` and `tests/integration.test.js` covering both fixes, run `npm test`, and confirm the new tests fail as expected.
2. **Green (Minimal Implementation):** Implement the helpers/updates in `src/policy.js` and `scripts/build.py`, rebuild `flow.json` via `python3 scripts/build.py`, and run `npm test` to confirm all tests pass.
3. **Refactor & Verify:** Confirm zero duplicated predicates across validation and encoder pipelines, then run `python3 scripts/build.py`, `npm run test:coverage`, and `git diff --check`.

---

# V15 Stage-Scoped Cache & Partial Invalidation Plan (`precheck`, `encode`, `candidate_frames`, `decode`)

## Goal
Replace the single monolithic engine hash (`__PRECHECK_ENGINE_HASH__`) and candidate-coupled `.prechecks.gz` storage with deterministic **stage-scoped signatures** (`sourceVideoPrecheck`, `sourceAudioPrecheck`, `encode`, `candidateFrames`, `decode`) so each cached stage invalidates only when its own logic, tool version, or inputs change — preventing validation/post-check fixes (like `OMe5KdY` -> `gC0GSzW`) or notification edits from triggering redundant 72-minute source frame scans, 40-minute encodes, or 66-minute candidate frame scans, and allowing encode fixes to retire stale candidates without discarding valid source prechecks.

## Change Categorization
- **Feature Addition + In-Place Cache/Invalidation Behavior Modification:** Adds stage-scoped build fingerprints, source-scoped precheck caching, and candidate frame-scan caching, and updates quarantine reuse/invalidation behavior in-place while maintaining backward compatibility with existing on-disk `version: 1` quarantine manifests and `precheck_cache.js` helper APIs.

## Architectural Design
1. **Build-Time Stage Signature Partitioning (`scripts/stage_signatures.py` + `scripts/build.py`)**
   - Compute 5 independent SHA-256 build hashes injected into the monolithic plugin:
     - `__PRECHECK_VIDEO_CODE_HASH__`: Source frame/HDR/color precheck helpers in `src/policy.js` (`inspectVideoFrames`, `buildFrameScanArguments`, `recordHdrFrame`, `collectHdrFrameStatic`, `classifyVideo`, `preflightHybridHdr`, `preflightDolbyHdrRoute`, `determineHdrRoute`, `mergeHdrMetadata`, Dolby Level 6/9 extraction, `validateSdrFrameSignaling`, `inferUntaggedColorRange`, corruption/infra diagnostic matchers, etc.), `src/precheck_cache.js` source-evidence schema, and the source-scan invocation block in `scripts/build.py`.
     - `__PRECHECK_AUDIO_CODE_HASH__`: `src/audio_timing.js` order/repair analysis and retained-audio precheck runner in `scripts/build.py`.
     - `__ENCODE_CODE_HASH__`: `src/progress.js` (`runSingleQuality`), encoder/filter/quality/HDR-route helpers in `src/policy.js` (`composeVideoFilterChain`, `useQsvDecode`, `isInterlacedFieldOrderTag`, `isQsvHdrMasteringClampRisk`, `untaggedColorRangeArgs`, `selectQualityValue`, `mustRetainOriginalAtQualityFloor`, etc.), ASS normalization & audio repair BSF (`src/subtitle_timing.js`, `src/audio_timing.js`), and the FFmpeg command/route builder (`needsProactiveHybrid`, `runFfmpeg`, seek-heal fallback) in `scripts/build.py` + `scripts/build_additions.py`.
     - `__CANDIDATE_FRAMES_CODE_HASH__`: `inspectVideoFrames` + frame HDR/color parsing in `src/policy.js` and the candidate frame-scan block inside `validateOutput`.
     - `__DECODE_CODE_HASH__`: `src/validation.js`, `src/pgs.js`, `validateCopiedSubtitlePackets` (`src/subtitle_timing.js`), output comparison/aspect/HDR/SDR validators in `src/policy.js` (`compareVideoTimestamps`, `hasVerifiedCandidateFrameTimestamps`, `validateAspect`, `validateHdr10`, `validateHlg`, `validateSdrColor`, `validateUntaggedOutput`, `shouldRetrySvtForQsvHdrClamp`, etc.), and `validateOutput` / `verifyVideoTimeline` / `validationStage` wrappers in `scripts/build.py`, `scripts/build_additions.py`, and `scripts/build_validation.py`.
   - **Completeness Guard:** Parse top-level declarations in `src/policy.js` and `src/subtitle_timing.js` during `build.py` and fail the build if any declaration is unmapped; shared helpers belong to every consumer stage set so edits invalidate all affected stages automatically without manual version bumps.

2. **Stage-Scoped Precheck & Candidate-Frame Evidence (`src/precheck_cache.js` + `src/quarantine.js`)**
   - **Source Precheck Storage (`<sourceKey>-<sourceHash>.prechecks.gz`):**
     - Key source evidence by canonical `(quarantineRoot, sourcePath, sourceHash)` rather than binding its filename to `<candidateId>.mkv`, while preserving fallback read/cleanup of legacy `${candidatePath}.prechecks.gz` and preserving existing `savePrecheckCache`/`loadPrecheckCache`/`removePrecheckCache` signatures.
     - Store `videoSignature` (`{ codeHash, node, ffprobe, video, mediaInfo }`) and `audioSignature` (`{ codeHash, node, ffprobe, ffmpeg, streams }`) independently inside the signed payload so an audio-only change re-runs only `[Audio precheck]` while reusing `frameScan`, and a video-only precheck change re-runs `frameScan` cleanly.
     - Expose structured miss reasons (`missing`, `corrupt`, `source_hash_changed`, `video_signature_changed`, `audio_signature_changed`) so Tdarr job logs explicitly state why prechecks were reused or re-run.
     - Keep `.prechecks.gz` tied to quarantined/retired-quarantine lifecycle so non-quarantined one-off failures never leave orphaned cache files, and clean up `<sourceKey>-<sourceHash>.prechecks.gz` on both replacement success (`cleanup_success`) and `arc_force_fresh_path`.
   - **Candidate Frame Scan Storage (`${candidatePath}.frames.gz`):**
     - Store verified `outputFrameScan` alongside the candidate `.mkv`, keyed by `(candidateHash, candidateFramesSignature)` (including `__CANDIDATE_FRAMES_CODE_HASH__`, `ffprobe` version, and scan-relevant HDR/untagged/copy flags), guarded by the same SHA-256 + bounded gzip integrity checks.
     - Reuse `outputFrameScan` when valid so post-check fixes (e.g., `src/validation.js`, `compareVideoTimestamps`, `pgs.js`) skip the 66-minute candidate `ffprobe -show_frames` pass while still running all fast header/metadata/timestamp/HDR assertions live (`stream_probe`, `video_stream`, `hdr_color`, `streams`, `replacement_readiness`).

3. **Quarantine Manifest `stageSignatures` & Action Matrix (`src/quarantine.js`, `scripts/build.py`, `scripts/build_additions.py`)**
   - Extend quarantine manifest `version: 1` with optional `stageSignatures: { encode, candidateFrames, decode }` (validated if present; legacy manifests without `stageSignatures` remain valid and continue using structural compatibility checks).
   - Update `updateQuarantineFailure(entry, validationReport, stageSignatures?)` so `stageSignatures` are refreshed after each validation run.
   - Runtime invalidation behavior on quarantine hit:
     - **`encode` invalidated (`manifest.stageSignatures?.encode` present and `!== currentEncodeSignature`, or legacy structural incompatibility):**
       Log the exact reason, retire/remove ONLY the candidate (`.mkv`, `.json`, `.frames.gz`), **preserve** valid `<sourceKey>-<sourceHash>.prechecks.gz` (migrating legacy `${candidatePath}.prechecks.gz` first if needed), reuse valid `frameScan`/audio precheck, and run fresh encode + validation.
     - **`encode` valid, `precheck` (video and/or audio) invalidated:**
       Re-run only the invalidated source precheck sub-stage(s), re-check preflight/encode compatibility with the refreshed source scan (`frameScan` / `audioTimestampRepairs`), keep the quarantined `.mkv` if `encodeSignature` still matches, and proceed to candidate validation.
     - **`encode` valid, `candidateFrames` valid, only `decode`/post-checks or notifications changed:**
       Reuse source `frameScan` + `audio` precheck, reuse quarantined `.mkv`, reuse `outputFrameScan` (`${candidatePath}.frames.gz`), log the per-stage reuse/invalidation summary, and run fast checks + live `timelines` / `video_decode` / `audio_decode` / `replacement_readiness`.
     - **`candidateFrames` invalidated:**
       Reuse source prechecks + quarantined `.mkv`, skip stale `.frames.gz`, run live candidate `inspectVideoFrames` + live downstream validation, and refresh `.frames.gz`.

## Files Affected
- [`scripts/stage_signatures.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/stage_signatures.py) (new): Stage symbol mapper, completeness verifier, and per-stage code hash builder.
- [`scripts/build.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build.py): Replace monolithic `__PRECHECK_ENGINE_HASH__` with stage-scoped hashes; compute runtime `sourceVideoSignature`, `sourceAudioSignature`, `encodeSignature`, `candidateFramesSignature`, `decodeSignature`; handle partial quarantine retirement/reuse + clear diagnostic logging.
- [`scripts/build_additions.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build_additions.py): Wire candidate `.frames.gz` load/save in `validateOutput` (`frames` stage) and clean `<sourceKey>-<sourceHash>.prechecks.gz` + `.frames.gz` in `cleanup_success`.
- [`scripts/build_validation.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build_validation.py): Preserve stage boundary telemetry and pass `stageSignatures` into quarantine storage/update.
- [`src/precheck_cache.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/precheck_cache.js): Support split video/audio source precheck signatures, source-scoped `<sourceKey>-<sourceHash>.prechecks.gz` path + legacy fallback/migration, structured miss reasons, and candidate frame-scan cache (`${candidatePath}.frames.gz`).
- [`src/quarantine.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/quarantine.js): Validate optional `stageSignatures` in manifests, update via `updateQuarantineFailure`, preserve valid source precheck on single-candidate retirement (`removeQuarantineCandidate({ keepSourcePrecheck: true })` or source-scoped file independence), and purge `.prechecks.gz` + `.frames.gz` in `removeQuarantineCandidatesForSource`.
- [`tests/precheck_cache.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/precheck_cache.test.js): Unit tests for independent video vs audio precheck invalidation, miss reason reporting, source-scoped path reuse across candidate retirement, and candidate `.frames.gz` caching/tamper rejection.
- [`tests/quarantine.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/quarantine.test.js): Unit tests for optional `stageSignatures` validation, legacy manifest compatibility, `updateQuarantineFailure` signature updates, and `removeQuarantineCandidatesForSource` cleanup of `.prechecks.gz` and `.frames.gz`.
- [`tests/integration.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/integration.test.js) (plus Python build-hash isolation check): Integration tests simulating:
  1. Post-check (`src/validation.js`) edit only -> precheck (`video` & `audio`), encode, and candidate `frames` are all reused while `video_decode` runs live.
  2. Candidate-frames logic edit only -> source precheck & encode reused, candidate `frames` re-runs.
  3. Encode-only edit (`encodeSignature` changed) -> old candidate retired, source `precheck` preserved & reused, fresh encode + validation run.
  4. Audio-precheck-only change -> source `frameScan` reused, `[Audio precheck]` re-runs.
- [`flow.json`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/flow.json): Rebuilt deterministically via `python3 scripts/build.py`.

## Step-by-Step Execution Path (TDD)
1. **Red Phase (Failing Tests First):**
   - Add failing tests in `tests/precheck_cache.test.js`, `tests/quarantine.test.js`, and `tests/integration.test.js` covering split video/audio source precheck signatures, source-scoped precheck retention across candidate retirement, candidate `frames` caching, `encodeSignature`-driven candidate retirement, and build-time stage hash isolation.
   - Run `npm test` and confirm the new tests fail as expected.
2. **Green Phase (Implementation):**
   - Implement `scripts/stage_signatures.py` with completeness validation over `src/policy.js` and `src/subtitle_timing.js`.
   - Extend `src/precheck_cache.js` and `src/quarantine.js` cleanly without duplicating hash/integrity validation helpers.
   - Update `scripts/build.py`, `scripts/build_additions.py`, and `scripts/build_validation.py` to wire stage signatures, reuse/retire actions, candidate-frame caching, cleanup, and diagnostic logging.
   - Rebuild `flow.json` via `python3 scripts/build.py` and run `npm test`.
3. **Refactor & Verify:**
   - Review shared cache envelope/path helpers for zero duplication and clear docstrings/comments.
   - Run `make check` (`python3 scripts/build.py && npm run test:coverage && git diff --check`) and confirm 100% pass rate with zero failures or skipped assertions.

---

# V15 Dolby Vision Profile 5 VUI-Omitted Full-Range (`tv` Fallback + RPU Range Guard)

## Change Categorization
- **In-Place Behavioral Fix (`isVerifiedDolbyProfile5Config` + RPU Range Preflight):**
  - Previously, `isVerifiedDolbyProfile5Config` required FFprobe `video.color_range === 'pc'`. However, real-world Dolby Vision Profile 5 MKVs whose HEVC SPS omits VUI signal flags (`video_signal_type_present_flag = 0`, observed in *Avengers: Infinity War (2018)* and *Supergirl (2026)*) cause FFmpeg's HEVC decoder (`export_stream_params`) to default `color_range` to `'tv'` while MediaInfo omits `colour_range`, even though the Dolby RPU confirms full-range IPT-PQ-c2 (`bl_video_full_range_flag = 1`).
  - Testing with `framemd5` inside `tdarr-flow-live-test-20261102` confirmed `libplacebo=apply_dolbyvision=true` uses the Dolby RPU's `bl_video_full_range_flag = 1` identically regardless of whether FFprobe/AVFrame carries `tv` or `setparams=range=pc`.
  - Keep strict rejection whenever MediaInfo explicitly tags `colour_range`/`color_range` as non-unknown when `video.color_range === 'tv'` (both `'Full'` conflicts and `'Limited'` genuine limited-range bitstreams), and verify opening-frame RPU metadata carries `vdr_rpu_profile === 0` and `bl_video_full_range_flag === 1` before admitting `dovi5_hdr10`.

## Files Affected
- [`src/policy.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/policy.js):
  - Update `isVerifiedDolbyProfile5Config` to admit `video.color_range === 'tv'` only when MediaInfo `colour_range`/`color_range` is unknown/absent (`isUnknownColorValue`).
  - Add `verifyDolbyProfile5RpuFullRange(frames)` to assert opening decoded frames carry `Dolby Vision Metadata` with `vdr_rpu_profile === 0` and `bl_video_full_range_flag === 1`.
- [`scripts/build.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build.py):
  - Call `verifyDolbyProfile5RpuFullRange(readHdrFrames(ffprobeBin,inputPath,mainVideo.index))` inside the `dovi5_hdr10` preflight branch before `extractDolbyProfile5HdrMetadata`.
- [`scripts/stage_signatures.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/stage_signatures.py):
  - Map `verifyDolbyProfile5RpuFullRange` to `("precheck_video",)`.
- [`tests/flow_test_runtime.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/flow_test_runtime.js), [`tests/policy.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/policy.test.js), [`tests/flow.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/flow.test.js): TDD unit and flow-wiring tests.
- [`docs/architecture/FAILURE_DIAGNOSTICS.md`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/docs/architecture/FAILURE_DIAGNOSTICS.md) & [`flow.json`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/flow.json): update documented Profile 5 range rule and rebuild flow export.

## Step-by-Step Execution Path (TDD)
1. **Red Phase**: Add failing tests in `tests/policy.test.js` and `tests/flow.test.js` (and export hook in `tests/flow_test_runtime.js`); run `make test` to observe expected failures.
2. **Green Phase**: Implement `isVerifiedDolbyProfile5Config` + `verifyDolbyProfile5RpuFullRange` in `src/policy.js`, wire into `scripts/build.py`, register in `scripts/stage_signatures.py`, update docs, and run `make build`.
3. **Verify**: Run `make check` (`make build` + `coverage` + `git diff --check`) and verify preflight/metadata checks read-only against both Profile 5 MKVs in `tdarr-flow-live-test-20261102`.

## V16 Execution Plan: In-Place Support for Remaining Unsupported Formats (Categories A, B, C, D)

### Scope & Classification
- **Change type:** In-place behavior expansion (feature additions & bugfixes within existing `precheck_video`, `encode`, and `candidate_frames` stages — approved by user).
- **Affected files:**
  - `src/policy.js`
  - `scripts/stage_signatures.py`
  - `scripts/build.py`
  - `flow.json` (generated)
  - `tests/flow_test_runtime.js`, `tests/policy.test.js`, `tests/flow.test.js`, `tests/integration.test.js`
  - `docs/architecture/CODEC_COVERAGE.md`, `docs/plans/IMPLEMENTATION_LOG.md`

### 4 Categories Implemented In-Place
1. **Category A — PAL/NTSC SDR `BT.470 System B/G` & `System M`:**
   - Normalize `"BT.470 System B/G"`, `"BT.470 System B, G"`, `"BT.470 System M"` in `normalizeColorToken` / `normalizeSdrMatrix` and prevent `/` in `"System B/G"` from splitting in `validateMediaInfoHdrColors`.
   - Accept `bt470m` primaries (`colour_primaries`) and map `bt470m` matrix coefficients to `smpte170m`.
2. **Category B — Native HLG without `HDR_Format`:**
   - In `determineHdrRoute`, admit HLG (`arib-std-b67` + `bt2020` + `bt2020nc` + `tv`) when `mediaInfoHdrText(info)` is empty and MediaInfo `transfer_characteristics` (or `_Original`) normalizes to `hlg` or `aribstdb67`, while continuing to reject HLG streams with conflicting non-HLG `HDR_Format` headers.
3. **Category C — Full-Range (`pc`) HDR10 / HDR10+ & Absent/`0,0` CLL on `hdr10plus_hdr10`:**
   - Add `isVerifiedHdrColorRange(video, info, allowFullRange=false)` allowing `'tv'`, or `'pc'` when both `ffprobe` (`color_range: 'pc'`) and MediaInfo (`colour_range`/`color_range: 'Full'`) agree on non-Dolby `hdr10` / `hdr10plus_hdr10`.
   - In `resolveHdrLight` and `scripts/build.py`, strip `0,0` or absent `Content light level metadata` cleanly on `hdr10plus_hdr10` (matching `hdr10` without invoking Dolby Level 6).
   - Drive `checkHdrFrameStatic` `requireLight`/`requireMastering` flags via `hdrFrameMetadataRequirements(hdrSource, hdrClass === "hdr10")` (or equivalent) so missing CLL does not fail per-frame static checks, and emit `-color_range pc` when `hdrSource?.color_range === "pc"`.
4. **Category D — Explicit SDR Streams with Orphan HDR Side Data:**
   - **D1 (`orphan_dovi_sdr`):** Explicit `bt709`/`bt709`/`bt709`/`tv` (both `ffprobe` & `mediainfo`) carrying a stale Matroska `DOVI configuration record` with 0 frame-level RPU packets (`hasFrameDolbyRpu`). Preflight returns `'orphan_dovi_sdr'`; after full-stream frame scan confirms zero `dovi`, `hdr10plus`, and `otherDynamic` frames, classify as `hdrClass = "sdr"` (`isHdr = false`), strip `DOVI_METADATA` via `composeVideoFilterChain`, and verify output has no Dolby Vision metadata.
   - **D2 (`isSdrWithOrphanStaticHdr`):** Explicit `bt709`/`bt709`/`bt709`/`tv` carrying leftover `SMPTE ST 2086` / mastering display / content light metadata with `dovi === 0, hdr10plus === 0, otherDynamic === 0`. Classify as `hdrClass = "sdr"` (`isHdr = false`), strip `MASTERING_DISPLAY_METADATA` and `CONTENT_LIGHT_LEVEL`, and verify output has no static HDR or dynamic HDR metadata.

### Verification Plan
1. TDD Red phase: add exports and failing unit/flow/integration tests; run `npm test` to confirm failures.
2. TDD Green phase: implement changes across `src/policy.js`, `scripts/stage_signatures.py`, `scripts/build.py`; rebuild `flow.json`; verify `python3 scripts/stage_signatures.py --check-isolation` and `make check` (>=90% coverage).
3. Live container tests inside `tdarr-flow-live-test-20261102:/test` covering all 4 categories on copied/clipped media samples, verify output streams (`ffprobe` + `mediainfo`), clean up container scratch clips and host `/tmp` files, and re-run `make check`.

---

# V16.1 Execution Plan: Original Guard Handling for `ctime`-Only Inode Changes (Hardlink Unlink / Metadata Updates)

## Change Categorization
- **In-Place Behavioral Fix (Existing Guard Contract Update):**
  - Currently, `assertOriginalUnchanged()` inside `arc_av1_monolithic` and `original_recheck` treat any `ctimeNs` change identically to file replacement unless `dev` or `ino` also changed (`identityMoved` for Unraid Mover).
  - As observed on *Watchmen (2009) WEBDL-2160p.mkv* (83.88 GB, `dev: 49`, `ino: 13229323913204474`), removing a sibling hardlink (`nlink: 2 -> 1`, e.g., torrent seeding cleanup) updates `ctime` on the inode without modifying `realPath`, `dev`, `ino`, `size`, `mtime`, or any media bytes, causing a false-positive `[Original guard]` failure after a 46-minute scan.
  - Because existing guard behavior changes (previously aborted on `ctime`-only changes; proposed behavior allows `ctime`-only metadata changes when the inode and stable metadata are unchanged), confirm whether to update in-place or gate behind a variable/flag.

## Architectural Review
- **Files Affected:**
  - [`src/source_identity.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/source_identity.js): add shared `diffOriginalSnapshot(saved, currentStat, currentRealPath)` helper returning `{ changed, sameStableMetadata, identityMoved, ctimeOnly }` (handling both `bigint` in-engine snapshots and stringified `args.variables.user.original_snapshot` fields) so snapshot diff logic is not duplicated across engine and `original_recheck`.
  - [`scripts/build.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build.py):
    - Update `assertOriginalUnchanged()` to call `diffOriginalSnapshot(...)`. When `ctimeOnly` holds (`realPath`, `dev`, `ino`, `size`, `mtimeNs` unchanged; only `ctimeNs` changed), verify `originalGuardFd` (`fstatSync`) still matches `(dev, ino, size, mtimeNs)` when open, refresh `originalSnapshot` and `args.variables.user.original_snapshot.ctimeNs` via `saveOriginalSnapshot(current, realPath)` (preserving any prior `contentHash`), log the metadata-only `ctime` event, and return without aborting. Keep byte-for-byte verification (`compareOpenFileToPath`) for `identityMoved && sameStableMetadata` and fail closed on any `path`, `size`, `mtime`, FD mismatch, or byte mismatch.
    - Update `original_recheck` to call `diffOriginalSnapshot(...)`. When `ctimeOnly` holds, update `saved.ctimeNs` in `args.variables.user.original_snapshot`, log the metadata-only `ctime` event, and proceed with `outputNumber: 1`. When `identityMoved && sameStableMetadata`, continue requiring an existing `saved.contentHash` and matching `hashFilePath(original)`.
  - [`docs/architecture/FAILURE_DIAGNOSTICS.md`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/docs/architecture/FAILURE_DIAGNOSTICS.md): document that `ctime`-only inode changes with identical `realPath`/`dev`/`ino`/`size`/`mtime` are tolerated while content/size/mtime/unhashed-inode changes remain rejected.
  - [`flow.json`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/flow.json): rebuilt output via `python3 scripts/build.py`.
  - Tests: [`tests/source_identity.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/source_identity.test.js), [`tests/source_identity_flow.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/source_identity_flow.test.js), [`tests/integration.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/integration.test.js).
- **API / Data Model Updates:**
  - `src/source_identity.js` exports `diffOriginalSnapshot` alongside `compareOpenFileToPath` and `hashFilePath`.
  - `args.variables.user.original_snapshot.ctimeNs` is updated in-place when a `ctime`-only change is accepted (schema unchanged).

## Step-by-Step Execution Path (TDD)
1. **Red Phase (Failing Tests First):**
   - Add unit tests in `tests/source_identity.test.js` covering `diffOriginalSnapshot` for unchanged, `ctimeOnly`, `identityMoved`, and `size`/`mtime`/`path` drift.
   - Add `original_recheck` flow test in `tests/source_identity_flow.test.js` verifying a `ctime`-only change (`chmod`/sibling hardlink unlink with identical `dev`, `ino`, `size`, `mtime`) passes without needing `contentHash`, while `size`/`mtime`/unhashed-inode changes still fail.
   - Add integration test in `tests/integration.test.js` simulating a sibling hardlink unlink (`nlink: 2 -> 1`, `ctime` bump, same `dev`/`ino`/`size`/`mtime`) during source scan and confirming the job completes (`outputNumber: 1`) and refreshes `ctimeNs`.
   - Run `npm test` to observe expected failures before modifying `src/` or `scripts/`.
2. **Green Phase (Implementation & Build):**
   - Implement `diffOriginalSnapshot` in `src/source_identity.js`.
   - Update `assertOriginalUnchanged()` and `original_recheck` in `scripts/build.py` to use `diffOriginalSnapshot`.
   - Update `docs/architecture/FAILURE_DIAGNOSTICS.md`.
   - Run `python3 scripts/build.py` to regenerate `flow.json`.
3. **Refactor & Verification:**
   - Review `src/source_identity.js` and `scripts/build.py` for zero duplicated diff logic, concise docstrings, and edge-case FD checks.
   - Run `make check` (`python3 scripts/build.py && npm run test:coverage && git diff --check`) and verify all tests pass with >= 90% coverage.

---

# V16.2 Execution Plan: Preserve Millisecond Video Presentation Timestamps on Arc QSV & SVT-AV1 Encodes

## Change Categorization
- **In-Place Bugfix / Behavioral Change (Encoder Filter & Timebase Args + Encode Signature Coverage):**
  - Currently, non-copy encodes pass `-fps_mode:v passthrough` with default `-enc_time_base:v 0` (`1/fps` = `1001/24000`) and route QSV-decoded streams through `vpp_qsv` / `vpp_qsv=format=p010`.
  - Live testing on `tdarr-flow-live-test-20261102` established both are responsible for `video_timestamp_order_changed` rejections on half-frame-offset (`+21 ms`) Matroska sources (*The Eminence in Shadow - S01E16*, `Po2VdJH`):
    - **Full `S01E16` (34,047 frames) live check** with `hwmap=derive_device=vaapi:reverse=1,scale_vaapi=format=p010,hwmap=derive_device=qsv` and `-enc_time_base:v 1:1000`: finished in `61s` at `259,199,513` bytes (vs `259,199,564` bytes in `WkNgZd5`), `srcFrames: 34047 -> outFrames: 34047`, **`ties: 0`**, **`backwards: 0`**, **`maxDrift: 0.000000s`**, **`FULL_DTS_NONINC: 0`**, and clean full timestamp-isolated CPU video decode + audio decode.
    - **10-bit `sidedata`-only check** verified `sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL` runs directly on 10-bit QSV hardware frames without `vpp_qsv` or `hwmap`.
    - **Stage-signature audit** revealed that `runFfmpeg`, `baseVideoFilter`, `vpp_qsv`, and `-fps_mode:v` sat *outside* `// [STAGE:encode:start] ... // [STAGE:encode:end]` in `flow.json` (`STAGE:encode` only spanned indices `262938..269441`). Without fixing encode-stage hash coverage too, `Po2VdJH`'s already-quarantined broken candidate would match `stageSignatures.encode` and fail revalidation instead of retiring and re-encoding.
  - Note on behavior scope: replacing `vpp_qsv` with `hwmap=derive_device=vaapi:reverse=1,scale_vaapi=format=p010,hwmap=derive_device=qsv` (for 8-bit QSV) / omitting `vpp_qsv` pass-through (for 10-bit QSV) and adding `-enc_time_base:v 1:1000` assumes VAAPI-derived QSV (`/dev/dri/renderD129` `vaapi=va:...` -> `qsv=hw@va`) and Matroska millisecond (`1:1000`) output containers. Confirm whether to update this in-place or gate behind a flow/library flag.

## Architectural Review
- **Files Affected:**
  - [`src/policy.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/src/policy.js):
    - Update `composeVideoFilterChain(baseFilter, options)` to handle empty/null `baseFilter` safely (`filters.filter(Boolean).join(',')`, returning `''` when no filter applies).
    - Add shared `buildVideoEncodeFilterChain({ hdrClass, is10Bit, useHybrid, useSoftwareFallback, normalizeProgressiveFieldOrder, removeHdr10Plus, removeContentLight, removeMasteringDisplay, removeDoviMetadata })` helper returning `''` when no `-vf` is needed (10-bit QSV pass-through without metadata/field filters), `sidedata=...` directly when 10-bit QSV only needs side-data deletion, or `hwmap=derive_device=vaapi:reverse=1,scale_vaapi=format=p010,hwmap=derive_device=qsv` (with any prepended `sidedata` filters) for 8-bit QSV -> 10-bit `p010` while keeping `dovi5_hdr10` (`libplacebo`), `useHybrid` (`format=p010le`), and `useSoftwareFallback` (`format=yuv420p10le`) intact.
  - [`scripts/stage_signatures.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/stage_signatures.py):
    - Register `buildVideoEncodeFilterChain` in `SYMBOL_STAGE_MAP["policy.js"]` under `("encode",)`.
    - Verify `--check-isolation` passes and edits to encode filters/timebase change `STAGE_CODE_HASHES.encode` without changing `precheck_video` or `precheck_audio`.
  - [`scripts/build.py`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/scripts/build.py):
    - Pass `-enc_time_base:v 1:1000` alongside `-fps_mode:v passthrough` when `!doCopyVideo` (`av1_qsv`, `libsvtav1` fallback, `dovi5_hdr10`, `useHybrid`; keep `doCopyVideo` unchanged).
    - Replace inline `vpp_qsv` / `baseVideoFilter` construction with `buildVideoEncodeFilterChain(...)`, emitting `-vf` only when non-empty.
    - Wrap `runFfmpeg`'s video encode argument construction (covering `doCopyVideo`, `-fps_mode:v`, `-enc_time_base:v`, `-vf`, and encoder flags) in `// [STAGE:encode:start]` ... `// [STAGE:encode:end]` so future encode CLI flag edits also bump `STAGE_CODE_HASHES.encode` automatically, ensuring stale `Po2VdJH`-class quarantined candidates auto-retire while keeping cached source prechecks.
  - [`docs/architecture/FAILURE_DIAGNOSTICS.md`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/docs/architecture/FAILURE_DIAGNOSTICS.md) & [`docs/plans/IMPLEMENTATION_LOG.md`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/docs/plans/IMPLEMENTATION_LOG.md): document the `vpp_qsv` / `-enc_time_base:v` root cause and fix.
  - [`flow.json`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/flow.json): rebuilt via `python3 scripts/build.py`.
  - Tests: [`tests/policy.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/policy.test.js), [`tests/flow.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/flow.test.js), [`tests/integration.test.js`](file:///Users/mfattoru/Documents/ChatGPT/Homelab/Ultimate-Tdarr-AV1-Flow/tests/integration.test.js).
- **API / Data Model Updates:**
  - `src/policy.js` exports `buildVideoEncodeFilterChain` (and `testVideoEncodeFilterChain` alongside existing test helpers).
  - `STAGE_CODE_HASHES.encode` updates deterministically on rebuild, retiring stale pre-fix `qsv_av1_encode` / `svt_av1_encode` quarantined candidates (e.g., `Po2VdJH`) via existing `candSigs.encode !== currentEncodeSignature` handling while keeping `precheck_video` and `precheck_audio` cache hits intact.

## Step-by-Step Execution Path (TDD)
1. **Red Phase (Failing Tests First):**
   - Update/add unit tests in `tests/policy.test.js` for `composeVideoFilterChain` (including empty base) and `buildVideoEncodeFilterChain` (8-bit QSV `scale_vaapi`, 10-bit QSV empty vs `sidedata`-only, `useHybrid`, `useSoftwareFallback`, `dovi5_hdr10`).
   - Add flow tests in `tests/flow.test.js` verifying `!doCopyVideo` emits `-fps_mode:v passthrough` + `-enc_time_base:v 1:1000`, `doCopyVideo` omits both, `vpp_qsv` is absent from `arc_av1_monolithic`, and the encode CLI block is covered by `STAGE:encode`.
   - Add FFmpeg integration tests in `tests/integration.test.js` encoding a synthetic `+21 ms`-delayed `24000/1001` H.264 + AAC MKV with `-fps_mode:v passthrough -enc_time_base:v 1:1000` and testing stale quarantine retirement when `encode` stage signature changes while preserving source precheck cache.
   - Run `npm test` to confirm expected failures before modifying `src/` or `scripts/`.
2. **Green Phase (Implementation & Build):**
   - Implement `composeVideoFilterChain` empty-base support and `buildVideoEncodeFilterChain` in `src/policy.js`.
   - Register the new declaration in `scripts/stage_signatures.py`.
   - Update `scripts/build.py` to emit `-enc_time_base:v 1:1000`, call `buildVideoEncodeFilterChain`, and include the `runFfmpeg` encode block inside `STAGE:encode`.
   - Rebuild `flow.json` via `python3 scripts/build.py`.
3. **Verification:**
   - Run `python3 scripts/stage_signatures.py --check-isolation` and `make check` (`build`, `test:coverage`, `git diff --check`) locally.
   - Verify end-to-end inside `tdarr-flow-live-test-20261102` and clean up any temporary files.
   - Update `docs/architecture/FAILURE_DIAGNOSTICS.md` and `docs/plans/IMPLEMENTATION_LOG.md`, then re-run `make check`.
