# Archived Tdarr flow revisions

This folder keeps the older local flow revisions together without deleting their source, tests, or notes. The active local candidate remains in `work/tdarr-flow-v12/` and is built as flow ID V13.

The current V13 builder now has its own V3 template and capacity-lock source under `work/tdarr-flow-v12/base/`. Archived V4–V11 and safety builders retain their original relative dependency on the archived V3 folder, so the history remains buildable when run from the workspace.

The two V13 worker-metadata snapshots are in `v13-snapshots/`; they are intermediate JSON exports, not build inputs.

To restore a revision to its former top-level location, move its `tdarr-flow-vN` directory from this folder back into `work/`. Tdarr server flows are unaffected by this local archive.
