let config = {};
let clusterAddresses = {};

async function init() {
  try {
    const resp = await fetch('/api/config');
    config = await resp.json();
    document.getElementById('connection-status').classList.add('connected');
  } catch {
    document.getElementById('connection-status').classList.add('error');
    return;
  }

  refreshClusters();
  refreshDns();
  loadPolicies();
  refreshIncidents();
  initRegistry();
  initAI();

  setInterval(() => { refreshClusters(); refreshDns(); }, 12000);
}

// --- Request Log Rendering ---

function identifyIp(ip) {
  if (!ip) return null;
  for (const [addr, cluster] of Object.entries(clusterAddresses)) {
    if (addr === ip || (addr.includes('.elb.') && ip === addr)) return cluster;
  }
  return null;
}

function routedToLabel(entry) {
  const ips = entry.resolvedIps || (entry.connectedIp ? [entry.connectedIp] : []);
  if (!ips.length) return '';

  const identified = ips.map(ip => {
    const cluster = identifyIp(ip);
    return cluster
      ? `<strong>${cluster}</strong> (${config.clusterMeta?.[cluster]?.cloud || '?'})`
      : ip;
  });
  const unique = [...new Set(identified)];
  return `<span class="routed-to">DNS resolved to ${ips.join(', ')} &rarr; ${unique.join(', ')}</span>`;
}

function renderRequestLog(containerId, entry) {
  const container = document.getElementById(containerId);
  container.style.display = 'block';

  const id = 'req-' + Date.now() + Math.random().toString(36).slice(2, 6);
  const statusClass = entry.response.status < 300 ? 'status-2xx'
    : entry.response.status === 429 ? 'status-429'
    : entry.response.status < 500 ? 'status-4xx' : 'status-5xx';

  const routedLabel = routedToLabel(entry);

  const html = `
    <div class="req-entry" onclick="document.getElementById('${id}').classList.toggle('open')">
      <div class="req-summary">
        <span class="method method-${entry.request.method}">${entry.request.method}</span>
        <span class="req-url">${entry.request.url}</span>
        <span class="req-status ${statusClass}">${entry.response.status} ${entry.response.statusText || ''}</span>
        <span class="req-duration">${entry.duration}ms</span>
      </div>
      ${routedLabel ? `<div style="font-size:11px;margin-top:4px">${routedLabel}</div>` : ''}
      <div class="req-detail" id="${id}">
        <h4>Request Headers</h4>
        <pre>${JSON.stringify(entry.request.headers, null, 2)}</pre>
        ${entry.resolvedIps?.length ? `<h4>DNS Resolution</h4><pre>${entry.resolvedIps.join(', ')}</pre>` : ''}
        <h4>Response Headers</h4>
        <pre>${JSON.stringify(entry.response.headers, null, 2)}</pre>
        <h4>Response Body</h4>
        <pre>${typeof entry.response.body === 'string' ? entry.response.body : JSON.stringify(entry.response.body, null, 2)}</pre>
      </div>
    </div>`;

  container.insertAdjacentHTML('afterbegin', html);
}

function clearLog(containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  container.style.display = 'none';
}

// --- Section 1: Cluster Status ---

async function refreshClusters() {
  try {
    const resp = await fetch('/api/clusters');
    const clusters = await resp.json();
    clusters.forEach(c => {
      c.gateway.addresses.forEach(a => {
        clusterAddresses[a.value] = c.cluster;
      });
      if (c.gatewayIps) {
        c.gatewayIps.forEach(ip => {
          clusterAddresses[ip] = c.cluster;
        });
      }
    });
    renderClusters(clusters);
  } catch (e) {
    document.getElementById('cluster-cards').innerHTML = `<p style="color:var(--neon-red)">Error: ${e.message}</p>`;
  }
}

