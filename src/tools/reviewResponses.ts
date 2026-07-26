/**
 * Customer review triage and public developer responses.
 *
 * Two families of tools live here:
 *
 *  1. Advanced review reading — filtering (rating, territory, answered/unanswered),
 *     sorting, full pagination and a client-side summary. The shipped
 *     `get_customer_reviews` tool only returns the 50 most recent reviews with no
 *     filters; these tools are what you use to actually work a review queue.
 *
 *  2. Developer responses — creating, reading and deleting the public reply
 *     attached to a review. Every write here is PUBLIC: the text appears on the
 *     App Store product page under the review, signed by the developer, visible
 *     to every store visitor. Tool descriptions say so, and the bulk tool refuses
 *     to run without an explicit confirmation flag.
 *
 * Endpoints used:
 *   GET    /v1/apps/{appId}/customerReviews
 *   GET    /v1/customerReviews/{reviewId}/response
 *   POST   /v1/customerReviewResponses
 *   DELETE /v1/customerReviewResponses/{responseId}
 */

import { AppStoreApiError, type AppStoreClient } from '../appstore-client.js';
import { defineTool, type Tool } from './types.js';

// ---------------------------------------------------------------------------
// Constants and guardrails
// ---------------------------------------------------------------------------

/** Apple's hard limit on `responseBody`. Longer bodies are rejected with a 409. */
const MAX_RESPONSE_BODY_LENGTH = 5970;

/** Apple caps `limit` at 200 on the customerReviews collection. */
const PAGE_SIZE = 200;

/** Ceiling on how many reviews one bulk call may ever answer, whatever is asked. */
const BULK_HARD_CAP = 50;

/** Default bulk batch size when the caller does not pass one. */
const BULK_DEFAULT_MAX = 10;

const SORT_VALUES = ['-createdDate', 'createdDate', '-rating', 'rating'] as const;
type SortValue = (typeof SORT_VALUES)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReviewAttributes {
  rating: number;
  title?: string;
  body?: string;
  reviewerNickname?: string;
  territory?: string;
  createdDate: string;
}

interface ReviewResource {
  id: string;
  attributes: ReviewAttributes;
}

interface ResponseAttributes {
  responseBody: string;
  lastModifiedDate?: string;
  state?: string;
}

interface ResponseResource {
  id: string;
  attributes: ResponseAttributes;
}

interface ReviewQuery {
  appId: string;
  rating?: number[];
  territory?: string[];
  answered?: boolean;
  sort?: SortValue;
  limit?: number;
  allPages?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `★★★★☆` — reads better than a bare number in a wall of reviews. */
function stars(rating: number): string {
  const clamped = Math.max(0, Math.min(5, Math.round(rating || 0)));
  return `${'★'.repeat(clamped)}${'☆'.repeat(5 - clamped)}`;
}

function formatDate(value?: string): string {
  if (!value) return 'unknown date';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().split('T')[0];
}

/** Human-readable rendering of one review, optionally with its response. */
function formatReview(review: ReviewResource, index?: number, response?: ResponseResource | null): string {
  const attrs = review.attributes || ({} as ReviewAttributes);
  const prefix = index === undefined ? '' : `${index + 1}. `;
  const lines = [
    `${prefix}${stars(attrs.rating)} ${attrs.rating}/5 — ${attrs.title?.trim() || '(no title)'}`,
    `   by ${attrs.reviewerNickname || 'anonymous'} · ${attrs.territory || 'unknown territory'} · ${formatDate(attrs.createdDate)}`,
    `   review id: ${review.id}`,
  ];

  if (attrs.body?.trim()) {
    // Keep the body intact but indent it so multi-review output stays scannable.
    lines.push(
      ...attrs.body
        .trim()
        .split('\n')
        .map((line) => `   ${line}`)
    );
  }

  if (response) {
    lines.push(formatResponse(response, '   '));
  } else if (response === null) {
    lines.push('   ↳ no developer response yet');
  }

  return lines.join('\n');
}

function formatResponse(response: ResponseResource, indent = ''): string {
  const attrs = response.attributes || ({} as ResponseAttributes);
  const state = attrs.state || 'UNKNOWN';
  const stateNote =
    state === 'PENDING_PUBLISH'
      ? ' (awaiting Apple review, not visible on the store yet)'
      : state === 'PUBLISHED'
        ? ' (live on the App Store)'
        : '';

  const lines = [
    `${indent}↳ developer response [${state}]${stateNote}`,
    `${indent}  response id: ${response.id}`,
    `${indent}  last modified: ${formatDate(attrs.lastModifiedDate)}`,
  ];

  if (attrs.responseBody) {
    lines.push(...attrs.responseBody.split('\n').map((line) => `${indent}  ${line}`));
  }

  return lines.join('\n');
}

/**
 * Validate a response body against Apple's constraints before spending a
 * round-trip on a request Apple will reject anyway.
 */
function assertValidResponseBody(body: string): void {
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new Error('responseBody is required and cannot be empty.');
  }

