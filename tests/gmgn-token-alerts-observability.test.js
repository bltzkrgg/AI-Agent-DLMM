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
