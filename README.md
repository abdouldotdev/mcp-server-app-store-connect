# mcp-server-app-store-connect

An MCP server that gives Claude real access to the App Store Connect API: read your
listings, audit every localization, upload screenshots for a dozen languages in one
call, submit for review, manage pricing and answer customer reviews — without leaving
the conversation.

**86 tools** across apps, versions, localizations, screenshots, review submission,
phased release, customer reviews, pricing, in-app purchases, territories and code
signing.

## Why this exists

Doing App Store release work by hand means clicking through the same forms once per
language, per device size, per app. The API can do all of it, but its resource model is
unfriendly — prices hide behind opaque `appPricePoint` ids, screenshots need a
three-step reserve/upload/commit dance, and half the useful filters are undocumented.

This server hides that. You give it a price in euros and a country code; it finds the
price tier. You give it a directory of PNGs; it validates the dimensions, creates the
sets and uploads them in the right order.

## Install

```bash
git clone https://github.com/Prodevking1/mcp-server-app-store-connect.git
cd mcp-server-app-store-connect
npm install && npm run build
```

Create a `.env` next to the server (see `.env.example`):

```ini
APPLE_KEY_ID=ABC123DEFG
APPLE_ISSUER_ID=00000000-0000-0000-0000-000000000000
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
...contents of your AuthKey_XXXXXX.p8...
-----END PRIVATE KEY-----"
APPLE_BUNDLE_ID=com.example.app
```

Generate the key at **App Store Connect → Users and Access → Integrations → App Store
Connect API**. The `.p8` file downloads only once. An **App Manager + Sales and Reports**
key covers everything except the code signing tools, which need **Admin** or
**Developer**.

Register the server (the `cd` matters — credentials are read from the working
directory):

```bash
claude mcp add appstore-connect -s user -- \
  sh -c 'cd /absolute/path/to/mcp-server-app-store-connect && exec node dist/index.js'
```

## What you can do

| Area | Highlights |
|---|---|
| **Diagnostics** | `get_app_release_status` answers "where do I stand?" — version, state, attached build, in-flight submission, phased release, and the next action to take |
| **Localizations** | List every locale with its id, read any listing with per-field character counts against Apple's limits, diagnose which locales block submission |
| **Screenshots** | Batch upload from `<dir>/<locale>/<DISPLAY_TYPE>/*.png`, with local dimension validation before anything is sent, and cleanup of the reservation if an upload fails |
| **Submission** | Modern `reviewSubmissions` API, one-shot submit, phased release control, manual release |
| **Reviews** | Filter unanswered reviews, rating distribution and trend, publish or bulk-publish responses |
| **Pricing** | Give a price in currency, the server resolves Apple's price tier; schedule promotions; add or remove territories without re-listing all 175 |
| **Code signing** | Certificates, bundle ids, capabilities, devices, profiles, plus a health check for what expires soon |

## Safety

This server can take actions that are public and irreversible. Three things guard that:

- **`confirm: true` is required** on every destructive, public or irreversible tool —
  submitting to review, releasing, changing prices, delisting territories, replying to
  reviews, revoking certificates. Without it the tool refuses and explains what it
  would have done. `bulk_respond_to_reviews` returns a full dry run.
- **stdio by default.** No network port is opened. The optional HTTP transport
  (`TRANSPORT=http`) refuses to bind a non-loopback interface unless OAuth or
  `MCP_HTTP_TOKEN` is configured.
- **Nothing about your key is logged.** All diagnostics go to stderr, redacted.

## Adding a tool

Tools live in `src/tools/`, one module per domain, collected in a registry that fails
loudly on duplicate names. Adding one means creating a file and adding a line. See
[CONTRIBUTING.md](CONTRIBUTING.md).

Apple publishes an OpenAPI specification for this API. Keeping it next to the repo as
`3.2.json` is the fastest way to settle a question about a payload shape — it is
gitignored rather than vendored.

## Status

Read paths are verified against a live account with 18 apps. Write paths follow Apple's
OpenAPI specification and are guarded by `confirm`, but most have not been exercised
against production data — the tool descriptions state what each one does before it does
it.

## Credits

Built on the foundation of
[ryaker/appstore-connect-mcp](https://github.com/ryaker/appstore-connect-mcp), itself
derived from earlier work by Joshua Riley. The JWT authentication approach comes from
that lineage; the transport, the tool registry and the large majority of the tools are
new.

MIT licensed — see [LICENSE](LICENSE) for the full copyright chain.
