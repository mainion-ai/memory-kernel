# A2A Handoff

When transferring memory context to another agent.

## Option A: Directory-level merge (shared filesystem)

When both agents can access each other's memory directories (e.g., same network, NFS/Samba mount):

```bash
# Always dry-run first — preview what will be merged
mk merge --from /path/to/sender/memory -d {dir} --dry-run

# If the preview looks correct, merge the event logs
mk merge --from /path/to/sender/memory -d {dir}

# Reindex after merge
mk reindex -d {dir}
```

## Option B: Checkpoint transfer (over network)

When agents communicate over A2A or other network protocols:

### Sender

```bash
mk checkpoint -d {dir} > handoff.md
# Send handoff.md to the receiving agent (via A2A message, file transfer, etc.)
```

### Receiver

```bash
# Always dry-run first — preview what will be imported
mk import --from handoff.md -d {dir} --dry-run

# If the preview looks correct, import the atoms
mk import --from handoff.md -d {dir}

# Reindex after import
mk reindex -d {dir}
```

**Why `--dry-run` first:** both merge and import are additive — atoms already present will be skipped, but conflicts can arise. The dry-run shows exactly what will change before any state is written.
