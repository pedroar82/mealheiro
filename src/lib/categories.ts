import type { Category } from '@/lib/types';

export type CategoryIndex = {
  byId: Map<string, Category>;
  children: Map<string | null, Category[]>;
};

export function indexCategories(list: Category[]): CategoryIndex {
  const byId = new Map(list.map((c) => [c.id, c]));
  const children = new Map<string | null, Category[]>();
  for (const c of list) {
    const key = c.parent_id;
    if (!children.has(key)) children.set(key, []);
    children.get(key)!.push(c);
  }
  for (const arr of children.values()) arr.sort((a, b) => a.name.localeCompare(b.name, 'pt'));
  return { byId, children };
}

/** Top-level ancestor id (the category itself if it has no parent). */
export function rootOf(idx: CategoryIndex, id: string | null): string | null {
  let cur = id ? idx.byId.get(id) : undefined;
  while (cur?.parent_id) cur = idx.byId.get(cur.parent_id);
  return cur?.id ?? null;
}

/** "Alimentação › Bebidas › Café" */
export function categoryPath(idx: CategoryIndex, id: string | null): string {
  if (!id) return 'Por categorizar';
  const parts: string[] = [];
  let cur = idx.byId.get(id);
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parent_id ? idx.byId.get(cur.parent_id) : undefined;
  }
  return parts.join(' › ') || 'Por categorizar';
}
