// Optional vector add-on for search. Off by default (RAG_EMBEDDINGS unset or "none").
//
// Two providers, both local:
//   - "ngram": built in, no download, no network. Hashes character trigrams into a 256-number vector.
//     It is NOT a semantic model: it helps with typos and word variants, not with synonyms.
//   - "ollama": a real embedding model served by Ollama on this machine. Only loopback URLs are accepted
//     (127.0.0.1, ::1 or localhost), redirects are refused, so note text never leaves the computer.

export interface Embedder {
  readonly id: string;
  readonly minSimilarity: number; // vector hits below this cosine similarity are ignored
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbeddingSettings {
  provider: "none" | "ngram" | "ollama";
  ollamaUrl: string;
  ollamaModel: string;
  minSimilarity?: number;
  timeoutMs: number;
}

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "nomic-embed-text";

export function parseEmbeddingSettings(env: NodeJS.ProcessEnv): EmbeddingSettings {
  const provider = (env.RAG_EMBEDDINGS || "none").trim().toLowerCase();
  if (provider !== "none" && provider !== "ngram" && provider !== "ollama") {
    throw new Error("RAG_EMBEDDINGS must be none, ngram or ollama");
  }

  const ollamaUrl = (env.RAG_OLLAMA_URL || DEFAULT_OLLAMA_URL).trim();
  if (provider === "ollama") {
    assertLoopbackUrl(ollamaUrl);
  }

  const minSimilarity = env.RAG_MIN_SIMILARITY ? Number(env.RAG_MIN_SIMILARITY) : undefined;
  if (minSimilarity !== undefined && !(minSimilarity >= -1 && minSimilarity <= 1)) {
    throw new Error("RAG_MIN_SIMILARITY must be a number from -1 to 1");
  }

  return {
    provider,
    ollamaUrl,
    ollamaModel: (env.RAG_OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL).trim(),
    minSimilarity,
    timeoutMs: 30_000,
  };
}

export function createEmbedder(settings: EmbeddingSettings, fetchImpl: typeof fetch = fetch): Embedder | undefined {
  switch (settings.provider) {
    case "none":
      return undefined;
    case "ngram":
      return createNgramEmbedder(256, settings.minSimilarity);
    case "ollama":
      return createOllamaEmbedder(settings, fetchImpl);
  }
}

// Throws unless the URL points at this machine. Used for every embedding request, not only at startup.
export function assertLoopbackUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("RAG_OLLAMA_URL is not a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("RAG_OLLAMA_URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("RAG_OLLAMA_URL must not contain credentials");
  }

  const host = url.hostname.replace(/^\[(.*)]$/, "$1").toLowerCase();
  const isLoopback = host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  if (!isLoopback) {
    throw new Error("RAG_OLLAMA_URL must point at this machine (127.0.0.1, ::1 or localhost); notes are never sent elsewhere");
  }

  return url;
}

export function createNgramEmbedder(dims = 256, minSimilarity = 0.35): Embedder {
  return {
    id: `ngram-${dims}`,
    minSimilarity,
    async embed(texts) {
      return texts.map((text) => ngramVector(text, dims));
    },
  };
}

function ngramVector(text: string, dims: number): Float32Array {
  const vector = new Float32Array(dims);
  const words = text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const word of words) {
    const padded = ` ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) {
      const hash = fnv1a(padded.slice(i, i + 3));
      vector[hash % dims] += hash & 0x80000000 ? -1 : 1;
    }
  }
  return normalizeVector(vector);
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function createOllamaEmbedder(settings: EmbeddingSettings, fetchImpl: typeof fetch = fetch): Embedder {
  const base = assertLoopbackUrl(settings.ollamaUrl);
  const endpoint = new URL("/api/embed", base);

  return {
    id: `ollama:${settings.ollamaModel}`,
    minSimilarity: settings.minSimilarity ?? 0.45,
    async embed(texts) {
      assertLoopbackUrl(endpoint.href);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: settings.ollamaModel, input: texts }),
        redirect: "error",
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Embedding server answered HTTP ${response.status}`);
      }

      const body = (await response.json()) as { embeddings?: unknown };
      const embeddings = body.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        throw new Error("Embedding server returned an unexpected response");
      }

      return embeddings.map((row) => {
        if (!Array.isArray(row) || row.length === 0 || row.length > 8192 || !row.every(Number.isFinite)) {
          throw new Error("Embedding server returned an invalid vector");
        }
        return normalizeVector(Float32Array.from(row as number[]));
      });
    },
  };
}

export function normalizeVector(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vector.length; i += 1) {
      vector[i] /= norm;
    }
  }
  return vector;
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
}
