import { appendAccountScope, type AccountScope } from '../lib/accountScope'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { apiClient } from './client'
import type { ComparisonRowEdits,
  Account,
  AccountLogo,
  Category,
  CategoryTree,
  CategoryCreateCommand,
  CategoryDeleteCommand,
  CategoryUpdateCommand,
  MatchContext,
  PendingLifecycleSelections,
  Payee,
  PayeeRules,
  PlaidStatus,
  LedgerBulkApplyCommand,
  LedgerBulkApplyResult,
  LedgerRow,
  LedgerTarget,
  SchedulePage,
  TransferCommandResult,
} from './types'

export function useAccounts(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['accounts'],
    queryFn: () => apiClient.get<Account[]>('/api/accounts'),
  })
}

export function useAccountLogos() {
  return useQuery({
    queryKey: ['account-logos'],
    queryFn: ({ signal }) => apiClient.get<AccountLogo[]>('/api/account-logos', signal),
  })
}

export function useReorderAccounts() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (ids: number[]) =>
      apiClient.put<Account[]>('/api/accounts/reorder', { ids }),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: ['accounts'] })
      const previous = queryClient.getQueryData<Account[]>(['accounts'])
      if (previous) {
        const byId = new Map(previous.map((account) => [account.id, account]))
        const reordered = ids.map((id) => byId.get(id)!)
        queryClient.setQueryData<Account[]>(['accounts'], [
          ...reordered,
          ...previous.filter((account) => account.closed),
        ])
      }
      return { previous }
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) queryClient.setQueryData(['accounts'], context.previous)
    },
    onSuccess: (accounts) => queryClient.setQueryData(['accounts'], accounts),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['accounts'] }),
  })
}

export function usePayees(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['payees'],
    queryFn: () => apiClient.get<Payee[]>('/api/payees'),
  })
}

export function useCategories(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['categories'],
    queryFn: () => apiClient.get<CategoryTree[]>('/api/categories'),
  })
}

export function useCreateCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: CategoryCreateCommand) => apiClient.post<Category>('/api/categories', payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['categories'] }),
  })
}

export function useUpdateCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: CategoryUpdateCommand }) =>
      apiClient.patch<{ success: boolean }>(`/api/categories/${id}`, payload),
    onSuccess: (_result, { payload }) => {
      if ('name' in payload || 'parent_id' in payload) {
        queryClient.invalidateQueries({ queryKey: ['transactions'] })
      }
      void queryClient.invalidateQueries({ queryKey: ['schedules'] })
      return queryClient.invalidateQueries({ queryKey: ['categories'] })
    },
  })
}

export function useDeleteCategory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: CategoryDeleteCommand }) =>
      apiClient.post<{ success: boolean }>(`/api/categories/${id}/delete`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories'] })
      queryClient.invalidateQueries({ queryKey: ['transactions'] })
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
    },
  })
}

export function usePlaidStatus() {
  return useQuery({
    queryKey: ['plaid-status'],
    queryFn: () => apiClient.get<PlaidStatus>('/api/plaid/status'),
    refetchInterval: (query) => query.state.data?.initial_import_account_ids?.length ? 5_000 : 60_000,
  })
}

export function invalidateAccountAndTransactionQueries(queryClient: QueryClient, { refetchLedger = true, refetchAccounts = refetchLedger, refetchReferenceData = true }: { refetchLedger?: boolean; refetchAccounts?: boolean; refetchReferenceData?: boolean } = {}) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['transactions'], ...(refetchLedger ? {} : { refetchType: 'none' }) }),
    queryClient.invalidateQueries({ queryKey: ['accounts'], ...(refetchAccounts ? {} : { refetchType: 'none' }) }),
    queryClient.invalidateQueries({ queryKey: ['payees'], ...(refetchReferenceData ? {} : { refetchType: 'none' }) }),
    queryClient.invalidateQueries({ queryKey: ['payee-transactions'] }),
    queryClient.invalidateQueries({ queryKey: ['payee-previews'] }),
    queryClient.invalidateQueries({ queryKey: ['payee-references'] }),
    queryClient.invalidateQueries({ queryKey: ['payee-schedules'] }),
    queryClient.invalidateQueries({ queryKey: ['categories'], ...(refetchReferenceData ? {} : { refetchType: 'none' }) }),
    queryClient.invalidateQueries({ queryKey: ['transfer-context'] }),
    queryClient.invalidateQueries({ queryKey: ['schedules'] }),
    queryClient.invalidateQueries({ queryKey: ['loans'] }),
    queryClient.invalidateQueries({ queryKey: ['account-logos'] }),
  ])
}

const ledgerRecoveryReadSet = ['accounts', 'transactions', 'payees', 'categories', 'schedules', 'loans', 'account-logos']

export function cancelLedgerRecoveryReads(queryClient: QueryClient) {
  return Promise.all(ledgerRecoveryReadSet.map((key) => queryClient.cancelQueries({ queryKey: [key] })))
}

export async function refreshLedgerRecoveryData(queryClient: QueryClient) {
  await invalidateAccountAndTransactionQueries(queryClient, { refetchLedger: false, refetchReferenceData: false })
  await Promise.all(ledgerRecoveryReadSet.map((key) =>
    queryClient.refetchQueries({ queryKey: [key], type: 'active' }, { throwOnError: true }),
  ))
}

