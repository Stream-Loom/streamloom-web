import { useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import type { EnrichedChannel } from '../hooks/useChannels'
import type { EpgProgram } from '../api/types'
import { useFavourites } from '../hooks/useChannels'
import { formatCountryDisplay } from '../util/country'
import { LOGO_SIZE, logoUrl, handleLogoError } from '../util/logo'
import './ChannelCard.css'

interface Props {
  channel: EnrichedChannel
  nowPlaying?: EpgProgram | null
  size?: 'small' | 'medium' | 'large'
  onWatch?: (channelId: string) => void
  playlist?: string[]
}

export function ChannelCard({ channel, nowPlaying, size = 'medium', onWatch, playlist }: Props) {
  const navigate = useNavigate()
  const location = useLocation()
  const { isFavourite, toggle } = useFavourites()

  const hasStream = !!channel.stream
  const fav = isFavourite(channel.id)

  const handleClick = useCallback(() => {
    if (!hasStream) return
    onWatch?.(channel.id)
    sessionStorage.setItem('sl_last_viewed', channel.id)
    const returnPath = location.pathname + location.search
    sessionStorage.setItem('sl_return_to', returnPath)
    const hasMultipleInPlaylist = Boolean(playlist && playlist.length > 1)
    if (hasMultipleInPlaylist) {
      try {
        sessionStorage.setItem('sl_active_playlist', JSON.stringify(playlist))
      } catch {}
    } else {
      try {
        sessionStorage.removeItem('sl_active_playlist')
      } catch {}
    }
    navigate(`/watch/${encodeURIComponent(channel.id)}`, {
      state: {
        playlist: hasMultipleInPlaylist ? playlist : undefined,
        returnTo: returnPath,
      },
    })
  }, [hasStream, channel.id, playlist, location.pathname, location.search, navigate, onWatch])

  const handleFav = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    toggle(channel.id)
  }, [channel.id, toggle])

  const countryDisplay = formatCountryDisplay(channel.country)
  const logoSrc = logoUrl(channel.logo)

  return (
    <article
      className={`channel-card channel-card--${size} ${!hasStream ? 'channel-card--no-stream' : ''}`}
      onClick={handleClick}
      role={hasStream ? 'button' : undefined}
      tabIndex={hasStream ? 0 : -1}
      data-card="channel"
      data-channel-id={channel.id}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      }}
      aria-label={`Play ${channel.name}`}
    >
      <div className="channel-card__thumb">
        {logoSrc ? (
          <img
            src={logoSrc}
            alt={channel.name}
            width={LOGO_SIZE}
            height={LOGO_SIZE}
            loading="lazy"
            decoding="async"
            onError={handleLogoError}
          />
        ) : (
          <span className="channel-card__initials">
            {channel.name.slice(0, 2).toUpperCase()}
          </span>
        )}
        {hasStream && <div className="channel-card__play-overlay">▶</div>}

        {/* Quality badge */}
        {channel.stream?.quality && channel.stream.quality !== '' && (
          <span className="channel-card__quality">{channel.stream.quality.toUpperCase()}</span>
        )}

        {/* Favourite button */}
        <button
          className={`channel-card__fav ${fav ? 'channel-card__fav--active' : ''}`}
          onClick={handleFav}
          aria-label={fav ? 'Remove from favourites' : 'Add to favourites'}
          title={fav ? 'Remove favourite' : 'Add to favourites'}
        >
          {fav ? '♥' : '♡'}
        </button>
      </div>

      <div className="channel-card__info">
        <p className="channel-card__name" title={channel.name}>{channel.name}</p>
        {nowPlaying ? (
          <p className="channel-card__epg" title={nowPlaying.title}>
            <span className="live-dot" style={{ marginRight: 6 }} />
            <span className="channel-card__epg-text">{nowPlaying.title}</span>
          </p>
        ) : countryDisplay ? (
          <p className="channel-card__country" title={countryDisplay}>{countryDisplay}</p>
        ) : null}
      </div>
    </article>
  )
}
