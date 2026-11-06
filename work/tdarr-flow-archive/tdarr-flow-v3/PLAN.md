# Tdarr flow safety fixes

Goal: Correct the reviewed issues in the user's latest export without changing its intended media policy or adding recovery copies.

1. Add regression fixtures for shortened video with full-length audio, distinct equal-metadata audio, unknown free space, source changes, destination collision, and ISO/failure routing.
2. Require verifiable video packet timelines and decode the complete output video before replacement. Fail closed if checks cannot establish safety.
3. Remove metadata-only duplicate and ghost pruning; retain the explicitly chosen downstream language and audio rules.
4. Fail closed on unknown cache space and preserve the capacity floor. Capture and recheck original file identity and check destination collisions.
5. Route Tdarr flow errors to safe cache cleanup and retain failure status. Preserve normal replacement, ISO deletion, Arr scan, and notifications.
6. Build an importable separate export, run regression and syntax/graph checks, and document remaining limits including replacement race and storage concurrency.
