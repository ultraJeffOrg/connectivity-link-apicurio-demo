# Connectivity Link + Apicurio Registry Demo

A minimal demo showing how **Red Hat Connectivity Link** (lightweight API management) and **Red Hat build of Apicurio Registry** (API schema registry) work together — and how an AI model can consume API specs from the registry to understand and interact with your APIs.

## What this demo shows

```
┌──────────────┐       ┌─────────────────────┐       ┌──────────────────┐
│              │       │  Connectivity Link   │       │                  │
│    Client    │──────▶│  (Gateway + Policies)│──────▶│   Incident API   │
│              │       │  - Rate limiting     │       │   (Node.js)      │
└──────────────┘       │  - API key auth      │       └──────────────────┘
                       └─────────────────────┘
                                                              │
                                                    spec registered in
                                                              │
                                                              ▼
┌──────────────┐       ┌─────────────────────┐
│              │       │   Apicurio Registry  │
│   AI Model   │◀──────│   (OpenAPI specs)    │
│   (Claude)   │       │                      │
└──────────────┘       └─────────────────────┘
```

1. **Incident API** — a simple Node.js service for tracking operational incidents (outages, alerts, cases)
2. **Connectivity Link 1.3** — manages the API gateway with rate limiting and API key authentication using Kubernetes-native Gateway API resources
3. **Red Hat build of Apicurio Registry 3.1** — stores the OpenAPI spec as a versioned artifact
4. **AI Consumer** — a Node.js script that fetches the spec from Apicurio and sends it to Claude, which can then answer questions about the API and generate working curl commands

## Prerequisites

