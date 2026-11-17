export function searchQuery(query: string): string {
  return query.trim().toLowerCase()
}

export function matchesSearch(text: string, normalizedQuery: string): boolean {
  return text.toLowerCase().includes(normalizedQuery)
}
