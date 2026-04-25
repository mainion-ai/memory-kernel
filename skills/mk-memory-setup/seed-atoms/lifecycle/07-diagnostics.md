# Diagnostics — When to Use What

| Situation | Command |
|---|---|
| Something seems wrong — atoms missing, recall feels off | `mk doctor -d {dir}` |
| Check for semantic issues: contradictions, stale atoms, orphans, duplicates | `mk lint -d {dir}` |
| Quick health check — counts, index status | `mk status -d {dir}` |
| Agent feels like it's reasoning in circles or over-referencing itself | `mk closure -d {dir} --trajectory` |
| Recall returns irrelevant atoms | `mk reindex -d {dir}` (rebuild index) |
| CLAUDE.md looks stale | `mk render {dir} {output}` |
| Want to see what two atoms have in common | `mk wander -d {dir} --seed ATOM-ID-A --seed ATOM-ID-B` |
| Need to see all edges on a specific atom | `mk relations {atom-id} -d {dir}` |
| Setup or environment problems | run the `/mk-doctor` skill |
