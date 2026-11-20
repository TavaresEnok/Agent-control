import {generateRepoMap, type RepoMapOptions} from './repo-map.ts';

// Run outside the supervisor so a slow repository cannot block its event loop.
const options = JSON.parse(process.argv[2] ?? '{}') as RepoMapOptions;
process.stdout.write(JSON.stringify(await generateRepoMap(options)));