  if (body.length > MAX_RESPONSE_BODY_LENGTH) {
    throw new Error(
      `responseBody is ${body.length} characters; App Store Connect allows at most ${MAX_RESPONSE_BODY_LENGTH}. ` +
        `Trim ${body.length - MAX_RESPONSE_BODY_LENGTH} characters and retry.`
    );
  }
}

/** Build the `filter[...]`/`sort` query for the customerReviews collection. */
function buildReviewQuery(args: ReviewQuery): Record<string, string | number | Array<string | number>> {
  const query: Record<string, string | number | Array<string | number>> = {
    sort: args.sort || '-createdDate',
    limit: args.allPages ? PAGE_SIZE : Math.min(Math.max(args.limit ?? 50, 1), PAGE_SIZE),
  };

  if (args.rating?.length) {
    const invalid = args.rating.filter((value) => !Number.isInteger(value) || value < 1 || value > 5);
    if (invalid.length > 0) {
      throw new Error(`Invalid rating filter value(s): ${invalid.join(', ')}. Ratings are integers from 1 to 5.`);
    }
    query['filter[rating]'] = args.rating;
  }

  if (args.territory?.length) {
    // Apple expects ISO-3166-1 alpha-3 codes (USA, FRA, JPN...).
    query['filter[territory]'] = args.territory.map((code) => code.toUpperCase());
  }

  if (args.answered !== undefined) {
    // Verified against the live API: `filter[existsResponse]` does not exist and
    // is rejected with `400 'existsResponse' is not a valid filter type`. The
    // parameter Apple actually accepts on this collection is the `exists[...]`
    // family, keyed on the relationship name.
    //
    // Caveat worth knowing: it keys on the *published* response, so a reply that
    // is still PENDING_PUBLISH is reported as unanswered.
    query['exists[publishedResponse]'] = String(args.answered);
  }

  return query;
}

/** Fetch reviews for an app, honouring filters, sort and the pagination choice. */
async function fetchReviews(args: ReviewQuery, client: AppStoreClient): Promise<ReviewResource[]> {
  const query = buildReviewQuery(args);
  const path = `/v1/apps/${args.appId}/customerReviews`;

  if (args.allPages) {
    const { data } = await client.getAllPages<ReviewResource>(path, { query });
    return data;
  }

  const response = await client.get(path, { query });
  return (response?.data as ReviewResource[]) || [];
}

/**
 * Distinguish "this review has no response" from "this review does not exist".
 *
 * Observed on the live API: an unanswered review answers `200 { "data": null }`,
 * while an unknown review ID answers `404 There is no resource of type
 * 'customerReviews' with id '...'`. Swallowing every 404 would turn a typo in a
 * review ID into a confident "no response yet", so only a 404 that is *not*
 * about the customerReviews resource itself is treated as "no response".
 */
function isMissingResponse(error: unknown): boolean {
  if (!(error instanceof AppStoreApiError) || error.httpStatus !== 404) return false;
  return !error.errors.some((detail) => /type 'customerReviews'/.test(detail.detail ?? ''));
}

/**
 * Read the developer response attached to a review.
 *
 * "No response" is mapped to `null`; any other API error is rethrown untouched
 * so Apple's `detail` message survives.
 */
async function fetchResponse(reviewId: string, client: AppStoreClient): Promise<ResponseResource | null> {
  try {
    const response = await client.get(`/v1/customerReviews/${reviewId}/response`);
    return (response?.data as ResponseResource) || null;
  } catch (error) {
    if (isMissingResponse(error)) return null;
    throw error;
  }
}

