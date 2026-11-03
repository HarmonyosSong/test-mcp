import { loadRuntimeConfig } from '../config.js';
import { migrateLegacyData, rollbackLegacyMigration } from './legacy.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'dry-run';
const migrationId = args[1];

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
