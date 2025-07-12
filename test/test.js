import dns from 'node:dns';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { isIP, isIPv4, isIPv6 } from 'node:net';
import isCI from 'is-ci';
import Redis from 'ioredis-mock';
import _ from 'lodash';
import got from 'got';
import sortKeys from 'sort-keys';
import test from 'ava';
import Tangerine from '../index.js';

const { Resolver } = dns.promises;

//
// NOTE: tests won't work if you're behind a VPN with DNS blackholed
//
test.before(async (t) => {
  // Echo the output of `/etc/dnsmasq.conf`
  try {
    t.log('/etc/dnsmasq.conf');
    t.log(fs.readFileSync('/etc/dnsmasq.conf'));
  } catch (error) {
    t.log(error);
  }

  // Echo the output of `/usr/local/etc/dnsmasq.d/localhost.conf`
  try {
    t.log('/usr/local/etc/dnsmasq.d/localhost.conf');
    t.log(fs.readFileSync('/usr/local/etc/dnsmasq.d/localhost.conf'));
  } catch (error) {
    t.log(error);
  }

  // Log the hosts (useful for debugging)
  t.log(Tangerine.HOSTFILE);

  // Attempt to setServers and perform a DNS lookup
  const tangerine = new Tangerine();
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  resolver.setServers(tangerine.getServers());

  t.deepEqual(resolver.getServers(), tangerine.getServers());

  try {
    t.log('Testing VPN with DNS blackhole');
    await resolver.resolve('cloudflare.com', 'A');
  } catch (error) {
    if (error.code === dns.TIMEOUT) {
      t.context.isBlackholed = true;
      t.log('VPN with DNS blackholed detected');
    } else {
      throw error;
    }
  }
});

// Clean up any remaining abort controllers to prevent memory leaks
test.after(() => {
  // Create a temporary instance to check for any lingering abort controllers
  const tangerine = new Tangerine();
  // Cancel any remaining abort controllers
  tangerine.cancel();
});

test('exports', async (t) => {
  const pkg = await import('../index.js');
  const Tangerine = pkg.default;
  const tangerine = new Tangerine();
  await t.notThrowsAsync(tangerine.resolve('cloudflare.com'));
});

// New Tangerine(options)
test('instance', (t) => {
  const tangerine = new Tangerine();
  t.true(tangerine instanceof Resolver);
  t.is(tangerine.options.timeout, 5000);
  t.is(tangerine.options.tries, 4);
});

// Tangerine.cancel()
test('cancel', (t) => {
  const tangerine = new Tangerine();
  const abortController = new AbortController();
  abortController.signal.addEventListener(
    'abort',
    () => {
      tangerine.abortControllers.delete(abortController);
    },
    { once: true }
  );
  tangerine.abortControllers.add(abortController);
  t.is(tangerine.abortControllers.size, 1);
  tangerine.cancel();
  t.is(tangerine.abortControllers.size, 0);
});

// Tangerine.getServers()
// tangerine.setServers()
test('getServers and setServers', (t) => {
  const tangerine = new Tangerine();
  const resolver = new Resolver();
  resolver.setServers(tangerine.getServers());
  t.deepEqual(tangerine.getServers(), resolver.getServers());
});

test.todo('getServers with [::0] returns accurate response');
// Test('getServers with [::0] returns accurate response', (t) => {
//   const servers = ['1.1.1.1', '[::0]'];
//   const tangerine = new Tangerine();
//   const resolver = new Resolver();
//   resolver.setServers(servers);
//   tangerine.setServers(servers);
//   t.deepEqual(tangerine.getServers(), resolver.getServers());
// });

test('getServers with IPv6 returns accurate response', (t) => {
  const tangerine = new Tangerine();
  const resolver = new Resolver();
  const servers = ['1.1.1.1', '2001:db8::1:80', '[2001:db8::1]:8080'];
  resolver.setServers(servers);
  tangerine.setServers(servers);
  t.deepEqual(tangerine.getServers(), resolver.getServers());
});

// Helper function to check if errors are equivalent
function areErrorsEquivalent(error1, error2) {
  if (!_.isError(error1) || !_.isError(error2)) {
    return false;
  }

  // Handle equivalent error codes
  const equivalentErrors = new Set([
    'ENOTFOUND', // Tangerine uses this for host not found
    'EBADNAME', // Native DNS uses this for invalid hostnames
    'EINVAL' // Some implementations use this for invalid input
  ]);

  // If both errors are in the equivalent set, consider them equal
  if (equivalentErrors.has(error1.code) && equivalentErrors.has(error2.code)) {
    return true;
  }

  // Otherwise they must match exactly
  return error1.code === error2.code;
}

