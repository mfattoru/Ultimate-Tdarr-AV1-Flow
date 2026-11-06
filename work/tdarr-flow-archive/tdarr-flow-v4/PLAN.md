# Arc AV1 unattended policy implementation plan

Goal: build a separate, reviewable flow that tries eligible source videos on Arc, checks for smaller validated output, and bounds quality degradation.

Architecture: preserve V3's source, cache, stream and ISO safeguards; add versioned completion marker, resolution-dependent ICQ attempts, and fail-closed handling for HDR paths that cannot be verified. Build from V3 without editing the active server.

1. Write behavioral tests for candidate quality selection, bounded retries, strict size reduction, AV1 sources and already-completed output; confirm they fail on V3.
2. Add the retry policy and marker to the generated V4 flow; preserve audio/subtitle selection and cleanup.
3. Guard HDR and Dolby Vision against unsupported metadata conversion or loss; independently verify any enabled path with real fixtures before enabling replacement.
4. Run focused policy tests and existing applicable V3 safety tests, review the generated flow and document limitations.

Constraints: ICQ 19 then 23 for 1080p SDR; ICQ 19, 23, 26 for 4K SDR; no permanent original copy; Arc device configurable; unsuccessful smaller encode leaves original intact. The user approved provisional 4K HDR ICQ 18 → 22, tested for size only; HDR remains disabled while dynamic metadata handling is unverified. Existing ISO deletion and Arr scan behavior remain.