export function useCreateTransactionMatch() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: {
      feed_transaction_id: number
      history_transaction_id: number
      payee_source: 'feed' | 'history'
      description_source: 'feed' | 'history'
      category_source: 'feed' | 'history'
      memo_source: 'feed' | 'history'
      flag_source: 'feed' | 'history'
      context_token: string
    }) => apiClient.post<LedgerRow>('/api/transaction-matches', payload),
    onSettled: () => { void invalidateAccountAndTransactionQueries(queryClient) },
  })
}

export function useDismissTransactionMatch() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => apiClient.post<MatchContext>(`/api/transaction-matches/${id}/dismiss`),
    onSettled: () => { void invalidateAccountAndTransactionQueries(queryClient) },
  })
}

export function useResolvePendingLifecycle() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: {
      pending_transaction_id: number
      cleared_transaction_id: number
      context_token: string
      selections: PendingLifecycleSelections
      row_edits?: ComparisonRowEdits
    }) => apiClient.post<LedgerRow>('/api/transactions/pending-lifecycle/resolve', payload),
    onSettled: () => { void invalidateAccountAndTransactionQueries(queryClient) },
  })
}

export function useRejectBankContinuity() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: { transaction_id: number; record_id: number; context_token: string }) =>
      apiClient.post<{ status: string }>('/api/transactions/bank-continuity/reject', payload),
    onSettled: () => { void invalidateAccountAndTransactionQueries(queryClient) },
  })
}

export function useDisappearPendingLifecycle() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: { pending_transaction_id: number; cleared_transaction_id?: number; context_token: string }) =>
      apiClient.post<{ status: string }>('/api/transactions/pending-lifecycle/disappear', payload),
    onSettled: () => { void invalidateAccountAndTransactionQueries(queryClient) },
  })
}

export function useUnmatchTransaction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, context_token }: { id: number; context_token: string }) => apiClient.post<MatchContext>(`/api/transaction-matches/${id}/unmatch`, { context_token }),
    onSettled: () => { void invalidateAccountAndTransactionQueries(queryClient) },
  })
}

export function useUnlinkTransfer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, context_token }: { id: number; context_token: string }) =>
      apiClient.post<TransferCommandResult>(`/api/transactions/${id}/transfer-unlink`, { context_token }),
    onSettled: () => { void invalidateAccountAndTransactionQueries(queryClient) },
  })
}

export function useBulkApplyTransactions() {
  return useMutation({
    mutationFn: (payload: LedgerBulkApplyCommand) =>
      apiClient.post<LedgerBulkApplyResult>('/api/transactions/bulk-apply', payload),
  })
}

export function useCreatePayee() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: { name: string }) => apiClient.post<Payee>('/api/payees', payload),
    onSuccess: (payee) => {
      queryClient.setQueryData<Payee[]>(['payees'], (current) => {
        const next = [...(current ?? []).filter((item) => item.id !== payee.id), payee]
        return next.sort((left, right) => left.name.localeCompare(right.name))
      })
      void invalidatePayeeQueries(queryClient).catch(() => undefined)
    },
  })
}

export function useUpdatePayee() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => apiClient.patch<Payee>(`/api/payees/${id}`, { name }),
    onSuccess: () => void invalidatePayeeQueries(queryClient),
  })
}

export function useDeletePayee() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, preview_token }: { id: number; preview_token: string }) => apiClient.delete<void>(`/api/payees/${id}`, { preview_token }),
    onSuccess: (_result, { id }) => finishPayeeDeletion(queryClient, [id]),
  })
}

export function useReplacePayee() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, destination_payee_id, preview_token }: { id: number; destination_payee_id: number; preview_token: string }) =>
      apiClient.post<void>(`/api/payees/${id}/replace`, { destination_payee_id, preview_token }),
    onSuccess: (_result, { id }) => finishPayeeDeletion(queryClient, [id]),
  })
}

export function useDeleteUnusedPayees() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ preview_token }: { preview_token: string; payee_ids: number[] }) => apiClient.delete<void>('/api/payees/unused', { preview_token }),
    onSuccess: (_result, { payee_ids }) => finishPayeeDeletion(queryClient, payee_ids),
  })
}

async function finishPayeeDeletion(queryClient: QueryClient, identifiers: number[]) {
  const deleted = new Set(identifiers)
  queryClient.setQueryData<Payee[]>(['payees'], (current) => current?.filter((payee) => !deleted.has(payee.id)))
  await invalidatePayeeQueries(queryClient).catch(() => undefined)
}

export function usePayeeRules() {
  return useQuery({
    queryKey: ['payee-rules'],
    queryFn: () => apiClient.get<PayeeRules>('/api/payees/rules'),
  })
}

export function useSavePayeeDefaultCategory() {
  return useMutation({
    mutationFn: ({ id, category_id, expected_default_category_id, targets }: {
      id: number
      category_id: number | null
      expected_default_category_id: number | null
      targets: LedgerTarget[]
    }) => apiClient.put<Payee>(`/api/payees/${id}/default-category`, { category_id, expected_default_category_id, targets }),
  })
}

export function invalidatePayeeQueries(
  queryClient: QueryClient,
) {
  return Promise.all([
    invalidateAccountAndTransactionQueries(queryClient),
    queryClient.invalidateQueries({ queryKey: ['payee-rules'] }),
  ])
}


export function useScheduledTransactions(accountId: AccountScope | null, enabled: boolean, membershipKey: string) {
  return useQuery({
    queryKey: ['schedules', accountId, membershipKey],
    enabled: enabled && accountId !== null,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      appendAccountScope(params, accountId)
      return apiClient.get<SchedulePage>(`/api/schedules${params.size ? `?${params}` : ''}`, signal)
    },
    refetchInterval: 60_000,
  })
}
