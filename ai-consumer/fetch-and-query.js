/**
 * Fetches an OpenAPI spec from Apicurio Registry and uses it as context
 * for Claude to answer questions about — or generate calls to — the API.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... \
 *   APICURIO_REGISTRY_URL=https://apicurio-registry.apps.mycluster.example.com \
 *   node fetch-and-query.js "How do I create a critical incident?"
 */

const Anthropic = require("@anthropic-ai/sdk");

const REGISTRY_URL =
  process.env.APICURIO_REGISTRY_URL || "http://localhost:8080";
const GROUP = process.env.APICURIO_GROUP || "incident-api";
const ARTIFACT_ID =
  process.env.APICURIO_ARTIFACT_ID || "incident-management-api";

async function fetchSpecFromApicurio() {
  const url = `${REGISTRY_URL}/apis/registry/v3/groups/${GROUP}/artifacts/${ARTIFACT_ID}/versions/branch=latest/content`;
  console.log(`Fetching spec from: ${url}\n`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch spec: ${res.status} ${res.statusText}\n${await res.text()}`
    );
  }
  return res.text();
}

async function askClaudeAboutApi(spec, question) {
  const client = new Anthropic();

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Here is an OpenAPI specification for an API I have access to:\n\n${spec}`,
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: `Based on this API spec, ${question}\n\nProvide a concrete curl command I can run, and explain what it does.`,
          },
        ],
      },
    ],
  });

  return message.content[0].text;
}

async function main() {
  const question = process.argv[2] || "What endpoints are available?";

  console.log("--- Apicurio Registry -> AI Demo ---\n");

  const spec = await fetchSpecFromApicurio();
  console.log(`Fetched spec (${spec.length} bytes)\n`);

  console.log(`Question: ${question}\n`);
  console.log("--- Claude's response ---\n");

  const answer = await askClaudeAboutApi(spec, question);
  console.log(answer);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
