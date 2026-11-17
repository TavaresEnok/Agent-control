type Item = {
  id: string;
  nome: string;
};

export function Itens(props: {items: readonly Item[]}) {
  const items = props.items;
  return (
    <ul data-list>{items.map(item => <li key={item.id}>{item.nome}</li>)}</ul>
  );
}
