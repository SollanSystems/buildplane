# Throwaway rootful-Docker harness image for the first live promotion-decision
# authority host/client round trip.
#
# ubuntu:24.04 matches the glibc of the WSL toolchain that produces
# native/target/debug. The 280MB of debug binaries are NOT baked in; they arrive
# through a read-only /repo bind mount at run time, so the image stays small and
# the harness always exercises the current build.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      openssl \
      sqlite3 \
      util-linux \
      passwd \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Fail at build time, not mid-run, if the base image's own root directory does
# not satisfy the client's open_root check (Directory, uid 0, mode exactly 0755).
RUN test "$(stat -c '%u %a' /)" = "0 755"
RUN test "$(openssl version | cut -d' ' -f2 | cut -d. -f1)" = "3"

WORKDIR /
CMD ["bash", "/repo/scripts/trust-spine/roundtrip/container/roundtrip.sh"]
