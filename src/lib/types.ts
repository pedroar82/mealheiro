// Hand-written row types matching supabase/migrations (replace with generated types later).

export type Kind = 'expense' | 'income' | 'transfer' | 'refund';
export type CategoryKind = 'expense' | 'income';

export type Category = {
  id: string;
  parent_id: string | null;
  name: string;
  kind: CategoryKind;
  icon: string | null;
  color: string | null;
  archived: boolean;
};

export type Account = { id: string; name: string; type: 'bank' | 'cash' | 'other'; bank_ref?: string | null };

export type Transaction = {
  id: string;
  kind: Kind;
  date: string;
  time: string | null;
  amount_cents: number;
  account_id: string | null;
  to_account_id: string | null;
  category_id: string | null;
  merchant_id: string | null;
  store_id: string | null;
  description: string | null;
  source: 'manual' | 'receipt' | 'pdf' | 'excel' | 'bank_csv';
  recurring: boolean;
  needs_review: boolean;
  created_at: string;
};

export type TransactionInput = Pick<
  Transaction,
  'kind' | 'date' | 'amount_cents' | 'account_id' | 'category_id' | 'description' | 'recurring'
>;

export type SpendFact = { date: string; amount_cents: number; category_id: string | null };
