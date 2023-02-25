const dns = require('node:dns');
const http = require('node:http');
const os = require('node:os');
const process = require('node:process');
const { Buffer } = require('node:buffer');
const { debuglog } = require('node:util');
const { getEventListeners, setMaxListeners } = require('node:events');
const { isIP, isIPv4, isIPv6 } = require('node:net');

const Keyv = require('keyv');
const getStream = require('get-stream');
const ipaddr = require('ipaddr.js');
const mergeOptions = require('merge-options');
const pMap = require('p-map');
const pWaitFor = require('p-wait-for');
const packet = require('dns-packet');
const semver = require('semver');
const { getService } = require('port-numbers');

const pkg = require('./package.json');

const debug = debuglog('tangerine');

// dynamically import dohdec
let dohdec;
// eslint-disable-next-line unicorn/prefer-top-level-await
import('dohdec').then((obj) => {
  dohdec = obj;
});

// <https://github.com/szmarczak/cacheable-lookup/pull/76>
class Tangerine extends dns.promises.Resolver {
  static isValidPort(port) {
    return Number.isSafeInteger(port) && port >= 0 && port <= 65535;
  }

  static getAddrConfigTypes() {
    const networkInterfaces = os.networkInterfaces();
    let hasIPv4 = false;
    let hasIPv6 = false;
    for (const key of Object.keys(networkInterfaces)) {
      for (const obj of networkInterfaces[key]) {
        if (!obj.internal) {
          if (obj.family === 'IPv4') {
            hasIPv4 = true;
          } else if (obj.family === 'IPv6') {
            hasIPv6 = true;
          }
        }
      }
    }

    if (hasIPv4 && hasIPv6) return 0;
    if (hasIPv4) return 4;
    if (hasIPv6) return 6;
    // NOTE: should this be an edge case where we return empty results (?)
    return 0;
  }

  // <https://github.com/mafintosh/dns-packet/blob/master/examples/doh.js>
  static getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  //
  // NOTE: we can most likely move to AggregateError instead
  //
  static combineErrors(errors) {
    let err;
    if (errors.length === 1) {
      err = errors[0];
    } else {
      err = new Error(
        [...new Set(errors.map((e) => e.message).filter(Boolean))].join('; ')
      );
      err.stack = [...new Set(errors.map((e) => e.stack).filter(Boolean))].join(
        '\n\n'
      );
      // if all errors had `code` and they were all the same then preserve it
      if (
        typeof errors[0].code !== 'undefined' &&
        errors.every((e) => e.code === errors[0].code)
      )
        err.code = errors[0].code;

      // if all errors had `errno` and they were all the same then preserve it
      if (
        typeof errors[0].errno !== 'undefined' &&
        errors.every((e) => e.errno === errors[0].errno)
      )
        err.errno = errors[0].errno;

      // preserve original errors
      err.errors = errors;
    }

    return err;
  }

  static CODES = new Set([
    dns.ADDRGETNETWORKPARAMS,
    dns.BADFAMILY,
    dns.BADFLAGS,
    dns.BADHINTS,
    dns.BADNAME,
    dns.BADQUERY,
    dns.BADRESP,
    dns.BADSTR,
    dns.CANCELLED,
    dns.CONNREFUSED,
    dns.DESTRUCTION,
    dns.EOF,
    dns.FILE,
    dns.FORMERR,
    dns.LOADIPHLPAPI,
    dns.NODATA,
    dns.NOMEM,
    dns.NONAME,
    dns.NOTFOUND,
    dns.NOTIMP,
    dns.NOTINITIALIZED,
    dns.REFUSED,
    dns.SERVFAIL,
    dns.TIMEOUT
  ]);

  static TYPES = new Set([
    'A',
    'AAAA',
    'CAA',
    'CNAME',
    'MX',
    'NAPTR',
    'NS',
    'PTR',
    'SOA',
    'SRV',
    'TXT'
  ]);

  static ANY_TYPES = [
    'A',
    'AAAA',
    'CNAME',
    'MX',
    'NAPTR',
    'NS',
    'PTR',
    'SOA',
    'SRV',
    'TXT'
  ];

  static NETWORK_ERROR_CODES = new Set([
    'ENETDOWN',
    'ENETRESET',
    'ECONNRESET',
    'EADDRINUSE',
    'ECONNREFUSED',
    'ENETUNREACH'
  ]);

  static RETRY_STATUS_CODES = new Set([
    408, 413, 429, 500, 502, 503, 504, 521, 522, 524
  ]);

