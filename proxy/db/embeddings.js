const ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const KEY = process.env.AZURE_OPENAI_KEY;
const DEPLOYMENT = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || "text-embedding-3-small";
const API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "2024-06-01";
const BATCH_SIZE = 16;

function isConfigured() {
  return Boolean(ENDPOINT && KEY);
}

function buildUrl() {
  const base = ENDPOINT.replace(/\/+$/, "");
  return `${base}/openai/deployments/${DEPLOYMENT}/embeddings?api-version=${API_VERSION}`;
}

async function callApi(input) {
  if (!isConfigured()) {
    throw new Error("AZURE_OPENAI_* env vars missing");
  }
  const res = await fetch(buildUrl(), {
    method: "POST",
    headers: {
      "api-key": KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Azure OpenAI embeddings ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data.map((d) => d.embedding);
}

async function embedText(text) {
  const [vec] = await callApi(text);
  return vec;
}

async function embedBatch(texts) {
  if (!isConfigured()) {
    throw new Error("AZURE_OPENAI_* env vars missing");
  }
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const chunk = texts.slice(i, i + BATCH_SIZE);
    const vecs = await callApi(chunk);
    out.push(...vecs);
  }
  return out;
}

function pgvectorLiteral(arr) {
  return `[${arr.join(",")}]`;
}

module.exports = {
  isConfigured,
  embedText,
  embedBatch,
  pgvectorLiteral,
};
