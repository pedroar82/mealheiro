// CGD "Consultar saldos e movimentos à ordem" CSV import (SPEC §6). Pure logic, no I/O:
// the screen fetches existing data from Supabase and hands it in.

import type { CategoryIndex } from '@/lib/categories';
import { sha256Hex } from '@/lib/hash';
import type { Category, CategoryKind } from '@/lib/types';

export type BankLine = {
  line: number; // 1-based line in the file
  posted: string; // 'Data mov.'  YYYY-MM-DD
  value: string; // 'Data valor' YYYY-MM-DD — used as the transaction date
  description: string;
  debit: number | null; // cents
  credit: number | null; // cents
  balance: number; // cents, 'Saldo contabilístico'
  bankCategory: string | null;
};

export type ParsedStatement = {
  accountLabel: string | null; // masked: '••••100 · Conta à ordem'
  periodStart: string | null;
  periodEnd: string | null;
  lines: BankLine[]; // oldest → newest
  chainBreaks: number[]; // file lines where balance_prev − debit + credit ≠ balance
  errors: string[];
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** CGD exports Latin-1; accept UTF-8 too in case that ever changes. */
export function decodeStatement(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

const isoFromDMY = (s: string) => {
  const m = s.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

/** '1.342,82' → 134282; '' → null; '-12,30' → -1230 */
export function parseCgdAmount(s: string | undefined): number | null {
  const t = (s ?? '').trim().replace(/\s|EUR/g, '');
  if (!t) return null;
  if (!/^-?[\d.]+(,\d{1,2})?$/.test(t)) return NaN;
  const [int, dec = ''] = t.replace(/\./g, '').split(',');
  const sign = int.startsWith('-') ? -1 : 1;
  return sign * (Math.abs(parseInt(int, 10)) * 100 + parseInt(dec.padEnd(2, '0') || '0', 10));
}

const normHeader = (s: string) => s.normalize('NFC').trim().toLowerCase();

export function parseStatement(text: string): ParsedStatement {
  const raw = text.replace(/^﻿/, '').split(/\r?\n/);
  const errors: string[] = [];
  let accountLabel: string | null = null;
  let periodStart: string | null = null;
  let periodEnd: string | null = null;

  const headerAt = raw.findIndex((l) => {
    const cells = l.split(';').map(normHeader);
    return cells.includes('data mov.') && cells.includes('data valor') && cells.includes('descrição') && cells.includes('saldo contabilístico');
  });
  if (headerAt < 0) {
    return { accountLabel, periodStart, periodEnd, lines: [], chainBreaks: [], errors: ['Não parece um extrato da CGD (cabeçalho "Data mov.; Data valor; Descrição…" não encontrado).'] };
  }

  for (const l of raw.slice(0, headerAt)) {
    const [k, v = ''] = l.split(';').map((c) => c.trim());
    const key = normHeader(k);
    if (key === 'conta') {
      // '0612345678100 - EUR - Conta à ordem' → '••••100 · Conta à ordem' (never show the full number)
      const [num, , ...rest] = v.split(' - ');
      const digits = (num ?? '').replace(/\D/g, '');
      accountLabel = `••••${digits.slice(-3)}${rest.length ? ` · ${rest.join(' - ')}` : ''}`;
    } else if (key === 'data de início') periodStart = isoFromDMY(v);
    else if (key === 'data de fim') periodEnd = isoFromDMY(v);
  }

  const header = raw[headerAt].split(';').map(normHeader);
  const col = (name: string) => header.indexOf(name);
  const c = {
    posted: col('data mov.'),
    value: col('data valor'),
    desc: col('descrição'),
    debit: col('débito'),
    credit: col('crédito'),
    balance: col('saldo contabilístico'),
    category: col('categoria'),
  };

  const newestFirst: BankLine[] = [];
  for (let i = headerAt + 1; i < raw.length; i++) {
    const cells = raw[i].split(';');
    const posted = isoFromDMY(cells[c.posted] ?? '');
    if (!posted) continue; // blank lines, final 'Saldo contabilístico' summary
    const value = isoFromDMY(cells[c.value] ?? '') ?? posted;
    const debit = parseCgdAmount(cells[c.debit]);
    const credit = parseCgdAmount(cells[c.credit]);
    const balance = parseCgdAmount(cells[c.balance]);
    const line = i + 1;
    if ([debit, credit, balance].some((x) => Number.isNaN(x)) || balance == null) {
      errors.push(`Linha ${line}: valores ilegíveis.`);
      continue;
    }
    if ((debit == null) === (credit == null) || (debit ?? 1) <= 0 || (credit ?? 1) <= 0) {
      errors.push(`Linha ${line}: precisa de exatamente um valor (débito ou crédito).`);
      continue;
    }
    newestFirst.push({
      line,
      posted,
      value,
      description: (cells[c.desc] ?? '').trim().replace(/\s+/g, ' '),
      debit,
      credit,
      balance,
      bankCategory: (cells[c.category] ?? '').trim() || null,
    });
  }

  const lines = newestFirst.reverse();
  const chainBreaks: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    if (prev.balance - (cur.debit ?? 0) + (cur.credit ?? 0) !== cur.balance) chainBreaks.push(cur.line);
  }
  return { accountLabel, periodStart, periodEnd, lines, chainBreaks, errors };
}

// ---------------------------------------------------------------------------
// Description normalisation, rules
// ---------------------------------------------------------------------------

/** Upper-case, no accents, collapsed spaces. */
export function normDesc(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * Grouping / rule key: words up to the first one with digits (terminal ids, phone numbers, refs),
 * without single letters, at most 3. 'STARBUCKS 56425 PENIN' → 'STARBUCKS', 'LIDL AGRADECE P' → 'LIDL AGRADECE',
 * 'Trf Mbway 9XXXXXXXX' → 'TRF MBWAY', 'CMPEA EMPRESA AGUAS M' → 'CMPEA EMPRESA AGUAS'.
 */
export function descKey(s: string): string {
  const all = normDesc(s).split(' ');
  const cut = all.findIndex((w) => /\d/.test(w));
  const words = (cut < 0 ? all : all.slice(0, cut)).filter((w) => w.length > 1);
  return words.slice(0, 3).join(' ') || normDesc(s);
}

export type BankRule = { pattern: string; match: 'exact' | 'prefix' | 'contains'; category_id: string | null; priority: number };

function ruleMatches(r: BankRule, key: string) {
  if (r.match === 'exact') return key === r.pattern;
  if (r.match === 'prefix') return key === r.pattern || key.startsWith(`${r.pattern} `);
  return key.includes(r.pattern);
}

/** Built-in defaults, used when no saved rule matches (SPEC §6.3: bank fees → Banco › Comissões). */
const BUILTIN: { prefix: string[]; path: string[] }[] = [
  { prefix: ['COMISSAO', 'MANUT CONTA', 'IMPOSTO SELO', 'IMP SELO'], path: ['Banco', 'Comissões'] },
];

function findPath(idx: CategoryIndex, kind: CategoryKind, path: string[]): string | null {
  let parent: string | null = null;
  for (const part of path) {
    const found: Category | undefined = (idx.children.get(parent) ?? []).find((c) => c.kind === kind && normDesc(c.name) === normDesc(part));
    if (!found) return null;
    parent = found.id;
  }
  return parent;
}

/** Category for a description key: saved rule (longest pattern, then priority) → built-in → null. */
export function categoryForKey(idx: CategoryIndex, rules: BankRule[], kind: CategoryKind, key: string): string | null {
  const hits = rules
    .filter((r) => r.category_id && ruleMatches(r, key) && idx.byId.get(r.category_id)?.kind === kind)
    .sort((a, b) => b.pattern.length - a.pattern.length || a.priority - b.priority);
  if (hits[0]) return hits[0].category_id;
  if (kind === 'expense') {
    for (const b of BUILTIN) if (b.prefix.some((p) => key === p || key.startsWith(`${p} `))) return findPath(idx, kind, b.path);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fingerprints (Rule 1) and classification (Rules 2–3)
// ---------------------------------------------------------------------------

export function fingerprint(accountId: string, l: BankLine): Promise<string> {
  return sha256Hex([accountId, l.posted, l.value, normDesc(l.description), l.debit ?? '', l.credit ?? '', l.balance].join('|'));
}

/** Existing transaction that could be the same real-world movement. */
export type ExistingTx = {
  id: string;
  kind: string;
  date: string;
  amount_cents: number;
  account_id: string | null;
  description: string | null;
  source: string;
  recurring?: boolean;
};

/** amountDiffers: a recurring movement (salary, bill) whose amount changed — linking updates it to the bank's amount. */
export type Candidate = { tx: ExistingTx; days: number; score: number; amountDiffers?: boolean };

export type RefundTarget = { tx: ExistingTx } | { lineIndex: number };

export type Plan =
  | { type: 'already' }
  | { type: 'cash' } // ATM withdrawal → transfer bank → Carteira
  | { type: 'refund'; target: RefundTarget; targetLabel: string }
  | { type: 'link'; candidates: Candidate[] } // choice made in the UI (default: best)
  | { type: 'mbway' } // person-to-person MB Way: user decides expense vs ignore
  | { type: 'create'; kind: CategoryKind };

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / DAY);

const words = (s: string | null) =>
  new Set(normDesc(s ?? '').split(/[^A-Z]+/).filter((w) => w.length >= 3));

/** Word overlap between bank description and an existing note (0..1). */
function similarity(a: string, b: string | null) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

export const isAtm = (l: BankLine) => /^ATM\s/i.test(l.description);
export const isMbwayTransfer = (l: BankLine) => /^TRF\s+MBWAY\b/.test(normDesc(l.description));
export const isVoucher = (l: BankLine) => normDesc(l.description).startsWith('CREDIT VOUCHER');

export function classify(
  lines: BankLine[],
  known: boolean[], // fingerprint already imported
  existing: ExistingTx[], // transactions around the statement period
  linkedIds: Set<string>, // transactions already linked to a bank line
  bankAccountId: string,
): Plan[] {
  const onBank = existing.filter((t) => t.account_id === bankAccountId || t.account_id == null);
  const usable = onBank.filter((t) => !linkedIds.has(t.id));

  const plans: Plan[] = lines.map((l, i) => {
    if (known[i]) return { type: 'already' };
    if (l.debit && isAtm(l)) return { type: 'cash' };

    if (l.credit && isVoucher(l)) {
      // original purchase: same amount, up to 60 days before — existing transaction or a debit in this file
      // (a purchase already linked to a bank line still counts: its line was imported before)
      const fromTx = onBank
        .filter((t) => t.kind === 'expense' && t.amount_cents === l.credit && daysBetween(l.value, t.date) >= 0 && daysBetween(l.value, t.date) <= 60)
        .map((t) => ({ target: { tx: t } as RefundTarget, days: daysBetween(l.value, t.date), label: `${t.description ?? 'Despesa'} (${t.date})` }));
      const fromFile = lines
        .map((d, j) => ({ d, j }))
        .filter(({ d, j }) => j !== i && !known[j] && d.debit === l.credit && !isAtm(d) && daysBetween(l.value, d.value) >= 0 && daysBetween(l.value, d.value) <= 60)
        .map(({ d, j }) => ({ target: { lineIndex: j } as RefundTarget, days: daysBetween(l.value, d.value), label: `${d.description} (${d.value})` }));
      const best = [...fromTx, ...fromFile].sort((a, b) => a.days - b.days)[0];
      if (best) return { type: 'refund', target: best.target, targetLabel: best.label };
      // no original found → falls through and is treated like any other credit
    }

    const kind = l.debit ? 'expense' : 'income';
    const amount = (l.debit ?? l.credit)!;
    const candidates = usable
      .filter((t) => {
        if (t.kind !== kind) return false;
        const days = Math.abs(daysBetween(t.date, l.value));
        if (t.amount_cents === amount) return days <= 3;
        // recurring entries registered by hand may differ a little from what the bank shows
        return !!t.recurring && days <= 5 && Math.abs(t.amount_cents - amount) <= 0.25 * Math.max(t.amount_cents, amount);
      })
      .map((t) => {
        const days = Math.abs(daysBetween(t.date, l.value));
        const amountDiffers = t.amount_cents !== amount;
        return { tx: t, days, score: days - 2 * similarity(l.description, t.description) + (amountDiffers ? 3 : 0), amountDiffers };
      })
      .sort((a, b) => a.score - b.score);
    if (candidates.length) return { type: 'link', candidates };
    if (l.debit && isMbwayTransfer(l)) return { type: 'mbway' };
    return { type: 'create', kind };
  });
  return plans;
}

/**
 * Default link choices: each existing transaction used once. Lines with fewer candidates pick first;
 * a line whose candidates are all taken gets 'new'.
 */
export function defaultLinks(plans: Plan[]): Record<number, string> {
  const order = plans
    .map((p, i) => ({ p, i }))
    .filter((x): x is { p: Extract<Plan, { type: 'link' }>; i: number } => x.p.type === 'link')
    .sort((a, b) => a.p.candidates.length - b.p.candidates.length || a.p.candidates[0].score - b.p.candidates[0].score);
  const taken = new Set<string>();
  const out: Record<number, string> = {};
  for (const { p, i } of order) {
    const c = p.candidates.find((x) => !taken.has(x.tx.id));
    out[i] = c ? c.tx.id : 'new';
    if (c) taken.add(c.tx.id);
  }
  return out;
}
