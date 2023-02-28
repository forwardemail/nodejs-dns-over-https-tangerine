<h1 align="center">
  <a href="https://github.com/forwardemail/tangerine"><img src="https://raw.githubusercontent.com/forwardemail/tangerine/main/media/header.png" alt="Tangerine" /></a>
</h1>
<div align="center">
  <a href="https://github.com/forwardemail/tangerine/actions/workflows/ci.yml"><img src="https://github.com/forwardemail/tangerine/actions/workflows/ci.yml/badge.svg" alt="build status" /></a>
  <a href="https://github.com/sindresorhus/xo"><img src="https://img.shields.io/badge/code_style-XO-5ed9c7.svg" alt="code style" /></a>
  <a href="https://github.com/prettier/prettier"><img src="https://img.shields.io/badge/styled_with-prettier-ff69b4.svg" alt="styled with prettier" /></a>
  <a href="https://lass.js.org"><img src="https://img.shields.io/badge/made_with-lass-95CC28.svg" alt="made with lass" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/forwardemail/tangerine.svg" alt="license" /></a>
  <a href="https://npm.im/tangerine"><img src="https://img.shields.io/npm/dt/tangerine.svg" alt="npm downloads" /></a>
</div>
<br />
<div align="center">
  🍊 <a href="https://github.com/forwardemail/tangerine" target="_blank">Tangerine</a> is the best <a href="https://nodejs.org" target="_blank">Node.js</a> drop-in replacement for <a href="https://nodejs.org/api/dns.html#resolveroptions" target="_blank">dns.promises.Resolver</a> using <a href="https://en.wikipedia.org/wiki/DNS_over_HTTPS" target="_blank">DNS over HTTPS</a> ("DoH") via <a href="https://github.com/nodejs/undici" target="_blank">undici</a> with built-in retries, timeouts, smart server rotation, <a href="https://developer.mozilla.org/en-US/docs/Web/API/AbortController" target="_blank">AbortControllers</a>, and caching support for multiple backends (with TTL support).
</div>
<hr />
<div align="center">
  ⚡ <a href="#tangerine-benchmarks"><i><u><strong>AS FAST AS</strong></u></i></a> native <a href="https://nodejs.org/api/dns.html" target="_blank">Node.js <code>dns</code></a>! 🚀 &bull; Supports Node v16+ with ESM/CJS &bull; Made for <a href="https://forwardemail.net" target="_blank"><strong>Forward Email</strong></a>.
</div>
<hr />


## Table of Contents