/** POST a response. Apple replaces any existing response on the same review. */
async function postResponse(reviewId: string, responseBody: string, client: AppStoreClient): Promise<ResponseResource> {
  const response = await client.post('/v1/customerReviewResponses', {
    data: {
      type: 'customerReviewResponses',
      attributes: { responseBody },
      relationships: {
        review: { data: { type: 'customerReviews', id: reviewId } },
      },
    },
  });

  return response.data as ResponseResource;
}

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const reviewFilterProperties = {
  appId: {
    type: 'string',
    description: 'The App Store Connect app ID (get it from list_apps)',
  },
  rating: {
    type: 'array',
    items: { type: 'number' },
    description: 'Only reviews with these star ratings, 1 to 5 (e.g. [1, 2] for the angry ones)',
  },
  territory: {
    type: 'array',
    items: { type: 'string' },
    description: 'Only reviews from these territories, ISO alpha-3 codes (e.g. ["USA", "FRA"])',
  },
  answered: {
    type: 'boolean',
    description:
      'Filter on whether a developer response already exists. Pass false to get the reviews still awaiting a reply. Omit for both.',
  },
  sort: {
    type: 'string',
    enum: [...SORT_VALUES],
    description: 'Sort order (default: -createdDate, newest first)',
  },
};

// ---------------------------------------------------------------------------
// Tools — reading
// ---------------------------------------------------------------------------

export const searchCustomerReviews = defineTool<
  ReviewQuery & { includeResponses?: boolean }
>({
  name: 'search_customer_reviews',
  description:
    'Search an app\'s customer reviews with filters (rating, territory, answered/unanswered), sorting and optional full pagination. Use answered=false to list the reviews still waiting for a developer reply.',
  inputSchema: {
    type: 'object',
    properties: {
      ...reviewFilterProperties,
      limit: {
        type: 'number',
        description: 'Maximum number of reviews to return, 1-200 (default: 50). Ignored when allPages is true.',
      },
      allPages: {
        type: 'boolean',
        description: 'Fetch every matching review by following pagination instead of a single page (default: false)',
      },
      includeResponses: {
        type: 'boolean',
        description:
          'Also fetch the existing developer response for each review. Costs one extra API call per review, so keep the result set small (default: false)',
      },
    },
    required: ['appId'],
  },
  handler: async (args, client) => {
    const reviews = await fetchReviews(args, client);

    if (reviews.length === 0) {
      return 'No reviews match these filters.';
    }

    const filters: string[] = [];
    if (args.rating?.length) filters.push(`rating ${args.rating.join('/')}`);
    if (args.territory?.length)
      filters.push(`territory ${args.territory.map((code) => code.toUpperCase()).join('/')}`);
    if (args.answered !== undefined) filters.push(args.answered ? 'already answered' : 'awaiting response');
    const filterNote = filters.length > 0 ? ` (${filters.join(', ')})` : '';

    let bodies: string[];

    if (args.includeResponses) {
      bodies = [];
      for (const [index, review] of reviews.entries()) {
        const response = await fetchResponse(review.id, client);
        bodies.push(formatReview(review, index, response));
      }
    } else {
      bodies = reviews.map((review, index) => formatReview(review, index));
    }

    return `${reviews.length} review(s)${filterNote} for app ${args.appId}, sorted by ${args.sort || '-createdDate'}:\n\n${bodies.join('\n\n')}`;
  },
});

