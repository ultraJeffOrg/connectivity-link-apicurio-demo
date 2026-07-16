const { viewResource } = require('./managed-cluster-view');
const { executeAction } = require('./managed-cluster-action');

async function getClusterStatus(cluster) {
  const [deployment, gateway, dnsPolicy] = await Promise.all([
    viewResource(cluster, {
      apiGroup: 'apps', kind: 'Deployment', version: 'v1',
      name: 'incident-api', namespace: 'incident-api',
    }, `deploy-${cluster}`).catch(() => null),
    viewResource(cluster, {
      apiGroup: 'gateway.networking.k8s.io', kind: 'Gateway', version: 'v1',
      name: 'incident-api-gateway', namespace: 'incident-api',
    }, `gw-${cluster}`).catch(() => null),
    viewResource(cluster, {
      apiGroup: 'kuadrant.io', kind: 'DNSPolicy', version: 'v1',
      name: 'incident-api-dns', namespace: 'incident-api',
    }, `dns-${cluster}`).catch(() => null),
  ]);

  const replicas = deployment?.status?.replicas || 0;
  const readyReplicas = deployment?.status?.readyReplicas || 0;
  const addresses = gateway?.status?.addresses || [];
  const gwConditions = gateway?.status?.conditions || [];
  const dnsConditions = dnsPolicy?.status?.conditions || [];
  const recordConditions = dnsPolicy?.status?.recordConditions || {};

  const programmed = gwConditions.find(c => c.type === 'Programmed');
  const enforced = dnsConditions.find(c => c.type === 'Enforced');
  const healthy = dnsConditions.find(c => c.type === 'SubResourcesHealthy');

  return {
    cluster,
    deployment: { replicas, readyReplicas },
    gateway: {
      addresses: addresses.map(a => ({ type: a.type, value: a.value })),
      programmed: programmed?.status === 'True',
    },
    dns: {
      enforced: enforced?.status === 'True',
      healthy: healthy?.status === 'True',
      records: recordConditions,
    },
    healthy: readyReplicas > 0 && programmed?.status === 'True',
  };
}

async function getAllClustersStatus(clusters) {
  return Promise.all(clusters.map(c => getClusterStatus(c)));
}

async function getClusterPolicies(cluster) {
  const [rateLimit, auth] = await Promise.all([
    viewResource(cluster, {
      apiGroup: 'kuadrant.io', kind: 'RateLimitPolicy', version: 'v1',
      name: 'incident-api-ratelimit', namespace: 'incident-api',
    }, `rl-${cluster}`).catch(() => null),
    viewResource(cluster, {
      apiGroup: 'kuadrant.io', kind: 'AuthPolicy', version: 'v1',
      name: 'incident-api-auth', namespace: 'incident-api',
    }, `auth-${cluster}`).catch(() => null),
  ]);
  return { rateLimit: rateLimit?.spec || null, auth: auth?.spec || null };
}

async function scaleDeployment(cluster, replicas) {
  return executeAction(cluster, 'Update', {
    resource: 'deployments',
    namespace: 'incident-api',
    name: 'incident-api',
    template: {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'incident-api', namespace: 'incident-api' },
      spec: { replicas },
    },
  }, `scale-${cluster}`);
}

module.exports = { getAllClustersStatus, getClusterPolicies, scaleDeployment };
