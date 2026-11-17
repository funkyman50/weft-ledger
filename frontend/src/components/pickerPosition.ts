import { useLayoutEffect, useState, type RefObject } from 'react'

interface PickerPosition {
  left: number
  top: number
  width: number
  maxHeight: number
}

const edgeMargin = 8
const triggerGap = 4

function viewportBounds() {
  const viewport = window.visualViewport
  if (viewport) {
    return {
      left: viewport.offsetLeft,
      top: viewport.offsetTop,
      right: viewport.offsetLeft + viewport.width,
      bottom: viewport.offsetTop + viewport.height,
    }
  }
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
}

export function usePickerPosition(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  popupRef: RefObject<HTMLElement | null>,
  width: number,
  placement: 'vertical' | 'above' | 'attached' | 'side' = 'vertical',
  align: 'start' | 'end' = 'start',
) {
  const [position, setPosition] = useState<PickerPosition>({ left: 0, top: 0, width, maxHeight: 0 })

  useLayoutEffect(() => {
    const trigger = triggerRef.current
    const popup = popupRef.current
    if (!open || !trigger || !popup) return

    const update = (event?: Event) => {
      if (event?.target instanceof Node && popup.contains(event.target)) return
      const rect = trigger.getBoundingClientRect()
      const viewport = viewportBounds()
      const availableWidth = Math.max(0, viewport.right - viewport.left - edgeMargin * 2)
      const resolvedWidth = Math.min(Math.max(width, rect.width), availableWidth)
      const anchorLeft = Math.max(viewport.left + edgeMargin, Math.min(align === 'end' ? rect.right - resolvedWidth : rect.left, viewport.right - edgeMargin))
      const anchorTop = Math.max(viewport.top + edgeMargin, Math.min(rect.top, viewport.bottom - edgeMargin))
      const anchorBottom = Math.max(viewport.top + edgeMargin, Math.min(rect.bottom, viewport.bottom - edgeMargin))
      const sideLeft = rect.right + triggerGap + resolvedWidth <= viewport.right - edgeMargin
        ? rect.right + triggerGap
        : rect.left - triggerGap - resolvedWidth
      const left = Math.max(viewport.left + edgeMargin, Math.min(placement === 'side' ? sideLeft : anchorLeft, viewport.right - edgeMargin - resolvedWidth))

      const previous = popup.style.cssText
      const scrollPositions = [popup, ...Array.from(popup.children).filter((child): child is HTMLElement => child instanceof HTMLElement)]
        .filter((element) => element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)
        .map((element) => ({ element, left: element.scrollLeft, top: element.scrollTop }))
      popup.style.left = `${left}px`
      popup.style.top = `${viewport.top + edgeMargin}px`
      popup.style.bottom = 'auto'
      popup.style.width = `${resolvedWidth}px`
      popup.style.height = 'auto'
      popup.style.maxHeight = 'none'
      const preferredHeight = popup.getBoundingClientRect().height
      popup.style.cssText = previous
      scrollPositions.forEach(({ element, left: scrollLeft, top: scrollTop }) => {
        element.scrollLeft = scrollLeft
        element.scrollTop = scrollTop
      })

      const gap = placement === 'attached' ? 0 : triggerGap
      const interiorHeight = Math.max(0, viewport.bottom - viewport.top - edgeMargin * 2)
      const below = Math.min(interiorHeight, Math.max(0, viewport.bottom - anchorBottom - gap - edgeMargin))
      const above = Math.min(interiorHeight, Math.max(0, anchorTop - viewport.top - gap - edgeMargin))
      const placeBelow = placement === 'above' ? preferredHeight > above && below > above : preferredHeight <= below || (preferredHeight > above && below >= above)
      const maxHeight = placement === 'side' ? interiorHeight : placeBelow ? below : above
      const top = placement === 'side'
        ? Math.max(viewport.top + edgeMargin, Math.min(anchorTop, viewport.bottom - edgeMargin - Math.min(preferredHeight, maxHeight)))
        : placeBelow
        ? Math.min(anchorBottom + gap, viewport.bottom - edgeMargin - maxHeight)
        : anchorTop - gap - Math.min(preferredHeight, maxHeight)
      const next = { left, top, width: resolvedWidth, maxHeight }
      setPosition((current) => (
        current.left === next.left
        && current.top === next.top
        && current.width === next.width
        && current.maxHeight === next.maxHeight
          ? current
          : next
      ))
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    const observer = new ResizeObserver(() => update())
    observer.observe(trigger)
    observer.observe(popup)
    Array.from(popup.children).forEach((child) => observer.observe(child))
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [align, open, placement, popupRef, triggerRef, width])

  return position
}
