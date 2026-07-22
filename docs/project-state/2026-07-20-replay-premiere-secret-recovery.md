# Replay Premiere guest-secret recovery

This note covers the fail-closed `guest_hmac_key_file_invalid` startup failure
caused by a crash leaving two hard links to the same 32-byte guest HMAC key.
It is an availability procedure, not key rotation.

## Safe diagnosis

1. Stop the Replay Premiere service and verify that no process has the private
   state directory or either key pathname open.
2. Resolve the configured `PROXYWAR_REPLAY_PREMIERE_STATE_ROOT`. Do not print,
   copy, hash, or open the contents of `guest-hmac-key-v1.bin`.
3. Inspect metadata only for `guest-hmac-key-v1.bin` and matching
   `.guest-hmac-key-v1.*.tmp` entries. The expected final key is a regular file,
   owned by the service uid, mode `0600`, size 32, with link count 1. The root
   must be owned by the service uid with mode `0700`.
4. A recoverable interrupted-create residue is exactly one temporary pathname
   that is a regular file with the same device and inode as the final key, mode
   `0600`, size 32, and link count 2. Any different owner, inode, file type,
   count, size, extra pathname, or symlink is an integrity incident; leave all
   files untouched and escalate.

Record only pathname, device, inode, owner, mode, size, link count, and
timestamps in the private incident receipt. Never record key bytes. Keep the
receipt outside every served root.

## Recovery gate

Removing the verified temporary hard-link pathname is destructive and requires
explicit operator approval. After approval, remove only that exact temporary
pathname; never remove, replace, copy, or chmod the final key. Fsync the private
directory, confirm the final key now has link count 1 with the expected metadata,
then restart the service. If any check changes between inspection and removal,
stop without modifying either pathname.

Do not automatically clean this condition at startup. Retaining the residue and
failing closed is intentional because an unexplained second hard link can also
signal same-host tampering.
