import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, apiClient, apiErrorMessage } from '../../api/client'
import { invalidatePayeeQueries, useSavePayeeDefaultCategory } from '../../api/hooks'
import type { LedgerTarget, Payee } from '../../api/types'

export function usePayeeDefaultCategory() {
  const queryClient = useQueryClient()
  const saveMutation = useSavePayeeDefaultCategory()
  const [targets, setTargets] = useState<LedgerTarget[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [outcomeUnknown, setOutcomeUnknown] = useState(false)
  const [requiresRefresh, setRequiresRefresh] = useState(false)

  const preview = useCallback(async (payee: Payee, categoryId: number | null, expectedDefaultCategoryId = payee.default_category_id) => {
    setError(null)
    if (categoryId === null) {
      setTargets([])
      return []
    }
    try {
      const result = await apiClient.postQuery<{ targets: LedgerTarget[] }>(`/api/payees/${payee.id}/default-category/preview`, {
        category_id: categoryId,
        expected_default_category_id: expectedDefaultCategoryId,
      })
      setTargets(result.targets)
      return result.targets
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) setRequiresRefresh(true)
      setError(apiErrorMessage(caught, 'Eligible transactions could not be loaded.'))
      return null
    }
  }, [])

  const save = useCallback(async (payee: Payee, categoryId: number | null, historyTargets: LedgerTarget[], expectedDefaultCategoryId = payee.default_category_id) => {
    setError(null)
    try {
      const saved = await saveMutation.mutateAsync({
        id: payee.id,
        category_id: categoryId,
        expected_default_category_id: expectedDefaultCategoryId,
        targets: historyTargets,
      })
      queryClient.setQueryData<Payee[]>(['payees'], (current) => current?.map((item) => item.id === saved.id ? saved : item) ?? [saved])
      void invalidatePayeeQueries(queryClient)
      setTargets(null)
      return saved
    } catch (caught) {
      if (!(caught instanceof ApiError) || caught.status >= 500) setOutcomeUnknown(true)
      if (!(caught instanceof ApiError) || caught.status >= 500 || caught.status === 409) setRequiresRefresh(true)
      setError(apiErrorMessage(caught, 'Default-category save outcome is unknown. Refresh and inspect it before trying again.'))
      return null
    }
  }, [queryClient, saveMutation])

  const inspect = useCallback(async () => {
    try {
      const payees = await apiClient.get<Payee[]>('/api/payees')
      queryClient.setQueryData(['payees'], payees)
      void invalidatePayeeQueries(queryClient)
      setError(null)
      return payees
    } catch {
      setError('Refresh failed. Writes remain disabled until it succeeds.')
      return null
    }
  }, [queryClient])

  const clearRecovery = useCallback(() => { setOutcomeUnknown(false); setRequiresRefresh(false); setError(null) }, [])
  const reset = useCallback(() => { setTargets(null); setError(null) }, [])
  const savingAction = saveMutation.isPending ? saveMutation.variables.targets.length ? 'history' as const : 'default' as const : null
  return { clearRecovery, error, inspect, outcomeUnknown, preview, requiresRefresh, reset, save, saving: saveMutation.isPending, savingAction, targets }
}
