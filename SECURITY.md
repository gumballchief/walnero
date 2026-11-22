# Security

Walnero holds people's money, so security reports come first.

## Reporting a problem

Please **don't open a public issue**. Use GitHub's private reporting instead: the **Security** tab of this repository,
then **Report a vulnerability**. Only the maintainers can see it.

Include what you found, how to reproduce it, and what an attacker could do with it. We'll reply as soon as we can,
fix it, and credit you in the release notes unless you'd rather stay anonymous.

## What matters most

- Anything that could reveal or move someone's coins: keys, recovery words, the password, the vault
- Anything that lets the feed, a node or a website trick the wallet about a balance or a payment
- Anything that leaks which addresses or transactions belong to a user
- Test-only code reaching a release build (`extension/scripts/check-release.mjs` is meant to stop this)

A bug bounty paid in XMR is planned; this page will say when it opens.
