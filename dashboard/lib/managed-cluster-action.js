const { customObjectsApi } = require('./k8s-client');
const crypto = require('crypto');

const GROUP = 'action.open-cluster-management.io';
const VERSION = 'v1beta1';
const PLURAL = 'managedclusteractions';
const LABEL = 'app.kubernetes.io/managed-by';
const LABEL_VALUE = 'rhcl-dashboard';

function actionName(prefix) {
  const suffix = crypto.randomBytes(3).toString('hex');
  return `dash-${prefix}-${suffix}`;
}

async function createAction(clusterName, name, actionType, kube) {
  const body = {
    apiVersion: `${GROUP}/${VERSION}`,
    kind: 'ManagedClusterAction',
    metadata: {
      name,
      namespace: clusterName,
      labels: { [LABEL]: LABEL_VALUE },
    },
    spec: { actionType, kube },
  };
  await customObjectsApi.createNamespacedCustomObject({
    group: GROUP, version: VERSION, namespace: clusterName, plural: PLURAL, body,
  });
}

async function waitForAction(clusterName, name, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await customObjectsApi.getNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace: clusterName, plural: PLURAL, name,
    });
    const obj = resp.body || resp;
    const cond = obj.status?.conditions?.[0];
    if (cond) return cond;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ManagedClusterAction ${name}`);
}

async function deleteAction(clusterName, name) {
  try {
    await customObjectsApi.deleteNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace: clusterName, plural: PLURAL, name,
    });
  } catch (e) {
    const code = e.body?.code || e.statusCode;
    if (code !== 404) throw e;
  }
}

async function executeAction(clusterName, actionType, kube, prefix = 'action') {
  const name = actionName(prefix);
  try {
    await createAction(clusterName, name, actionType, kube);
    return await waitForAction(clusterName, name);
  } finally {
    await deleteAction(clusterName, name);
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
        await deleteAction(cluster, item.metadata.name);
      }
    } catch (e) {
      // Ignore errors during cleanup
    }
  }
}

module.exports = { executeAction, cleanupOrphans };
