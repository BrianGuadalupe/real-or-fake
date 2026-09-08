import { createRoot } from 'react-dom/client';

import { Game } from '../app/game';
import '../app/globals.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Application root not found.');
}

createRoot(root).render(<Game />);
