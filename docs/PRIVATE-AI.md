# Walnero AI: useful, and as private as Monero

Research done 2026-11-21. Question: how can Walnero have an AI that is actually useful without breaking the privacy
that is the whole reason people use Monero?

## The answer in one paragraph

Run the AI on the user's own device by default, so wallet data never leaves it. Let code do the maths and the
safety checks, and let the model only understand the request and phrase the answer. When a question needs a bigger
brain, send only the minimum, with no wallet data, to a cloud that provably keeps nothing and cannot see who is
asking (Apple's Private Cloud Compute on iPhone, a verified hardware enclave on desktop). The AI never moves money:
it fills in the normal Send screen and the person approves with Face ID.

## Ways to run an AI, ranked by privacy

| Option | Who can see the question | Verdict |
|---|---|---|
| **On-device model** (iPhone: Apple's Foundation Models; Chrome: Gemini Nano) | Nobody. Never leaves the device, works offline | **Default** |
| **Apple Private Cloud Compute** (iPhone, opt-in "think harder") | Nobody, by design, and checkable by outside researchers; the request is anonymous and a third-party relay hides the IP | **Best cloud option on iPhone** |
| **Hardware enclave cloud with attestation** (Tinfoil, NEAR AI, Maple/OpenSecret) | The chip proves which open-source code runs; the operator can't read requests. Hardware trust, not a promise | **Desktop "think harder"**, through a relay so the provider can't see the IP |
| "We don't log" private APIs (NanoGPT, Venice, DuckDuckGo) | The company, if it lies or is hacked or compelled | Not good enough for wallet data |
| OpenAI, Anthropic, Google cloud | The company. Wallet history becomes their data | **Never for wallet data** |
| Fully encrypted maths (FHE/MPC) | Nobody | Not usable yet: 2026 research shows 30 to 50+ seconds **per word** on 8 GPUs |

### What we confirmed
- **Apple on-device model**: third-party apps can use it since iOS 26, free and offline, with tool calling (the model
  can call into the app). WWDC 2026 shipped a new on-device model "better at logic and tool calling", plus image
  understanding and a primitive for agentic apps. Sources: Apple newsroom (Sep 2025), WWDC26 session 241.
- **Apple Private Cloud Compute for apps** (new at WWDC 2026): `PrivateCloudComputeLanguageModel`, "a much bigger
  model", 32,000-token context, reasoning, no account or API keys. Apple: "No prompts are ever stored, and we make it
  possible for independent researchers to verify these claims." Free with no cloud API costs for developers under
  2 million first-time downloads; each user gets a daily allowance (higher with iCloud+). **Needs an entitlement.**
  Apple's PCC security design: data used only for the request and never kept (not even in logs), no staff access
  even during outages, requests authorised with anonymous tokens (RSA blind signatures) not tied to a user, sent
  through a third-party OHTTP relay that hides the device's IP, and public software images researchers can inspect.
- **Gemini Nano in Chrome**: the Prompt API is stable for Chrome extensions since Chrome 138. Needs a GPU with more
  than 4 GB VRAM, or 16 GB RAM and 4 cores, plus about 22 GB free disk. Fallback: a small open model run in the
  browser (WebLLM), downloaded once.
- **Tinfoil**: requests processed in secure enclaves Tinfoil itself can't access; security-critical code open source;
  the SDK verifies the attestation on every connection; OpenAI-compatible with tool calling and structured output.

## What would actually be useful (and where it runs)

The small on-device models are good at understanding a request and calling tools, weak at long reasoning and maths.
So every feature is built as: model understands, **code computes**, model phrases. Ranked by value:

1. **Ask your wallet** (on device): "how much did I get this month", "when did @kestrel last pay me", "what did I
   spend in October". Code adds up the real history; the model only writes the sentence.
2. **Send by asking** (on device): "send 0.05 to @kestrel" or "pay @kestrel 20 dollars" fills in the Send screen
   (amount converted at the live price). The person checks it and approves with Face ID. The AI never sends.
3. **Scam guard** (on device, rules in code, explained by the model). Before a send it checks for:
   - an address that looks like a saved name's but isn't;
   - a first payment to a new address;
   - an amount far above normal;
   - a pasted address that changed since it was copied (clipboard malware);
   - someone typing their 25 words into anything.

   It says plainly: "Support will never ask for this."
4. **Explain this** (on device): a "?" on any screen or payment. "Why is this locked?" (10 confirmations, about 20
   min), "What does Hidden by Monero mean?", "Why does it say on the way?", "What is a restore height and what should
   mine be?" Grounded in a short built-in Monero guide so answers are right.
5. **Ask for money** (on device): "request 25 dollars from Sam" makes a receive code with the amount.
6. **Learn Monero** (on device, or Private Cloud Compute for long answers): view keys, subaddresses, privacy habits,
   how swaps work. These questions carry no wallet data, so the bigger model is safe to use with the user's OK.
7. **Exports** (on device): "make a spreadsheet of last month for my accountant", built locally, saved to Files.

Not doing: a general chatbot, trading tips, reading social media posts (that is how agents get hijacked).

## Guardrails (learned from real agent-wallet thefts)

In May 2026 a hidden instruction in a post on X got the Grok/Bankr agent to move about $150K to $200K of tokens.
No keys were stolen; the agent simply had permission to send. So:

- The AI cannot send, sign, or see keys or recovery words. It can only fill in a screen the person approves.
- Spending caps and every safety check are enforced by wallet code, never by the model.
- Text from outside (names, notes, pasted text) is treated as data, never as instructions.
- Every cloud request shows a "what's being sent" preview the first time, and wallet data is never in it.
- Chat history lives in the encrypted wallet vault, on this device only, one tap to delete. No analytics, no logs.

## What others do (Nov 2026)

- Trust Wallet AI (July 2026) and its Agent Kit, MetaMask Agent Wallet, Phantom's MCP server, Coinbase AgentKit:
  all cloud AI; agents get their own wallets or limited permissions.
- Monero: an open-source Monero MCP server lets Claude check balances and send XMR, with sending off by default and
  daily limits. The user's history still goes to Anthropic's cloud.
- **Nobody ships an on-device wallet assistant.** "An AI that never leaves your phone" is open ground, and it is
  the only version the Monero community is likely to accept.

## Catches

- Private Cloud Compute needs Apple's entitlement and an App Store or TestFlight build (paid developer account,
  $99/year). The free sideloaded build can only use the on-device model.
- On-device AI needs Apple Intelligence turned on (iPhone 15 Pro or newer) and a supported language and region. On
  other phones the AI section simply says it isn't available.
- Chrome's Gemini Nano needs about 22 GB free disk.
- Small models make mistakes, which is why code does the numbers and the person approves every send.

## Build order

1. iPhone, on-device only: features 1, 2, 4 and 3, with the guardrails. Free, works in the current sideloaded app.
2. Chrome extension: the same on Gemini Nano, with the WebLLM fallback.
3. Opt-in "think harder": Private Cloud Compute on iPhone (once on TestFlight), enclave cloud on desktop.

## Sources

- Apple, Foundation Models framework (Sep 2025): https://www.apple.com/newsroom/2025/09/apples-foundation-models-framework-unlocks-new-intelligent-app-experiences/
- Apple, What's new in the Foundation Models framework, WWDC26: https://developer.apple.com/videos/play/wwdc2026/241/
- Apple Security Research, Private Cloud Compute: https://security.apple.com/blog/private-cloud-compute/
- Chrome, Prompt API for extensions: https://developer.chrome.com/docs/extensions/ai/prompt-api
- Tinfoil docs: https://docs.tinfoil.sh/introduction
- Maple (OpenSecret) on the App Store: https://apps.apple.com/app/id6743764835
- FHE Llama inference speed (2026): https://arxiv.org/abs/2601.18511
- Grok/Bankr wallet drain (May 2026): https://cointelegraph.com/news/grok-bankr-wallet-free-nft-prompt-injection
- Wallet AI features 2026: https://coingape.com/best-ai-agentic-crypto-wallets/
- Monero MCP server: https://glama.ai/mcp/servers/Baltsar/monero-mcp
- Monero restore height guide: https://web.getmonero.org/resources/user-guides/change-restore-height.html
