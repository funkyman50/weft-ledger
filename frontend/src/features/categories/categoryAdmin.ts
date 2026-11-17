import { matchesSearch, searchQuery } from '../../lib/search'
import type { Category, CategoryTree } from '../../api/types'

export interface CategoryBranch {
  category: CategoryTree
  children: Category[]
  childMatches: number
}

export interface DestinationOption {
  id: number
  label: string
}

const collator = new Intl.Collator('en', { sensitivity: 'base' })

function byName(a: Category, b: Category): number {
  return collator.compare(a.name, b.name)
}

function activeThenArchived<T extends Category>(categories: T[]): T[] {
  return [...categories].sort((left, right) => Number(left.archived) - Number(right.archived) || byName(left, right))
}

export function categoryBranches(categories: CategoryTree[], query: string): CategoryBranch[] {
  const needle = searchQuery(query)
  return activeThenArchived(categories)
    .map((category) => {
      const children = activeThenArchived(category.children)
      return {
        category,
        children,
        childMatches: needle ? children.filter((child) => matchesSearch(child.name, needle)).length : 0,
      }
    })
    .filter(({ category, childMatches }) => matchesSearch(category.name, needle) || childMatches > 0)
}

export function presentationChildren(branch: CategoryBranch, query: string): Category[] {
  const needle = searchQuery(query)
  if (!needle || matchesSearch(branch.category.name, needle)) return branch.children
  return branch.children.filter((child) => matchesSearch(child.name, needle))
}

export function activeChildCount(category: CategoryTree): number {
  return category.children.filter((child) => !child.archived).length
}

export function effectiveArchived(category: Category, parent: Category | null = null): boolean {
  return category.archived || Boolean(parent?.archived)
}

export function deleteDestinations(categories: CategoryTree[], source: Category): DestinationOption[] {
  return activeThenArchived(categories)
    .filter((parent) => !parent.archived && (source.parent_id !== null || parent.id !== source.id))
    .flatMap((parent) => activeThenArchived(parent.children)
      .filter((child) => !child.archived && child.id !== source.id)
      .map((child) => ({ id: child.id, label: `${parent.name}: ${child.name}` })))
}

export function moveDestinations(categories: CategoryTree[], source: Category): DestinationOption[] {
  return activeThenArchived(categories)
    .filter((category) => !category.archived && category.id !== source.parent_id)
    .map((category) => ({ id: category.id, label: category.name }))
}

export interface HighlightSegment {
  text: string
  match: boolean
}

export function highlightedSegments(name: string, query: string): HighlightSegment[] {
  const needle = searchQuery(query)
  if (!needle) return [{ text: name, match: false }]
  const lowerName = name.toLowerCase()
  const segments: HighlightSegment[] = []
  let cursor = 0
  let index = lowerName.indexOf(needle)
  while (index !== -1) {
    if (index > cursor) segments.push({ text: name.slice(cursor, index), match: false })
    segments.push({ text: name.slice(index, index + needle.length), match: true })
    cursor = index + needle.length
    index = lowerName.indexOf(needle, cursor)
  }
  if (cursor < name.length) segments.push({ text: name.slice(cursor), match: false })
  return segments
}
