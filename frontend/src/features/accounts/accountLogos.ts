export const MAX_ICON_FILE_BYTES = 4_000_000 * 4 + 1024 * 1024

export function accountLogoUrl(id: string): string {
  return `/api/account-logos/${encodeURIComponent(id)}/image`
}
