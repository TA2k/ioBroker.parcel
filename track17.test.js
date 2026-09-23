// @ts-nocheck
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Load the real adapter methods without starting an ioBroker process or loading
// unrelated provider dependencies. All network and state I/O is supplied below.
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const context = {
  require: (id) => id === 'crypto' ? require('node:crypto') : { Adapter: class {}, default: {} },
  module: { exports: {} },
};
vm.runInNewContext(source + '\nmodule.exports = Parcel.prototype;', context);
const prototype = context.module.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));
const response = (accepted, rejected = []) => ({ data: { code: 0, data: { accepted, rejected } } });

function fixture(handler) {
  const states = { '17t.trackList': JSON.stringify(['LAST']) };
  const calls = [];
  const adapter = Object.assign(Object.create(prototype), {
    config: { '17trackKey': 'test-key' },
    sessions: { '17track': 'test-key' },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    logAxiosError: (_label, error) => { throw error; },
    sleep: async () => {},
    update17TQuota: async () => {},
    requestClient: async (options) => {
      const command = options.url.split('/').pop();
      const data = JSON.parse(options.data);
      calls.push({ command, data });
      return handler(command, data);
    },
    setStateAsync: async (id, value) => { states[id] = value; },
    setState: (id, value) => { states[id] = value; },
    ignoredPath: [],
    json2iob: { parse() {} },
    cleanupProvider: async () => {},
    delivery_status: { OUT_FOR_DELIVERY: 40, DELIVERED: 1 },
    deliveryStatusCheck: () => 30,
  });
  return { adapter, states, calls };
}

