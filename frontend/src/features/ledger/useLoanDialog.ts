import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../api/client'
import { refreshLedgerRecoveryData } from '../../api/hooks'
import type { LedgerHistoryInspection } from '../../api/types'

export function useLoanDialog<T>({
  read,
  inspect,
  onSaved,
}: {
  read: () => Promise<T>
  inspect: () => Promise<LedgerHistoryInspection>
  onSaved: () => void
}) {
  const client = useQueryClient()
  const openingRead = useRef(read).current
  const [context, setContext] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const writing = useRef(false)
  useEffect(() => {
    let active = true
    void openingRead()
      .then((fresh) => {
        if (active) setContext(fresh)
      })
      .catch(() => {
        if (active) setLoadError(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [openingRead])
  const refresh = async () => {
    if (writing.current || busy) return
    setBusy(true)
    try {
      const inspection = await inspect()
      if (saved || inspection.outcome?.status === 'committed') {
        onSaved()
        return
      }
      try {
        setContext(await read())
        setLoadError(false)
        setNeedsRefresh(false)
        setError(null)
      } catch (caught) {
        if (
          caught instanceof ApiError &&
          (caught.status === 404 || caught.status === 422)
        ) {
          setContext(null)
          setLoadError(true)
          setNeedsRefresh(false)
          setError(
            'This loan context is no longer available. Close and inspect the account. Your draft was not saved again.'
          )
        } else throw caught
      }
    } catch {
      setError('Refresh failed. Inspect and refresh again before saving.')
      setNeedsRefresh(true)
    } finally {
      setBusy(false)
    }
  }
  const save = async (write: () => Promise<unknown>) => {
    if (writing.current || busy || needsRefresh || saved) return
    writing.current = true
    setBusy(true)
    setError(null)
    try {
      await write()
      setSaved(true)
      try {
        await refreshLedgerRecoveryData(client)
        onSaved()
      } catch {
        setError('Saved. Refresh the updated balances before closing.')
        setNeedsRefresh(true)
      }
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        caught.status >= 400 &&
        caught.status < 500 &&
        caught.status !== 409 &&
        caught.code !== 'unknown_error'
      )
        setError(caught.message)
      else {
        setNeedsRefresh(true)
        setError(
          caught instanceof ApiError && caught.status === 409
            ? caught.message
            : 'The save outcome is unclear. Inspect and refresh before continuing.'
        )
      }
    } finally {
      writing.current = false
      setBusy(false)
    }
  }
  return {
    context,
    loading,
    loadError,
    busy,
    needsRefresh,
    saved,
    error,
    refresh,
    save,
  }
}
