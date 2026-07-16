const { customObjectsApi } = require('./k8s-client');
const crypto = require('crypto');

const GROUP = 'view.open-cluster-management.io';
const VERSION = 'v1beta1';
const PLURAL = 'managedclusterviews';
const LABEL = 'app.kubernetes.io/managed-by';
const LABEL_VALUE = 'rhcl-dashboard';

function viewName(prefix) {
  const suffix = crypto.randomBytes(3).toString('hex');
  return `dash-${prefix}-${suffix}`;
}

async function createView(clusterName, name, scope) {
  const body = {
    apiVersion: `${GROUP}/${VERSION}`,
    kind: 'ManagedClusterView',
    metadata: {
      name,
      namespace: clusterName,
      labels: { [LABEL]: LABEL_VALUE },
    },
    spec: { scope },
  };
  await customObjectsApi.createNamespacedCustomObject({
    group: GROUP, version: VERSION, namespace: clusterName, plural: PLURAL, body,
  });
}

async function getViewResult(clusterName, name, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await customObjectsApi.getNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace: clusterName, plural: PLURAL, name,
    });
    const obj = resp.body || resp;
    if (obj.status?.result) return obj.status.result;
    const cond = obj.status?.conditions?.[0];
    if (cond?.reason === 'GetResourceFailed') {
      throw new Error(cond.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ManagedClusterView ${name}`);
}

async function deleteView(clusterName, name) {
  try {
    await customObjectsApi.deleteNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace: clusterName, plural: PLURAL, name,
    });
  } catch (e) {
    const code = e.body?.code || e.statusCode;
    if (code !== 404) throw e;
  }
}

async function viewResource(clusterName, scope, prefix = 'view') {
  const name = viewName(prefix);
  try {
    await createView(clusterName, name, scope);
    return await getViewResult(clusterName, name);
  } finally {
    await deleteView(clusterName, name);
  }
}

async function cleanupOrphans(clusters) {
  for (const cluster of clusters) {
    try {
      const resp = await customObjectsApi.listNamespacedCustomObject({
        group: GROUP, version: VERSION, namespace: cluster, plural: PLURAL,
        labelSelector: `${LABEL}=${LABEL_VALUE}`,
      });
      const list = resp.body || resp;
      for (const item of list.items || []) {
        await deleteView(cluster, item.metadata.name);
      }
    } catch (e) {
      // Ignore errors during cleanup
    }
  }
}

module.exports = { viewResource, cleanupOrphans };
