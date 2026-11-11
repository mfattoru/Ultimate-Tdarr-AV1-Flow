# Tdarr DeNiX with Intel VPL PR #385

This derived image preserves the production FFmpeg and prioritizes the patched Intel VPL GPU runtime through `ONEVPL_PRIORITY_PATH`. The patch is from [intel/vpl-gpu-rt PR #385](https://github.com/intel/vpl-gpu-rt/pull/385), commit `391ce6e08457fdc8c8e9b2567fae12be98354ab4`.

The Dockerfile tracks the upstream `latest` tag while pinning the exact base digest, currently `sha256:ae4d1babf91a5015e331355c96b55dada589af8f8baed7b04660b72ef15acb5c` as observed on 2026-11-11. This keeps builds reproducible while allowing Renovate to detect when the tag moves.

## Upstream base update PRs

`renovate.json` at the repository root asks Renovate to check the Denix base digest weekly and open a PR for an update. It is scoped to this Dockerfile, does not auto-merge, and does not need Docker Hub credentials because the upstream image is public. The `Build Tdarr DeNiX image candidate` GitHub Actions workflow builds the proposed image on pull requests without publishing it; it uses a hosted runner and has no registry secrets.

The hosted build verifies that the custom image can be assembled, but it cannot access the Unraid Arc GPU. Before publishing an updated image, review the PR, run the included smoke check on Unraid, and then push a fresh immutable tag. The build workflow never changes the production Tdarr container.

To activate this automation, install/enable the Renovate GitHub App for this repository and ensure GitHub Actions are enabled. The configuration expects `Ultimate-Tdarr-AV1-Flow/` to be the repository root. If the project is hosted inside a larger repository instead, move `renovate.json` and `.github/workflows/` to that repository root and adjust the Dockerfile paths in the configuration.

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

This is a versioned test image. The production Tdarr template and container have not been changed. When ready to deploy, set the Unraid Tdarr template's Repository to the verified versioned tag (or pin its digest), then recreate the container while preserving its current ports, GPU device access, environment, and volume mappings. Keep the exported Tdarr flow separate from the container image.

## Rebuild and publish a later version

Build from this directory on Unraid or another x86_64 Docker host:

```sh
docker build --pull -t tdarr-denix-vpl-pr385:candidate .
docker run --rm --device=/dev/dri:/dev/dri \
  -e TDARR_ARC_DEVICE=/dev/dri/renderD129 \
  --entrypoint /usr/local/bin/tdarr-vpl-smokecheck \
  tdarr-denix-vpl-pr385:candidate
docker tag tdarr-denix-vpl-pr385:candidate mfattoru/tdarr-denix-vpl-pr385:<new-version-tag>
docker push mfattoru/tdarr-denix-vpl-pr385:<new-version-tag>
docker buildx imagetools inspect mfattoru/tdarr-denix-vpl-pr385:<new-version-tag>
```

Use a fresh version tag for each rebuild and record the registry digest returned by the push or manifest inspection. Do not overwrite the verified tag. The upstream `latest` tag is used only as Renovate's update signal; the Dockerfile remains pinned to a digest.

## Green-y regression result

With a synthetic HDR10 source whose green-y mastering coordinate is `39850/50000`, the stock runtime clipped output to `50000/65536`; PR #385 produced `52232/65536`, preserving the coordinate after AV1's 16-bit scaling. This is a focused green-mapping comparison, not a full-length movie transcode.

The 2026-11-11 comparison also confirmed both the pinned upstream base and derived image produced a 120-frame, 1920×1080 AV1 Main output through `av1_qsv` on `/dev/dri/renderD129`. FFmpeg's `trace_headers` reported `50000/65536` from the base and `52232/65536` from the derived image. The Matroska stream-side-data view showed `797/1000` for both and was not a reliable discriminator for the encoded sequence-header value in this test.
