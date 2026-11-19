import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { indexCategories } from '@/lib/categories';
import { supabase } from '@/lib/supabase';
import type { Account, Category, SpendFact, Transaction, TransactionInput } from '@/lib/types';

async function unwrap<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}

export function useCategories() {
  const q = useQuery({
    queryKey: ['categories'],
    queryFn: () => unwrap<Category[]>(supabase.from('categories').select('*').eq('archived', false)),
    staleTime: 5 * 60_000,
  });
  const index = useMemo(() => indexCategories(q.data ?? []), [q.data]);
  return { ...q, index };
}

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: () => unwrap<Account[]>(supabase.from('accounts').select('id, name, type').order('name')),
    staleTime: 5 * 60_000,
  });
}

/** All movements (any kind) with date in [from, to], newest first. */
export function useTransactions(from: string, to: string) {
  return useQuery({
    queryKey: ['transactions', from, to],
    queryFn: () =>
      unwrap<Transaction[]>(
        supabase
          .from('transactions')
          .select('*')
          .gte('date', from)
          .lte('date', to)
          .order('date', { ascending: false })
          .order('created_at', { ascending: false }),
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
    queryFn: () =>
      unwrap<SpendFact[]>(
        supabase.from('spend_facts').select('date, amount_cents, category_id').gte('date', from).lte('date', to),
      ),
  });
}

function useInvalidateMovements() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['transaction'] });
    qc.invalidateQueries({ queryKey: ['spend'] });
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

export type LineItem = { id: string; name: string; raw_text: string; quantity: number | null; unit: string | null; total_cents: number; category_id: string | null };

export function useLineItems(transactionId: string | undefined) {
  return useQuery({
    queryKey: ['line_items', transactionId],
    enabled: !!transactionId,
    queryFn: () =>
      unwrap<LineItem[]>(
        supabase
          .from('line_items')
          .select('id, name, raw_text, quantity, unit, total_cents, category_id')
          .eq('transaction_id', transactionId!)
          .order('position'),
      ),
  });
}
