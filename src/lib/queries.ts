import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { fetchAll } from '@/lib/import-io';
import { indexCategories } from '@/lib/categories';
import { setTextGrouping, type PackUnit } from '@/lib/products';
import { linePattern } from '@/lib/receipt';
import { supabase } from '@/lib/supabase';
import type { Account, Category, CategoryGroup, SpendFact, Transaction, TransactionInput } from '@/lib/types';

async function unwrap<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}

export function useCategories() {
  const q = useQuery({
    queryKey: ['categories'],
    // archived ones too: old movements keep showing their names; pickers hide them
    queryFn: () => unwrap<Category[]>(supabase.from('categories').select('*')),
    staleTime: 5 * 60_000,
  });
  const index = useMemo(() => indexCategories(q.data ?? []), [q.data]);
  return { ...q, index };
}

/** New (sub)category; if one with the same name already exists under that parent, it is returned instead. */
export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (c: { name: string; parent_id: string | null; kind: Category['kind'] }): Promise<Category> => {
      const name = c.name.trim().replace(/\s+/g, ' ');
      if (!name) throw new Error('Escreva um nome.');
      const { data, error } = await supabase.from('categories').insert({ ...c, name }).select('*').single();
      if (!error) return data as Category;
      if (error.code !== '23505') throw new Error(error.message);
      const q = supabase.from('categories').select('*').eq('kind', c.kind).ilike('name', name);
      const found = await unwrap<Category[]>(c.parent_id ? q.eq('parent_id', c.parent_id) : q.is('parent_id', null));
      if (!found[0]) throw new Error(error.message);
      if (found[0].archived) await supabase.from('categories').update({ archived: false }).eq('id', found[0].id);
      return found[0];
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories'] }),
  });
}

export function useGroups() {
  return useQuery({
    queryKey: ['groups'],
    queryFn: async () => {
      const rows = await unwrap<{ id: string; name: string; category_group_members: { category_id: string }[] }[]>(
        supabase.from('category_groups').select('id, name, category_group_members(category_id)').order('name'),
      );
      return rows.map((g): CategoryGroup => ({ id: g.id, name: g.name, members: g.category_group_members.map((m) => m.category_id) }));
    },
    staleTime: 5 * 60_000,
  });
}

type GroupChange =
  | { op: 'create'; name: string }
  | { op: 'rename'; id: string; name: string }
  | { op: 'delete'; id: string }
  | { op: 'add'; id: string; categoryId: string }
  | { op: 'remove'; id: string; categoryId: string };

export function useGroupChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (c: GroupChange) => {
      const name = 'name' in c ? c.name.trim().replace(/\s+/g, ' ') : '';
      if ((c.op === 'create' || c.op === 'rename') && !name) throw new Error('Escreva um nome.');
      const run = async (p: PromiseLike<{ error: { message: string; code?: string } | null }>) => {
        const { error } = await p;
        if (error) throw new Error(error.code === '23505' ? 'Já existe um grupo com esse nome.' : error.message);
      };
      switch (c.op) {
        case 'create': return run(supabase.from('category_groups').insert({ name }));
        case 'rename': return run(supabase.from('category_groups').update({ name }).eq('id', c.id));
        case 'delete': return run(supabase.from('category_groups').delete().eq('id', c.id));
        case 'add': return run(supabase.from('category_group_members').upsert({ group_id: c.id, category_id: c.categoryId }, { ignoreDuplicates: true }));
        case 'remove': return run(supabase.from('category_group_members').delete().eq('group_id', c.id).eq('category_id', c.categoryId));
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });
}

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: () => unwrap<Account[]>(supabase.from('accounts').select('id, name, type, bank_ref').order('name')),
    staleTime: 5 * 60_000,
  });
}

/** All movements (any kind) with date in [from, to], newest first. */
export function useTransactions(from: string, to: string) {
  return useQuery({
    queryKey: ['transactions', from, to],
    // paged: the Data API returns at most 1000 rows per request (a long custom period can have more)
    queryFn: () =>
      fetchAll<Transaction>((a, b) =>
        supabase
          .from('transactions')
          .select('*')
          .gte('date', from)
          .lte('date', to)
          .order('date', { ascending: false })
          .order('created_at', { ascending: false })
          .order('id')
          .range(a, b),
      ),
  });
}

export function useTransaction(id: string | undefined) {
  return useQuery({
    queryKey: ['transaction', id],
    enabled: !!id,
    queryFn: () => unwrap<Transaction>(supabase.from('transactions').select('*').eq('id', id!).single()),
  });
}

/** Spending facts (line items / plain expenses, refunds netted) in [from, to]. */
export function useSpendFacts(from: string, to: string) {
  return useQuery({
    queryKey: ['spend', from, to],
    // paged: 12 months of receipt lines are well over the 1000-row limit of one request (rows were silently cut off).
    // A view has no id: order on every column so pages never overlap or skip rows (same as loadExploreData).
    queryFn: () =>
      fetchAll<SpendFact>((a, b) =>
        supabase
          .from('spend_facts')
          .select('date, amount_cents, category_id')
          .gte('date', from)
          .lte('date', to)
          .order('date')
          .order('transaction_id')
          .order('amount_cents')
          .order('category_id')
          .order('product_id')
          .range(a, b),
      ),
  });
}