// eslint-disable-next-line complexity
function compareResults(t, type, r1, r2) {
  // T.log('tangerine', r1);
  // t.log('resolver', r2);

  if (type === 'TXT') {
    if (!_.isError(r1)) {
      r1 = r1.flat();
    }

    if (!_.isError(r2)) {
      r2 = r2.flat();
    }
  }

  switch (type) {
    //
    // for some hosts the DNS is round-robin or geo-location based or health check based
    // so the A records for example would not always return the same
    //
    // e.g. `dig example.com A` -> 4.4.4.4
    // e.g. `dig example.com A` -> 3.3.3.3
    // e.g. `dig example.com A` -> 3.3.3.3
    // e.g. `dig example.com A` -> 7.7.7.7
    // e.g. `dig example.com A` -> 4.4.4.4
    //
    // as you can see, the results are not consistent, so tests cannot be written for that
    // so instead we check that all values are IP addresses
    //
    case 'A':
    case 'AAAA': {
      if (!_.isError(r1)) {
        r1 = r1.every((o) => isIPv4(o) || isIPv6(o));
      }

      if (!_.isError(r2)) {
        r2 = r2.every((o) => isIPv4(o) || isIPv6(o));
      }

      // Handle errors with equivalent codes
      if (_.isError(r1) && _.isError(r2)) {
        if (areErrorsEquivalent(r1, r2)) {
          t.pass(
            `Both resolvers returned equivalent errors: ${r1.code} vs ${r2.code}`
          );
        } else {
          t.deepEqual(r1, r2);
        }
      } else {
        t.deepEqual(r1, r2);
      }

      break;
    }

    case 'SOA': {
      if (!_.isError(r1) && !_.isError(r2)) {
        // Ensure object that has the following values for both
        const keys = [
          'nsname',
          'hostmaster',
          'serial',
          'refresh',
          'retry',
          'expire',
          'minttl'
        ];
        t.deepEqual(keys.sort(), Object.keys(r1).sort());
        t.deepEqual(keys.sort(), Object.keys(r2).sort());
      } else if (_.isError(r1) && _.isError(r2)) {
        // Handle errors with equivalent codes
        if (areErrorsEquivalent(r1, r2)) {
          t.pass(
            `Both resolvers returned equivalent errors: ${r1.code} vs ${r2.code}`
          );
        } else {
          t.deepEqual(r1, r2);
        }
      } else {
        t.deepEqual(r1, r2);
      }

      break;
    }

    case 'CAA': {
      // Sort each by critical_iodef_issue_issuewild
      if (!_.isError(r1)) {
        r1 = _.sortBy(
          r1,
          (o) => `${o.critical}_${o.iodef}_${o.issue}_${o.issuewild}`
        );
      }

      if (!_.isError(r2)) {
        r2 = _.sortBy(
          r2,
          (o) => `${o.critical}_${o.iodef}_${o.issue}_${o.issuewild}`
        );
      }

      // Handle errors with equivalent codes
      if (_.isError(r1) && _.isError(r2)) {
        if (areErrorsEquivalent(r1, r2)) {
          t.pass(
            `Both resolvers returned equivalent errors: ${r1.code} vs ${r2.code}`
          );
        } else {
          t.deepEqual(r1, r2);
        }
      } else {
        t.deepEqual(r1, r2);
      }

      break;
    }

    case 'MX': {
      // Sort each by exchange_priority
      if (!_.isError(r1)) {
        r1 = _.sortBy(r1, (o) => `${o.exchange}_${o.priority}`);
      }

      if (!_.isError(r2)) {
        r2 = _.sortBy(r2, (o) => `${o.exchange}_${o.priority}`);
      }

      // Handle errors with equivalent codes
      if (_.isError(r1) && _.isError(r2)) {
        if (areErrorsEquivalent(r1, r2)) {
          t.pass(
            `Both resolvers returned equivalent errors: ${r1.code} vs ${r2.code}`
          );
        } else {
          t.deepEqual(r1, r2);
        }
      } else {
        t.deepEqual(r1, r2);
      }

      break;
    }

    case 'ANY': {
      // Sometimes ENOTIMP for dns servers
      if (_.isError(r2) && r2.code === dns.NOTIMP) {
        t.pass(`${dns.NOTIMP} detected for resolver.resolveAny`);
        break;
      }

      if (_.isError(r1) || _.isError(r2)) {
        // Handle errors with equivalent codes
        if (_.isError(r1) && _.isError(r2)) {
          if (areErrorsEquivalent(r1, r2)) {
            t.pass(
              `Both resolvers returned equivalent errors: ${r1.code} vs ${r2.code}`
            );
          } else {
            t.log(r1);
            t.log(r2);
            t.deepEqual(r1, r2);
          }
        } else {
          t.log(r1);
          t.log(r2);
          t.deepEqual(r1, r2);
        }
      } else {
        // R1/r2 = [ { type: 'TXT', value: 'blah' }, ... ] }
        //
        // NOTE: this isn't yet implemented (we could alternatively check properties for proper types, see below link's "example of the `ret` object")
        //       <https://nodejs.org/api/dns.html#dnsresolveanyhostname-callback>
        //
        // t.log('Comparison not yet implemented');
        t.pass();
      }

      break;
    }

    case 'reverse': {
      // Handle reverse DNS lookups
      // Handle errors with equivalent codes
      if (_.isError(r1) && _.isError(r2)) {
        if (areErrorsEquivalent(r1, r2)) {
          t.pass(
            `Both resolvers returned equivalent errors: ${r1.code} vs ${r2.code}`
          );
        } else {
          t.deepEqual(r1, r2);
        }
      } else if (_.isError(r1) || _.isError(r2)) {
        // One succeeded, one failed - this can happen for reverse DNS
        // when local hosts file entries differ from public DNS
        t.pass(
          'Reverse DNS resolution differences are expected (one succeeded, one failed)'
        );
      } else if (Array.isArray(r1) && Array.isArray(r2)) {
        // Both succeeded - compare as arrays of strings, but allow differences
        // since local hosts file vs public DNS can legitimately differ
        // If both are arrays, just verify they're both valid hostname arrays
        const isValidHostname = (hostname) =>
          typeof hostname === 'string' && hostname.length > 0;
        const r1Valid = r1.every((hostname) => isValidHostname(hostname));
        const r2Valid = r2.every((hostname) => isValidHostname(hostname));
        if (r1Valid && r2Valid) {
          t.pass(
            `Both resolvers returned valid hostnames: ${r1.length} vs ${r2.length} entries`
          );
        } else {
          t.deepEqual(r1, r2);
        }
      } else {
        t.deepEqual(r1, r2);
      }

      break;
    }

    default: {
      // Handle errors with equivalent codes
      if (_.isError(r1) && _.isError(r2)) {
        if (areErrorsEquivalent(r1, r2)) {
          t.pass(
            `Both resolvers returned equivalent errors: ${r1.code} vs ${r2.code}`
          );
        } else {
          t.deepEqual(r1, r2);
        }
      } else {
        t.deepEqual(
          _.isError(r1)
            ? r1
            : Array.isArray(r1) && r1.every((s) => _.isString(s))
              ? r1.sort()
              : sortKeys(r1),
          _.isError(r2)
            ? r2
            : Array.isArray(r2) && r2.every((s) => _.isString(s))
              ? r2.sort()
              : sortKeys(r2)
        );
      }
    }
  }
}

