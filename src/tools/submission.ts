/**
 * Tools for submitting an app to App Review and driving its release.
 *
 * Two generations of the submission API exist. The old one
 * (`appStoreVersionSubmissions`) is deprecated and only ever submits a single
 * version; everything here uses the modern `reviewSubmissions` flow, which
 * bundles several items (a version, a custom product page, an app event, ...)
 * into one submission:
 *
 *   POST   /v1/reviewSubmissions               create the (empty) submission
 *   POST   /v1/reviewSubmissionItems           attach items to it
 *   PATCH  /v1/reviewSubmissions/{id}          { submitted: true }  -> send to Apple
 *                                              { canceled: true }   -> withdraw
 *   GET    /v1/reviewSubmissions?filter[app]   list existing submissions
 *
 * Several tools here are irreversible or highly visible to end users (sending
 * a build to Apple, publishing on the App Store). Those require an explicit
 * `confirm: true` argument so they cannot be triggered as a side effect of a
 * vague instruction.
 */

import { defineTool, type Tool } from './types.js';
import { AppStoreApiError, type AppStoreClient } from '../appstore-client.js';

// ---------------------------------------------------------------------------
// Enums and reference data
// ---------------------------------------------------------------------------

/**
 * `appStoreVersion.appStoreState` values, roughly in lifecycle order.
 * Only the first group is editable / submittable.
 */
const EDITABLE_VERSION_STATES = [
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
] as const;

/** States meaning the version already sits somewhere in Apple's review queue. */
const IN_FLIGHT_VERSION_STATES = [
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'PENDING_APPLE_RELEASE',
  'PENDING_DEVELOPER_RELEASE',
  'PROCESSING_FOR_APP_STORE',
  'READY_FOR_REVIEW',
] as const;

const VERSION_STATE_HELP: Record<string, string> = {
  PREPARE_FOR_SUBMISSION: 'editable, not submitted yet',
  READY_FOR_REVIEW: 'attached to a submission that has not been sent yet',
  WAITING_FOR_REVIEW: 'submitted, queued at Apple',
  IN_REVIEW: 'a reviewer is looking at it right now',
  PENDING_DEVELOPER_RELEASE: 'approved — waiting for you to press Release',
  PENDING_APPLE_RELEASE: 'approved — Apple will publish it',
  PROCESSING_FOR_APP_STORE: 'being published',
  READY_FOR_SALE: 'live on the App Store',
  REJECTED: 'rejected by App Review',
  METADATA_REJECTED: 'rejected for metadata only — no new build needed',
  DEVELOPER_REJECTED: 'you withdrew it from review',
  DEVELOPER_REMOVED_FROM_SALE: 'removed from sale by you',
  REMOVED_FROM_SALE: 'removed from sale',
  INVALID_BINARY: 'the attached build was rejected as invalid',
  REPLACED_WITH_NEW_VERSION: 'superseded by a newer version',
  ACCEPTED: 'accepted by App Review',
  IN_APP_REVIEW: 'in review',
  WAITING_FOR_EXPORT_COMPLIANCE: 'blocked on export compliance answers',
  NOT_APPLICABLE: 'not applicable',
};

/** `reviewSubmission.state` values. */
const REVIEW_SUBMISSION_STATES = [
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'UNRESOLVED_ISSUES',
  'CANCELING',
  'COMPLETING',
  'COMPLETE',
] as const;

const SUBMISSION_STATE_HELP: Record<string, string> = {
  READY_FOR_REVIEW: 'draft — items attached but not sent to Apple yet',
  WAITING_FOR_REVIEW: 'sent, queued at Apple',
  IN_REVIEW: 'being reviewed right now',
  UNRESOLVED_ISSUES: 'Apple raised issues that need a reply',
  CANCELING: 'cancellation in progress',
  COMPLETING: 'finishing up',
  COMPLETE: 'closed',
};

/** A submission in one of these states can no longer be edited or resubmitted. */
const CLOSED_SUBMISSION_STATES = ['COMPLETE', 'CANCELING', 'COMPLETING'];

/** States a submission can only reach once it has been sent to Apple. */
const SENT_SUBMISSION_STATES = [
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'UNRESOLVED_ISSUES',
  'CANCELING',
  'COMPLETING',
  'COMPLETE',
];

const PHASED_RELEASE_STATES = ['INACTIVE', 'ACTIVE', 'PAUSED', 'COMPLETE'] as const;

/**
 * Share of the user base reached on each day of a phased release.
 * Apple's schedule is fixed: 7 days, 1/2/5/10/20/50/100 %.
 */
const PHASED_RELEASE_DAY_PERCENTAGES = [1, 2, 5, 10, 20, 50, 100];

const REVIEW_ITEM_TYPES = [
  'appStoreVersion',
  'appCustomProductPage',
  'appEvent',
  'appStoreVersionExperiment',
  'appStoreVersionExperimentV2',
] as const;