describe('17TRACK API shipments', () => {
  it('recovers the complete paginated list and publishes every batch and shipment key', async () => {
    const numbers = Array.from({ length: 45 }, (_, i) => 'TRACK' + i);
    const { adapter, states, calls } = fixture((command, data) => {
      if (command === 'gettracklist') {
        assert.deepEqual(Object.keys(data), ['page_no']);
        const page = data.page_no === 1 ? numbers.slice(0, 30) : data.page_no === 2 ? numbers.slice(30) : [];
        return response(page.map((number) => ({ number })));
      }
      assert.equal(command, 'gettrackinfo');
      assert.ok(data.length <= 40);
      return response(data.map(({ number }) => ({ number, track: { z0: { z: 'In transit' } } })));
    });
    await adapter.updateProvider();
    assert.deepEqual(JSON.parse(states['17t.trackList']), numbers);
    assert.deepEqual(calls.filter((call) => call.command === 'gettrackinfo').map((call) => call.data.length), [40, 5]);
    assert.deepEqual(Object.keys(JSON.parse(states.allProviderObjects)), numbers);
    assert.equal(JSON.parse(states.allProviderJson).length, 45);
    assert.equal(JSON.parse(states['17t.trackinginfo.json']).accepted.length, 45);
    assert.equal(states.notDeliveredCount, 45);
  });

  for (const command of ['register', 'deleteTrack']) {
    it(command + ' refreshes all numbers without filtering to the changed shipment', async () => {
      const { adapter, states } = fixture((endpoint, data) => {
        if (endpoint === command) return response([{ number: 'LAST' }]);
        assert.equal(endpoint, 'gettracklist');
        assert.deepEqual(Object.keys(data), ['page_no']);
        return response(data.page_no === 1 ? [{ number: 'FIRST' }, { number: 'SECOND' }] : []);
      });
      await adapter.onStateChange('parcel.0.17t.' + command, { val: 'LAST', ack: false });
      assert.deepEqual(JSON.parse(states['17t.trackList']), ['FIRST', 'SECOND']);
    });
  }

  it('normalizes a registration, reports acceptance and acknowledges it', async () => {
    const { adapter, states, calls } = fixture((command, data) => command === 'register'
      ? response([{ number: data[0].number }]) : response([]));
    const messages = [];
    const writes = [];
    const setState = adapter.setStateAsync;
    adapter.setStateAsync = async (...args) => {
      writes.push(args);
      return setState(...args);
    };
    adapter.log.info = (message) => messages.push(message);
    await adapter.onStateChange('parcel.0.17t.register', { val: '  00123456789  ', ack: false });
    assert.deepEqual(calls[0], { command: 'register', data: [{ number: '00123456789', auto_detection: true }] });
    assert.equal(states['parcel.0.17t.register'], '  00123456789  ');
    assert.deepEqual(writes[0], ['parcel.0.17t.register', '  00123456789  ', true]);
    assert.ok(messages.some((message) => message.includes('accepted tracking number 00123456789')));
  });

  it('reports API rejections returned with HTTP success without acknowledging success', async () => {
    const { adapter, states, calls } = fixture(() => response([], [{
      number: 'NEWTRACK', error: { code: -18019903, message: 'Carrier cannot be detected.' },
    }]));
    const errors = [];
    adapter.log.error = (message) => errors.push(message);
    await adapter.onStateChange('parcel.0.17t.register', { val: 'NEWTRACK', ack: false });
    assert.ok(errors.some((message) => message.includes('-18019903') && message.includes('Carrier cannot be detected.')));
    assert.equal(states['parcel.0.17t.register'], undefined);
    assert.equal(calls.length, 1);
  });

  it('reports a nonzero API result even when HTTP succeeds', async () => {
    const { adapter, states } = fixture(() => ({ data: { code: -18010002, data: {} } }));
    const errors = [];
    adapter.logAxiosError = (_label, error) => errors.push(error.message);
    await adapter.onStateChange('parcel.0.17t.register', { val: 'NEWTRACK', ack: false });
    assert.ok(errors.some((message) => message.includes('-18010002')));
    assert.equal(states['parcel.0.17t.register'], undefined);
  });

  it('does not send acknowledged states or unrelated 17TRACK states as commands', async () => {
    const { adapter, calls } = fixture(() => response([]));
    await adapter.onStateChange('parcel.0.17t.register', { val: 'NEWTRACK', ack: true });
    await adapter.onStateChange('parcel.0.17t.trackList', { val: '[]', ack: false });
    assert.equal(calls.length, 0);
  });

  it('rejects empty or imprecise numeric input before making a request', async () => {
    const { adapter, calls } = fixture(() => response([]));
    const errors = [];
    adapter.log.error = (message) => errors.push(message);
    for (const val of ['  ', Number.MAX_SAFE_INTEGER + 1, null, true]) {
      await adapter.onStateChange('parcel.0.17t.register', { val, ack: false });
    }
    assert.equal(calls.length, 0);
    assert.equal(errors.length, 4);
  });

  it('clears an empty account without sending an empty gettrackinfo request', async () => {
    const { adapter, states, calls } = fixture(() => response([]));
    assert.deepEqual(plain(await adapter.fetch17TParcels()), { accepted: [], rejected: [] });
    assert.equal(states['17t.trackList'], '[]');
    assert.equal(calls.length, 1);
  });

  it('keeps the saved list if a later page fails', async () => {
    const { adapter, states } = fixture((_command, data) => data.page_no === 1
      ? response([{ number: 'FIRST' }]) : { data: { code: -18010002 } });
    await assert.rejects(adapter.refresh17TTrackList(), /gettracklist failed/);
    assert.equal(states['17t.trackList'], '["LAST"]');
  });

  it('publishes all collected shipments when the API repeats its last page', async () => {
    const { adapter, states, calls } = fixture((command, data) => {
      if (command === 'gettracklist') {
        return response(data.page_no === 1 ? [{ number: 'FIRST' }] : [{ number: 'SECOND' }]);
      }
      return response(data.map(({ number }) => ({ number, track: { z0: { z: 'In transit' } } })));
    });
    await adapter.updateProvider();
    assert.deepEqual(JSON.parse(states['17t.trackList']), ['FIRST', 'SECOND']);
    assert.deepEqual(Object.keys(JSON.parse(states.allProviderObjects)), ['FIRST', 'SECOND']);
    assert.equal(states.notDeliveredCount, 2);
    assert.equal(calls.filter((call) => call.command === 'gettracklist').length, 3);
  });

  it('recognizes repeated shipments despite changed metadata and response order', async () => {
    const { adapter, calls } = fixture((_command, data) => response(data.page_no === 1
      ? [{ number: 'FIRST', w1: 1, tt: 'old' }, { number: 'SECOND', w1: 2 }]
      : [{ number: 'SECOND', w1: 2 }, { number: 'FIRST', w1: 1, tt: 'new' }]));
    assert.deepEqual(plain(await adapter.refresh17TTrackList()), ['FIRST', 'SECOND']);
    assert.equal(calls.length, 2);
  });

  it('stops at the reported last page without requesting an extra page', async () => {
    const { adapter, calls } = fixture((_command, data) => ({
      ...response([{ number: 'TRACK' + data.page_no }]),
      data: {
        ...response([{ number: 'TRACK' + data.page_no }]).data,
        page: { page_no: data.page_no, page_total: 2 },
      },
    }));
    assert.deepEqual(plain(await adapter.refresh17TTrackList()), ['TRACK1', 'TRACK2']);
    assert.equal(calls.length, 2);
  });

  it('combines accepted and rejected results across detail batches', async () => {
    const { adapter } = fixture((_command, data) => response(data.slice(0, -1), data.slice(-1)));
    adapter.refresh17TTrackList = async () => Array.from({ length: 41 }, (_, i) => 'TRACK' + i);
    const result = await adapter.fetch17TParcels();
    assert.equal(result.accepted.length, 39);
    assert.deepEqual(plain(result.rejected), [{ number: 'TRACK39' }, { number: 'TRACK40' }]);
  });
});