function renderClusters(clusters) {
  const container = document.getElementById('cluster-cards');
  container.innerHTML = clusters.map(c => {
    const meta = c.meta || {};
    const cloudClass = meta.cloud === 'Azure' ? 'cloud-azure' : meta.cloud === 'AWS' ? 'cloud-aws' : '';
    const gwAddr = c.gateway.addresses.map(a => {
      const label = a.type === 'IPAddress' ? `${a.value}` : `${a.value.split('.')[0]}...`;
      return `<span class="val">${label}</span>`;
    }).join(', ') || '<span class="val fail">No address</span>';

    const isServing = c.servingTraffic;
    const isDown = c.deployment.desiredReplicas === 0 || c.deployment.readyReplicas === 0;
    const statusLabel = isServing ? 'SERVING TRAFFIC' : isDown ? 'DOWN' : 'NOT SERVING';
    const statusClass = isServing ? 'ok' : 'fail';
    const cardClass = isDown ? 'unhealthy' : 'healthy';

    return `
    <div class="cluster-card ${cardClass}">
      <div class="card-header">
        <span class="health-dot"></span>
        <span class="cluster-name">${c.cluster}</span>
        <span class="cloud-label ${cloudClass}">${meta.cloud || '?'} / ${meta.region || '?'}</span>
      </div>
      ${isDown ? '<div class="down-banner">DOWN</div>' : ''}
      <div class="stat"><label>Status</label> <span class="val ${statusClass}">${statusLabel}</span></div>
      <div class="stat"><label>Replicas</label> <span class="val ${c.deployment.readyReplicas > 0 ? 'ok' : 'fail'}">${c.deployment.readyReplicas}/${c.deployment.desiredReplicas || c.deployment.replicas}</span></div>
      <div class="stat"><label>Gateway</label> ${gwAddr}</div>
      <div class="stat"><label>IPs</label> <span class="val">${(c.gatewayIps || []).join(', ') || 'none'}</span></div>
      <div class="stat"><label>DNS</label> <span class="val ${c.dns.healthy ? 'ok' : 'fail'}">${c.dns.healthy ? 'Healthy' : 'Unhealthy'}${c.dns.enforced ? ', Enforced' : ''}</span></div>
      <div class="card-actions">
        ${!isDown
          ? `<button class="btn btn-danger" onclick="scaleCluster('${c.cluster}', 0)">Take ${c.cluster} Down</button>`
          : `<button class="btn btn-success" onclick="scaleCluster('${c.cluster}', 1)">Bring ${c.cluster} Back Up</button>`}
      </div>
    </div>`;
  }).join('');
}

