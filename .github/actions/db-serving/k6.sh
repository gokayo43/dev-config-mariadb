# shellcheck shell=bash
# k6, verified against the checksum pinned here and ready to run. Sourced rather
# than run: it leaves the binary at $K6.
#
# The pin is the whole of this tool's supply-chain story. k6 is a Go binary
# rather than an npm package, so it is in no lockfile and no install policy
# reaches it: the version string is a label, the SHA-256 is the contract, and
# Renovate's pinned-binary manager moves the two together. dev-config carries
# the same pair for its own ramp, at the same version on purpose — a ramp is
# only comparable with another ramp of the same k6, and the fleet's numbers are
# kept to be compared.
#
# Beside the one step that sources it rather than in `_lib/`. `_lib/` here is
# what every action shares, and this is a fetch with one caller: the ramp is the
# only thing in this repo that needs a binary nothing on a runner ships. It
# moves there when a second gate needs one, which is a move of a file rather
# than a change of a contract.
#
# renovate: datasource=github-release-attachments depName=grafana/k6
K6_VERSION=v2.2.0
K6_SHA256=b5a8003c86f35f5cd5ceef1490312c48e587696c94d998cefc6d7b3b4cb1597d

K6="$RUNNER_TEMP/k6"
K6_ARCHIVE="$RUNNER_TEMP/k6.tar.gz"

# A release CDN resets a connection now and then, and that is a retry rather
# than a supply-chain event. --retry-all-errors because the failure this has
# actually taken is a reset mid-transfer, which plain --retry does not count as
# transient. What arrived is still only the pinned artefact if the checksum
# below says so, however many attempts it took.
curl -sSfL --retry 3 --retry-all-errors --retry-delay 2 -o "$K6_ARCHIVE" \
  "https://github.com/grafana/k6/releases/download/${K6_VERSION}/k6-${K6_VERSION}-linux-amd64.tar.gz"
echo "${K6_SHA256}  ${K6_ARCHIVE}" | sha256sum -c -
tar -xzf "$K6_ARCHIVE" -C "$RUNNER_TEMP" --strip-components=1 "k6-${K6_VERSION}-linux-amd64/k6"
rm -f "$K6_ARCHIVE"

export K6
