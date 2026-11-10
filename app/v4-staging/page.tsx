import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LANES, PILOTS, REQUEST_ID_PATTERN, stagingEnabled } from '../../lib/v4Staging';
import V4StagingForm from './V4StagingForm';
import { V4_STAGING_CSS } from './v4StagingStyles';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'DK v4 staging',
  robots: { index: false, follow: false, nocache: true }
};

export default function V4StagingPage() {
  if (!stagingEnabled()) notFound();
  return (
    <>
      <style>{V4_STAGING_CSS}</style>
      <V4StagingForm
        lanes={LANES.map((lane) => ({ ...lane }))}
        pilots={PILOTS.map((pilot) => ({ ...pilot }))}
        requestIdPattern={REQUEST_ID_PATTERN.source}
      />
    </>
  );
}
