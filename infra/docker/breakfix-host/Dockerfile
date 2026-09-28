# Lab host: a minimal Linux box with ping, traceroute and ip. Candidates never get a shell here;
# the server runs whitelisted commands through docker-guard.
FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

RUN apk add --no-cache \
      iproute2-minimal=7.0.0-r0 \
      iputils-ping=20250605-r2 \
      traceroute=2.1.6-r0 \
      tini=0.19.0-r3

LABEL org.opencontainers.image.title="breakfix-host" \
      org.opencontainers.image.source="https://github.com/buildwithabid/network-breakfix-lab"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sleep", "2147483647"]
