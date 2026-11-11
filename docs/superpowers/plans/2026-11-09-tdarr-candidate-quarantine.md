# Tdarr Candidate Quarantine Implementation Plan

> **For agentic workers:** Execute this plan task by task. Keep the user's original file untouched until the existing validation and original-file recheck both pass.

**Goal:** Preserve complete candidates that fail final validation so a later Tdarr run can validate them again without re-encoding.

**Architecture:** Store a failed candidate and an atomic manifest under a quarantine directory inside the shared reservation root. Match the manifest to the original path and SHA-256 content hash. On retry, rebuild current source expectations, skip encoding when a matching candidate exists, and run the current final validator. Promote only through the existing original recheck and replacement path. `arc_force_fresh_path` in Tdarr library variables removes a matching candidate and bypasses the completion-marker shortcut for that exact path.

**Tech Stack:** Node.js custom functions embedded by the Python flow builder; Tdarr Flow JSON; existing capacity reservation and source-identity helpers.

**Spec:** The user-approved amendment to [`V15_DESIGN.md`](../../../V15_DESIGN.md) in the conversation on 2026-11-09. This plan updates that document to replace its current no-quarantine policy.

## Global Constraints

- Keep the original file untouched on every quarantine, copy, validation, or revalidation failure.
- Quarantine only complete candidates that reached final validation and failed it; retain both rejected and inconclusive candidates.
- Confirm the captured original is still unchanged before hashing/storing a new candidate; a source-change guard failure is not eligible for quarantine.
- Require the canonical original path and matching source SHA-256 before candidate reuse.
- Store candidates below the configured reservation root (`TDARR_RESERVATION_ROOT`, default `/transcode_cache`) in `tdarr-av1-quarantine`; keep this directory outside media libraries.
- Compare the quarantine directory against the current Tdarr library folder before lookup, purge, or storage; refuse to use a location that falls under a scanned library root.
- Preserve the configured free-space floor. If quarantine storage cannot be reserved or written, log the reason and follow the existing failure cleanup path.
- Retain a quarantined candidate until successful replacement, an exact-path force-fresh run, or manual removal. Do not prune it by age.
- Read `args.userVariables.library.arc_force_fresh_path` as the exact Tdarr-visible source path; it remains set until the user clears it.
- Preserve existing Arr-search classification and success/failure notification routing.

## Review Focus

- Changed source content or path: do not reuse the old candidate; retain the original.
- Original changes during the encode: do not associate that candidate with the new file at the same path.
- Missing, malformed, truncated, or hash-mismatched manifest/candidate: fail closed and never promote it.
- No quarantine capacity, unwritable storage, or cross-filesystem copy failure: keep normal failure behavior and the original.
- Candidate fails again during validation or replacement readiness: keep it quarantined for another attempt.
- Force-fresh path uses Tdarr's node-visible path and affects only an exact match; clear it after the targeted job.

---

### Task 1: Add persistent quarantine storage

**Files:**
- Create: `quarantine.js`
- Modify: `build.py`
- Modify: `build_additions.py`

**Interfaces:**
- `findQuarantineCandidate({root, sourcePath, sourceHash?, libraryRoots})` returns a validated entry or `null`; when no source hash is supplied, it hashes the source only if path-matched manifests exist, then verifies the manifest and candidate SHA-256. Invalid entries do not prevent later valid entries from being considered.
- `storeQuarantineCandidate({root, sourcePath, sourceHash?, candidatePath, marker, kind, validationReport, assertSourceUnchanged?, libraryRoots})` hashes the source internally when needed, atomically moves a same-filesystem candidate or capacity-reserved copy into quarantine, verifies its hash, then writes the manifest atomically.
- `updateQuarantineFailure(entry, validationReport)` atomically updates retry diagnostics without replacing the candidate.
- `removeQuarantineCandidate(entry)` removes only the validated candidate and manifest below the quarantine root.
- `removeQuarantineCandidatesForSource({root, sourcePath, libraryRoots})` removes only in-root entries indexed by that exact source path key; force-fresh cleanup continues through malformed manifests using validated identifiers and derived in-root paths.

- [x] Add bounded manifest parsing and strict path checks for quarantine entries.
- [x] Use the existing reservation ledger when a cross-filesystem copy needs additional space; release the temporary reservation after the completed file is installed.
- [x] Inject the helper into the generated engine through the builder.
- [x] Preserve the candidate if manifest writing fails; remove partial quarantine writes and allow existing cache cleanup to proceed.

### Task 2: Revalidate quarantined candidates in the engine

**Files:**
- Modify: `build_additions.py`
- Modify: `build.py`
- Modify: generated `flow.json`

**Interfaces:**
- The engine reads the exact-path override from `args.userVariables.library.arc_force_fresh_path`.
- A matching quarantine entry supplies its candidate path, completion marker, candidate kind, and prior validation report.

- [x] Resolve an exact-path force-fresh request before the completed-encode early return; delete only that source's quarantine entry and proceed from the original.
- [x] Find quarantine entries by canonical source path, then verify the original's content hash before reuse.
- [x] Rebuild current source validation expectations and skip only encode/remux when a valid quarantined candidate exists.
- [x] Re-run the normal candidate size and final validation policy against the quarantined file; on failure, retain it and update its manifest. For a newly generated candidate, atomically quarantine it before the failure route cleans scratch.
- [x] Before storing a new failed candidate, confirm the original snapshot remains unchanged; do not quarantine when the original guard fails.
- [x] On validation success, return the candidate through the existing original-recheck and replacement path, tagging the entry for deletion only after replacement succeeds.
- [x] Ensure failures before final validation and incomplete encoder outputs are not quarantined.

### Task 3: Wire cleanup and document the user controls

**Files:**
- Modify: `build_additions.py`
- Modify: `README.md`
- Modify: `V15_DESIGN.md`
- Modify: `flow-diagram.md`
- Regenerate: `flow.json`

- [x] Make successful cleanup remove a quarantined entry only after `replaceOriginalFile` succeeds.
- [x] Keep failed and unexpected-error cleanup limited to job scratch and temporary reservation release; preserve quarantine entries.
- [x] Document the Libraries-tab variable `arc_force_fresh_path`, the exact Tdarr-visible path value, the need to clear it after a targeted run, the quarantine directory, capacity behavior, and manual purge.
- [x] Update the V15 design and diagrams to remove the current no-permanent-copy rule and show quarantine/revalidation/fresh-run branches.
- [x] Run the flow builder from the project root and inspect the regenerated export diff for the expected node IDs, code fragments, and flow edges.

## Verification Boundary

The implementation follows the existing generated-flow build path. Do not add or run tests unless the user separately asks for implementation verification. Regenerating `flow.json` and inspecting the resulting diff are required build/review steps, not a test-suite run.
