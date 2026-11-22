import { call } from '@/wallet/client';
import { parsePayLink } from '@/wallet/pay-link';

// Keeps the gap small while the wallet is closed, so opening it after a long time away has little left to do.
const ALARM = 'catchup';

const wake = () => { call('catchup').catch((error) => console.warn('background catch-up skipped', error)); };

export default defineBackground(() => {
  // Every time this wakes, not just on install: Chrome can drop alarms, and the scan shouldn't quietly stop.
  chrome.alarms.get(ALARM).then((alarm) => { if (!alarm) chrome.alarms.create(ALARM, { periodInMinutes: 30 }); });
  chrome.runtime.onStartup.addListener(wake);
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) wake(); });

  // A payment link was clicked. The site's name comes from Chrome, not from the page, so a page can't claim to be another site.
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.target !== 'host' || message.event !== 'pay' || sender.id !== chrome.runtime.id || !sender.tab) return;
    const request = parsePayLink(String(message.uri ?? ''));
    if (!request) return;
    const site = new URL(sender.url ?? sender.tab.url ?? 'about:blank').hostname;
    const params = new URLSearchParams({ pay: request.address, amount: request.amount, label: request.label, note: request.note, site });
    chrome.windows.create({ url: chrome.runtime.getURL(`popup.html?${params}`), type: 'popup', width: 396, height: 640, focused: true });
  });
});
