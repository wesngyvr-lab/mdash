import { setGlobalDispatcher, Agent } from 'undici';

// Workaround: Node's bundled undici has a dual-stack issue on macOS where
// fetch() times out trying both IPv4 + IPv6 addresses even when curl succeeds.
// Forcing IPv4 resolves it. Affects all fetch() calls in this process.
setGlobalDispatcher(
  new Agent({
    connect: { family: 4, timeout: 30_000 },
    allowH2: false,
  })
);
