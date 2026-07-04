import test from 'node:test';
import assert from 'node:assert/strict';

import { __resolveManualCaPoolForTests } from '../src/agents/hunterAlpha.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const CA = '9shb4VuR85tKziVn7sxScS8AXEFA4smM8NL4Z6utBAGS';

function mockResponse(ok, status, payload) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

test('manual CA resolves when CA is tokenX and SOL is tokenY', async () => {
  const out = await __resolveManualCaPoolForTests(CA, { binStepPriority: [200, 125, 100] }, {
    getPoolInfoFn: async () => { throw new Error('not a pool address'); },
    fetchWithTimeoutFn: async (url) => {
      if (String(url).includes('dlmm.datapi.meteora.ag/pools?query=')) {
        return mockResponse(true, 200, {
          data: [{
            pool_address: 'PoolX111111111111111111111111111111111111',
            token_x: { address: CA, symbol: 'TRK' },
            token_y: { address: WSOL, symbol: 'SOL' },
            dlmm_params: { bin_step: 100 },
            fee_pct: 3,
            tvl: 20000,
            volume_24h: 10000,
          }],
        });
      }
      return mockResponse(true, 200, { data: [] });
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.kind, 'TOKEN');
  assert.equal(out.poolInfo.tokenXMint, CA);
  assert.equal(out.poolInfo.tokenYMint, WSOL);
});

test('manual CA resolves when CA is tokenY and SOL is tokenX', async () => {
  const out = await __resolveManualCaPoolForTests(CA, { binStepPriority: [200, 125, 100] }, {
    getPoolInfoFn: async () => { throw new Error('not a pool address'); },
    fetchWithTimeoutFn: async () => mockResponse(true, 200, {
      data: [{
        pool_address: 'PoolY111111111111111111111111111111111111',
        token_x: { address: WSOL, symbol: 'SOL' },
        token_y: { address: CA, symbol: 'TRK' },
        dlmm_params: { bin_step: 100 },
        fee_pct: 3,
        tvl: 15000,
      }],
    }),
  });

  assert.equal(out.ok, true);
  assert.equal(out.poolInfo.tokenXMint, CA);
  assert.equal(out.poolInfo.tokenYMint, WSOL);
});

test('TRK-SOL binStep 100 fee 3% candidate is accepted', async () => {
  const out = await __resolveManualCaPoolForTests(CA, { binStepPriority: [200, 125, 100] }, {
    getPoolInfoFn: async () => { throw new Error('not a pool address'); },
    fetchWithTimeoutFn: async () => mockResponse(true, 200, {
      data: [{
        pool_address: 'PoolTRK1111111111111111111111111111111111',
        token_x: { address: CA, symbol: 'TRK' },
        token_y: { address: WSOL, symbol: 'SOL' },
        dlmm_params: { bin_step: 100 },
        fee_pct: 3,
        tvl: 9000,
      }],
    }),
  });

  assert.equal(out.ok, true);
  assert.equal(out.poolInfo.binStep, 100);
  assert.equal(Number(out.poolInfo.feePct), 3);
});

test('latest Meteora schema pool_config.bin_step is treated as DLMM (not notDlmm)', async () => {
  const out = await __resolveManualCaPoolForTests(
    'GWjQzhiTgHNA7E4nEoYzYPTbwQBJ35h89zjYyyTepump',
    { binStepPriority: [200, 125, 100] },
    {
      getPoolInfoFn: async () => { throw new Error('not a pool address'); },
      fetchWithTimeoutFn: async () => mockResponse(true, 200, {
        data: [{
          address: 'A3TiKgaSCFracfVwZiEs1rW2oFJfTYz8KwezcXmuwc9E',
          name: 'GYATT-SOL',
          token_x: { address: 'GWjQzhiTgHNA7E4nEoYzYPTbwQBJ35h89zjYyyTepump', symbol: 'GYATT' },
          token_y: { address: WSOL, symbol: 'SOL' },
          pool_config: { bin_step: 100, base_fee_pct: 3 },
          tvl: 19264.17,
        }],
      }),
    }
  );

  assert.equal(out.ok, true);
  assert.equal(out.kind, 'TOKEN');
  assert.equal(out.poolAddress, 'A3TiKgaSCFracfVwZiEs1rW2oFJfTYz8KwezcXmuwc9E');
  assert.equal(out.poolInfo.binStep, 100);
  assert.equal(out.poolInfo.isDlmm, true);
});

test('direct dlmm search success bypasses fallback discovery fetch', async () => {
  let fallbackCalled = false;
  const out = await __resolveManualCaPoolForTests(CA, { binStepPriority: [200, 125, 100] }, {
    getPoolInfoFn: async () => { throw new Error('not a pool address'); },
    fetchWithTimeoutFn: async (url) => {
      if (String(url).includes('dlmm.datapi.meteora.ag/pools?query=')) {
        return mockResponse(true, 200, {
          data: [{
            pool_address: 'PoolDirect1111111111111111111111111111111',
            token_x: { address: CA, symbol: 'TRK' },
            token_y: { address: WSOL, symbol: 'SOL' },
            dlmm_params: { bin_step: 100 },
            tvl: 12000,
          }],
        });
      }
      fallbackCalled = true;
      return mockResponse(true, 200, { data: [] });
    },
  });
  assert.equal(out.ok, true);
  assert.equal(fallbackCalled, false);
});

test('direct search empty falls back to fresh discovery source', async () => {
  const out = await __resolveManualCaPoolForTests(CA, { binStepPriority: [200, 125, 100] }, {
    getPoolInfoFn: async () => { throw new Error('not a pool address'); },
    fetchWithTimeoutFn: async (url) => {
      if (String(url).includes('dlmm.datapi.meteora.ag/pools?query=')) {
        return mockResponse(true, 200, { data: [] });
      }
      return mockResponse(true, 200, {
        data: [{
          pool_address: 'PoolFallback11111111111111111111111111111',
          pool_type: 'dlmm',
          token_x: { address: CA, symbol: 'TRK' },
          token_y: { address: WSOL, symbol: 'SOL' },
          dlmm_params: { bin_step: 100 },
          tvl: 11111,
        }],
      });
    },
  });
  assert.equal(out.ok, true);
  assert.match(String(out.resolutionNote || ''), /fresh pool-discovery fallback/i);
});

test('multiple pools choose the SOL pair candidate with the strongest fee generation', async () => {
  const out = await __resolveManualCaPoolForTests(CA, { binStepPriority: [200, 125, 100] }, {
    getPoolInfoFn: async () => { throw new Error('not a pool address'); },
    fetchWithTimeoutFn: async () => mockResponse(true, 200, {
      data: [
        {
          pool_address: 'PoolNoSol111111111111111111111111111111111',
          token_x: { address: CA, symbol: 'TRK' },
          token_y: { address: 'OtherMint111111111111111111111111111111111', symbol: 'USDC' },
          dlmm_params: { bin_step: 200 },
          tvl: 999999,
        },
        {
          pool_address: 'PoolSolLowPrio11111111111111111111111111111',
          token_x: { address: CA, symbol: 'TRK' },
          token_y: { address: WSOL, symbol: 'SOL' },
          dlmm_params: { bin_step: 100 },
          tvl: 10000,
          volume_24h: 40000,
          fees: { '24h': 900 },
        },
        {
          pool_address: 'PoolSolHighPrio1111111111111111111111111111',
          token_x: { address: CA, symbol: 'TRK' },
          token_y: { address: WSOL, symbol: 'SOL' },
          dlmm_params: { bin_step: 200 },
          tvl: 9000,
          volume_24h: 12000,
          fees: { '24h': 100 },
        },
      ],
    }),
  });

  assert.equal(out.ok, true);
  assert.equal(out.poolAddress, 'PoolSolLowPrio11111111111111111111111111111');
  assert.deepEqual(out.candidatePoolAddresses, [
    'PoolSolLowPrio11111111111111111111111111111',
    'PoolSolHighPrio1111111111111111111111111111',
  ]);
});

test('manual CA falls back to fee/TVL ratio when fees24h is missing', async () => {
  const out = await __resolveManualCaPoolForTests(CA, { binStepPriority: [125, 100, 80] }, {
    getPoolInfoFn: async () => { throw new Error('not a pool address'); },
    fetchWithTimeoutFn: async () => mockResponse(true, 200, {
      data: [
        {
          pool_address: 'PoolFeeRatioLow1111111111111111111111111111',
          token_x: { address: CA, symbol: 'TRK' },
          token_y: { address: WSOL, symbol: 'SOL' },
          dlmm_params: { bin_step: 100 },
          tvl: 50000,
          fee_tvl_ratio: { '24h': 0.03 },
          volume_24h: 25000,
        },
        {
          pool_address: 'PoolFeeRatioHigh111111111111111111111111111',
          token_x: { address: CA, symbol: 'TRK' },
          token_y: { address: WSOL, symbol: 'SOL' },
          dlmm_params: { bin_step: 80 },
          tvl: 40000,
          fee_tvl_ratio: { '24h': 0.08 },
          volume_24h: 22000,
        },
      ],
    }),
  });

  assert.equal(out.ok, true);
  assert.equal(out.poolAddress, 'PoolFeeRatioHigh111111111111111111111111111');
});

test('candidates found but rejected include diagnostic rejection counts', async () => {
  await assert.rejects(
    __resolveManualCaPoolForTests(CA, { binStepPriority: [200, 125, 100] }, {
      getPoolInfoFn: async () => { throw new Error('not a pool address'); },
      fetchWithTimeoutFn: async () => mockResponse(true, 200, {
        data: [
          {
            pool_address: '',
            pool_type: 'dlmm',
            token_x: { address: CA, symbol: 'TRK' },
            token_y: { address: WSOL, symbol: 'SOL' },
            dlmm_params: { bin_step: 100 },
          },
          {
            pool_address: 'PoolRejectNoSol11111111111111111111111111111',
            pool_type: 'dlmm',
            token_x: { address: CA, symbol: 'TRK' },
            token_y: { address: 'OtherMint111111111111111111111111111111111', symbol: 'USDC' },
            dlmm_params: { bin_step: 100 },
          },
        ],
      }),
    }),
    (err) => {
      const msg = String(err?.message || '');
      assert.match(msg, /sources=/);
      assert.match(msg, /direct:\{found=/);
      assert.match(msg, /noSol=/);
      assert.match(msg, /noAddr=/);
      return true;
    }
  );
});
