#!/usr/bin/env bash
#
# Uploads the Incident API OpenAPI spec to Apicurio Registry.
# Run this after the registry is up and the route is accessible.
#
# Usage: ./03-seed-registry.sh <apicurio-registry-url>
# Example: ./03-seed-registry.sh https://apicurio-registry.apps.mycluster.example.com

set -euo pipefail

REGISTRY_URL="${1:?Usage: $0 <apicurio-registry-url>}"
SPEC_FILE="$(dirname "$0")/../sample-api/openapi.yaml"
GROUP="incident-api"
ARTIFACT_ID="incident-management-api"

echo "==> Uploading OpenAPI spec to Apicurio Registry"
echo "    Registry: ${REGISTRY_URL}"
echo "    Group:    ${GROUP}"
echo "    Artifact: ${ARTIFACT_ID}"
echo ""

curl -X POST "${REGISTRY_URL}/apis/registry/v3/groups/${GROUP}/artifacts" \
  -H "Content-Type: application/yaml" \
  -H "X-Registry-ArtifactId: ${ARTIFACT_ID}" \
  -H "X-Registry-ArtifactType: OPENAPI" \
  -d @"${SPEC_FILE}" \
  --fail-with-body \
  -w "\n"

echo ""
echo "==> Done. Verify at: ${REGISTRY_URL}/apis/registry/v3/groups/${GROUP}/artifacts/${ARTIFACT_ID}/versions"