  static RETRY_ERROR_CODES = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'EADDRINUSE',
    'ECONNREFUSED',
    'EPIPE',
    // NOTE: dns behavior does not retry on ENOTFOUND
    // <https://nodejs.org/api/dns.html#dnssetserversservers>
    // 'ENOTFOUND',
    'ENETUNREACH',
    'EAI_AGAIN'
  ]);

  // sourced from node, superagent, got, axios, and fetch
  // <https://github.com/nodejs/node/issues/14554>
  // <https://github.com/nodejs/node/issues/38361#issuecomment-1046151452>
  // <https://github.com/axios/axios/blob/bdf493cf8b84eb3e3440e72d5725ba0f138e0451/lib/cancel/CanceledError.js#L17>
  static ABORT_ERROR_CODES = new Set([
    'ABORT_ERR',
    'ECONNABORTED',
    'ERR_CANCELED',
    'ECANCELLED',
    'ERR_ABORTED',
    'UND_ERR_ABORTED'
  ]);

  static getSysCall(rrtype) {
    return `query${rrtype.slice(0, 1).toUpperCase()}${rrtype
      .slice(1)
      .toLowerCase()}`;
  }

  // <https://github.com/EduardoRuizM/native-dnssec-dns/blob/main/lib/client.js#L350>
  static createError(name, rrtype, code = dns.BADRESP, errno) {
    const syscall = this.getSysCall(rrtype);

    if (this.ABORT_ERROR_CODES.has(code)) code = dns.CANCELLED;
    else if (this.NETWORK_ERROR_CODES.has(code)) code = dns.CONNREFUSED;
    else if (this.RETRY_ERROR_CODES.has(code)) code = dns.TIMEOUT;
    else if (!this.CODES.has(code)) code = dns.BADRESP;

    const err = new Error(`${syscall} ${code} ${name}`);
    err.hostname = name;
    err.syscall = syscall;
    err.code = code;
    err.errno = errno || undefined;
    return err;
  }

  constructor(options = {}, request = require('undici').request) {
    const timeout =
      options.timeout && options.timeout !== -1 ? options.timeout : 5000;
    const tries = options.tries || 4;

    super({
      timeout,
      tries
    });

    if (typeof request !== 'function')
      throw new Error(
        'Request option must be a function (e.g. `undici.request` or `got`)'
      );

    this.request = request;

    this.options = mergeOptions(
      {
        // <https://github.com/nodejs/node/issues/33353#issuecomment-627259827>
        // > For posterity: there's a 75 second timeout.
        // > Local testing with a blackholed DNS server shows that c-ares internally
        // > retries four times (with 5, 10, 20 and 40 second timeouts)
        // > before giving up with an ARES_ETIMEDOUT error.
        timeout,
        tries,

        // dns servers will optionally retry in series
        // and servers that error will get shifted to the end of list
        servers: new Set(['1.1.1.1', '1.0.0.1']),
        requestOptions: {
          method: 'GET',
          headers: {
            'content-type': 'application/dns-message',
            'user-agent': `${pkg.name}/${pkg.version}`,
            accept: 'application/dns-message'
          }
        },
        requestTimeout: (ms) => ({ bodyTimeout: ms }),
        //
        // NOTE: we set the default to "get" since it is faster from `benchmark` results
        //
        // http protocol to be used
        protocol: 'https',
        //
        // NOTE: this value was changed from ipv4first to verbatim in v17.0.0
        //       and this feature was added in v14.8.0 and v16.4.0
        //       <https://nodejs.org/api/dns.html#dnspromisessetdefaultresultorderorder>
        dnsOrder: semver.gte(process.version, 'v17.0.0')
          ? 'verbatim'
          : 'ipv4first',
        // https://github.com/cabinjs/cabin
        // https://github.com/cabinjs/axe
        logger: false,
        // default id generator
        // (e.g. set to a synchronous or async function such as `() => Tangerine.getRandomInt(1, 65534)`)
        id: 0,
        // concurrency for `resolveAny` (defaults to # of CPU's)
        concurrency: os.cpus().length,
        // ipv4 and ipv6 default addresses (from dns defaults)
        ipv4: '0.0.0.0',
        ipv6: '::0',
        ipv4Port: undefined,
        ipv6Port: undefined,
        // cache mapping (e.g. txt -> keyv instance) - see below
        cache: new Map(),
        // whether to do 1:1 HTTP -> DNS error mapping
        returnHTTPErrors: false,
        // whether to smart rotate and bump-to-end servers that have issues
        smartRotate: true,
        // fallback if status code was not found in http.STATUS_CODES
        defaultHTTPErrorMessage: 'Unsuccessful HTTP response'
      },
      options
    );

    // timeout must be >= 0
    if (!Number.isFinite(this.options.timeout) || this.options.timeout < 0)
      throw new Error('Timeout must be >= 0');

    // tries must be >= 1
    if (!Number.isFinite(this.options.tries) || this.options.tries < 1)
      throw new Error('Tries must be >= 1');

    // request option method must be either GET or POST
    if (
      !['get', 'post'].includes(
        this.options.requestOptions.method.toLowerCase()
      )
    )
      throw new Error('Request options method must be either GET or POST');

    // perform validation by re-using `setServers` method
    this.setServers([...this.options.servers]);

    if (
      !(this.options.servers instanceof Set) ||
      this.options.servers.size === 0
    )
      throw new Error(
        'Servers must be an Array or Set with at least one server'
      );

    if (!['http', 'https'].includes(this.options.protocol))
      throw new Error('Protocol must be http or https');

    if (!['verbatim', 'ipv4first'].includes(this.options.dnsOrder))
      throw new Error('DNS order must be either verbatim or ipv4first');

    // if `cache: false` then caching is disabled
    // but note that this doesn't disable `got` dnsCache which is separate
    // so to turn that off, you need to supply `dnsCache: undefined` in `got` object (?)
    if (this.options.cache === true) this.options.cache = new Map();

    if (this.options.cache instanceof Map) {
      // each of the types have their own Keyv with prefix
      for (const type of this.constructor.TYPES) {
        if (!this.options.cache.get(type))
          this.options.cache.set(
            type,
            new Keyv({
              namespace: `dns:${type.toLowerCase()}`
            })
          );
      }
    }

    // convert `false` logger option into noop
    // <https://github.com/breejs/bree/issues/147>
    if (this.options.logger === false)
      this.options.logger = {
        /* istanbul ignore next */
        info() {},
        /* istanbul ignore next */
        warn() {},
        /* istanbul ignore next */
        error() {}
      };

    // manage set of abort controllers
    this.abortControllers = new Set();
  }

  setLocalAddress(ipv4, ipv6) {
    // ipv4 = default => '0.0.0.0'
    // ipv6 = default => '::0'
    if (ipv4) {
      if (typeof ipv4 !== 'string') {
        const err = new TypeError(
          'The "ipv4" argument must be of type string.'
        );
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }

      // if port specified then split it apart
      let port;

      if (ipv4.includes(':')) [ipv4, port] = ipv4.split(':');

      if (!isIPv4(ipv4)) {
        const err = new TypeError('Invalid IP address.');
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }

      // not sure if there's a built-in way with Node.js to do this (?)
      if (port) {
        port = Number(port);
        // <https://github.com/leecjson/node-is-valid-port/blob/2da250b23e0d83bcfc042b44fa7cabdea1984a73/index.js#L3-L7>
        if (!this.constructor.isValidPort(port)) {
          const err = new TypeError('Invalid port.');
          err.code = 'ERR_INVALID_ARG_TYPE';
          throw err;
        }
      }

      this.options.ipv4 = ipv4;
      this.options.ipv4Port = port;
    }

    if (ipv6) {
      if (typeof ipv6 !== 'string') {
        const err = new TypeError(
          'The "ipv6" argument must be of type string.'
        );
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }

      // if port specified then split it apart
      let port;

      // if it starts with `[` then we can assume it's encoded as `[IPv6]` or `[IPv6]:PORT`
      if (ipv6.startsWith('[')) {
        const lastIndex = ipv6.lastIndexOf(']');
        port = ipv6.slice(lastIndex + 2);
        ipv6 = ipv6.slice(1, lastIndex);
      }

      // not sure if there's a built-in way with Node.js to do this (?)
      if (port) {
        port = Number(port);
        // <https://github.com/leecjson/node-is-valid-port/blob/2da250b23e0d83bcfc042b44fa7cabdea1984a73/index.js#L3-L7>
        if (!(Number.isSafeInteger(port) && port >= 0 && port <= 65535)) {
          const err = new TypeError('Invalid port.');
          err.code = 'ERR_INVALID_ARG_TYPE';
          throw err;
        }
      }

      if (!isIPv6(ipv6)) {
        const err = new TypeError('Invalid IP address.');
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }

      this.options.ipv6 = ipv6;
      this.options.ipv6Port = port;
    }
  }

  // eslint-disable-next-line complexity
  async lookup(name, options = {}) {
    // validate name
    if (typeof name !== 'string') {
      const err = new TypeError('The "name" argument must be of type string.');
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }

    // if options is an integer, it must be 4 or 6
    if (typeof options === 'number') {
      if (options !== 4 && options !== 6) {
        const err = new TypeError(
          `The argument 'family' must be one of: 0, 4, 6. Received ${options}`
        );
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }

      options = { family: options };
    } else if (
      typeof options.family !== 'undefined' &&
      ![0, 4, 6, 'IPv4', 'IPv6'].includes(options.family)
    ) {
      // validate family
      const err = new TypeError(
        `The argument 'family' must be one of: 0, 4, 6. Received ${options.family}`
      );
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }

    if (options.family === 'IPv4') options.family = 4;
    else if (options.family === 'IPv6') options.family = 6;

    // validate hints
    // eslint-disable-next-line no-bitwise
    if ((options.hints & ~(dns.ADDRCONFIG | dns.ALL | dns.V4MAPPED)) !== 0) {
      const err = new TypeError(
        `The argument 'hints' is invalid. Received ${options.hints}`
      );
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }

    // resolve the first A or AAAA record
    let answers = [];

    try {
      answers = await Promise.any([
        this.resolve4(name),
        // the only downside here is that if one succeeds the other won't be aborted
        // (an alternative approach could be implemented, but would have to wrap around ENOTFOUND err
        this.resolve6(name)
      ]);
    } catch (_err) {
      debug(_err);

      // this will most likely be instanceof AggregateError
      if (_err instanceof AggregateError) {
        const err = this.constructor.combineErrors(_err.errors);
        err.hostname = name;
        // remap and perform syscall
        err.syscall = 'getaddrinfo';
        if (!err.code)
          err.code = _err.errors.find((e) => e.code)?.code || dns.BADRESP;
        if (!err.errno)
          err.errno = _err.errors.find((e) => e.errno)?.errno || undefined;

        throw err;
      }

      const err = this.constructor.createError(name, '', _err.code, _err.errno);
      // remap and perform syscall
      err.syscall = 'getaddrinfo';
      err.error = _err;
      throw err;
    }

    // respect options from dns module
    // <https://nodejs.org/api/dns.html#dnspromiseslookuphostname-options>
    // - [x]: `family` (4, 6, or 0, default is 0)
    // - [x] `hints` multiple flags may be passed by bitwise OR'ing values
    // - [x] `all` (iff true, then return all results, otherwise single result)
    // - [x] `verbatim` - if `true` then return as-is, otherwise use dns order

    //
    // <https://nodejs.org/api/dns.html#supported-getaddrinfo-flags>
    //
    // dns.ADDRCONFIG:
    //   Limits returned address types to the types of non-loopback addresses configured on the system.
    //   For example, IPv4 addresses are only returned if the current system has at least one IPv4 address configured.
    // dns.V4MAPPED:
    //   If the IPv6 family was specified, but no IPv6 addresses were found, then return IPv4 mapped IPv6 addresses.
    //   It is not supported on some operating systems (e.g. FreeBSD 10.1).
    // dns.ALL:
    //   If dns.V4MAPPED is specified, return resolved IPv6 addresses as well as IPv4 mapped IPv6 addresses.
    //
    const { hints } = options;
    if (hints) {
      switch (hints) {
        case dns.ADDRCONFIG: {
          options.family = this.constructor.getAddrConfigTypes();
          break;
        }

        case dns.V4MAPPED: {
          if (options.family === 6 && !answers.some((answer) => isIPv6(answer)))
            answers = answers.map((answer) =>
              ipaddr.parse(answer).toIPv4MappedAddress().toString()
            );
          break;
        }

        case dns.ALL: {
          options.all = true;
          break;
        }

        // eslint-disable-next-line no-bitwise
        case dns.ADDRCONFIG | dns.V4MAPPED: {
          options.family = this.constructor.getAddrConfigTypes();
          if (options.family === 6 && !answers.some((answer) => isIPv6(answer)))
            answers = answers.map((answer) =>
              ipaddr.parse(answer).toIPv4MappedAddress().toString()
            );
          break;
        }

        // eslint-disable-next-line no-bitwise
        case dns.V4MAPPED | dns.ALL: {
          if (options.family === 6 && !answers.some((answer) => isIPv6(answer)))
            answers = answers.map((answer) =>
              ipaddr.parse(answer).toIPv4MappedAddress().toString()
            );
          options.all = true;
          break;
        }

        // eslint-disable-next-line no-bitwise
        case dns.ADDRCONFIG | dns.V4MAPPED | dns.ALL: {
          options.family = this.constructor.getAddrConfigTypes();
          if (options.family === 6 && !answers.some((answer) => isIPv6(answer)))
            answers = answers.map((answer) =>
              ipaddr.parse(answer).toIPv4MappedAddress().toString()
            );
          options.all = true;

          break;
        }

        default: {
          break;
        }
      }
    }

    if (options.family === 4)
      answers = answers.filter((answer) => isIPv4(answer));
    else if (options.family === 6)
      answers = answers.filter((answer) => isIPv6(answer));

    // respect sort order from `setDefaultResultOrder` method
    if (options.verbatim !== true && this.options.dnsOrder === 'ipv4first')
      answers = answers.sort((answer) => (isIPv4(answer) ? 0 : 1));

    return options.all === true
      ? answers.map((answer) => ({
          address: answer,
          family: isIP(answer)
        }))
      : { address: answers[0], family: isIP(answers[0]) };
  }

  // <https://man7.org/linux/man-pages/man3/getnameinfo.3.html>
  async lookupService(address, port, abortController) {
    if (!address || !port) {
      const err = new TypeError(
        'The "address" and "port" arguments must be specified.'
      );
      err.code = 'ERR_MISSING_ARGS';
      throw err;
    }

    if (!isIP(address)) {
      const err = new TypeError(
        `The argument 'address' is invalid. Received '${address}'`
      );
      err.code = 'ERR_INVALID_ARG_VALUE';
      throw err;
    }

    if (!this.constructor.isValidPort(port)) {
      const err = new TypeError(
        `Port should be >= 0 and < 65536. Received ${port}.`
      );
      err.code = 'ERR_SOCKET_BAD_PORT';
      throw err;
    }

    const { name } = getService(port);

    // reverse lookup
    try {
      const [hostname] = await this.reverse(address, abortController);
      return { hostname, service: name };
    } catch (err) {
      err.syscall = 'getnameinfo';
      throw err;
    }
  }

  async reverse(ip, abortController) {
    // basically reverse the IP and then perform PTR lookup
    if (typeof ip !== 'string') {
      const err = new TypeError('The "ip" argument must be of type string.');
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }

    if (!isIP(ip)) {
      const err = this.constructor.createError(ip, '', dns.EINVAL);
      err.syscall = 'getHostByAddr';
      // err.errno = -22;
      if (!ip) delete err.hostname;
      throw err;
    }

    // reverse the IP address
    if (!dohdec) await pWaitFor(() => Boolean(dohdec));
    const name = dohdec.DNSoverHTTPS.reverse(ip);

    // perform resolvePTR
    try {
      const answers = await this.resolve(name, 'PTR', {}, abortController);
      return answers;
    } catch (err) {
      // remap syscall
      err.syscall = 'getHostByAddr';
      err.message = `${err.syscall} ${err.code} ${ip}`;
      err.hostname = ip;
      throw err;
    }
  }

  //
  // NOTE: we support an `options.ecsSubnet` property (e.g. in addition to `ttl`)
  //
  resolve4(name, options, abortController) {
    return this.resolve(name, 'A', options, abortController);
  }

  resolve6(name, options, abortController) {
    return this.resolve(name, 'AAAA', options, abortController);
  }

  resolveCaa(name, abortController) {
    return this.resolve(name, 'CAA', {}, abortController);
  }

  resolveCname(name, abortController) {
    return this.resolve(name, 'CNAME', {}, abortController);
  }

  resolveMx(name, abortController) {
    return this.resolve(name, 'MX', {}, abortController);
  }

  resolveNaptr(name, abortController) {
    return this.resolve(name, 'NAPTR', {}, abortController);
  }

  resolveNs(name, abortController) {
    return this.resolve(name, 'NS', {}, abortController);
  }

  resolvePtr(name, abortController) {
    return this.resolve(name, 'PTR', {}, abortController);
  }

  resolveSoa(name, abortController) {
    return this.resolve(name, 'SOA', {}, abortController);
  }

  resolveSrv(name, abortController) {
    return this.resolve(name, 'SRV', {}, abortController);
  }

  resolveTxt(name, abortController) {
    return this.resolve(name, 'TXT', {}, abortController);
  }

  // 1:1 mapping with node's official dns.promises API
  // (this means it's a drop-in replacement for `dns`)
  // <https://github.com/nodejs/node/blob/9bbde3d7baef584f14569ef79f116e9d288c7aaa/lib/internal/dns/utils.js#L87-L95>
  getServers() {
    return [...this.options.servers];
  }

  //
  // NOTE: we attempted to set up streams with `got` however the retry usage
  //       was too confusing and the documentation was lacking, misleading, or incredibly complex
  //       <https://github.com/sindresorhus/got/issues/2226>
  //
  async #request(pkt, server, abortController, timeout = this.options.timeout) {
    // safeguard in case aborted
    if (abortController.signal.aborted) return;

    let localAddress;
    let localPort;
    let url = `${this.options.protocol}://${server}/dns-query`;
    if (isIPv4(new URL(url).hostname)) {
      localAddress = this.options.ipv4;
      if (this.options.ipv4LocalPort) localPort = this.options.ipv4LocalPort;
    } else {
      localAddress = this.options.ipv6;
      if (this.options.ipv6LocalPort) localPort = this.options.ipv6LocalPort;
    }

    const options = {
      ...this.options.requestOptions,
      ...this.options.requestTimeout(timeout), // returns `{ bodyTimeout: requestTimeout }`
      signal: abortController.signal
    };

    if (localAddress !== '0.0.0.0') options.localAddress = localAddress;
    if (localPort) options.localPort = localPort;

    // <https://github.com/hildjj/dohdec/blob/43564118c40f2127af871bdb4d40f615409d4b9c/pkg/dohdec/lib/doh.js#L117-L120>
    if (this.options.requestOptions.method.toLowerCase() === 'get') {
      if (!dohdec) await pWaitFor(() => Boolean(dohdec));
      url += `?dns=${dohdec.DNSoverHTTPS.base64urlEncode(pkt)}`;
    } else {
      options.body = pkt;
    }

    debug('request', { url, options });
    const response = await this.request(url, options);
    return response;
  }

  // <https://github.com/hildjj/dohdec/tree/main/pkg/dohdec>
  // eslint-disable-next-line complexity
  async #query(name, rrtype = 'A', ecsSubnet, abortController) {
    if (!dohdec) await pWaitFor(() => Boolean(dohdec));
    debug('query', { name, rrtype, ecsSubnet, abortController });
    // <https://github.com/hildjj/dohdec/blob/43564118c40f2127af871bdb4d40f615409d4b9c/pkg/dohdec/lib/dnsUtils.js#L161>
    const pkt = dohdec.DNSoverHTTPS.makePacket({
      id:
        typeof this.options.id === 'function'
          ? await this.options.id()
          : this.options.id,
      rrtype,
      name,
      // <https://github.com/mafintosh/dns-packet/pull/47#issuecomment-1435818437>
      ecsSubnet
    });
    try {
      // mirror the behavior as noted in built-in DNS
      // <https://github.com/nodejs/node/issues/33353#issuecomment-627259827>
      let buffer;
      const errors = [];
      // NOTE: we would have used `p-map-series` but it did not support abort/break
      const servers = [...this.options.servers];
      for (const server of servers) {
        const ipErrors = [];
        for (let i = 0; i < this.options.tries; i++) {
          try {
            // <https://github.com/sindresorhus/p-map-series/blob/bc1b9f5e19ed62363bff3d7dc5ecc1fd820ccb51/index.js#L1-L11>
            // eslint-disable-next-line no-await-in-loop
            const response = await this.#request(
              pkt,
              server,
              abortController,
              this.options.timeout * 2 ** i
            );

            // if aborted signal then returns early
            // eslint-disable-next-line max-depth
            if (response) {
              const { statusCode, body, headers } = response;
              debug('response', { statusCode, headers });

              // eslint-disable-next-line max-depth
              if (body && statusCode >= 200 && statusCode < 300) {
                buffer = Buffer.isBuffer(body)
                  ? body
                  : // eslint-disable-next-line no-await-in-loop
                    await getStream.buffer(body);
                // eslint-disable-next-line max-depth
                if (!abortController.signal.aborted) abortController.abort();
                break;
              }

              const message =
                http.STATUS_CODES[statusCode] ||
                this.options.defaultHTTPErrorMessage;
              const err = new Error(message);
              err.statusCode = statusCode;
              throw err;
            }
          } catch (err) {
            debug(err);

            //
            // NOTE: if NOTFOUND error occurs then don't attempt further requests
            // <https://nodejs.org/api/dns.html#dnssetserversservers>
            //
            // eslint-disable-next-line max-depth
            if (err.code === dns.NOTFOUND) throw err;

            ipErrors.push(err);

            // break out of the loop if status code was not retryable
            // eslint-disable-next-line max-depth
            if (
              !(
                err.statusCode &&
                this.constructor.RETRY_STATUS_CODES.has(err.statusCode)
              ) &&
              !(err.code && this.constructor.RETRY_ERROR_CODES.has(err.code))
            )
              break;
          }
        }

        // break out if we had a response
        if (buffer) break;
        if (ipErrors.length > 0) {
          // if the `server` had all errors, then remove it and add to end
          // (this ensures we don't keep retrying servers that keep timing out)
          // (which improves upon default c-ares behavior)
          if (this.options.servers.size > 1 && this.options.smartRotate) {
            const err = this.constructor.combineErrors([
              new Error('Rotating DNS servers due to issues'),
              ...ipErrors
            ]);
            this.options.logger.error(err, { server });
            this.options.servers.delete(server);
            this.options.servers.add(server);
          }

          errors.push(...ipErrors);
        }
      }

      if (!buffer) {
        if (errors.length > 0) throw this.constructor.combineErrors(errors);
        // if no errors and no response
        // that must indicate that it was aborted
        throw this.constructor.createError(name, rrtype, dns.CANCELLED);
      }

      // without logging an error here, one might not know
      // that one or more dns servers have persistent issues
      if (errors.length > 0)
        this.options.logger.error(this.constructor.combineErrors(errors));
      return packet.decode(buffer);
    } catch (_err) {
      if (!abortController.signal.aborted) abortController.abort();
      debug(_err, { name, rrtype, ecsSubnet });
      if (this.options.returnHTTPErrors) throw _err;
      const err = this.constructor.createError(
        name,
        rrtype,
        _err.code,
        _err.errno
      );
      // then map it to dns.CONNREFUSED
      // preserve original error and stack trace
      err.error = _err;
      // throwing here saves indentation below
      throw err;
    }
  }

  // Cancel all outstanding DNS queries made by this resolver
  // NOTE: callbacks not currently called with ECANCELLED (prob need to alter got options)
  //       (instead they are called with "ABORT_ERR"; see ABORT_ERROR_CODES)
  cancel() {
    for (const abortController of this.abortControllers) {
      if (!abortController.signal.aborted) abortController.abort();
    }
  }

  #resolveByType(name, parentAbortController) {
    return async (type) => {
      const abortController = new AbortController();
      this.abortControllers.add(abortController);
      abortController.signal.addEventListener(
        'abort',
        () => {
          this.abortControllers.delete(abortController);
        },
        { once: true }
      );
      parentAbortController.signal.addEventListener(
        'abort',
        () => {
          abortController.abort();
        },
        { once: true }
      );
      // wrap with try/catch because ENODATA shouldn't cause errors
      try {
        switch (type) {
          case 'A': {
            const result = await this.resolve4(
              name,
              { ttl: true },
              abortController
            );
            return result.map((r) => ({ type, ...r }));
          }

          case 'AAAA': {
            const result = await this.resolve6(
              name,
              { ttl: true },
              abortController
            );
            return result.map((r) => ({ type, ...r }));
          }

          case 'CNAME': {
            const result = await this.resolveCname(name, abortController);
            return result.map((value) => ({ type, value }));
          }

          case 'MX': {
            const result = await this.resolveMx(name, abortController);
            return result.map((r) => ({ type, ...r }));
          }

          case 'NAPTR': {
            const result = await this.resolveNaptr(name, abortController);
            return result.map((value) => ({ type, value }));
          }

          case 'NS': {
            const result = await this.resolveNs(name, abortController);
            return result.map((value) => ({ type, value }));
          }

          case 'PTR': {
            const result = await this.resolvePtr(name, abortController);
            return result.map((value) => ({ type, value }));
          }

          case 'SOA': {
            const result = await this.resolveSoa(name, abortController);
            return { type, ...result };
          }

          case 'SRV': {
            const result = await this.resolveSrv(name, abortController);
            return result.map((value) => ({ type, value }));
          }

          case 'TXT': {
            const result = await this.resolveTxt(name, abortController);
            return result.map((entries) => ({ type, entries }));
          }

          default: {
            break;
          }
        }
      } catch (err) {
        debug(err);

        if (err.code === dns.NODATA) return;
        throw err;
      }
    };
  }

  // <https://nodejs.org/api/dns.html#dnspromisesresolveanyhostname>
  async resolveAny(name, abortController) {
    if (typeof name !== 'string') {
      const err = new TypeError('The "name" argument must be of type string.');
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }

    // <https://gist.github.com/andrewcourtice/ef1b8f14935b409cfe94901558ba5594#file-task-ts-L37>
    // <https://github.com/nodejs/undici/blob/0badd390ad5aa531a66aacee54da664468aa1577/lib/api/api-fetch/request.js#L280-L295>
    // <https://github.com/nodejs/node/issues/40849>
    if (!abortController) {
      abortController = new AbortController();
      this.abortControllers.add(abortController);
      abortController.signal.addEventListener(
        'abort',
        () => {
          this.abortControllers.delete(abortController);
        },
        { once: true }
      );

      // <https://github.com/nodejs/undici/pull/1910/commits/7615308a92d3c8c90081fb99c55ab8bd59212396>
      setMaxListeners(
        getEventListeners(abortController.signal, 'abort').length +
          this.constructor.ANY_TYPES.length,
        abortController.signal
      );
    }

    const results = await pMap(
      this.constructor.ANY_TYPES,
      this.#resolveByType(name, abortController),
      // <https://developers.cloudflare.com/fundamentals/api/reference/limits/>
      { concurrency: this.options.concurrency, signal: abortController.signal }
    );
    return results.flat().filter(Boolean);
  }

  setDefaultResultOrder(dnsOrder) {
    if (dnsOrder !== 'ipv4first' && dnsOrder !== 'verbatim') {
      const err = new TypeError(
        "The argument 'dnsOrder' must be one of: 'verbatim', 'ipv4first'."
      );
      err.code = 'ERR_INVALID_ARG_VALUE';
      throw err;
    }

    this.options.dnsOrder = dnsOrder;
  }

  setServers(servers) {
    if (!Array.isArray(servers) || servers.length === 0) {
      const err = new TypeError(
        'The "name" argument must be an instance of Array.'
      );
      err.code = 'ERR_INVALID_ARG_TYPE';
    }

    //
    // TODO: every address must be ipv4 or ipv6 (use `new URL` to parse and check)
    // servers [ string ] - array of RFC 5952 formatted addresses
    //

    // <https://github.com/nodejs/node/blob/9bbde3d7baef584f14569ef79f116e9d288c7aaa/lib/internal/dns/utils.js#L87-L95>
    this.options.servers = new Set(servers);
  }

  // eslint-disable-next-line complexity
  async resolve(name, rrtype = 'A', options = {}, abortController) {
    if (typeof name !== 'string') {
      const err = new TypeError('The "name" argument must be of type string.');
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }

    if (typeof rrtype !== 'string') {
      const err = new TypeError(
        'The "rrtype" argument must be of type string.'
      );
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }

    if (!this.constructor.TYPES.has(rrtype)) {
      const err = new TypeError("The argument 'rrtype' is invalid.");
      err.code = 'ERR_INVALID_ARG_VALUE';
      throw err;
    }

    // ecsSubnet support
    let ecsSubnet;
    if (options.ecsSubnet) {
      ecsSubnet = options.ecsSubnet;
      delete options.ecsSubnet;
    }

    let cache;
    if (this.options.cache instanceof Map)
      cache = this.options.cache.get(rrtype);

    const key = ecsSubnet ? `${ecsSubnet}:${name}` : name;

    let result;
    let data;
    if (cache) {
      //
      // <https://github.com/jaredwray/keyv/issues/106>
      //
      // NOTE: we store `result.lowest_answer_ttl` which was the lowest TTL determined
      //       (this saves us from duplicating the same `...sort().filter(Number.isFinite)` logic)
      //
      data = await cache.get(key, { raw: true });
      if (data?.value) {
        result = data.value;
        const now = Date.now();
        if (
          // safeguard in case catch gets polluted
          Number.isFinite(result.lowest_answer_ttl) &&
          result.lowest_answer_ttl > 0 &&
          data.expires &&
          now <= data.expires
        ) {
          // returns ms -> s conversion
          const ttl = Math.round((data.expires - now) / 1000);
          const diff = result.lowest_answer_ttl - ttl;

          for (let i = 0; i < result.answers.length; i++) {
            // eslint-disable-next-line max-depth
            if (typeof result.answers[i].ttl === 'number') {
              // subtract ttl from answer
              result.answers[i].ttl = Math.round(result.answers[i].ttl - diff);

              // eslint-disable-next-line max-depth
              if (result.answers[i].ttl <= 0) {
                result = undefined;
                data = undefined;
                break;
              }
            }
          }
        }
      }
    }

    //
    // <https://nodejs.org/api/dns.html#dnspromisesresolvehostname-rrtype>
    //
    // // <https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/#return-codes>
    // HTTP Status	Meaning
    // 400	        DNS query not specified or too small.
    // 413	        DNS query is larger than maximum allowed DNS message size.
    // 415	        Unsupported content type.
    // 504	        Resolver timeout while waiting for the query response.
    //
    // <https://developers.google.com/speed/public-dns/docs/doh#errors>
    // 400 Bad Request
    // - Problems parsing the GET parameters, or an invalid DNS request message. For bad GET parameters, the HTTP body should explain the error. Most invalid DNS messages get a 200 OK with a FORMERR; the HTTP error is returned for garbled messages with no Question section, a QR flag indicating a reply, or other nonsensical flag combinations with binary DNS parse errors.
    // 413 Payload Too Large
    // - An RFC 8484 POST request body exceeded the 512 byte maximum message size.
    // 414 URI Too Long
    // - The GET query header was too large or the dns parameter had a Base64Url encoded DNS message exceeding the 512 byte maximum message size.
    // 415 Unsupported Media Type
    // - The POST body did not have an application/dns-message Content-Type header.
    // 429 Too Many Requests
    // - The client has sent too many requests in a given amount of time. Clients should stop sending requests until the time specified in the Retry-After header (a relative time in seconds).
    // 500 Internal Server Error
    // - Google Public DNS internal DoH errors.
    // 501 Not Implemented
    // - Only GET and POST methods are implemented, other methods get this error.
    // 502 Bad Gateway
    // - The DoH service could not contact Google Public DNS resolvers.
    // - In the case of a 502 response, although retrying on an alternate Google Public DNS address might help, a more effective fallback response would be to try another DoH service, or to switch to traditional UDP or TCP DNS at 8.8.8.8.
    //
    if (cache && result) {
      debug(`cached result found for "${cache.opts.namespace}:${key}"`);
    } else {
      if (!abortController) {
        abortController = new AbortController();
        this.abortControllers.add(abortController);
        abortController.signal.addEventListener(
          'abort',
          () => {
            this.abortControllers.delete(abortController);
          },
          { once: true }
        );
      }

      // setImmediate(() => this.cancel());
      result = await this.#query(name, rrtype, ecsSubnet, abortController);
    }

    // <https://github.com/m13253/dns-over-https/blob/2e36b4ebcdb8a1a102ea86370d7f8b1f1e72380a/json-dns/response.go#L50-L74>
    // result = {
    //  Status (integer): Standard DNS response code (32 bit integer)
    //  TC (boolean): Whether the response is truncated
    //  RD (boolean): Recursion desired
    //  RA (boolean): Recursion available
    //  AD (boolean): Whether all response data was validated with DNSSEC
    //  CD (boolean) Whether the client asked to disable DNSSEC
    //  ...
    // }

    // Based off "Status" returned, we need to map it to proper DNS response code
    // <http://www.iana.org/assignments/dns-parameters/dns-parameters.xhtml#dns-parameters-6>
    // <https://nodejs.org/api/dns.html#error-codes>
    // <https://github.com/c-ares/c-ares/blob/7712fcd17847998cf1ee3071284ec50c5b3c1978/include/ares_nameser.h#L158-L176>
    // <https://github.com/nodejs/node/blob/9bbde3d7baef584f14569ef79f116e9d288c7aaa/deps/cares/src/lib/ares_query.c#L155-L176>
    // <https://github.com/nodejs/node/blob/9bbde3d7baef584f14569ef79f116e9d288c7aaa/deps/cares/include/ares.h#L107-L146>
    //
    // <https://github.com/mafintosh/dns-packet/blob/c11116822afcdaab05ccd9f76549e9089bb44f47/rcodes.js#L3-L28>
    //
    switch (result.rcode) {
      case 'NOERROR': {
        //
        // NOTE: if the answer was truncated then unset results (?)
        // <https://github.com/EduardoRuizM/native-dnssec-dns/blob/fc27face6c64ab53675840bafc81f70bab48a743/lib/client.js#L354>
        // <https://github.com/hildjj/dohdec/issues/40>
        // if (result.flag_tc) throw createError(name, rrtype, dns.BADRESP);
        if (result.flag_tc) {
          this.options.logger.error(new Error('Truncated DNS response'), {
            name,
            rrtype,
            result
          });
        } else if (cache && !data?.value) {
          // store in cache based off lowest ttl
          const ttl = result.answers
            .map((answer) => answer.ttl)
            .sort()
            .find((ttl) => Number.isFinite(ttl));
          result.lowest_answer_ttl = ttl;
          await (result.lowest_answer_ttl && result.lowest_answer_ttl > 0
            ? cache.set(
                key,
                result,
                Math.round(result.lowest_answer_ttl * 1000)
              )
            : cache.set(key, result));
        }

        break;
      }

      case 'FORMERR': {
        throw this.constructor.createError(name, rrtype, dns.FORMERR);
      }

      case 'SERVFAIL': {
        throw this.constructor.createError(name, rrtype, dns.SERVFAIL);
      }

      case 'NXDOMAIN': {
        throw this.constructor.createError(name, rrtype, dns.NOTFOUND);
      }

      case 'NOTIMP': {
        throw this.constructor.createError(name, rrtype, dns.NOTIMP);
      }

      case 'REFUSED': {
        throw this.constructor.createError(name, rrtype, dns.REFUSED);
      }

      default: {
        throw this.constructor.createError(name, rrtype, dns.BADRESP);
      }
    }

    // if no results then throw ENODATA
    if (result.answers.length === 0)
      throw this.constructor.createError(name, rrtype, dns.NODATA);

    // filter the answers for the same type
    result.answers = result.answers.filter((answer) => answer.type === rrtype);

    //
    // NOTE: the dns package does not throw an error if there are no filtered answers
    //

    switch (rrtype) {
      case 'A': {
        // IPv4 addresses `dnsPromises.resolve4()`
        // if options.ttl === true then return [ { address, ttl } ] vs [ address ]
        if (options?.ttl)
          return result.answers.map((a) => ({
            ttl: a.ttl,
            address: a.data
          }));
        return result.answers.map((a) => a.data);
      }

      case 'AAAA': {
        // IPv6 addresses `dnsPromises.resolve6()`
        // if options.ttl === true then return [ { address, ttl } ] vs [ address ]
        if (options?.ttl)
          return result.answers.map((a) => ({
            ttl: a.ttl,
            address: a.data
          }));
        return result.answers.map((a) => a.data);
      }

      case 'CAA': {
        // CA authorization records	`dnsPromises.resolveCaa()`
        // <https://www.rfc-editor.org/rfc/rfc6844#section-3>
        return result.answers.map((a) => ({
          critical: a.data.flags,
          [a.data.tag]: a.data.value
        }));
      }

      case 'CNAME': {
        // canonical name records	`dnsPromises.resolveCname()`
        return result.answers.map((a) => a.data);
      }

      case 'MX': {
        // mail exchange records	`dnsPromises.resolveMx()`
        return result.answers.map((a) => ({
          exchange: a.data.exchange,
          priority: a.data.preference
        }));
      }

      case 'NAPTR': {
        // name authority pointer records `dnsPromises.resolveNaptr()`
        return result.answers.map((a) => a.data);
      }

      case 'NS': {
        // name server records	`dnsPromises.resolveNs()`
        return result.answers.map((a) => a.data);
      }

      case 'PTR': {
        // pointer records	`dnsPromises.resolvePtr()`
        return result.answers.map((a) => a.data);
      }

      case 'SOA': {
        // start of authority records `dnsPromises.resolveSoa()`
        const answers = result.answers.map((a) => ({
          nsname: a.data.mname,
          hostmaster: a.data.rname,
          serial: a.data.serial,
          refresh: a.data.refresh,
          retry: a.data.retry,
          expire: a.data.expire,
          minttl: a.data.minimum
        }));
        //
        // NOTE: probably should just return answers[0] for consistency (?)
        //
        return answers.length === 1 ? answers[0] : answers;
      }

      case 'SRV': {
        // service records	`dnsPromises.resolveSrv()`
        return result.answers.map((a) => ({
          name: a.data.target,
          port: a.data.port,
          priority: a.data.priority,
          weight: a.data.weight
        }));
      }

      case 'TXT': {
        // text records `dnsPromises.resolveTxt()`
        return result.answers.flatMap((a) => [
          Buffer.isBuffer(a.data)
            ? a.data.toString()
            : Array.isArray(a.data)
            ? a.data.map((d) => (Buffer.isBuffer(d) ? d.toString() : d))
            : a.data
        ]);
      }

      default: {
        throw new Error(`Unknown type of ${rrtype}`);
      }
    }
  }
}

module.exports = Tangerine;
