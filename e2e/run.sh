#!/usr/bin/env bash
# Builds infra, infra-agent (from ../infra-agent) and the test host, and runs the end-to-end test (e2e/run.ts). Set KIND_CLUSTER to the name of a kind cluster to
# include Kubernetes; CI creates one.
set -euo pipefail
cd "$(dirname "$0")/.."
docker build -q -t "${INFRA_IMAGE:-infra:dev}" . >/dev/null
docker build -q -t "${TARGET_IMAGE:-openasy-infra-target:dev}" e2e/target >/dev/null
# infra-agent from the repository next to this one (CI checks it out there).
docker build -q -t "${AGENT_IMAGE:-infra-agent:dev}" "${AGENT_DIR:-../infra-agent}" >/dev/null
node e2e/run.ts
