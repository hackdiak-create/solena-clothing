import './index.css';

if (window.location.pathname.replace(/\/+$/, '') === '/admin') {
  import('./AdminApp').then(async ({ default: AdminApp }) => {
    const { createRoot } = await import('react-dom/client');
    const rootElement = document.getElementById('root');
    if (!rootElement) throw new Error('Élément #root introuvable.');
    createRoot(rootElement).render(<AdminApp />);
  }).catch((error) => {
    console.error('[Solena Admin] Impossible de charger l’espace gérante.', error);
    const rootElement = document.getElementById('root');
    if (rootElement) rootElement.textContent = 'Impossible de charger l’espace gérante. Recharge la page.';
  });
} else {
  import('./bundle.js');
}
