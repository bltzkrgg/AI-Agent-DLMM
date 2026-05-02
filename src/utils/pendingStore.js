class PendingStore {
  constructor() {
    this.pending = new Map();
  }

  add(tokenAddress, tokenName, currentPrice, supertrendValue, poolData = null) {
    if (!this.pending.has(tokenAddress)) {
      this.pending.set(tokenAddress, {
        name: tokenName,
        lastPrice: currentPrice,
        supertrendValue: supertrendValue,
        poolData: poolData,
        retryCount: 0,
        firstSeen: Date.now()
      });
      console.log(`⏳ [PendingStore] Token ${tokenName} ditambahkan ke pending retest (Supertrend: ${supertrendValue})`);
    } else {
      const entry = this.pending.get(tokenAddress);
      entry.lastPrice = currentPrice;
      entry.retryCount++;
      if (poolData) entry.poolData = poolData;
    }
  }

  getPendingTokens() {
    return Array.from(this.pending.entries()).map(([address, data]) => ({
      address,
      name: data.name,
      lastPrice: data.lastPrice,
      supertrendValue: data.supertrendValue,
      retryCount: data.retryCount,
      poolData: data.poolData
    }));
  }

  remove(tokenAddress) {
    if (this.pending.has(tokenAddress)) {
      const { name } = this.pending.get(tokenAddress);
      this.pending.delete(tokenAddress);
      console.log(`✅ [PendingStore] Token ${name} dihapus dari pending retest`);
    }
  }

  cleanExpired(maxAgeMs = 60 * 60 * 1000) {
    const now = Date.now();
    for (const [address, data] of this.pending.entries()) {
      if (now - data.firstSeen > maxAgeMs) {
        console.log(`⏰ [PendingStore] Token ${data.name} expired, dihapus dari pending`);
        this.pending.delete(address);
      }
    }
  }
}

export default new PendingStore();
