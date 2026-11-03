import {prepareNativeImage} from './native-image-builder.mjs';
const [binary,digest,...extra]=process.argv.slice(2);
if(extra.length)throw Error('INVALID_ARGUMENTS');
console.log(JSON.stringify(await prepareNativeImage('tools',binary,digest)));
