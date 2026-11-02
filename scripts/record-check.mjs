import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const [id,...command] = process.argv.slice(2);
if (!id || !command.length) throw Error('check id and command required');
const startedAt = new Date().toISOString();
const result = spawnSync(command[0],command.slice(1),{stdio:'inherit',env:process.env});
appendFileSync('docs/validation/evidence/CHECKS.jsonl',JSON.stringify({id,command,startedAt,finishedAt:new Date().toISOString(),exitCode:result.status,signal:result.signal})+'\n');
process.exit(result.status ?? 1);
