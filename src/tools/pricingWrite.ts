/**
 * Pricing, in-app purchase and territory availability — WRITE operations.
 *
 * Read-only counterparts live in `pricing.ts` (`get_app_pricing`,
 * `get_in_app_purchases`); nothing here duplicates them. The two read helpers
 * added below (`list_app_price_points`, `list_territories`) exist only because
 * the write tools are unusable without a way to discover Apple's opaque ids.
 *
 * ⚠️  Everything in this module has an immediate, publicly visible commercial
 * effect: a price change reaches customers on the App Store within minutes, a
 * removed territory delists the app there, and a deleted in-app purchase is
 * gone for good. Every mutating tool therefore requires an explicit
 * `confirm: true` argument.
 *
 * === The price point problem ===
 * Apple no longer accepts a free-form amount. Prices are opaque, per-territory
 * `appPricePoints` / `inAppPurchasePricePoints` identifiers picked from a fixed
 * ladder of tiers. A caller who only knows "I want €4.99" cannot use those
 * endpoints directly.
 *
 * The tools below close that gap: they take a human amount in the base
 * territory's currency, page through the territory's price point ladder,
 * pick the closest `customerPrice`, and report which tier was actually applied
 * (including the rounding, when the requested amount is not on the ladder).
 */

import { defineTool, type Tool } from './types.js';
import type { AppStoreClient } from '../appstore-client.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Convenience mapping for the most common ISO 3166-1 alpha-2 codes.
 * Apple's canonical territory id is alpha-3 ("USA", "FRA", "DEU"); accepting
 * alpha-2 removes the most frequent source of 404s. Use `list_territories`
 * for the authoritative list.
 */
const ALPHA2_TO_ALPHA3: Record<string, string> = {
  AE: 'ARE', AT: 'AUT', AU: 'AUS', BE: 'BEL', BR: 'BRA', CA: 'CAN', CH: 'CHE',
  CI: 'CIV', CL: 'CHL', CN: 'CHN', CO: 'COL', CZ: 'CZE', DE: 'DEU', DK: 'DNK',
  DZ: 'DZA', EG: 'EGY', ES: 'ESP', FI: 'FIN', FR: 'FRA', GB: 'GBR', GR: 'GRC',
  HK: 'HKG', HU: 'HUN', ID: 'IDN', IE: 'IRL', IL: 'ISR', IN: 'IND', IT: 'ITA',
  JP: 'JPN', KE: 'KEN', KR: 'KOR', MA: 'MAR', MX: 'MEX', MY: 'MYS', NG: 'NGA',
  NL: 'NLD', NO: 'NOR', NZ: 'NZL', PH: 'PHL', PL: 'POL', PT: 'PRT', RO: 'ROU',
  RU: 'RUS', SA: 'SAU', SE: 'SWE', SG: 'SGP', SN: 'SEN', TH: 'THA', TN: 'TUN',
  TR: 'TUR', TW: 'TWN', UA: 'UKR', US: 'USA', VN: 'VNM', ZA: 'ZAF',
};

/** Normalise a caller-supplied country code to Apple's alpha-3 territory id. */
function normalizeTerritory(input: string): string {
  const code = input.trim().toUpperCase();

  if (code.length === 2) {
    const mapped = ALPHA2_TO_ALPHA3[code];
    if (!mapped) {
      throw new Error(
        `Unknown 2-letter country code "${code}". Use Apple's 3-letter territory id instead (run list_territories).`
      );
    }
    return mapped;
  }

  if (code.length !== 3) {
    throw new Error(
      `Invalid territory "${input}". Expected an Apple 3-letter territory id such as USA or FRA (run list_territories).`
    );
  }

  return code;
}

function normalizeTerritories(codes: string[]): string[] {
  // De-duplicate while preserving the caller's order.
  return Array.from(new Set(codes.map(normalizeTerritory)));
}

