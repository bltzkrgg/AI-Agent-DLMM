import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getGmgnTokenInfo,
  getGmgnTrendingTokens,
} from '../src/utils/gmgn.js';

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