type ReviewItemType = (typeof REVIEW_ITEM_TYPES)[number];

/** JSON:API `type` to use in a reviewSubmissionItem relationship. */
const REVIEW_ITEM_RELATIONSHIP_TYPE: Record<ReviewItemType, string> = {
  appStoreVersion: 'appStoreVersions',
  appCustomProductPage: 'appCustomProductPageVersions',
  appEvent: 'appEvents',
  appStoreVersionExperiment: 'appStoreVersionExperiments',
  appStoreVersionExperimentV2: 'appStoreVersionExperimentsV2',
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function describeVersionState(state: string | undefined): string {
  if (!state) return 'unknown';
  const help = VERSION_STATE_HELP[state];
  return help ? `${state} (${help})` : state;
}

function describeSubmissionState(state: string | undefined): string {
  if (!state) return 'unknown';
  const help = SUBMISSION_STATE_HELP[state];
  return help ? `${state} (${help})` : state;
}

interface VersionSummary {
  id: string;
  versionString: string;
  platform: string;
  appStoreState: string;
  releaseType?: string;
  earliestReleaseDate?: string;
  appId?: string;
}

async function fetchVersion(client: AppStoreClient, versionId: string): Promise<VersionSummary> {
  const response = await client.get(`/v1/appStoreVersions/${versionId}`);
  const version = response?.data;

  if (!version) {
    throw new Error(`No app store version found with ID ${versionId}.`);
  }

  return {
    id: version.id,
    versionString: version.attributes?.versionString,
    platform: version.attributes?.platform,
    appStoreState: version.attributes?.appStoreState,
    releaseType: version.attributes?.releaseType,
    earliestReleaseDate: version.attributes?.earliestReleaseDate,
    appId: version.relationships?.app?.data?.id,
  };
}

/**
 * Resolve the app ID a version belongs to. The `relationships` block is not
 * always populated, so fall back to the dedicated relationship endpoint.
 */
async function resolveAppId(client: AppStoreClient, version: VersionSummary): Promise<string> {
  if (version.appId) return version.appId;

  const response = await client.get(`/v1/appStoreVersions/${version.id}/relationships/app`);
  const appId = response?.data?.id;

  if (!appId) {
    throw new Error(`Could not determine which app version ${version.id} belongs to.`);
  }

  return appId;
}

/** Throw a readable error when a version is in a state Apple will not accept. */
function assertVersionSubmittable(version: VersionSummary): void {
  const state = version.appStoreState;

  if ((EDITABLE_VERSION_STATES as readonly string[]).includes(state)) return;

  if ((IN_FLIGHT_VERSION_STATES as readonly string[]).includes(state)) {
    throw new Error(
      `Version ${version.versionString} is already ${describeVersionState(state)}. ` +
        `It cannot be submitted again. Cancel the pending review submission first ` +
        `(cancel_review_submission), or use release_app_store_version if it is approved.`
    );
  }

  throw new Error(
    `Version ${version.versionString} is ${describeVersionState(state)} and cannot be ` +
      `submitted for review. A submittable version is in one of: ${EDITABLE_VERSION_STATES.join(', ')}.`
  );
}

interface SubmissionSummary {
  id: string;
  state: string;
  platform?: string;
  submitted?: boolean;
  submittedDate?: string;
}

function toSubmissionSummary(raw: any): SubmissionSummary {
  const attributes = raw?.attributes ?? {};

  // `submitted` is a write-only attribute: it is accepted in a PATCH body but
  // never returned by Apple. Reading it gave `undefined` on every submission,
  // so an IN_REVIEW or COMPLETE submission was rendered as "draft". Derive the
  // fact from what Apple does return: `submittedDate`, or a state that can only
  // be reached after the submission left the developer's hands.
  const submitted =
    typeof attributes.submitted === 'boolean'
      ? attributes.submitted
      : Boolean(attributes.submittedDate) || SENT_SUBMISSION_STATES.includes(attributes.state);

  return {
    id: raw.id,
    state: attributes.state,
    platform: attributes.platform,
    submitted,
    submittedDate: attributes.submittedDate,
  };
}

async function listSubmissions(
  client: AppStoreClient,
  appId: string,
  state?: string
): Promise<SubmissionSummary[]> {
  const query: Record<string, string> = { 'filter[app]': appId };
  if (state) query['filter[state]'] = state;

  const { data } = await client.getAllPages('/v1/reviewSubmissions', { query });
  return data.map(toSubmissionSummary);
}

/** The open (not yet closed) submissions for an app, most useful first. */
async function findOpenSubmissions(
  client: AppStoreClient,
  appId: string
): Promise<SubmissionSummary[]> {
  const submissions = await listSubmissions(client, appId);
  return submissions.filter((s) => !CLOSED_SUBMISSION_STATES.includes(s.state));
}

function requireConfirmation(confirm: boolean | undefined, action: string): void {
  if (confirm === true) return;
  throw new Error(
    `Refused: ${action} is irreversible. Call this tool again with confirm: true once the ` +
      `user has explicitly asked for it.`
  );
}

function formatDate(value: string | undefined): string {
  if (!value) return 'n/a';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// ---------------------------------------------------------------------------
// 1. Review submissions
// ---------------------------------------------------------------------------

export const listReviewSubmissions = defineTool<{ appId: string; state?: string }>({
  name: 'list_review_submissions',
  description:
    'List App Review submissions for an app (modern reviewSubmissions API), optionally filtered by state. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'The ID of the app' },
      state: {
        type: 'string',
        description: 'Only return submissions in this state (optional)',
        enum: [...REVIEW_SUBMISSION_STATES],
      },
    },
    required: ['appId'],
  },
  handler: async ({ appId, state }, client) => {
    const submissions = await listSubmissions(client, appId, state);

    if (submissions.length === 0) {
      return state
        ? `No review submissions in state ${state} for app ${appId}.`
        : `No review submissions found for app ${appId}.`;
    }

    return `📤 Review submissions for app ${appId}:

${submissions
  .map(
    (submission, index) =>
      `${index + 1}. ${describeSubmissionState(submission.state)}
   • Submission ID: ${submission.id}
   • Platform: ${submission.platform || 'unknown'}
   • Sent to Apple: ${submission.submitted ? `yes (${formatDate(submission.submittedDate)})` : 'no'}`
  )
  .join('\n\n')}`;
  },
});

