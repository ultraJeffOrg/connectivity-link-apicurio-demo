const dns = require('dns');
const { viewResource } = require('./managed-cluster-view');
const { executeAction } = require('./managed-cluster-action');

function resolveHostname(hostname) {
  return new Promise((resolve) => {
    const resolver = new dns.Resolver();
    resolver.resolve4(hostname, (err, ips) => resolve(err ? [] : ips));
  });
}

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
  const desiredReplicas = deployment?.spec?.replicas ?? 1;
  const addresses = gateway?.status?.addresses || [];
  const gwConditions = gateway?.status?.conditions || [];
  const dnsConditions = dnsPolicy?.status?.conditions || [];
  const recordConditions = dnsPolicy?.status?.recordConditions || {};

  const programmed = gwConditions.find(c => c.type === 'Programmed');
  const enforced = dnsConditions.find(c => c.type === 'Enforced');
  const dnsHealthy = dnsConditions.find(c => c.type === 'SubResourcesHealthy');

  // Resolve hostname-type addresses (ELB) to actual IPs
  let gatewayIps = [];
  for (const addr of addresses) {
    if (addr.type === 'IPAddress') {
      gatewayIps.push(addr.value);
    } else if (addr.type === 'Hostname') {
      const resolved = await resolveHostname(addr.value);
      gatewayIps.push(...resolved);
    }
  }

  const appUp = readyReplicas > 0 && desiredReplicas > 0;

  return {
    cluster,
    deployment: { replicas, readyReplicas, desiredReplicas },
    gateway: {
      addresses: addresses.map(a => ({ type: a.type, value: a.value })),
      programmed: programmed?.status === 'True',
    },
    gatewayIps,
    dns: {
      enforced: enforced?.status === 'True',
      healthy: dnsHealthy?.status === 'True',
      records: recordConditions,
    },
    healthy: appUp && programmed?.status === 'True',
    servingTraffic: appUp && dnsHealthy?.status === 'True',
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
  let deploy;
  try {
    deploy = await viewResource(cluster, {
      apiGroup: 'apps', kind: 'Deployment', version: 'v1',
      name: 'incident-api', namespace: 'incident-api',
    }, `getdeploy-${cluster}`);
  } catch (e) {
    throw new Error(`Could not read Deployment on ${cluster}: ${e.message}`);
  }
  if (!deploy?.spec) throw new Error(`Deployment not found on ${cluster}`);

  deploy.spec.replicas = replicas;
  delete deploy.metadata.managedFields;
  delete deploy.metadata.resourceVersion;
  delete deploy.status;

  return executeAction(cluster, 'Update', {
    resource: 'deployments',
    namespace: 'incident-api',
    name: 'incident-api',
    template: deploy,
  }, `scale-${cluster}`);
}

module.exports = { getAllClustersStatus, getClusterPolicies, scaleDeployment };
