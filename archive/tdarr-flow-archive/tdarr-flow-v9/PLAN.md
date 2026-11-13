# V6: concurrent jobs, PGS validation and failure notifications

Work in a separate export; never change the live Tdarr workflow or library. Preserve original input and accepted audio/subtitle behavior, use the Arc and bounded quality values, require smaller output, and do not keep permanent recovery copies.

1. Reproduce the reported V3 failure: compare remuxed PGS segment payloads and timestamps with the source. Implement a packetization-independent PGS content and timeline validator; add regression tests for same-content regrouping and missing/retimed segments.
2. Route both controlled failures and unexpected flow errors through a deduplicating Discord failure notification; retain the actual reason in flow variables and keep failure status if notification fails. Test with mock HTTPS only.
3. Replace the whole-job capacity lock with per-filesystem reservations guarded by a short mutex. Preserve cleanup ownership and recoverability; handle /dev/shm and disk independently, concurrency, low space and crashes conservatively.
4. Investigate supported HDR/Dolby paths; enable only conversions whose pixel transform and output metadata can be validated. Preserve user-approved HDR10 fallback and report unsupported or unverified variants rather than destroying originals.
5. Run unit and integration regressions, disposable node tests for PGS and Arc, independent review, and document live-deployment limits.
