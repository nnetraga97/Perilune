# Perilune build status (session handoff notes)

M0 ✅ / M1 ✅ (see CHANGELOG.md). M2 in progress.

M2 slice order:
1. Multi-vessel physics bubble + switching (foundation) ← current
2. Docking merge/undock + rendezvous
3. Comms network + relays + probe control
4. New parts: wheels, gear, drills, scanners, big wings
5. ISRU chain: scan → drill → convert
6. Transfer planner UI (windows list) + alarms + entry prediction
7. Aircraft (runway spawn) + rovers
8. EVA
9. Visual upgrades (atmosphere shader, terrain scatter)

Conventions: sim modules pure & tested first; UI drives via GameState;
commit per slice; docs updated at milestone gates.
