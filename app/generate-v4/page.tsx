import { notFound } from 'next/navigation';
import { LANES, PILOTS, PUBLIC_ERROR_COPY, RECIPIENT_PATTERN, REQUEST_ID_PATTERN, v4Enabled } from '../../lib/v4Staging';
import V4StagingForm from '../v4-staging/V4StagingForm';
import { V4_STAGING_CSS } from '../v4-staging/v4StagingStyles';

export const dynamic = 'force-dynamic';

/**
 * The public v4 form. middleware.ts serves it at /generate when v4 is enabled (DK_V4_STAGING_URL and
 * DK_V4_STAGING_TOKEN both set, Production or Preview); otherwise /generate is the unchanged v3 page and
 * this route is a 404.
 */
export default function GenerateV4Page() {
  if (!v4Enabled()) notFound();
  return (
    <>
      <style>{V4_STAGING_CSS}</style>
      <V4StagingForm
        errorCopy={{ ...PUBLIC_ERROR_COPY }}
        // No budget figures in the public page payload: the public form never uses a lane's cap.
        lanes={LANES.map((lane) => ({ ...lane, capUsd: '' }))}
        pilots={PILOTS.map((pilot) => ({ ...pilot }))}
        recipientPattern={RECIPIENT_PATTERN.source}
        requestIdPattern={REQUEST_ID_PATTERN.source}
        variant="public"
      />
    </>
  );
}