async function scaleCluster(cluster, replicas) {
  const action = replicas === 0 ? 'trigger failover on' : 'restore';
  if (!confirm(`${action} ${cluster}?`)) return;

  try {
    const resp = await fetch(`/api/clusters/${cluster}/scale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replicas }),
    });
    const data = await resp.json();

    const log = document.getElementById('failover-log');
    log.style.display = 'block';
    const time = new Date().toLocaleTimeString();
    const others = config.clusters.filter(c => c !== cluster).join(', ');
    const msg = replicas === 0
      ? `<span style="color:var(--neon-red)">[${time}] Taking ${cluster} down (0 replicas). Health checks will fail in ~3 min, then DNS will route all traffic to ${others}.</span>`
      : `<span style="color:var(--neon-green)">[${time}] Bringing ${cluster} back up (1 replica). Once healthy, DNS will add it back and traffic will be load-balanced again.</span>`;
    log.insertAdjacentHTML('afterbegin', `<div class="req-entry"><div class="req-summary">${msg}</div></div>`);

    setTimeout(refreshClusters, 3000);
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
}

async function refreshDns() {
  try {
    const resp = await fetch('/api/dns');
    const data = await resp.json();
    const el = document.getElementById('dns-status');
    if (data.addresses.length > 0) {
      const labeled = data.addresses.map(ip => {
        const cluster = clusterAddresses[ip];
        const meta = cluster ? config.clusterMeta?.[cluster] : null;
        if (cluster) {
          return `${ip} <span style="color:var(--neon-purple)">(${cluster} / ${meta?.cloud || '?'})</span>`;
        }
        return ip;
      });
      el.innerHTML = `${data.hostname} &rarr; ${labeled.join(', ')}`;
    } else if (data.cname?.length > 0) {
      el.innerHTML = `${data.hostname} &rarr; CNAME: ${data.cname[0]}`;
    } else {
      el.innerHTML = `${data.hostname} &rarr; <span style="color:var(--text-dim)">No records (DNS propagating)</span>`;
    }
  } catch (e) {
    document.getElementById('dns-status').textContent = `Error: ${e.message}`;
  }
}

async function testEndpoint() {
  try {
    const resp = await fetch('/api/test/endpoint');
    const data = await resp.json();
    renderRequestLog('failover-log', data);
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
}

// --- Section 2: Policies ---

async function loadPolicies() {
  try {
    const resp = await fetch('/api/policies');
    const data = await resp.json();
    document.getElementById('ratelimit-yaml').textContent = data.rateLimit || 'Not found';
    document.getElementById('auth-yaml').textContent = data.auth || 'Not found';
  } catch (e) {
    document.getElementById('ratelimit-yaml').textContent = `Error: ${e.message}`;
  }
}

async function testRateLimit() {
  const result = document.getElementById('ratelimit-result');
  result.innerHTML = '<span style="color:var(--text-dim)">Sending 60 requests...</span>';
  clearLog('ratelimit-log');

  try {
    const resp = await fetch('/api/test/ratelimit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 60 }),
    });
    const data = await resp.json();

    const badges = Object.entries(data.summary).map(([status, count]) => {
      const cls = status === '200' ? 'status-2xx' : status === '429' ? 'status-429' : 'status-5xx';
      return `<span class="badge ${cls}" style="background:rgba(${status==='200'?'0,255,136':'255,136,0'},0.15)">${count}x ${status}</span>`;
    });
    const rlRouted = data.resolvedIps?.length ? routedToLabel(data) : '';
    result.innerHTML = `Sent ${data.total} to <span style="color:var(--neon-cyan)">${data.request.url}</span>: ${badges.join(' ')}${rlRouted ? '<br>' + rlRouted : ''}`;

    const log = document.getElementById('ratelimit-log');
    log.style.display = 'block';
    log.innerHTML = `<div class="req-entry">
      <div class="req-summary">
        <span class="method method-GET">GET</span>
        <span class="req-url">${data.request.url}</span>
        <span style="color:var(--text-dim)">x${data.total}</span>
      </div>
      <div class="req-detail open">
        <h4>Request Headers</h4>
        <pre>${JSON.stringify(data.request.headers, null, 2)}</pre>
        <h4>Results (per request)</h4>
        <pre>${data.results.map(r => `#${r.i+1}: ${r.status}${r.error ? ' ('+r.error+')' : ''}`).join('\n')}</pre>
      </div>
    </div>`;
  } catch (e) {
    result.innerHTML = `<span style="color:var(--neon-red)">Error: ${e.message}</span>`;
  }
}

async function testAuth(withKey) {
  try {
    const resp = await fetch('/api/test/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ withKey }),
    });
    const data = await resp.json();
    renderRequestLog('auth-log', data);
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
}

// --- Section 3: Incidents ---

async function hitEndpoint(method, path) {
  try {
    const resp = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, path }),
    });
    const data = await resp.json();
    renderRequestLog('endpoint-log', data);
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
}

async function refreshIncidents() {
  try {
    const resp = await fetch('/api/incidents');
    if (!resp.ok) {
      document.getElementById('incident-tbody').innerHTML = `<tr><td colspan="5" style="color:var(--neon-red)">API returned ${resp.status}</td></tr>`;
      return;
    }
    const incidents = await resp.json();
    document.getElementById('incident-tbody').innerHTML = incidents.map(inc => `
      <tr>
        <td style="font-family:var(--mono);font-size:12px">${inc.id}</td>
        <td>${inc.title}</td>
        <td class="severity-${inc.severity}">${inc.severity}</td>
        <td>${inc.status}</td>
        <td>${inc.reportedBy || '-'}</td>
      </tr>
    `).join('');
  } catch (e) {
    document.getElementById('incident-tbody').innerHTML = `<tr><td colspan="5" style="color:var(--neon-red)">Error: ${e.message}</td></tr>`;
  }
}

async function createIncident(e) {
  e.preventDefault();
  const form = e.target;
  const body = {
    title: form.title.value,
    severity: form.severity.value,
    description: form.description.value || undefined,
    reportedBy: form.reportedBy.value || undefined,
  };
  try {
    await fetch('/api/incidents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    form.reset();
    refreshIncidents();
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
}

// --- Section 4: Apicurio Registry ---

async function initRegistry() {
  if (!config.hasRegistryUrl) {
    document.getElementById('registry-unavailable').style.display = 'block';
    return;
  }
  try {
    const resp = await fetch('/api/registry/spec');
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    const parsed = data.parsed;
    let html = `<p style="margin-bottom:12px"><strong style="color:var(--neon-cyan)">${parsed.info.title}</strong> <span style="color:var(--text-dim)">v${parsed.info.version}</span></p>`;
    if (parsed.info.description) html += `<p style="margin-bottom:12px;color:var(--text-dim)">${parsed.info.description}</p>`;

    for (const [path, methods] of Object.entries(parsed.paths || {})) {
      for (const [method, detail] of Object.entries(methods)) {
        if (['get', 'post', 'patch', 'put', 'delete'].includes(method)) {
          html += `<div class="endpoint">
            <span class="method method-${method}">${method.toUpperCase()}</span>
            <span>${path}</span>
            <span style="color:var(--text-dim);margin-left:auto;font-size:11px">${detail.summary || ''}</span>
          </div>`;
        }
      }
    }

    if (data.registryUrl) {
      html += `<p style="margin-top:14px"><a href="${data.registryUrl}" target="_blank" style="color:var(--neon-pink)">Open Apicurio Registry UI</a></p>`;
    }

    document.getElementById('registry-spec').innerHTML = html;
    document.getElementById('registry-raw').textContent = data.spec;
    document.getElementById('toggle-spec-btn').style.display = 'inline-block';
  } catch (e) {
    document.getElementById('registry-spec').innerHTML = `<p style="color:var(--neon-red)">Error: ${e.message}</p>`;
  }
}

function toggleRawSpec() {
  const raw = document.getElementById('registry-raw');
  const btn = document.getElementById('toggle-spec-btn');
  if (raw.style.display === 'none') { raw.style.display = 'block'; btn.textContent = 'Hide Raw YAML'; }
  else { raw.style.display = 'none'; btn.textContent = 'Show Raw YAML'; }
}

// --- Section 5: AI Assistant ---

function initAI() {
  if (config.hasAnthropicKey && config.hasRegistryUrl) {
    document.getElementById('ai-container').style.display = 'flex';
  } else {
    document.getElementById('ai-unavailable').style.display = 'block';
  }
}

function submitAI(e) {
  e.preventDefault();
  const input = document.getElementById('ai-input');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  askAI(question);
}

async function askAI(question) {
  const messages = document.getElementById('chat-messages');

  const userMsg = document.createElement('div');
  userMsg.className = 'chat-msg user';
  userMsg.textContent = question;
  messages.appendChild(userMsg);

  const assistantMsg = document.createElement('div');
  assistantMsg.className = 'chat-msg assistant';
  assistantMsg.textContent = '';
  messages.appendChild(assistantMsg);
  messages.scrollTop = messages.scrollHeight;

  try {
    const resp = await fetch('/api/ai/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.text) { assistantMsg.textContent += data.text; messages.scrollTop = messages.scrollHeight; }
          if (data.error) assistantMsg.textContent += `\nError: ${data.error}`;
        } catch {}
      }
    }
  } catch (e) {
    assistantMsg.textContent = `Error: ${e.message}`;
  }
}

document.addEventListener('DOMContentLoaded', init);