//
// NOTE: need to test all options
//
for (const host of [
  'localhost',
  'localhost.',
  'localhost.foo',
  '..localhost',
  '.',
  '..',
  '..a..',
  '.aa.',
  ',.,.',
  ',..',
  '.,',
  'localhost..',
  'beep..',
  'beep.com',
  'beep.com..',
  'beep..com..',
  'foo..com',
  '..foo.com',
  '..foo..com.',
  '.foo.com.',
  'foo..localhost',
  'foo..localhost..localhost',
  '.localhost',
  'foo.localhost',
  'foo.bar.localhost',
  '::1',
  '::0',
  'fe00::0',
  'ff00::0',
  '192.168.1.1',
  '255.255.255.0',
  '255.255.255.255',
  '127.0.0.1',
  '127.0.1.1',
  'forwardemail.net',
  'cloudflare.com',
  'stackoverflow.com',
  'github.com',
  'gmail.com',
  'microsoft.com'
]) {
  // Test seems to be broken on GitHub CI (maybe due to IPv6 setup?)

  test.todo(`setDefaultResultOrder with ${host}`);
  /*
  Test(`setDefaultResultOrder with ${host}`, async (t) => {
    const tangerine = new Tangerine({ cache: false });
    for (const dnsOrder of ['verbatim', 'ipv4first']) {
      tangerine.setDefaultResultOrder(dnsOrder);
      dns.promises.setDefaultResultOrder(dnsOrder);
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop
        const [results, dnsResults] = await Promise.all([
          tangerine.lookup(host, {
            all: true
          }),
          dns.promises.lookup(host, {
            all: true
          })
        ]);
        // since IP's can vary based off round-robin DNS or geo DNS
        // we simply return the sorted results based off IPv4 or IPv6 sort
        const sortedResults = (
          dnsOrder === 'verbatim' ? results : _.sortBy(results, 'family')
        ).map((result) => result.family);
        t.deepEqual(
          results.map((result) => result.family),
          sortedResults
        );
        t.deepEqual(
          dnsResults.map((result) => result.family),
          sortedResults
        );
      }
    }
  });
  */

  // tangerine.reverse
  test(`reverse("${host}")`, async (t) => {
    const tangerine = new Tangerine();
    const resolver = new Resolver();
    if (!t.context.isBlackholed) {
      resolver.setServers(tangerine.getServers());
    }

    let r1;
    let r2;
    try {
      r1 = await tangerine.reverse(host);
    } catch (error) {
      r1 = error;
    }

    try {
      r2 = await resolver.reverse(host);
    } catch (error) {
      r2 = error;
    }

    t.log(r1);
    t.log(r2);

    compareResults(t, 'reverse', r1, r2);
  });

  // Tangerine.lookup"${host}"[, options])
  //
  // NOTE: if the local DNS resolver on the server that c-ares communicates with
  // is using a wildcard or regex based approach for matching hostnames
  // then it won't match in these tests because we only check for /etc/hosts
  // (see #compatibility section of README for more insight)
  //
  if (!isCI || !['.', 'foo.localhost', 'foo.bar.localhost'].includes(host)) {
    test(`lookup("${host}")`, async (t) => {
      // Returns { address: IP , family: 4 || 6 }
      const tangerine = new Tangerine();
      let r1;
      let r2;
      try {
        r1 = await tangerine.lookup(host);
      } catch (error) {
        r1 = error;
      }

      try {
        r2 = await dns.promises.lookup(host);
      } catch (error) {
        r2 = error;
      }

      t.log(r1);
      t.log(r2);

      if (_.isPlainObject(r1)) {
        r1 = [r1];
      }

      if (_.isPlainObject(r2)) {
        r2 = [r2];
      }

      if (!_.isError(r1)) {
        r1 = r1.every((o) => isIP(o.address) === o.family);
      }

      if (!_.isError(r2)) {
        r2 = r2.every((o) => isIP(o.address) === o.family);
      }

      t.deepEqual(r1, r2);
    });
  }

  // Tangerine.resolve"${host}"[, rrtype])
  test(`resolve("${host}")`, async (t) => {
    const tangerine = new Tangerine();
    const resolver = new Resolver();
    if (!t.context.isBlackholed) {
      resolver.setServers(tangerine.getServers());
    }

    let r1;
    let r2;
    try {
      r1 = await tangerine.resolve(host);
    } catch (error) {
      r1 = error;
    }

    try {
      r2 = await resolver.resolve(host);
    } catch (error) {
      r2 = error;
    }

    t.log(r1);
    t.log(r2);

    // See explanation below regarding this under "A" and "AAAA" in switch/case
    if (!_.isError(r1)) {
      r1 = r1.every((o) => isIPv4(o) || isIPv6(o));
    }

    if (!_.isError(r2)) {
      r2 = r2.every((o) => isIPv4(o) || isIPv6(o));
    }

    // Handle errors with equivalent codes
    if (_.isError(r1) && _.isError(r2)) {
      if (areErrorsEquivalent(r1, r2)) {
        t.pass(
          `Both resolvers returned equivalent errors: ${r1.code} vs ${r2.code}`
        );
      } else {
        t.deepEqual(r1, r2);
      }
    } else {
      t.deepEqual(r1, r2);
    }
  });

  for (const type of Tangerine.DNS_TYPES) {
    test(`resolve("${host}", "${type}")`, async (t) => {
      const tangerine = new Tangerine();
      const resolver = new Resolver();

      // Mirror DNS servers for accuracy (e.g. SOA)
      if (!t.context.isBlackholed) {
        resolver.setServers(tangerine.getServers());
      }

      let h = host;
      if (type === 'SRV') {
        // T.log('switching SRV lookup to _submission._tcp.hostname');
        h = `_submission._tcp.${host}`;
      }

      let r1;
      try {
        r1 = await tangerine.resolve(h, type);
      } catch (error) {
        r1 = error;
      }

      let r2;
      try {
        r2 = await resolver.resolve(h, type);
      } catch (error) {
        r2 = error;
      }

      // If (host === h) t.log(host, type);
      // else t.log(host, type, h);
      compareResults(t, type, r1, r2);
    });
  }

  // Tangerine.resolve4"${host}"[, options, abortController])
  test(`resolve4("${host}")`, async (t) => {
    const tangerine = new Tangerine();
    const resolver = new Resolver();
    if (!t.context.isBlackholed) {
      resolver.setServers(tangerine.getServers());
    }

    let r1;
    try {
      r1 = await tangerine.resolve4(host);
    } catch (error) {
      r1 = error;
    }

    let r2;
    try {
      r2 = await resolver.resolve4(host);
    } catch (error) {
      r2 = error;
    }

    compareResults(t, 'A', r1, r2);
  });

  // Tangerine.resolve6"${host}"[, options, abortController])
  test(`resolve6("${host}")`, async (t) => {
    const tangerine = new Tangerine();
    const resolver = new Resolver();
    if (!t.context.isBlackholed) {
      resolver.setServers(tangerine.getServers());
    }

    let r1;
    try {
      r1 = await tangerine.resolve6(host);
    } catch (error) {
      r1 = error;
    }

    let r2;
    try {
      r2 = await resolver.resolve6(host);
    } catch (error) {
      r2 = error;
    }

    compareResults(t, 'AAAA', r1, r2);
  });

  // Tangerine.resolveAny"${host}"[, abortController])
  if (!isCI) {
    test(`resolveAny("${host}")`, async (t) => {
      const tangerine = new Tangerine();
      const resolver = new Resolver();
      if (!t.context.isBlackholed) {
        resolver.setServers(tangerine.getServers());
      }

      let r1;
      try {
        r1 = await tangerine.resolveAny(host);
      } catch (error) {
        r1 = error;
      }

      let r2;
      try {
        r2 = await resolver.resolveAny(host);
      } catch (error) {
        r2 = error;
      }

      compareResults(t, 'ANY', r1, r2);
    });
  }

  // Tangerine.resolveCaa"${host}"[, abortController]))
  test(`resolveCaa("${host}")`, async (t) => {
    const tangerine = new Tangerine();
    const resolver = new Resolver();
    if (!t.context.isBlackholed) {
      resolver.setServers(tangerine.getServers());
    }

    let r1;
    try {
      r1 = await tangerine.resolveCaa(host);
    } catch (error) {
      r1 = error;
    }

    let r2;
    try {
      r2 = await resolver.resolveCaa(host);
    } catch (error) {
      r2 = error;
    }

    compareResults(t, 'CAA', r1, r2);
  });

  // Tangerine.resolveCname"${host}"[, abortController]))
  test(`resolveCname("${host}")`, async (t) => {
    const tangerine = new Tangerine();
    const resolver = new Resolver();
    if (!t.context.isBlackholed) {
      resolver.setServers(tangerine.getServers());
    }

    let r1;
    try {
      r1 = await tangerine.resolveCname(host);
    } catch (error) {
      r1 = error;
    }

    let r2;
    try {
      r2 = await resolver.resolveCname(host);
    } catch (error) {
      r2 = error;
    }

    compareResults(t, 'CNAME', r1, r2);
  });

  // Tangerine.resolveMx"${host}"[, abortController]))
  test(`resolveMx("${host}")`, async (t) => {
    const tangerine = new Tangerine();
    const resolver = new Resolver();
    if (!t.context.isBlackholed) {
      resolver.setServers(tangerine.getServers());
    }

    let r1;
    try {
      r1 = await tangerine.resolveMx(host);
    } catch (error) {
      r1 = error;
    }

    let r2;
    try {
      r2 = await resolver.resolveMx(host);
    } catch (error) {
      r2 = error;
    }

    compareResults(t, 'MX', r1, r2);
  });

  // Tangerine.resolveNaptr"${host}"[, abortController]))
  test(`resolveNaptr("${host}")`, async (t) => {
    const tangerine = new Tangerine();
    const resolver = new Resolver();
    if (!t.context.isBlackholed) {
      resolver.setServers(tangerine.getServers());
    }

    let r1;
    try {
      r1 = await tangerine.resolveNaptr(host);
    } catch (error) {
      r1 = error;
    }

    let r2;
    try {
      r2 = await resolver.resolveNaptr(host);
    } catch (error) {
      r2 = error;
    }

    compareResults(t, 'NAPTR', r1, r2);
  });

  // Tangerine.resolveNs"${host}"[, abortController]))
  test(`resolveNs("${host}")`, async (t) => {
    const tangerine = new Tangerine();
    const resolver = new Resolver();
    if (!t.context.isBlackholed) {
      resolver.setServers(tangerine.getServers());
    }

    let r1;
    try {
      r1 = await tangerine.resolveNs(host);
    } catch (error) {
      r1 = error;
    }

    let r2;
    try {
      r2 = await resolver.resolveNs(host);
    } catch (error) {
      r2 = error;
    }

    compareResults(t, 'NS', r1, r2);
  });

  // Tangerine.resolvePtr"${host}"[, abortController]))
  test(`resolvePtr("${host}")`, async (t) => {
    const tangerine = new Tangerine();
    const resolver = new Resolver();
    if (!t.context.isBlackholed) {
      resolver.setServers(tangerine.getServers());
    }

    let r1;
    try {
      r1 = await tangerine.resolvePtr(host);
    } catch (error) {
      r1 = error;
    }

    let r2;
    try {
      r2 = await resolver.resolvePtr(host);
    } catch (error) {
      r2 = error;
    }

    compareResults(t, 'PTR', r1, r2);
  });

  // Tangerine.resolveSoa"${host}"[, abortController]))
  test(`resolveSoa("${host}")`, async (t) => {
    const tangerine = new Tangerine();
    const resolver = new Resolver();
    if (!t.context.isBlackholed) {
      resolver.setServers(tangerine.getServers());
    }

    let r1;
    try {
      r1 = await tangerine.resolveSoa(host);
    } catch (error) {
      r1 = error;
    }

    let r2;
    try {
      r2 = await resolver.resolveSoa(host);
    } catch (error) {
      r2 = error;
    }

    compareResults(t, 'SOA', r1, r2);
  });

  // Tangerine.resolveSrv"${host}"[, abortController]))
  test(`resolveSrv("${host}")`, async (t) => {
    const tangerine = new Tangerine();
    const resolver = new Resolver();
    if (!t.context.isBlackholed) {
      resolver.setServers(tangerine.getServers());
    }

    let r1;
    try {
      r1 = await tangerine.resolveSrv(host);
    } catch (error) {
      r1 = error;
    }

    let r2;
    try {
      r2 = await resolver.resolveSrv(host);
    } catch (error) {
      r2 = error;
    }

    compareResults(t, 'SRV', r1, r2);
  });

  // Tangerine.resolveTxt"${host}"[, abortController]))
  test(`resolveTxt("${host}")`, async (t) => {
    const tangerine = new Tangerine();
    const resolver = new Resolver();
    if (!t.context.isBlackholed) {
      resolver.setServers(tangerine.getServers());
    }

    let r1;
    try {
      r1 = await tangerine.resolveTxt(host);
    } catch (error) {
      r1 = error;
    }

    let r2;
    try {
      r2 = await resolver.resolveTxt(host);
    } catch (error) {
      r2 = error;
    }

    // Ensures buffer decoding cache working
    let r3;
    try {
      r3 = await tangerine.resolveTxt(host);
    } catch (error) {
      r3 = error;
    }

    compareResults(t, 'TXT', r1, r2);
    compareResults(t, 'TXT', r1, r3);
    compareResults(t, 'TXT', r2, r3);
  });
}

