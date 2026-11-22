import { createRoot } from 'react-dom/client';
import '@/theme.css';
import App from '@/screens/App';
import { call, firstView } from '@/wallet/client';

if (import.meta.env.MODE === 'test' || import.meta.env.MODE === 'mainnet-test') (window as any).walnero = { call };

// Works out the first frame before drawing anything, so there's never a loading screen to flash past.
performance.mark('walnero-script');
firstView().then((first) => {
  performance.mark('walnero-view');
  createRoot(document.getElementById('root')!).render(<App first={first} />);
  requestAnimationFrame(() => requestAnimationFrame(() => performance.mark('walnero-painted')));
});
