# gifi-sdk

Official TypeScript client and CLI for the [Gifi](https://gifi.ai) API: inspect,
clean and rewrite AI provenance marks in text and files.

The source of the [gifi-sdk](https://www.npmjs.com/package/gifi-sdk) npm
package, mirrored to <https://github.com/Reload-Apps/gifi-sdk>. Gifi itself is
closed source; this client is not, because you should be able to read what you
are running against your own data.

Zero runtime dependencies. Written against the published contract at
<https://gifi.ai/openapi.json>.

## Install

```bash
npm install gifi-sdk
```

Create a key at <https://gifi.ai/api-keys>. Inspecting and cleaning text cost
no credits; cleaning a file costs one, and rewriting costs one per candidate.

## Use

```ts
import { GifiClient, GifiError } from "gifi-sdk";

const gifi = new GifiClient({ apiKey: process.env.GIFI_API_KEY! });

// Inspect first. It is free, changes nothing, and tells you whether there is
// anything to remove at all.
const { data, rateLimit } = await gifi.inspect({ text: "Looks ordinary​." });
console.log(data, `${rateLimit.remaining}/${rateLimit.limit} calls left`);

// Cleaning a file spends a credit. An Idempotency-Key is sent for you, so a
// retry after a dropped connection replays the first response instead of
// cleaning — and charging for — the same file twice.
const cleaned = await gifi.clean({ file: await readFile("photo.jpg"), filename: "photo.jpg" });
if (cleaned.replayed) console.log("replayed an earlier response");
```

### Errors

Failures throw `GifiError`, carrying the machine-readable half of the
[RFC 9457 problem document](https://gifi.ai/docs#errors):

```ts
try {
  await gifi.rewrite({ text });
} catch (err) {
  if (err instanceof GifiError) {
    console.error(err.code, err.status, err.hint);
    if (err.refunded) console.error("the credits came back");
  }
}
```

`retryable` comes from the server rather than being guessed from the status,
and the client retries those automatically (twice by default), waiting for
`Retry-After` when one is sent.

### Paging

```ts
for await (const job of gifi.jobs()) {
  console.log(job.id, job.status, job.creditsCost);
}
```

The cursor is followed for you. It is anchored to the last row you saw, so jobs
created while you page do not shift rows and make you read one twice.

## CLI

```bash
export GIFI_API_KEY=wmr_live_...

gifi inspect --text "Looks ordinary."
gifi inspect --file photo.jpg
gifi clean   --file photo.jpg --out cleaned.jpg
gifi usage
gifi jobs --limit 20
```

Rewriting is in the SDK but not the CLI: spending credits from a shell
one-liner is easy to do by accident.

## What this will not do

- Certify that rewritten text defeats a vendor detector. SynthID-Text uses a
  private key that nobody outside the vendor can see.
- Prove human authorship. Removing a mark removes the mark.
- Touch pixel-embedded image watermarks, audio or video. Out of scope.

## Licence

Apache-2.0, the same licence as the Gifi source. See <https://gifi.ai/terms>
for the terms covering the hosted service itself.
