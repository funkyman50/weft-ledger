export const ACCOUNT_TYPES = ['checking', 'savings', 'credit', 'cash', 'loan'] as const

export function accountTypeLabel(type: string): string {
  return type === 'credit' ? 'Credit card' : type.charAt(0).toUpperCase() + type.slice(1)
}