/** Guard for every operation with a customer-visible or destructive effect. */
function requireConfirmation(confirm: boolean | undefined, action: string): void {
  if (confirm === true) return;

  throw new Error(
    `Refused: ${action} has an immediate, publicly visible effect. ` +
      `Re-run the same call with "confirm": true once the change has been approved.`
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: string | undefined, field: string): void {
  if (value !== undefined && !ISO_DATE.test(value)) {
    throw new Error(`${field} must be an ISO date formatted as YYYY-MM-DD (got "${value}").`);
  }
}

/** Cap on the number of tiers printed when the caller gives no `aroundPrice`. */
const UNFILTERED_PRICE_POINT_LIMIT = 40;

interface PricePoint {
  id: string;
  customerPrice: number;
  proceeds: number;
  rawCustomerPrice: string;
}

/**
 * Page through a price point ladder and return the tier whose `customerPrice`
 * is closest to `targetPrice`.
 *
 * `path` is either `/v1/apps/{id}/appPricePoints` (app prices) or
 * `/v2/inAppPurchases/{id}/pricePoints` (in-app purchase prices) — both return
 * the same `{ customerPrice, proceeds }` attribute shape.
 */
async function findClosestPricePoint(
  client: AppStoreClient,
  path: string,
  territory: string,
  targetPrice: number
): Promise<{ chosen: PricePoint; exact: boolean; neighbours: PricePoint[] }> {
  const { data } = await client.getAllPages<any>(path, {
    query: { 'filter[territory]': territory, limit: 200 },
    maxPages: 20,
  });

  const points: PricePoint[] = data
    .map((point: any) => ({
      id: point.id,
      rawCustomerPrice: String(point.attributes?.customerPrice ?? ''),
      customerPrice: Number.parseFloat(point.attributes?.customerPrice ?? 'NaN'),
      proceeds: Number.parseFloat(point.attributes?.proceeds ?? 'NaN'),
    }))
    .filter((point: PricePoint) => Number.isFinite(point.customerPrice));

  if (points.length === 0) {
    throw new Error(
      `No price points returned for territory ${territory} on ${path}. ` +
        `Check the territory id (list_territories) and that the resource is priceable.`
    );
  }

  points.sort((a, b) => a.customerPrice - b.customerPrice);

  let chosen = points[0];
  for (const point of points) {
    if (
      Math.abs(point.customerPrice - targetPrice) < Math.abs(chosen.customerPrice - targetPrice)
    ) {
      chosen = point;
    }
  }

  // A couple of tiers on each side, so the caller can see the ladder's grain.
  const index = points.indexOf(chosen);
  const neighbours = points.slice(Math.max(0, index - 2), index + 3);

  return {
    chosen,
    exact: Math.abs(chosen.customerPrice - targetPrice) < 0.005,
    neighbours,
  };
}

function describePricePoint(
  territory: string,
  requested: number,
  result: { chosen: PricePoint; exact: boolean; neighbours: PricePoint[] }
): string {
  const header = result.exact
    ? `• Price point: ${result.chosen.rawCustomerPrice} in ${territory} (exact match)`
    : `• Price point: ${result.chosen.rawCustomerPrice} in ${territory} ` +
      `⚠️ requested ${requested} is not on Apple's ladder, the closest tier was applied`;

  const ladder = result.neighbours
    .map((point) => (point.id === result.chosen.id ? `[${point.rawCustomerPrice}]` : point.rawCustomerPrice))
    .join(' · ');

  return `${header}
• Developer proceeds: ${Number.isFinite(result.chosen.proceeds) ? result.chosen.proceeds : 'n/a'}
• Nearby tiers: ${ladder}
• Price point id: ${result.chosen.id}`;
}

/**
 * Build the `included` entry describing one manual price.
 *
 * `appPriceSchedules` / `inAppPurchasePriceSchedules` reference their prices by
 * a client-generated placeholder id (`${price0}`), resolved against `included`
 * in the same request body. That indirection is what lets a single POST declare
 * several scheduled prices at once.
 */
function manualPriceEntry(params: {
  localId: string;
  priceType: 'appPrices' | 'inAppPurchasePrices';
  pointType: 'appPricePoints' | 'inAppPurchasePricePoints';
  pointRelationship: 'appPricePoint' | 'inAppPurchasePricePoint';
  pricePointId: string;
  startDate?: string;
  endDate?: string;
}) {
  return {
    id: params.localId,
    type: params.priceType,
    attributes: {
      // `null` means "no boundary" for Apple; `undefined` would be dropped.
      startDate: params.startDate ?? null,
      endDate: params.endDate ?? null,
    },
    relationships: {
      [params.pointRelationship]: {
        data: { type: params.pointType, id: params.pricePointId },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 1. App price points & price schedules
// ---------------------------------------------------------------------------

export const listAppPricePoints = defineTool<{
  appId: string;
  territory: string;
  aroundPrice?: number;
}>({
  name: 'list_app_price_points',
  description:
    "List the price tiers (opaque appPricePoint ids) Apple allows for an app in a given territory, with customer price and developer proceeds. Read-only — use it to inspect the ladder before calling set_app_price.",
  inputSchema: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'The App Store Connect app id' },
      territory: {
        type: 'string',
        description:
          "Territory id, Apple 3-letter code (e.g. 'USA', 'FRA', 'JPN'). 2-letter ISO codes are accepted for common countries. Run list_territories for the full list.",
      },
      aroundPrice: {
        type: 'number',
        description:
          'Optional. Only show the ~15 tiers closest to this customer price, instead of the whole ladder.',
      },
    },
    required: ['appId', 'territory'],
  },
  handler: async ({ appId, territory, aroundPrice }, client) => {
    const code = normalizeTerritory(territory);

    const { data } = await client.getAllPages<any>(`/v1/apps/${appId}/appPricePoints`, {
      query: { 'filter[territory]': code, limit: 200 },
      maxPages: 20,
    });

    if (data.length === 0) {
      return `No price points found for app ${appId} in ${code}.`;
    }

    const points: PricePoint[] = data
      .map((point: any) => ({
        id: point.id,
        rawCustomerPrice: String(point.attributes?.customerPrice ?? ''),
        customerPrice: Number.parseFloat(point.attributes?.customerPrice ?? 'NaN'),
        proceeds: Number.parseFloat(point.attributes?.proceeds ?? 'NaN'),
      }))
      .filter((point: PricePoint) => Number.isFinite(point.customerPrice))
      .sort((a: PricePoint, b: PricePoint) => a.customerPrice - b.customerPrice);

    let shown = points;
    let note = '';

    if (aroundPrice !== undefined) {
      const nearestIndex = points.reduce(
        (best, point, index) =>
          Math.abs(point.customerPrice - aroundPrice) <
          Math.abs(points[best].customerPrice - aroundPrice)
            ? index
            : best,
        0
      );
      shown = points.slice(Math.max(0, nearestIndex - 7), nearestIndex + 8);
      note = `Showing the ${shown.length} tiers closest to ${aroundPrice}.`;
    } else if (points.length > UNFILTERED_PRICE_POINT_LIMIT) {
      // Apple's ladder is ~670-800 tiers per territory. Printing it whole is
      // tens of thousands of characters of noise, so the low end (where almost
      // every app sits) is shown and the rest summarised.
      shown = points.slice(0, UNFILTERED_PRICE_POINT_LIMIT);
      note =
        `Only the ${UNFILTERED_PRICE_POINT_LIMIT} cheapest tiers are listed; the ladder runs up to ` +
        `${points[points.length - 1].rawCustomerPrice}. Pass aroundPrice to zoom in on a specific amount.`;
    }

    return `💲 Price points for app ${appId} in ${code} (${shown.length} of ${points.length} tiers):

${shown
  .map(
    (point) =>
      `• ${point.rawCustomerPrice} — proceeds ${
        Number.isFinite(point.proceeds) ? point.proceeds : 'n/a'
      } — id ${point.id}`
  )
  .join('\n')}
${note ? `\n${note}` : ''}
Pass the customer price you want to set_app_price; it resolves the id for you.`;
  },
});

export const setAppPrice = defineTool<{
  appId: string;
  price: number;
  baseTerritory: string;
  startDate?: string;
  confirm?: boolean;
}>({
  name: 'set_app_price',
  description:
    '⚠️ CHANGES THE PUBLIC PRICE OF THE APP in every App Store territory. Takes a customer price in the base territory currency (0 = free), resolves Apple\'s closest price point and applies a new price schedule. Requires confirm: true.',
  inputSchema: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'The App Store Connect app id' },
      price: {
        type: 'number',
        description:
          "Customer price in the base territory's currency, e.g. 4.99. Use 0 to make the app free. Apple only sells fixed tiers, so the closest tier is applied and reported back.",
        minimum: 0,
      },
      baseTerritory: {
        type: 'string',
        description:
          "Territory the price is expressed in; Apple equalises every other territory from it. Apple 3-letter code (e.g. 'USA', 'FRA'). 2-letter ISO codes accepted for common countries.",
      },
      startDate: {
        type: 'string',
        description:
          'Optional ISO date (YYYY-MM-DD) for a future price change. Omit to apply the new price immediately.',
      },
      confirm: {
        type: 'boolean',
        description:
          'Must be true. Acknowledges that the new price becomes visible to customers on the App Store.',
      },
    },
    required: ['appId', 'price', 'baseTerritory', 'confirm'],
  },
  handler: async ({ appId, price, baseTerritory, startDate, confirm }, client) => {
    requireConfirmation(confirm, `changing the public price of app ${appId}`);
    assertIsoDate(startDate, 'startDate');

    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`price must be a non-negative number (got ${price}).`);
    }

    const territory = normalizeTerritory(baseTerritory);
    const result = await findClosestPricePoint(
      client,
      `/v1/apps/${appId}/appPricePoints`,
      territory,
      price
    );

    const localId = '${price0}';

    await client.post('/v1/appPriceSchedules', {
      data: {
        type: 'appPriceSchedules',
        relationships: {
          app: { data: { type: 'apps', id: appId } },
          baseTerritory: { data: { type: 'territories', id: territory } },
          manualPrices: { data: [{ type: 'appPrices', id: localId }] },
        },
      },
      included: [
        manualPriceEntry({
          localId,
          priceType: 'appPrices',
          pointType: 'appPricePoints',
          pointRelationship: 'appPricePoint',
          pricePointId: result.chosen.id,
          startDate,
        }),
      ],
    });

    const free = result.chosen.customerPrice === 0;

    return `✅ New price schedule applied to app ${appId}.

${describePricePoint(territory, price, result)}
• Base territory: ${territory} (all other territories are equalised by Apple)
• Effective: ${startDate ? `from ${startDate}` : 'immediately'}
${free ? '• The app is now FREE.\n' : ''}
This price is live for customers. Run get_app_pricing to see the per-territory result.`;
  },
});