export const summarizeCustomerReviews = defineTool<{
  appId: string;
  territory?: string[];
  recentDays?: number;
}>({
  name: 'summarize_customer_reviews',
  description:
    'Summarize an app\'s customer reviews: rating distribution, average rating, how many are still awaiting a developer response, and the recent trend. Computed client-side from every paginated review.',
  inputSchema: {
    type: 'object',
    properties: {
      appId: reviewFilterProperties.appId,
      territory: reviewFilterProperties.territory,
      recentDays: {
        type: 'number',
        description: 'Window in days used for the recent-trend comparison (default: 30)',
      },
    },
    required: ['appId'],
  },
  handler: async ({ appId, territory, recentDays }, client) => {
    const windowDays = recentDays && recentDays > 0 ? recentDays : 30;

    const reviews = await fetchReviews({ appId, territory, allPages: true, sort: '-createdDate' }, client);

    if (reviews.length === 0) {
      return `No reviews found for app ${appId}.`;
    }

    // One extra pass with exists[publishedResponse]=false gives the unanswered
    // count straight from Apple rather than inferring it review by review.
    const unanswered = await fetchReviews(
      { appId, territory, answered: false, allPages: true, sort: '-createdDate' },
      client
    );

    const distribution = [0, 0, 0, 0, 0];
    let ratingSum = 0;

    for (const review of reviews) {
      const rating = Math.max(1, Math.min(5, Math.round(review.attributes?.rating || 0)));
      distribution[rating - 1] += 1;
      ratingSum += rating;
    }

    const average = ratingSum / reviews.length;

    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const recent = reviews.filter((review) => new Date(review.attributes?.createdDate).getTime() >= cutoff);
    const older = reviews.filter((review) => new Date(review.attributes?.createdDate).getTime() < cutoff);

    const mean = (subset: ReviewResource[]) =>
      subset.length === 0
        ? null
        : subset.reduce((sum, review) => sum + (review.attributes?.rating || 0), 0) / subset.length;

    const recentAverage = mean(recent);
    const olderAverage = mean(older);

    let trend: string;
    if (recentAverage === null) {
      trend = `No review in the last ${windowDays} days.`;
    } else if (olderAverage === null) {
      trend = `${recent.length} review(s) in the last ${windowDays} days, averaging ${recentAverage.toFixed(2)}/5 (no earlier reviews to compare against).`;
    } else {
      const delta = recentAverage - olderAverage;
      const direction = delta > 0.1 ? 'improving' : delta < -0.1 ? 'declining' : 'stable';
      trend =
        `${recent.length} review(s) in the last ${windowDays} days averaging ${recentAverage.toFixed(2)}/5, ` +
        `versus ${olderAverage.toFixed(2)}/5 before — ${direction} (${delta >= 0 ? '+' : ''}${delta.toFixed(2)}).`;
    }

    const bars = distribution
      .map((count, index) => {
        const rating = index + 1;
        const share = (count / reviews.length) * 100;
        const bar = '█'.repeat(Math.round(share / 4));
        return `  ${stars(rating)}  ${String(count).padStart(5)}  ${share.toFixed(1).padStart(5)}%  ${bar}`;
      })
      .reverse()
      .join('\n');

    const territoryNote = territory?.length ? ` (territories: ${territory.join(', ')})` : '';

    return `Review summary for app ${appId}${territoryNote}

Total reviews analysed: ${reviews.length}
Average rating: ${average.toFixed(2)}/5

Distribution:
${bars}

Awaiting a developer response: ${unanswered.length} (${((unanswered.length / reviews.length) * 100).toFixed(1)}%)
Negative reviews (1-2★) without a response: ${
      unanswered.filter((review) => (review.attributes?.rating || 0) <= 2).length
    }
(Apple counts only *published* responses, so a reply still in PENDING_PUBLISH shows up here as awaiting.)

Recent trend: ${trend}`;
  },
});

export const getReviewResponse = defineTool<{ reviewId: string }>({
  name: 'get_review_response',
  description:
    'Get the developer response attached to a customer review, including its publication state (PUBLISHED or PENDING_PUBLISH). Returns a clear message when the review has no response yet.',
  inputSchema: {
    type: 'object',
    properties: {
      reviewId: {
        type: 'string',
        description: 'The customer review ID (returned by search_customer_reviews)',
      },
    },
    required: ['reviewId'],
  },
  handler: async ({ reviewId }, client) => {
    const response = await fetchResponse(reviewId, client);

    if (!response) {
      return `Review ${reviewId} has no developer response yet.`;
    }

    return `Developer response for review ${reviewId}:\n\n${formatResponse(response)}`;
  },
});

// ---------------------------------------------------------------------------
// Tools — writing (public actions)
// ---------------------------------------------------------------------------

export const respondToReview = defineTool<{ reviewId: string; responseBody: string }>({
  name: 'respond_to_review',
  description:
    'PUBLIC ACTION: publish a developer response to a customer review. The text appears on the App Store product page under the review and is visible to every store visitor. If the review already has a response, this REPLACES it. Max 5970 characters.',
  inputSchema: {
    type: 'object',
    properties: {
      reviewId: {
        type: 'string',
        description: 'The customer review ID to answer (returned by search_customer_reviews)',
      },
      responseBody: {
        type: 'string',
        description: `The public reply text, 1 to ${MAX_RESPONSE_BODY_LENGTH} characters. It is shown publicly on the App Store.`,
      },
    },
    required: ['reviewId', 'responseBody'],
  },
  handler: async ({ reviewId, responseBody }, client) => {
    assertValidResponseBody(responseBody);

    const existing = await fetchResponse(reviewId, client);
    const created = await postResponse(reviewId, responseBody, client);

    const header = existing
      ? `Replaced the existing response on review ${reviewId} (previous response id ${existing.id}).`
      : `Published a response to review ${reviewId}.`;

    return `${header}

${formatResponse(created)}

Note: App Store Connect has no update endpoint for review responses — posting again on the same review replaces the previous text, keeping a single response per review. A replaced response returns to PENDING_PUBLISH until Apple publishes it.`;
  },
});

