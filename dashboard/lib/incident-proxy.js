const dns = require('dns').promises;

const INCIDENT_HOST = process.env.INCIDENT_API_HOST || 'incidents.sandbox4020.opentlc.com';
const API_KEY = process.env.INCIDENT_API_KEY || 'demo-key-12345';

function baseUrl() {
  return `http://${INCIDENT_HOST}`;
}

async function resolveHost() {
  try {
    const ips = await dns.resolve4(INCIDENT_HOST);
    return ips[0] || null;
  } catch {
    return null;
  }
}

async function proxyRequest(method, path, { body, withApiKey = true } = {}) {
  const url = `${baseUrl()}${path}`;
  const reqHeaders = { 'Content-Type': 'application/json' };
  if (withApiKey) reqHeaders['x-api-key'] = API_KEY;

  const resolvedIp = await resolveHost();

  const opts = { method, headers: reqHeaders };
  if (body) opts.body = JSON.stringify(body);

  const startTime = Date.now();
  const resp = await fetch(url, opts);
  const duration = Date.now() - startTime;
  const respBody = await resp.text();
  let data;
  try { data = JSON.parse(respBody); } catch { data = respBody; }

  return {
    request: {
      method,
      url,
      headers: reqHeaders,
    },
    response: {
      status: resp.status,
      statusText: resp.statusText,
      headers: Object.fromEntries(resp.headers),
      body: data,
    },
    resolvedIp,
    duration,
  };
}

async function blastRateLimit(count = 60) {
  const url = `${baseUrl()}/api/incidents`;
  const resolvedIp = await resolveHost();
  const results = [];
  const promises = [];
  for (let i = 0; i < count; i++) {
    promises.push(
      fetch(url, { headers: { 'x-api-key': API_KEY } })
        .then(r => results.push({ i, status: r.status }))
        .catch(e => results.push({ i, status: 0, error: e.message }))
    );
  }
  await Promise.all(promises);
  results.sort((a, b) => a.i - b.i);

  const summary = {};
  for (const r of results) {
    summary[r.status] = (summary[r.status] || 0) + 1;
  }
  return {
    request: { method: 'GET', url, headers: { 'x-api-key': API_KEY } },
    resolvedIp,
    total: count,
    summary,
    results,
  };
}

module.exports = { proxyRequest, blastRateLimit, baseUrl };
