// Isolated child process: expected to terminate with code1 after its actual PG
// advisory-lock session is killed by the parent test. No fake lock observations.
import {readFile} from 'node:fs/promises';
import {brokerMain,type SandboxBrokerConfig} from '../../src/sandbox-broker.ts';
const config=JSON.parse(await readFile(process.argv[2]!,'utf8')) as SandboxBrokerConfig;
await brokerMain(config);
process.send?.({state:'broker_lock_held'});
process.channel?.unref();
