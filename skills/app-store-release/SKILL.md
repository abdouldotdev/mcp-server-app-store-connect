---
name: app-store-release
description: Run App Store releases end to end from the conversation — diagnose what blocks a version, audit and write listings in every language, upload localized screenshots, submit for review, control the rollout, and handle pricing, territories and customer reviews. Use for any App Store Connect task, and read it before calling the App Store Connect MCP tools.
---

# 🚀 App Store Release

Run an entire App Store release from the conversation — diagnose what blocks a version,
write the listing in every language, upload localized screenshots, submit, and control
the rollout.

Requires the [`mcp-server-app-store-connect`](https://github.com/abdouldotdev/mcp-server-app-store-connect)
MCP server (86 tools over Apple's App Store Connect API).

## When to use

- "Why can't I submit this app?" / "Where does this version stand?"
- "Which of my languages are incomplete?"
- "Upload these screenshots for all my locales"
- "Translate the App Store listing into German and Japanese"
- "Submit the app for review" / "Release the approved version"
- "Which reviews are still waiting for a reply?"
- "Change the price to €4.99" / "Add these countries"
- Any task naming App Store Connect, TestFlight builds, app metadata, keywords,
  screenshots, phased release, or App Store reviews.

## What this is for

Publishing an iOS app means repeating the same work once per language, per device
size, per app: paste a description, paste keywords, drag ten screenshots, check a
character count, repeat in eleven locales. It is the part of shipping that consumes
hours and produces nothing but consistency.

The `mcp-server-app-store-connect` server exposes App Store Connect as **86 tools**, so
that work becomes a conversation. "Which locales are incomplete?" is one call. "Upload
these screenshots for all eleven languages" is one call that validates every file
before sending anything. "Where does this app stand?" is one call that reads the
version, the build, the pending submission and the rollout at once.

**What it changes.** Three things you cannot do by clicking:

- **See everything at once.** The web UI shows one locale at a time. A single call
  reports which of your eleven languages is missing keywords, which has no screenshots,
  and how many characters you have left in each field.
- **Act across an entire account.** Every tool takes an `appId`. The same question can
  be asked of eighteen apps in a loop.
- **Fail before Apple does.** Screenshot dimensions, character limits and locale codes
  are checked locally. You learn a file is the wrong size before the upload, not after
  a rejection.

**What it does not do.** Uploading a build is not in Apple's API — that stays with
Xcode or Transporter. Creating a new app is not either.

## Before anything: the safety rule

Some of these tools take **public, irreversible actions** — submitting to Apple,
releasing a version, changing a price, delisting a territory, replying to a review,
revoking a certificate. They require `confirm: true`.

**Never pass `confirm: true` unless the user asked for that specific action in that
specific turn.** "Get the app ready" is not permission to submit. "Fix the pricing" is
not permission to publish a price. When a confirmed action is the right next step,
describe it and let the user decide.

Called without `confirm`, these tools return what they *would* do. Use that to show the
plan rather than to ask for permission in the abstract.

If the MCP tools are unavailable, say so and stop. Do not guess at Apple's API or walk
the user through the web UI unless they ask.

## Always start with the diagnosis

Never begin by editing. Three read-only calls establish the whole situation:

1. **`get_app_release_status`** — version, state, attached build, in-flight submission,
   phased release, and the next action. This one call usually determines the plan.
2. **`localizations_diagnose`** — which locales are missing required fields.
3. **`screenshots_version_overview`** — the locale × display-type matrix.

Report the findings before proposing work. The real blocker is often something the user
did not mention — no build attached, or a submission stuck in `UNRESOLVED_ISSUES`.

### What each state allows

| State | What you can do |
|---|---|
| `PREPARE_FOR_SUBMISSION` | Editable. Needs a build attached before submitting. |
| `WAITING_FOR_REVIEW` / `IN_REVIEW` | Locked. Editing requires withdrawing first. |
| `PENDING_DEVELOPER_RELEASE` | Approved. `release_app_store_version` publishes it. |
| `REJECTED` | Editable, **but an open submission usually remains**. Resolve or withdraw it first, or the resubmission fails. |
| `READY_FOR_SALE` | Live. Changes need a new version. |

## Listings, in every language

This is where the time goes, so it is worth doing in the right order.

**`localizations_list` is normally your second call.** Almost everything else needs the
localization ids it returns, and it shows which fields are already filled.

**Locale codes are not uniform.** Some carry a region, some do not: `fr-FR`, `en-US`,
`pt-BR` and `pt-PT` do; `ja`, `it`, `pl` do not. Call
`localizations_supported_locales` instead of constructing a code — a wrong one is
rejected with an unhelpful message.

**Spend the character budget.** `localizations_get` reports each field against Apple's
limit (description 4000, keywords 100, promotional text 170). Keywords are the field
that bites: 100 characters, commas included. Report how many remain after writing.

**Translating.** Write one locale per call with
`update_app_store_version_localization`. Translate faithfully rather than inventing
marketing copy in a language you cannot verify, and flag the strings that deserve a
native speaker's eye.

## Screenshots

`screenshots_upload_batch` takes a directory laid out as
`<dir>/<locale>/<DISPLAY_TYPE>/*.png` — the fastlane convention. It reads and validates
every file before uploading anything, so a bad set fails whole instead of leaving a
listing half-updated. If an upload does fail, the reservation is deleted rather than
left dangling.

Two facts that save a debugging round:

- **Several sizes are valid per display type.** The 13" iPad ships `2064x2752`, older
  iPads `2048x2732` — both are accepted for `APP_IPAD_PRO_3GEN_129`.
- **The locale must exist first.** Create it with `localizations_create` before
  attaching screenshots.

Order is preserved as you set it, so use `screenshots_reorder` when the upload order
was not the display order.

## Submitting and releasing

`submit_app_store_version_for_review` runs the whole chain — create the submission,
attach the version, send it. Prefer it to assembling the three steps by hand.

Check two things first with `get_app_release_status`: a build is attached, and no
submission is already open. Apple allows one open submission per app; a second attempt
fails with an opaque error.

`set_version_release_type` decides what happens after approval — `MANUAL` (you press
the button), `AFTER_APPROVAL` (immediate), or `SCHEDULED` with a date. For a
significant release, suggest `MANUAL` plus `enable_phased_release`: a 7-day rollout
that can be paused if something breaks.

## Customer reviews

`search_customer_reviews` with `answered: false` is the queue that matters.
`summarize_customer_reviews` gives the distribution, the average and the trend.

A reply appears publicly under the review, and **Apple has no endpoint to edit one** —
re-posting replaces the text and sends it back through moderation. Draft the response,
show it, let the user approve.

`bulk_respond_to_reviews` posts one text to several unanswered reviews. It dry-runs
without `confirm` and never overwrites a human-written reply. Use it for generic thanks
on 5-star reviews, never for anything that should read as personal.

## Pricing and territories

Apple prices are **tiers**, not free amounts. Pass a price in currency and a territory
code; the server resolves the nearest tier and reports which one it picked and the
resulting proceeds. Verify the tier is the one you meant before confirming.

To change where an app sells, prefer **`update_app_territories`** (a delta) over
`set_app_territories` (a full replacement) — the delta reads the current list and
applies your changes, so an omission cannot delist 174 countries.

Note that `get_in_app_purchases` excludes auto-renewable subscriptions; they are a
separate resource. Zero in-app purchases does not mean the app is unmonetized.

## Code signing

These tools need an API key with the **Admin** or **Developer** role. An **App
Manager** key gets a 403 on every one of them — when that happens, say so plainly: the
fix is a new key, not a retry.

`check_signing_health` is worth running before a release. It reports certificates
expiring soon and profiles already invalid, which is the failure that otherwise
surfaces at the worst moment.
