import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installUpstashMock } from './support/upstashMock'
import { createR2Server } from './support/r2Mock'

/**
 * The author's-picks row on the site (ADR-0033 §3).
 *
 * The rule under test is the one the whole work order exists for: **a pinned
 * channel is shown whether or not it plays.** Not filtered by a broken-stream
 * mark, not filtered by the user's own hide-broken setting, and still shown —
 * labelled — when the channel has no stream at all. The only thing that ends a
 * pin is the author removing it in the portal.
 *
 * `catalogue/picks.json` is served by the same local R2 mock the catalogue comes
 * from, so nothing here touches a real bucket.
 */

const r2Server = createR2Server()
const r2 = r2Server.mock

test.beforeAll(() => r2Server.listen())
test.afterAll(() => r2Server.close())

/** ch18.xx and ch19.xx are published with no streams (see `streamlessChannels`). */
const CATALOGUE = { totalChannels: 20, guideChannels: 5, streamlessChannels: 2 }

const PLAYABLE = 'ch1.xx'
const STREAMLESS = 'ch19.xx'

function picksDocument() {
  return {
    schema: 1,
    updatedAt: '2026-09-22T00:00:00.000Z',
    groups: [
      {
        title: 'Editor picks',
        items: [
          { channelId: PLAYABLE, note: 'Worth the trip', rank: 0 },
          { channelId: STREAMLESS, rank: 1 },
        ],
      },
      // Nothing in this group has reached the catalogue, so the row must not draw it.
      { title: 'Not yet published', items: [{ channelId: 'never-synced.zz', rank: 0 }] },
      // Not in the catalogue either, but this save carries a snapshot (ADR-0042):
      // it must render from it, not disappear like the group above.
      {
        title: 'Fresh picks',
        items: [
          {
            channelId: 'brand-new.zz',
            rank: 0,
            name: 'Brand New Channel',
            country: 'ZZ',
            categories: ['news'],
          },
        ],
      },
      // Not in the catalogue either, but a fast-track entry (ADR-0043, WO-19) exists for it:
      // it must render as playable, not as an identity-only card.
      { title: 'Fast-tracked', items: [{ channelId: 'fast-tracked.zz', rank: 0 }] },
      // The author left this one empty; an empty group is the one thing that hides a row.
      { title: 'Empty on purpose', items: [] },
    ],
  }
}

function fastTrackDocument() {
  return {
    schema: 1,
    entries: [
      {
        channelId: 'fast-tracked.zz',
        name: 'Fast-Tracked Channel',
        country: 'ZZ',
        categories: ['news'],
        stream: { url: 'https://example.invalid/fast-tracked.m3u8', quality: '1080p' },
      },
    ],
  }
}

/** The picks row for `title`, as a locator. */
const picksRow = (page: Page, title: string) => page.locator(`section[aria-label="Picks: ${title}"]`)

async function openHome(page: Page, context: Parameters<typeof installUpstashMock>[0]) {
  await installUpstashMock(context, CATALOGUE)
  await page.goto('/')
  await expect(page.locator('body')).toContainText('Channel', { timeout: 60_000 })
}

test.beforeEach(() => {
  r2Server.reset(CATALOGUE)
  r2.setPicks(picksDocument())
  r2.setFastTrack(fastTrackDocument())
})

test('pinned channels are shown, with the note and the no-stream state', async ({ page, context }) => {
  await openHome(page, context)

  const row = picksRow(page, 'Editor picks')
  await expect(row).toBeVisible()
  await expect(row.getByRole('button', { name: 'Play Channel 1', exact: true })).toBeVisible()
  await expect(row).toContainText('Worth the trip')

  // A pin with no stream is present, labelled, and not playable.
  await expect(row).toContainText('Channel 19')
  await expect(row).toContainText('No stream available')
  await expect(row.getByRole('button', { name: 'Play Channel 19', exact: true })).toHaveCount(0)
})

