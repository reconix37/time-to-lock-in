import assert from 'node:assert/strict';
import test from 'node:test';
import { singleFlight } from '../src/singleFlight.ts';

test('slow refresh cannot accumulate a queue, and refresh resumes after completion', async () => {
  let finish;
  let calls = 0;
  const refresh = singleFlight(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  });
  const waiting = Array.from({length:10000}, () => refresh());
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.ok(waiting.every(item => item === waiting[0]));
  finish('done');
  assert.ok((await Promise.all(waiting)).every(value => value === 'done'));
  const next = refresh();
  await Promise.resolve();
  assert.equal(calls, 2);
  finish('next');
  assert.equal(await next, 'next');
});

test('an error releases the gate for the next refresh', async () => {
  let calls = 0;
  const refresh = singleFlight(async () => {
    if (++calls === 1) throw new Error('database failure');
    return 42;
  });
  await assert.rejects(refresh(), /database failure/);
  assert.equal(await refresh(), 42);
});