- OpenShift 4.16+ cluster
- `oc` CLI logged in to the cluster
- An [Anthropic API key](https://console.anthropic.com/) for the AI consumer script

## Project structure

```
├── operators/                   # Operator installations (apply first)
│   ├── 00-cert-manager.yaml     # cert-manager (Connectivity Link prerequisite)
│   ├── 01-connectivity-link.yaml
│   └── 02-apicurio-registry.yaml
├── sample-api/                  # The incident management API
│   ├── server.js                # Express app
│   ├── openapi.yaml             # OpenAPI 3.0 spec
│   ├── package.json
│   └── Containerfile
├── apicurio/                    # Apicurio Registry instance + seed script
│   ├── 02-apicurio-registry.yaml
│   └── 03-seed-registry.sh     # Uploads the spec to the registry
├── connectivity-link/           # Gateway API + Connectivity Link policies
│   ├── 01-gateway.yaml
│   ├── 02-httproute.yaml
│   ├── 03-rate-limit-policy.yaml
│   ├── 04-auth-policy.yaml
│   └── 05-deployment.yaml
└── ai-consumer/                 # Fetches specs from Apicurio for AI
    ├── fetch-and-query.js
    └── package.json
```

## Step 0: Install the operators

```bash
# cert-manager (required by Connectivity Link)
oc apply -f operators/00-cert-manager.yaml
oc wait --for=condition=Available deployment/cert-manager -n cert-manager --timeout=120s

# Connectivity Link (installs Authorino, Limitador, and DNS operators automatically)
# Note: apply the Subscription/OperatorGroup first, wait for the operator, then the Kuadrant CR activates it
oc apply -f operators/01-connectivity-link.yaml
oc wait --for=jsonpath={.status.installPlanRef.name} subscription rhcl-operator -n kuadrant-system --timeout=60s
oc wait kuadrant/kuadrant --for="condition=Ready=true" -n kuadrant-system --timeout=300s

# Red Hat build of Apicurio Registry
oc apply -f operators/02-apicurio-registry.yaml

# Verify all operators are installed
oc get csv -A | grep -E 'rhcl\|apicurio\|cert-manager'
```

## Step 1: Deploy Apicurio Registry

```bash
oc apply -f apicurio/02-apicurio-registry.yaml
oc wait --for=condition=Ready pod -l app=apicurio-db -n apicurio-registry --timeout=120s
```

Wait for the ApicurioRegistry instance to come up (the operator creates the deployment):

```bash
oc get apicurioregistry3 -n apicurio-registry
```

## Step 2: Register the OpenAPI spec

```bash
REGISTRY_URL=$(oc get route apicurio-registry -n apicurio-registry -o jsonpath='{.spec.host}')
chmod +x apicurio/03-seed-registry.sh
./apicurio/03-seed-registry.sh "https://${REGISTRY_URL}"
```

Verify the artifact is stored:

```bash
curl -s "https://${REGISTRY_URL}/apis/registry/v3/groups/incident-api/artifacts" | jq .
```

## Step 3: Deploy the Incident API with Connectivity Link

Replace `<cluster-domain>` in the HTTPRoute and `<your-org>` in the Deployment with your values.

```bash
# Build and push the image
cd sample-api
podman build -t quay.io/<your-org>/incident-api:latest -f Containerfile .
podman push quay.io/<your-org>/incident-api:latest
cd ..

# Deploy
oc new-project incident-api || true
oc apply -f connectivity-link/05-deployment.yaml
oc apply -f connectivity-link/01-gateway.yaml
oc apply -f connectivity-link/02-httproute.yaml
oc apply -f connectivity-link/03-rate-limit-policy.yaml
oc apply -f connectivity-link/04-auth-policy.yaml
```

## Step 4: Test the API through the gateway

```bash
GATEWAY_URL=$(oc get httproute incident-api-route -n incident-api -o jsonpath='{.spec.hostnames[0]}')

# Without API key — should get 401
curl -s "https://${GATEWAY_URL}/api/incidents" | jq .

# With API key — should get 200
curl -s -H "x-api-key: demo-key-12345" "https://${GATEWAY_URL}/api/incidents" | jq .

# Create a new incident
curl -s -X POST "https://${GATEWAY_URL}/api/incidents" \
  -H "x-api-key: demo-key-12345" \
  -H "Content-Type: application/json" \
  -d '{"title": "Database failover triggered", "severity": "critical", "reportedBy": "dba-team"}' | jq .
```

## Step 5: Use AI to explore the API

The AI consumer pulls the OpenAPI spec from Apicurio Registry and uses it as context for Claude.

```bash
cd ai-consumer
npm install

ANTHROPIC_API_KEY=sk-... \
APICURIO_REGISTRY_URL="https://${REGISTRY_URL}" \
node fetch-and-query.js "How do I create a critical incident and then update its status to resolved?"
```

Try other questions:

```bash
node fetch-and-query.js "What filters can I use when listing incidents?"
node fetch-and-query.js "Show me how to get all open high-severity incidents"
```

## What to highlight in a demo

| Talking point | Where to show it |
|---|---|
| **GitOps-ready operator install** | `operators/` — Subscription manifests in Git, not click-ops in the console |
| **Gateway API is the standard** | `01-gateway.yaml`, `02-httproute.yaml` — plain Kubernetes Gateway API, no vendor lock-in |
| **Policy attachment pattern** | `03-rate-limit-policy.yaml`, `04-auth-policy.yaml` — policies attach to routes via `targetRef`, not embedded in app code |
| **API key auth with zero app changes** | The incident API has no auth code at all — Connectivity Link handles it at the gateway |
| **Rate limiting out of the box** | Hit the API 50+ times in 10 seconds to see `429 Too Many Requests` |
| **API specs as a single source of truth** | Apicurio stores the spec; the AI consumer fetches it live — no copy-pasting specs into prompts |
| **AI + API registry** | The AI consumer shows how LLMs can dynamically discover and understand APIs from a registry |

## Versions

| Component | Version |
|---|---|
| Red Hat Connectivity Link | 1.3 |
| Red Hat build of Apicurio Registry | 3.1 |
| Node.js (UBI base image) | 22 |
| Kubernetes Gateway API | v1 |
