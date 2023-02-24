const dns = require('node:dns');

const Keyv = require('keyv');
const Benchmark = require('benchmark');

const Tangerine = require('..');

const opts = { timeout: 5000, tries: 1 };

dns.setServers(['1.1.1.1', '1.0.0.1']);

const resolver = new dns.promises.Resolver(opts);
resolver.setServers(['1.1.1.1', '1.0.0.1']);

const lookupCache = new Keyv();

async function lookupWithCache(host) {
  let result = await lookupCache.get(host);
  if (result) return result;
  result = await dns.promises.lookup(host);
  if (result) await lookupCache.set(host, result);
  return result;
}

const tangerine = new Tangerine({ ...opts, method: 'POST' });
const tangerineNoCache = new Tangerine({
  ...opts,
  method: 'POST',
  cache: false
});
const tangerineGet = new Tangerine(opts);
const tangerineGetNoCache = new Tangerine({ ...opts, cache: false });

const host = 'netflix.com';

const suit = new Benchmark.Suite('lookup');

suit.add('tangerine.lookup POST with caching using Cloudflare', {
  defer: true,
  async fn(deferred) {
    await tangerine.lookup(host);
    deferred.resolve();
  }
});

suit.add('tangerine.lookup POST without caching using Cloudflare', {
  defer: true,
  async fn(deferred) {
    await tangerineNoCache.lookup(host);
    deferred.resolve();
  }
});

suit.add('tangerine.lookup GET with caching using Cloudflare', {
  defer: true,
  async fn(deferred) {
    await tangerineGet.lookup(host);
    deferred.resolve();
  }
});

suit.add('tangerine.lookup GET without caching using Cloudflare', {
  defer: true,
  async fn(deferred) {
    await tangerineGetNoCache.lookup(host);
    deferred.resolve();
  }
});

suit.add('dns.promises.lookup with caching using Cloudflare', {
  defer: true,
  async fn(deferred) {
    try {
      await lookupWithCache(host);
    } catch {}

    deferred.resolve();
  }
});

suit.add('dns.promises.lookup without caching using Cloudflare', {
  defer: true,
  async fn(deferred) {
    try {
      await dns.promises.lookup(host);
    } catch {}

    deferred.resolve();
  }
});

suit.on('cycle', (ev) => {
  console.log(String(ev.target));
});

suit.on('complete', function () {
  console.log(
    `Fastest without caching is: ${this.filter((bench) =>
      bench.name.includes('without caching')
    )
      .filter('fastest')
      .map('name')
      .join(', ')}`
  );
});

suit.run();