test('a group whose channels are not published yet is not drawn; an empty group is not drawn', async ({
  page,
  context,
}) => {
  await openHome(page, context)
  await expect(picksRow(page, 'Editor picks')).toBeVisible()
  await expect(picksRow(page, 'Not yet published')).toHaveCount(0)
  await expect(picksRow(page, 'Empty on purpose')).toHaveCount(0)
  // The unpublished pin is still counted, so the author can see it is waiting.
  await expect(picksRow(page, 'Editor picks')).toContainText('2')
})

test('a pin not yet in the catalogue renders from its saved snapshot (ADR-0042)', async ({ page, context }) => {
  await openHome(page, context)

  const row = picksRow(page, 'Fresh picks')
  await expect(row).toBeVisible()
  await expect(row).toContainText('Brand New Channel')
  // Distinct from the ordinary no-stream label: this one may still get a stream
  // on the next sync, an ordinary "no stream" pin has already been checked and
  // genuinely has none.
  await expect(row).toContainText('Not yet in the catalogue')
  await expect(row).not.toContainText('No stream available')
  await expect(row.getByRole('button', { name: 'Play Brand New Channel', exact: true })).toHaveCount(0)
})

test('a fast-tracked pin renders as playable, not as an identity-only card (ADR-0043, WO-19)', async ({ page, context }) => {
  await openHome(page, context)

  const row = picksRow(page, 'Fast-tracked')
  await expect(row).toBeVisible()
  await expect(row).toContainText('Fast-Tracked Channel')
  await expect(row.getByRole('button', { name: 'Play Fast-Tracked Channel', exact: true })).toBeVisible()
  await expect(row).not.toContainText('Not yet in the catalogue')
  await expect(row).not.toContainText('No stream available')
})

test('a broken mark does not hide a pin, even with hide-broken turned on', async ({ page, context }) => {
  await page.addInitScript((channelId) => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    // The one-time purge of pre-classification marks would otherwise clear this.
    localStorage.setItem('sl_broken_reset_v1', '1')
    localStorage.setItem('sl_hide_broken', 'true')
    localStorage.setItem('sl_auto_skip', 'true')
    localStorage.setItem('sl_broken_streams_v2', JSON.stringify({ [channelId]: { timestamp: Date.now() } }))
  }, PLAYABLE)

  await openHome(page, context)

  // Gone from the ordinary rows, because the user asked for broken channels to be hidden...
  await expect(page.locator('.category-row').getByRole('button', { name: 'Play Channel 1', exact: true })).toHaveCount(0)
  // ...and still on the picks row, because the pin wins (ADR-0033 section 3).
  await expect(picksRow(page, 'Editor picks').getByRole('button', { name: 'Play Channel 1', exact: true })).toBeVisible()
})

test('a channel the user hid themselves is still shown when it is pinned', async ({ page, context }) => {
  await page.addInitScript((channelId) => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('sl_hidden_channels_v1', JSON.stringify([channelId]))
  }, PLAYABLE)

  await openHome(page, context)

  await expect(page.locator('.category-row').getByRole('button', { name: 'Play Channel 1', exact: true })).toHaveCount(0)
  await expect(picksRow(page, 'Editor picks').getByRole('button', { name: 'Play Channel 1', exact: true })).toBeVisible()
})

test('no picks object means no row at all', async ({ page, context }) => {
  r2.setPicks(null)
  await openHome(page, context)
  await expect(page.locator('.picks-row')).toHaveCount(0)
})

test('an unreadable picks object means no row at all', async ({ page, context }) => {
  r2.fail('picks', 'status')
  await openHome(page, context)
  await expect(page.locator('.picks-row')).toHaveCount(0)
  // The rest of the page is unaffected: one optional object failing is not an outage.
  await expect(page.locator('.category-row').first()).toBeVisible()
})

test('a picks object with an unknown schema is ignored rather than guessed at', async ({ page, context }) => {
  r2.setPicks({ ...picksDocument(), schema: 99 })
  await openHome(page, context)
  await expect(page.locator('.picks-row')).toHaveCount(0)
})
