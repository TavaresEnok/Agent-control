// Test-only writer barrier: no repository effect is attempted before the deadline.
if(!/^[a-f0-9-]{36}$/.test(process.argv[2]??''))throw Error('INVALID_OPERATION');
setTimeout(()=>process.exit(42),60000);