function useInvalidateMovements() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['transaction'] });
    qc.invalidateQueries({ queryKey: ['spend'] });
    qc.invalidateQueries({ queryKey: ['explore'] });
  };
}

export function useSaveTransaction() {
  const invalidate = useInvalidateMovements();
  return useMutation({
    mutationFn: async ({ id, input }: { id?: string; input: TransactionInput }) => {
      if (id) return unwrap(supabase.from('transactions').update(input).eq('id', id).select('id').single());
      return unwrap(supabase.from('transactions').insert({ ...input, source: 'manual' }).select('id').single());
    },
    onSuccess: invalidate,
  });
}

/** "Consumi / Não consumi" on a receipt item of a split bill (the database recomputes the user's part). */
export function useSetConsumed() {
  const invalidate = useInvalidateMovements();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, consumed }: { id: string; consumed: boolean }) =>
      unwrap(supabase.from('line_items').update({ consumed }).eq('id', id).select('id').single()),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ['line_items'] });
    },
  });
}

/**
 * A receipt item's category, changed on the movement screen: every saved item with the same printed text moves too,
 * and a rule makes future receipts use it.
 */
export function useSetLineCategory() {
  const invalidate = useInvalidateMovements();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ rawText, categoryId }: { rawText: string; categoryId: string | null }) => {
      await unwrap(supabase.from('line_items').update({ category_id: categoryId, needs_review: false }).eq('raw_text', rawText).select('id'));
      if (categoryId) {
        await unwrap(
          supabase
            .from('rules')
            .upsert(
              { scope: 'line_item', pattern: linePattern(rawText), match: 'exact', category_id: categoryId, origin: 'user' },
              { onConflict: 'user_id,scope,match,pattern' },
            )
            .select('id'),
        );
      }
    },
    onSuccess: () => {
      invalidate();
      ['line_items', 'rules'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
  });
}

export function useDeleteTransaction() {
  const invalidate = useInvalidateMovements();
  return useMutation({
    mutationFn: async (id: string) => {
      const tx = await unwrap<{ document_id: string | null }>(supabase.from('transactions').select('document_id').eq('id', id).single());
      await unwrap(supabase.from('transactions').delete().eq('id', id));
      // drop the receipt's metadata too, so the same invoice can be imported again
      if (tx.document_id) await unwrap(supabase.from('documents').delete().eq('id', tx.document_id));
    },
    onSuccess: invalidate,
  });
}

export type LineItem = {
  id: string;
  name: string;
  raw_text: string;
  quantity: number | null;
  unit: string | null;
  total_cents: number;
  category_id: string | null;
  consumed: boolean;
  product_id: string | null;
  brand: string | null;
  pack_qty: number | null;
  pack_unit: PackUnit | null;
};

/** A receipt item's product, changed on the movement screen: every line with the same printed text follows. */
export function useSetLineProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ rawText, productId }: { rawText: string; productId: string }) => setTextGrouping(rawText, { product_id: productId }),
    onSuccess: () => ['line_items', 'explore', 'products'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  });
}

/**
 * Receipt products still without a category (discount lines don't count — they follow the receipt), by movement.
 * Under the 'transactions' key so every save/import/category change refreshes it.
 */
export function useUncategorised() {
  return useQuery({
    queryKey: ['transactions', 'uncategorised-lines'],
    queryFn: async () => {
      const rows = await fetchAll<{ transaction_id: string; name: string }>((from, to) =>
        supabase.from('line_items').select('transaction_id, name').is('category_id', null).gt('total_cents', 0).order('transaction_id').range(from, to),
      );
      const byTx = new Map<string, string[]>();
      for (const r of rows) byTx.set(r.transaction_id, [...(byTx.get(r.transaction_id) ?? []), r.name]);
      return byTx;
    },
  });
}

/**
 * Receipts / invoices in [from, to] with a product whose name or printed text contains `q` (Movimentos search:
 * "espetada" finds the restaurant bill). Map of transaction id → the first matching product's name.
 */
export function useLineSearch(from: string, to: string, q: string) {
  // characters that would break the PostgREST or() filter or act as ilike wildcards
  const term = q.trim().replace(/[,()%_\\*]/g, ' ').trim();
  return useQuery({
    queryKey: ['line_items', 'search', from, to, term.toLowerCase()],
    enabled: term.length >= 2,
    queryFn: async () => {
      const rows = await fetchAll<{ transaction_id: string; name: string; raw_text: string }>((a, b) =>
        supabase
          .from('line_items')
          .select('transaction_id, name, raw_text, transactions!inner(date)')
          .gte('transactions.date', from)
          .lte('transactions.date', to)
          .or(`name.ilike.*${term}*,raw_text.ilike.*${term}*`)
          .order('id')
          .range(a, b),
      );
      const byTx = new Map<string, string>();
      for (const r of rows) if (!byTx.has(r.transaction_id)) byTx.set(r.transaction_id, r.name || r.raw_text);
      return byTx;
    },
  });
}

export function useLineItems(transactionId: string | undefined) {
  return useQuery({
    queryKey: ['line_items', transactionId],
    enabled: !!transactionId,
    queryFn: () =>
      unwrap<LineItem[]>(
        supabase
          .from('line_items')
          .select('id, name, raw_text, quantity, unit, total_cents, category_id, consumed, product_id, brand, pack_qty, pack_unit')
          .eq('transaction_id', transactionId!)
          .order('position'),
      ),
  });
}
