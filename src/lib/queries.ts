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
    mutationFn: (id: string) => unwrap(supabase.from('transactions').delete().eq('id', id)),
    onSuccess: invalidate,
  });
}
