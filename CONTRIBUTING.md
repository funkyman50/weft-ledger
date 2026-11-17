# Reports and feedback

Bug reports, feature ideas and documentation feedback are welcome through GitHub Issues. Use the matching issue template. Open an issue for larger ideas; a request does not promise implementation.

Pull requests and patches for inclusion are not accepted yet. Contribution permissions must be settled before code intake opens. Describe the problem or proposed behavior instead of pasting a patch into an issue. This intake policy does not change the permissions in [LICENSE](LICENSE).

## Protect your information

Use made-up accounts, names and amounts in every reproduction. Do not upload real financial information, databases, backups, recovery keys, credentials or provider responses. Do not attach raw logs or the app's **Download diagnostics** report publicly. Review any screenshot before posting it; prefer a synthetic example. See [Diagnostics](docs/OPERATIONS.md#diagnostics) for report contents.

Report suspected vulnerabilities through [the security policy](SECURITY.md), not an ordinary public issue. Minimal synthetic proofs of concept are welcome in private security reports.

If you accidentally post private information, remove it and notify a maintainer without repeating it. Maintainers may edit, hide or remove posts containing private information. Removal cannot undo exposure. Revoke or replace exposed provider credentials. Treat an exposed recovery key and any backups it can decrypt as compromised. If the installation encryption secret is exposed, read [the credential warning](docs/OPERATIONS.md#local-security-and-credentials) and [backup limits](docs/OPERATIONS.md#backups-and-restore) before changing it. Financial backups do not include every connection setting; replacing the secret without re-encrypting all protected stores makes saved connections unreadable.

## Support and conduct

Support is best effort for [the current preview](SECURITY.md#supported-versions). There is no guaranteed response or fix deadline. Use [README](README.md) for setup and local checks. Keep your working version and recovery material until an update's compatibility is clear; see [Schema revisions](docs/OPERATIONS.md#schema-revisions).

Be respectful and constructive. Keep discussion focused on the project. Harassment and sharing someone else's private information are not acceptable; maintainers may close or remove disruptive discussions.
