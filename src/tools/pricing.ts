/**
 * Pricing and in-app purchase catalogue — read-only.
 *
 * Everything here goes through the two-hop reads implemented in
 * `AppStoreClient` (`getAppPricing`, `getInAppPurchasePricing`): on Apple's
 * price-schedule resources the amount is never an attribute of the schedule,
 * it hangs off `manualPrices → appPricePoint`.
 */

import { defineTool, type Tool } from './types.js';

/** Number of in-app purchases we enrich with their price before giving up. */
const MAX_ENRICHED_IAPS = 25;

function formatMoney(amount: unknown, currency?: string): string {
  if (amount === undefined || amount === null || amount === '') return 'unknown';
  const value = Number.parseFloat(String(amount));
  if (!Number.isFinite(value)) return String(amount);
  return currency ? `${value.toFixed(2)} ${currency}` : value.toFixed(2);
}

export const getAppPricing = defineTool<{ appId: string }>({
  name: 'get_app_pricing',
  description:
    "Get an app's price schedule: base territory, currency, and the manually set price per territory with the developer proceeds.",
  inputSchema: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The ID of the app',
      },
    },
    required: ['appId'],
  },
  handler: async ({ appId }, client) => {
    const pricing = await client.getAppPricing(appId);

    if (!pricing) {
      return `No price schedule exists for app ${appId} yet. A price is only created once the app has been priced in App Store Connect.`;
    }

    const lines = [
      `💰 App pricing for app ${appId}:`,
      '',
      `• Base territory: ${pricing.baseTerritory ?? 'unknown'}`,
      `• Base currency: ${pricing.currency ?? 'unknown'}`,
      `• Price schedule id: ${pricing.id}`,
    ];

    if (typeof pricing.automaticPriceCount === 'number') {
      lines.push(
        `• Equalised automatically in ${pricing.automaticPriceCount} other territories (Apple converts from the base price).`
      );
    }

    lines.push('', 'Manually set prices:');

    if (pricing.prices.length === 0) {
      lines.push('(none — every territory is equalised from the base territory)');
    } else {
      for (const [index, price] of pricing.prices.entries()) {
        const currency = price.currency ?? pricing.currency;
        const amount = formatMoney(price.price, currency);
        const free = Number.parseFloat(String(price.price)) === 0;

        lines.push(
          `${index + 1}. ${price.territory ?? 'unknown territory'} — ${amount}${free ? ' (free)' : ''}` +
            `\n   • Developer proceeds: ${formatMoney(price.proceeds, currency)}` +
            `\n   • Window: ${price.startDate ?? 'always'} → ${price.endDate ?? 'no end date'}`
        );
      }
    }

    return lines.join('\n');
  },
});

export const getInAppPurchases = defineTool<{ appId: string; includePricing?: boolean }>({
  name: 'get_in_app_purchases',
  description:
    'List the in-app purchases of an app (consumable, non-consumable, non-renewing) with their type, review state and, unless disabled, their current price in the base territory. Auto-renewable subscriptions are a separate resource and are NOT listed here.',
  inputSchema: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The ID of the app',
      },
      includePricing: {
        type: 'boolean',
        description:
          'Resolve each purchase price (one extra API call per purchase, capped at 25). Defaults to true.',
      },
    },
    required: ['appId'],
  },
  handler: async ({ appId, includePricing = true }, client) => {
    const purchases = await client.getInAppPurchases(appId);

    if (purchases.length === 0) {
      return (
        `No in-app purchases found for app ${appId}.\n\n` +
        `Note: auto-renewable subscriptions live under subscription groups, not on the ` +
        `inAppPurchasesV2 resource this tool reads — an app can have subscriptions and still show zero here.`
      );
    }

    // Apple exposes the price on a separate schedule resource per purchase.
    // One call each, so it is capped and best-effort: a failure on one price
    // must not hide the whole catalogue.
    const prices = new Map<string, any>();
    if (includePricing) {
      for (const iap of purchases.slice(0, MAX_ENRICHED_IAPS)) {
        try {
          const pricing = await client.getInAppPurchasePricing(iap.id);
          if (pricing) prices.set(iap.id, pricing);
        } catch {
          // Left out of the map: rendered as "unavailable" below.
        }
      }
    }

    const truncated = includePricing && purchases.length > MAX_ENRICHED_IAPS;

    const body = purchases
      .map((iap, index) => {
        const pricing = prices.get(iap.id);
        const priceLine = !includePricing
          ? null
          : pricing
            ? `   • Price: ${formatMoney(pricing.customerPrice, pricing.currency)} in ${pricing.baseTerritory} (proceeds ${formatMoney(pricing.proceeds, pricing.currency)})`
            : index < MAX_ENRICHED_IAPS
              ? '   • Price: no price schedule yet'
              : '   • Price: not resolved (enrichment cap reached)';

        return [
          `${index + 1}. ${iap.name} (id ${iap.id})`,
          `   • Product ID: ${iap.productId}`,
          `   • Type: ${iap.inAppPurchaseType}`,
          `   • State: ${iap.state}`,
          `   • Family sharable: ${iap.familySharable ? 'yes' : 'no'}`,
          priceLine,
          iap.reviewNote ? `   • Review note: ${iap.reviewNote}` : null,
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');

    return `🛒 In-app purchases for app ${appId} (${purchases.length}):

${body}${truncated ? `\n\n(prices resolved for the first ${MAX_ENRICHED_IAPS} purchases only)` : ''}`;
  },
});

export const pricingTools: Tool[] = [getAppPricing, getInAppPurchases];
