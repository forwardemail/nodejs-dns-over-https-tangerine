import dns from 'node:dns';
import http from 'node:http';
import os from 'node:os';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { debuglog } from 'node:util';
import { getEventListeners, setMaxListeners } from 'node:events';
import { isIP, isIPv4, isIPv6 } from 'node:net';
import { toASCII } from 'punycode/punycode.es6.js';
import autoBind from 'auto-bind';
import getStream from 'get-stream';
import hostile from 'hostile';
import ipaddr from 'ipaddr.js';
import { isStream } from 'is-stream';
import mergeOptions from 'merge-options';
import pMap from 'p-map';
import pWaitFor from 'p-wait-for';
import packet from 'dns-packet';
import semver from 'semver';
import { request as undiciRequest } from 'undici';
import * as dohdec from 'dohdec';
import isPrivateIP from 'private-ip';
import portNumbers from 'port-numbers' with { type: 'json' };
import pkg from './package.json' with { type: 'json' };

// Service name mapping to match Node.js built-in behavior
const serviceNameMap = {
  'www-http': 'http',
  smtp: 'smtp',
  domain: 'domain'
  // Add more mappings as needed
};

// Create a getService function compatible with the old API
const getService = (port, protocol = 'tcp') => {
  const key = `${port}/${protocol}`;
  const serviceInfo = portNumbers[key];
  if (serviceInfo) {
    let name = serviceInfo[0];
    // Apply mapping to match Node.js behavior
    name = serviceNameMap[name] || name;
    return { name };
  }

  // Try UDP if TCP not found and no protocol specified
  if (protocol === 'tcp') {
    const udpKey = `${port}/udp`;
    const udpInfo = portNumbers[udpKey];
    if (udpInfo) {
      let name = udpInfo[0];
      name = serviceNameMap[name] || name;
      return { name };
    }
  }

  return { name: '' };
};

const debug = debuglog('tangerine');

const HOSTFILE = hostile
  .get(true)
  .map((s) => (Array.isArray(s) ? s.join(' ') : s))
  .join('\n');

const HOSTS = [];
const hosts = hostile.get();
for (const line of hosts) {
  const [ip, string_] = line;
  const hosts = string_.split(' ');
  HOSTS.push({ ip, hosts });
}

// <https://github.com/szmarczak/cacheable-lookup/pull/76>
class Tangerine extends dns.promises.Resolver {
  static HOSTFILE = HOSTFILE;
  static HOSTS = HOSTS;

  static isValidPort(port) {
    return Number.isSafeInteger(port) && port >= 0 && port <= 65_535;
  }

  static CTYPE_BY_VALUE = {
    1: 'PKIX',
    2: 'SPKI',
    3: 'PGP',
    4: 'IPKIX',
    5: 'ISPKI',
    6: 'IPGP',
    7: 'ACPKIX',
    8: 'IACPKIX',
    253: 'URI',
    254: 'OID'
  };

