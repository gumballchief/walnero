// The wallet was written as a Chrome extension: the screens and the engine are separate pages that talk through chrome.runtime.
// In the iPhone app they share one page, so this supplies the few chrome.* pieces they use and passes messages in-process.
// Imported first, before anything that touches chrome.
type Reply = (result: unknown) => void;
type Listener = (message: any, sender: { id: string; url: string }, reply: Reply) => boolean | void;

const listeners: Listener[] = [];
const ID = 'walnero-app';
const base = new URL('./', location.href).href;

(globalThis as any).chrome = {
  runtime: {
    id: ID,
    getURL: (path = '') => new URL(path, base).href,
    onMessage: { addListener: (listener: Listener) => { listeners.push(listener); } },
    sendMessage: (message: unknown) => new Promise((resolve) => {
      let waiting = false;
      for (const listener of listeners) if (listener(message, { id: ID, url: location.href }, resolve) === true) waiting = true;
      // Nobody is answering (an event, not a call), so settle the way Chrome does.
      if (!waiting) queueMicrotask(() => resolve(undefined));
    }),
    // The engine lives in this same page, so it's always running.
    getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
  },
  offscreen: { createDocument: async () => {} },
};
