const http = require('node:http');
const process = require('node:process');

const Benchmark = require('benchmark');
const axios = require('axios');
const fetch = require('node-fetch');
const fetchMock = require('fetch-mock');
const got = require('got');
const nock = require('nock');
const phin = require('phin');
const request = require('request');
const superagent = require('superagent');
const undici = require('undici');

const PROTOCOL = process.env.BENCHMARK_PROTOCOL || 'http';
const HOST = process.env.BENCHMARK_HOST || 'test';
const PORT = process.env.BENCHMARK_PORT
  ? Number.parseInt(process.env.BENCHMARK_PORT, 10)
  : 80;
const PATH = process.env.BENCHMARK_PATH || '/test';
const URL = `${PROTOCOL}://${HOST}:${PORT}${PATH}`;

const suite = new Benchmark.Suite();

axios.defaults.baseURL = `http://${HOST}`;

if (HOST === 'test') {
  const mockAgent = new undici.MockAgent();

  mockAgent
    .get(axios.defaults.baseURL)
    .intercept({ path: PATH })
    .reply(200, 'ok');

  undici.setGlobalDispatcher(mockAgent);

  nock(axios.defaults.baseURL)
    .persist()
    .post(PATH)
    .reply(200, 'ok')
    .get(PATH)
    .reply(200, 'ok');

  fetchMock.mock(URL, 200);
}

suite.add('http.request POST request', {
  defer: true,
  fn(defer) {
    const req = http.request(
      { host: HOST, port: PORT, path: PATH, method: 'POST' },
      (res) => {
        res.resume().on('end', () => defer.resolve());
      }
    );
    req.write('');
    req.end();
  }
});

suite.add('http.request GET request', {
  defer: true,
  fn(defer) {
    http
      .request({ path: PATH, host: HOST, port: PORT }, (res) => {
        res.resume().on('end', () => defer.resolve());
      })
      .end();
  }
});

suite.add('undici GET request', {
  defer: true,
  fn(defer) {
    undici
      .request(URL)
      .then(() => defer.resolve())
      .catch(() => defer.resolve());
  }
});

suite.add('undici POST request', {
  defer: true,
  fn(defer) {
    undici
      .request(URL, { method: 'POST' })
      .then(() => defer.resolve())
      .catch(() => defer.resolve());
  }
});

suite.add('axios GET request', {
  defer: true,
  fn(defer) {
    axios
      .get(PATH)
      .then(() => defer.resolve())
      .catch(() => defer.resolve());
  }
});

suite.add('axios POST request', {
  defer: true,
  fn(defer) {
    axios
      .post(PATH)
      .then(() => defer.resolve())
      .catch(() => defer.resolve());
  }
});

suite.add('got GET request', {
  defer: true,
  fn(defer) {
    got
      .get(URL, { throwHttpErrors: false, retry: 0 })
      .then(() => defer.resolve())
      .catch(() => defer.resolve());
  }
});

suite.add('got POST request', {
  defer: true,
  fn(defer) {
    got
      .post(URL, { throwHttpErrors: false })
      .then(() => defer.resolve())
      .catch(() => defer.resolve());
  }
});

suite.add('fetch GET request', {
  defer: true,
  fn(defer) {
    fetch(URL).then(() => defer.resolve());
  }
});

suite.add('fetch POST request', {
  defer: true,
  fn(defer) {
    fetch(URL, { method: 'POST' })
      .then(() => defer.resolve())
      .catch(() => defer.resolve());
  }
});

suite.add('request GET request', {
  defer: true,
  fn(defer) {
    request(URL, () => defer.resolve());
  }
});

suite.add('request POST request', {
  defer: true,
  fn(defer) {
    request.post({ url: URL }, () => defer.resolve());
  }
});

suite.add('superagent GET request', {
  defer: true,
  fn(defer) {
    superagent.get(URL).end(() => defer.resolve());
  }
});

suite.add('superagent POST request', {
  defer: true,
  fn(defer) {
    superagent
      .post(URL)
      .send()
      .end(() => defer.resolve());
  }
});

suite.add('phin GET request', {
  defer: true,
  fn(defer) {
    phin(URL).then(() => defer.resolve());
  }
});

suite.add('phin POST request', {
  defer: true,
  fn(defer) {
    phin({ url: URL, method: 'POST' }).then(() => defer.resolve());
  }
});

suite.on('complete', function () {
  console.log('Fastest is ' + this.filter('fastest').map('name'));
});

suite.on('cycle', function (event) {
  console.log(String(event.target));
});

suite.run();
