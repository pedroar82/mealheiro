import { Placeholder, Screen } from '@/components/screen';

export default function Explorar() {
  return (
    <Screen title="Explorar">
      <Placeholder phase={5} text="Quanto gastei em X (categoria, produto ou loja) num período, incluindo desde sempre." />
    </Screen>
  );
}