  static getAddrConfigTypes() {
    const networkInterfaces = os.networkInterfaces();
    let hasIPv4 = false;
    let hasIPv6 = false;
    for (const key of Object.keys(networkInterfaces)) {
      for (const object of networkInterfaces[key]) {
        if (!object.internal) {
          if (object.family === 'IPv4') {
            hasIPv4 = true;
          } else if (object.family === 'IPv6') {
            hasIPv6 = true;
          }
        }
      }
    }

    if (hasIPv4 && hasIPv6) {
      return 0;
    }

    if (hasIPv4) {
      return 4;
    }

    if (hasIPv6) {
      return 6;
    }

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
    let error;
    if (errors.length === 1) {
      error = errors[0];
    } else {
      error = new Error(
        [
          ...new Set(errors.map((error_) => error_.message).filter(Boolean))
        ].join('; ')
      );
      error.stack = [
        ...new Set(errors.map((error_) => error_.stack).filter(Boolean))
      ].join('\n\n');

      // If all errors had `name` and they were all the same then preserve it
      if (
        errors[0].name !== undefined &&
        errors.every((error_) => error_.name === errors[0].name)
      ) {
        error.name = errors[0].name;
      }

      // If all errors had `code` and they were all the same then preserve it
      if (
        errors[0].code !== undefined &&
        errors.every((error_) => error_.code === errors[0].code)
      ) {
        error.code = errors[0].code;
      }

      // If all errors had `errno` and they were all the same then preserve it
      if (
        errors[0].errno !== undefined &&
        errors.every((error_) => error_.errno === errors[0].errno)
      ) {
        error.errno = errors[0].errno;
      }

      // Preserve original errors
      error.errors = errors;
    }

    return error;
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
    dns.TIMEOUT,
    'EINVAL'
  ]);
  static DNS_TYPES = new Set([
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
  // <https://www.iana.org/assignments/dns-parameters/dns-parameters.xhtml#dns-parameters-4>
  static TYPES = new Set([
    'A',
    'A6',
    'AAAA',
    'AFSDB',
    'AMTRELAY',
    'APL',
    'ATMA',
    'AVC',
    'AXFR',
    'CAA',
    'CDNSKEY',
    'CDS',
    'CERT',
    'CNAME',
    'CSYNC',
    'DHCID',
    'DLV',
    'DNAME',
    'DNSKEY',
    'DOA',
    'DS',
    'EID',
    'EUI48',
    'EUI64',
    'GID',
    'GPOS',
    'HINFO',
    'HIP',
    'HTTPS',
    'IPSECKEY',
    'ISDN',
    'IXFR',
    'KEY',
    'KX',
    'L32',
    'L64',
    'LOC',
    'LP',
    'MAILA',
    'MAILB',
    'MB',
    'MD',
    'MF',
    'MG',
    'MINFO',
    'MR',
    'MX',
    'NAPTR',
    'NID',
    'NIMLOC',
    'NINFO',
    'NS',
    'NSAP',
    'NSAP-PTR',
    'NSEC',
    'NSEC3',
    'NSEC3PARAM',
    'NULL',
    'NXT',
    'OPENPGPKEY',
    'OPT',
    'PTR',
    'PX',
    'RKEY',
    'RP',
    'RRSIG',
    'RT',
    'Reserved',
    'SIG',
    'SINK',
    'SMIMEA',
    'SOA',
    'SPF',
    'SRV',
    'SSHFP',
    'SVCB',
    'TA',
    'TALINK',
    'TKEY',
    'TLSA',
    'TSIG',
    'TXT',
    'UID',
    'UINFO',
    'UNSPEC',
    'URI',
    'WKS',
    'X25',
    'ZONEMD'
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
    'ETIMEOUT',
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
  // Sourced from node, superagent, got, axios, and fetch
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

    if (this.ABORT_ERROR_CODES.has(code)) {
      code = dns.CANCELLED;
    } else if (this.NETWORK_ERROR_CODES.has(code)) {
      code = dns.CONNREFUSED;
    } else if (this.RETRY_ERROR_CODES.has(code)) {
      code = dns.TIMEOUT;
    } else if (!this.CODES.has(code)) {
      code = dns.BADRESP;
    }

    const error = new Error(`${syscall} ${code} ${name}`);
    error.hostname = name;
    error.syscall = syscall;
    error.code = code;
    error.errno = errno || undefined;
    return error;
  }

  constructor(options = {}, request = undiciRequest) {
    const timeout =
      options.timeout && options.timeout !== -1 ? options.timeout : 5000;
    const tries = options.tries || 4;

    super({
      timeout,
      tries
    });

    if (typeof request !== 'function') {
      throw new TypeError(
        'Request option must be a function (e.g. `undici.request` or `got`)'
      );
    }

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

        // Dns servers will optionally retry in series
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
        // Default id generator
        // (e.g. set to a synchronous or async function such as `() => Tangerine.getRandomInt(1, 65534)`)
        id: 0,
        // Concurrency for `resolveAny` (defaults to # of CPU's)
        concurrency: os.cpus().length,
        // Ipv4 and ipv6 default addresses (from dns defaults)
        ipv4: '0.0.0.0',
        ipv6: '::0',
        ipv4Port: undefined,
        ipv6Port: undefined,
        // Cache mapping (e.g. txt -> Map/keyv/redis instance) - see below
        cache: new Map(),
        // <https://developers.cloudflare.com/dns/manage-dns-records/reference/ttl/>
        defaultTTLSeconds: 300,
        maxTTLSeconds: 86_400,
        // Default is to support ioredis
        // setCacheArgs(key, result) {
        setCacheArgs() {
          // Also you have access to `result.expires` which is is ms since epoch
          // (can be converted to Date via `new Date(result.expires)`)
          // return ['PX', Math.round(result.ttl * 1000)];
          return [];
        },
        // Whether to do 1:1 HTTP -> DNS error mapping
        returnHTTPErrors: false,
        // Whether to smart rotate and bump-to-end servers that have issues
        smartRotate: true,
        // Fallback if status code was not found in http.STATUS_CODES
        defaultHTTPErrorMessage: 'Unsuccessful HTTP response'
      },
      options
    );

    // Timeout must be >= 0
    if (!Number.isFinite(this.options.timeout) || this.options.timeout < 0) {
      throw new Error('Timeout must be >= 0');
    }

    // Tries must be >= 1
    if (!Number.isFinite(this.options.tries) || this.options.tries < 1) {
      throw new Error('Tries must be >= 1');
    }

    // Request option method must be either GET or POST
    if (
      !['get', 'post'].includes(
        this.options.requestOptions.method.toLowerCase()
      )
    ) {
      throw new Error('Request options method must be either GET or POST');
    }

    // Perform validation by re-using `setServers` method
    this.setServers([...this.options.servers]);

    if (
      !(this.options.servers instanceof Set) ||
      this.options.servers.size === 0
    ) {
      throw new Error(
        'Servers must be an Array or Set with at least one server'
      );
    }

    if (!['http', 'https'].includes(this.options.protocol)) {
      throw new Error('Protocol must be http or https');
    }

    if (!['verbatim', 'ipv4first'].includes(this.options.dnsOrder)) {
      throw new Error('DNS order must be either verbatim or ipv4first');
    }

    // If `cache: false` then caching is disabled
    // but note that this doesn't disable `got` dnsCache which is separate
    // so to turn that off, you need to supply `dnsCache: undefined` in `got` object (?)
    if (this.options.cache === true) {
      this.options.cache = new Map();
    }

    // Convert `false` logger option into noop
    // <https://github.com/breejs/bree/issues/147>
    if (this.options.logger === false) {
      this.options.logger = {
        /* istanbul ignore next */
        info() {},
        /* istanbul ignore next */
        warn() {},
        /* istanbul ignore next */
        error() {}
      };
    }

    // Manage set of abort controllers
    this.abortControllers = new Set();

    //
    // NOTE: bind methods so we don't have to programmatically call `.bind`
    // (e.g. `getDmarcRecord(name, resolver.resolve.bind(resolver))`)
    // (alternative to `autoBind(this)` is `this[method] = this[method].bind(this)`)
    //
    autoBind(this);
  }

  setLocalAddress(ipv4, ipv6) {
    // Ipv4 = default => '0.0.0.0'
    // ipv6 = default => '::0'
    if (ipv4) {
      if (typeof ipv4 !== 'string') {
        const error = new TypeError(
          'The "ipv4" argument must be of type string.'
        );
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }

      // If port specified then split it apart
      let port;

      if (ipv4.includes(':')) {
        [ipv4, port] = ipv4.split(':');
      }

      if (!isIPv4(ipv4)) {
        const error = new TypeError('Invalid IP address.');
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }

      // Not sure if there's a built-in way with Node.js to do this (?)
      if (port) {
        port = Number(port);
        // <https://github.com/leecjson/node-is-valid-port/blob/2da250b23e0d83bcfc042b44fa7cabdea1984a73/index.js#L3-L7>
        if (!this.constructor.isValidPort(port)) {
          const error = new TypeError('Invalid port.');
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
      }

      this.options.ipv4 = ipv4;
      this.options.ipv4Port = port;
    }

    if (ipv6) {
      if (typeof ipv6 !== 'string') {
        const error = new TypeError(
          'The "ipv6" argument must be of type string.'
        );
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }

      // If port specified then split it apart
      let port;

      // If it starts with `[` then we can assume it's encoded as `[IPv6]` or `[IPv6]:PORT`
      if (ipv6.startsWith('[')) {
        const lastIndex = ipv6.lastIndexOf(']');
        port = ipv6.slice(lastIndex + 2);
        ipv6 = ipv6.slice(1, lastIndex);
      }

      // Not sure if there's a built-in way with Node.js to do this (?)
      if (port) {
        port = Number(port);
        // <https://github.com/leecjson/node-is-valid-port/blob/2da250b23e0d83bcfc042b44fa7cabdea1984a73/index.js#L3-L7>
        if (!(Number.isSafeInteger(port) && port >= 0 && port <= 65_535)) {
          const error = new TypeError('Invalid port.');
          error.code = 'ERR_INVALID_ARG_TYPE';
          throw error;
        }
      }

      if (!isIPv6(ipv6)) {
        const error = new TypeError('Invalid IP address.');
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }

      this.options.ipv6 = ipv6;
      this.options.ipv6Port = port;
    }
  }


  async lookup(name, options = {}) {
    // Validate name
    if (typeof name !== 'string') {
      const error = new TypeError(
        'The "name" argument must be of type string.'
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }

    // If options is an integer, it must be 4 or 6
    if (typeof options === 'number') {
      if (options !== 0 && options !== 4 && options !== 6) {
        const error = new TypeError(
          `The argument 'family' must be one of: 0, 4, 6. Received ${options}`
        );
        error.code = 'ERR_INVALID_ARG_TYPE';
        throw error;
      }

      options = { family: options };
    } else if (
      options?.family !== undefined &&
      ![0, 4, 6, 'IPv4', 'IPv6'].includes(options.family)
    ) {
      // Validate family
      const error = new TypeError(
        `The argument 'family' must be one of: 0, 4, 6. Received ${options.family}`
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }

    if (options?.family === 'IPv4') {
      options.family = 4;
    } else if (options?.family === 'IPv6') {
      options.family = 6;
    }

    if (typeof options.family !== 'number') {
      options.family = 0;
    }

    // Validate hints

    if ((options?.hints & ~(dns.ADDRCONFIG | dns.ALL | dns.V4MAPPED)) !== 0) {
      const error = new TypeError(
        `The argument 'hints' is invalid. Received ${options.hints}`
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }

    if (name === '.') {
      const error = this.constructor.createError(name, '', dns.NOTFOUND);
      // Remap and perform syscall
      error.syscall = 'getaddrinfo';
      error.message = error.message.replace('query', 'getaddrinfo');
      error.errno = -3008; // <-- ?
      // err.errno = -3007;
      throw error;
    }

    // Purge cache support
    let purgeCache;
    if (options?.purgeCache) {
      purgeCache = true;
      delete options.purgeCache;
    }

    if (options.hints) {
      switch (options.hints) {
        case dns.ADDRCONFIG: {
          options.family = this.constructor.getAddrConfigTypes();
          break;
        }


        case dns.ADDRCONFIG | dns.V4MAPPED: {
          options.family = this.constructor.getAddrConfigTypes();
          break;
        }


        case dns.ADDRCONFIG | dns.V4MAPPED | dns.ALL: {
          options.family = this.constructor.getAddrConfigTypes();

          break;
        }

        default: {
          break;
        }
      }
    }

    // <https://github.com/c-ares/c-ares/blob/38b30bc922c21faa156939bde15ea35332c30e08/src/lib/ares_getaddrinfo.c#L407>
    // <https://www.rfc-editor.org/rfc/rfc6761.html#section-6.3>
    //
    // >  'localhost and any domains falling within .localhost'
    //
    // if no system loopback match, then revert to the default
    // <https://github.com/c-ares/c-ares/blob/38b30bc922c21faa156939bde15ea35332c30e08/src/lib/ares__addrinfo_localhost.c#L224-L229>
    // - IPv4 = '127.0.0.1"
    // - IPv6 = "::1"
    //
    let resolve4;
    let resolve6;

    const lower = name.toLowerCase();

    for (const rule of this.constructor.HOSTS) {
      if (rule.hosts.every((h) => h.toLowerCase() !== lower)) {
        continue;
      }

      const type = isIP(rule.ip);
      if (!resolve4 && type === 4) {
        if (!Array.isArray(resolve4)) {
          resolve4 = [rule.ip];
        } else if (!resolve4.includes(rule.ip)) {
          resolve4.push([rule.ip]);
        }
      } else if (!resolve6 && type === 6) {
        if (!Array.isArray(resolve6)) {
          resolve6 = [rule.ip];
        } else if (!resolve6.includes(rule.ip)) {
          resolve6.push(rule.ip);
        }
      }
    }

    // Safeguard (matches c-ares)
    if (lower === 'localhost' || lower === 'localhost.') {
      resolve4 ||= ['127.0.0.1'];
      resolve6 ||= ['::1'];
    }

    if (isIPv4(name)) {
      resolve4 = [name];
      resolve6 = [];
    } else if (isIPv6(name)) {
      resolve6 = [name];
      resolve4 = [];
    }

    // Resolve the first A or AAAA record (conditionally)
    const promises = [
      Array.isArray(resolve4)
        ? Promise.resolve(resolve4)
        : this.resolve4(name, { purgeCache, noThrowOnNODATA: true }),
      Array.isArray(resolve6)
        ? Promise.resolve(resolve6)
        : this.resolve6(name, { purgeCache, noThrowOnNODATA: true })
    ];

    const results = await Promise.allSettled(promises);
    const resolvedResults = results.map((result) =>
      result.status === 'fulfilled' ? result.value : result.reason
    );

    const errors = [];
    let answers = [];

    for (const result of resolvedResults) {
      if (result instanceof Error) {
        errors.push(result);
      } else {
        answers.push(result);
      }
    }

    if (
      answers.length === 0 &&
      errors.length > 0 &&
      errors.every((error_) => error_.code === errors[0].code)
    ) {
      const error = this.constructor.createError(
        name,
        '',
        errors[0].code === dns.BADNAME ? dns.NOTFOUND : errors[0].code
      );
      // Remap and perform syscall
      error.syscall = 'getaddrinfo';
      error.message = error.message.replace('query', 'getaddrinfo');
      error.errno = -3008;
      throw error;
    }

    // Default node behavior seems to return IPv4 by default always regardless
    if (answers.length > 0) {
      answers =
        answers[0].length > 0 &&
        (options.family === undefined || options.family === 0)
          ? answers[0]
          : answers.flat();
    }

    // If no results then throw ENODATA
    if (answers.length === 0) {
      const error = this.constructor.createError(name, '', dns.NODATA);
      // Remap and perform syscall
      error.syscall = 'getaddrinfo';
      error.message = error.message.replace('query', 'getaddrinfo');
      error.errno = -3008;
      throw error;
    }

    // Respect options from dns module
    // <https://nodejs.org/api/dns.html#dnspromiseslookuphostname-options>
    // - [x] `family` (4, 6, or 0, default is 0)
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
    if (options.hints) {
      switch (options.hints) {
        case dns.V4MAPPED: {
          if (
            options.family === 6 &&
            !answers.some((answer) => isIPv6(answer))
          ) {
            answers = answers.map((answer) =>
              ipaddr.parse(answer).toIPv4MappedAddress().toString()
            );
          }

          break;
        }

        case dns.ALL: {
          options.all = true;
          break;
        }


        case dns.ADDRCONFIG | dns.V4MAPPED: {
          if (
            options.family === 6 &&
            !answers.some((answer) => isIPv6(answer))
          ) {
            answers = answers.map((answer) =>
              ipaddr.parse(answer).toIPv4MappedAddress().toString()
            );
          }

          break;
        }


        case dns.V4MAPPED | dns.ALL: {
          if (
            options.family === 6 &&
            !answers.some((answer) => isIPv6(answer))
          ) {
            answers = answers.map((answer) =>
              ipaddr.parse(answer).toIPv4MappedAddress().toString()
            );
          }

          options.all = true;
          break;
        }


        case dns.ADDRCONFIG | dns.V4MAPPED | dns.ALL: {
          if (
            options.family === 6 &&
            !answers.some((answer) => isIPv6(answer))
          ) {
            answers = answers.map((answer) =>
              ipaddr.parse(answer).toIPv4MappedAddress().toString()
            );
          }

          options.all = true;

          break;
        }

        default: {
          break;
        }
      }
    }

    if (options.family === 4) {
      answers = answers.filter((answer) => isIPv4(answer));
    } else if (options.family === 6) {
      answers = answers.filter((answer) => isIPv6(answer));
    }

    //
    // respect sort order from `setDefaultResultOrder` method
    //
    // NOTE: we need to optimize this sort logic at some point
    //
    if (options.verbatim !== true && this.options.dnsOrder === 'ipv4first') {
      answers = answers.sort((a, b) => {
        const aFamily = isIP(a);
        const bFamily = isIP(b);
        if (aFamily < bFamily) {
          return -1;
        }

        if (aFamily > bFamily) {
          return 1;
        }

        return 0;
      });
    }

    return options.all === true
      ? answers.map((answer) => ({
          address: answer,
          family: isIP(answer)
        }))
      : { address: answers[0], family: isIP(answers[0]) };
  }

  // <https://man7.org/linux/man-pages/man3/getnameinfo.3.html>
  async lookupService(address, port, abortController, purgeCache = false) {
    if (!address || !port) {
      const error = new TypeError(
        'The "address" and "port" arguments must be specified.'
      );
      error.code = 'ERR_MISSING_ARGS';
      throw error;
    }

    if (!isIP(address)) {
      const error = new TypeError(
        `The argument 'address' is invalid. Received '${address}'`
      );
      error.code = 'ERR_INVALID_ARG_VALUE';
      throw error;
    }

    if (!this.constructor.isValidPort(port)) {
      const error = new TypeError(
        `Port should be >= 0 and < 65536. Received ${port}.`
      );
      error.code = 'ERR_SOCKET_BAD_PORT';
      throw error;
    }

    const { name } = getService(port);

    // Reverse lookup
    try {
      const [hostname] = await this.reverse(
        address,
        abortController,
        purgeCache
      );
      return { hostname, service: name };
    } catch (error) {
      error.syscall = 'getnameinfo';
      throw error;
    }
  }

  async reverse(ip, abortController, purgeCache = false) {
    // Basically reverse the IP and then perform PTR lookup
    if (typeof ip !== 'string') {
      const error = new TypeError('The "ip" argument must be of type string.');
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }

    if (!isIP(ip)) {
      const error = this.constructor.createError(ip, '', 'EINVAL');
      error.message = `getHostByAddr EINVAL ${error.hostname}`;
      error.syscall = 'getHostByAddr';
      error.errno = -22;
      if (!ip) {
        delete error.hostname;
      }

      throw error;
    }

    // Edge case where localhost IP returns matches
    if (!isPrivateIP) {
      await pWaitFor(() => Boolean(isPrivateIP));
    }

    const answers = new Set();
    let match = false;

    for (const rule of this.constructor.HOSTS) {
      if (rule.ip === ip) {
        match = true;
        for (const host of rule.hosts.slice(1)) {
          answers.add(host);
        }
      }
    }

    if (answers.size > 0 || match) {
      return [...answers];
    }

    // NOTE: we can prob remove this (?)
    // if (ip === '::1' || ip === '127.0.0.1') return [];

    // reverse the IP address
    if (!dohdec) {
      await pWaitFor(() => Boolean(dohdec));
    }

    const name = dohdec.DNSoverHTTPS.reverse(ip);

    // Perform resolvePTR
    try {
      const answers = await this.resolve(
        name,
        'PTR',
        { purgeCache },
        abortController
      );
      return answers;
    } catch (error) {
      // Remap syscall
      error.syscall = 'getHostByAddr';
      error.message = `${error.syscall} ${error.code} ${ip}`;
      error.hostname = ip;
      throw error;
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

  resolveCaa(name, options, abortController) {
    return this.resolve(name, 'CAA', options, abortController);
  }

  resolveCname(name, options, abortController) {
    return this.resolve(name, 'CNAME', options, abortController);
  }

  resolveMx(name, options, abortController) {
    return this.resolve(name, 'MX', options, abortController);
  }

  resolveNaptr(name, options, abortController) {
    return this.resolve(name, 'NAPTR', options, abortController);
  }

  resolveNs(name, options, abortController) {
    return this.resolve(name, 'NS', options, abortController);
  }

  resolvePtr(name, options, abortController) {
    return this.resolve(name, 'PTR', options, abortController);
  }

  resolveSoa(name, options, abortController) {
    return this.resolve(name, 'SOA', options, abortController);
  }

  resolveSrv(name, options, abortController) {
    return this.resolve(name, 'SRV', options, abortController);
  }

  resolveTxt(name, options, abortController) {
    return this.resolve(name, 'TXT', options, abortController);
  }

  resolveCert(name, options, abortController) {
    return this.resolve(name, 'CERT', options, abortController);
  }

  // NOTE: parse this properly according to spec (see below default case)
  resolveTlsa(name, options, abortController) {
    return this.resolve(name, 'TLSA', options, abortController);
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
    // Safeguard in case aborted
    abortController?.signal?.throwIfAborted();

    let localAddress;
    let localPort;
    let url = `${this.options.protocol}://${server}/dns-query`;
    if (isIPv4(new URL(url).hostname)) {
      localAddress = this.options.ipv4;
      if (this.options.ipv4LocalPort) {
        localPort = this.options.ipv4LocalPort;
      }
    } else {
      localAddress = this.options.ipv6;
      if (this.options.ipv6LocalPort) {
        localPort = this.options.ipv6LocalPort;
      }
    }

    const options = {
      ...this.options.requestOptions,
      signal: abortController.signal
    };

    if (localAddress !== '0.0.0.0') {
      options.localAddress = localAddress;
    }

    if (localPort) {
      options.localPort = localPort;
    }

    // <https://github.com/hildjj/dohdec/blob/43564118c40f2127af871bdb4d40f615409d4b9c/pkg/dohdec/lib/doh.js#L117-L120>
    if (this.options.requestOptions.method.toLowerCase() === 'get') {
      if (!dohdec) {
        await pWaitFor(() => Boolean(dohdec));
      }

      // Safeguard in case aborted
      abortController?.signal?.throwIfAborted();
      url += `?dns=${dohdec.DNSoverHTTPS.base64urlEncode(pkt)}`;
    } else {
      options.body = pkt;
    }

    debug('request', { url, options });
    const timeoutId = setTimeout(() => {
      if (!abortController?.signal?.aborted) {
        abortController.abort();
      }
    }, timeout);

    try {
      const response = await this.request(url, options);
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // <https://github.com/hildjj/dohdec/tree/main/pkg/dohdec>

  async #query(name, rrtype = 'A', ecsSubnet, abortController) {
    if (!dohdec) {
      await pWaitFor(() => Boolean(dohdec));
    }

    debug('query', {
      name,
      nameToASCII: toASCII(name),
      rrtype,
      ecsSubnet,
      abortController
    });
    // <https://github.com/hildjj/dohdec/blob/43564118c40f2127af871bdb4d40f615409d4b9c/pkg/dohdec/lib/dnsUtils.js#L161>
    const pkt = dohdec.DNSoverHTTPS.makePacket({
      id:
        typeof this.options.id === 'function'
          ? await this.options.id()
          : this.options.id,
      rrtype,
      // Mirrors dns module behavior
      name: toASCII(name),
      // <https://github.com/mafintosh/dns-packet/pull/47#issuecomment-1435818437>
      ecsSubnet
    });
    try {
      // Mirror the behavior as noted in built-in DNS
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

            const response = await this.#request(
              pkt,
              server,
              abortController,
              this.options.timeout * 2 ** i
            );

            // If aborted signal then returns early

            if (response) {
              const { body, headers } = response;
              const statusCode = response.status || response.statusCode;
              debug('response', { statusCode, headers });


              if (body && statusCode >= 200 && statusCode < 300) {
                // <https://sindresorhus.com/blog/goodbye-nodejs-buffer>

                if (Buffer.isBuffer(body)) {
                  buffer = body;
                } else if (typeof body.arrayBuffer === 'function') {

                  buffer = Buffer.from(await body.arrayBuffer());
                } else if (isStream(body)) {

                  buffer = await getStream.buffer(body);
                } else {
                  const error = new TypeError('Unsupported body type');
                  error.body = body;
                  throw error;
                }

                break;
              }

              // <https://github.com/nodejs/undici/issues/3353>
              if (
                !abortController?.signal?.aborted &&
                body &&
                typeof body.dump === 'function'
              ) {

                await body.dump();
              }

              // <https://github.com/nodejs/undici/blob/00dfd0bd41e73782452aecb728395f354585ca94/lib/core/errors.js#L47-L58>
              const message =
                http.STATUS_CODES[statusCode] ||
                this.options.defaultHTTPErrorMessage;
              const error = new Error(message);
              error.body = body;
              error.status = statusCode;
              error.statusCode = statusCode;
              error.headers = headers;
              throw error;
            }
          } catch (error) {
            debug(error);

            //
            // NOTE: if NOTFOUND error occurs then don't attempt further requests
            // <https://nodejs.org/api/dns.html#dnssetserversservers>
            //

            if (error.code === dns.NOTFOUND) {
              throw error;
            }

            if (error.status >= 429) {
              ipErrors.push(error);
            }

            // Break out of the loop if status code was not retryable

            if (
              !(
                error.statusCode &&
                this.constructor.RETRY_STATUS_CODES.has(error.statusCode)
              ) &&
              !(
                error.code && this.constructor.RETRY_ERROR_CODES.has(error.code)
              )
            ) {
              break;
            }
          }
        }

        // Break out if we had a response
        if (buffer) {
          break;
        }

        if (ipErrors.length > 0) {
          // If the `server` had all errors, then remove it and add to end
          // (this ensures we don't keep retrying servers that keep timing out)
          // (which improves upon default c-ares behavior)
          if (this.options.servers.size > 1 && this.options.smartRotate) {
            const error = this.constructor.combineErrors([
              new Error('Rotating DNS servers due to issues'),
              ...ipErrors
            ]);
            this.options.logger.error(error, { server });
            this.options.servers.delete(server);
            this.options.servers.add(server);
          }

          errors.push(...ipErrors);
        }
      }

      if (!buffer) {
        if (errors.length > 0) {
          throw this.constructor.combineErrors(errors);
        }

        // If no errors and no response
        // that must indicate that it was aborted
        throw this.constructor.createError(name, rrtype, dns.CANCELLED);
      }

      // Without logging an error here, one might not know
      // that one or more dns servers have persistent issues
      if (errors.length > 0) {
        this.options.logger.error(this.constructor.combineErrors(errors));
      }

      //
      // NOTE: dns-packet does not yet support Uint8Array
      //       (however undici does have body.arrayBuffer() method)
      //
      // https://github.com/mafintosh/dns-packet/issues/72
      return packet.decode(buffer);
    } catch (error) {
      debug(error, { name, rrtype, ecsSubnet });
      if (this.options.returnHTTPErrors) {
        throw error;
      }

      const error_ = this.constructor.createError(
        name,
        rrtype,
        error.code,
        error.errno
      );
      // Then map it to dns.CONNREFUSED
      // preserve original error and stack trace
      error_.error = error;
      // Throwing here saves indentation below
      throw error_;
    }
  }

  // Cancel all outstanding DNS queries made by this resolver
  // NOTE: callbacks not currently called with ECANCELLED (prob need to alter got options)
  //       (instead they are called with "ABORT_ERR"; see ABORT_ERROR_CODES)
  cancel() {
    for (const abortController of this.abortControllers) {
      if (!abortController.signal.aborted) {
        try {
          abortController.abort('Cancel invoked');
        } catch (error) {
          this.options.logger.debug(error);
        }
      }
    }

    // Clear all abort controllers from the set to prevent memory leaks
    this.abortControllers.clear();
  }

  #resolveByType(name, options = {}, parentAbortController) {
    return async (type) => {
      const abortController = new AbortController();

      // Set max listeners to prevent memory leak warnings (before adding listeners)
      setMaxListeners(50, abortController.signal);

      // Also ensure parent abort controller can handle multiple listeners
      if (parentAbortController && parentAbortController.signal) {
        setMaxListeners(50, parentAbortController.signal);
      }

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
          try {
            abortController.abort('Parent abort controller aborted');
          } catch (error) {
            this.options.logger.debug(error);
          }
        },
        { once: true }
      );
      // Wrap with try/catch because ENODATA shouldn't cause errors
      try {
        switch (type) {
          case 'A': {
            const result = await this.resolve4(
              name,
              { ...options, ttl: true },
              abortController
            );
            return result.map((r) => ({ type, ...r }));
          }

          case 'AAAA': {
            const result = await this.resolve6(
              name,
              { ...options, ttl: true },
              abortController
            );
            return result.map((r) => ({ type, ...r }));
          }

          case 'CNAME': {
            const result = await this.resolveCname(
              name,
              options,
              abortController
            );
            return result.map((value) => ({ type, value }));
          }

          case 'MX': {
            const result = await this.resolveMx(name, options, abortController);
            return result.map((r) => ({ type, ...r }));
          }

          case 'NAPTR': {
            const result = await this.resolveNaptr(
              name,
              options,
              abortController
            );
            return result.map((value) => ({ type, value }));
          }

          case 'NS': {
            const result = await this.resolveNs(name, options, abortController);
            return result.map((value) => ({ type, value }));
          }

          case 'PTR': {
            const result = await this.resolvePtr(
              name,
              options,
              abortController
            );
            return result.map((value) => ({ type, value }));
          }

          case 'SOA': {
            const result = await this.resolveSoa(
              name,
              options,
              abortController
            );
            return { type, ...result };
          }

          case 'SRV': {
            const result = await this.resolveSrv(
              name,
              options,
              abortController
            );
            return result.map((value) => ({ type, value }));
          }

          case 'TXT': {
            const result = await this.resolveTxt(
              name,
              options,
              abortController
            );
            return result.map((entries) => ({ type, entries }));
          }

          default: {
            break;
          }
        }
      } catch (error) {
        debug(error);

        if (error.code === dns.NODATA) {
          return;
        }

        throw error;
      }
    };
  }

  // <https://nodejs.org/api/dns.html#dnspromisesresolveanyhostname>
  async resolveAny(name, options = {}, abortController) {
    if (typeof name !== 'string') {
      const error = new TypeError(
        'The "name" argument must be of type string.'
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }

    // <https://gist.github.com/andrewcourtice/ef1b8f14935b409cfe94901558ba5594#file-task-ts-L37>
    // <https://github.com/nodejs/undici/blob/0badd390ad5aa531a66aacee54da664468aa1577/lib/api/api-fetch/request.js#L280-L295>
    // <https://github.com/nodejs/node/issues/40849>
    if (!abortController) {
      abortController = new AbortController();

      // Set max listeners to prevent memory leak warnings (before adding listeners)
      setMaxListeners(50, abortController.signal);

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

    try {
      const results = await pMap(
        this.constructor.ANY_TYPES,
        this.#resolveByType(name, options, abortController),
        // <https://developers.cloudflare.com/fundamentals/api/reference/limits/>
        {
          concurrency: this.options.concurrency,
          signal: abortController.signal
        }
      );
      return results.flat().filter(Boolean);
    } catch (error) {
      error.syscall = 'queryAny';
      error.message = `queryAny ${error.code} ${name}`;
      throw error;
    }
  }

  setDefaultResultOrder(dnsOrder) {
    if (dnsOrder !== 'ipv4first' && dnsOrder !== 'verbatim') {
      const error = new TypeError(
        "The argument 'dnsOrder' must be one of: 'verbatim', 'ipv4first'."
      );
      error.code = 'ERR_INVALID_ARG_VALUE';
      throw error;
    }

    this.options.dnsOrder = dnsOrder;
  }

  setServers(servers) {
    if (!Array.isArray(servers) || servers.length === 0) {
      const error = new TypeError(
        'The "name" argument must be an instance of Array.'
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
    }

    //
    // NOTE: every address must be ipv4 or ipv6 (use `new URL` to parse and check)
    // servers [ string ] - array of RFC 5952 formatted addresses
    //

    // <https://github.com/nodejs/node/blob/9bbde3d7baef584f14569ef79f116e9d288c7aaa/lib/internal/dns/utils.js#L87-L95>
    this.options.servers = new Set(servers);
  }


  spoofPacket(name, rrtype, answers = [], json = false, expires = 30_000) {
    if (typeof name !== 'string') {
      const error = new TypeError(
        'The "name" argument must be of type string.'
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }

    if (typeof rrtype !== 'string') {
      const error = new TypeError(
        'The "rrtype" argument must be of type string.'
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }

    if (!this.constructor.TYPES.has(rrtype)) {
      const error = new TypeError("The argument 'rrtype' is invalid.");
      error.code = 'ERR_INVALID_ARG_VALUE';
      throw error;
    }

    if (!Array.isArray(answers)) {
      const error = new TypeError("The argument 'answers' is invalid.");
      error.code = 'ERR_INVALID_ARG_VALUE';
      throw error;
    }

    const object = {
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
      questions: [{ name, type: rrtype, class: 'IN' }],
      answers: answers.map((answer) => ({
        name,
        type: rrtype,
        ttl: 300,
        class: 'IN',
        flush: false,
        data: rrtype === 'TXT' ? [answer] : answer
      })),
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
          options: [Array]
        }
      ],
      ttl: 300,
      expires:
        expires instanceof Date ? expires.getTime() : Date.now() + expires
    };

    return json ? JSON.stringify(object) : object;
  }


  async resolve(name, rrtype = 'A', options = {}, abortController) {
    if (typeof name !== 'string') {
      const error = new TypeError(
        'The "name" argument must be of type string.'
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }

    if (typeof rrtype !== 'string') {
      const error = new TypeError(
        'The "rrtype" argument must be of type string.'
      );
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }

    if (!this.constructor.TYPES.has(rrtype)) {
      const error = new TypeError("The argument 'rrtype' is invalid.");
      error.code = 'ERR_INVALID_ARG_VALUE';
      throw error;
    }

    // Edge case where c-ares detects "." as start of string
    // <https://github.com/c-ares/c-ares/blob/38b30bc922c21faa156939bde15ea35332c30e08/src/lib/ares_getaddrinfo.c#L829>
    if (name !== '.' && (name.startsWith('.') || name.includes('..'))) {
      throw this.constructor.createError(name, rrtype, dns.BADNAME);
    }

    // Purge cache support
    let purgeCache;
    if (options?.purgeCache) {
      purgeCache = true;
      delete options.purgeCache;
    }

    // EcsSubnet support
    let ecsSubnet;
    if (options?.ecsSubnet) {
      ecsSubnet = options.ecsSubnet;
      delete options.ecsSubnet;
    }

    const key = (
      ecsSubnet ? `${rrtype}:${ecsSubnet}:${name}` : `${rrtype}:${name}`
    ).toLowerCase();

    let result;
    let data;
    if (this.options.cache && !purgeCache) {
      //
      // NOTE: we store `result.ttl` which was the lowest TTL determined
      //       (this saves us from duplicating the same `...sort().filter(Number.isFinite)` logic)
      //
      data = await this.options.cache.get(key);
      //
      // if it's not an object then assume that
      // the cache implementation does not have JSON.parse built-in
      // and so we should try to parse it on our own (user-friendly)
      //
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {}
      }

      // Safeguard in case cache pollution
      if (data && typeof data === 'object') {
        debug('cache retrieved', key);
        const now = Date.now();
        // Safeguard in case cache pollution
        if (
          !Number.isFinite(data.expires) ||
          data.expires < now ||
          !Number.isFinite(data.ttl) ||
          data.ttl < 1
        ) {
          debug('cache expired', key);
          data = undefined;
        } else if (options?.ttl) {
          // Clone the data so that we don't mutate cache (e.g. if it's in-memory)
          // <https://nodejs.org/api/globals.html#structuredclonevalue-options>
          // <https://github.com/ungap/structured-clone>
          data = structuredClone(data);

          // Returns ms -> s conversion
          const ttl = Math.round((data.expires - now) / 1000);
          const diff = data.ttl - ttl;

          for (let i = 0; i < data.answers.length; i++) {

            if (typeof data.answers[i].ttl === 'number') {
              // Subtract ttl from answer
              data.answers[i].ttl = Math.round(data.answers[i].ttl - diff);


              if (data.answers[i].ttl <= 0) {
                debug('answer cache expired', key);
                data = undefined;
                break;
              }
            }
          }
        }

        // Will only use cache if it's still set after parsing ttl
        result = data;
      } else {
        data = undefined;
      }
    }

    //
    // <https://nodejs.org/api/dns.html#dnspromisesresolvehostname-rrtype>
    //
    // // <https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/#return-codes>
    // HTTP Status  Meaning
    // 400          DNS query not specified or too small.
    // 413          DNS query is larger than maximum allowed DNS message size.
    // 415          Unsupported content type.
    // 504          Resolver timeout while waiting for the query response.
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
    if (this.options.cache && result) {
      debug(`cached result found for "${key}"`);
    } else {
      if (!abortController) {
        abortController = new AbortController();

        // Set max listeners to prevent memory leak warnings (before adding listeners)
        setMaxListeners(50, abortController.signal);

        this.abortControllers.add(abortController);
        abortController.signal.addEventListener(
          'abort',
          () => {
            this.abortControllers.delete(abortController);
          },
          { once: true }
        );
      }

      // SetImmediate(() => this.cancel());
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
        // <https://github.com/hildjj/dohdec/issues/40#issuecomment-1445554626>
        if (result.flag_tc) {
          this.options.logger.error(
            new Error(
              'Truncated DNS response; Defer to https://github.com/hildjj/dohdec/issues/40#issuecomment-1445554626 for insight.'
            ),
            {
              name,
              rrtype,
              result
            }
          );
        } else if (this.options.cache && !data) {
          // Store in cache based off lowest ttl
          let ttl = result.answers
            .map((answer) => answer.ttl)
            .sort()
            .find((ttl) => Number.isFinite(ttl));
          // If TTL is not a number or is < 1 or is > max then set to default
          if (
            !Number.isFinite(ttl) ||
            ttl < 1 ||
            ttl > this.options.maxTTLSeconds
          ) {
            ttl = this.options.defaultTTLSeconds;
          }

          result.ttl = ttl;
          // This supports both redis-based key/value/ttl and simple key/value implementations
          result.expires = Date.now() + Math.round(result.ttl * 1000);
          const args = [key, result, ...this.options.setCacheArgs(key, result)];
          debug('setting cache', { args });
          await this.options.cache.set(...args);
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

    // If no results then throw ENODATA
    // (hidden option for `lookup` to prevent errors being thrown)
    if (result.answers.length === 0 && !options.noThrowOnNODATA) {
      throw this.constructor.createError(name, rrtype, dns.NODATA);
    }

    // Filter the answers for the same type
    result.answers = result.answers.filter((answer) => answer.type === rrtype);

    //
    // NOTE: the dns package does not throw an error if there are no filtered answers
    //

    switch (rrtype) {
      case 'A': {
        // IPv4 addresses `dnsPromises.resolve4()`
        // if options.ttl === true then return [ { address, ttl } ] vs [ address ]
        if (options?.ttl) {
          return result.answers.map((a) => ({
            ttl: a.ttl,
            address: a.data
          }));
        }

        return result.answers.map((a) => a.data);
      }

      case 'AAAA': {
        // IPv6 addresses `dnsPromises.resolve6()`
        // if options.ttl === true then return [ { address, ttl } ] vs [ address ]
        if (options?.ttl) {
          return result.answers.map((a) => ({
            ttl: a.ttl,
            address: a.data
          }));
        }

        return result.answers.map((a) => a.data);
      }

      case 'CAA': {
        // CA authorization records  `dnsPromises.resolveCaa()`
        // <https://www.rfc-editor.org/rfc/rfc6844#section-3>
        return result.answers.map((a) => ({
          critical: a.data.flags,
          [a.data.tag]: a.data.value
        }));
      }

      case 'CNAME': {
        // Canonical name records  `dnsPromises.resolveCname()`
        return result.answers.map((a) => a.data);
      }

      case 'MX': {
        // Mail exchange records  `dnsPromises.resolveMx()`
        return result.answers.map((a) => ({
          exchange: a.data.exchange,
          priority: a.data.preference
        }));
      }

      case 'NAPTR': {
        // Name authority pointer records `dnsPromises.resolveNaptr()`
        return result.answers.map((a) => a.data);
      }

      case 'NS': {
        // Name server records  `dnsPromises.resolveNs()`
        return result.answers.map((a) => a.data);
      }

      case 'PTR': {
        // Pointer records  `dnsPromises.resolvePtr()`
        return result.answers.map((a) => a.data);
      }

      case 'SOA': {
        // Start of authority records `dnsPromises.resolveSoa()`
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
        // Service records  `dnsPromises.resolveSrv()`
        return result.answers.map((a) => ({
          name: a.data.target,
          port: a.data.port,
          priority: a.data.priority,
          weight: a.data.weight
        }));
      }

      case 'TXT': {
        // Text records `dnsPromises.resolveTxt()`
        return result.answers.flatMap((a) => {
          //
          // NOTE: we need to support buffer conversion
          //       (e.g. JSON.stringify from most cache stores will convert this as such below)
          //
          // a {
          //   name: 'forwardemail.net',
          //   type: 'TXT',
          //   ttl: 3600,
          //   class: 'IN',
          //   flush: false,
          //   data: [ { type: 'Buffer', data: [Array] } ]
          // }
          //
          // (or)
          //
          // a {
          //   name: 'forwardemail.net',
          //   type: 'TXT',
          //   ttl: 3600,
          //   class: 'IN',
          //   flush: false,
          //   data: { type: 'Buffer', data: [Array] }
          // }
          //
          if (Array.isArray(a.data)) {
            a.data = a.data.map((d) => {
              if (
                typeof d === 'object' &&
                d.type === 'Buffer' &&
                Array.isArray(d.data)
              ) {
                return Buffer.from(d.data);
              }

              return d;
            });
          } else if (
            typeof a.data === 'object' &&
            a.data.type === 'Buffer' &&
            Array.isArray(a.data.data)
          ) {
            a.data = Buffer.from(a.data.data);
          }

          return [
            Buffer.isBuffer(a.data)
              ? a.data.toString()
              : Array.isArray(a.data)
                ? a.data.map((d) => (Buffer.isBuffer(d) ? d.toString() : d))
                : a.data
          ];
        });
      }

      case 'CERT': {
        // CERT records `tangerine.resolveCert`
        // <https://github.com/jpnarkinsky/tangerine/commit/5f70954875aa93ef4acf076172d7540298b0a16b>
        // <https://www.rfc-editor.org/rfc/rfc4398.html>
        return result.answers.map((answer) => {
          if (!Buffer.isBuffer(answer.data)) {
            throw new TypeError('Buffer was not available');
          }

          try {
            // <https://github.com/rthalley/dnspython/blob/98b12e9e43847dac615bb690355d2fabaff969d2/dns/rdtypes/ANY/CERT.py#L69>
            const object = {
              name: answer.name,
              ttl: answer.ttl,
              certificateType: answer.data.subarray(0, 2).readUInt16BE(),
              keyTag: answer.data.subarray(2, 4).readUInt16BE(),
              algorithm: answer.data.subarray(4, 5).readUInt8(),
              certificate: answer.data.subarray(5).toString('base64')
            };
            if (this.constructor.CTYPE_BY_VALUE[object.certificateType]) {
              object.certificateType =
                this.constructor.CTYPE_BY_VALUE[object.certificateType];
            } else {
              object.certificateType = object.certificateType.toString();
            }

            return object;
          } catch (error) {
            this.options.logger.error(error, {
              name,
              rrtype,
              options,
              answer
            });
            throw error;
          }
        });
      }

      case 'TLSA': {
        // If it returns answers with `type: TLSA` then recursively lookup
        // 3 1 1 D6FEA64D4E68CAEAB7CBB2E0F905D7F3CA3308B12FD88C5B469F08AD 7E05C7C7
        return result.answers.map((answer) => {
          const object = {
            name: answer.name,
            ttl: answer.ttl
          };

          // <https://www.mailhardener.com/kb/dane>
          // <https://github.com/rthalley/dnspython/blob/98b12e9e43847dac615bb690355d2fabaff969d2/dns/rdtypes/tlsabase.py#L35>
          if (Buffer.isBuffer(answer.data)) {
            object.usage = answer.data.subarray(0, 1).readUInt8();
            object.selector = answer.data.subarray(1, 2).readUInt8();
            object.mtype = answer.data.subarray(2, 3).readUInt8();
            object.cert = answer.data.subarray(3);
          } else {
            object.usage = answer.data.usage;
            object.selector = answer.data.selector;
            object.mtype = answer.data.matchingType;
            object.cert = answer.data.certificate;
          }

          // Aliases to match Cloudflare DNS response
          object.matchingType = object.mtype;
          object.certificate = object.cert;

          return object;
        });
      }

      default: {
        this.options.logger.error(
          new Error(
            `Submit a PR at <https://github.com/forwardemail/nodejs-dns-over-https-tangerine> with proper parsing for ${rrtype} records.  You can reference <https://github.com/rthalley/dnspython/tree/master/dns/rdtypes/ANY> for inspiration.`
          )
        );
        return result.answers;
      }
    }
  }
}

export default Tangerine;