export const createReviewSubmission = defineTool<{ appId: string; platform: string }>({
  name: 'create_review_submission',
  description:
    'Create an empty App Review submission for an app. Nothing is sent to Apple until items are attached and submit_review_submission is called.',
  inputSchema: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'The ID of the app' },
      platform: {
        type: 'string',
        description: 'Platform of the submission',
        enum: ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'],
      },
    },
    required: ['appId', 'platform'],
  },
  handler: async ({ appId, platform }, client) => {
    const existing = await findOpenSubmissions(client, appId);
    if (existing.length > 0) {
      const open = existing[0];
      throw new Error(
        `App ${appId} already has an open review submission (${open.id}, ${describeSubmissionState(
          open.state
        )}). Attach your items to it with add_review_submission_item, or cancel it first.`
      );
    }

    const response = await client.post('/v1/reviewSubmissions', {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    });

    const submission = toSubmissionSummary(response.data);

    return `✅ Review submission created (nothing sent to Apple yet):
• Submission ID: ${submission.id}
• Platform: ${submission.platform}
• State: ${describeSubmissionState(submission.state)}

Next: add_review_submission_item, then submit_review_submission.`;
  },
});

export const addReviewSubmissionItem = defineTool<{
  submissionId: string;
  itemType: ReviewItemType;
  itemId: string;
}>({
  name: 'add_review_submission_item',
  description:
    'Attach an item (app store version, custom product page, app event, experiment) to an existing App Review submission.',
  inputSchema: {
    type: 'object',
    properties: {
      submissionId: { type: 'string', description: 'The ID of the review submission' },
      itemType: {
        type: 'string',
        description: 'Kind of item to attach',
        enum: [...REVIEW_ITEM_TYPES],
      },
      itemId: {
        type: 'string',
        description: 'ID of the resource to attach (e.g. the app store version ID)',
      },
    },
    required: ['submissionId', 'itemType', 'itemId'],
  },
  handler: async ({ submissionId, itemType, itemId }, client) => {
    const relationshipType = REVIEW_ITEM_RELATIONSHIP_TYPE[itemType];
    if (!relationshipType) {
      throw new Error(`Unsupported item type "${itemType}".`);
    }

    const response = await client.post('/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
          [itemType]: { data: { type: relationshipType, id: itemId } },
        },
      },
    });

    return `✅ Item attached to review submission ${submissionId}:
• Item type: ${itemType}
• Item ID: ${itemId}
• Submission item ID: ${response?.data?.id ?? 'unknown'}

The submission is still a draft — call submit_review_submission to send it to Apple.`;
  },
});

export const removeReviewSubmissionItem = defineTool<{ itemId: string }>({
  name: 'remove_review_submission_item',
  description:
    'Detach an item from a draft App Review submission. Only works while the submission has not been sent to Apple.',
  inputSchema: {
    type: 'object',
    properties: {
      itemId: {
        type: 'string',
        description: 'The reviewSubmissionItem ID (not the version ID)',
      },
    },
    required: ['itemId'],
  },
  handler: async ({ itemId }, client) => {
    await client.delete(`/v1/reviewSubmissionItems/${itemId}`);
    return `✅ Removed submission item ${itemId} from its review submission.`;
  },
});

