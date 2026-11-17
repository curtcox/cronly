# Secret master-key rotation (S1)

Secret values remain write-only. New ciphertext records carry a key version, authenticated
along with the account and secret name. The original unversioned format is read with `v1`.
Key version names are immutable: never assign different key material to an existing name.

## Stage and activate keys

1. Keep secure backups of every key still in use. Rotation cannot recover ciphertext if
   its old key has been lost. Do not copy hashbin's keys or put actual keys in git, command
   arguments, logs, or tickets.
2. Deploy the version-aware code before changing any key. A deployment without
   `SECRETS_KEYRING` continues using `SECRETS_MASTER_KEY` as `v1`.
3. Through the secret manager, prepare a `SECRETS_KEYRING` JSON secret with this shape
   (these are structural placeholders, not usable production values):

   ```json
   {"active":"v1","keys":{"v1":"EXISTING_MASTER_KEY","v2":"NEW_RANDOM_MASTER_KEY"}}
   ```

   Each real master must contain at least 32 random bytes. Preserve the existing master
   exactly as `v1`; generating a replacement under that name would lose old secrets.
   Store the binding in GitHub's production environment and deploy through the existing
   workflow. CI validates the configuration and uploads it through stdin. Keep the
   `SECRETS_MASTER_KEY` binding during this transition for version-aware deployments
   that still use it. Once version-2 ciphertext has been written, rollback code must
   understand that format; the original pre-S1 executor cannot read new records.
4. Verify existing actions still succeed, then change only `active` to `v2` in the
   keyring secret and deploy again. One binding contains both the active selection and
   all retained keys so they update together. New writes now use `v2`. Existing secrets
   and queued runs remain readable using their recorded version.

## Re-encrypt each account

For each account, use a capped API key with `read` and `secrets:write` scopes, supplied
as `CRONLY_API_KEY` from the secret manager. The script never needs master keys or
plaintext values. Set `CRONLY_ORIGIN` only when targeting a separate test deployment.

```sh
npm run secrets:rotate
npm run secrets:rotate -- --apply
```

The first command quotes all secrets without re-encrypting them. Its config read is
billed at the ordinary API read price. `--apply` then rotates pending secrets one by
one at the normal change price (currently 100 µ$ each). It respects balance, key daily
caps and account rate limits. A cap or balance refusal stops the script; completed
rotations stay valid and rerunning skips secrets already on the active key.

The underlying endpoint is `POST /api/secrets/{name}/rotate`, with `?dry_run=1` and
`Idempotency-Key` support. A session or `secrets:write` key is required. It returns only
metadata, a quote, cost and balance. `GET /api/config` and secret metadata expose
`key_version` for inventory; neither returns ciphertext or plaintext.

Rotation reserves its maximum price before executor code decrypts the old record.
The AccountDO replaces the ciphertext only if the original is still current. A
concurrent edit or deletion wins; rotation returns `409 secret_conflict` and releases
the hold at zero charge. An authentication/decryption failure also releases the hold
and returns a generic error. Rotation preserves the value, fingerprint and the user's
last-update timestamp and records a metadata-only audit entry.

If a request is interrupted after the hold, retry with the same idempotency key.
An unfinished rotation resumes against its original secret and target version without
another hold or charge, including after a restart. Concurrent retries finalize once.
If the secret or active target changed, recovery releases the hold at zero charge and
preserves the conflict response. Expired reservations return `rotation_expired`; check
the account balance and metadata before starting with a new key. Uncertain holds expire
at their reserved maximum under the standard ledger policy. Completed results, refunded
failures and no-op results replay unchanged even after later edits or key activations.
Dry runs always quote the current state. The script stops on uncertain network outcomes;
rerunning checks current metadata before issuing new rotations.

## Retire an old key

Do not remove an old key immediately after rotating stored definitions. Every run
holds a frozen encrypted snapshot of its referenced secrets. Those snapshots retain
their original key version even after the definition is re-encrypted or deleted.

1. Inventory **every registered account**, including inactive/unfunded accounts, using
   the private SafetyDO registry and each account's metadata. The per-account script
   does not establish global completion. Accounts without enough balance must retain
   the old key until they can rotate or their secrets are explicitly deleted.
2. Verify all stored secret definitions use the new version, all pre-activation Worker
   invocations/deployments have drained, and every old-key run hold has completed or
   expired and been settled. Holds currently last two minutes; inspect outstanding
   holds rather than relying solely on a fixed wait. Retain the key while any snapshot
   can still execute. Old receipts/logs do not contain encrypted snapshots.
3. Remove the old entry from `SECRETS_KEYRING` and deploy. Missing versions fail closed;
   decryption never tries a different key. Verify HTTP and JS secret actions again.
   Remove the legacy `SECRETS_MASTER_KEY` binding from Cloudflare and GitHub only after
   fallback to the legacy binding is no longer needed; the normal bulk uploader does not delete
   omitted bindings. Keep historical keys securely backed up for ciphertext backups.

This is an operator procedure, not an automatic background job. Rotation of inactive
accounts must not create unreserved infrastructure work or silently bill customers.
Live production activation and retirement remain owner operations under L14.
