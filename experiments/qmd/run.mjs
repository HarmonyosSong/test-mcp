// Isolated QMD 2.8.3 experiment. No production MCP/config changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pilot = path.join(root, '.data/qmd-pilot');
process.env.XDG_CACHE_HOME = path.join(pilot, 'cache');
process.env.QMD_CONFIG_DIR = path.join(pilot, 'config');
process.env.QMD_EMBED_PARALLELISM = '1';
// chunkDocumentByTokens 硬编码走 getDefaultLlamaCpp() 单例（store.js:2449），
// 单例只读环境变量；不设会把默认 embeddinggemma 从 HuggingFace 拉下来（网络挂起）。
process.env.QMD_EMBED_MODEL = path.join(pilot, 'models/Qwen3-Embedding-0.6B-Q8_0.gguf');
process.env.QMD_RERANK_MODEL = path.join(pilot, 'models/qwen3-reranker-0.6b-q8_0.gguf');
const { createStore } = await import(pathToFileURL(path.join(pilot, 'node_modules/@tobilu/qmd/dist/index.js')));
const config = {
  models: {
    embed: path.join(pilot, 'models/Qwen3-Embedding-0.6B-Q8_0.gguf'),
    rerank: path.join(pilot, 'models/qwen3-reranker-0.6b-q8_0.gguf'),
  },
  collections: {
    facts: { path: path.join(root, 'knowledge/facts'), pattern: '**/*.md' },
    symptoms: { path: path.join(root, 'knowledge/symptoms'), pattern: '*.md' },
  },
};
const store = await createStore({ dbPath: path.join(pilot, 'index.sqlite'), config });
const modeArg = process.argv[2] || 'all';
const fixture = JSON.parse(fs.readFileSync(path.join(pilot, 'fixtures.json'), 'utf8'));
const output = path.join(pilot, `results-${modeArg}.json`);
const artifact = { version: '2.8.3', started_at: new Date().toISOString(), config,
  corpus: fixture.corpus, cases: fixture.cases, rows: [],
  notes: ['Scores are not probabilities; minScore=0 collects raw candidates.',
    'hybrid uses original query as lex+vec; no generated query expansion.',
    'Local shared store; first inference includes model loading; later latency is warm.'] };
function save() { fs.writeFileSync(output, JSON.stringify(artifact, null, 2)); }
const modes = modeArg === 'all' ? ['bm25', 'vector', 'hybrid', 'rerank'] : [modeArg];
try {
  const start = performance.now();
  artifact.indexing = await store.update();
  artifact.indexing_ms = performance.now() - start;
  console.log(JSON.stringify({ indexing: artifact.indexing, collections: await store.listCollections() }));
  if (modes.some(m => m !== 'bm25')) {
    const started = performance.now();
    artifact.embedding = await store.embed({ maxDocsPerBatch: 10, maxBatchBytes: 4*1024*1024,
      onProgress: p => { if (p.current % 10 === 0) console.error(JSON.stringify(p)); } });
    artifact.embedding_ms = performance.now() - started;
    console.log(JSON.stringify({ embedding: artifact.embedding, ms: artifact.embedding_ms }));
  }
  save();
  for (const mode of modes) {
    for (const item of fixture.cases) {
      const started = performance.now();
      const row = { id: item.id, mode };
      try {
        let hits;
        if (mode === 'bm25') hits = await store.searchLex(item.query, { limit: 10 });
        else if (mode === 'vector') hits = await store.searchVector(item.query, { limit: 10 });
        else hits = await store.search({ queries: [
          { type: 'lex', query: item.query }, { type: 'vec', query: item.query },
        ], rerank: mode === 'rerank', candidateLimit: 20, minScore: 0, limit: 10, explain: true });
        row.hits = hits.map(h => ({ name: path.basename(h.file || h.filepath || h.displayPath, '.md'),
          file: h.file || h.filepath || h.displayPath, score: h.score, explain: h.explain }));
      } catch (error) { row.error = String(error); row.hits = []; }
      row.elapsed_ms = Math.round((performance.now() - started)*100)/100;
      artifact.rows.push(row); save();
      console.log(JSON.stringify({ id: item.id, mode, ms: row.elapsed_ms, top: row.hits[0], error: row.error }));
    }
  }
  artifact.health = await store.getIndexHealth();
  artifact.peak_rss_bytes = process.resourceUsage().maxRSS * 1024;
  save();
} finally { await store.close(); }
