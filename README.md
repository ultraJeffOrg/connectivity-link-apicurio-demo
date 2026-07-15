# Connectivity Link + Apicurio Registry Demo

A demo showing how **Red Hat Connectivity Link** (lightweight API management) and **Red Hat build of Apicurio Registry** (API schema registry) work together — with support for both single-cluster deployment and **multi-cluster DNS-based failover** via ACM.

## What this demo shows

### Single-cluster mode

```
┌──────────────┐       ┌─────────────────────┐       ┌──────────────────┐
│              │       │  Connectivity Link   │       │                  │
│    Client    │──────▶│  (Gateway + Policies)│──────▶│   Incident API   │
│              │       │  - Rate limiting     │       │   (Node.js)      │
└──────────────┘       │  - API key auth      │       └──────────────────┘
                       └─────────────────────┘
```

### Multi-cluster failover mode

```
                          ┌──────────────────────────────────────┐
                          │           ACM Hub Cluster             │
                          │  (Policy distribution, DNS mgmt)     │
                          │                                      │
                          │  Policy ──▶ Placement ──▶ blue       │
                          │                      ──▶ aws-ai      │
                          └──────────────────────────────────────┘
                                         │
                         ACM distributes config to spokes
                                         │
                    ┌────────────────────┬┘
                    ▼                    ▼
     ┌──────────────────────┐  ┌──────────────────────┐
     │   Spoke: blue (Azure) │  │  Spoke: aws-ai (AWS)  │
     │                      │  │                      │
     │  Gateway + HTTPRoute │  │  Gateway + HTTPRoute │
     │  DNSPolicy ──▶ R53   │  │  DNSPolicy ──▶ R53   │
     │  Incident API        │  │  Incident API        │
     └──────────────────────┘  └──────────────────────┘
                    │                    │
                    └──────┬─────────────┘
                           │
              DNS: incidents.sandbox4020.opentlc.com
              resolves to healthy spoke IPs only
                           │
                    ┌──────▼──────┐
                    │   Client    │
                    └─────────────┘
```

Both spokes register A records for the same hostname. RHCL health checks monitor `/healthz` on each spoke — when a spoke goes down, its IP is removed from DNS and traffic fails over to the surviving spoke.

## Prerequisites