export const submitReviewSubmission = defineTool<{ submissionId: string; confirm?: boolean }>({
  name: 'submit_review_submission',
  description:
    'HIGH IMPACT, IRREVERSIBLE: send an existing review submission to Apple App Review. Requires confirm: true. Only call after the user explicitly asks to submit.',
  inputSchema: {
    type: 'object',
    properties: {
      submissionId: { type: 'string', description: 'The ID of the review submission to send' },
      confirm: {
        type: 'boolean',
        description: 'Must be true. Guard against accidental submission to Apple.',
      },
    },
    required: ['submissionId', 'confirm'],
  },
  handler: async ({ submissionId, confirm }, client) => {
    requireConfirmation(confirm, 'submitting to Apple App Review');

    const current = await client.get(`/v1/reviewSubmissions/${submissionId}`);
    const state = current?.data?.attributes?.state;

    if (current?.data?.attributes?.submitted === true) {
      throw new Error(
        `Review submission ${submissionId} has already been sent to Apple ` +
          `(${describeSubmissionState(state)}). Use cancel_review_submission to withdraw it.`
      );
    }

    const response = await client.patch(`/v1/reviewSubmissions/${submissionId}`, {
      data: {
        type: 'reviewSubmissions',
        id: submissionId,
        attributes: { submitted: true },
      },
    });

    const submission = toSubmissionSummary(response.data);

    return `🚀 Submission ${submission.id} sent to Apple App Review.
• State: ${describeSubmissionState(submission.state)}
• Submitted: ${formatDate(submission.submittedDate)}

Track it with get_app_release_status or list_review_submissions.`;
  },
});

export const cancelReviewSubmission = defineTool<{ submissionId: string; confirm?: boolean }>({
  name: 'cancel_review_submission',
  description:
    'HIGH IMPACT: withdraw a submission from App Review (the "Remove from review" button). Requires confirm: true. Loses the queue position.',
  inputSchema: {
    type: 'object',
    properties: {
      submissionId: { type: 'string', description: 'The ID of the review submission to cancel' },
      confirm: {
        type: 'boolean',
        description: 'Must be true. Guard against accidentally pulling an app out of review.',
      },
    },
    required: ['submissionId', 'confirm'],
  },
  handler: async ({ submissionId, confirm }, client) => {
    requireConfirmation(confirm, 'withdrawing a submission from App Review');

    const current = await client.get(`/v1/reviewSubmissions/${submissionId}`);
    const state = current?.data?.attributes?.state;

    if (state && CLOSED_SUBMISSION_STATES.includes(state)) {
      throw new Error(
        `Review submission ${submissionId} is ${describeSubmissionState(state)} and can no longer be canceled.`
      );
    }

    const response = await client.patch(`/v1/reviewSubmissions/${submissionId}`, {
      data: {
        type: 'reviewSubmissions',
        id: submissionId,
        attributes: { canceled: true },
      },
    });

    const submission = toSubmissionSummary(response.data);

    return `↩️ Submission ${submission.id} withdrawn from App Review.
• State: ${describeSubmissionState(submission.state)}

The version goes back to an editable state; you will have to submit again and requeue.`;
  },
});

