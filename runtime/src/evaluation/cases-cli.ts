import {
  applyDraft,
  captureCase,
  draftCase,
  listCases,
  linkCase,
  resolveCasePath,
  reviewCase,
} from './cases.js';
import { loadRuntimeConfig } from '../config.js';
import { isAbsolute, resolve } from 'node:path';
import { redactConfiguredError } from '../security/configured-redaction.js';

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const config = loadRuntimeConfig();
  const directory = value(args, '--directory') ?? config.caseArchiveDir;
  const knowledge = value(args, '--knowledge');
  if (knowledge) config.knowledgeRoot = isAbsolute(knowledge) ? knowledge : resolve(config.projectRoot, knowledge);
  const command = args[0];
  if (!command || command === '--help' || command === '-h') {
    console.log('Usage: cases list [--directory DIR]\n       cases capture --conversation ID --message ID\n       cases review CASE --outcome confirmed|rejected|uncertain --root-cause TEXT --reviewer NAME [--evidence-id ID ...]\n       cases draft CASE --name ID --domain DOMAIN\n       cases apply CASE\n       cases link CASE --name ID');
    return;
  }
  if (command === 'list') {
    console.log(JSON.stringify(await listCases(directory), null, 2));
    return;
  }
  if (command === 'capture') {
    const conversation = value(args, '--conversation');
    const message = value(args, '--message');
    if (!conversation || !message) throw new Error('capture requires --conversation and --message');
    console.log(await captureCase(config, conversation, message, directory));
    return;
  }
  const caseArgument = args[1];
  if (!caseArgument) throw new Error(`${command} requires a case path or id`);
  const path = resolveCasePath(caseArgument, directory);
  if (command === 'review') {
    const outcome = value(args, '--outcome');
    const rootCause = value(args, '--root-cause');
    const reviewer = value(args, '--reviewer');
    if (!outcome || !rootCause || !reviewer) throw new Error('review requires outcome, root cause, and reviewer');
    await reviewCase(path, { outcome, rootCause, reviewer, evidenceIds: args.flatMap((item, index) => item === '--evidence-id' && args[index + 1] ? [args[index + 1]] : []) });
  } else if (command === 'draft') {
    const name = value(args, '--name');
    const domain = value(args, '--domain');
    if (!name || !domain) throw new Error('draft requires --name and --domain');
    console.log(await draftCase(path, config, name, domain));
  } else if (command === 'apply') {
    console.log(await applyDraft(path, config));
  } else if (command === 'link') {
    const name = value(args, '--name');
    if (!name) throw new Error('link requires --name');
    await linkCase(path, config, name);
  } else {
    throw new Error(`unknown command: ${command}`);
  }
}

main().catch(async (error) => {
  try {
    console.error(await redactConfiguredError(loadRuntimeConfig().modelConfigFile, error));
  } catch {
    console.error(error instanceof Error ? error.message : 'case operation failed');
  }
  process.exitCode = 1;
});