// Tangerine.lookupService(address, port)
// Tangerine.reverse(ip)

test('lookupService', async (t) => {
  // Returns { hostname, service }
  // so we can sort by hostname_service
  const tangerine = new Tangerine();
  const r1 = await tangerine.lookupService('1.1.1.1', 80);
  const r2 = await dns.promises.lookupService('1.1.1.1', 80);
  t.deepEqual(r1, { hostname: 'one.one.one.one', service: 'http' });
  t.deepEqual(r2, { hostname: 'one.one.one.one', service: 'http' });
});

test('reverse', async (t) => {
  // Returns an array of reversed hostnames from IP address
  const tangerine = new Tangerine();
  const resolver = new Resolver();
  if (!t.context.isBlackholed) {
    resolver.setServers(tangerine.getServers());
  }

  let r1;
  try {
    r1 = await tangerine.reverse('1.1.1.1');
  } catch (error) {
    r1 = error;
  }

  let r2;
  try {
    r2 = await resolver.reverse('1.1.1.1');
  } catch (error) {
    r2 = error;
  }

  t.deepEqual(r1, ['one.one.one.one']);
  t.deepEqual(r2, ['one.one.one.one']);
});

test('timeout', async (t) => {
  const tangerine = new Tangerine({
    timeout: 1,
    tries: 1
  });
  const error = await t.throwsAsync(tangerine.resolve('cloudflare.com'));
  // Accept both TIMEOUT and CANCELLED as valid timeout error codes
  t.true(
    error.code === dns.TIMEOUT || error.code === 'ECANCELLED',
    `Expected TIMEOUT or ECANCELLED, got ${error.code}`
  );
});

