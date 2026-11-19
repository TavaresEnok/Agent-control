// Processo filho exclusivo da homologação. O coletor cria o endereço do socket.
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [adapter, socket] = process.argv.slice(2);
process.once('disconnect', () => process.exit(0));
const {default: handler} = await import(pathToFileURL(resolve(adapter)).href);
if (typeof handler !== 'function') process.exit(1);

createServer(handler).listen(socket, () => process.send('ready'));