- OpenShift 4.16+ cluster(s)
- `oc` CLI logged in to the cluster
- `kustomize` CLI (or `oc apply -k`)
- An [Anthropic API key](https://console.anthropic.com/) for the AI consumer script (optional)

For multi-cluster mode:
- ACM hub cluster with two managed spoke clusters
- AWS Route53 zone for DNS-based failover
- RHCL + cert-manager operators installed on each spoke

## Project structure

```
├── operators/                          # Operator installations (apply first, separately)
│   ├── 00-cert-manager.yaml
│   ├── 01-connectivity-link.yaml
│   └── 02-apicurio-registry.yaml
├── kustomize/
│   ├── base/                           # Shared app + RHCL resources
│   │   ├── kustomization.yaml
│   │   ├── namespace.yaml
│   │   ├── deployment.yaml
│   │   ├── service.yaml
│   │   ├── gateway.yaml
│   │   ├── httproute.yaml
│   │   ├── rate-limit-policy.yaml
│   │   ├── auth-policy.yaml
│   │   └── api-key-secret.yaml
│   ├── components/
│   │   └── apicurio/                   # Optional Apicurio Registry component
│   │       ├── kustomization.yaml
│   │       ├── apicurio-registry.yaml
│   │       └── postgres.yaml
│   └── overlays/
│       ├── single-cluster/             # Original single-cluster demo
│       │   ├── kustomization.yaml
│       │   └── patches/
│       └── multi-cluster/
│           ├── spoke/                  # Applied to each spoke cluster
│           │   ├── kustomization.yaml
│           │   ├── dns-policy.yaml
│           │   ├── dns-provider-secret.yaml
│           │   └── patches/
│           └── hub/                    # ACM resources for hub cluster
│               ├── kustomization.yaml
│               ├── namespace.yaml
│               ├── managed-cluster-set-binding.yaml
│               ├── placement.yaml
│               ├── placement-binding.yaml
│               └── policy-spoke-config.yaml
├── sample-api/                         # Incident API source code
├── apicurio/
│   └── 03-seed-registry.sh            # Uploads OpenAPI spec to registry
└── ai-consumer/                        # AI-powered API explorer
```

---

## Single-Cluster Deployment

### Step 0: Install the operators

```bash
oc apply -f operators/00-cert-manager.yaml
oc wait --for=condition=Available deployment/cert-manager -n cert-manager --timeout=120s

oc apply -f operators/01-connectivity-link.yaml
oc wait --for=jsonpath={.status.installPlanRef.name} subscription rhcl-operator -n kuadrant-system --timeout=60s
oc wait kuadrant/kuadrant --for="condition=Ready=true" -n kuadrant-system --timeout=300s

oc apply -f operators/02-apicurio-registry.yaml
```

### Step 1: Build and push the Incident API image

```bash
cd sample-api
podman build -t quay.io/<your-org>/incident-api:latest -f Containerfile .
podman push quay.io/<your-org>/incident-api:latest
cd ..
```

### Step 2: Edit placeholders and deploy

Edit the patches in `kustomize/overlays/single-cluster/patches/`:
- `httproute-hostname.yaml` — replace `<cluster-domain>` with your cluster's apps domain
- `deployment-image.yaml` — replace `<your-org>` with your Quay.io org

```bash
oc apply -k kustomize/overlays/single-cluster/
```

### Step 3: Test the API

```bash
GATEWAY_URL=$(oc get httproute incident-api-route -n incident-api -o jsonpath='{.spec.hostnames[0]}')

# Without API key — should get 401
curl -s "https://${GATEWAY_URL}/api/incidents" | jq .

# With API key — should get 200
curl -s -H "x-api-key: demo-key-12345" "https://${GATEWAY_URL}/api/incidents" | jq .
```

### Optional: Deploy Apicurio Registry

Uncomment the `components` section in `kustomize/overlays/single-cluster/kustomization.yaml`, then:

```bash
oc apply -k kustomize/overlays/single-cluster/

REGISTRY_URL=$(oc get route apicurio-registry -n apicurio-registry -o jsonpath='{.spec.host}')
./apicurio/03-seed-registry.sh "https://${REGISTRY_URL}"
```

---

## Multi-Cluster Failover Deployment (ACM Hub)

This mode uses ACM to distribute the Incident API + RHCL configuration to two spoke clusters (`blue` on Azure, `aws-ai` on AWS). DNS-based failover via Route53 health checks ensures traffic routes only to healthy spokes.

### Prerequisites

1. ACM hub cluster with both spokes joined as ManagedClusters
2. RHCL + cert-manager operators installed on each spoke (use `operators/` manifests)
3. AWS Route53 credentials on the hub in `kube-system/rhdp` secret

### Step 1: Build and push the Incident API image

```bash
cd sample-api
podman build -t quay.io/ultraJeffOrg/incident-api:latest -f Containerfile .
podman push quay.io/ultraJeffOrg/incident-api:latest
cd ..
```

### Step 2: Apply the hub overlay

Log in to the hub cluster and apply:

```bash
oc apply -k kustomize/overlays/multi-cluster/hub/
```

This creates:
- `incident-api-policies` namespace on the hub
- `ManagedClusterSetBinding` for the `global` cluster set
- `Placement` targeting `blue` and `aws-ai` clusters
- `Policy` with three `ConfigurationPolicies` that push all spoke resources

### Step 3: Verify policy compliance

```bash
oc get policy -n incident-api-policies
# Should show: incident-api-spoke-config   Compliant

oc get configurationpolicy -A | grep incident-api
# Should show all three ConfigurationPolicies as Compliant
```

### Step 4: Verify DNS records

```bash
dig incidents.sandbox4020.opentlc.com
# Should return A records for both spoke Gateway IPs
```

### Step 5: Test the API

```bash
# Should work through DNS-based routing to either spoke
curl -s -H "x-api-key: demo-key-12345" "http://incidents.sandbox4020.opentlc.com/api/incidents" | jq .
```

### Step 6: Test failover

```bash
# Log in to one spoke and scale down the app
oc login <spoke-1-api-url>
oc scale deployment incident-api --replicas=0 -n incident-api

# Wait ~3 minutes for health checks to fail (failureThreshold: 3 x interval: 60s)
# Then verify DNS has removed the unhealthy spoke's IP
dig incidents.sandbox4020.opentlc.com

# Traffic now routes exclusively to the healthy spoke
curl -s -H "x-api-key: demo-key-12345" "http://incidents.sandbox4020.opentlc.com/api/incidents" | jq .

# Restore the spoke
oc scale deployment incident-api --replicas=1 -n incident-api
```

### Direct spoke deployment (without ACM)

You can also apply the spoke overlay directly to each spoke cluster:

```bash
# Edit dns-provider-secret.yaml with your Route53 credentials
oc login <spoke-api-url>
oc apply -k kustomize/overlays/multi-cluster/spoke/
```

---

## AI Consumer (Optional)

```bash
cd ai-consumer
npm install

ANTHROPIC_API_KEY=sk-... \
APICURIO_REGISTRY_URL="https://${REGISTRY_URL}" \
node fetch-and-query.js "How do I create a critical incident and then update its status to resolved?"
```

## What to highlight in a demo

| Talking point | Where to show it |
|---|---|
| **Kustomize overlays for single vs multi-cluster** | `kustomize/overlays/` — same base, different deployment models |
| **DNS-based failover** | `dns-policy.yaml` — health checks remove unhealthy spoke IPs from DNS |
| **ACM policy distribution** | `policy-spoke-config.yaml` — hub pushes all config to spokes via governance |
| **Hub-template secrets** | DNS credentials pulled from hub secret, never stored in Git |
| **Gateway API is the standard** | `gateway.yaml`, `httproute.yaml` — plain Kubernetes Gateway API |
| **Policy attachment pattern** | Rate limiting + auth policies attach to routes via `targetRef` |
| **Zero-app-change auth** | The Incident API has no auth code — Connectivity Link handles it at the gateway |

## Versions

| Component | Version |
|---|---|
| Red Hat Connectivity Link | 1.3 |
| Red Hat build of Apicurio Registry | 3.1 |
| Red Hat Advanced Cluster Management | 2.17 |
| Node.js (UBI base image) | 22 |
| Kubernetes Gateway API | v1 |