function quotaFixture(remaining = 19) {
  const context = fixture(() => ({ data: { code: 0, data: { quota_remain: remaining } } }));
  const { adapter, states } = context;
  delete adapter.update17TQuota;
  adapter.config.t17QuotaNotification = true;
  adapter.config.sendToInstance = 'telegram.0';
  adapter.config.sendToUser = '';
  adapter.getStateAsync = async (id) => states[id] === undefined ? null : { val: states[id] };
  const messages = [];
  const errors = [];
  adapter.sendToAsync = async (instance, payload) => { messages.push({ instance, payload }); };
  adapter.logAxiosError = (_label, error) => errors.push(error.message);
  return { ...context, messages, errors };
}

describe('17TRACK quota', () => {
  it('creates read-only numeric quota and persistent notification states', async () => {
    const { adapter } = quotaFixture();
    const objects = {};
    adapter.setObjectNotExistsAsync = async (id, object) => { objects[id] = object; };
    await adapter.login17TApi();
    assert.equal(objects['17t.quotaRemaining'].common.type, 'number');
    assert.equal(objects['17t.quotaRemaining'].common.write, false);
    assert.equal(objects['17t.quotaWarningSent'].common.type, 'boolean');
  });

  it('requests getquota with the API key and saves the remaining quota even with alerts disabled', async () => {
    const { adapter, states, messages } = quotaFixture();
    adapter.config.t17QuotaNotification = false;
    adapter.requestClient = async (options) => {
      assert.equal(options.url, 'https://api.17track.net/track/v2.4/getquota');
      assert.equal(options.method, 'post');
      assert.equal(options.headers['17token'], 'test-key');
      assert.equal(options.data, '[]');
      return { data: { code: 0, data: { quota_remain: 12 } } };
    };
    await adapter.update17TQuota();
    assert.equal(states['17t.quotaRemaining'], 12);
    assert.equal(messages.length, 0);
  });

  it('warns below 20 only once, including after a restart, and rearms at 20', async () => {
    const { adapter, states, messages } = quotaFixture();
    await adapter.update17TQuota();
    await adapter.update17TQuota();
    assert.equal(messages.length, 1);
    assert.ok(messages[0].payload.text.includes('19'));
    assert.equal(states['17t.quotaWarningSent'], true);
    const restarted = quotaFixture(18);
    restarted.states['17t.quotaWarningSent'] = states['17t.quotaWarningSent'];
    await restarted.adapter.update17TQuota();
    assert.equal(restarted.messages.length, 0);
    adapter.requestClient = async () => ({ data: { code: 0, data: { quota_remain: 20 } } });
    await adapter.update17TQuota();
    assert.equal(messages.length, 1);
    assert.equal(states['17t.quotaWarningSent'], false);
    adapter.requestClient = async () => ({ data: { code: 0, data: { quota_remain: 0 } } });
    await adapter.update17TQuota();
    assert.equal(states['17t.quotaRemaining'], 0);
    assert.equal(messages.length, 2);
  });

  it('uses only configured Telegram instances and recipients without requiring shipment alerts', async () => {
    const { adapter, messages } = quotaFixture();
    adapter.config.sendToActive = false;
    adapter.config.sendToInstance = 'telegram.0, pushover.0, telegram.1, telegram.0';
    adapter.config.sendToUser = ' Alice, Bob, Alice, ';
    await adapter.update17TQuota();
    assert.deepEqual(messages.map(({ instance, payload }) => [instance, payload.user]), [
      ['telegram.0', 'Alice'], ['telegram.0', 'Bob'], ['telegram.1', 'Alice'], ['telegram.1', 'Bob'],
    ]);
  });

  it('does not mark alerts sent when no Telegram instance is configured', async () => {
    const { adapter, states, messages } = quotaFixture();
    adapter.config.sendToInstance = 'pushover.0';
    await adapter.update17TQuota();
    assert.equal(messages.length, 0);
    assert.equal(states['17t.quotaWarningSent'], undefined);
  });

  it('retries notifications after Telegram reports an error', async () => {
    const { adapter, states, errors } = quotaFixture();
    adapter.sendToAsync = async () => ({ error: 'not connected' });
    await adapter.update17TQuota();
    assert.equal(states['17t.quotaWarningSent'], undefined);
    assert.equal(errors.length, 1);
    adapter.sendToAsync = async () => ({});
    await adapter.update17TQuota();
    assert.equal(states['17t.quotaWarningSent'], true);
  });

  it('preserves the last quota on malformed, failed or unavailable API responses', async () => {
    const { adapter, states, messages, errors } = quotaFixture();
    states['17t.quotaRemaining'] = 42;
    for (const data of [null, { code: -1, data: { quota_remain: 0 } },
      { code: 0, data: {} }, { code: 0, data: { quota_remain: -1 } }, { code: 0, data: { quota_remain: '19' } }]) {
      adapter.requestClient = async () => ({ data });
      await adapter.update17TQuota();
    }
    adapter.requestClient = async () => { throw new Error('timeout'); };
    await adapter.update17TQuota();
    assert.equal(states['17t.quotaRemaining'], 42);
    assert.equal(messages.length, 0);
    assert.equal(errors.length, 6);
  });

  it('continues shipment updates after a quota request fails', async () => {
    const { adapter, states, errors } = quotaFixture();
    adapter.requestClient = async (options) => {
      if (options.url.endsWith('/getquota')) throw new Error('quota unavailable');
      return response([]);
    };
    await adapter.updateProvider();
    assert.equal(states['17t.trackList'], '[]');
    assert.equal(states.allProviderJson, '[]');
    assert.equal(errors.length, 1);
  });

  it('refreshes quota after accepted registration', async () => {
    const { adapter, calls } = quotaFixture();
    adapter.requestClient = async (options) => {
      const command = options.url.split('/').pop();
      calls.push(command);
      if (command === 'register') return response([{ number: 'NEWTRACK' }]);
      if (command === 'getquota') return { data: { code: 0, data: { quota_remain: 100 } } };
      return response([]);
    };
    await adapter.onStateChange('parcel.0.17t.register', { val: 'NEWTRACK', ack: false });
    assert.deepEqual(calls, ['register', 'getquota', 'gettracklist']);
  });
});
