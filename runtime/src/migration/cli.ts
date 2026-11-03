import { loadRuntimeConfig } from '../config.js';
import { migrateLegacyData, rollbackLegacyMigration } from './legacy.js';

const args = process.argv.slice(2);
const positional = args.filter((value) => !value.startsWith('--'));
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const command = option('--mode') ?? positional[0] ?? 'dry-run';
const migrationId = option('--migration-id') ?? positional[1];

if (!['dry-run', 'apply', 'rollback'].includes(command)) {
  process.stderr.write('mode must be one of: dry-run, apply, rollback\n');
  process.exitCode = 2;
} else {

try {
  const config = loadRuntimeConfig();
  const report = command === 'rollback'
    ? await rollbackLegacyMigration(config, migrationId ?? '')
    : await migrateLegacyData(config, command === 'apply' ? 'apply' : 'dry-run');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.rejected.length > 0) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
}
