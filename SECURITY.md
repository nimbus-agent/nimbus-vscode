# Security Policy

`nimbus-vscode` is a thin editor client that talks only to a **locally-running**
Nimbus Gateway over local IPC. It does not make cloud calls or store credentials.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue:

- Use GitHub's [private vulnerability reporting](https://github.com/nimbus-agent/nimbus-vscode/security/advisories/new) for this repository, or
- Follow the disclosure process in the main [Nimbus security policy](https://github.com/nimbus-agent/Nimbus/security/policy).

Please include reproduction steps and the extension version (`Nimbus Agent` in the
Extensions view). We aim to acknowledge reports within a few business days.

## Scope

Issues in the Gateway, connectors, or `@nimbus-dev/client` belong in the
[Nimbus](https://github.com/nimbus-agent/Nimbus) repository. Issues specific to the
extension host code (this repo) belong here.
