/**
 * App Store Connect API client.
 *
 * Owns JWT (ES256) generation and every HTTP call to
 * https://api.appstoreconnect.apple.com.
 *
 * Two layers are exposed:
 *  1. Generic helpers — `get` / `post` / `patch` / `delete` / `getAllPages` —
 *     which handle auth, query building, pagination and Apple error parsing.
 *     New tools should be built on these.
 *  2. Domain helpers (listApps, getBuilds, ...) kept for the existing tools.
 */

import jwt from 'jsonwebtoken';
import { logger } from './logger.js';

export interface AppStoreConfig {
  keyId: string;
  issuerId: string;
  privateKey: string;
  bundleId: string;
  appStoreId?: string;
  /** Vendor number used by the sales/finance report endpoints. */
  vendorNumber?: string;
}

export interface AppInfo {
  /** Resource id, which is also the app's Apple ID (the numeric App Store id). */
  id: string;
  name: string;
  bundleId: string;
  /** Same value as `id`. Kept because callers know this concept as "App Store ID". */
  appStoreId?: string;
  sku?: string;
  primaryLocale?: string;
  /** Live state of the most recent version, when it could be resolved. */
  status: string;
  version?: string;
  platform?: string;
}

export interface SalesData {
  date: string;
  revenue: number;
  currency: string;
  transactionCount: number;
  units: number;
}

export interface AppStoreVersion {
  id: string;
  versionString: string;
  platform: string;
  appStoreState: string;
  releaseType?: string;
  earliestReleaseDate?: string;
  copyright?: string;
  createdDate: string;
}

/** Shape of a single entry in an Apple `{ errors: [...] }` payload. */
export interface AppleApiErrorDetail {
  id?: string;
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
  source?: unknown;
}

/**
 * Error thrown for any non-2xx response from App Store Connect.
 *
 * Apple returns `{ errors: [{ status, code, title, detail }] }`. The `detail`
 * field is the actionable one ("The provided entity includes an attribute with
 * a value that has already been used") — it is surfaced as the message.
 */
export class AppStoreApiError extends Error {
  readonly httpStatus: number;
  readonly errors: AppleApiErrorDetail[];
  readonly method: string;
  readonly path: string;

  constructor(params: {
    httpStatus: number;
    errors: AppleApiErrorDetail[];
    method: string;
    path: string;
    fallbackBody?: string;
  }) {
    super(AppStoreApiError.buildMessage(params));
    this.name = 'AppStoreApiError';
    this.httpStatus = params.httpStatus;
    this.errors = params.errors;
    this.method = params.method;
    this.path = params.path;
  }

  /** First Apple error code, when present (e.g. "ENTITY_ERROR.ATTRIBUTE.INVALID"). */
  get code(): string | undefined {
    return this.errors[0]?.code;
  }

  private static buildMessage(params: {
    httpStatus: number;
    errors: AppleApiErrorDetail[];
    method: string;
    path: string;
    fallbackBody?: string;
  }): string {
    const prefix = `App Store Connect API error ${params.httpStatus} on ${params.method} ${params.path}`;

    if (params.errors.length === 0) {
      const body = (params.fallbackBody || '').trim();
      return body ? `${prefix}: ${body}` : prefix;
    }

    const details = params.errors
      .map((err) => {
        // `detail` carries the actionable explanation; `title` is generic.
        const message = err.detail || err.title || 'Unknown error';
        return err.code ? `${message} (${err.code})` : message;
      })
      .join('; ');

    return `${prefix}: ${details}`;
  }
}

/** Query parameters. Arrays are joined with commas, as Apple's API expects. */
export type QueryParams = Record<string, string | number | boolean | Array<string | number> | undefined>;

export interface RequestOptions {
  query?: QueryParams;
  /** Extra headers merged on top of Authorization / Content-Type. */
  headers?: Record<string, string>;
}

/** Minimal shape of a JSON:API response from App Store Connect. */
export interface AppStoreResponse<T = any> {
  data: T;
  included?: any[];
  links?: { self?: string; next?: string; first?: string };
  meta?: { paging?: { total?: number; limit?: number } };
}

