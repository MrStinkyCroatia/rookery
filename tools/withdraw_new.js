  async withdraw(user, { chain, to, amount }) {
    if (!CHAINS[chain]) throw new Error('Unsupported network');
    if (!isAddress(to)) throw new Error('Invalid destination address');
    const amt = B(amount);
    if (amt <= 0n) throw new Error('Enter an amount');
    if (amt > LIMITS.maxWithdraw) throw new Error('Max 5,000 ZRO per withdrawal');
    if (this.meta('withdrawals_paused') === '1') throw new Error('Withdrawals are paused for maintenance');
    const day = this.sql.exec(`SELECT amount FROM transfers WHERE user_id=? AND kind='withdrawal' AND status IN ('sent','pending') AND ts>?`,
      user.id, now() - 864e5).toArray().reduce((a, r) => a + B(r.amount), 0n);
    if (day + amt > LIMITS.dailyWithdraw) throw new Error('Daily withdrawal limit is 20,000 ZRO');
    const fee = (await this.withdrawFee(chain)).wei;
    if (amt <= fee) throw new Error(`Amount must be higher than the ${Number(fee) / 1e18} ZRO network fee`);
    const send = amt - fee; // what arrives on-chain

    let tid;
    this.ctx.storage.transactionSync(() => {
      this.addBal(user.id, 'zro', -amt);
      this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,to_addr,status,note,ts) VALUES (?,?,?,?,?,?,?,?)`,
        user.id, 'withdrawal', chain, amt.toString(), getAddress(to), 'pending', `fee ${Number(fee) / 1e18} ZRO`, now());
      tid = this.sql.exec('SELECT last_insert_rowid() id').one().id;
    });
    try {
      const C = CHAINS[chain];
      const provider = new JsonRpcProvider(C.rpc, C.chainId, { staticNetwork: true });
      const hot = new Wallet(this.hotWallet().privateKey, provider);
      const zroOf = (signerOrProv) => new Contract(ZRO_TOKEN, ERC20_ABI, signerOrProv);
      const gp = await this.gasPrice(chain);

      // 1) hot wallet first, 2) otherwise any deposit address on this chain that holds enough ZRO (omnibus pool)
      let source = null, sourceUser = null;
      if ((await zroOf(provider).balanceOf(hot.address)) >= send) source = hot;
      if (!source) {
        const cands = this.sql.exec(`SELECT d.user_id, d.last, u.dep_index FROM deposit_seen d JOIN users u ON u.id=d.user_id
          WHERE d.chain=?`, chain).toArray().filter(r => B(r.last) >= send).sort((a, b) => (B(b.last) > B(a.last) ? 1 : -1)).slice(0, 5);
        for (const c of cands) {
          const w = new Wallet(this.master().deriveChild(c.dep_index).privateKey, provider);
          if ((await zroOf(provider).balanceOf(w.address)) >= send) { source = w; sourceUser = c; break; }
        }
      }
      if (!source) throw new Error(`Not enough ZRO liquidity on ${C.label} right now. Try another network.`);

      // gas for a deposit-address source comes from the hot wallet (native coin)
      if (source !== hot) {
        const need = WD_GAS * gp * 2n;
        const have = await provider.getBalance(source.address);
        if (have < need) {
          const top = need - have;
          if ((await provider.getBalance(hot.address)) < top + TOPUP_GAS * gp) throw new Error(`Withdrawals on ${C.label} are waiting for a gas top-up. Try another network.`);
          const t = await hot.sendTransaction({ to: source.address, value: top });
          await t.wait(1);
        }
      } else if ((await provider.getBalance(hot.address)) < WD_GAS * gp) {
        throw new Error(`Withdrawals on ${C.label} are waiting for a gas top-up. Try another network.`);
      }

      const tx = await zroOf(source).transfer(getAddress(to), send);
      if (sourceUser) {
        // keep deposit detection exact: this address now holds `send` less ZRO
        const nl = B(sourceUser.last) - send;
        this.sql.exec('UPDATE deposit_seen SET last=? WHERE user_id=? AND chain=?', (nl > 0n ? nl : 0n).toString(), sourceUser.user_id, chain);
      }
      this.setMeta('fee_revenue_zro', (B(this.meta('fee_revenue_zro')) + fee).toString());
      this.sql.exec(`UPDATE transfers SET status='sent', txid=? WHERE id=?`, tx.hash, tid);
      return { ok: true, txid: tx.hash, explorer: `${C.explorer}/tx/${tx.hash}`, sent: send.toString(), fee: fee.toString() };
    } catch (e) {
      // refund and mark failed — the user never loses funds on a failed send
      this.ctx.storage.transactionSync(() => {
        this.addBal(user.id, 'zro', amt);
        this.sql.exec(`UPDATE transfers SET status='failed', note=? WHERE id=?`, String(e.shortMessage || e.message).slice(0, 200), tid);
      });
      const friendly = /liquidity|gas top-up/.test(e.message || '');
      throw new Error(friendly ? e.message : 'Withdrawal could not be sent, your balance was refunded. ' + (e.shortMessage || ''));
    }
  }