export const scheduleAppPricePromotion = defineTool<{
  appId: string;
  promoPrice: number;
  basePrice: number;
  baseTerritory: string;
  startDate: string;
  endDate: string;
  confirm?: boolean;
}>({
  name: 'schedule_app_price_promotion',
  description:
    '⚠️ Schedules a temporary public price drop (sale) for an app, then restores the base price. Writes a price schedule holding both prices. Requires confirm: true.',
  inputSchema: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'The App Store Connect app id' },
      promoPrice: {
        type: 'number',
        description: 'Discounted customer price during the window (0 = free promo).',
        minimum: 0,
      },
      basePrice: {
        type: 'number',
        description:
          'Regular customer price applied before and after the promo window. Must be stated explicitly so the schedule is unambiguous.',
        minimum: 0,
      },
      baseTerritory: {
        type: 'string',
        description: "Territory both prices are expressed in (Apple 3-letter code, e.g. 'USA').",
      },
      startDate: { type: 'string', description: 'First day of the promo, ISO YYYY-MM-DD.' },
      endDate: { type: 'string', description: 'Last day of the promo, ISO YYYY-MM-DD.' },
      confirm: {
        type: 'boolean',
        description: 'Must be true. The discounted price becomes publicly visible on startDate.',
      },
    },
    required: ['appId', 'promoPrice', 'basePrice', 'baseTerritory', 'startDate', 'endDate', 'confirm'],
  },
  handler: async (
    { appId, promoPrice, basePrice, baseTerritory, startDate, endDate, confirm },
    client
  ) => {
    requireConfirmation(confirm, `scheduling a public price promotion for app ${appId}`);
    assertIsoDate(startDate, 'startDate');
    assertIsoDate(endDate, 'endDate');

    if (startDate >= endDate) {
      throw new Error(`startDate (${startDate}) must be strictly before endDate (${endDate}).`);
    }

    const territory = normalizeTerritory(baseTerritory);
    const path = `/v1/apps/${appId}/appPricePoints`;

    const base = await findClosestPricePoint(client, path, territory, basePrice);
    const promo = await findClosestPricePoint(client, path, territory, promoPrice);

    const baseLocalId = '${base0}';
    const promoLocalId = '${promo0}';

    await client.post('/v1/appPriceSchedules', {
      data: {
        type: 'appPriceSchedules',
        relationships: {
          app: { data: { type: 'apps', id: appId } },
          baseTerritory: { data: { type: 'territories', id: territory } },
          manualPrices: {
            data: [
              { type: 'appPrices', id: baseLocalId },
              { type: 'appPrices', id: promoLocalId },
            ],
          },
        },
      },
      included: [
        // Open-ended baseline price.
        manualPriceEntry({
          localId: baseLocalId,
          priceType: 'appPrices',
          pointType: 'appPricePoints',
          pointRelationship: 'appPricePoint',
          pricePointId: base.chosen.id,
        }),
        // Promo window overrides the baseline between the two dates.
        manualPriceEntry({
          localId: promoLocalId,
          priceType: 'appPrices',
          pointType: 'appPricePoints',
          pointRelationship: 'appPricePoint',
          pricePointId: promo.chosen.id,
          startDate,
          endDate,
        }),
      ],
    });

    return `✅ Price promotion scheduled for app ${appId} (${startDate} → ${endDate}).

Promo price:
${describePricePoint(territory, promoPrice, promo)}

Base price (before and after the window):
${describePricePoint(territory, basePrice, base)}

The discount becomes publicly visible on ${startDate}.`;
  },
});