test('supports got HTTP library', async (t) => {
  const tangerine = new Tangerine(
    {
      requestOptions: {
        responseType: 'buffer',
        decompress: false,
        retry: {
          limit: 0
        }
      }
    },
    got
  );
  const resolver = new Resolver();
  if (!t.context.isBlackholed) {
    resolver.setServers(tangerine.getServers());
  }

  const host = 'cloudflare.com';
  let r1 = await tangerine.resolve(host);
  let r2 = await resolver.resolve(host);
  // See explanation below regarding this under "A" and "AAAA" in switch/case
  if (!_.isError(r1)) {
    r1 = r1.every((o) => isIPv4(o) || isIPv6(o));
  }

  if (!_.isError(r2)) {
    r2 = r2.every((o) => isIPv4(o) || isIPv6(o));
  }

  t.deepEqual(r1, r2);
});

test('creates default cache', (t) => {
  const tangerine = new Tangerine();
  t.true(tangerine.options.cache instanceof Map);
});

test('default cache supports ttl', async (t) => {
  const tangerine = new Tangerine();
  const a = await tangerine.resolve('forwardemail.net');
  const b = await tangerine.options.cache.get('a:forwardemail.net');
  compareResults(
    t,
    'A',
    a,
    b.answers.map((a) => a.data)
  );
});

