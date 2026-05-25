# Security Policy

## Secrets

This repository does not require or contain credentials. Never commit
`COMMANDCODE_API_KEY`, `.env` files, OMP auth databases, exported sessions, or
browser callback payloads.

The recommended local credential location is `~/.omp/agent/.env` with
permissions set to `600`.

## Dependency Posture

The extension has no runtime or installation dependencies and is intended to be
loaded directly from its checked-out TypeScript source by OMP. Do not introduce
package-manager installation hooks, npm publishing workflows, or runtime
packages without a documented security review.

The optional model synchronizer reads JSON from the credited upstream GitHub
repository and writes it only when invoked with `--write`; review its diff
before committing.

## Reporting

Report a suspected vulnerability through GitHub's private vulnerability
reporting feature when available. Do not include API keys or other credentials
in a public issue.
