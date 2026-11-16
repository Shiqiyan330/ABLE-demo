import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import solc from 'solc';
import { BrowserProvider, ContractFactory, id } from 'ethers';

test('atomic swap enforces access, expiry, minimum output, rollback, replay and halt', async t => {
  const chain = ganache.provider({ logging: { quiet: true }, chain: { chainId: 31337 } });
  const provider = new BrowserProvider(chain); provider.pollingInterval = 100;
  try {
    const owner = await provider.getSigner(0), facility = await provider.getSigner(1), outsider = await provider.getSigner(2);
    const sources = Object.fromEntries(['MockToken.sol', 'AtomicDvPSwap.sol'].map(file => [file, { content: readFileSync(new URL(`../contracts/${file}`, import.meta.url), 'utf8') }]));
    const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: { evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
    async function deploy(file, name, args) { const artifact = compiled.contracts[file][name]; const c = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, owner).deploy(...args); await c.waitForDeployment(); return c; }
    const mmf = await deploy('MockToken.sol', 'MockToken', ['MMF', 'MMF', owner.address, 10000n]);
    const govBond = await deploy('MockToken.sol', 'MockToken', ['Government Bond', 'tGOVBOND', owner.address, 10000n]);
    const corpBond = await deploy('MockToken.sol', 'MockToken', ['Corporate Bond', 'tCORPBOND', owner.address, 10000n]);
    const stablecoin = await deploy('MockToken.sol', 'MockToken', ['USD Stablecoin', 'USDC', owner.address, 10000n]);
    const cash = await deploy('MockToken.sol', 'MockToken', ['Cash', 'CASH', facility.address, 10000n]);
    const swap = await deploy('AtomicDvPSwap.sol', 'AtomicDvPSwap', [owner.address, await mmf.getAddress(), await govBond.getAddress(), await corpBond.getAddress(), await stablecoin.getAddress(), await cash.getAddress()]);
    await (await mmf.approve(await swap.getAddress(), 10000n)).wait();
    await (await govBond.approve(await swap.getAddress(), 10000n)).wait();
    await (await corpBond.approve(await swap.getAddress(), 10000n)).wait();
    await (await stablecoin.approve(await swap.getAddress(), 10000n)).wait();
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const args = [id('request'), facility.address, 1000n, 950n, 950n, deadline];
    await t.test('unauthorized executor is rejected', async () => assert.rejects(swap.connect(outsider).swap.staticCall(...args)));
    await t.test('expired quote and insufficient output are rejected', async () => { await assert.rejects(swap.swap.staticCall(...args.slice(0, 5), 1)); await assert.rejects(swap.swap.staticCall(...args.slice(0, 4), 951n, deadline)); });
    await t.test('failed second leg restores first leg and request marker', async () => {
      const tx = await swap.swap(...args, { gasLimit: 500000 }); await assert.rejects(tx.wait());
      assert.equal(await mmf.balanceOf(owner.address), 10000n); assert.equal(await mmf.balanceOf(facility.address), 0n);
      assert.equal(await cash.balanceOf(owner.address), 0n); assert.equal(await swap.settledRequest(args[0]), false); assert.equal(await swap.nonce(), 0n);
    });
    await (await cash.connect(facility).approve(await swap.getAddress(), 10000n)).wait();
    await t.test('both legs settle and emit SwapExecuted', async () => {
      const receipt = await (await swap.swap(...args)).wait();
      assert.equal(await mmf.balanceOf(owner.address), 9000n); assert.equal(await cash.balanceOf(owner.address), 950n);
      assert.ok(receipt.logs.some(log => { try { return swap.interface.parseLog(log)?.name === 'SwapExecuted'; } catch { return false; } }));
    });
    await t.test('settled request cannot replay', async () => assert.rejects(swap.swap.staticCall(...args)));
    await t.test('stablecoin failure rolls back input, nonce and request marker', async () => {
      const requestId = id('stable-rollback'), inputBefore = await stablecoin.balanceOf(owner.address), nonceBefore = await swap.nonce();
      await (await cash.connect(facility).approve(await swap.getAddress(), 0n)).wait();
      const tx = await swap.swapAsset(requestId, await stablecoin.getAddress(), facility.address, 100n, 700n, 700n, deadline, { gasLimit: 500000 });
      await assert.rejects(tx.wait());
      assert.equal(await stablecoin.balanceOf(owner.address), inputBefore);
      assert.equal(await stablecoin.balanceOf(facility.address), 0n);
      assert.equal(await swap.settledRequest(requestId), false); assert.equal(await swap.nonce(), nonceBefore);
      await (await cash.connect(facility).approve(await swap.getAddress(), 10000n)).wait();
      const stableArgs = [requestId, await stablecoin.getAddress(), facility.address, 100n, 700n, 700n, deadline];
      await assert.rejects(swap.connect(outsider).swapAsset.staticCall(...stableArgs));
      await assert.rejects(swap.swapAsset.staticCall(...stableArgs.slice(0, 6), 1));
      await assert.rejects(swap.swapAsset.staticCall(...stableArgs.slice(0, 5), 701n, deadline));
    });
    await t.test('bonds and stablecoin exchange atomically for wCBDC', async () => {
      const govRequest = id('government-bond-request'), corpRequest = id('corporate-bond-request');
      const govReceipt = await (await swap.swapAsset(govRequest, await govBond.getAddress(), facility.address, 100n, 95n, 90n, deadline)).wait();
      const corpReceipt = await (await swap.swapAsset(corpRequest, await corpBond.getAddress(), facility.address, 200n, 190n, 180n, deadline)).wait();
      const stableReceipt = await (await swap.swapAsset(id('stablecoin-request'), await stablecoin.getAddress(), facility.address, 300n, 285n, 280n, deadline)).wait();
      assert.equal(await govBond.balanceOf(facility.address), 100n);
      assert.equal(await corpBond.balanceOf(facility.address), 200n);
      assert.equal(await stablecoin.balanceOf(facility.address), 300n); assert.equal(await cash.balanceOf(owner.address), 1520n);
      assert.ok(govReceipt.logs.some(log => { try { return swap.interface.parseLog(log)?.name === 'AssetSwapExecuted'; } catch { return false; } }));
      assert.ok(corpReceipt.logs.some(log => { try { return swap.interface.parseLog(log)?.name === 'AssetSwapExecuted'; } catch { return false; } }));
      assert.ok(stableReceipt.logs.some(log => { try { return swap.interface.parseLog(log)?.name === 'AssetSwapExecuted'; } catch { return false; } }));
      await assert.rejects(swap.swapAsset.staticCall(id('stablecoin-request'), await stablecoin.getAddress(), facility.address, 300n, 285n, 280n, deadline));
      await assert.rejects(swap.swapAsset.staticCall(id('unknown-asset'), await mmf.getAddress(), facility.address, 1n, 1n, 1n, deadline));
    });
    await t.test('on-chain halt blocks execution', async () => { await (await swap.setHalted(true)).wait(); await assert.rejects(swap.swap.staticCall(id('new'), ...args.slice(1))); });
  } finally { provider.destroy(); await chain.disconnect(); }
});