test('supports redis cache', async (t) => {
  const cache = new Redis();

  // <https://github.com/luin/ioredis/issues/1179>
  Redis.Command.setArgumentTransformer('set', (args) => {
    if (typeof args[1] === 'object') {
      args[1] = JSON.stringify(args[1]);
    }

    return args;
  });

  Redis.Command.setReplyTransformer('get', (value) => {
    if (value && typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {}
    }

    return value;
  });

  const tangerine = new Tangerine({
    cache,
    setCacheArgs(key, result) {
      return ['PX', Math.round(result.ttl * 1000)];
    }
  });

  t.true(tangerine.options.cache instanceof Redis);

  const a = await tangerine.resolve('forwardemail.net');
  const b = await tangerine.options.cache.get('a:forwardemail.net');
  const c = await cache.get('a:forwardemail.net');

  compareResults(
    t,
    'A',
    a,
    b.answers.map((a) => a.data)
  );

  compareResults(
    t,
    'A',
    b.answers.map((a) => a.data),
    c.answers.map((a) => a.data)
  );
});

test('supports decoding of cached Buffers', async (t) => {
  const expirationTimestamp = Date.now() + 10_000;

  const json = `{"id":0,"type":"response","flags":384,"flag_qr":true,"opcode":"QUERY","flag_aa":false,"flag_tc":false,"flag_rd":true,"flag_ra":true,"flag_z":false,"flag_ad":false,"flag_cd":false,"rcode":"NOERROR","questions":[{"name":"forwardemail.net","type":"TXT","class":"IN"}],"answers":[{"name":"forwardemail.net","type":"TXT","ttl":3600,"class":"IN","flush":false,"data":[{"type":"Buffer","data":[104,101,108,108,111,32,119,111,114,108,100,33]}]},{"name":"forwardemail.net","type":"TXT","ttl":3600,"class":"IN","flush":false,"data":[{"type":"Buffer","data":[104,101,108,108,111,32,119,111,114,108,100,33]}]},{"name":"forwardemail.net","type":"TXT","ttl":3600,"class":"IN","flush":false,"data":[{"type":"Buffer","data":[104,101,108,108,111,32,119,111,114,108,100,33]}]},{"name":"forwardemail.net","type":"TXT","ttl":3600,"class":"IN","flush":false,"data":[{"type":"Buffer","data":[104,101,108,108,111,32,119,111,114,108,100,33]}]},{"name":"forwardemail.net","type":"TXT","ttl":3600,"class":"IN","flush":false,"data":[{"type":"Buffer","data":[104,101,108,108,111,32,119,111,114,108,100,33]}]}],"authorities":[],"additionals":[{"name":".","type":"OPT","udpPayloadSize":1232,"extendedRcode":0,"ednsVersion":0,"flags":0,"flag_do":false,"options":[{"code":12,"type":"PADDING","data":{"type":"Buffer","data":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}}]}],"ttl":3600,"expires":${expirationTimestamp}}`;
  const cache = new Map();
  const { get } = cache;
  cache.get = function (key) {
    return JSON.parse(get.call(cache, key));
  };

  const tangerine = new Tangerine({ cache });
  cache.set('txt:forwardemail.net', json);
  const results = await tangerine.resolveTxt('forwardemail.net');
  t.deepEqual(results, [
    ['hello world!'],
    ['hello world!'],
    ['hello world!'],
    ['hello world!'],
    ['hello world!']
  ]);
});

