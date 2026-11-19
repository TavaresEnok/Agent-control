import {readFileSync, readdirSync, readlinkSync} from 'node:fs';
import {request} from 'node:http';
import {setTimeout as sleep} from 'node:timers/promises';
import {limits} from './limits.mjs';
import {launch} from './processes.mjs';
import {loopback} from './snapshot.mjs';

const proxyName = 'qa-carga';
const toxicName = 'qa-latencia';
const proxies = '/proxies';
const toxics = `${proxies}/${proxyName}/toxics`;
const maxAdminBytes = 4096;

// O PID e o inode do socket confirmam que a porta efêmera pertence ao processo recém-criado.
function ownedLoopbackPorts(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return [];
  const processDir = `/proc/${child.pid}`;
  const sockets = new Set();
  for (const fd of readdirSync(`${processDir}/fd`)) {
    try {
      const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`${processDir}/fd/${fd}`));
      if (match) sockets.add(match[1]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return readFileSync(`${processDir}/net/tcp`, 'utf8').split('\n').slice(1).flatMap(line => {
    const fields = line.trim().split(/\s+/);
    const address = /^0100007F:([A-F0-9]{4})$/.exec(fields[1]);
    return address && fields[3] === '0A' && sockets.has(fields[9]) ? [parseInt(address[1], 16)] : [];
  });
}

async function waitForListener(child, signal) {
  const deadline = performance.now() + limits.startupMs;
  while (performance.now() < deadline && child.pid && child.exitCode === null && child.signalCode === null) {
    const ports = ownedLoopbackPorts(child);
    if (ports.length === 1) return ports[0];
    await sleep(25, undefined, {signal});
  }
  throw new Error('QA_CARGA_PROXY_STARTUP');
}

function adminRequest(port, method, path, expectedStatuses, signal, payload) {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('QA_CARGA_PROXY_ADMIN'));
    const req = request({
      hostname: loopback, port, method, path, agent: false, maxHeaderSize: maxAdminBytes,
      signal: AbortSignal.any([signal, AbortSignal.timeout(limits.requestMs)]),
      headers: body === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)},
    }, res => {
      res.once('error', fail);
      if (!expectedStatuses.includes(res.statusCode)) {
        fail();
        res.destroy();
        return;
      }
      const parts = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes <= maxAdminBytes) parts.push(chunk);
        else {
          fail();
          res.destroy();
        }
      });
      res.once('end', () => {
        try {
          resolve(method === 'DELETE' ? undefined : JSON.parse(Buffer.concat(parts).toString('utf8')));
        } catch {
          fail();
        }
      });
    });
    req.once('error', fail);
    req.end(body);
  });
}

export async function startLatencyProxy(binary, cwd, upstreamPort, signal) {
  const {child, closed} = launch(binary, [`-host=${loopback}`, '-port=0'], cwd, signal);
  const close = async () => {
    child.kill('SIGKILL');
    await closed;
  };
  try {
    const adminPort = await waitForListener(child, signal);
    const localAddress = port => `${loopback}:${port}`;
    const assertListening = port => {
      if (!ownedLoopbackPorts(child).includes(port)) throw new Error('QA_CARGA_PROXY_LISTENER');
    };
    const admin = (method, path, statuses, payload) => {
      assertListening(adminPort);
      return adminRequest(adminPort, method, path, statuses, signal, payload);
    };
    const upstream = localAddress(upstreamPort);
    const created = await admin('POST', proxies, [200, 201], {
      name: proxyName, listen: localAddress(0), upstream, enabled: true,
    });
    const dataPorts = ownedLoopbackPorts(child).filter(port => port !== adminPort);
    const [port] = dataPorts;
    if (dataPorts.length !== 1 || created?.name !== proxyName || created.upstream !== upstream ||
        created.enabled !== true || ![localAddress(port), localAddress(0)].includes(created.listen)) {
      throw new Error('QA_CARGA_PROXY_TARGET');
    }
    const exit = new AbortController();
    void closed.then(() => exit.abort());
    return {
      origin: `http://${localAddress(port)}`,
      signal: AbortSignal.any([signal, exit.signal]),
      assertReady: () => assertListening(port),
      async addLatency() {
        const toxic = await admin('POST', toxics, [200, 201], {
          name: toxicName, type: 'latency', stream: 'downstream', toxicity: 1,
          attributes: {latency: limits.latencyMs, jitter: 0},
        });
        if (toxic?.name !== toxicName || toxic.type !== 'latency' || toxic.stream !== 'downstream' ||
            toxic.toxicity !== 1 || toxic.attributes?.latency !== limits.latencyMs || toxic.attributes.jitter !== 0) {
          throw new Error('QA_CARGA_PROXY_LATENCY');
        }
      },
      async removeLatency() {
        await admin('DELETE', `${toxics}/${toxicName}`, [200, 204]);
        const remaining = await admin('GET', toxics, [200]);
        if (!Array.isArray(remaining) || remaining.length) throw new Error('QA_CARGA_PROXY_RECOVERY');
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
