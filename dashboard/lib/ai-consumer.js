const Anthropic = require('@anthropic-ai/sdk').default;

const REGISTRY_URL = process.env.APICURIO_REGISTRY_URL || 'http://localhost:8080';
const GROUP = process.env.APICURIO_GROUP || 'incident-api';
const ARTIFACT_ID = process.env.APICURIO_ARTIFACT_ID || 'incident-management-api';

let cachedSpec = null;

async function fetchSpec() {
  if (cachedSpec) return cachedSpec;
  const url = `${REGISTRY_URL}/apis/registry/v3/groups/${GROUP}/artifacts/${ARTIFACT_ID}/versions/branch=latest/content`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch spec: ${resp.status}`);
  cachedSpec = await resp.text();
  return cachedSpec;
}

function clearSpecCache() {
  cachedSpec = null;
}

async function askClaude(question, onChunk) {
  const client = new Anthropic();
  let spec;
  try {
    spec = await fetchSpec();
  } catch (e) {
    throw new Error(`Could not fetch API spec from Apicurio Registry: ${e.message}`);
  }

  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Here is the OpenAPI specification for the Incident Management API:\n\n${spec}`,
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: `Based on the API spec above, ${question}\n\nProvide a clear explanation and working curl command examples using the gateway URL http://${process.env.INCIDENT_API_HOST || 'incidents.sandbox4020.opentlc.com'} with the header "x-api-key: demo-key-12345".`,
        },
      ],
    }],
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      onChunk(event.delta.text);
    }
  }
}

module.exports = { fetchSpec, clearSpecCache, askClaude };