export const deleteReviewResponse = defineTool<{ responseId: string }>({
  name: 'delete_review_response',
  description:
    'PUBLIC ACTION: delete a developer response, removing the public reply from the App Store product page. Takes the response ID (from get_review_response), not the review ID.',
  inputSchema: {
    type: 'object',
    properties: {
      responseId: {
        type: 'string',
        description: 'The customer review response ID (from get_review_response), not the review ID',
      },
    },
    required: ['responseId'],
  },
  handler: async ({ responseId }, client) => {
    await client.delete(`/v1/customerReviewResponses/${responseId}`);
    return `Deleted developer response ${responseId}. The reply is no longer shown on the App Store.`;
  },
});

export const bulkRespondToReviews = defineTool<{
  appId: string;
  responseBody: string;
  confirm: boolean;
  rating?: number[];
  territory?: string[];
  maxReviews?: number;
  sort?: SortValue;
}>({
  name: 'bulk_respond_to_reviews',
  description:
    'PUBLIC ACTION: post the same developer response to several unanswered reviews at once (e.g. every 5-star review with no reply). Requires confirm=true, only ever targets reviews with no existing response, and never processes more than 50 reviews per call. Use search_customer_reviews with answered=false first to preview exactly what will be answered.',
  inputSchema: {
    type: 'object',
    properties: {
      appId: reviewFilterProperties.appId,
      responseBody: {
        type: 'string',
        description: `The public reply posted on every selected review, 1 to ${MAX_RESPONSE_BODY_LENGTH} characters. The same text is published on all of them, so keep it generic.`,
      },
      confirm: {
        type: 'boolean',
        description:
          'Must be explicitly true. Without it the tool only previews which reviews would be answered and posts nothing.',
      },
      rating: {
        type: 'array',
        items: { type: 'number' },
        description: 'Only answer reviews with these star ratings, 1 to 5 (e.g. [5])',
      },
      territory: reviewFilterProperties.territory,
      maxReviews: {
        type: 'number',
        description: `Maximum number of reviews answered in this call (default: ${BULK_DEFAULT_MAX}, hard cap: ${BULK_HARD_CAP})`,
      },
      sort: reviewFilterProperties.sort,
    },
    required: ['appId', 'responseBody', 'confirm'],
  },
  handler: async ({ appId, responseBody, confirm, rating, territory, maxReviews, sort }, client) => {
    assertValidResponseBody(responseBody);

    const cap = Math.min(Math.max(maxReviews ?? BULK_DEFAULT_MAX, 1), BULK_HARD_CAP);

    // `answered: false` is not optional: it is the guardrail that stops the tool
    // from silently overwriting replies a human already wrote.
    const candidates = (
      await fetchReviews({ appId, rating, territory, answered: false, sort: sort || '-createdDate', limit: PAGE_SIZE }, client)
    ).slice(0, cap);

    if (candidates.length === 0) {
      return 'No unanswered review matches these filters. Nothing to do.';
    }

    const preview = candidates.map((review, index) => formatReview(review, index)).join('\n\n');

    if (confirm !== true) {
      return `DRY RUN — nothing was published.

${candidates.length} unanswered review(s) would receive this public reply:

"${responseBody}"

${preview}

Re-run with confirm=true to publish these ${candidates.length} response(s) on the App Store.`;
    }

    const succeeded: string[] = [];
    const failed: string[] = [];

    for (const review of candidates) {
      try {
        const created = await postResponse(review.id, responseBody, client);
        succeeded.push(
          `• review ${review.id} (${stars(review.attributes?.rating)}) → response ${created.id} [${created.attributes?.state || 'UNKNOWN'}]`
        );
      } catch (error: any) {
        // One rejected review must not abort the batch; report it and continue.
        failed.push(`• review ${review.id}: ${error?.message ?? 'unknown error'}`);
      }
    }

    const parts = [
      `Bulk response on app ${appId}: ${succeeded.length} published, ${failed.length} failed (of ${candidates.length} selected).`,
    ];

    if (succeeded.length > 0) parts.push(`Published:\n${succeeded.join('\n')}`);
    if (failed.length > 0) parts.push(`Failed:\n${failed.join('\n')}`);

    parts.push(
      'Responses in PENDING_PUBLISH are queued for Apple review and are not visible on the store yet. Re-run the tool to answer the next batch if more unanswered reviews remain.'
    );

    return parts.join('\n\n');
  },
});

export const reviewResponseTools: Tool[] = [
  searchCustomerReviews,
  summarizeCustomerReviews,
  getReviewResponse,
  respondToReview,
  deleteReviewResponse,
  bulkRespondToReviews,
];
