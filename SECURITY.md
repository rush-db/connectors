# Security policy

Please do not report vulnerabilities in public issues or pull requests. Report
them to security@rushdb.com with a minimal reproduction, the affected version,
the impact, and any mitigation you know of. We acknowledge reports within a few
working days and keep you informed until a fix ships.

This package handles third-party credentials and executes specs that people
(or tools) write, so these are in scope and especially welcome:

- **Egress bypasses**: a spec, config value, redirect or next-page URL that
  makes the runtime reach a private, loopback or link-local address, or send
  credentials to a host other than the provider's.
- **Webhook verification bypasses**: a delivery accepted without a valid
  signature, or a replay outside the tolerance window.
- **Credential exposure**: tokens or keys in error messages, logs, records,
  catalog entries or anything else the runtime returns.
- **Code execution or denial of service** through JSONPath, templates, specs
  or provider responses.
- A built-in connector requesting more than read access.

Out of scope: vulnerabilities in the providers' own APIs, and findings that
need an attacker who already controls the process running the runtime.

Do not include real customer data or live credentials in a report; sanitized
payloads and test accounts are enough.
