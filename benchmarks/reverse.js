const dns = require('node:dns');

const Benchmark = require('benchmark');

const Tangerine = require('..');

const opts = { timeout: 5000, tries: 1 };

dns.setServers(['1.1.1.1', '1.0.0.1']);

const resolver = new dns.promises.Resolver(opts);
resolver.setServers(['1.1.1.1', '1.0.0.1']);

const tangerine = new Tangerine({ ...opts, method: 'POST' });
const tangerineNoCache = new Tangerine({
  ...opts,
  method: 'POST',
  cache: false
});

const suite = new Benchmark.Suite('reverse');

suite.add('tangerine.reverse GET with caching', {
  defer: true,
  async fn(deferred) {
    try {
      await tangerine.reverse('1.1.1.1');
    } catch {}

    deferred.resolve();
  }
});

suite.add('tangerine.reverse GET without caching', {
  defer: true,
  async fn(deferred) {
    try {
      await tangerineNoCache.reverse('1.1.1.1');
    } catch {}

    deferred.resolve();
  }
});

suite.add('resolver.reverse', {
  defer: true,
  async fn(deferred) {
    try {
      await resolver.reverse('1.1.1.1');
    } catch {}

    deferred.resolve();
  }
});

suite.add('dns.promises.reverse', {
  defer: true,
  async fn(deferred) {
    try {
      await dns.promises.reverse('1.1.1.1');
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
      .join(', ')}`
  );
});

suite.run();
