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
    const cash = await deploy('MockToken.sol', 'MockToken', ['Cash', 'CASH', facility.address, 10000n]);
    const swap = await deploy('AtomicDvPSwap.sol', 'AtomicDvPSwap', [owner.address, await mmf.getAddress(), await cash.getAddress()]);
    await (await mmf.approve(await swap.getAddress(), 10000n)).wait();
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
    await t.test('on-chain halt blocks execution', async () => { await (await swap.setHalted(true)).wait(); await assert.rejects(swap.swap.staticCall(id('new'), ...args.slice(1))); });
  } finally { provider.destroy(); await chain.disconnect(); }
});
