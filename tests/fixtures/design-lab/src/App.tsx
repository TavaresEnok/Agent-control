import {Route, Routes} from 'react-router-dom';

export function App() {
  return (
    <Routes>
      <Route path="/contraste" element={<p>Contraste</p>} />
      <Route path="/botao" element={<p>Botao</p>} />
      <Route path="/foco" element={<p>Foco</p>} />
      <Route path="/cinzas" element={<p>Cinzas</p>} />
      <Route path="/espaco" element={<p>Espaco</p>} />
      <Route path="/itens" element={<p>Itens</p>} />
      <Route path="/estreito" element={<p>Estreito</p>} />
      <Route path="/cortado" element={<p>Cortado</p>} />
      <Route path="/boa-inicio" element={<p>Inicio</p>} />
      <Route path="/boa-detalhe" element={<p>Detalhe</p>} />
    </Routes>
  );
}
