type Item = {
  id: string;
  nome: string;
};

export function BoaDetalhe(props: {items: readonly Item[]}) {
  const items = props.items;
  if (items.length === 0) return <p data-empty>Nenhum item</p>;
  return (
    <ul data-list>{items.map(item => <li key={item.id}>{item.nome}</li>)}</ul>
  );
}
