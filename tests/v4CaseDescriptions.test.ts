import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CASE_DESCRIPTIONS, PILOTS, pilotsWithDescriptions } from '../lib/v4Staging';

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const sentences = (text: string) => text.trim().split(/(?<=[.?!])\s+/).filter(Boolean).length;

describe('case descriptions under the KIQ drop-down', () => {
  it('has exactly one entry per case, for the three cases', () => {
    assert.deepEqual(Object.keys(CASE_DESCRIPTIONS).sort(), ['SL-002', 'SL-028', 'SL-035']);
    assert.deepEqual(PILOTS.map((pilot) => pilot.value).sort(), Object.keys(CASE_DESCRIPTIONS).sort());
  });

  for (const [pilot, description] of Object.entries(CASE_DESCRIPTIONS)) {
    it(`${pilot}: a short title and one or two sentences of at most 35 words`, () => {
      assert.ok(description.title.trim().length > 0);
      assert.ok(words(description.title) <= 6, `title has ${words(description.title)} words`);
      assert.ok(words(description.summary) <= 35, `summary has ${words(description.summary)} words`);
      const count = sentences(description.summary);
      assert.ok(count >= 1 && count <= 2, `summary has ${count} sentences`);
      assert.equal(description.title, description.title.trim());
      assert.equal(description.summary, description.summary.trim());
    });

    it(`${pilot}: plain public text (no markup, money or answer-key vocabulary)`, () => {
      const text = `${description.title} ${description.summary}`;
      assert.doesNotMatch(text, /[<>$]/);
      assert.doesNotMatch(text, /\b(answer|culprit|sponsor|mechanism|candidate|scor(e|ing)|reviewer|hidden|restricted|ground truth)\b/i);
    });
  }

  it('reaches the form through the pilots prop', () => {
    for (const pilot of pilotsWithDescriptions()) {
      assert.deepEqual(pilot.description, CASE_DESCRIPTIONS[pilot.value]);
    }
  });
});