// ---------------------------------------------------------------------------
// 2. In-app purchases
// ---------------------------------------------------------------------------

const IAP_TYPES = ['CONSUMABLE', 'NON_CONSUMABLE', 'NON_RENEWING_SUBSCRIPTION'];

export const createInAppPurchase = defineTool<{
  appId: string;
  name: string;
  productId: string;
  inAppPurchaseType: string;
  reviewNote?: string;
  familySharable?: boolean;
}>({
  name: 'create_in_app_purchase',
  description:
    'Create an in-app purchase on an app (App Store Connect API v2). The product id is permanent and can never be reused, even after deletion.',
  inputSchema: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'The App Store Connect app id' },
      name: {
        type: 'string',
        description: 'Reference name, internal to App Store Connect (max 64 characters).',
      },
      productId: {
        type: 'string',
        description:
          'Product identifier used by StoreKit, e.g. "com.example.app.pro". PERMANENT: it cannot be changed or reused later.',
      },
      inAppPurchaseType: {
        type: 'string',
        enum: IAP_TYPES,
        description:
          'CONSUMABLE (can be bought repeatedly), NON_CONSUMABLE (bought once, permanent), NON_RENEWING_SUBSCRIPTION (fixed-duration, no auto-renew). Auto-renewable subscriptions use a different API and are not covered here.',
      },
      reviewNote: {
        type: 'string',
        description: 'Optional note for App Review explaining how to test the purchase.',
      },
      familySharable: {
        type: 'boolean',
        description: 'Optional. Whether the purchase is shared through Family Sharing.',
      },
      // No `availableInAllTerritories`: it is not part of Apple's
      // InAppPurchaseV2CreateRequest. Territory availability is a separate
      // `inAppPurchaseAvailabilities` resource, created after the purchase.
    },
    required: ['appId', 'name', 'productId', 'inAppPurchaseType'],
  },
  handler: async ({ appId, name, productId, inAppPurchaseType, reviewNote, familySharable }, client) => {
    const type = inAppPurchaseType.trim().toUpperCase();
    if (!IAP_TYPES.includes(type)) {
      throw new Error(`inAppPurchaseType must be one of ${IAP_TYPES.join(', ')} (got "${inAppPurchaseType}").`);
    }

    const response = await client.post('/v2/inAppPurchases', {
      data: {
        type: 'inAppPurchases',
        attributes: {
          name,
          productId,
          inAppPurchaseType: type,
          reviewNote,
          familySharable,
        },
        relationships: {
          app: { data: { type: 'apps', id: appId } },
        },
      },
    });

    const iap = response?.data;

    return `✅ In-app purchase created on app ${appId}.

• Name: ${iap?.attributes?.name ?? name}
• Product ID: ${iap?.attributes?.productId ?? productId} (permanent)
• Type: ${iap?.attributes?.inAppPurchaseType ?? type}
• State: ${iap?.attributes?.state ?? 'unknown'}
• IAP id: ${iap?.id ?? 'unknown'}

Next steps: set_in_app_purchase_localization (name + description shown to customers), set_in_app_purchase_price, then submit_in_app_purchase_for_review.`;
  },
});

