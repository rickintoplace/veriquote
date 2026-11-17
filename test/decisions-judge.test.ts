import { describe, expect, it } from 'vitest';
import { DecisionsJudge } from '../src/index.js';

const answer = (choice: string) =>
  new Response(JSON.stringify({ answers: { support: { choice, probabilities: { [choice]: 1 } } }, usage: { input_tokens: 10, cost: 0.000001 } }));

const item = { id: 'a', claim: 'The sky is blue.', quote: 'The sky is blue on clear days.', context: '' };

describe('DecisionsJudge', () => {
  it('moves on when a model has no host left, and stays there', async () => {
    const asked: string[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      const { model } = JSON.parse(String(init.body));
      asked.push(model);
      if (model === 'old/retired') return new Response(JSON.stringify({ error: { message: 'No endpoints found for old/retired.' } }), { status: 404 });
      return answer('entailed');
    }) as typeof globalThis.fetch;

    const judge = new DecisionsJudge({ model: ['old/retired', 'next/one'], fetch, concurrency: 1 });
    const out = await judge.judge([item, item]);

    expect(out.map((r) => r.class)).toEqual(['entailed', 'entailed']);
    expect(asked).toEqual(['old/retired', 'next/one', 'next/one']);
    expect(judge.model).toBe('next/one');
  });

  it('names the model and the reason when the last one fails', async () => {
    const fetch = (async () => new Response(JSON.stringify({ error: { message: 'No endpoints found for x/y.' } }), { status: 404 })) as typeof globalThis.fetch;
    const [r] = await new DecisionsJudge({ model: 'x/y', fetch }).judge([item]);
    expect(r.class).toBe('error');
    expect(r.reasons[0]).toContain('x/y');
    expect(r.reasons[0]).toContain('No endpoints');
  });

  it('defaults to a hosted checkpoint with a fallback from another vendor', () => {
    expect(new DecisionsJudge({ fetch: (async () => answer('entailed')) as typeof globalThis.fetch }).model).toBe('perplexity/pplx-decider-v1.2');
  });
});