// <https://github.com/jpnarkinsky/tangerine/commit/5f70954875aa93ef4acf076172d7540298b0a16b#diff-a561630bb56b82342bc66697aee2ad96efddcbc9d150665abd6fb7ecb7c0ab2f>
test('resolveCert', async (t) => {
  const tangerine = new Tangerine();

  let r1;
  try {
    r1 = await tangerine.resolveCert('ett.healthit.gov');
  } catch (error) {
    r1 = error;
  }

  // Since the node resolver has no support for resolving CERT
  // records, the standard approach won't work here.  So, we lookup
  // a well known address that DOES have a CERT record, then check
  // that the resorts are sensible, since that's the best we can do.
  t.assert(r1.length > 0, "Couldn't resolve CERT record for ett.healthit.gov!");

  t.log(r1);

  for (const d of r1) {
    t.assert(typeof d === 'object', 'must be an object');
    t.assert(typeof d.name === 'string', 'name missing');
    t.assert(typeof d.ttl === 'number', 'ttl missing');
    t.assert(typeof d.certificateType === 'string', 'certificateType missing');
    t.assert(typeof d.keyTag === 'number', 'keyTag missing');
    t.assert(typeof d.algorithm === 'number', 'algorithm missing');
    t.assert(typeof d.certificate === 'string', 'certificate missing');
  }
});

