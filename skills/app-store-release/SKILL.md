---
name: app-store-release
description: Ship an iOS app to the App Store — diagnose what blocks a release, audit and fill listings across every language, upload screenshots per locale, submit for review, and handle pricing, territories and customer reviews. Use whenever the task involves App Store Connect, app metadata, localizations, screenshots, review submission, phased release, or replying to App Store reviews.
---

# Shipping to the App Store

This skill assumes the `mcp-server-app-store-connect` MCP server is connected. If its
tools are unavailable, say so and stop — do not fall back to guessing at Apple's API or
to instructing the user through the web UI unless they ask for that.

## The one rule that matters

Several of these tools take **public, irreversible actions**: submitting to Apple,
releasing a version, changing a price, delisting a territory, replying to a review,
revoking a certificate. They require `confirm: true`.

**Never pass `confirm: true` unless the user asked for that specific action in that
specific turn.** "Get the app ready" is not permission to submit. "Fix the pricing" is
not permission to publish a price. When you believe a confirmed action is the right
next step, describe it and let the user say yes.

Without `confirm`, these tools return a description of what they would do. That is a
feature — use it to show the user the plan.

## Always start with the diagnosis

Do not begin by editing anything. Three read-only calls tell you everything about where
an app stands:

1. `get_app_release_status` — version, state, attached build, in-flight submission,
   phased release, and the next action. This one call usually determines the whole plan.
2. `localizations_diagnose` — which locales are missing required fields or have
   no screenshots.
3. `screenshots_version_overview` — the locale × display-type matrix.

Report what you found before proposing work. The user often discovers the real blocker
here (no build attached, a submission stuck in `UNRESOLVED_ISSUES`) and redirects you.

## App Store states, and what each one means

| State | What you can do |
|---|---|
| `PREPARE_FOR_SUBMISSION` | Editable. Needs a build attached before it can be submitted. |
| `WAITING_FOR_REVIEW` / `IN_REVIEW` | Locked. Editing requires withdrawing first. |
| `PENDING_DEVELOPER_RELEASE` | Approved. `release_app_store_version` publishes it. |
| `REJECTED` | Editable, **but** an open submission usually remains. Resolve or withdraw it before resubmitting, or the submission will fail. |
| `READY_FOR_SALE` | Live. Changes need a new version. |

## Working across languages

Localization ids are required by almost everything else, so `localizations_list` is
normally your second call. It returns each locale's id plus which fields are filled.

**Locale codes are not uniform.** Some carry a region, some do not: `fr-FR`, `en-US`,
`pt-BR` and `pt-PT` do; `ja`, `it`, `pl` do not. Use
`localizations_supported_locales` rather than constructing a code yourself — a wrong
code is rejected by Apple with an unhelpful message.

`localizations_get` reports each field's character count against Apple's limit
(description 4000, keywords 100, promotional text 170). Keywords are the field that
actually bites: 100 characters including commas. When writing keywords, spend the
budget — report how many characters remain.

When the user asks to translate a listing, write each locale with
`update_app_store_version_localization`, one call per locale. Do not invent marketing
copy in a language you are then unable to check; if you are unsure of the register or a
product term, translate faithfully and flag which strings deserve a native review.

## Screenshots

The batch upload takes a directory laid out as `<dir>/<locale>/<DISPLAY_TYPE>/*.png`,
which matches the fastlane convention. It validates every file's dimensions locally
before uploading anything, so a malformed set fails fast instead of leaving the listing
half-updated.

Two things worth knowing:

- Apple accepts several sizes per display type. The 13" iPad ships `2064x2752` while
  older iPads use `2048x2732` — both are valid for `APP_IPAD_PRO_3GEN_129`.
- A locale must already exist before screenshots can be attached to it. Create it with
  `localizations_create` first.

Ordering matters to users and Apple keeps whatever order you set, so use
`screenshots_reorder` when the upload order was not the display order.

## Submitting

`submit_app_store_version_for_review` does the whole chain — create the submission,
attach the version, send it. Prefer it over assembling the three steps by hand.

Before proposing a submission, verify with `get_app_release_status` that a build is
attached and that no submission is already open. Apple accepts only one open submission
per app, and a second attempt fails with an opaque error.

`set_version_release_type` controls what happens after approval: `MANUAL` (you press
the button), `AFTER_APPROVAL` (goes live immediately), or `SCHEDULED` with a date. For
a significant release, suggest `MANUAL` plus `enable_phased_release` — a 7-day rollout
that can be paused if something breaks.

## Pricing and territories

Apple prices are tiers, not free-form amounts. Pass a price in currency and a
territory code; the server resolves the nearest tier and tells you which one it picked
and what the developer proceeds are. Check that the tier it chose is the one you meant
before confirming.

To change where an app sells, prefer `update_app_territories` (a delta) over
`set_app_territories` (a full replacement) — the delta reads the current list and
applies your additions and removals, so you cannot accidentally delist 174 countries by
omitting them.

Note that `get_in_app_purchases` does not return auto-renewable subscriptions; they are
a separate resource. An app with subscriptions can legitimately report zero in-app
purchases.

## Customer reviews

`search_customer_reviews` with `answered: false` is the queue that matters — reviews
still awaiting a reply. `summarize_customer_reviews` gives the distribution, the
average and the trend.

A reply is public and permanent enough to matter: it appears under the review on the
App Store product page. Apple has no endpoint to edit one — re-posting replaces the
text and sends it back through moderation. Draft the response, show it to the user, and
let them approve it.

`bulk_respond_to_reviews` posts the same text to several unanswered reviews. It runs as
a dry run without `confirm`, and it will not overwrite a human-written reply. Use it for
generic thanks on 5-star reviews, never for anything that reads as a personal answer.

## Code signing

The certificate, profile and device tools need an API key with the **Admin** or
**Developer** role. An **App Manager** key gets a 403 on all of them. If that happens,
say so plainly — the fix is a new key, not a retry.

`check_signing_health` is worth running before a release: it reports certificates
expiring soon and profiles that are already invalid.
