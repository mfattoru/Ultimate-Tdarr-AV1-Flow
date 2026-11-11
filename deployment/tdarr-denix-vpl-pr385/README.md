# Tdarr DeNiX with Intel VPL PR #385

This derived image preserves the production FFmpeg and prioritizes the patched Intel VPL GPU runtime through `ONEVPL_PRIORITY_PATH`. The patch is from [intel/vpl-gpu-rt PR #385](https://github.com/intel/vpl-gpu-rt/pull/385), commit `391ce6e08457fdc8c8e9b2567fae12be98354ab4`.

The Dockerfile tracks the upstream `latest` tag while pinning the exact base digest, currently `sha256:ae4d1babf91a5015e331355c96b55dada589af8f8baed7b04660b72ef15acb5c` as observed on 2026-11-11. This keeps builds reproducible while allowing Renovate to detect when the tag moves.

## Upstream base update PRs

`renovate.json` at the repository root allows the Denix base digest check daily during the 4 a.m. Central window and opens a PR when the upstream digest changes. It is scoped to this Dockerfile and does not auto-merge. The `Build Tdarr DeNiX image candidate` workflow builds PRs without registry credentials. After a change is merged to `main`, that workflow publishes `candidate-<full-commit-sha>` to Docker Hub.

The hosted build verifies that the custom image can be assembled, but it cannot access the Unraid Arc GPU. Pull the candidate on Unraid and run the included smoke check. If it passes, run **Actions → Promote tested Tdarr DeNiX image → Run workflow** on `main`, entering the full `candidate-<commit-sha>` tag. The promotion workflow copies the same candidate image to `sha-<full-commit-sha>` and `latest`; the SHA tag provides rollback, and `latest` is the update-notification target. A new `latest` tag does not restart Tdarr by itself.

For Docker Hub publishing, add these repository secrets under **Settings → Secrets and variables → Actions**:

- `DOCKERHUB_USERNAME`: `mfattoru`
- `DOCKERHUB_TOKEN`: a Docker Hub access token with write access to `mfattoru/tdarr-denix-vpl-pr385`

Install/enable the Renovate GitHub App and GitHub Actions for this repository. The configuration expects `Ultimate-Tdarr-AV1-Flow/` to be the repository root. If the project is hosted inside a larger repository instead, move `renovate.json` and `.github/workflows/` to that repository root and adjust the Dockerfile paths in the configuration.

## Build context

`runtime/lib/` contains the x86_64 runtime built and tested in `tdarr-flow-live-test-20261102`, including its shared library, symlinks, and `libmfx-gen/enctools.so`. The main library SHA-256 is:

```text
77f91fd1eac836a1f63f96daa692697a6168d03f56305e6dd21ca89206fc3f2d  libmfx-gen.so.1.2.17
```

`smoke-check.sh` is copied into the image as `/usr/local/bin/tdarr-vpl-smokecheck`. It checks the runtime path and checksum, verifies Arc device access, runs a short `av1_qsv` encode, confirms FFmpeg loaded the patched library, and probes the output codec and frame count.

## Published test image

The verified test image is published on Docker Hub:

```text
mfattoru/tdarr-denix-vpl-pr385:pr385-20261111-smokecheck
Digest: sha256:6eae4920c7d1da1211103b43e0f2d7970cb212b0c3d3bed386ebf928fcf97086
```

Pull by immutable digest:

```sh
docker pull mfattoru/tdarr-denix-vpl-pr385@sha256:6eae4920c7d1da1211103b43e0f2d7970cb212b0c3d3bed386ebf928fcf97086
```

Run the smoke check on the Unraid host with the Arc render device passed through:

```sh
docker run --rm --device=/dev/dri:/dev/dri \
  -e TDARR_ARC_DEVICE=/dev/dri/renderD129 \
  --entrypoint /usr/local/bin/tdarr-vpl-smokecheck \
  mfattoru/tdarr-denix-vpl-pr385:pr385-20261111-smokecheck
```

The verified run printed:

```text
PASS: QSV AV1 encoded 24 frames on /dev/dri/renderD129 and loaded the patched VPL runtime
```

This short hardware check confirms the patched runtime is active and can encode AV1. It is not a full-length movie transcode test.

This is the versioned image currently deployed in production on Unraid and has already passed the Arc smoke check. After the workflows are merged and Docker Hub secrets are configured, bootstrap `latest` by running the promotion workflow with source tag `pr385-20261111-smokecheck`. Then change the Tdarr template's Repository once to `mfattoru/tdarr-denix-vpl-pr385:latest`, preserving the existing ports, GPU device access, environment, and volume mappings. Unraid can then notify you when a promoted image is available; apply the update while Tdarr is idle. Keep the exported Tdarr flow separate from the container image. Leave the auto-update plugin in notification/manual mode for this container if you want to choose when it restarts.

## Check and promote an updated image

After GitHub publishes a candidate, pull it on Unraid and run the Arc smoke check:

```sh
docker pull mfattoru/tdarr-denix-vpl-pr385:candidate-<full-commit-sha>
docker run --rm --device=/dev/dri:/dev/dri \
  -e TDARR_ARC_DEVICE=/dev/dri/renderD129 \
  --entrypoint /usr/local/bin/tdarr-vpl-smokecheck \
  mfattoru/tdarr-denix-vpl-pr385:candidate-<full-commit-sha>
```

After it passes, promote it with the GitHub Actions workflow described above. The candidate remains available for diagnosis, while `sha-<full-commit-sha>` and `latest` point to the approved release. In Unraid, set **Settings → User Preferences → Notification Settings → Docker update notification** to check daily. The alert tells you when `latest` changed; Unraid does not pull or restart the container until you apply the update.

## Green-y regression result

With a synthetic HDR10 source whose green-y mastering coordinate is `39850/50000`, the stock runtime clipped output to `50000/65536`; PR #385 produced `52232/65536`, preserving the coordinate after AV1's 16-bit scaling. This is a focused green-mapping comparison, not a full-length movie transcode.

The 2026-11-11 comparison also confirmed both the pinned upstream base and derived image produced a 120-frame, 1920×1080 AV1 Main output through `av1_qsv` on `/dev/dri/renderD129`. FFmpeg's `trace_headers` reported `50000/65536` from the base and `52232/65536` from the derived image. The Matroska stream-side-data view showed `797/1000` for both and was not a reliable discriminator for the encoded sequence-header value in this test.