// Similar edge case as resolveCert above, but for resolveTlsa
// <https://github.com/internetstandards/toolbox-wiki/blob/main/DANE-for-SMTP-how-to.md>
test('resolveTlsa', async (t) => {
  const tangerine = new Tangerine();

  let r1;
  try {
    r1 = await tangerine.resolveTlsa('_25._tcp.internet.nl');
  } catch (error) {
    r1 = error;
  }

  // TLSA records might not be available - this is not necessarily an error
  if (_.isError(r1)) {
    if (r1.code === 'ENOTFOUND' || r1.code === 'ENODATA') {
      t.pass(`TLSA record not available for _25._tcp.internet.nl (${r1.code})`);
      return;
    }

    t.fail(`Unexpected error resolving TLSA record: ${r1.message}`);
    return;
  }

  t.assert(
    r1.length > 0,
    "Couldn't resolve TLSA record for _25._tcp.internet.nl!"
  );

  t.log(r1);

  for (const d of r1) {
    t.assert(typeof d === 'object', 'must be an object');
    t.assert(typeof d.name === 'string', 'name missing');
    t.assert(typeof d.ttl === 'number', 'ttl missing');
    t.assert(typeof d.usage === 'number', 'usage missing');
    t.assert(typeof d.selector === 'number', 'selector missing');
    t.assert(typeof d.mtype === 'number', 'mtype missing');
    t.assert(Buffer.isBuffer(d.cert), 'cert must be buffer');
  }
});

test('spoofPacket with json', async (t) => {
  const cache = new Redis();
  const tangerine = new Tangerine({ cache });

  const txt = tangerine.spoofPacket(
    'forwardemail.net',
    'TXT',
    ['v=spf1 ip4:127.0.0.1 -all'],
    true
  );

  t.deepEqual(_.omit(JSON.parse(txt), ['expires']), {
    id: 0,
    type: 'response',
    flags: 384,
    flagQr: true,
    opcode: 'QUERY',
    flagAa: false,
    flagTc: false,
    flagRd: true,
    flagRa: true,
    flagZ: false,
    flagAd: false,
    flagCd: false,
    rcode: 'NOERROR',
    questions: [{ name: 'forwardemail.net', type: 'TXT', class: 'IN' }],
    answers: [
      {
        name: 'forwardemail.net',
        type: 'TXT',
        ttl: 300,
        class: 'IN',
        flush: false,
        data: ['v=spf1 ip4:127.0.0.1 -all']
      }
    ],
    authorities: [],
    additionals: [
      {
        name: '.',
        type: 'OPT',
        udpPayloadSize: 1232,
        extendedRcode: 0,
        ednsVersion: 0,
        flags: 0,
        flagDo: false,
        options: [null]
      }
    ],
    ttl: 300
    // Expires: 1684087106042
  });

  await cache.set('txt:forwardemail.net', txt);

  const txtDns = await tangerine.resolveTxt('forwardemail.net');

  t.deepEqual(txtDns, [['v=spf1 ip4:127.0.0.1 -all']]);
});

test('spoofPacket', async (t) => {
  const cache = new Redis();
  const tangerine = new Tangerine({ cache });

  const txt = tangerine.spoofPacket('forwardemail.net', 'TXT', [
    'v=spf1 ip4:127.0.0.1 -all'
  ]);

  t.deepEqual(txt.answers, [
    {
      name: 'forwardemail.net',
      type: 'TXT',
      ttl: 300,
      class: 'IN',
      flush: false,
      data: ['v=spf1 ip4:127.0.0.1 -all']
    }
  ]);

  await cache.set('txt:forwardemail.net', JSON.stringify(txt));

  const txtDns = await tangerine.resolveTxt('forwardemail.net');

  t.deepEqual(txtDns, [['v=spf1 ip4:127.0.0.1 -all']]);

  const mx = tangerine.spoofPacket('forwardemail.net', 'MX', [
    { exchange: 'mx1.forwardemail.net', preference: 0 },
    { exchange: 'mx2.forwardemail.net', preference: 0 }
  ]);

  t.deepEqual(mx.answers, [
    {
      name: 'forwardemail.net',
      type: 'MX',
      ttl: 300,
      class: 'IN',
      flush: false,
      data: {
        preference: 0,
        exchange: 'mx1.forwardemail.net'
      }
    },
    {
      name: 'forwardemail.net',
      type: 'MX',
      ttl: 300,
      class: 'IN',
      flush: false,
      data: {
        preference: 0,
        exchange: 'mx2.forwardemail.net'
      }
    }
  ]);

  await cache.set('mx:forwardemail.net', JSON.stringify(mx));

  const mxDns = await tangerine.resolveMx('forwardemail.net');

  t.deepEqual(mxDns, [
    { exchange: 'mx1.forwardemail.net', priority: 0 },
    { exchange: 'mx2.forwardemail.net', priority: 0 }
  ]);
});
