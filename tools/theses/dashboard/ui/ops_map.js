/* GENERATED from ops_map.json by gen_ops_map.mjs — DO NOT EDIT.
   Source: docs/OPERATIONS_MAP.md (DRAFT v0). Regenerate: node tools/theses/dashboard/ui/gen_ops_map.mjs */
window.__OPS_MAP__ = {
  "_provenance": {
    "source_doc": "docs/OPERATIONS_MAP.md",
    "doc_version": "DRAFT v0",
    "doc_date": "2026-07-11",
    "doc_status": "owner review pending",
    "generated_at": "2026-07-11T10:00:00-07:00",
    "generator": "hand-derived from OPERATIONS_MAP.md §1 (actor graph) + §3 (wait graph). Regenerate ops_map.js via: node tools/theses/dashboard/ui/gen_ops_map.mjs",
    "note": "Static curated map so the tab never parses markdown at runtime. Live wait-edges are overlaid at RUNTIME from the decisions + theses feeds; the agent-lane leg is NOT AVAILABLE until the waiting_on.jsonl producer goes live (next session). Nothing here is fabricated: convention edges are protocol, not mechanical capture, and are badged as such."
  },

  "classes": [
    { "id": "human",        "label": "Human",                            "color": "human", "meaning": "sole ruling authority" },
    { "id": "orchestrator", "label": "Orchestrator + workforce",          "color": "accent", "meaning": "decision layer + the subagents it delegates to" },
    { "id": "mechanical",   "label": "Mechanical (hook-fed / enforced)",  "color": "pass",  "meaning": "runs as code — hooks, deny-lists, gates, registries" },
    { "id": "protocol",     "label": "Protocol (convention, not code)",   "color": "warn",  "meaning": "written practice, not mechanically enforced" }
  ],

  "actors": [
    { "id": "owner", "label": "Owner (adam)", "class": "human", "convention": false,
      "role": "Sole ruling authority: calibrated-gate adoptions, ceremonies, publishes, naming, Rust internals, money/keys; receives relays + nags; adjudicates proxy rulings.",
      "lives_at": "Human; ruling records in CLAUDE.md (frontier/nag) + docs/NEXT_MOVES.md §0" },

    { "id": "orchestrator", "label": "Orchestrator", "class": "orchestrator", "convention": false,
      "role": "Decision layer: delegates heavy work, reads agent summaries, serializes merges + batteries, performs calibrated-gate surgery itself, relays to owner.",
      "lives_at": "CLAUDE.md ORCHESTRATION section (standing orders)" },

    { "id": "agent_scout", "label": "scout", "class": "orchestrator", "convention": false,
      "role": "Locate — where-is-X. Haiku.", "lives_at": ".claude/agents/scout.md" },
    { "id": "agent_auditor", "label": "auditor", "class": "orchestrator", "convention": false,
      "role": "Read-only deep-read, correctness verdicts. Opus.", "lives_at": ".claude/agents/auditor.md" },
    { "id": "agent_auditor_sonnet", "label": "auditor-sonnet", "class": "orchestrator", "convention": false,
      "role": "Doc/ledger reads, spec distillation. Sonnet.", "lives_at": ".claude/agents/auditor-sonnet.md" },
    { "id": "agent_auditor_haiku", "label": "auditor-haiku", "class": "orchestrator", "convention": false,
      "role": "Mechanical extraction (git logs, gate numbers, inventories). Haiku.", "lives_at": ".claude/agents/auditor-haiku.md" },
    { "id": "agent_surgeon", "label": "surgeon", "class": "orchestrator", "convention": false,
      "role": "Scoped implement + owns exit gates. Opus.", "lives_at": ".claude/agents/surgeon.md" },
    { "id": "agent_gatekeeper", "label": "gatekeeper", "class": "orchestrator", "convention": false,
      "role": "Runs the gate battery, NEVER fixes. Haiku.", "lives_at": ".claude/agents/gatekeeper.md" },
    { "id": "agent_measurer", "label": "measurer", "class": "orchestrator", "convention": false,
      "role": "tools/ lanes only, src/ read-only. Opus.", "lives_at": ".claude/agents/measurer.md" },
    { "id": "agent_researcher", "label": "researcher", "class": "orchestrator", "convention": false,
      "role": "Web + read-only repo research; never edits.", "lives_at": ".claude/agents/researcher.md" },

    { "id": "fable_spawns", "label": "Deliberate Fable/Opus spawns", "class": "orchestrator", "convention": true,
      "role": "Owner grant 2026-07-10: grouped verify-result/fix waves; precondition = pre-spawn domain isolation (explicit file-set per agent, zero overlap, worktree-isolated).",
      "lives_at": "CLAUDE.md model-policy paragraph — grant text, not mechanically enforced" },

    { "id": "hooks", "label": "Harness hooks", "class": "mechanical", "convention": false,
      "role": "SubagentStop → log_subagent.mjs appends every run (duration/tokens/turns/model) to agent_runs.jsonl; SessionStart/End → prewarm_vite.mjs manages the shared e2e vite on 3199.",
      "lives_at": ".claude/settings.json hooks block; .claude/hooks/" },
    { "id": "denylist", "label": "Deny-lists / permissions", "class": "mechanical", "convention": false,
      "role": "Mechanical ingestion guard: blocks reads of node_modules/dist/pkg/atlas/worktrees + all binary formats; pre-allows the gate commands.",
      "lives_at": ".claude/settings.json permissions block" },
    { "id": "gates", "label": "Gates / batteries", "class": "mechanical", "convention": false,
      "role": "The regression wall: tsc + vitest counts (machine-regenerated in GATES.md), api smoke (13), two pinned reference solves. Run after EVERY increment; break = revert.",
      "lives_at": "docs/GATES.md (single source of truth); e2e drivers in tools/e2e/" },
    { "id": "csl", "label": "CSL thesis framework", "class": "mechanical", "convention": false,
      "role": "Pre-registered falsification: declarative schema IS the gate (v0.2.0), mechanical linter, hash-chained append-only registry, frozen criteria before data; AI/HUMAN/HYBRID buckets never pooled.",
      "lives_at": "tools/theses/thesis_schema.ts, thesis_lint.mjs, test_results/theses/registry.jsonl" },
    { "id": "ledgers", "label": "Ledgers", "class": "mechanical", "convention": false,
      "role": "System memory: agent_runs.jsonl (hook-fed), AGENT_TIMING_LOG.md (manual editorial), otel/*.jsonl (session tokens/cost), wrap reports + adjudication packages, thesis registry.",
      "lives_at": "test_results/*, docs/AGENT_TIMING_LOG.md" },

    { "id": "laws", "label": "Laws / rules", "class": "protocol", "convention": false,
      "role": "The written constitution: LAWS 1–7 (two ledgers, gates-never-lowered, honest-or-absent, incubator, wasm rebuild, brand-neutral, memory-boundary), unit traps, routing table. LAW 7 is compile-enforced via the generative schema.",
      "lives_at": "CLAUDE.md; LAW 7 schema at src/engine/contracts/binary_layouts.ts" },
    { "id": "proposal", "label": "Proposal pipeline", "class": "protocol", "convention": true,
      "role": "Novel-tool path: researcher proposes math + frozen test (never runs it) → adversarial review → stake-free surgeon lands the flagged test → graduation harness arbitrates. Hints = search priors only.",
      "lives_at": "tools/validation/ (graduation harness); /propose + /pressure-test skills — pipeline order is protocol, not code" },
    { "id": "proxy", "label": "Owner-proxy precedent engine", "class": "protocol", "convention": true,
      "role": "Triage over the owner-decision queue: rules from recorded precedent (/proxy-rule), sources questions (/proxy-questions); every ruling passes a mandatory pressure-test; hard deny-list; all rulings pend owner adjudication.",
      "lives_at": "/proxy-rule, /proxy-questions, /pressure-test skills; ADJUDICATION_PACKAGE.md — skills + protocol" }
  ],

  "wait_graph": {
    "viewbox": { "w": 960, "h": 600 },
    "legend_note": "Directed edge FROM (waiter) → TO (blocker). Live edges are lit from the decisions + theses feeds at each 15s poll; convention edges are protocol (amber, not mechanically captured); the agent-lane edge is NOT AVAILABLE until waiting_on.jsonl exists.",
    "nodes": [
      { "id": "owner",        "label": "Owner",              "x": 385, "y": 26,  "w": 190, "h": 54, "class": "human" },
      { "id": "orchestrator", "label": "Orchestrator",       "x": 380, "y": 165, "w": 200, "h": 58, "class": "orchestrator" },
      { "id": "agents",       "label": "Subagents",          "x": 55,  "y": 168, "w": 170, "h": 54, "class": "orchestrator" },
      { "id": "gates",        "label": "Gates / battery",    "x": 735, "y": 168, "w": 170, "h": 54, "class": "mechanical" },
      { "id": "registry",     "label": "Thesis registry",    "x": 55,  "y": 320, "w": 170, "h": 54, "class": "mechanical" },
      { "id": "quietbox",     "label": "Quiet box",          "x": 385, "y": 322, "w": 190, "h": 52, "class": "mechanical" },
      { "id": "proxy",        "label": "Proxy rulings",      "x": 735, "y": 320, "w": 170, "h": 54, "class": "protocol" },
      { "id": "proposal",     "label": "Proposal graduation","x": 55,  "y": 468, "w": 170, "h": 54, "class": "protocol" },
      { "id": "releases",     "label": "Publishes / releases","x": 385, "y": 470, "w": 190, "h": 52, "class": "orchestrator" },
      { "id": "vite",         "label": "Prewarmed vite 3199","x": 735, "y": 468, "w": 170, "h": 54, "class": "mechanical" }
    ],
    "edges": [
      { "id": "W1", "from": "orchestrator", "to": "owner", "curve": -34,
        "label": "waits on OWNER ruling", "source": "live", "live_feed": "decisions",
        "for_what": "Calibrated adoptions, rebaselines, ceremonies, publishes, naming, Rust internals",
        "evidence": "CLAUDE.md frontier + owner-decision queue; owner-guards-calibrated-gates ruling" },

      { "id": "W2", "from": "orchestrator", "to": "owner", "curve": 34,
        "label": "waits on OWNER confirmation (nag list)", "source": "convention", "live_feed": null,
        "for_what": "Small lifts blocked only on confirmation (Drive setup, ARW samples); re-surface until ruled",
        "evidence": "CLAUDE.md OWNER-CONFIRM NAG LIST [CONVENTION]" },

      { "id": "W3", "from": "agents", "to": "orchestrator", "curve": -26,
        "label": "merge / battery serialization", "source": "convention", "live_feed": null,
        "for_what": "Merges + gate batteries serialize through the orchestrator — one heavy lane at a time",
        "evidence": "CLAUDE.md Fable-grant precondition; box-load incident protocol; preflight_manifests.jsonl [CONVENTION]" },

      { "id": "W4", "from": "orchestrator", "to": "gates", "curve": 0,
        "label": "commit/merge waits on battery GREEN", "source": "convention", "live_feed": null,
        "for_what": "tsc/vitest/api-smoke/e2e verdicts vs GATES.md before any increment lands; red = revert",
        "evidence": "CLAUDE.md GATES section; gatekeeper.md — standing edge; verdicts live in run output, not a wait-record" },

      { "id": "W5", "from": "owner", "to": "orchestrator", "curve": 78,
        "label": "OWNER waits on relay", "source": "convention", "live_feed": null,
        "for_what": "Agent results reach the owner only through the orchestrator's editorial relay (+ timing-log entry)",
        "evidence": "CLAUDE.md ORCHESTRATION (agent-timing manual step) [CONVENTION]" },

      { "id": "W6", "from": "agents", "to": "orchestrator", "curve": 26,
        "label": "in-flight agents / 200% ACK", "source": "not_available", "live_feed": "waiting_on",
        "for_what": "Launch-without-complete lanes + SendMessage at 2× estimate; orchestrator waits on the AGENT, agent waits on ACK",
        "evidence": "waiting_on.jsonl (producer goes live next session start); surgeon.md TIME clause" },

      { "id": "W7", "from": "proxy", "to": "owner", "curve": 30,
        "label": "proxy rulings wait on OWNER adjudication", "source": "convention", "live_feed": null,
        "for_what": "Every proxy ruling is provisional until owner confirms/overturns (trials 1&2: 0/3 overturns)",
        "evidence": "ADJUDICATION_PACKAGE.md record [CONVENTION]" },

      { "id": "W8", "from": "registry", "to": "quietbox", "curve": -22,
        "label": "frozen runs wait on the QUIET BOX", "source": "live", "live_feed": "theses",
        "for_what": "Verdict (PASS/FAIL stamp) moves only after the pre-registered run completes; heavy lanes are mutually exclusive",
        "evidence": "test_results/theses/registry.jsonl; thesis_schema.ts ThesisStatus — best-instrumented edge" },

      { "id": "W9", "from": "orchestrator", "to": "quietbox", "curve": 30,
        "label": "heavy lanes serialize on the QUIET BOX", "source": "convention", "live_feed": null,
        "for_what": "Frozen runs / sweeps / batteries are mutually exclusive; host contention can ~2× a run and fake a red",
        "evidence": "box-load incident protocol; AGENT_TIMING_LOG.md row 3 note [CONVENTION]" },

      { "id": "W10", "from": "releases", "to": "gates", "curve": -30,
        "label": "publishes wait on SMOKE verification", "source": "convention", "live_feed": null,
        "for_what": "e.g. self-update smoke is OURS on next release before claiming the path; push after review",
        "evidence": "MQ3 record; CLAUDE.md 'push after review' [CONVENTION]" },

      { "id": "W11", "from": "proposal", "to": "gates", "curve": 34,
        "label": "graduation waits on HARNESS verdict", "source": "convention", "live_feed": null,
        "for_what": "Flagged candidates promote only on graduation-harness evidence (ship-flagged-graduate-async)",
        "evidence": "tools/validation/; ship-flagged ruling [CONVENTION]" },

      { "id": "W12", "from": "agents", "to": "vite", "curve": 0,
        "label": "e2e agents wait on PREWARMED VITE 3199", "source": "convention", "live_feed": null,
        "for_what": "Shared server must be listening, else the agent warms a dedicated port and owns its PID cleanup",
        "evidence": "docs/GATES.md port protocol; test_results/prewarm_vite.json pidfile evidences up/down, not a wait" }
    ]
  }
};
