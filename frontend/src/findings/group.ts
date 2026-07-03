import { CATEGORIES, type Category, type Finding } from '../types'

export interface CategoryGroup {
  category: Category
  findings: Finding[]
}

export function groupByCategory(findings: Finding[]): CategoryGroup[] {
  const byCategory = new Map<Category, Finding[]>()
  for (const finding of findings) {
    const list = byCategory.get(finding.category) ?? []
    list.push(finding)
    byCategory.set(finding.category, list)
  }
  return CATEGORIES.filter((category) => byCategory.has(category)).map(
    (category) => ({
      category,
      findings: byCategory
        .get(category)!
        .sort((a, b) => a.span.start - b.span.start),
    }),
  )
}
