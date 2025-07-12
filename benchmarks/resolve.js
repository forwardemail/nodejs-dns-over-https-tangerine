import dns from 'node:dns';
import Benchmark from 'benchmark';
import Tangerine from '../index.js';

const options = { timeout: 5000, tries: 1 };

// eslint-disable-next-line n/prefer-promises/dns
dns.setServers(['1.1.1.1', '1.0.0.1']);

const resolver = new dns.promises.Resolver(options);
resolver.setServers(['1.1.1.1', '1.0.0.1']);

const cache = new Map();

async function resolveWithCache(host, record) {
  const key = `${host}:${record}`;
  let result = cache.get(key);
  if (result) {
    return result;
  }

  result = await resolver.resolve(host, record);
  if (result) {
    cache.set(key, result);
  }

  return result;
}

const tangerine = new Tangerine({ ...options, method: 'POST' });
const tangerineNoCache = new Tangerine({
  ...options,
  method: 'POST',
  cache: false
});
const tangerineGet = new Tangerine(options);
const tangerineGetNoCache = new Tangerine({ ...options, cache: false });

// Google servers
const servers = ['8.8.8.8', '8.8.4.4'];

const tangerineGoogle = new Tangerine({ ...options, servers, method: 'POST' });
const tangerineGoogleNoCache = new Tangerine({
  ...options,
  servers,
  method: 'POST',
  cache: false
});
const tangerineGoogleGet = new Tangerine({ ...options, servers });
const tangerineGoogleGetNoCache = new Tangerine({
  ...options,
  servers,
  cache: false
});

const host = 'netflix.com';
const record = 'A';

// ---

const suite = new Benchmark.Suite('resolve');

suite.on('start', (ev) => {
  console.log(`Started: ${ev.currentTarget.name}`);
});

// Cloudflare
suite.add('tangerine.resolve POST with caching using Cloudflare', {
  defer: true,
  async fn(deferred) {
    await tangerine.resolve(host, record);
    deferred.resolve();
  }
});

suite.add('tangerine.resolve POST without caching using Cloudflare', {
  defer: true,
  async fn(deferred) {
    await tangerineNoCache.resolve(host, record);
    deferred.resolve();
  }
});

suite.add('tangerine.resolve GET with caching using Cloudflare', {
  defer: true,
  async fn(deferred) {
    await tangerineGet.resolve(host, record);
    deferred.resolve();
  }
});

suite.add('tangerine.resolve GET without caching using Cloudflare', {
  defer: true,
  async fn(deferred) {
    await tangerineGetNoCache.resolve(host, record);
    deferred.resolve();
  }
});

// Google
suite.add('tangerine.resolve POST with caching using Google', {
  defer: true,
  async fn(deferred) {
    await tangerineGoogle.resolve(host, record);
    deferred.resolve();
  }
});

suite.add('tangerine.resolve POST without caching using Google', {
  defer: true,
  async fn(deferred) {
    await tangerineGoogleNoCache.resolve(host, record);
    deferred.resolve();
  }
});

suite.add('tangerine.resolve GET with caching using Google', {
  defer: true,
  async fn(deferred) {
    await tangerineGoogleGet.resolve(host, record);
    deferred.resolve();
  }
});

suite.add('tangerine.resolve GET without caching using Google', {
  defer: true,
  async fn(deferred) {
    await tangerineGoogleGetNoCache.resolve(host, record);
    deferred.resolve();
  }
});

suite.add('resolver.resolve with caching using Cloudflare', {
  defer: true,
  async fn(deferred) {
    try {
      await resolveWithCache(host, record);
    } catch {}

    deferred.resolve();
  }
});

suite.add('resolver.resolve without caching using Cloudflare', {
  defer: true,
  async fn(deferred) {
    try {
      await resolver.resolve(host, record);
    } catch {}

    deferred.resolve();
  }
});

suite.on('cycle', (ev) => {
  console.log(String(ev.target));
});

suite.on('complete', function () {
  console.log(
    `Fastest without caching is: ${this.filter((bench) =>
      bench.name.includes('without caching')
    )
      .filter('fastest')
      .map('name')
      .join(', ')}\n`
  );
});

suite.run();