export const updateInAppPurchase = defineTool<{
  inAppPurchaseId: string;
  name?: string;
  reviewNote?: string;
  familySharable?: boolean;
}>({
  name: 'update_in_app_purchase',
  description:
    'Update the editable attributes of an in-app purchase (reference name, review note, family sharing). The product id and the purchase type are immutable.',
  inputSchema: {
    type: 'object',
    properties: {
      inAppPurchaseId: { type: 'string', description: 'The in-app purchase id' },
      name: { type: 'string', description: 'New internal reference name (max 64 characters).' },
      reviewNote: { type: 'string', description: 'New note for App Review.' },
      familySharable: { type: 'boolean', description: 'Enable or disable Family Sharing.' },
      // No `availableInAllTerritories`: not part of InAppPurchaseV2UpdateRequest.
    },
    required: ['inAppPurchaseId'],
  },
  handler: async ({ inAppPurchaseId, name, reviewNote, familySharable }, client) => {
    const attributes: Record<string, unknown> = {};
    if (name !== undefined) attributes.name = name;
    if (reviewNote !== undefined) attributes.reviewNote = reviewNote;
    if (familySharable !== undefined) attributes.familySharable = familySharable;

    if (Object.keys(attributes).length === 0) {
      throw new Error(
        'Nothing to update: provide at least one of name, reviewNote, familySharable.'
      );
    }

    const response = await client.patch(`/v2/inAppPurchases/${inAppPurchaseId}`, {
      data: {
        type: 'inAppPurchases',
        id: inAppPurchaseId,
        attributes,
      },
    });

    const iap = response?.data;

    return `✅ In-app purchase ${inAppPurchaseId} updated.

• Name: ${iap?.attributes?.name ?? '(unchanged)'}
• Product ID: ${iap?.attributes?.productId ?? 'unknown'}
• State: ${iap?.attributes?.state ?? 'unknown'}
• Updated fields: ${Object.keys(attributes).join(', ')}`;
  },
});

export const deleteInAppPurchase = defineTool<{
  inAppPurchaseId: string;
  confirm?: boolean;
}>({
  name: 'delete_in_app_purchase',
  description:
    '⚠️ DESTRUCTIVE AND IRREVERSIBLE. Deletes an in-app purchase; its product id can never be reused, and customers lose the product. Only works while the purchase has not been approved/sold. Requires confirm: true.',
  inputSchema: {
    type: 'object',
    properties: {
      inAppPurchaseId: { type: 'string', description: 'The in-app purchase id to delete' },
      confirm: {
        type: 'boolean',
        description:
          'Must be true. Acknowledges the deletion is permanent and the product id is burned forever.',
      },
    },
    required: ['inAppPurchaseId', 'confirm'],
  },
  handler: async ({ inAppPurchaseId, confirm }, client) => {
    requireConfirmation(confirm, `deleting in-app purchase ${inAppPurchaseId}`);

    await client.delete(`/v2/inAppPurchases/${inAppPurchaseId}`);

    return `🗑️ In-app purchase ${inAppPurchaseId} deleted. This cannot be undone and its product id is now permanently unusable.`;
  },
});

export const setInAppPurchaseLocalization = defineTool<{
  inAppPurchaseId: string;
  locale: string;
  name: string;
  description?: string;
}>({
  name: 'set_in_app_purchase_localization',
  description:
    'Create or update the customer-facing display name and description of an in-app purchase for one locale. This text is shown in the App Store and in StoreKit purchase sheets.',
  inputSchema: {
    type: 'object',
    properties: {
      inAppPurchaseId: { type: 'string', description: 'The in-app purchase id' },
      locale: {
        type: 'string',
        description:
          "App Store locale code, e.g. 'en-US', 'fr-FR', 'de-DE', 'ja', 'es-ES', 'pt-BR', 'zh-Hans'.",
      },
      name: {
        type: 'string',
        description: 'Display name shown to customers in this locale (max 30 characters).',
      },
      description: {
        type: 'string',
        description: 'Description shown to customers in this locale (max 45 characters).',
      },
    },
    required: ['inAppPurchaseId', 'locale', 'name'],
  },
  handler: async ({ inAppPurchaseId, locale, name, description }, client) => {
    // Apple rejects a POST for an existing locale, so mirror the read-then-write
    // pattern already used for App Store version localizations.
    const { data: existing } = await client.getAllPages<any>(
      `/v2/inAppPurchases/${inAppPurchaseId}/inAppPurchaseLocalizations`,
      { query: { limit: 200 } }
    );

    const match = existing.find((loc: any) => loc.attributes?.locale === locale);

    if (match) {
      await client.patch(`/v1/inAppPurchaseLocalizations/${match.id}`, {
        data: {
          type: 'inAppPurchaseLocalizations',
          id: match.id,
          attributes: { name, description },
        },
      });

      return `✅ Updated the ${locale} localization of in-app purchase ${inAppPurchaseId}.

• Name: ${name}
• Description: ${description ?? '(unchanged)'}
• Localization id: ${match.id}`;
    }

    const response = await client.post('/v1/inAppPurchaseLocalizations', {
      data: {
        type: 'inAppPurchaseLocalizations',
        attributes: { locale, name, description },
        relationships: {
          inAppPurchaseV2: { data: { type: 'inAppPurchases', id: inAppPurchaseId } },
        },
      },
    });

    return `✅ Created the ${locale} localization of in-app purchase ${inAppPurchaseId}.

• Name: ${name}
• Description: ${description ?? '(none)'}
• Localization id: ${response?.data?.id ?? 'unknown'}`;
  },
});