export const submitAppStoreVersionForReview = defineTool<{
  versionId: string;
  confirm?: boolean;
  reuseOpenSubmission?: boolean;
}>({
  name: 'submit_app_store_version_for_review',
  description:
    'HIGH IMPACT, IRREVERSIBLE: full one-shot submission of an app store version — creates the review submission, attaches the version and sends it to Apple. Requires confirm: true. Only call after the user explicitly asks to submit for review.',
  inputSchema: {
    type: 'object',
    properties: {
      versionId: { type: 'string', description: 'The ID of the app store version to submit' },
      confirm: {
        type: 'boolean',
        description: 'Must be true. Guard against accidental submission to Apple.',
      },
      reuseOpenSubmission: {
        type: 'boolean',
        description:
          'Attach to an existing draft submission instead of failing when one is already open (default false)',
      },
    },
    required: ['versionId', 'confirm'],
  },
  handler: async ({ versionId, confirm, reuseOpenSubmission }, client) => {
    requireConfirmation(confirm, 'submitting a version to Apple App Review');

    const version = await fetchVersion(client, versionId);
    assertVersionSubmittable(version);

    const appId = await resolveAppId(client, version);
    const steps: string[] = [];

    // 1. Reuse a draft submission if allowed, otherwise create a fresh one.
    const open = await findOpenSubmissions(client, appId);
    const draft = open.find((s) => s.state === 'READY_FOR_REVIEW');
    const alreadySent = open.find((s) => s.state !== 'READY_FOR_REVIEW');

    if (alreadySent) {
      throw new Error(
        `App ${appId} already has a submission at Apple (${alreadySent.id}, ` +
          `${describeSubmissionState(alreadySent.state)}). Cancel it before submitting again.`
      );
    }

    let submissionId: string;

    if (draft && reuseOpenSubmission) {
      submissionId = draft.id;
      steps.push(`Reused existing draft submission ${submissionId}.`);
    } else if (draft) {
      throw new Error(
        `App ${appId} already has a draft review submission (${draft.id}). Re-run with ` +
          `reuseOpenSubmission: true to attach the version to it, or cancel it first.`
      );
    } else {
      const created = await client.post('/v1/reviewSubmissions', {
        data: {
          type: 'reviewSubmissions',
          attributes: { platform: version.platform },
          relationships: { app: { data: { type: 'apps', id: appId } } },
        },
      });
      submissionId = created.data.id;
      steps.push(`Created review submission ${submissionId}.`);
    }

    // 2. Attach the version. A duplicate attachment is not fatal — carry on.
    try {
      await client.post('/v1/reviewSubmissionItems', {
        data: {
          type: 'reviewSubmissionItems',
          relationships: {
            reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
            appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
          },
        },
      });
      steps.push(`Attached version ${version.versionString} (${versionId}).`);
    } catch (error) {
      const alreadyAttached =
        error instanceof AppStoreApiError &&
        (error.httpStatus === 409 || /already/i.test(error.message));

      if (!alreadyAttached) throw error;
      steps.push(`Version ${version.versionString} was already attached.`);
    }

    // 3. Send it.
    const submitted = await client.patch(`/v1/reviewSubmissions/${submissionId}`, {
      data: {
        type: 'reviewSubmissions',
        id: submissionId,
        attributes: { submitted: true },
      },
    });
    const summary = toSubmissionSummary(submitted.data);
    steps.push('Sent to Apple App Review.');

    return `🚀 Version ${version.versionString} submitted for review.

${steps.map((step) => `• ${step}`).join('\n')}

• Submission ID: ${summary.id}
• State: ${describeSubmissionState(summary.state)}
• Submitted: ${formatDate(summary.submittedDate)}

This cannot be undone except by withdrawing the submission (cancel_review_submission).`;
  },
});

// ---------------------------------------------------------------------------
// 2. Phased release
// ---------------------------------------------------------------------------

interface PhasedReleaseSummary {
  id: string;
  phasedReleaseState: string;
  startDate?: string;
  totalPauseDuration?: number;
  currentDayNumber?: number;
}

function toPhasedReleaseSummary(raw: any): PhasedReleaseSummary {
  return {
    id: raw.id,
    phasedReleaseState: raw.attributes?.phasedReleaseState,
    startDate: raw.attributes?.startDate,
    totalPauseDuration: raw.attributes?.totalPauseDuration,
    currentDayNumber: raw.attributes?.currentDayNumber,
  };
}

function formatPhasedRelease(phased: PhasedReleaseSummary): string {
  const day = phased.currentDayNumber;
  const percentage =
    typeof day === 'number' && day >= 1 && day <= PHASED_RELEASE_DAY_PERCENTAGES.length
      ? `${PHASED_RELEASE_DAY_PERCENTAGES[day - 1]}% of users`
      : 'not started';

  return `• Phased release ID: ${phased.id}
• State: ${phased.phasedReleaseState}
• Day: ${typeof day === 'number' ? `${day} of 7` : 'n/a'} → ${percentage}
• Started: ${formatDate(phased.startDate)}${
    phased.totalPauseDuration ? `\n• Paused for: ${phased.totalPauseDuration} day(s)` : ''
  }`;
}

async function fetchPhasedRelease(
  client: AppStoreClient,
  versionId: string
): Promise<PhasedReleaseSummary | null> {
  try {
    const response = await client.get(`/v1/appStoreVersions/${versionId}/appStoreVersionPhasedRelease`);
    return response?.data ? toPhasedReleaseSummary(response.data) : null;
  } catch (error) {
    // Observed on the live API: when no phased release exists Apple answers
    // `200 { "data": null }` (handled above), and 404s only when the *version*
    // ID itself is unknown. Swallowing that 404 turned a bad version ID into a
    // reassuring "no phased release configured", so it is rethrown.
    if (
      error instanceof AppStoreApiError &&
      error.httpStatus === 404 &&
      !error.errors.some((detail) => /type 'appStoreVersions'/.test(detail.detail ?? ''))
    ) {
      return null;
    }
    throw error;
  }
}

