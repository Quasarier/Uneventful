# Authentication signing-key rotation

The API signs 15-minute access tokens with the current RSA private key. It verifies
tokens only with the current public key and, optionally, one previous public key.
Refresh tokens are opaque, stored hashed, and are not affected by signing-key
rotation.

The related settings are:

- `JWT_KEY_ID`
- `JWT_PRIVATE_KEY_B64`
- `JWT_PUBLIC_KEY_B64`
- `JWT_PREVIOUS_KEY_ID` (optional)
- `JWT_PREVIOUS_PUBLIC_KEY_B64` (optional)

The previous key ID and public key must be configured together, and the previous
key ID must differ from the current ID. The private key is never needed for the
previous key. Use separate secret-manager entries or an atomic configuration
revision so an instance never starts with mismatched key material.

## Planned zero-downtime rotation

Let `old-id` / `old-key` be the currently active pair and `new-id` / `new-key`
the replacement pair. Keep the new private key in the deployment secret manager;
only its public key is needed during the first stage.

1. **Stage the new verifier.** Deploy the code that supports two verification
   keys while keeping the old pair current:
   - `JWT_KEY_ID=old-id`
   - current private/public settings remain `old-key`
   - `JWT_PREVIOUS_KEY_ID=new-id`
   - `JWT_PREVIOUS_PUBLIC_KEY_B64` is the public half of `new-key`

   This stage continues issuing old-key tokens but all instances are prepared
   to verify the new key.

2. **Switch signing and retain old verification.** In one atomic configuration
   revision, set:
   - `JWT_KEY_ID=new-id`
   - current private/public settings to `new-key`
   - `JWT_PREVIOUS_KEY_ID=old-id`
   - `JWT_PREVIOUS_PUBLIC_KEY_B64` to the public half of `old-key`

   Roll out the new configuration. During the mixed rollout, stage-one
   instances verify both old and new IDs, and stage-two instances also verify
   both. Each instance signs only with its current key.

3. **Verify rollout.** Confirm every serving instance has the stage-two
   revision, its startup key-pair check passes, and newly issued tokens carry
   `kid=new-id`. Confirm tokens carrying `kid=old-id` still verify.
4. **Retire the old verifier.** After the last old-key signer has been removed,
   wait at least the 15-minute access-token lifetime plus the verifier's
   5-second clock tolerance and your maximum deployment clock skew. Waiting
   20 minutes is a practical minimum when clocks are synchronized. Then remove
   both previous-key settings and roll out that configuration.

Never put private keys in source control, build logs, or this document. Keep
refresh-token cookies and unrelated application secrets unchanged.

## Compromised-key response

The overlap above intentionally trusts old-key signatures until old access
tokens expire. If the old private key may be compromised, do not preserve that
trust window for convenience: remove the compromised public key immediately,
deploy the replacement as current, and require affected users to obtain new
sessions. Treat that as an incident response, not a zero-downtime planned
rotation.
