# Tdarr Arc AV1 safety-review flow

`ArcAV1-safety-review.json` is an importable copy with a new flow ID. It has not been installed or assigned to a live library. It contains the original Discord webhook and Arr credentials; keep it private and rotate those credentials when ready.

## Changes

- Retains ISO deletion and reports success only after the unlink. After deletion, it requests the existing content-aware Radarr/Sonarr rescan and then ends as failed. A rescan updates the library, but it is not itself a search or a guarantee of refetch; Arr monitoring and search settings must handle that separately.
- Uses unique per-job cache directories and cleans the generated output and empty directory on normal success and failure paths.
- Uses bigint filesystem statistics, falls back to `df`, and refuses cache candidates whose free space cannot be measured. The existing 20 GiB default floor and 1.25x source estimate remain. Checks do not reserve space: concurrent jobs or other writers can still consume it; use one transcode worker unless you have separate capacity controls.
- Uses `/dev/dri/renderD129` by default. Override with `TDARR_ARC_DEVICE` on the node, or the Tdarr library/global variable `arc_device`. If the selected device is unavailable, video encoding fails before starting. The existing CPU decode fallback still encodes on QSV.
- Checks the final output with ffprobe, including source/output format duration (0.5% tolerance, minimum one second), video codec, and the count and codecs of selected audio/subtitle streams. The same checks run after the size-based fallback. It refuses to replace the original if another file already exists at the would-be output path. These checks do not decode every frame or measure visual quality.
- Removes the unused bitrate clamp and corrects the near-lossless notification text. The existing quality-based encode and size fallback remain.
- Does not create recovery copies. Tdarr's normal Replace Original File plugin handles replacement. A successful check is not a guarantee against corruption or lost track content.

Audio filtering and conversions, subtitle filtering and conversion, HDR/Dolby Vision logic, and AV1 re-encoding decisions are unchanged. Credentials were not rotated.

## Verification and limitations

Run `python3 work/tdarr-flow-safety/build.py` followed by `node --test work/tdarr-flow-safety/*.test.js` from the workspace root. The tests use local FFmpeg fixtures and mock the webhook URL. They cover AV1 stream-copy, output probing, destination collisions, ISO deletion, cache cleanup, and inaccessible GPU handling. They do not verify the Arc encoder, the installed Tdarr version, actual replacement, media players, or live Arr refetch behavior.

The Unraid Tdarr container was paused by an existing cache safeguard when inspected. `/dev/dri` is mapped into it and the host `/dev/dri/renderD129` is an Intel device. The flow has not been tested inside that paused container or deployed. Import the JSON as a separate flow and test with disposable copies before assigning it to production.

A process crash or a replacement plugin exception can leave a per-job cache directory behind; the normal cleanup nodes only run when their flow paths are reached. Free-space checks are snapshots, not reservations.
