import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LANES, PILOTS, RECIPIENT_PATTERN, REQUEST_ID_PATTERN, stagingPageEnabled } from '../../lib/v4Staging';
import V4StagingForm from './V4StagingForm';
import { V4_STAGING_CSS } from './v4StagingStyles';

export const dynamic = 'force-dynamic';

/** Staging metadata only when the page is enabled, so the disabled 404 carries no staging title. */
export function generateMetadata(): Metadata {
  if (!stagingPageEnabled()) return {};
  return { title: 'DK v4 staging', robots: { index: false, follow: false, nocache: true } };
}

export default function V4StagingPage() {
  // Operator page: Vercel Preview only (and v4 configured).
  if (!stagingPageEnabled()) notFound();
  return (
    <>
      <style>{V4_STAGING_CSS}</style>
      <V4StagingForm
        lanes={LANES.map((lane) => ({ ...lane }))}
        pilots={PILOTS.map((pilot) => ({ ...pilot }))}
        recipientPattern={RECIPIENT_PATTERN.source}
        requestIdPattern={REQUEST_ID_PATTERN.source}
        variant="operator"
      />
    </>
  );
}
