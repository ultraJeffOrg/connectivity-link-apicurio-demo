const express = require('express');
const dns = require('dns').promises;
const path = require('path');
const yaml = require('js-yaml');
const { getAllClustersStatus, getClusterPolicies, scaleDeployment } = require('./lib/hub-queries');
const { proxyRequest, blastRateLimit } = require('./lib/incident-proxy');
const { fetchSpec, askClaude } = require('./lib/ai-consumer');
const { cleanupOrphans: cleanupViews } = require('./lib/managed-cluster-view');
const { cleanupOrphans: cleanupActions } = require('./lib/managed-cluster-action');

const app = express();
const PORT = process.env.PORT || 4000;
const INCIDENT_HOST = process.env.INCIDENT_API_HOST || 'incidents.sandbox4020.opentlc.com';
const SPOKE_CLUSTERS = (process.env.SPOKE_CLUSTERS || 'blue,aws-ai').split(',');

const CLUSTER_META = {
  'blue': { cloud: 'Azure', region: 'centralus', color: '#0078d4' },
  'aws-ai': { cloud: 'AWS', region: 'us-east-2', color: '#ff9900' },
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Cluster Status ---

app.get('/api/clusters', async (req, res) => {
  try {
    const statuses = await getAllClustersStatus(SPOKE_CLUSTERS);
    const enriched = statuses.map(s => ({
      ...s,
      meta: CLUSTER_META[s.cluster] || { cloud: 'Unknown' },
    }));
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/dns', async (req, res) => {
  try {
    const addresses = await dns.resolve4(INCIDENT_HOST).catch(() => []);
    let cname = null;
    try { cname = await dns.resolveCname(INCIDENT_HOST); } catch {}
    res.json({ hostname: INCIDENT_HOST, addresses, cname });
  } catch (e) {
    res.json({ hostname: INCIDENT_HOST, addresses: [], cname: null, error: e.message });
  }
});

app.post('/api/clusters/:cluster/scale', async (req, res) => {
  const { cluster } = req.params;
  const { replicas } = req.body;
  if (!SPOKE_CLUSTERS.includes(cluster)) {
    return res.status(400).json({ error: `Unknown cluster: ${cluster}` });
  }
  if (replicas !== 0 && replicas !== 1) {
    return res.status(400).json({ error: 'replicas must be 0 or 1' });
  }
  try {
    const result = await scaleDeployment(cluster, replicas);
    res.json({ cluster, replicas, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Test which cluster responds via the DNS hostname
app.get('/api/test/endpoint', async (req, res) => {
  try {
    const result = await proxyRequest('GET', '/healthz');
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Policies ---

app.get('/api/policies', async (req, res) => {
  try {
    const cluster = SPOKE_CLUSTERS[0];
    const policies = await getClusterPolicies(cluster);
    res.json({
      cluster,
      rateLimit: policies.rateLimit ? yaml.dump(policies.rateLimit) : null,
      auth: policies.auth ? yaml.dump(policies.auth) : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/test/ratelimit', async (req, res) => {
  try {
    const count = req.body.count || 60;
    const result = await blastRateLimit(count);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/test/auth', async (req, res) => {
  try {
    const { withKey } = req.body;
    const result = await proxyRequest('GET', '/api/incidents', { withApiKey: !!withKey });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Generic proxy (for endpoint explorer) ---

app.post('/api/proxy', async (req, res) => {
  const { method, path: reqPath } = req.body;
  if (!method || !reqPath) return res.status(400).json({ error: 'method and path required' });
  try {
    const result = await proxyRequest(method, reqPath);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Incident API Proxy ---

app.get('/api/incidents', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const p = `/api/incidents${qs ? '?' + qs : ''}`;
    const result = await proxyRequest('GET', p);
    res.status(result.response.status).json(result.response.body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/incidents', async (req, res) => {
  try {
    const result = await proxyRequest('POST', '/api/incidents', { body: req.body });
    res.status(result.response.status).json(result.response.body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.patch('/api/incidents/:id', async (req, res) => {
  try {
    const result = await proxyRequest('PATCH', `/api/incidents/${req.params.id}`, { body: req.body });
    res.status(result.response.status).json(result.response.body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- Apicurio Registry ---

app.get('/api/registry/spec', async (req, res) => {
  try {
    const spec = await fetchSpec();
    res.json({
      spec,
      parsed: yaml.load(spec),
      registryUrl: process.env.APICURIO_REGISTRY_URL || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- AI Consumer ---

app.post('/api/ai/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    await askClaude(question, (chunk) => {
      res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
    });
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

// --- Config endpoint ---

app.get('/api/config', (req, res) => {
  res.json({
    clusters: SPOKE_CLUSTERS,
    clusterMeta: CLUSTER_META,
    incidentHost: INCIDENT_HOST,
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    hasRegistryUrl: !!process.env.APICURIO_REGISTRY_URL,
  });
});

// --- Startup ---

async function start() {
  console.log('Cleaning up orphaned dashboard resources...');
  await Promise.all([cleanupViews(SPOKE_CLUSTERS), cleanupActions(SPOKE_CLUSTERS)]);

  app.listen(PORT, () => {
    console.log(`RHCL Dashboard running at http://localhost:${PORT}`);
    console.log(`Spoke clusters: ${SPOKE_CLUSTERS.join(', ')}`);
    console.log(`Incident API: ${INCIDENT_HOST}`);
  });
}

start().catch(e => {
  console.error('Failed to start:', e.message);
  process.exit(1);
});