export const getPhasedReleaseStatus = defineTool<{ versionId: string }>({
  name: 'get_phased_release_status',
  description:
    'Show the phased release state of an app store version, including the current day (1-7) and the share of users reached. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      versionId: { type: 'string', description: 'The ID of the app store version' },
    },
    required: ['versionId'],
  },
  handler: async ({ versionId }, client) => {
    const phased = await fetchPhasedRelease(client, versionId);

    if (!phased) {
      return `No phased release configured for version ${versionId}. The update ships to 100% of users at once. Use enable_phased_release to change that.`;
    }

    return `📈 Phased release for version ${versionId}:

${formatPhasedRelease(phased)}

Apple's schedule (fixed): day 1 = 1%, 2 = 2%, 3 = 5%, 4 = 10%, 5 = 20%, 6 = 50%, 7 = 100%.`;
  },
});

export const enablePhasedRelease = defineTool<{ versionId: string; initialState?: string }>({
  name: 'enable_phased_release',
  description:
    'Enable phased release on an app store version so the update rolls out over 7 days instead of reaching everyone at once.',
  inputSchema: {
    type: 'object',
    properties: {
      versionId: { type: 'string', description: 'The ID of the app store version' },
      initialState: {
        type: 'string',
        description: 'Initial state (default INACTIVE — the rollout starts when the version goes live)',
        enum: ['INACTIVE', 'ACTIVE'],
      },
    },
    required: ['versionId'],
  },
  handler: async ({ versionId, initialState }, client) => {
    const existing = await fetchPhasedRelease(client, versionId);
    if (existing) {
      throw new Error(
        `Version ${versionId} already has a phased release (${existing.phasedReleaseState}). ` +
          `Use update_phased_release_state to change it, or cancel_phased_release to remove it.`
      );
    }

    const attributes: Record<string, string> = {};
    if (initialState) attributes.phasedReleaseState = initialState;

    const response = await client.post('/v1/appStoreVersionPhasedReleases', {
      data: {
        type: 'appStoreVersionPhasedReleases',
        attributes,
        relationships: {
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    });

    return `✅ Phased release enabled for version ${versionId}:

${formatPhasedRelease(toPhasedReleaseSummary(response.data))}`;
  },
});

export const updatePhasedReleaseState = defineTool<{
  phasedReleaseId: string;
  phasedReleaseState: string;
}>({
  name: 'update_phased_release_state',
  description:
    'Pause, resume or complete a phased release. COMPLETE is high impact: it immediately pushes the update to 100% of users and cannot be undone.',
  inputSchema: {
    type: 'object',
    properties: {
      phasedReleaseId: {
        type: 'string',
        description: 'The ID of the phased release (see get_phased_release_status)',
      },
      phasedReleaseState: {
        type: 'string',
        description:
          'INACTIVE = not started, ACTIVE = rolling out / resume, PAUSED = hold the rollout, COMPLETE = release to 100% now (irreversible)',
        enum: [...PHASED_RELEASE_STATES],
      },
    },
    required: ['phasedReleaseId', 'phasedReleaseState'],
  },
  handler: async ({ phasedReleaseId, phasedReleaseState }, client) => {
    const response = await client.patch(`/v1/appStoreVersionPhasedReleases/${phasedReleaseId}`, {
      data: {
        type: 'appStoreVersionPhasedReleases',
        id: phasedReleaseId,
        attributes: { phasedReleaseState },
      },
    });

    const phased = toPhasedReleaseSummary(response.data);
    const note =
      phasedReleaseState === 'COMPLETE'
        ? '\n\n⚠️ The rollout is now complete: every user gets the update. This cannot be rolled back.'
        : '';

    return `✅ Phased release updated:

${formatPhasedRelease(phased)}${note}`;
  },
});

export const cancelPhasedRelease = defineTool<{ phasedReleaseId: string }>({
  name: 'cancel_phased_release',
  description:
    'Delete the phased release of a version. Users who have not received the update yet get it immediately, as with a normal release.',
  inputSchema: {
    type: 'object',
    properties: {
      phasedReleaseId: { type: 'string', description: 'The ID of the phased release to delete' },
    },
    required: ['phasedReleaseId'],
  },
  handler: async ({ phasedReleaseId }, client) => {
    await client.delete(`/v1/appStoreVersionPhasedReleases/${phasedReleaseId}`);
    return `✅ Phased release ${phasedReleaseId} canceled. The version now behaves like a standard, all-at-once release.`;
  },
});

// ---------------------------------------------------------------------------
// 3. Release control
// ---------------------------------------------------------------------------

export const setVersionReleaseType = defineTool<{
  versionId: string;
  releaseType: string;
  earliestReleaseDate?: string;
}>({
  name: 'set_version_release_type',
  description:
    'Choose how an approved version goes live: MANUAL (you press Release), AFTER_APPROVAL (automatic), or SCHEDULED at a date.',
  inputSchema: {
    type: 'object',
    properties: {
      versionId: { type: 'string', description: 'The ID of the app store version' },
      releaseType: {
        type: 'string',
        description:
          'MANUAL = wait for release_app_store_version, AFTER_APPROVAL = publish as soon as Apple approves, SCHEDULED = publish at earliestReleaseDate',
        enum: ['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'],
      },
      earliestReleaseDate: {
        type: 'string',
        description: 'ISO 8601 date-time, required when releaseType is SCHEDULED',
      },
    },
    required: ['versionId', 'releaseType'],
  },
  handler: async ({ versionId, releaseType, earliestReleaseDate }, client) => {
    if (releaseType === 'SCHEDULED' && !earliestReleaseDate) {
      throw new Error('earliestReleaseDate is required when releaseType is SCHEDULED.');
    }

    const attributes: Record<string, unknown> = { releaseType };
    // Apple rejects a date on non-scheduled releases; clear it explicitly.
    attributes.earliestReleaseDate = releaseType === 'SCHEDULED' ? earliestReleaseDate : null;

    const response = await client.patch(`/v1/appStoreVersions/${versionId}`, {
      data: { type: 'appStoreVersions', id: versionId, attributes },
    });

    const attrs = response?.data?.attributes ?? {};

    return `✅ Release type updated for version ${attrs.versionString ?? versionId}:
• Release type: ${attrs.releaseType ?? releaseType}
• Scheduled for: ${formatDate(attrs.earliestReleaseDate)}
• State: ${describeVersionState(attrs.appStoreState)}`;
  },
});

export const releaseAppStoreVersion = defineTool<{ versionId: string; confirm?: boolean }>({
  name: 'release_app_store_version',
  description:
    'HIGH IMPACT, IRREVERSIBLE: publish an approved version on the App Store (the "Release this version" button). Only works on PENDING_DEVELOPER_RELEASE. Requires confirm: true.',
  inputSchema: {
    type: 'object',
    properties: {
      versionId: { type: 'string', description: 'The ID of the approved app store version' },
      confirm: {
        type: 'boolean',
        description: 'Must be true. Guard against accidentally publishing to the App Store.',
      },
    },
    required: ['versionId', 'confirm'],
  },
  handler: async ({ versionId, confirm }, client) => {
    requireConfirmation(confirm, 'publishing a version on the App Store');

    const version = await fetchVersion(client, versionId);

    if (version.appStoreState !== 'PENDING_DEVELOPER_RELEASE') {
      throw new Error(
        `Version ${version.versionString} is ${describeVersionState(version.appStoreState)}. ` +
          `Only a version in PENDING_DEVELOPER_RELEASE (approved, waiting for you) can be released. ` +
          `Use get_app_release_status to see where it stands.`
      );
    }

    await client.post('/v1/appStoreVersionReleaseRequests', {
      data: {
        type: 'appStoreVersionReleaseRequests',
        relationships: {
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    });

    const phased = await fetchPhasedRelease(client, versionId);

    return `🎉 Version ${version.versionString} is being released on the App Store.

${
  phased
    ? `Phased release is configured — the rollout follows Apple's 7-day schedule:\n${formatPhasedRelease(phased)}`
    : 'No phased release: the update reaches all users at once.'
}

Propagation across the store takes some time; poll get_app_release_status for READY_FOR_SALE.`;
  },
});

// ---------------------------------------------------------------------------
// 4. Diagnostics
// ---------------------------------------------------------------------------

/**
 * The one line a human actually reads: what to do next, given where the current
 * version stands. Editable states additionally depend on a build being attached,
 * since Apple rejects a submission without one.
 */
function nextAction(
  state: string | undefined,
  hasBuild: boolean,
  openSubmissions: SubmissionSummary[]
): string {
  if (state && (EDITABLE_VERSION_STATES as readonly string[]).includes(state)) {
    // A rejected version is editable, yet its submission usually stays open in
    // UNRESOLVED_ISSUES — and Apple refuses a new submission while one is in
    // flight. Advertising submit_app_store_version_for_review there sends the
    // reader straight into a guaranteed failure.
    const blocking = openSubmissions.find((submission) => submission.submitted);
    if (blocking) {
      return (
        `the version is editable, but submission ${blocking.id} is still open at Apple ` +
        `(${describeSubmissionState(blocking.state)}). Resolve it in App Store Connect, or withdraw it ` +
        `with cancel_review_submission, before submitting again.`
      );
    }

    if (!hasBuild) {
      return 'the version is editable but has no build attached. Upload a build (Xcode/Transporter) and attach it before submitting.';
    }

    const draft = openSubmissions.find((submission) => !submission.submitted);
    if (draft) {
      return (
        `a draft submission (${draft.id}) already exists and was never sent — submit_review_submission ` +
        `sends it, or submit_app_store_version_for_review with reuseOpenSubmission: true.`
      );
    }

    return 'the version is editable and has a build — submit_app_store_version_for_review sends it to Apple.';
  }

  switch (state) {
    case 'READY_FOR_REVIEW':
      return 'the version is attached to a draft submission that was never sent. submit_review_submission sends it to Apple.';
    case 'WAITING_FOR_REVIEW':
      return 'nothing to do — queued at Apple. Poll this tool, or cancel_review_submission to pull it back.';
    case 'IN_REVIEW':
      return 'nothing to do — a reviewer has it. Poll this tool for the outcome.';
    case 'PENDING_DEVELOPER_RELEASE':
      return 'approved and waiting on you — release_app_store_version publishes it.';
    case 'PENDING_APPLE_RELEASE':
    case 'PROCESSING_FOR_APP_STORE':
      return 'nothing to do — Apple is publishing it.';
    case 'READY_FOR_SALE':
      return 'the version is live. Create a new version to ship an update.';
    case 'WAITING_FOR_EXPORT_COMPLIANCE':
      return 'answer the export-compliance questions on the build before this can move.';
    default:
      return `no standard next step for state ${describeVersionState(state)}.`;
  }
}

export const getAppReleaseStatus = defineTool<{ appId: string }>({
  name: 'get_app_release_status',
  description:
    'Answer "where do I stand?" for an app: latest version, its state, the attached build, any in-flight review submission and the phased release. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'The ID of the app' },
    },
    required: ['appId'],
  },
  handler: async ({ appId }, client) => {
    const versionsResponse = await client.get(`/v1/apps/${appId}/appStoreVersions`, {
      query: { limit: 5, include: 'build' },
    });

    const versions: any[] = versionsResponse?.data ?? [];
    const included: any[] = versionsResponse?.included ?? [];

    if (versions.length === 0) {
      return `No app store version found for app ${appId}.`;
    }

    // Apple returns versions newest first in practice but documents no default
    // sort on this collection (and rejects an explicit `sort` on it), so order
    // by creation date defensively rather than trusting the response order.
    versions.sort((a, b) => {
      const left = new Date(a.attributes?.createdDate ?? 0).getTime();
      const right = new Date(b.attributes?.createdDate ?? 0).getTime();
      return right - left;
    });

    const current = versions[0];
    const attrs = current.attributes ?? {};
    const buildId = current.relationships?.build?.data?.id;
    const build = included.find((entry) => entry.type === 'builds' && entry.id === buildId);

    const buildLine = build
      ? // `build.attributes.version` is the build number (CFBundleVersion).
        `build ${build.attributes?.version ?? '?'} — ${
          build.attributes?.processingState ?? 'unknown state'
        } (ID ${build.id})`
      : buildId
        ? `attached (ID ${buildId})`
        : '❌ none attached — a version cannot be submitted without a build';

    let submissionLine = 'none';
    let openSubmissions: SubmissionSummary[] = [];
    try {
      const open = await findOpenSubmissions(client, appId);
      openSubmissions = open;
      submissionLine =
        open.length === 0
          ? 'none in flight'
          : open
              .map(
                (submission) =>
                  `${describeSubmissionState(submission.state)} — ID ${submission.id}${
                    submission.submitted ? `, sent ${formatDate(submission.submittedDate)}` : ', draft'
                  }`
              )
              .join('\n              ');
    } catch (error) {
      submissionLine = `could not be read (${(error as Error).message})`;
    }

    const phased = await fetchPhasedRelease(client, current.id);

    const otherVersions = versions
      .slice(1)
      .map((version) => `   • ${version.attributes?.versionString}: ${version.attributes?.appStoreState}`)
      .join('\n');

    return `📊 Release status for app ${appId}

Current version
• Version: ${attrs.versionString ?? '?'} (${attrs.platform ?? '?'})
• State: ${describeVersionState(attrs.appStoreState)}
• Release type: ${attrs.releaseType ?? 'MANUAL'}${
      attrs.earliestReleaseDate ? `\n• Scheduled for: ${formatDate(attrs.earliestReleaseDate)}` : ''
    }
• Version ID: ${current.id}
• Build: ${buildLine}

Review submission
• ${submissionLine}

Phased release
${phased ? formatPhasedRelease(phased) : '• not configured (release goes to 100% of users at once)'}
${otherVersions ? `\nPrevious versions\n${otherVersions}` : ''}

👉 Next action: ${nextAction(attrs.appStoreState, Boolean(buildId), openSubmissions)}`;
  },
});

export const submissionTools: Tool[] = [
  // Review submissions
  listReviewSubmissions,
  createReviewSubmission,
  addReviewSubmissionItem,
  removeReviewSubmissionItem,
  submitReviewSubmission,
  cancelReviewSubmission,
  submitAppStoreVersionForReview,
  // Phased release
  getPhasedReleaseStatus,
  enablePhasedRelease,
  updatePhasedReleaseState,
  cancelPhasedRelease,
  // Release control
  setVersionReleaseType,
  releaseAppStoreVersion,
  // Diagnostics
  getAppReleaseStatus,
];