export const setInAppPurchasePrice = defineTool<{
  inAppPurchaseId: string;
  price: number;
  baseTerritory: string;
  startDate?: string;
  confirm?: boolean;
}>({
  name: 'set_in_app_purchase_price',
  description:
    "⚠️ CHANGES THE PUBLIC PRICE OF AN IN-APP PURCHASE in every territory. Takes a customer price in the base territory currency, resolves Apple's closest price point and applies a price schedule. Requires confirm: true.",
  inputSchema: {
    type: 'object',
    properties: {
      inAppPurchaseId: { type: 'string', description: 'The in-app purchase id' },
      price: {
        type: 'number',
        description:
          "Customer price in the base territory's currency, e.g. 2.99. Apple only sells fixed tiers, so the closest tier is applied and reported back.",
        minimum: 0,
      },
      baseTerritory: {
        type: 'string',
        description:
          "Territory the price is expressed in; every other territory is equalised from it. Apple 3-letter code (e.g. 'USA', 'FRA').",
      },
      startDate: {
        type: 'string',
        description: 'Optional ISO date (YYYY-MM-DD) for a future price change. Omit to apply now.',
      },
      confirm: {
        type: 'boolean',
        description: 'Must be true. Acknowledges the new price is immediately visible to customers.',
      },
    },
    required: ['inAppPurchaseId', 'price', 'baseTerritory', 'confirm'],
  },
  handler: async ({ inAppPurchaseId, price, baseTerritory, startDate, confirm }, client) => {
    requireConfirmation(confirm, `changing the public price of in-app purchase ${inAppPurchaseId}`);
    assertIsoDate(startDate, 'startDate');

    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`price must be a non-negative number (got ${price}).`);
    }

    const territory = normalizeTerritory(baseTerritory);
    const result = await findClosestPricePoint(
      client,
      `/v2/inAppPurchases/${inAppPurchaseId}/pricePoints`,
      territory,
      price
    );

    const localId = '${price0}';

    await client.post('/v1/inAppPurchasePriceSchedules', {
      data: {
        type: 'inAppPurchasePriceSchedules',
        relationships: {
          inAppPurchase: { data: { type: 'inAppPurchases', id: inAppPurchaseId } },
          baseTerritory: { data: { type: 'territories', id: territory } },
          manualPrices: { data: [{ type: 'inAppPurchasePrices', id: localId }] },
        },
      },
      included: [
        manualPriceEntry({
          localId,
          priceType: 'inAppPurchasePrices',
          pointType: 'inAppPurchasePricePoints',
          pointRelationship: 'inAppPurchasePricePoint',
          pricePointId: result.chosen.id,
          startDate,
        }),
      ],
    });

    return `✅ New price schedule applied to in-app purchase ${inAppPurchaseId}.

${describePricePoint(territory, price, result)}
• Base territory: ${territory} (all other territories are equalised by Apple)
• Effective: ${startDate ? `from ${startDate}` : 'immediately'}

This price is live for customers.`;
  },
});

export const submitInAppPurchaseForReview = defineTool<{
  inAppPurchaseId: string;
  confirm?: boolean;
}>({
  name: 'submit_in_app_purchase_for_review',
  description:
    '⚠️ Submits an in-app purchase to App Review. Once submitted it is locked for editing and, if approved, becomes purchasable by customers. Requires confirm: true.',
  inputSchema: {
    type: 'object',
    properties: {
      inAppPurchaseId: { type: 'string', description: 'The in-app purchase id to submit' },
      confirm: {
        type: 'boolean',
        description:
          'Must be true. Acknowledges the purchase goes to Apple review and will go on sale if approved.',
      },
    },
    required: ['inAppPurchaseId', 'confirm'],
  },
  handler: async ({ inAppPurchaseId, confirm }, client) => {
    requireConfirmation(confirm, `submitting in-app purchase ${inAppPurchaseId} to App Review`);

    const response = await client.post('/v1/inAppPurchaseSubmissions', {
      data: {
        type: 'inAppPurchaseSubmissions',
        relationships: {
          inAppPurchaseV2: { data: { type: 'inAppPurchases', id: inAppPurchaseId } },
        },
      },
    });

    return `📤 In-app purchase ${inAppPurchaseId} submitted to App Review.

• Submission id: ${response?.data?.id ?? 'unknown'}
• The purchase is now locked for editing until Apple reviews it.
Run get_in_app_purchases to follow its state.`;
  },
});

