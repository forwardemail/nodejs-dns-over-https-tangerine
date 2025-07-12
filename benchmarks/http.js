import http from 'node:http';
import process from 'node:process';
import Benchmark from 'benchmark';
import axios from 'axios';
import fetchMock from 'fetch-mock';
import got from 'got';
import nock from 'nock';
import phin from 'phin';
import superagent from 'superagent';
import undici from 'undici';

const PROTOCOL = process.env.BENCHMARK_PROTOCOL || 'http';
const HOST = process.env.BENCHMARK_HOST || 'test';
const PORT = process.env.BENCHMARK_PORT
  ? Number.parseInt(process.env.BENCHMARK_PORT, 10)
  : 80;
const PATH = process.env.BENCHMARK_PATH || '/test';
const URL = `${PROTOCOL}://${HOST}:${PORT}${PATH}`;

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

  fetchMock.get(URL, 200);
  fetchMock.post(URL, 200);
}

const suite = new Benchmark.Suite();

suite.on('start', (ev) => {
  console.log(`Started: ${ev.currentTarget.name}`);
});

suite.add('http.request POST request', {
  defer: true,
  fn(defer) {
    const request_ = http.request(
      {
        host: HOST,
        port: PORT,
        path: PATH,
        method: 'POST'
      },
      (response) => {
        response.resume().on('end', () => defer.resolve());
      }
    );
    request_.write('');
    request_.end();
  }
});

suite.add('http.request GET request', {
  defer: true,
  fn(defer) {
    http
      .request({ path: PATH, host: HOST, port: PORT }, (response) => {
        response.resume().on('end', () => defer.resolve());
      })
      .end();
  }
});

suite.add('undici GET request', {
  defer: true,
  async fn(defer) {
    try {
      await undici.request(URL);
    } catch {}

    defer.resolve();
  }
});

suite.add('undici POST request', {
  defer: true,
  async fn(defer) {
    try {
      await undici.request(URL, { method: 'POST' });
    } catch {}

    defer.resolve();
  }
});

suite.add('axios GET request', {
  defer: true,
  async fn(defer) {
    try {
      await axios.get(PATH);
    } catch {}

    defer.resolve();
  }
});

suite.add('axios POST request', {
  defer: true,
  async fn(defer) {
    try {
      await axios.post(PATH);
    } catch {}

    defer.resolve();
  }
});

suite.add('got GET request', {
  defer: true,
  async fn(defer) {
    try {
      await got.get(URL, { throwHttpErrors: false, retry: 0 });
    } catch {}

    defer.resolve();
  }
});

suite.add('got POST request', {
  defer: true,
  async fn(defer) {
    try {
      await got.post(URL, { throwHttpErrors: false });
    } catch {}

    defer.resolve();
  }
});

suite.add('fetch GET request', {
  defer: true,
  async fn(defer) {
    await fetch(URL);
    defer.resolve();
  }
});

suite.add('fetch POST request', {
  defer: true,
  async fn(defer) {
    try {
      await fetch(URL, { method: 'POST' });
    } catch {}

    defer.resolve();
  }
});

suite.add('axios GET request', {
  defer: true,
  async fn(defer) {
    try {
      await axios.get(URL);
    } catch {}

    defer.resolve();
  }
});

suite.add('axios POST request', {
  defer: true,
  async fn(defer) {
    try {
      await axios.post(URL);
    } catch {}

    defer.resolve();
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
  async fn(defer) {
    await phin(URL);
    defer.resolve();
  }
});

suite.add('phin POST request', {
  defer: true,
  async fn(defer) {
    await phin({ url: URL, method: 'POST' });
    defer.resolve();
  }
});

suite.on('cycle', (ev) => {
  console.log(String(ev.target));
});

suite.on('complete', function () {
  console.log(
    'Fastest is ' + this.filter('fastest').map('name').join(', ') + '\n'
  );
});

suite.run();
