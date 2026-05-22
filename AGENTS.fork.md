# AGENTS.fork.md

## Fork-Specific Instructions

This repository is a fork of an actively maintained upstream project. Keep fork-specific behavior as separated from core upstream code as practical.

Prefer additive changes in new modules, wrappers, adapters, or middleware-style layers. Minimize edits to existing core files, shared contracts, provider/runtime internals, and orchestration flows unless the change is strictly required.

The goal is to preserve behavior while reducing the surface area that can break during upstream merges or create long-term conflict and maintenance cost.
