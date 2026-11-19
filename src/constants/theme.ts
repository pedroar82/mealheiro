// Visual tokens from the mockup (docs/SPEC.md → design canvas).
export const colors = {
  ground: '#F3F4F6',
  card: '#FFFFFF',
  ink: '#14171F',
  muted: '#5B6170',
  border: '#E4E6EB',
  accent: '#2F5BEA',
  accentSoft: '#E6ECFD',
  income: '#17785A',
  expense: '#F2A65A',
  warning: '#C2560C',
  warningSoft: '#FDF3EA',
  danger: '#B42318',
} as const;

export const categoryPalette = ['#2F5BEA', '#E8871E', '#17785A', '#8B5CF6', '#A3A9B6'] as const;

export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
export const radius = { sm: 8, md: 14, lg: 20 } as const;
export const maxContentWidth = 1100;
