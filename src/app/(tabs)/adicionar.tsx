import { Placeholder, Screen } from '@/components/screen';

export default function Adicionar() {
  return (
    <Screen title="Adicionar">
      <Placeholder phase={1} text="Despesa ou receita manual (fase 1), digitalizar talão (fase 3), PDF (fase 4)." />
    </Screen>
  );
}
