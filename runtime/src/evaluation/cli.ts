import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute, dirname } from 'node:path';

import { loadRuntimeConfig } from '../config.js';
import { compare, loadArtifact, runLive, summarize } from './live.js';
import { redactConfiguredError } from '../security/configured-redaction.js';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: live-eval --live DATASET.jsonl [--output PATH] [--baseline PATH] [--timeout SECONDS]\n       live-eval --input ARTIFACT.json [--output PATH] [--baseline PATH]');
    return;
  }
  const live = option(args, '--live');
  const input = option(args, '--input');
  const output = option(args, '--output') ?? '.data/evals/latest.json';
  const baseline = option(args, '--baseline');
  const projectRoot = loadRuntimeConfig().projectRoot;
  const resolveProject = (path: string) => isAbsolute(path) ? path : resolve(projectRoot, path);
  const outputPath = resolveProject(output);
  const timeout = Number(option(args, '--timeout') ?? '180');
  if (Boolean(live) === Boolean(input)) throw new Error('指定 --live 或 --input 之一');

  const artifact = live ? await runLive(live, outputPath, timeout) : await loadArtifact(resolveProject(input!));
  artifact.summary = summarize(artifact.rows);
  if (baseline) artifact.comparison = compare(artifact, JSON.parse(await readFile(resolveProject(baseline), 'utf8')));
  {
    const { mkdir, writeFile, rename } = await import('node:fs/promises');
    await mkdir(dirname(outputPath), { recursive: true });
    const temporary = `${outputPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, outputPath);
  }
  console.log(JSON.stringify(artifact.summary, null, 2));
  if (artifact.rows.some((row: any) => row.status === 'failed' || row.correct_location === false || row.appropriate_clarification === false || row.expected_verdict_pass === false)) process.exitCode = 1;
}

main().catch(async (error) => {
  try {
    console.error(await redactConfiguredError(loadRuntimeConfig().modelConfigFile, error));
  } catch {
    console.error(error instanceof Error ? error.message : 'evaluation failed');
  }
  process.exitCode = 1;
});
