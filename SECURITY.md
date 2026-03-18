# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
| < 1.0   | No        |

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use one of the following channels:

- **GitHub private security advisory** (preferred) — open an advisory at  
  [https://github.com/mainion-ai/memory-kernel/security/advisories/new](https://github.com/mainion-ai/memory-kernel/security/advisories/new)
- **Email** — send details to [mainion@proton.me](mailto:mainion@proton.me)

---

## What to Include

A useful report contains:

- A clear description of the vulnerability
- Step-by-step instructions to reproduce the issue
- The version of memory-kernel affected
- The potential impact (what an attacker could achieve)
- Any proof-of-concept code or logs, if available

---

## Response Timeline

| Milestone | Target |
| --------- | ------ |
| Acknowledgement of report | Within 48 hours |
| Status update / triage | Within 7 days |
| Patch or mitigation | Dependent on severity |

We will keep you informed at each stage and credit you in the release notes unless you request otherwise.

---

## Scope

The following classes of issues are in scope:

- Encryption bypass or weakening of memory-at-rest protection
- Path traversal allowing reads or writes outside the designated memory directory
- Privilege escalation via the CLI or MCP server
- Denial-of-service through unbounded resource consumption in public APIs
- Injection vulnerabilities in query or filter handling

Out of scope: vulnerabilities in third-party dependencies (please report those upstream), issues requiring physical access to the machine, and theoretical attacks without a practical exploit path.
