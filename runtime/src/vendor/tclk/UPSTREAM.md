# tclk reference verifier

Source: https://github.com/flop-labs/tclk
Commit: `5cc4ab93efbc8999a3a7e1471b639deca25998ea`
License: Apache-2.0 (included alongside NOTICE).

The published 0.1.0 npm tarball does not contain the transcript verifier present
at this commit. These JavaScript files are mechanically transpiled from that
commit's `src/*.ts`, without semantic modifications. Do not silently substitute
the older npm package: it lacks the signed-record and room-binding checks.

This is a read-only verifier. PACT does not use its signing, payment or wallet
functions to transact. The source is pinned for reproducible offline replay.