* [Install](#install)
* [Foreword](#foreword)
  * [What is this project about](#what-is-this-project-about)
  * [Why integrate DNS over HTTPS](#why-integrate-dns-over-https)
  * [What does this mean](#what-does-this-mean)
  * [What projects were used for inspiration](#what-projects-were-used-for-inspiration)
* [Features](#features)
* [Usage and Examples](#usage-and-examples)
  * [ECMAScript modules (ESM)](#ecmascript-modules-esm)
  * [CommonJS (CJS)](#commonjs-cjs)
* [API](#api)
  * [`new Tangerine(options[, request])`](#new-tangerineoptions-request)
  * [`tangerine.cancel()`](#tangerinecancel)
  * [`tangerine.getServers()`](#tangerinegetservers)
  * [`tangerine.lookup(hostname[, options])`](#tangerinelookuphostname-options)
  * [`tangerine.lookupService(address, port, abortController)`](#tangerinelookupserviceaddress-port-abortcontroller)
  * [`tangerine.resolve(hostname[, rrtype, options, abortController])`](#tangerineresolvehostname-rrtype-options-abortcontroller)
  * [`tangerine.resolve4(hostname[, options, abortController])`](#tangerineresolve4hostname-options-abortcontroller)
  * [`tangerine.resolve6(hostname[, options, abortController])`](#tangerineresolve6hostname-options-abortcontroller)
  * [`tangerine.resolveAny(hostname[, abortController])`](#tangerineresolveanyhostname-abortcontroller)
  * [`tangerine.resolveCaa(hostname[, abortController]))`](#tangerineresolvecaahostname-abortcontroller)
  * [`tangerine.resolveCname(hostname[, abortController]))`](#tangerineresolvecnamehostname-abortcontroller)
  * [`tangerine.resolveMx(hostname[, abortController]))`](#tangerineresolvemxhostname-abortcontroller)
  * [`tangerine.resolveNaptr(hostname[, abortController]))`](#tangerineresolvenaptrhostname-abortcontroller)
  * [`tangerine.resolveNs(hostname[, abortController]))`](#tangerineresolvenshostname-abortcontroller)
  * [`tangerine.resolvePtr(hostname[, abortController]))`](#tangerineresolveptrhostname-abortcontroller)
  * [`tangerine.resolveSoa(hostname[, abortController]))`](#tangerineresolvesoahostname-abortcontroller)
  * [`tangerine.resolveSrv(hostname[, abortController]))`](#tangerineresolvesrvhostname-abortcontroller)
  * [`tangerine.resolveTxt(hostname[, abortController]))`](#tangerineresolvetxthostname-abortcontroller)
  * [`tangerine.reverse(ip[, abortController])`](#tangerinereverseip-abortcontroller)
  * [`tangerine.setDefaultResultOrder(order)`](#tangerinesetdefaultresultorderorder)
  * [`tangerine.setServers(servers)`](#tangerinesetserversservers)
* [Options](#options)
* [Cache](#cache)
* [Debugging](#debugging)
* [Benchmarks](#benchmarks)
  * [Tangerine Benchmarks](#tangerine-benchmarks)
  * [HTTP Library Benchmarks](#http-library-benchmarks)
* [Contributors](#contributors)
* [License](#license)


## Install

```sh
npm install tangerine undici
```

```diff
-import dns from 'dns';
+import Tangerine from 'tangerine';

- const resolver = new dns.promises.Resolver();
+const resolver = new Tangerine();
```


## Foreword

### What is this project about

Our team at [Forward Email](https://forwardemail.net) (100% open-source and privacy-focused email service) needed a better solution for DNS.

<details>
<summary>After years of using the Node.js internal DNS module, we ran into these recurring patterns:</summary>

* [Cloudflare](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/) and [Google](https://developers.google.com/speed/public-dns/docs/doh/) now have DNS over HTTPS servers ("DoH") available – and browsers such as Mozilla Firefox now have it [enabled by default](https://support.mozilla.org/en-US/kb/firefox-dns-over-https).
* DNS cache consistency across multiple servers cannot be easily accomplished using packages such as `unbound`, `dnsmasq`, and `bind` – and configuring `/etc/resolv.conf` across multiple Ubuntu versions is not enjoyable (even with Ansible).  Maintaining logic at the application layer is much easier from a development, deployment, and maintenance perspective.
* Privacy, security, and caching approaches needed to be constantly scaled, re-written, and re-configured.
* Our development teams would encounter unexpected 75 second delays while making DNS requests (if they were connected to a VPN and forgot they were behind blackholed DNS servers – and attempting to use patterns such as `dns.setServers(['1.1.1.1'])`).  The default timeout if you are behind a blackholed DNS server in Node.js is 75 seconds (due to `c-ares` under the hood with `5`, `10`, `20`, and `40` second retry backoff timeout strategy).
* There are **zero existing** DNS over HTTPS ("DoH") Node.js npm packages that:
  * Utilize modern open-source software under the MIT license and are currently maintained.
    * Once popular packages such as [native-dns](https://github.com/tjfontaine/node-dns/issues/111) and [dnscached](https://github.com/yahoo/dnscache/issues/28) are archived or deprecated.
    * [Other packages](https://www.npmjs.com/search?q=dns%20cache) only provide `lookup` functions, have a limited sub-set of methods such as [@zeit/dns-cached-resolver](https://github.com/vercel/dns-cached-resolve), or are unmaintained.
  * Act as a 1:1 drop-in replacement for `dns.promises.Resolver` with DNS over HTTPS ("DoH").
  * Support caching for multiple backends (with TTL support), retries, smart server rotation, and [AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) usage.
  * Provide out of the box support for both ECMAScript modules (ESM) **and** CommonJS (CJS) (see discussions [for](https://gist.github.com/sindresorhus/a39789f98801d908bbc7ff3ecc99d99c) and [against](https://gist.github.com/joepie91/bca2fda868c1e8b2c2caf76af7dfcad3)).
* The native Node.js `dns` module does not support caching out of the box – which is a [highly requested feature](https://github.com/nodejs/node/issues/5893) (but belongs in userland).
* Writing tests against DNS-related infrastructure requires either hacky DNS mocking or a DNS server (manipulating cache is much easier).
* <u>**The Node.js community is lacking a high-quality and dummy-proof userland DNS package with sensible defaults.**</u>

</details>

### Why integrate DNS over HTTPS

> With DNS over HTTPS (DoH), DNS queries and responses are encrypted and sent via the HTTP or HTTP/2 protocols. DoH ensures that attackers cannot forge or alter DNS traffic. DoH uses port 443, which is the standard HTTPS traffic port, to wrap the DNS query in an HTTPS request. DNS queries and responses are camouflaged within other HTTPS traffic, since it all comes and goes from the same port. – [Cloudflare](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/)

> DNS over HTTPS (DoH) is a protocol for performing remote [Domain Name System](https://en.wikipedia.org/wiki/Domain_Name_System) (DNS) resolution via the [HTTPS](https://en.wikipedia.org/wiki/HTTPS) protocol. A goal of the method is to increase user privacy and security by preventing eavesdropping and manipulation of DNS data by [man-in-the-middle attacks](https://en.wikipedia.org/wiki/Man-in-the-middle_attacks) by using the HTTPS protocol to [encrypt](https://en.wikipedia.org/wiki/Encrypt) the data between the DoH client and the DoH-based [DNS resolver](https://en.wikipedia.org/wiki/DNS_resolver). – [Wikipedia](https://en.wikipedia.org/wiki/DNS_over_HTTPS)

### What does this mean

[We're](https://forwardemail.net) the <i>only</i> email service provider that is 100% open-source *and* uses DNS over HTTPS ("DoH") throughout their entire infrastructure.  We've open-sourced this project – which means you can integrate DNS over HTTPS ("DoH") by simply using :tangerine: Tangerine.  Its documentation below includes [Features](#features), [Usage and Examples](#usage-and-examples), [API](#api), [Options](#options), and [Benchmarks](#tangerine-benchmarks).

### What projects were used for inspiration

Thanks to the authors of [dohdec](https://github.com/hildjj/dohdec), [dns-packet](https://github.com/mafintosh/dns-packet), [dns2](https://github.com/song940/node-dns), and [native-dnssec-dns](https://github.com/EduardoRuizM/native-dnssec-dns) – which made this project possible and were used for inspiration.


## Features

:tangerine: Tangerine is a 1:1 **drop-in replacement with DNS over HTTPS ("DoH")** for [dns.promises.Resolver](https://nodejs.org/api/dns.html#resolveroptions):

* All options and defaults for `new dns.promises.Resolver()` are available in `new Tangerine()`.
* Instances of `Tangerine` are also instances of `dns.promises.Resolver` as this class `extends` from it.  This makes it compatible with [cacheable-lookup](https://github.com/szmarczak/cacheable-lookup).
* HTTP error codes are mapped to DNS error codes (the error `code` and `errno` properties will appear as if they're from `dns` usage).  This is a configurable option enabled by default (see `returnHTTPErrors` option).
* If you need callbacks, then use [util.callbackify](https://nodejs.org/api/util.html#utilcallbackifyoriginal) (e.g. `const resolveTxt = callbackify(tangerine.resolveTxt)`).

<details>
<summary>We have also added several improvements and new features:</summary>

* Default name servers used have been set to [Cloudflare's](https://1.1.1.1/) (`['1.1.1.1', '1.0.0.1']`) (as opposed to the system default – which is often set to a default which is not privacy-focused or simply forgotten to be set by DevOps teams).  You may also want to use [Cloudflare's Malware and Adult Content Blocking](https://blog.cloudflare.com/introducing-1-1-1-1-for-families/) DNS server addresses instead.
* You can pass a custom `servers` option (as opposed to having to invoke `dns.setServers(...)` or `resolver.setServers(...)`).
* `lookup` and `lookupService` methods have been added (these are not in the original `dns.promises.Resolver` instance methods).
* [AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) support has been added to all DNS request methods (you can also pass your own).
* The method `cancel()` will signal `"abort"` to all AbortController signals created for existing requests and handle cleanup.
* An `ecsClientSubnet` option has been added to all methods accepting an `options` object for [RFC 7871](https://datatracker.ietf.org/doc/html/rfc7871) client subnet querying (this includes `resolve4` and `resolve6`).
* If you have multiple DNS servers configured (e.g. `tangerine.setServers(['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4'])`) – and if any of these servers have repeated errors, then they will be bumped to the end of the list (e.g. if `1.1.1.1` has errors, then the updated in-memory `Set` for future requests will be `['1.0.0.1', '8.8.8.8', '8.8.4.4', '1.1.1.1']`).  This "smart server rotation" behavior can be disabled (see `smartRotate` option) – but it is discouraged, as the original behavior of [c-ares](https://c-ares.org/) does not rotate as such.
* Debug via `NODE_DEBUG=tangerine node app.js` flag (uses [util.debuglog](https://nodejs.org/api/util.html#utildebuglogsection-callback)).
* The method `setLocalAddress()` will parse the IP address and port properly to pass along for use with the agent as `localAddress` and `localPort`.  If you require IPv6 addresses with ports, you must encode it as `[IPv6]:PORT` ([similar to RFC 3986](https://serverfault.com/a/205794)).

</details>

<details>
<summary>All existing <code>syscall</code> values have been preserved:</summary>

* `resolveAny` → `queryAny`
* `resolve4` → `queryA`
* `resolve6` → `queryAaaa`
* `resolveCaa` → `queryCaa`
* `resolveCname` → `queryCname`
* `resolveMx` → `queryMx`
* `resolveNs` → `queryNs`
* `resolveNs` → `queryNs`
* `resolveTxt` → `queryTxt`
* `resolveSrv` → `querySrv`
* `resolvePtr` → `queryPtr`
* `resolveNaptr` → `queryNaptr`
* `resolveSoa` → `querySoa`
* `reverse` → `getHostByAddr`

</details>


## Usage and Examples

### ECMAScript modules (ESM)

```js
// app.mjs

import Tangerine from 'tangerine';

const tangerine = new Tangerine();
// or `const resolver = new Tangerine()`

tangerine.resolve('forwardemail.net').then(console.log);
```

### CommonJS (CJS)

```js
// app.js

const Tangerine = require('tangerine');

const tangerine = new Tangerine();
// or `const resolver = new Tangerine()`

tangerine.resolve('forwardemail.net').then(console.log);
```


## API

### `new Tangerine(options[, request])`

* The `request` argument is a `Function` that defaults to [undici.request](https://undici.nodejs.org/#/?id=undicirequesturl-options-promise).
  * This is an HTTP library request async or Promise returning function to be used for making requests.

  * You could alternatively use [got](https://github.com/sindresorhus/got) or any other HTTP library of your choice that accepts `fn(url, options)`.  However, we suggest to stick with the default of `undici` due to these [benchmark tests](http-library-benchmarks).

    ```js
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
    ```

  * It should return an object with `body`, `headers`, and either a `status` or `statusCode` property.

  * The `body` property returned should be either a `Buffer` or `Stream`.

  * Specify default request options based off the library under `requestOptions` below
* Instance methods of [dns.promises.Resolver](https://nodejs.org/api/dns.html) are mirrored to :tangerine: Tangerine.
* Resolver methods accept an optional `abortController` argument, which is an instance of [AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).  Note that :tangerine: Tangerine manages `AbortController` usage internally – so you most likely won't need to pass your own (see [index.js](https://github.com/forwardemail/tangerine/blob/main/index.js) for more insight).
* See the complete list of [Options](#options) below.
* Instances of `new Tangerine()` are instances of `dns.promises.Resolver` via `class Tangerine extends dns.promises.Resolver { ... }` (namely for compatibility with projects such as [cacheable-lookup](https://github.com/szmarczak/cacheable-lookup)).

### `tangerine.cancel()`

### `tangerine.getServers()`

### `tangerine.lookup(hostname[, options])`

### `tangerine.lookupService(address, port, abortController)`

### `tangerine.resolve(hostname[, rrtype, options, abortController])`

### `tangerine.resolve4(hostname[, options, abortController])`

Tangerine supports a new `ecsSubnet` property in the `options` Object argument.

### `tangerine.resolve6(hostname[, options, abortController])`

Tangerine supports a new `ecsSubnet` property in the `options` Object argument.

### `tangerine.resolveAny(hostname[, abortController])`

### `tangerine.resolveCaa(hostname[, abortController]))`

### `tangerine.resolveCname(hostname[, abortController]))`

### `tangerine.resolveMx(hostname[, abortController]))`

### `tangerine.resolveNaptr(hostname[, abortController]))`

### `tangerine.resolveNs(hostname[, abortController]))`

### `tangerine.resolvePtr(hostname[, abortController]))`

### `tangerine.resolveSoa(hostname[, abortController]))`

### `tangerine.resolveSrv(hostname[, abortController]))`

### `tangerine.resolveTxt(hostname[, abortController]))`

### `tangerine.reverse(ip[, abortController])`

### `tangerine.setDefaultResultOrder(order)`

### `tangerine.setServers(servers)`


## Options

Similar to the `options` argument from `new dns.promises.Resolver(options)` invocation – :tangerine: Tangerine also has its own options with default `dns` behavior mirrored. See [index.js](https://github.com/forwardemail/tangerine/blob/main/index.js) for more insight into how these options work.

| Property                  | Type                                                                          | Default Value                                                                                                                               | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout`                 | `Number`                                                                      | `5000`                                                                                                                                      | Number of milliseconds for requests to timeout.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tries`                   | `Number`                                                                      | `4`                                                                                                                                         | Number of tries per `server` in `servers` to attempt.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `servers`                 | `Set` or `Array`                                                              | `new Set(['1.1.1.1', '1.0.0.1'])`                                                                                                           | A Set or Array of [RFC 5952](https://tools.ietf.org/html/rfc5952#section-6) formatted addresses for DNS queries (matches default Node.js dns module behavior).  Duplicates will be removed as this is converted to a `Set` internally.  Defaults to Cloudflare's of `1.1.1.1` and `1.0.0.1`.  If an `Array` is passed, then it will be converted to a `Set`.                                                                                                            |
| `requestOptions`          | `Object`                                                                      | Defaults to an Object with `requestOptions.method` and `requestOptions.headers` properties and values below                                 | Default options to pass to [undici](https://github.com/nodejs/undici) (or your custom HTTP library function passed as `request`).                                                                                                                                                                                                                                                                                                                                       |
| `requestOptions.method`   | `String`                                                                      | Defaults to `"GET"` (must be either `"GET"` or `"POST"`, case-insensitive depending on library you use).                                    | Default HTTP method to use for DNS over HTTP ("DoH") requests.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `requestOptions.headers`  | `Object`                                                                      | Defaults to `{ 'content-type': 'application/dns-message', 'user-agent': pkg.name + "/" + pkg.version, accept: 'application/dns-message' }`. | Default HTTP headers to use for DNS over HTTP ("DoH") requests.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `protocol`                | `String`                                                                      | Defaults to `"https"`.                                                                                                                      | Default HTTP protocol to use for DNS over HTTPS ("DoH") requests.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `dnsOrder`                | `String`                                                                      | Defaults to `"verbatim"` for Node.js v17.0.0+ and `"ipv4first"` for older versions.                                                         | Sets the default result order of `lookup` invocations (see [dns.setDefaultResultOrder](https://nodejs.org/api/dns.html#dnssetdefaultresultorderorder) for more insight).                                                                                                                                                                                                                                                                                                |
| `logger`                  | `Object`                                                                      | `false`                                                                                                                                     | This is the default logger.  We recommend using [Cabin](https://github.com/cabinjs) instead of using `console` as your default logger.  Set this value to `false` to disable logging entirely (uses noop function).                                                                                                                                                                                                                                                     |
| `id`                      | `Number` or `Function`                                                        | `0`                                                                                                                                         | Default `id` to be passed for DNS packet creation.  This could alternatively be a synchronous or asynchronous function that returns a `Number` (e.g. `id: () => Tangerine.getRandomInt(1, 65534)`).                                                                                                                                                                                                                                                                     |
| `concurrency`             | `Number`                                                                      | `os.cpus().length`                                                                                                                          | Default concurrency to use for `resolveAny` lookup via [p-map](https://github.com/sindresorhus/p-map).  The default value is the number of CPU's available to the system using the Node.js `os` module [os.cpus()](https://nodejs.org/api/os.html#oscpus) method.                                                                                                                                                                                                       |
| `ipv4`                    | `String`                                                                      | `"0.0.0.0"`                                                                                                                                 | Default IPv4 address to use for HTTP agent `localAddress` if DNS `server` was an IPv4 address.                                                                                                                                                                                                                                                                                                                                                                          |
| `ipv6`                    | `String`                                                                      | `"::0"`                                                                                                                                     | Default IPv6 address to use for HTTP agent `localAddress` if DNS `server` was an IPv6 address.                                                                                                                                                                                                                                                                                                                                                                          |
| `ipv4Port`                | `Number`                                                                      | `undefined`                                                                                                                                 | Default port to use for HTTP agent `localPort` if DNS `server` was an IPv4 address.                                                                                                                                                                                                                                                                                                                                                                                     |
| `ipv6Port`                | `Number`                                                                      | `undefined`                                                                                                                                 | Default port to use for HTTP agent `localPort` if DNS `server` was an IPv6 address.                                                                                                                                                                                                                                                                                                                                                                                     |
| `cache`                   | `Map`, `Boolean`, or custom cache implementation with `get` and `set` methods | `new Map()`                                                                                                                                 | Set this to `false` in order to disable caching. By default or if you pass `cache: true`, it will use a new `Map` instance for caching.  See [Cache](#cache) documentation and the options `defaultTTLSeconds`, `maxTTLSeconds`, and `setCacheArgs` below.                                                                                                                                                                                                              |
| `defaultTTLSeconds`       | `Number` (seconds)                                                            | `300`                                                                                                                                       | The default number of seconds to use for storing results in cache (defaults to [Cloudflare's recommendation](https://developers.cloudflare.com/dns/manage-dns-records/reference/ttl/) of 300 seconds – 5 minutes).                                                                                                                                                                                                                                                      |
| `maxTTLSeconds`           | `Number` (seconds)                                                            | `86400`                                                                                                                                     | The maximum number of seconds to use for storing results in cache (defaults to [Cloudflare's recommendation](https://developers.cloudflare.com/dns/manage-dns-records/reference/ttl/) of 86,400 seconds – 24 hours – 1 day).                                                                                                                                                                                                                                            |
| `setCacheArgs`            | `Function`                                                                    | `(key, result) => []`                                                                                                                       | This is a helper function used for cache store providers such as [ioredis](https://github.com/luin/ioredis) or [lru-cache](https://github.com/isaacs/node-lru-cache) which support more than two arguments to `cache.set()` function.  See [Cache](#cache) documentation below for more insight and examples into how this works.  You may want to set this to something such as `(key, result) => [ 'PX', Math.round(result.ttl * 1000) ]` if you are using `ioredis`. |
| `returnHTTPErrors`        | `Boolean`                                                                     | `false`                                                                                                                                     | Whether to return HTTP errors instead of mapping them to corresponding DNS errors.                                                                                                                                                                                                                                                                                                                                                                                      |
| `smartRotate`             | `Boolean`                                                                     | `true`                                                                                                                                      | Whether to do smart server rotation if servers fail.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `defaultHTTPErrorMessage` | `String`                                                                      | `"Unsuccessful HTTP response"`                                                                                                              | Default fallback message if `statusCode` returned from HTTP request was not found in [http.STATUS_CODES](https://nodejs.org/api/http.html#httpstatus_codes).                                                                                                                                                                                                                                                                                                            |


## Cache

:tangerine: Tangerine supports custom cache implementations, such as with [ioredis](https://github.com/luin/ioredis) or any other cache store that has a Map-like implementation with `set(key, value)` and `get(key)` methods.  If your cache implementation allows a third argument to `set()`, such as `set(key, value, ttl)` or `set(key, value, { maxAge })`, then you must set the `setCacheArgs` option respectively (see below examples).  A third argument with TTL argument support is optional as it is already built-in to :tangerine: Tangerine out of the box (cached results store their TTL and expiration time on the objects themselves – view source code for insight).

```sh
npm install tangerine undici ioredis
```

```js
// app.js

const Redis = require('ioredis');
const Tangerine = require('tangerine');

// <https://github.com/luin/ioredis/issues/1179>
Redis.Command.setArgumentTransformer('set', (args) => {
  if (typeof args[1] === 'object') args[1] = JSON.stringify(args[1]);
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

const cache = new Redis();
const tangerine = new Tangerine({
  cache,
  setCacheArgs(key, result) {
    return ['PX', Math.round(result.ttl * 1000)];
  }
});

(async () => {
  console.time('without cache');
  await tangerine.resolve('forwardemail.net'); // <-- cached
  console.timeEnd('without cache');

  console.time('with cache');
  await tangerine.resolve('forwardemail.net'); // <-- uses cached value
  console.timeEnd('with cache');
})();
```

```sh
❯ node app
without cache: 98.25ms
with cache: 0.091ms
```


## Debugging

If you run into issues while using :tangerine: Tangerine, then these recommendations may help:

* Set `NODE_DEBUG=tangerine` environment variable flag when you start your app:

  ```sh
  NODE_DEBUG=tangerine node app.js
  ```

* Pass a verbose logger as the `logger` option, e.g. `logger: console` (see [Options](#options) above).

* Assuming you are not allergic, try eating a [nutritious](https://en.wikipedia.org/wiki/Tangerine#Nutrition) :tangerine: tangerine.


## Benchmarks

Contributors can run benchmarks locally by cloning the repository, installing dependencies, and running the benchmarks script:

```sh
git clone https://github.com/forwardemail/tangerine.git
cd tangerine
npm install
npm run benchmarks
```

You can also specify optional custom environment variables to test against real-world or locally running servers (instead of using mocked in-memory servers):

```sh
BENCHMARK_PROTOCOL="http" BENCHMARK_HOST="127.0.0.1" BENCHMARK_PORT="4000" BENCHMARK_PATH="/v1/test" npm run benchmarks
```

### Tangerine Benchmarks

We have written extensive benchmarks to show that :tangerine: Tangerine is as fast as the native Node.js DNS module (with the exception of the `lookup` command).  Note that performance is opinionated – since rate limiting plays a factor dependent on the DNS servers you are using and since caching is most likely going to takeover.

The latest benchmark results are viewable on GitHub under this repository's [GitHub CI actions logs](https://github.com/forwardemail/tangerine/actions?query=event%3Apush):

> [Node 16 on ubuntu-latest](#TODO)

```sh
> node benchmarks/lookup && node benchmarks/resolve && node benchmarks/reverse

TODO
```

> **NOTE**: HTTP library benchmark tests above are not based on real-world usage; instead they are using mock libraries such as `nock` and undici's `MockAgent`.  An actual HTTP server could be implemented in these benchmarks (pull request is welcome).  See [HTTP Library Benchmarks](#http-library-benchmarks) below for more insight into results with real-world servers.

> [Node 18 on ubuntu latest](#TODO)

```sh
> node benchmarks/lookup && node benchmarks/resolve && node benchmarks/reverse && node benchmarks/http

TODO
```

> **NOTE**: HTTP library benchmark tests above are not based on real-world usage; instead they are using mock libraries such as `nock` and undici's `MockAgent`.  An actual HTTP server could be implemented in these benchmarks (pull request is welcome).  See [HTTP Library Benchmarks](#http-library-benchmarks) below for more insight into results with real-world servers.

---

You can also [run the benchmarks yourself](#benchmarks).

---

Provided below are additional benchmark tests we have run:

> Node v18.14.2 on MacBook Air M1 16GB (without VPN):

```diff
> node --version
v18.14.2

> node benchmarks/lookup && node benchmarks/resolve && node benchmarks/reverse

Started: lookup
tangerine.lookup POST with caching using Cloudflare x 1,035 ops/sec ±195.73% (91 runs sampled)
tangerine.lookup POST without caching using Cloudflare x 52.76 ops/sec ±51.29% (53 runs sampled)
tangerine.lookup GET with caching using Cloudflare x 694,910 ops/sec ±1.54% (87 runs sampled)
+tangerine.lookup GET without caching using Cloudflare x 40.18 ops/sec ±60.19% (49 runs sampled)
dns.promises.lookup with caching using Cloudflare x 12,645,103 ops/sec ±0.26% (90 runs sampled)
-dns.promises.lookup without caching using Cloudflare x 2,664 ops/sec ±0.54% (88 runs sampled)
Fastest without caching is: dns.promises.lookup without caching using Cloudflare

Started: resolve
tangerine.resolve POST with caching using Cloudflare x 1,005 ops/sec ±195.93% (91 runs sampled)
tangerine.resolve POST without caching using Cloudflare x 55.52 ops/sec ±46.26% (57 runs sampled)
tangerine.resolve GET with caching using Cloudflare x 2,879,865 ops/sec ±0.35% (86 runs sampled)
+tangerine.resolve GET without caching using Cloudflare x 71.11 ops/sec ±2.94% (74 runs sampled)
tangerine.resolve POST with caching using Google x 1,292 ops/sec ±195.91% (88 runs sampled)
tangerine.resolve POST without caching using Google x 36.88 ops/sec ±41.76% (53 runs sampled)
tangerine.resolve GET with caching using Google x 2,885,428 ops/sec ±0.22% (88 runs sampled)
tangerine.resolve GET without caching using Google x 70.38 ops/sec ±3.72% (68 runs sampled)
resolver.resolve with caching using Cloudflare x 10,645,813 ops/sec ±0.23% (91 runs sampled)
-resolver.resolve without caching using Cloudflare x 71.80 ops/sec ±2.84% (67 runs sampled)
Fastest without caching is: resolver.resolve without caching using Cloudflare, tangerine.resolve GET without caching using Cloudflare, tangerine.resolve GET without caching using Google, tangerine.resolve POST without caching using Cloudflare

Started: reverse
tangerine.reverse GET with caching x 917 ops/sec ±195.78% (88 runs sampled)
+tangerine.reverse GET without caching x 51.15 ops/sec ±51.92% (61 runs sampled)
resolver.reverse with caching x 11,058,579 ops/sec ±0.37% (88 runs sampled)
-resolver.reverse without caching x 62.30 ops/sec ±24.83% (64 runs sampled)
dns.promises.reverse with caching x 11,276,123 ops/sec ±0.17% (90 runs sampled)
-dns.promises.reverse without caching x 73.46 ops/sec ±1.99% (69 runs sampled)
Fastest without caching is: dns.promises.reverse without caching, resolver.reverse without caching
```

> Node v18.14.2 on MacBook Air M1 16GB (with DNS blackholed VPN) – **this highlights the DNS blackhole problem**:

```diff
> node --version
v18.14.2

> node benchmarks/lookup && node benchmarks/resolve && node benchmarks/reverse

Started: lookup
tangerine.lookup POST with caching using Cloudflare x 1,327 ops/sec ±195.65% (89 runs sampled)
tangerine.lookup POST without caching using Cloudflare x 71.11 ops/sec ±8.24% (71 runs sampled)
tangerine.lookup GET with caching using Cloudflare x 759,816 ops/sec ±0.46% (90 runs sampled)
+tangerine.lookup GET without caching using Cloudflare x 73.98 ops/sec ±1.78% (69 runs sampled)
dns.promises.lookup with caching using Cloudflare x 1,744 ops/sec ±195.97% (88 runs sampled)
-dns.promises.lookup without caching using Cloudflare x 2,717 ops/sec ±0.82% (87 runs sampled)
Fastest without caching is: dns.promises.lookup without caching using Cloudflare

Started: resolve
tangerine.resolve POST with caching using Cloudflare x 947 ops/sec ±195.93% (91 runs sampled)
tangerine.resolve POST without caching using Cloudflare x 44.33 ops/sec ±73.30% (75 runs sampled)
tangerine.resolve GET with caching using Cloudflare x 2,814,737 ops/sec ±0.17% (91 runs sampled)
+tangerine.resolve GET without caching using Cloudflare x 57.25 ops/sec ±51.61% (73 runs sampled)
tangerine.resolve POST with caching using Google x 1,087 ops/sec ±195.92% (91 runs sampled)
tangerine.resolve POST without caching using Google x 36.84 ops/sec ±7.04% (62 runs sampled)
tangerine.resolve GET with caching using Google x 2,784,199 ops/sec ±0.15% (92 runs sampled)
tangerine.resolve GET without caching using Google x 47.55 ops/sec ±5.66% (76 runs sampled)
resolver.resolve with caching using Cloudflare x 0.09 ops/sec ±6.41% (5 runs sampled)
-resolver.resolve without caching using Cloudflare x 0.10 ops/sec ±6.52% (5 runs sampled)
Fastest without caching is: tangerine.resolve GET without caching using Google

Started: reverse
tangerine.reverse GET with caching x 1,345 ops/sec ±195.66% (92 runs sampled)
+tangerine.reverse GET without caching x 71.73 ops/sec ±3.03% (73 runs sampled)
resolver.reverse with caching x 0.10 ops/sec ±6.54% (5 runs sampled)
-resolver.reverse without caching x 0.10 ops/sec ±0.01% (5 runs sampled)
dns.promises.reverse with caching x 0.10 ops/sec ±6.54% (5 runs sampled)
-dns.promises.reverse without caching x 0.10 ops/sec ±0.01% (5 runs sampled)
```

Also see this [write-up](https://samknows.com/blog/dns-over-https-performance) on UDP-based DNS versus DNS over HTTPS ("DoH") benchmarks.

**Speed could be increased** by switching to use [undici streams](https://undici.nodejs.org/#/?id=undicistreamurl-options-factory-promise) and [getStream.buffer](https://github.com/sindresorhus/get-stream) (pull request is welcome).

### HTTP Library Benchmarks

Originally we wrote this library using [got](https://github.com/sindresorhus/got) – however after running benchmarks and learning of [how performant](https://github.com/sindresorhus/got/issues/1419) undici is, we weren't happy – and we rewrote it with [undici](https://github.com/nodejs/undici).  Here are test results from the latest versions of all HTTP libraries against our real-world API (both client and server running locally):

> Node v18.14.2 on MacBook Air M1 16GB (using real-world API server):

```sh
> node --version
v18.14.2

> BENCHMARK_HOST="127.0.0.1" BENCHMARK_PORT="4000" BENCHMARK_PATH="/v1/test" node benchmarks/http
http.request POST request x 765 ops/sec ±9.83% (72 runs sampled)
http.request GET request x 1,000 ops/sec ±3.88% (85 runs sampled)
undici GET request x 2,740 ops/sec ±5.92% (78 runs sampled)
undici POST request x 1,247 ops/sec ±0.61% (88 runs sampled)
axios GET request x 792 ops/sec ±7.78% (76 runs sampled)
axios POST request x 717 ops/sec ±13.85% (69 runs sampled)
got GET request x 1,234 ops/sec ±21.10% (67 runs sampled)
got POST request x 113 ops/sec ±168.45% (37 runs sampled)
fetch GET request x 977 ops/sec ±38.12% (51 runs sampled)
fetch POST request x 708 ops/sec ±23.64% (65 runs sampled)
request GET request x 1,152 ops/sec ±40.48% (49 runs sampled)
request POST request x 947 ops/sec ±1.35% (86 runs sampled)
superagent GET request x 148 ops/sec ±139.32% (31 runs sampled)
superagent POST request x 571 ops/sec ±40.14% (54 runs sampled)
phin GET request x 252 ops/sec ±158.51% (50 runs sampled)
phin POST request x 714 ops/sec ±17.39% (62 runs sampled)
Fastest is undici GET request
```


## Contributors

| Name              | Website                    |
| ----------------- | -------------------------- |
| **Forward Email** | <https://forwardemail.net> |


## License

[MIT](LICENSE) © [Forward Email](https://forwardemail.net)


##

<a href="#"><img src="https://raw.githubusercontent.com/forwardemail/tangerine/main/media/footer.png" alt="#" /></a>