// ---------------------------------------------------------------------------
// 3. Territory availability
// ---------------------------------------------------------------------------

export const listTerritories = defineTool<{ search?: string }>({
  name: 'list_territories',
  description:
    'List every App Store territory with its Apple 3-letter id and currency. Read-only reference for the territory ids expected by the pricing and availability tools.',
  inputSchema: {
    type: 'object',
    properties: {
      search: {
        type: 'string',
        description: 'Optional case-insensitive filter on the territory id or currency (e.g. "EUR", "FR").',
      },
    },
  },
  handler: async ({ search }, client) => {
    const { data } = await client.getAllPages<any>('/v1/territories', {
      query: { limit: 200 },
      maxPages: 10,
    });

    const needle = search?.trim().toUpperCase();
    const rows = data
      .map((territory: any) => ({
        id: territory.id as string,
        currency: (territory.attributes?.currency as string) ?? '?',
      }))
      .filter((row: { id: string; currency: string }) =>
        needle ? row.id.includes(needle) || row.currency.includes(needle) : true
      )
      .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));

    if (rows.length === 0) {
      return `No territory matches "${search}".`;
    }

    return `🌍 App Store territories (${rows.length}${needle ? ` matching "${needle}"` : ''}):

${rows.map((row: { id: string; currency: string }) => `${row.id} (${row.currency})`).join(' · ')}`;
  },
});

/**
 * Id of the `territoryAvailabilities` resource pairing one app with one
 * territory.
 *
 * Apple's ids on that resource are not opaque: they are the base64 of
 * `{"s":"<appId>","t":"<TERRITORY>"}`, unpadded. Verified against the live API —
 * `GET /v2/appAvailabilities/{appId}/territoryAvailabilities` returns
 * `eyJzIjoiNjczODcyODkzOCIsInQiOiJGUkEifQ` for FRA on app 6738728938, which is
 * exactly what this function builds.
 *
 * This matters because `AppAvailabilityV2CreateRequest` accepts inline
 * `territoryAvailabilities` entries made of `{ type, id }` only — no attributes,
 * no `territory` relationship — so the id is the *only* way to name a territory
 * in the write payload.
 */
function territoryAvailabilityId(appId: string, territory: string): string {
  return Buffer.from(JSON.stringify({ s: appId, t: territory }))
    .toString('base64')
    .replace(/=+$/, '');
}

/** Current availability record id + the territories currently switched on. */
async function readCurrentAvailability(
  client: AppStoreClient,
  appId: string
): Promise<{ availabilityId?: string; territories: string[]; availableInNewTerritories?: boolean }> {
  const availability = await client.getAppAvailability(appId);

  if (!availability) {
    return { availabilityId: undefined, territories: [] };
  }

  return {
    availabilityId: availability.id,
    territories: availability.territories,
    availableInNewTerritories: availability.availableInNewTerritories,
  };
}

/**
 * Write a full territory list.
 *
 * `POST /v2/appAvailabilities` is the only endpoint that exists: the v1
 * resource is gone, and the API answers
 * `404 The resource 'v1/appAvailabilities' does not exist` — verified live, so
 * the former v1 fallback was dead code that could only turn a real v2 error
 * into a misleading one. Nothing is retried here on purpose.
 *
 * Each territory is declared twice, as Apple's JSON:API inline-create expects:
 * once in `data.relationships.territoryAvailabilities.data` and once in
 * `included`, both times as `{ type: 'territoryAvailabilities', id }` with the
 * deterministic id built by `territoryAvailabilityId`.
 */
async function writeAvailability(
  client: AppStoreClient,
  appId: string,
  territories: string[],
  availableInNewTerritories: boolean
): Promise<void> {
  const refs = territories.map((territory) => ({
    type: 'territoryAvailabilities' as const,
    id: territoryAvailabilityId(appId, territory),
  }));

  await client.post('/v2/appAvailabilities', {
    data: {
      type: 'appAvailabilities',
      attributes: { availableInNewTerritories },
      relationships: {
        app: { data: { type: 'apps', id: appId } },
        territoryAvailabilities: { data: refs },
      },
    },
    included: refs,
  });
}

