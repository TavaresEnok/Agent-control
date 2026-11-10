// Runs the unmodified Happier light server for personal use. Keep it running (tmux, systemd or compose).
// Data lives in <dataDirectory>/happier; the port comes from happier.upstreamOrigin in the installation file.
import {spawn,execFileSync} from 'node:child_process';
import {readFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const installation=process.argv[2];
if(!installation){console.log('Uso: npm run personal:happier -- <instalação.json>');process.exit(0);}
const config=JSON.parse(await readFile(installation,'utf8'));
const origin=new URL(config.happier.upstreamOrigin);
if(origin.hostname!=='127.0.0.1')throw Error('HAPPIER_UPSTREAM_MUST_BE_LOCAL');
const data=join(config.dataDirectory,'happier');await mkdir(data,{recursive:true,mode:0o700});
const root=resolve(import.meta.dirname,'..'),server=join(root,'upstream/happier/apps/server');
const env={PATH:process.env.PATH,HOME:data,CI:'1',DO_NOT_TRACK:'1',EXPO_NO_TELEMETRY:'1',PORT:origin.port,METRICS_ENABLED:'false',AUTH_ANONYMOUS_SIGNUP_ENABLED:'true',
 HAPPIER_FILES_BACKEND:'local',HAPPIER_DB_PROVIDER:'sqlite',HAPPY_DB_PROVIDER:'sqlite',HAPPIER_SERVER_LIGHT_DATA_DIR:data,HAPPIER_SERVER_HOST:'127.0.0.1',HAPPY_SERVER_HOST:'127.0.0.1',
 DATABASE_URL:'file:'+join(data,'server.sqlite')+'?socket_timeout=30&connection_limit=1',HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY:'required_e2ee'};
execFileSync('yarn',['-s','migrate:sqlite:deploy'],{cwd:server,env,stdio:'inherit'});
const child=spawn(process.execPath,[join(root,'upstream/happier/node_modules/tsx/dist/cli.mjs'),'--tsconfig','./tsconfig.json','./sources/main.light.ts'],{cwd:server,env,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code??1));