export class AppStoreClient {
  private config: AppStoreConfig;
  private baseUrl = 'https://api.appstoreconnect.apple.com';

  constructor(config: AppStoreConfig) {
    this.config = {
      ...config,
      privateKey: config.privateKey.trim(),
    };
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  /**
   * Generate a short-lived ES256 JWT for App Store Connect.
   * Nothing about the key material is logged.
   */
  private generateToken(): string {
    try {
      const payload = {
        iss: this.config.issuerId,
        exp: Math.floor(Date.now() / 1000) + 20 * 60, // Apple caps token lifetime at 20 minutes
        aud: 'appstoreconnect-v1',
      };

      return jwt.sign(payload, this.config.privateKey, {
        algorithm: 'ES256',
        header: {
          alg: 'ES256',
          kid: this.config.keyId,
          typ: 'JWT',
        },
      });
    } catch (error: any) {
      // Do not include the error payload verbatim: some jsonwebtoken failures
      // echo back parts of the key material.
      logger.error('Failed to generate App Store Connect JWT.');
      throw new Error(`JWT generation failed: ${error?.message ?? 'unknown error'}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Generic HTTP helpers — build new tools on top of these
  // ---------------------------------------------------------------------------

  private buildUrl(path: string, query?: QueryParams): string {
    // Accept both an absolute URL (e.g. a `links.next` value) and a relative path.
    const url = path.startsWith('http') ? new URL(path) : new URL(path, this.baseUrl);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
      }
    }

    return url.toString();
  }

  /**
   * Perform an authenticated request and parse the response.
   * Throws `AppStoreApiError` (with Apple's `detail` message) on failure.
   */
  async request<T = any>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<T> {
    const token = this.generateToken();
    const url = this.buildUrl(path, options?.query);

    logger.debug(`${method} ${url}`);

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const rawBody = await response.text();
      let errors: AppleApiErrorDetail[] = [];

      try {
        const parsed = JSON.parse(rawBody);
        if (Array.isArray(parsed?.errors)) {
          errors = parsed.errors as AppleApiErrorDetail[];
        }
      } catch {
        // Non-JSON error body (HTML error page, gateway timeout, ...).
      }

      throw new AppStoreApiError({
        httpStatus: response.status,
        errors,
        method,
        path: url.replace(this.baseUrl, ''),
        fallbackBody: rawBody,
      });
    }

    // 204 No Content, typical for DELETE.
    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) return undefined as T;

    return JSON.parse(text) as T;
  }

  get<T = any>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, options);
  }

  post<T = any>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }

  patch<T = any>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, body, options);
  }

  delete<T = any>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  /**
   * Follow `links.next` until the collection is exhausted and return every
   * `data` entry, along with the merged `included` resources.
   *
   * `maxPages` guards against runaway loops on very large collections.
   */
  async getAllPages<T = any>(
    path: string,
    options?: RequestOptions & { maxPages?: number }
  ): Promise<{ data: T[]; included: any[] }> {
    const maxPages = options?.maxPages ?? 50;
    const data: T[] = [];
    const included: any[] = [];

    let nextPath: string | undefined = path;
    let query = options?.query;
    let page = 0;

    while (nextPath && page < maxPages) {
      const response: AppStoreResponse<T[]> = await this.get<AppStoreResponse<T[]>>(nextPath, {
        ...options,
        query,
      });

      if (Array.isArray(response?.data)) data.push(...response.data);
      if (Array.isArray(response?.included)) included.push(...response.included);

      // `links.next` is a fully-qualified URL that already carries the cursor,
      // so the initial query must not be re-applied.
      nextPath = response?.links?.next;
      query = undefined;
      page += 1;
    }

    if (nextPath) {
      logger.warn(`Pagination stopped after ${maxPages} pages for ${path}; more results exist.`);
    }

    return { data, included };
  }

  /**
   * `getAllPages` that treats a 404 as an empty collection.
   *
   * Several App Store Connect sub-resources answer
   * `404 There is no resource of type 'null'` instead of `{ data: [] }` when the
   * parent exists but holds nothing yet — price schedules with no price being
   * the usual case. Every other error still propagates.
   */
  async getPagesOrEmpty<T = any>(
    path: string,
    options?: RequestOptions & { maxPages?: number }
  ): Promise<{ data: T[]; included: any[] }> {
    try {
      return await this.getAllPages<T>(path, options);
    } catch (error) {
      if (error instanceof AppStoreApiError && error.httpStatus === 404) {
        return { data: [], included: [] };
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Domain helpers used by the shipped tools
  // ---------------------------------------------------------------------------

  /**
   * `appStoreState` and `platform` do not exist on the app resource: state lives
   * on `appStoreVersions` and platform is per-version too. We pull the newest
   * version alongside the app so callers get a real state instead of `undefined`.
   */
  private static toAppInfo(app: any, versionsById: Map<string, any>): AppInfo {
    const versionId = app.relationships?.appStoreVersions?.data?.[0]?.id;
    const version = versionId ? versionsById.get(versionId) : undefined;

    return {
      id: app.id,
      name: app.attributes.name,
      bundleId: app.attributes.bundleId,
      appStoreId: app.id,
      sku: app.attributes.sku,
      primaryLocale: app.attributes.primaryLocale,
      status: version?.attributes?.appStoreState ?? 'UNKNOWN',
      version: version?.attributes?.versionString,
      platform: version?.attributes?.platform,
    };
  }

  /** Index an `included` array by resource id for relationship resolution. */
  private static indexIncluded(included: any[] | undefined): Map<string, any> {
    return new Map((included || []).map((item: any) => [item.id, item]));
  }

  async listApps(): Promise<AppInfo[]> {
    const data = await this.get('/v1/apps', {
      query: { include: 'appStoreVersions', 'limit[appStoreVersions]': '1' },
    });
    const versionsById = AppStoreClient.indexIncluded(data.included);

    return data.data?.map((app: any) => AppStoreClient.toAppInfo(app, versionsById)) || [];
  }

  async getAppInfo(appId: string): Promise<AppInfo | null> {
    const data = await this.get(`/v1/apps/${appId}`, {
      query: { include: 'appStoreVersions', 'limit[appStoreVersions]': '1' },
    });
    const app = data.data;
    if (!app) return null;

    return AppStoreClient.toAppInfo(app, AppStoreClient.indexIncluded(data.included));
  }

  async getSalesData(date?: string): Promise<SalesData> {
    const targetDate = date || new Date().toISOString().split('T')[0];
    const vendorNumber = this.config.vendorNumber || this.config.issuerId;

    const data = await this.get('/v1/salesReports', {
      query: {
        'filter[frequency]': 'DAILY',
        'filter[reportDate]': targetDate,
        'filter[reportType]': 'SALES',
        'filter[vendorNumber]': vendorNumber,
      },
    });

    const totalRevenue =
      data.data?.reduce(
        (sum: number, item: any) => sum + parseFloat(item.attributes?.proceeds || 0),
        0
      ) || 0;

    const totalUnits =
      data.data?.reduce((sum: number, item: any) => sum + parseInt(item.attributes?.units || 0), 0) ||
      0;

    return {
      date: targetDate,
      revenue: totalRevenue,
      currency: 'USD',
      transactionCount: data.data?.length || 0,
      units: totalUnits,
    };
  }

  async getAnalytics(appId: string): Promise<any> {
    return this.get(`/v1/apps/${appId}/analyticsReportRequests`);
  }

  async getBuilds(appId: string): Promise<any[]> {
    const data = await this.get(`/v1/apps/${appId}/builds`);

    return (
      data.data?.map((build: any) => ({
        id: build.id,
        version: build.attributes.version,
        buildNumber: build.attributes.build,
        processingState: build.attributes.processingState,
        uploadedDate: build.attributes.uploadedDate,
      })) || []
    );
  }

  async listAppStoreVersions(appId: string): Promise<AppStoreVersion[]> {
    const response = await this.get(`/v1/apps/${appId}/appStoreVersions`);

    return (
      response.data?.map((version: any) => ({
        id: version.id,
        versionString: version.attributes.versionString,
        platform: version.attributes.platform,
        appStoreState: version.attributes.appStoreState,
        releaseType: version.attributes.releaseType,
        earliestReleaseDate: version.attributes.earliestReleaseDate,
        copyright: version.attributes.copyright,
        createdDate: version.attributes.createdDate,
      })) || []
    );
  }

  async listBetaGroups(appId: string): Promise<any[]> {
    const response = await this.get(`/v1/apps/${appId}/betaGroups`);

    return (
      response.data?.map((group: any) => ({
        id: group.id,
        name: group.attributes.name,
        isInternalGroup: group.attributes.isInternalGroup,
        publicLink: group.attributes.publicLink,
        publicLinkEnabled: group.attributes.publicLinkEnabled,
        publicLinkLimit: group.attributes.publicLinkLimit,
        publicLinkLimitEnabled: group.attributes.publicLinkLimitEnabled,
        createdDate: group.attributes.createdDate,
      })) || []
    );
  }

  async addTesterToBetaGroup(params: {
    groupId: string;
    email: string;
    firstName?: string;
    lastName?: string;
  }): Promise<any> {
    let testerId: string;

    try {
      const testerResponse = await this.post('/v1/betaTesters', {
        data: {
          type: 'betaTesters',
          attributes: {
            email: params.email,
            firstName: params.firstName,
            lastName: params.lastName,
          },
        },
      });
      testerId = testerResponse.data.id;
    } catch (error) {
      // The tester may already exist — look them up before giving up.
      const existingTesters = await this.get('/v1/betaTesters', {
        query: { 'filter[email]': params.email },
      });

      if (existingTesters.data?.length > 0) {
        testerId = existingTesters.data[0].id;
      } else {
        throw error;
      }
    }

    await this.post(`/v1/betaGroups/${params.groupId}/relationships/betaTesters`, {
      data: [{ type: 'betaTesters', id: testerId }],
    });

    return {
      success: true,
      testerId,
      groupId: params.groupId,
      email: params.email,
      message: `Successfully added ${params.email} to beta group`,
    };
  }

  async updateAppStoreVersionLocalization(params: {
    versionId: string;
    locale: string;
    description?: string;
    keywords?: string;
    whatsNew?: string;
    promotionalText?: string;
    supportUrl?: string;
    marketingUrl?: string;
  }): Promise<any> {
    const attributes = {
      description: params.description,
      keywords: params.keywords,
      whatsNew: params.whatsNew,
      promotionalText: params.promotionalText,
      supportUrl: params.supportUrl,
      marketingUrl: params.marketingUrl,
    };

    // Must paginate: a heavily localized app can exceed Apple's default page
    // size, and a missed locale here turns the update into a create, which then
    // fails as a duplicate.
    const existingData = await this.getAllPages(
      `/v1/appStoreVersions/${params.versionId}/appStoreVersionLocalizations`
    );
    const existingLocalization = existingData.data?.find(
      (loc: any) => loc.attributes.locale === params.locale
    );

    const response = existingLocalization
      ? await this.patch(`/v1/appStoreVersionLocalizations/${existingLocalization.id}`, {
          data: {
            type: 'appStoreVersionLocalizations',
            id: existingLocalization.id,
            attributes,
          },
        })
      : await this.post('/v1/appStoreVersionLocalizations', {
          data: {
            type: 'appStoreVersionLocalizations',
            attributes: { locale: params.locale, ...attributes },
            relationships: {
              appStoreVersion: {
                data: { type: 'appStoreVersions', id: params.versionId },
              },
            },
          },
        });

    return {
      id: response.data.id,
      locale: response.data.attributes.locale,
      description: response.data.attributes.description,
      keywords: response.data.attributes.keywords,
      whatsNew: response.data.attributes.whatsNew,
      promotionalText: response.data.attributes.promotionalText,
      supportUrl: response.data.attributes.supportUrl,
      marketingUrl: response.data.attributes.marketingUrl,
    };
  }

  async createAppStoreVersion(params: {
    appId: string;
    platform: string;
    versionString: string;
    copyright?: string;
    releaseType?: string;
    earliestReleaseDate?: string;
    buildId?: string;
  }): Promise<AppStoreVersion> {
    const relationships: Record<string, unknown> = {
      app: { data: { type: 'apps', id: params.appId } },
    };

    if (params.buildId) {
      relationships.build = { data: { type: 'builds', id: params.buildId } };
    }

    const response = await this.post('/v1/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes: {
          platform: params.platform,
          versionString: params.versionString,
          copyright: params.copyright,
          releaseType: params.releaseType || 'MANUAL',
          earliestReleaseDate: params.earliestReleaseDate,
        },
        relationships,
      },
    });

    const version = response.data;
    return {
      id: version.id,
      versionString: version.attributes.versionString,
      platform: version.attributes.platform,
      appStoreState: version.attributes.appStoreState,
      releaseType: version.attributes.releaseType,
      earliestReleaseDate: version.attributes.earliestReleaseDate,
      copyright: version.attributes.copyright,
      createdDate: version.attributes.createdDate,
    };
  }

  async getCustomerReviews(appId: string, limit: number = 50): Promise<any[]> {
    const data = await this.get(`/v1/apps/${appId}/customerReviews`, {
      query: { limit, sort: '-createdDate' },
    });

    return (
      data.data?.map((review: any) => ({
        id: review.id,
        rating: review.attributes.rating,
        title: review.attributes.title,
        body: review.attributes.body,
        reviewerNickname: review.attributes.reviewerNickname,
        territory: review.attributes.territory,
        createdDate: review.attributes.createdDate,
        lastModifiedDate: review.attributes.lastModifiedDate,
      })) || []
    );
  }

  /**
   * Read the price schedule of an app.
   *
   * `appPriceSchedules` carries **no attributes at all**: the base territory and
   * the prices are relationships, and Apple returns nothing in `included`
   * without an explicit `include=`. Worse, the `appPrices` resources themselves
   * only hold `manual/startDate/endDate` — the amount lives one hop further, on
   * the related `appPricePoint`. So this is a two-step read:
   *
   *   1. `/v1/apps/{id}/appPriceSchedule?include=baseTerritory`
   *      → base territory id, and its currency from `included`.
   *   2. `/v1/appPriceSchedules/{id}/manualPrices?include=appPricePoint,territory`
   *      → one entry per manually-set territory, with `customerPrice` and
   *        `proceeds` resolved from the included price points.
   *
   * Only manual prices are returned. `automaticPrices` holds the ~175 territories
   * Apple equalises from the base one; it is summarised as a count instead of
   * being dumped (see `automaticPriceCount`).
   *
   * Returns `null` when the app has no price schedule yet (Apple answers 404).
   */
  async getAppPricing(appId: string): Promise<any> {
    let schedule: AppStoreResponse;

    try {
      schedule = await this.get(`/v1/apps/${appId}/appPriceSchedule`, {
        query: { include: 'baseTerritory' },
      });
    } catch (error) {
      // An app that has never been priced has no schedule resource at all.
      if (error instanceof AppStoreApiError && error.httpStatus === 404) return null;
      throw error;
    }

    if (!schedule?.data) return null;

    const scheduleId: string = schedule.data.id;
    const baseTerritory: string | undefined =
      schedule.data.relationships?.baseTerritory?.data?.id;
    const currency: string | undefined = schedule.included?.find(
      (entry: any) => entry.type === 'territories' && entry.id === baseTerritory
    )?.attributes?.currency;

    // A schedule stub can exist with no price at all (app never priced): Apple
    // then answers 404 "no resource of type 'null'" on the sub-resource rather
    // than an empty collection.
    const { data: prices, included } = await this.getPagesOrEmpty(
      `/v1/appPriceSchedules/${scheduleId}/manualPrices`,
      { query: { include: 'appPricePoint,territory', limit: 200 }, maxPages: 5 }
    );

    const pricePoints = new Map<string, any>();
    const territories = new Map<string, any>();
    for (const entry of included) {
      if (entry.type === 'appPricePoints') pricePoints.set(entry.id, entry);
      if (entry.type === 'territories') territories.set(entry.id, entry);
    }

    // Cheap HEAD-ish probe: a limit=1 page tells us how many territories Apple
    // equalises without pulling all 175 of them.
    let automaticPriceCount: number | undefined;
    try {
      const automatic = await this.get(`/v1/appPriceSchedules/${scheduleId}/automaticPrices`, {
        query: { limit: 200 },
      });
      automaticPriceCount = automatic?.data?.length;
    } catch {
      // Non-fatal (404 when the app was never priced): manual prices are the
      // interesting part, and the count is only a hint.
    }

    return {
      id: scheduleId,
      baseTerritory,
      currency,
      automaticPriceCount,
      prices: prices.map((price: any) => {
        const territoryId: string | undefined = price.relationships?.territory?.data?.id;
        const point = pricePoints.get(price.relationships?.appPricePoint?.data?.id);

        return {
          territory: territoryId,
          currency: territories.get(territoryId ?? '')?.attributes?.currency,
          price: point?.attributes?.customerPrice,
          proceeds: point?.attributes?.proceeds,
          startDate: price.attributes?.startDate ?? undefined,
          endDate: price.attributes?.endDate ?? undefined,
        };
      }),
    };
  }

  /**
   * In-app purchases of an app (App Store Connect API v2).
   *
   * Note `availableInAllTerritories` is deliberately absent: it is not part of
   * the `InAppPurchaseV2` attribute set. Territory availability is a separate
   * resource, exposed through the `inAppPurchaseAvailability` relationship —
   * see `getInAppPurchaseAvailability`.
   */
  async getInAppPurchases(appId: string): Promise<any[]> {
    const { data } = await this.getAllPages<any>(`/v1/apps/${appId}/inAppPurchasesV2`, {
      query: { limit: 200 },
      maxPages: 10,
    });

    return data.map((iap: any) => ({
      id: iap.id,
      name: iap.attributes?.name,
      productId: iap.attributes?.productId,
      state: iap.attributes?.state,
      inAppPurchaseType: iap.attributes?.inAppPurchaseType,
      reviewNote: iap.attributes?.reviewNote,
      familySharable: iap.attributes?.familySharable,
      contentHosting: iap.attributes?.contentHosting,
    }));
  }

  /**
   * Price of one in-app purchase, resolved the same two-hop way as
   * `getAppPricing`: schedule → manual prices → price points.
   * Returns `null` when the purchase has no price schedule.
   */
  async getInAppPurchasePricing(inAppPurchaseId: string): Promise<any> {
    let schedule: AppStoreResponse;

    try {
      schedule = await this.get(`/v2/inAppPurchases/${inAppPurchaseId}/iapPriceSchedule`, {
        query: { include: 'baseTerritory' },
      });
    } catch (error) {
      if (error instanceof AppStoreApiError && error.httpStatus === 404) return null;
      throw error;
    }

    if (!schedule?.data) return null;

    const scheduleId: string = schedule.data.id;
    const baseTerritory: string | undefined =
      schedule.data.relationships?.baseTerritory?.data?.id;
    const currency: string | undefined = schedule.included?.find(
      (entry: any) => entry.type === 'territories' && entry.id === baseTerritory
    )?.attributes?.currency;

    const { data: prices, included } = await this.getPagesOrEmpty<any>(
      `/v1/inAppPurchasePriceSchedules/${scheduleId}/manualPrices`,
      { query: { include: 'inAppPurchasePricePoint,territory', limit: 200 }, maxPages: 5 }
    );

    const points = new Map<string, any>(
      included
        .filter((entry: any) => entry.type === 'inAppPurchasePricePoints')
        .map((entry: any) => [entry.id, entry])
    );

    const base = prices.find(
      (price: any) => price.relationships?.territory?.data?.id === baseTerritory
    );
    const point = points.get(base?.relationships?.inAppPurchasePricePoint?.data?.id);

    return {
      id: scheduleId,
      baseTerritory,
      currency,
      customerPrice: point?.attributes?.customerPrice,
      proceeds: point?.attributes?.proceeds,
      manualPriceCount: prices.length,
    };
  }

  /** Territory availability of one in-app purchase (`inAppPurchaseAvailabilities`). */
  async getInAppPurchaseAvailability(inAppPurchaseId: string): Promise<any> {
    try {
      const response = await this.get(
        `/v2/inAppPurchases/${inAppPurchaseId}/inAppPurchaseAvailability`
      );
      if (!response?.data) return null;

      return {
        id: response.data.id,
        availableInNewTerritories: response.data.attributes?.availableInNewTerritories,
      };
    } catch (error) {
      if (error instanceof AppStoreApiError && error.httpStatus === 404) return null;
      throw error;
    }
  }

  /**
   * Territory availability of an app.
   *
   * `appAvailabilities` only carries `availableInNewTerritories`; the territory
   * list is the `territoryAvailabilities` relationship, and it is **only**
   * reachable on the v2 resource — `/v1/appAvailabilities` answers
   * "The resource 'v1/appAvailabilities' does not exist". Even with
   * `?include=territoryAvailabilities`, the included entries come back without
   * their `territory` relationship, so the sub-resource has to be paged
   * explicitly with `include=territory`.
   */
  async getAppAvailability(appId: string): Promise<any> {
    let response: AppStoreResponse;

    try {
      response = await this.get(`/v1/apps/${appId}/appAvailabilityV2`);
    } catch (error) {
      if (error instanceof AppStoreApiError && error.httpStatus === 404) return null;
      throw error;
    }

    const availabilityId: string | undefined = response?.data?.id;
    if (!availabilityId) return null;

    const { data } = await this.getAllPages<any>(
      `/v2/appAvailabilities/${availabilityId}/territoryAvailabilities`,
      { query: { limit: 200, include: 'territory' }, maxPages: 10 }
    );

    const entries = data.map((entry: any) => ({
      territory: entry.relationships?.territory?.data?.id as string | undefined,
      available: entry.attributes?.available === true,
      releaseDate: entry.attributes?.releaseDate ?? undefined,
      preOrderEnabled: entry.attributes?.preOrderEnabled === true,
      contentStatuses: entry.attributes?.contentStatuses ?? [],
    }));

    const available = entries
      .filter((entry) => entry.available && entry.territory)
      .map((entry) => entry.territory as string)
      .sort();
    const unavailable = entries
      .filter((entry) => !entry.available && entry.territory)
      .map((entry) => entry.territory as string)
      .sort();

    return {
      id: availabilityId,
      availableInNewTerritories: response.data.attributes?.availableInNewTerritories,
      /** Territories the app is currently on sale in. */
      territories: available,
      unavailableTerritories: unavailable,
      totalTerritories: entries.length,
      /** Earliest release date seen, when Apple reports one. */
      releaseDate: entries.map((entry) => entry.releaseDate).filter(Boolean).sort()[0],
      entries,
    };
  }

  async getAppInfoDetails(appId: string): Promise<any> {
    const data = await this.get(`/v1/apps/${appId}/appInfos`);
    if (!data.data?.[0]) return null;

    const appInfo = data.data[0];
    return {
      id: appInfo.id,
      appStoreState: appInfo.attributes?.appStoreState,
      appStoreAgeRating: appInfo.attributes?.appStoreAgeRating,
      brazilAgeRating: appInfo.attributes?.brazilAgeRating,
      kidsAgeBand: appInfo.attributes?.kidsAgeBand,
      primaryCategory: appInfo.relationships?.primaryCategory?.data?.id,
      primarySubcategoryOne: appInfo.relationships?.primarySubcategoryOne?.data?.id,
      primarySubcategoryTwo: appInfo.relationships?.primarySubcategoryTwo?.data?.id,
      secondaryCategory: appInfo.relationships?.secondaryCategory?.data?.id,
      secondarySubcategoryOne: appInfo.relationships?.secondarySubcategoryOne?.data?.id,
      secondarySubcategoryTwo: appInfo.relationships?.secondarySubcategoryTwo?.data?.id,
    };
  }
}

/** @deprecated Use `AppStoreClient`. Kept so older imports keep resolving. */
export { AppStoreClient as AppStoreConnectClient };
