// Lab-only broker. The only Docker-socket holder is the controller service, never a worker.
import { brokerMain } from '../../dist/src/sandbox-broker.js';
const config={hostRoot:process.env.AC_SANDBOX_HOST_ROOT,probeHostPath:process.env.AC_SANDBOX_PROBE,
 probeSha256:process.env.AC_SANDBOX_PROBE_SHA256,imageId:process.env.AC_SANDBOX_IMAGE,
 implementationPath:process.env.AC_SANDBOX_IMPLEMENTATION,implementationSha256:process.env.AC_SANDBOX_IMPLEMENTATION_SHA256,
 socketPath:'/run/ac-broker/control.sock',keyPath:'/run/ac-broker/key',databaseUrl:process.env.AC_SANDBOX_DATABASE_URL};
if(Object.values(config).some(value=>!value)||!config.databaseUrl.endsWith('/ac_sandbox_test'))throw Error('ISOLATED_SANDBOX_CONFIG_REQUIRED');
const instance=await brokerMain(config);
const stop=()=>void instance.stop().then(()=>process.exit(0)).catch(()=>process.exit(1));
process.once('SIGTERM',stop);process.once('SIGINT',stop);
