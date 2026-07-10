# Contributing to Silo

Silo is small on purpose. The best contribution is usually the one that makes it easier for a Hack Clubber to ship something without adding a whole new machine to maintain.

## Before you start

Open an issue if the change is big, surprising, or changes how storage behaves. For a typo, papercut, or small clear fix, a pull request is lovely.

> [!TIP]
> Keep one pull request about one thing. It makes review kinder, faster, and much less mysterious.

## Working locally

```sh
bun install
bun run build
bun run dataplane:check
```

The dashboard/control plane and the Rust dataplane share configuration. The [environment example](.env.production.example) names what a real deployment needs; use your own local credentials and never commit them.

## A few good rules

- Keep the user-facing bits warm and understandable.
- Do not add generated output, benchmark dumps, local caches, or secrets to Git.
- Prefer the smallest change that makes the project nicer.
- If you touch the dataplane, keep the common file path boring and safe.
- Tell us what you tested in the pull request.

## Security issues

If you found something that could affect another person's files, account, or bucket, please skip GitHub issues and read [our security policy](SECURITY.md) instead.

Thanks for helping make the internet a little easier to build on.
