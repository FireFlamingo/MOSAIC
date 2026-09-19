# MOSAIC MVP scoring

MOSAIC evaluates only caller-supplied metadata, static text, and in-memory prior evaluations. It does not fetch, install, resolve, or execute an artifact.

| Signal | Points | Condition |
| --- | ---: | --- |
| Artifact not found | 48 | `metadata.exists` is explicitly `false` |
| Existence unverified | 8 | `metadata.exists` is absent or not `true` |
| Known-package lookalike | 26 | A **package** name is a close edit-distance match for the small built-in catalog; a trailing semver suffix is ignored |
| Unsigned artifact | 10 | `metadata.signed` is explicitly `false` |
| Very new artifact | 8 | `metadata.ageDays` is less than 7 |
| Low observed adoption | 7 | `metadata.downloads` is less than 50 |
| Elevated permissions | 8 each, maximum 24 | Recognized elevated permission is requested (`filesystem:read`, `filesystem:write`, network, spawn, shell, secrets, clipboard, or browser control) |
| Obfuscated content | 18 | Static text has an obfuscation marker |
| Credential-access indicator | 16 | Static text references a credential-bearing location or token pattern |
| Remote payload indicator | 24 | Static text contains a shell-piped remote download pattern |
| Instruction override | 22 | A **skill** or **MCP** text asks to ignore prior instructions or disable/bypass security |
| Non-HTTPS URL | 12 | A **URL** parses but does not use HTTPS |
| Local or private URL host | 20 | A **URL** parses to loopback, `.localhost`, RFC1918, link-local IPv4, IPv6 ULA, or IPv6 link-local host |
| Invalid URL | 20 | A **URL** fails local parsing |
| Session correlation | 6 per matching prior artifact, maximum 18 | Same session, last 20 session evaluations, prior non-allowed artifact, and a different artifact type |
| Cross-artifact name reuse | 12 | One of those correlated artifacts has the same normalized name |

Scores are summed and capped at **100**. Decisions use inclusive policy thresholds: score at or above `denyThreshold` is `deny`; otherwise score at or above `reviewThreshold` is `review`; lower scores are `allow`. The default policy uses review at 35 and deny at 70.

## Limits

This is deterministic triage, not verification. Missing or unknown metadata adds caution but never establishes that an artifact is genuine, signed, safe, or unsafe. The package catalog is intentionally small and name similarity can produce false positives. URL checks only parse the supplied URL and classify literal host forms; MOSAIC performs no DNS lookup or network request. Correlation is limited to supplied local history and cannot establish causation or account ownership.
