// The iPhone app's one page: the wallet engine and the screens together.
import './chrome-shim';
import '@/theme.css';
import './app.css';
import '@/entrypoints/offscreen/main';
import { createRoot } from 'react-dom/client';
import App from '@/screens/App';
import { firstView } from '@/wallet/client';

// When the iPhone keyboard opens, iOS nudges the page up to keep the field in view. Put it back when typing ends.
addEventListener('focusout', () => setTimeout(() => { if (!document.activeElement?.matches('input, textarea')) window.scrollTo(0, 0); }, 60));

// Works out the first frame before drawing anything, so there's never a loading screen to flash past.
firstView().then((first) => createRoot(document.getElementById('root')!).render(<App first={first} />));
