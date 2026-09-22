import { useEffect, useMemo, useState } from 'react'
import { ChannelCard } from './ChannelCard'
import { fetchPicksFromR2 } from '../api/r2'
import { orderPickItems } from '../api/r2Contract'
import type { PickItem, PicksDocument } from '../api/r2Contract'
import type { EnrichedChannel } from '../hooks/useChannels'
import './PicksRow.css'

/**
 * The author's-picks rows (ADR-0033 §3).
 *
 * The one rule that matters here: **a pinned channel is never hidden**. Not by a
 * broken-stream mark, not by the user's own hide-broken or auto-skip settings,
 * not by having no stream at all. Removal is the author's act in the portal and
 * nothing else. That is why this component takes `channels` from `allChannels` —
 * the list before `useChannels` applies the hidden and broken filters — and why
 * it never consults `getBrokenSet`, `getHiddenSet` or the settings that drive
 * them. The stream-failure rules of WO-11 are untouched: a pinned channel that
 * fails still records its failure and still marks itself broken; the mark simply
 * does not remove it from this row.
 *
 * A pin whose channel has no stream is shown, greyed, labelled "No stream
 * available" — it is what the author asked for and it is honest about the state.
 *
 * A pin whose channel is not in the live generation at all (ADR-0042) is drawn
 * from the identity snapshot the portal saved alongside it — name, country,
 * categories, no stream, no logo — rather than left out until the next sync:
 * the whole point of pinning something new is seeing it appear now, not after
 * up to a sync interval. It is labelled "Not yet in the catalogue" rather than
 * "No stream available": the two are different facts (one may still get a
 * stream on the next sync; the other has been probed and genuinely has none),
 * and conflating them would tell the author their save did nothing. A pin with
 * neither a live-generation match nor a snapshot — only possible for a document
 * saved before this field existed — still counts as "pending" and is left out,
 * exactly as every pin was before.
 *
 * Any read failure renders nothing at all: an absent row is better than a broken
 * one, and `picks.json` may simply never have been published.
 */

interface Props {
  /**
   * The **unfiltered** channel list (`allChannels`). Passing the filtered list
   * would let a broken mark hide a pin, which is exactly what ADR-0033 forbids.
   */
  channels: EnrichedChannel[]
  onWatch?: (channelId: string) => void
}

interface ResolvedPick {
  channel: EnrichedChannel
  note?: string
  /** True when `channel` was built from the save-time snapshot, not the live generation (ADR-0042). */
  pending: boolean
}

interface ResolvedGroup {
  title: string
  picks: ResolvedPick[]
  /** Ids of channels that only start playing when they are published. Shown as a count. */
  pendingCount: number
}

/**
 * Builds a card-renderable channel from an item's save-time snapshot, or null
 * when it did not carry one (ADR-0042). Never has a stream: a channel this
 * client's own catalogue does not know about cannot have one either.
 */
function synthesizeChannel(item: PickItem): EnrichedChannel | null {
  if (!item.name) return null
  return {
    id: item.channelId,
    name: item.name,
    logo: null,
    country: item.country ?? null,
    is_active: true,
    channel_categories: (item.categories ?? []).map((category_id) => ({ category_id })),
    stream: undefined,
    streams: [],
    categoryIds: item.categories ?? [],
  }
}

export function PicksRow({ channels, onWatch }: Props) {
  const [picks, setPicks] = useState<PicksDocument | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchPicksFromR2()
      .then((document) => {
        if (!cancelled) setPicks(document)
      })
      .catch(() => {
        // Absent on any read error, by design.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const byId = useMemo(() => {
    const map = new Map<string, EnrichedChannel>()
    for (const channel of channels) map.set(channel.id, channel)
    return map
  }, [channels])

  const groups = useMemo<ResolvedGroup[]>(() => {
    if (!picks) return []
    const out: ResolvedGroup[] = []
    for (const group of picks.groups) {
      const resolved: ResolvedPick[] = []
      let pendingCount = 0
      for (const item of orderPickItems(group.items)) {
        const channel = byId.get(item.channelId)
        if (channel) {
          resolved.push({ channel, note: item.note, pending: false })
          continue
        }
        const synthesized = synthesizeChannel(item)
        if (!synthesized) {
          pendingCount += 1
          continue
        }
        resolved.push({ channel: synthesized, note: item.note, pending: true })
      }
      // A group is hidden only when the author left it empty (or nothing in it
      // has reached the catalogue yet) — never because its channels look broken.
      if (resolved.length === 0) continue
      out.push({ title: group.title, picks: resolved, pendingCount })
    }
    return out
  }, [picks, byId])

  if (groups.length === 0) return null

  return (
    <>
      {groups.map((group) => {
        // Keyboard next/previous should not land on a pin that cannot play.
        const playlist = group.picks
          .filter((pick) => pick.channel.stream)
          .map((pick) => pick.channel.id)

        return (
          <section className="picks-row fade-up" key={group.title} aria-label={`Picks: ${group.title}`}>
            <div className="picks-row__header">
              <h2 className="picks-row__title">
                <span aria-hidden="true">★ </span>
                {group.title}
              </h2>
              <span className="picks-row__count">{group.picks.length}</span>
              {group.pendingCount > 0 && (
                <span className="picks-row__pending" title="Pinned, but not in the published catalogue yet">
                  {group.pendingCount} pending
                </span>
              )}
            </div>

            <div className="picks-row__track">
              {group.picks.map(({ channel, note, pending }) => (
                <div className="picks-row__item" key={channel.id}>
                  <ChannelCard
                    channel={channel}
                    onWatch={onWatch}
                    playlist={playlist.length > 1 ? playlist : undefined}
                  />
                  {note && (
                    <p className="picks-row__note" title={note}>
                      {note}
                    </p>
                  )}
                  {!channel.stream && (
                    <p className="picks-row__unavailable">
                      {pending ? 'Not yet in the catalogue' : 'No stream available'}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )
      })}
    </>
  )
}
