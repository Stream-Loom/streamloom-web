import { useEffect } from 'react'

interface Options {
  onEscape?: () => void
}

/**
 * TV & Desktop keyboard navigation hook.
 *
 * Supports:
 * - ArrowLeft / ArrowRight: Navigate horizontally between channel cards in a row
 * - ArrowUp / ArrowDown: Navigate vertically between rows / toolbar / search
 * - Enter: Activate/play channel (native button/role="button" handling)
 * - /: Instantly focus search bar
 * - Escape: Clear active filter / blur input
 */
export function useKeyboardNav(options?: Options) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const activeEl = document.activeElement as HTMLElement | null
      const isInput =
        activeEl?.tagName === 'INPUT' ||
        activeEl?.tagName === 'TEXTAREA' ||
        activeEl?.tagName === 'SELECT'

      // Shortcut: "/" to focus search bar
      if (e.key === '/' && !isInput) {
        e.preventDefault()
        const searchInput = document.querySelector<HTMLInputElement>('.search-bar input, input[type="search"]')
        if (searchInput) {
          searchInput.focus()
          searchInput.select()
        }
        return
      }

      // Escape: blur or clear filters
      if (e.key === 'Escape') {
        if (isInput) {
          activeEl?.blur()
          return
        }
        options?.onEscape?.()
        return
      }

      // Arrow navigation
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        // If typing inside an input, don't hijack left/right arrows unless arrow down to exit
        if (isInput) {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            activeEl?.blur()
            const firstCard = document.querySelector<HTMLElement>('[data-card="channel"]')
            firstCard?.focus()
          }
          return
        }

        const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-card="channel"]'))
        if (cards.length === 0) return

        // A card without a stream (shown, never hidden, on the picks row — ADR-0033 §3)
        // isn't itself in the tab order, so its favourite button is the only stop a
        // keyboard user lands on for that pin. Resolving from the closest ancestor
        // card, not an exact match, keeps arrow keys moving from there instead of
        // reading "not on a card" and snapping back to the first one.
        const currentCard = activeEl?.closest<HTMLElement>('[data-card="channel"]') ?? null
        const currentIndex = currentCard ? cards.indexOf(currentCard) : -1

        if (currentIndex === -1) {
          // If nothing is focused yet, focus the first card on any arrow press
          e.preventDefault()
          cards[0]?.focus()
          cards[0]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
          return
        }

        const currentRect = currentCard!.getBoundingClientRect()

        if (e.key === 'ArrowRight') {
          e.preventDefault()
          const nextCard = cards[currentIndex + 1]
          if (nextCard) {
            nextCard.focus()
            nextCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
          }
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          const prevCard = cards[currentIndex - 1]
          if (prevCard) {
            prevCard.focus()
            prevCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
          }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          // Find the card in the next row below whose horizontal center is closest
          const belowCards = cards.filter((c) => {
            const rect = c.getBoundingClientRect()
            return rect.top > currentRect.bottom - 10
          })

          if (belowCards.length > 0) {
            // Find closest by horizontal center
            const currentCenter = currentRect.left + currentRect.width / 2
            let closest = belowCards[0]
            let minDist = Infinity
            for (const c of belowCards) {
              const r = c.getBoundingClientRect()
              const dist = Math.abs(r.left + r.width / 2 - currentCenter)
              if (dist < minDist) {
                minDist = dist
                closest = c
              }
            }
            closest.focus()
            closest.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          // Find card in row above
          const aboveCards = cards.filter((c) => {
            const rect = c.getBoundingClientRect()
            return rect.bottom < currentRect.top + 10
          })

          if (aboveCards.length > 0) {
            const currentCenter = currentRect.left + currentRect.width / 2
            let closest = aboveCards[0]
            let minDist = Infinity
            for (const c of aboveCards) {
              const r = c.getBoundingClientRect()
              const dist = Math.abs(r.left + r.width / 2 - currentCenter)
              if (dist < minDist) {
                minDist = dist
                closest = c
              }
            }
            closest.focus()
            closest.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
          } else {
            // Reached top row — jump to search bar or filter bar
            const searchInput = document.querySelector<HTMLInputElement>('.search-bar input')
            if (searchInput) {
              searchInput.focus()
            }
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [options])
}
