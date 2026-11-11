# Keep Tdarr's tested FFmpeg and replace only the Intel VPL GPU runtime.
# Renovate tracks the upstream latest tag and proposes digest-only changes.
# The pinned digest keeps each build immutable until an update PR is reviewed.
FROM denix811/tdarr-denix:latest@sha256:ae4d1babf91a5015e331355c96b55dada589af8f8baed7b04660b72ef15acb5c

# runtime/lib is the x86_64 VPL GPU runtime built from intel/vpl-gpu-rt
# commit 391ce6e08457fdc8c8e9b2567fae12be98354ab4 (PR #385).
COPY runtime/lib/ /opt/tdarr-vpl-pr385/lib/
COPY smoke-check.sh /usr/local/bin/tdarr-vpl-smokecheck
RUN chmod 0755 /usr/local/bin/tdarr-vpl-smokecheck

# Use the patched runtime through the VPL dispatcher without replacing the
# image's system libraries or FFmpeg binary.
ENV ONEVPL_PRIORITY_PATH=/opt/tdarr-vpl-pr385/lib

LABEL org.opencontainers.image.title="Tdarr DeNiX with Intel VPL PR #385" \
      org.opencontainers.image.description="Production Tdarr base with the tested Intel VPL green-y mapping fix" \
      org.opencontainers.image.revision="391ce6e08457fdc8c8e9b2567fae12be98354ab4"
