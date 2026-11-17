import { useEffect, useRef } from 'react'

const HOLD_DELAY_MS = 200
const DROP_ANIMATION_MS = 200
const SCROLL_ZONE_PX = 40
const SCROLL_PX_PER_MS = 5 / 16
const MAX_FRAME_DELTA_MS = 32
const ACCOUNT_SELECTOR = '[data-sortable-account-ids]'

type Point = { clientX: number; clientY: number }
type GestureState = 'idle' | 'holding' | 'dragging' | 'dropping' | 'saving'

function pointFrom(event: MouseEvent | TouchEvent): Point | null {
  if ('touches' in event) return event.touches[0] ?? event.changedTouches[0] ?? null
  return event
}

export function useSortableAccountRail(
  enabled: boolean,
  onReorder: (ids: number[]) => Promise<void>,
  scopeKey: string,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const onReorderRef = useRef(onReorder)

  useEffect(() => {
    onReorderRef.current = onReorder
  }, [onReorder])

  useEffect(() => {
    const containerElement = containerRef.current
    if (!containerElement || !enabled) return
    const container: HTMLDivElement = containerElement
    const scrollContainer = container.closest<HTMLElement>('.bp-account-list') ?? container

    let state: GestureState = 'idle'
    let disposed = false
    let holdTimer: number | null = null
    let dropTimer: number | null = null
    let frameId: number | null = null
    let lastFrameTime: number | null = null
    let scrollRemainder = 0
    let draggedElement: HTMLElement | null = null
    let ghostElement: HTMLElement | null = null
    let gapElement: HTMLElement | null = null
    let containerRect: DOMRect | null = null
    let scrollRect: DOMRect | null = null
    let latestPoint: Point | null = null
    let pointChanged = false
    let offsetX = 0
    let offsetY = 0
    let ghostOriginLeft = 0
    let ghostOriginTop = 0
    let ghostWidth = 0
    let siblingElements: HTMLElement[] = []
    let gapIndex = 0
    let pickupPending = false
    let suppressNextClick = false

    const getItems = () => Array.from(container.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element.matches(ACCOUNT_SELECTOR))
    const getItemIds = (element: HTMLElement): number[] => JSON.parse(element.dataset.sortableAccountIds!)

    const stopFrame = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId)
      frameId = null
      lastFrameTime = null
    }

    const removeHoldListeners = () => {
      document.removeEventListener('mouseup', finishHold)
      document.removeEventListener('touchend', finishHold)
      document.removeEventListener('touchcancel', finishHold)
      window.removeEventListener('blur', cancelDrag)
      window.removeEventListener('resize', cancelDrag)
    }

    const removeDragListeners = () => {
      document.removeEventListener('mousemove', moveDrag)
      document.removeEventListener('touchmove', moveDrag)
      document.removeEventListener('mouseup', finishDrag)
      document.removeEventListener('touchend', finishDrag)
      document.removeEventListener('touchcancel', cancelDrag)
      window.removeEventListener('blur', cancelDrag)
      window.removeEventListener('resize', cancelDrag)
    }

    const cleanDragElements = () => {
      ghostElement?.remove()
      gapElement?.remove()
      if (draggedElement) draggedElement.style.display = ''
      container.classList.remove('is-sorting')
      document.body.classList.remove('bp-account-sort-active')
      ghostElement = null
      gapElement = null
      draggedElement = null
      latestPoint = null
      siblingElements = []
      pickupPending = false
    }

    const moveGap = (index: number) => {
      if (!gapElement || index === gapIndex) return
      if (index >= siblingElements.length) container.appendChild(gapElement)
      else container.insertBefore(gapElement, siblingElements[index])
      gapIndex = index
    }

    const paintDrag = (timestamp: number, allowScroll: boolean) => {
      if (
        state !== 'dragging'
        || !ghostElement
        || !containerRect
        || !scrollRect
        || !latestPoint
      ) return

      if (pickupPending) {
        ghostElement.classList.add('is-picked-up')
        pickupPending = false
      }

      let didScroll = false
      if (allowScroll && lastFrameTime !== null) {
        const elapsed = Math.min(timestamp - lastFrameTime, MAX_FRAME_DELTA_MS)
        let scrollDirection = 0
        if (latestPoint.clientY - scrollRect.top < SCROLL_ZONE_PX) {
          scrollDirection = -1
        } else if (scrollRect.bottom - latestPoint.clientY < SCROLL_ZONE_PX) {
          scrollDirection = 1
        }
        if (scrollDirection === 0) {
          scrollRemainder = 0
        } else {
          scrollRemainder += scrollDirection * elapsed * SCROLL_PX_PER_MS
          const scrollStep = Math.trunc(scrollRemainder)
          if (scrollStep !== 0) {
            const previousScrollTop = scrollContainer.scrollTop
            scrollContainer.scrollTop += scrollStep
            scrollRemainder -= scrollStep
            didScroll = scrollContainer.scrollTop !== previousScrollTop
          }
        }
      }
      lastFrameTime = timestamp

      if (pointChanged) {
        const left = Math.max(
          containerRect.left,
          Math.min(latestPoint.clientX - offsetX, containerRect.right - ghostWidth),
        )
        ghostElement.style.translate = `${left - ghostOriginLeft}px ${latestPoint.clientY - offsetY - ghostOriginTop}px`
      }

      if (pointChanged || didScroll) {
        const nextIndex = siblingElements.findIndex((item) => {
          const rect = item.getBoundingClientRect()
          return latestPoint!.clientY < rect.top + rect.height / 2
        })
        moveGap(nextIndex === -1 ? siblingElements.length : nextIndex)
      }
      pointChanged = false
    }

    const runFrame = (timestamp: number) => {
      frameId = null
      if (state !== 'dragging') return
      paintDrag(timestamp, true)
      frameId = window.requestAnimationFrame(runFrame)
    }

    function moveDrag(event: MouseEvent | TouchEvent) {
      if (state !== 'dragging') return
      const point = pointFrom(event)
      if (!point) return
      pointChanged = pointChanged
        || latestPoint?.clientX !== point.clientX
        || latestPoint.clientY !== point.clientY
      latestPoint = { clientX: point.clientX, clientY: point.clientY }
      if (event.cancelable) event.preventDefault()
    }

    function finishHold() {
      removeHoldListeners()
      if (state !== 'holding') return
      if (holdTimer !== null) window.clearTimeout(holdTimer)
      holdTimer = null
      state = 'idle'
      draggedElement = null
      latestPoint = null
    }

    function startDrag(point: Point) {
      holdTimer = null
      if (state !== 'holding' || !draggedElement?.isConnected) {
        finishHold()
        return
      }
      removeHoldListeners()

      const items = getItems()
      const draggedIndex = items.indexOf(draggedElement)
      if (draggedIndex === -1) {
        state = 'idle'
        draggedElement = null
        return
      }

      const itemRects = items.map((item) => item.getBoundingClientRect())
      const draggedRect = itemRects[draggedIndex]
      state = 'dragging'
      containerRect = container.getBoundingClientRect()
      scrollRect = scrollContainer.getBoundingClientRect()
      siblingElements = items.filter((item) => item !== draggedElement)
      gapIndex = draggedIndex
      latestPoint = { clientX: point.clientX, clientY: point.clientY }
      pointChanged = false
      offsetX = point.clientX - draggedRect.left
      offsetY = point.clientY - draggedRect.top
      ghostOriginLeft = draggedRect.left
      ghostOriginTop = draggedRect.top
      ghostWidth = draggedRect.width
      scrollRemainder = 0

      ghostElement = draggedElement.cloneNode(true) as HTMLElement
      ghostElement.classList.add('bp-account-sort-ghost')
      ghostElement.setAttribute('aria-hidden', 'true')
      Object.assign(ghostElement.style, {
        position: 'fixed',
        left: `${draggedRect.left}px`,
        top: `${draggedRect.top}px`,
        width: `${draggedRect.width}px`,
        height: `${draggedRect.height}px`,
        zIndex: '10000',
        pointerEvents: 'none',
        margin: '0',
      })
      document.body.appendChild(ghostElement)
      pickupPending = true

      gapElement = document.createElement('div')
      gapElement.className = 'bp-account-sort-gap'
      gapElement.style.height = `${draggedRect.height}px`
      draggedElement.style.display = 'none'
      draggedElement.parentNode?.insertBefore(gapElement, draggedElement)
      container.classList.add('is-sorting')
      document.body.classList.add('bp-account-sort-active')

      document.addEventListener('mousemove', moveDrag)
      document.addEventListener('touchmove', moveDrag, { passive: false })
      document.addEventListener('mouseup', finishDrag)
      document.addEventListener('touchend', finishDrag)
      document.addEventListener('touchcancel', cancelDrag)
      window.addEventListener('blur', cancelDrag)
      window.addEventListener('resize', cancelDrag)
      frameId = window.requestAnimationFrame(runFrame)
    }

    function finishDrag(event: MouseEvent | TouchEvent) {
      if (state === 'holding') {
        finishHold()
        return
      }
      if (state !== 'dragging' || !draggedElement || !ghostElement || !gapElement) return
      const point = pointFrom(event)
      if (point) {
        pointChanged = pointChanged
          || latestPoint?.clientX !== point.clientX
          || latestPoint.clientY !== point.clientY
        latestPoint = { clientX: point.clientX, clientY: point.clientY }
      }
      stopFrame()
      paintDrag(window.performance.now(), false)
      state = 'dropping'
      suppressNextClick = true
      removeDragListeners()

      const gapRect = gapElement.getBoundingClientRect()
      ghostElement.classList.add('is-dropping')
      ghostElement.classList.remove('is-picked-up')
      ghostElement.style.translate = `${gapRect.left - ghostOriginLeft}px ${gapRect.top - ghostOriginTop}px`

      dropTimer = window.setTimeout(() => {
        dropTimer = null
        if (state !== 'dropping' || !draggedElement || !gapElement) return
        const nextItems = [...siblingElements]
        nextItems.splice(gapIndex, 0, draggedElement)
        const nextIds = nextItems.flatMap(getItemIds)
        if (JSON.stringify(nextIds) === JSON.stringify(getItems().flatMap(getItemIds))) {
          cleanDragElements()
          state = 'idle'
          return
        }
        state = 'saving'
        void onReorderRef.current(nextIds)
          .catch(() => {})
          .finally(() => {
            if (!disposed) {
              cleanDragElements()
              state = 'idle'
            }
          })
      }, DROP_ANIMATION_MS)
    }

    function cancelDrag() {
      cancelForAccountChange()
    }

    const cancelForAccountChange = () => {
      if (state === 'holding') {
        finishHold()
        return false
      }
      if (state !== 'dragging') return false
      state = 'idle'
      stopFrame()
      removeDragListeners()
      cleanDragElements()
      return true
    }

    const startHold = (event: MouseEvent | TouchEvent) => {
      suppressNextClick = false
      if (state !== 'idle') return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('[data-account-group-open]')) return
      const item = target?.closest<HTMLElement>(ACCOUNT_SELECTOR)
      if (!item || item.parentElement !== container) return
      if ('button' in event && event.button !== 0) return
      const point = pointFrom(event)
      if (!point) return

      state = 'holding'
      draggedElement = item
      holdTimer = window.setTimeout(() => startDrag(point), HOLD_DELAY_MS)
      document.addEventListener('mouseup', finishHold)
      document.addEventListener('touchend', finishHold)
      document.addEventListener('touchcancel', finishHold)
      window.addEventListener('blur', cancelDrag)
      window.addEventListener('resize', cancelDrag)
      event.preventDefault()
    }

    const suppressDragClick = (event: MouseEvent) => {
      if (!suppressNextClick) return
      suppressNextClick = false
      event.preventDefault()
      event.stopPropagation()
    }

    const accountObserver = new MutationObserver((records) => {
      if (state !== 'holding' && state !== 'dragging') return
      const accountsChanged = records.some((record) => (
        [...record.addedNodes, ...record.removedNodes].some((node) => (
          node instanceof HTMLElement && (node.matches(ACCOUNT_SELECTOR) || node.querySelector(ACCOUNT_SELECTOR) !== null)
        ))
      ))
      if (accountsChanged) cancelForAccountChange()
    })

    container.addEventListener('mousedown', startHold)
    container.addEventListener('touchstart', startHold, { passive: false })
    container.addEventListener('click', suppressDragClick, true)
    accountObserver.observe(container, { childList: true, subtree: true })

    return () => {
      disposed = true
      if (holdTimer !== null) window.clearTimeout(holdTimer)
      if (dropTimer !== null) window.clearTimeout(dropTimer)
      stopFrame()
      removeHoldListeners()
      removeDragListeners()
      cleanDragElements()
      accountObserver.disconnect()
      container.removeEventListener('mousedown', startHold)
      container.removeEventListener('touchstart', startHold)
      container.removeEventListener('click', suppressDragClick, true)
    }
  }, [enabled, scopeKey])

  return containerRef
}
