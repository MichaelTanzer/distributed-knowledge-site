import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import V4StagingForm from '../app/v4-staging/V4StagingForm';
import { LANES, PUBLIC_ERROR_COPY, RECIPIENT_PATTERN, REQUEST_ID_PATTERN, pilotsWithDescriptions } from '../lib/v4Staging';

/** First render (before the config answer): the config is unavailable, so the fallback rules apply. */
function render(variant: 'public' | 'operator'): string {
  return renderToStaticMarkup(
    <V4StagingForm
      errorCopy={variant === 'public' ? { ...PUBLIC_ERROR_COPY } : undefined}
      lanes={LANES.map((lane) => ({ ...lane, capUsd: variant === 'public' ? '' : lane.capUsd }))}
      pilots={pilotsWithDescriptions()}
      recipientPattern={RECIPIENT_PATTERN.source}
      requestIdPattern={REQUEST_ID_PATTERN.source}
      variant={variant}
    />
  );
}

function selectHtml(html: string, id: string): string {
  const match = new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
  assert.ok(match, `select #${id} rendered`);
  return match[0];
}

function optionValues(select: string): string[] {
  return [...select.matchAll(/<option[^>]*value="([^"]*)"/g)].map((match) => match[1] ?? '');
}

describe('v4 form, first render (config not loaded yet)', () => {
  it("public: offers today's three providers and not Anthropic", () => {
    const providers = selectHtml(render('public'), 'v4s-lane');
    assert.deepEqual(optionValues(providers), ['', 'openai', 'google', 'xai']);
    assert.equal(providers.includes('Anthropic'), false);
    assert.equal(providers.includes('disabled'), false);
  });

  it('operator: shows the three lane radios and not Anthropic', () => {
    const html = render('operator');
    const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*value="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(radios, ['openai', 'google', 'xai']);
    assert.equal(html.includes('value="anthropic"'), false);
  });

  for (const variant of ['public', 'operator'] as const) {
    it(`${variant}: the KIQ select is described by the case description region`, () => {
      const html = render(variant);
      const kiq = selectHtml(html, 'v4s-pilot');
      assert.match(kiq, /aria-describedby="v4s-pilot-description"/);
      assert.deepEqual(optionValues(kiq), ['', 'SL-002', 'SL-028', 'SL-035']);
      const region = /<div[^>]*id="v4s-pilot-description"[^>]*>([\s\S]*?)<\/div>/.exec(html);
      assert.ok(region, 'description region rendered');
      assert.match(region[0], /aria-live="polite"/);
      // No case selected yet: the region is empty, and it sits outside the <label> so it never joins the select's name.
      assert.equal(region[1], '');
      const label = /<label[^>]*for="v4s-pilot"[^>]*>[\s\S]*?<\/label>/.exec(html);
      assert.ok(label);
      assert.equal(label[0].includes('id="v4s-pilot-description"'), false);
    });
  }

  it('public: keeps the technical-trial notice', () => {
    assert.match(render('public'), /DK v4 technical preview: packets are technical-trial output/);
  });
});
