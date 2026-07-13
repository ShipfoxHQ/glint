import '@shipfox/react-ui/index.css';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import './shell.css';

function App() {
  return (
    <main className="shell">
      <p className="eyebrow">Glint</p>
      <h1>Visual regression infrastructure is ready.</h1>
      <p>The review workflow will arrive in E6.</p>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('The Glint web root is missing.');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