export const setAppTerritories = defineTool<{
  appId: string;
  territories: string[];
  availableInNewTerritories?: boolean;
  confirm?: boolean;
}>({
  name: 'set_app_territories',
  description:
    '⚠️ REPLACES the full list of App Store territories where the app is sold. Any territory not in the list is delisted immediately. Prefer update_app_territories for an add/remove delta. Requires confirm: true.',
  inputSchema: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'The App Store Connect app id' },
      territories: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description:
          "Complete list of territories the app must be available in, as Apple 3-letter ids (e.g. ['USA','FRA','DEU']). 2-letter ISO codes accepted for common countries. THIS IS A REPLACEMENT, not an addition.",
      },
      availableInNewTerritories: {
        type: 'boolean',
        description:
          'Whether the app is automatically offered in territories Apple opens in the future. Defaults to false.',
      },
      confirm: {
        type: 'boolean',
        description:
          'Must be true. Acknowledges that omitted territories are delisted and the app disappears from those stores.',
      },
    },
    required: ['appId', 'territories', 'confirm'],
  },
  handler: async ({ appId, territories, availableInNewTerritories, confirm }, client) => {
    requireConfirmation(confirm, `replacing the territory availability of app ${appId}`);

    if (!Array.isArray(territories) || territories.length === 0) {
      throw new Error('territories must contain at least one territory id.');
    }

    const wanted = normalizeTerritories(territories);
    const current = await readCurrentAvailability(client, appId);
    const removed = current.territories.filter((code) => !wanted.includes(code));
    const added = wanted.filter((code) => !current.territories.includes(code));

    await writeAvailability(client, appId, wanted, availableInNewTerritories ?? false);

    return `✅ Territory availability replaced for app ${appId}.

• Now available in ${wanted.length} territories.
• Added (${added.length}): ${added.join(', ') || 'none'}
• Removed / delisted (${removed.length}): ${removed.join(', ') || 'none'}
• Available in new territories: ${(availableInNewTerritories ?? false) ? 'yes' : 'no'}

Removed territories no longer show the app on the App Store.`;
  },
});

export const updateAppTerritories = defineTool<{
  appId: string;
  add?: string[];
  remove?: string[];
  availableInNewTerritories?: boolean;
  confirm?: boolean;
}>({
  name: 'update_app_territories',
  description:
    "⚠️ Adds and/or removes App Store territories for an app without re-listing all 175 of them: reads the current availability, applies the delta, writes it back. Removing a territory delists the app there immediately. Requires confirm: true.",
  inputSchema: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'The App Store Connect app id' },
      add: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Territories to start selling in, as Apple 3-letter ids (e.g. ['JPN','KOR']). 2-letter ISO codes accepted for common countries.",
      },
      remove: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Territories to stop selling in. The app is delisted there as soon as the change propagates.',
      },
      availableInNewTerritories: {
        type: 'boolean',
        description:
          'Optional. Whether the app is automatically offered in territories Apple opens later. Left unchanged when omitted.',
      },
      confirm: {
        type: 'boolean',
        description: 'Must be true. Acknowledges the publicly visible listing/delisting.',
      },
    },
    required: ['appId', 'confirm'],
  },
  handler: async ({ appId, add, remove, availableInNewTerritories, confirm }, client) => {
    requireConfirmation(confirm, `changing the territory availability of app ${appId}`);

    const toAdd = normalizeTerritories(add ?? []);
    const toRemove = normalizeTerritories(remove ?? []);

    if (toAdd.length === 0 && toRemove.length === 0) {
      throw new Error('Nothing to do: provide at least one territory in "add" or "remove".');
    }

    const overlap = toAdd.filter((code) => toRemove.includes(code));
    if (overlap.length > 0) {
      throw new Error(`Territories listed in both add and remove: ${overlap.join(', ')}.`);
    }

    const current = await readCurrentAvailability(client, appId);

    if (current.territories.length === 0) {
      throw new Error(
        `Could not read the current territory list for app ${appId}. ` +
          `Use set_app_territories with the complete list instead of a delta.`
      );
    }

    const next = current.territories.filter((code) => !toRemove.includes(code));
    for (const code of toAdd) {
      if (!next.includes(code)) next.push(code);
    }

    if (next.length === 0) {
      throw new Error(
        'Refused: the delta would remove every territory, which would take the app off sale worldwide.'
      );
    }

    const actuallyAdded = toAdd.filter((code) => !current.territories.includes(code));
    const actuallyRemoved = toRemove.filter((code) => current.territories.includes(code));

    await writeAvailability(
      client,
      appId,
      next,
      availableInNewTerritories ?? current.availableInNewTerritories ?? false
    );

    return `✅ Territory availability updated for app ${appId}.

• Before: ${current.territories.length} territories → after: ${next.length}
• Added (${actuallyAdded.length}): ${actuallyAdded.join(', ') || 'none'}
• Removed / delisted (${actuallyRemoved.length}): ${actuallyRemoved.join(', ') || 'none'}
• Ignored (already in the requested state): ${
      [
        ...toAdd.filter((code) => current.territories.includes(code)),
        ...toRemove.filter((code) => !current.territories.includes(code)),
      ].join(', ') || 'none'
    }
• Available in new territories: ${
      (availableInNewTerritories ?? current.availableInNewTerritories ?? false) ? 'yes' : 'no'
    }`;
  },
});

export const pricingWriteTools: Tool[] = [
  listAppPricePoints,
  setAppPrice,
  scheduleAppPricePromotion,
  createInAppPurchase,
  updateInAppPurchase,
  deleteInAppPurchase,
  setInAppPurchaseLocalization,
  setInAppPurchasePrice,
  submitInAppPurchaseForReview,
  listTerritories,
  setAppTerritories,
  updateAppTerritories,
];
