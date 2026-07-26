/**
 * Sales, analytics and customer feedback reporting.
 */

import { defineTool, type Tool } from './types.js';

export const getSalesData = defineTool<{ date?: string }>({
  name: 'get_sales_data',
  description: 'Get sales and revenue data for a specific date',
  inputSchema: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: 'Date in YYYY-MM-DD format (optional, defaults to today)',
      },
    },
  },
  handler: async ({ date }, client) => {
    const salesData = await client.getSalesData(date);

    return `Sales Data for ${salesData.date}:
• Revenue: ${salesData.currency} ${salesData.revenue.toFixed(2)}
• Units Sold: ${salesData.units}
• Transaction Count: ${salesData.transactionCount}
• Currency: ${salesData.currency}`;
  },
});

export const getAnalytics = defineTool<{ appId: string }>({
  name: 'get_analytics',
  description: 'Get app analytics data including installs, sessions, and retention',
  inputSchema: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The App Store Connect app ID',
      },
    },
    required: ['appId'],
  },
  handler: async ({ appId }, client) => {
    const analytics = await client.getAnalytics(appId);

    return `Analytics for App ${appId}:
• Total Installs: ${analytics.installs?.toLocaleString() || 'N/A'}
• Total Sessions: ${analytics.sessions?.toLocaleString() || 'N/A'}
• Active Users: ${analytics.activeUsers?.toLocaleString() || 'N/A'}
• Retention Rates:
  - Day 1: ${((analytics.retention?.day1 || 0) * 100).toFixed(1)}%
  - Day 7: ${((analytics.retention?.day7 || 0) * 100).toFixed(1)}%
  - Day 30: ${((analytics.retention?.day30 || 0) * 100).toFixed(1)}%`;
  },
});

export const getCustomerReviews = defineTool<{ appId: string; limit?: number }>({
  name: 'get_customer_reviews',
  description: 'Get customer reviews for an app',
  inputSchema: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The ID of the app',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of reviews to return (default: 50)',
      },
    },
    required: ['appId'],
  },
  handler: async ({ appId, limit }, client) => {
    const reviews = await client.getCustomerReviews(appId, limit || 50);

    return `📝 Customer Reviews for App ${appId}:

${
  reviews.length === 0
    ? 'No reviews found.'
    : reviews
        .map(
          (review, index) =>
            `${index + 1}. ${review.title || 'Untitled'}
   • Rating: ${'⭐'.repeat(review.rating)}
   • Reviewer: ${review.reviewerNickname}
   • Territory: ${review.territory}
   • Date: ${new Date(review.createdDate).toLocaleDateString()}
   ${review.body ? `• Review: ${review.body.substring(0, 200)}${review.body.length > 200 ? '...' : ''}` : ''}`
        )
        .join('\n\n')
}`;
  },
});

export const reportTools: Tool[] = [getSalesData, getAnalytics, getCustomerReviews];
