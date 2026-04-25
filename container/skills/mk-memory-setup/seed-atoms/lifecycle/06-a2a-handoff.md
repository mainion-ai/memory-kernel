# A2A Handoff

When transferring memory context to another agent.

## Sender

```bash
mk checkpoint -d {dir} --json > handoff-bundle.json
# Send handoff-bundle.json to the receiving agent
```

## Receiver

```bash
# Always dry-run first — preview what will be imported
mk import --from handoff-bundle.json -d {dir} --dry-run

# If the preview looks correct, merge the event log
mk merge -d {dir} --from handoff-bundle.json

# Reindex after merge
mk reindex -d {dir}
```

**Why `--dry-run` first:** import is additive — atoms already present will be skipped, but conflicts can arise. The dry-run shows exactly what will be added before any state changes.
