// Runs on every page and does exactly one thing: when a person really clicks a monero: payment link, it tells Walnero. It reads
// nothing else on the page, and sends nothing unless that click happens. A page can't fake it: scripted clicks are ignored.
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_start',
  main() {
    document.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const link = (event.target as Element | null)?.closest?.('a[href]');
      const href = link?.getAttribute('href') ?? '';
      if (!/^monero:/i.test(href)) return;
      event.preventDefault();
      event.stopPropagation();
      chrome.runtime.sendMessage({ target: 'host', event: 'pay', uri: href }).catch(() => {});
    }, true);
  },
});
