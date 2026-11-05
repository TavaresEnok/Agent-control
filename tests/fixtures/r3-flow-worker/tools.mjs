// Laboratory write endpoint on the isolated pair network only.
import http from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
const server=http.createServer(async(req,res)=>{try{let data='';for await(const part of req)data+=part;const {paths}=JSON.parse(data);if(!Array.isArray(paths)||paths.some(p=>typeof p!=='string'||!/^src\/[a-z0-9/_-]+\.ts$/.test(p)))throw Error('bad scope');for(const path of paths){const dest=resolve('/work',path);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,`// synthetic ${path}\n`);}res.writeHead(200).end();}catch{res.writeHead(400).end();}});
server.listen(19493,'0.0.0.0');
