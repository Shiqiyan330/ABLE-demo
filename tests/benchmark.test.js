import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWorkload, runBenchmark } from '../benchmark.js';

test('workloads are reproducible and paired systems receive the same obligations', () => {
  const first = generateWorkload(42, 'ordinary', 20);
  const second = generateWorkload(42, 'ordinary', 20);
  assert.deepEqual(first, second);
  assert.equal(first.requests.length, 20);
  assert.equal(first.exceptions.length, 5);
  assert.ok(first.requests.every(request => request.arrivalHour >= 0 && request.deadlineHour === request.arrivalHour + 2));
});

test('off-hours workload concentrates all requests in the first five days outside RTGS hours', () => {
  const workload = generateWorkload(2026, 'off_hours', 100);
  assert.ok(workload.requests.every(request => request.arrivalHour < 5 * 24));
  assert.ok(workload.requests.every(request => request.arrivalHour % 24 < 9 || request.arrivalHour % 24 >= 18));
});

test('benchmark emits all allocation and scenario cells with paired decision metrics', () => {
  const report = runBenchmark({ repetitions: 1, requestCount: 10 });
  assert.equal(report.cells.length, 12);
  assert.ok(report.cells.every(cell => cell.runs.length === 1 && cell.runs[0].able && cell.runs[0].legacy));
  assert.ok(report.cells.every(cell => cell.runs[0].able.unauthorizedMovements === 0));
  assert.equal(report.assumptions.repetitions, 1);
  assert.equal(report.assumptions.requestCount, 10);
});
