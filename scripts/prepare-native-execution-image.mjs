// Creates a context only: never authenticates, builds an image or runs a model.
import {prepareNativeImage} from './native-image-builder.mjs';
if(process.argv.length!==4)throw Error('Usage: prepare-native-execution-image.mjs PUBLIC_CODEX_ELF EXPECTED_SHA256');
console.log(JSON.stringify(await prepareNativeImage('execution',process.argv[2],process.argv[3])));
