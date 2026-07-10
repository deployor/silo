# Security at Silo

Thank you for helping keep Hack Clubbers' projects safe.

> [!IMPORTANT]
> Please **do not** open a public issue for a security problem.

Send a private report to [security@deployor.dev](mailto:security@deployor.dev). A good report tells us what happened, how to reproduce it, who could be affected, and any proof or screenshots that help us understand it.

## What we care about

Silo handles files, credentials, and buckets, so we take reports about these especially seriously:

- authentication, sessions, and access keys;
- bucket or object isolation between people;
- private files becoming public (or public files becoming writable);
- request signing, presigned URLs, quotas, or the dataplane;
- accidental secrets in the repository or deployment.

## Please be gentle

Use an account and bucket you control. Do not read, change, or delete someone else's files; do not make the service unavailable; and do not post a proof of concept that would put users at risk.

We do not have a bug bounty program. We will still read good-faith reports and do our best to keep you in the loop while we fix them.

## A tiny timeline

We will acknowledge your email as soon as we can, investigate privately, and let you know when a fix is live. If a report affects people using Silo, we will coordinate disclosure with you rather than surprising anyone in public.

Thank you for being thoughtful with a thing that holds other people's work.
