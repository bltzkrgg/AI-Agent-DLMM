import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getGmgnRobinhoodTrendingTokens,
  getGmgnTokenInfo,
  getGmgnTrendingTokens,
} from '../src/utils/gmgn.js';

test('GMGN Robinhood rank sends chain and both qualification filters', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GMGN_API_KEY;
  const originalRetries = process.env.GMGN_MAX_RETRIES;
  let requestedUrl = '';
  process.env.GMGN_API_KEY = 'test-secret-key';
  process.env.GMGN_MAX_RETRIES = '0';
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ code: 0, data: { rank: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await getGmgnRobinhoodTrendingTokens({
      minVolumeUsd: 100000,
      minTotalFeesEth: 0.1,
    });
    const url = new URL(requestedUrl);
    assert.equal(url.pathname, '/v1/market/rank');
    assert.equal(url.searchParams.get('chain'), 'robinhood');
    assert.equal(url.searchParams.get('interval'), '5m');
    assert.equal(url.searchParams.get('min_volume'), '100000');
    assert.equal(url.searchParams.get('min_total_fee'), '0.1');
  } finally {
    global.fetch = originalFetch;
    if (originalKey == null) delete process.env.GMGN_API_KEY;
    else process.env.GMGN_API_KEY = originalKey;
    if (originalRetries == null) delete process.env.GMGN_MAX_RETRIES;
    else process.env.GMGN_MAX_RETRIES = originalRetries;
  }
});

test('GMGN market rank fails visibly when the API key is missing', async () => {
  const originalKey = process.env.GMGN_API_KEY;
  delete process.env.GMGN_API_KEY;

  try {
    await assert.rejects(
      getGmgnTrendingTokens(),
      (error) => error?.code === 'GMGN_API_KEY_MISSING'
    );
    assert.equal(await getGmgnTokenInfo('mint'), null);
  } finally {
    if (originalKey == null) delete process.env.GMGN_API_KEY;
    else process.env.GMGN_API_KEY = originalKey;
  }
});

test('GMGN market rank exposes HTTP status without leaking the API key', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GMGN_API_KEY;
  const originalRetries = process.env.GMGN_MAX_RETRIES;
  let requestedUrl = '';
  process.env.GMGN_API_KEY = 'test-secret-key';
  process.env.GMGN_MAX_RETRIES = '0';
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(
      JSON.stringify({ message: 'Forbidden' }),
      {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }
    );
  };

  try {
    await assert.rejects(
      getGmgnTrendingTokens(),
      (error) => {
        assert.equal(error?.code, 'GMGN_HTTP_403');
        assert.equal(error?.status, 403);
        assert.doesNotMatch(error?.message || '', /test-secret-key/);
        return true;
      }
    );
    assert.doesNotMatch(requestedUrl, /min_volume|min_marketcap|max_created/);
  } finally {
    global.fetch = originalFetch;
    if (originalKey == null) delete process.env.GMGN_API_KEY;
    else process.env.GMGN_API_KEY = originalKey;
    if (originalRetries == null) delete process.env.GMGN_MAX_RETRIES;
    else process.env.GMGN_MAX_RETRIES = originalRetries;
  }
});

test('GMGN market rank unwraps the nested response envelope used by production', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GMGN_API_KEY;
  const originalRetries = process.env.GMGN_MAX_RETRIES;
  process.env.GMGN_API_KEY = 'test-secret-key';
  process.env.GMGN_MAX_RETRIES = '0';
  global.fetch = async () => new Response(
    JSON.stringify({
      code: 0,
      data: {
        code: 0,
        data: {
          rank: [
            {
              address: 'So11111111111111111111111111111111111111112',
              symbol: 'WSOL',
              volume: 123456,
            },
          ],
        },
        message: 'success',
        reason: '',
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }
  );

  try {
    const rows = await getGmgnTrendingTokens();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].symbol, 'WSOL');
    assert.equal(rows[0].volume, 123456);
  } finally {
    global.fetch = originalFetch;
    if (originalKey == null) delete process.env.GMGN_API_KEY;
    else process.env.GMGN_API_KEY = originalKey;
    if (originalRetries == null) delete process.env.GMGN_MAX_RETRIES;
    else process.env.GMGN_MAX_RETRIES = originalRetries;
  }
});

test('GMGN nested API errors remain visible to Token Alerts', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GMGN_API_KEY;
  const originalRetries = process.env.GMGN_MAX_RETRIES;
  process.env.GMGN_API_KEY = 'test-secret-key';
  process.env.GMGN_MAX_RETRIES = '0';
  global.fetch = async () => new Response(
    JSON.stringify({
      code: 0,
      data: {
        code: 1006,
        data: null,
        message: 'market data unavailable',
        reason: 'permission',
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }
  );

  try {
    await assert.rejects(
      getGmgnTrendingTokens(),
      (error) => {
        assert.equal(error?.code, 'GMGN_API_ERROR');
        assert.match(error?.message || '', /1006/);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
    if (originalKey == null) delete process.env.GMGN_API_KEY;
    else process.env.GMGN_API_KEY = originalKey;
    if (originalRetries == null) delete process.env.GMGN_MAX_RETRIES;
    else process.env.GMGN_MAX_RETRIES = originalRetries;
  }
});

test('GMGN rate limit creates a shared cooldown without retrying or extending the ban', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GMGN_API_KEY;
  const originalRetries = process.env.GMGN_MAX_RETRIES;
  const resetAt = Math.floor(Date.now() / 1000) + 60;
  let fetchCalls = 0;
  process.env.GMGN_API_KEY = 'test-secret-key';
  process.env.GMGN_MAX_RETRIES = '2';
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({
      code: 429,
      error: 'RATE_LIMIT_BANNED',
      message: 'Too many requests',
      reset_at: resetAt,
    }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-reset': String(resetAt),
      },
    });
  };

  try {
    await assert.rejects(
      getGmgnTrendingTokens(),
      (error) => {
        assert.equal(error?.code, 'GMGN_RATE_LIMITED');
        assert.equal(error?.status, 429);
        assert.ok(error?.retryAt >= resetAt * 1000);
        return true;
      }
    );
    await assert.rejects(
      getGmgnRobinhoodTrendingTokens(),
      (error) => {
        assert.equal(error?.code, 'GMGN_RATE_LIMITED');
        assert.match(error?.message || '', /cooldown active until/);
        return true;
      }
    );
    assert.equal(fetchCalls, 1);
  } finally {
    global.fetch = originalFetch;
    if (originalKey == null) delete process.env.GMGN_API_KEY;
    else process.env.GMGN_API_KEY = originalKey;
    if (originalRetries == null) delete process.env.GMGN_MAX_RETRIES;
    else process.env.GMGN_MAX_RETRIES = originalRetries;
  }
});
