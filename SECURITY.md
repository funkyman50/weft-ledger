# Security policy

## Supported versions

Until the first tagged preview release, only the newest default-branch code is supported. Afterwards, only the latest preview release is supported. Older versions do not receive promised fixes or backports. Support is best effort, with no guaranteed response or remediation deadline.

Weft supports one user with the service and browser on the same computer. See [Local security and credentials](docs/OPERATIONS.md#local-security-and-credentials) for the supported setup. Version support does not promise database compatibility; check [Schema revisions](docs/OPERATIONS.md#schema-revisions) before updating.

## Report a vulnerability privately

Reporting setup is pending while the project is prepared for public release. The maintainer must enable and verify GitHub private vulnerability reporting before opening public issues.

When available, open the repository's **Security → Advisories → Report a vulnerability** form. Do not put vulnerability details in public issues, discussions or pull requests. If the form is missing, open an issue requesting a private reporting channel without describing the vulnerability. Wait for a private channel before sending details.

Include the affected version or commit, installation method, operating system, expected impact and steps using synthetic data. A minimal synthetic proof of concept is helpful. Do not send real financial information, databases, backups, recovery keys, credentials or provider responses. Do not attach raw logs or unreviewed screenshots or diagnostics reports.

The maintainer assesses reports and coordinates any fix and disclosure privately.
